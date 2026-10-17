import { createHash } from "node:crypto";
import { createDAVClient, type DAVCalendar } from "tsdav";
import ICAL from "ical.js";
import { currentContext } from "./context.ts";
import { clearLastEvent, loadLastEvent, saveLastEvent } from "./db.ts";

const TZ = process.env.TIMEZONE || "America/New_York";
const MAX_EVENTS = 40;
const PENDING_TTL_MS = 10 * 60_000;

// ---- time helpers ----

function tzOffsetMs(utcMs: number): number {
  const p = Object.fromEntries(
    new Intl.DateTimeFormat("en-US", {
      timeZone: TZ, hourCycle: "h23", year: "numeric", month: "numeric", day: "numeric", hour: "numeric", minute: "numeric", second: "numeric",
    }).formatToParts(new Date(utcMs)).map((x) => [x.type, x.value]),
  );
  return Date.UTC(+p.year!, +p.month! - 1, +p.day!, +p.hour!, +p.minute!, +p.second!) - Math.floor(utcMs / 1000) * 1000;
}

/** Parse "2026-10-21T19:00" (wall time in TIMEZONE), a date-only string, or an ISO string with offset/Z. */
export function parseLocal(s: string, endOfDay = false): Date {
  s = s.trim();
  if (/(Z|[+-]\d\d:?\d\d)$/.test(s) && s.includes("T")) return new Date(s);
  const m = s.match(/^(\d{4})-(\d\d)-(\d\d)(?:[T ](\d\d):(\d\d)(?::(\d\d))?)?$/);
  if (!m) throw new Error(`Bad date "${s}", use YYYY-MM-DDTHH:MM`);
  const dateOnly = m[4] === undefined;
  const wall = Date.UTC(+m[1]!, +m[2]! - 1, +m[3]!, dateOnly ? (endOfDay ? 23 : 0) : +m[4]!, dateOnly ? (endOfDay ? 59 : 0) : +m[5]!, dateOnly ? (endOfDay ? 59 : 0) : +(m[6] ?? 0));
  let utc = wall - tzOffsetMs(wall);
  utc = wall - tzOffsetMs(utc);
  return new Date(utc);
}

const fmtDay = (d: Date) => d.toLocaleDateString("en-US", { timeZone: TZ, weekday: "short", month: "short", day: "numeric" });
const fmtTime = (d: Date) => d.toLocaleTimeString("en-US", { timeZone: TZ, hour: "numeric", minute: "2-digit" }).replace(":00", "");

function fmtRange(start: Date, end: Date): string {
  const sameDay = fmtDay(start) === fmtDay(end);
  return sameDay ? `${fmtDay(start)} ${fmtTime(start)}-${fmtTime(end)}` : `${fmtDay(start)} ${fmtTime(start)} - ${fmtDay(end)} ${fmtTime(end)}`;
}

// ---- compact formatting for confirmations: "Fri 4–5pm" ----

let nowFn: () => Date = () => new Date();
/** Tests pin the clock; production never calls this. */
export const setNowForTests = (fn?: () => Date) => void (nowFn = fn ?? (() => new Date()));

const ymd = (d: Date) => d.toLocaleDateString("en-CA", { timeZone: TZ });
const dayNum = (d: Date) => Math.floor(Date.parse(`${ymd(d)}T00:00:00Z`) / 86400_000);

function clock(d: Date) {
  const m = d.toLocaleTimeString("en-US", { timeZone: TZ, hour: "numeric", minute: "2-digit" }).match(/^(\d+):(\d\d)\s?([AP]M)$/i)!;
  return { text: m[2] === "00" ? m[1]! : `${m[1]}:${m[2]}`, mer: m[3]!.toLowerCase() };
}

function dayLabel(d: Date): string {
  const wd = d.toLocaleDateString("en-US", { timeZone: TZ, weekday: "short" });
  const diff = dayNum(d) - dayNum(nowFn());
  return diff >= -1 && diff <= 6 ? wd : `${wd} ${d.toLocaleDateString("en-US", { timeZone: TZ, month: "short", day: "numeric" })}`;
}

export function timeOnly(start: Date, end: Date): string {
  const a = clock(start), b = clock(end);
  return a.mer === b.mer ? `${a.text}–${b.text}${b.mer}` : `${a.text}${a.mer}–${b.text}${b.mer}`;
}

/** "Fri 4–5pm", "Fri Oct 23 11am–1pm", or a two-day span. */
export function fmtCompact(start: Date, end: Date): string {
  if (ymd(start) === ymd(end)) return `${dayLabel(start)} ${timeOnly(start, end)}`;
  const a = clock(start), b = clock(end);
  return `${dayLabel(start)} ${a.text}${a.mer} – ${dayLabel(end)} ${b.text}${b.mer}`;
}

/** "Wed 8pm" / "Fri Oct 23 4:30pm": one moment, for reminders. */
export function fmtAt(d: Date): string {
  const c = clock(d);
  return `${dayLabel(d)} ${c.text}${c.mer}`;
}

/** Wall-clock "YYYY-MM-DDTHH:MM" in TIMEZONE, the format the tools take. */
export function toLocalIso(d: Date): string {
  const p = Object.fromEntries(
    new Intl.DateTimeFormat("en-US", { timeZone: TZ, hourCycle: "h23", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" })
      .formatToParts(d).map((x) => [x.type, x.value]),
  );
  return `${p.year}-${p.month}-${p.day}T${p.hour}:${p.minute}`;
}

// ---- iCalendar parsing ----

type Ev = {
  title: string; start: Date; end: Date; allDay: boolean; location: string; notes: string; calendar: string;
  uid: string; recId: number; recurring: boolean;
};

function parseIcs(data: string): ICAL.Component {
  const comp = new ICAL.Component(ICAL.parse(data));
  for (const tz of comp.getAllSubcomponents("vtimezone")) {
    const t = new ICAL.Timezone(tz);
    if (!ICAL.TimezoneService.has(t.tzid)) ICAL.TimezoneService.register(t);
  }
  return comp;
}

/** Expand an iCalendar object into the occurrences that overlap [from, to). */
export function expand(data: string, from: Date, to: Date, calendar: string): Ev[] {
  const out: Ev[] = [];
  const comp = parseIcs(data);
  const vevents = comp.getAllSubcomponents("vevent");
  const masters = vevents.filter((v) => !v.hasProperty("recurrence-id"));
  const exceptions = vevents.filter((v) => v.hasProperty("recurrence-id"));
  const push = (ev: ICAL.Event, startT: ICAL.Time, endT: ICAL.Time, recId: number, recurring: boolean) => {
    const s = startT.toJSDate(), e = endT.toJSDate();
    if (e <= from || s >= to) return;
    out.push({
      title: ev.summary || "(no title)", start: s, end: e, allDay: startT.isDate, location: ev.location || "", notes: ev.description || "",
      calendar, uid: ev.uid, recId, recurring,
    });
  };
  for (const m of masters) {
    const ev = new ICAL.Event(m);
    for (const x of exceptions) if (x.getFirstPropertyValue("uid") === ev.uid) ev.relateException(new ICAL.Event(x));
    if (!ev.isRecurring()) {
      push(ev, ev.startDate, ev.endDate, ev.startDate.toJSDate().getTime(), false);
      continue;
    }
    const it = ev.iterator();
    for (let n = 0, t = it.next(); t && n < 5000; t = it.next(), n++) {
      const d = ev.getOccurrenceDetails(t);
      if (d.startDate.toJSDate() >= to) break;
      push(d.item, d.startDate, d.endDate, d.recurrenceId.toJSDate().getTime(), true);
    }
  }
  return out;
}

// ---- pure iCalendar edits (no network; unit-tested) ----

export type Scope = "one" | "all";
export type Changes = { title?: string; start?: Date; end?: Date; location?: string; notes?: string };

const utc = (d: Date) => ICAL.Time.fromJSDate(d, true);
const tzidOf = (t: ICAL.Time): string | null => (t.zone && t.zone.tzid && t.zone.tzid !== "UTC" && t.zone.tzid !== "floating" ? t.zone.tzid : null);

function addTimeProp(comp: ICAL.Component, name: string, t: ICAL.Time) {
  const p = new ICAL.Property(name);
  p.setValue(t);
  const tz = tzidOf(t);
  if (tz) p.setParameter("tzid", tz);
  comp.addProperty(p);
}

function setText(v: ICAL.Component, name: string, val: string) {
  v.removeAllProperties(name);
  if (val) v.addPropertyWithValue(name, val);
}

function bump(v: ICAL.Component) {
  const seq = Number(v.getFirstPropertyValue("sequence") ?? 0) + 1;
  v.removeAllProperties("sequence");
  v.addPropertyWithValue("sequence", seq);
  for (const name of ["dtstamp", "last-modified"]) {
    v.removeAllProperties(name);
    v.addPropertyWithValue(name, utc(new Date()));
  }
}

function setFields(v: ICAL.Component, ch: Changes) {
  if (ch.title !== undefined) setText(v, "summary", ch.title);
  if (ch.location !== undefined) setText(v, "location", ch.location);
  if (ch.notes !== undefined) setText(v, "description", ch.notes);
  if (ch.start) {
    v.removeAllProperties("dtstart");
    v.addPropertyWithValue("dtstart", utc(ch.start));
  }
  if (ch.end) {
    v.removeAllProperties("dtend");
    v.removeAllProperties("duration");
    v.addPropertyWithValue("dtend", utc(ch.end));
  }
}

const isRecurringMaster = (m: ICAL.Component) => m.hasProperty("rrule") || m.hasProperty("rdate");
const masterOf = (comp: ICAL.Component) => comp.getAllSubcomponents("vevent").find((v) => !v.hasProperty("recurrence-id"));
const recIdOf = (v: ICAL.Component) => (v.getFirstPropertyValue("recurrence-id") as ICAL.Time).toJSDate().getTime();

/** The occurrence's start in the master's own time representation (what RECURRENCE-ID / EXDATE must match). */
function occurrenceTime(master: ICAL.Component, recId: number): ICAL.Time | null {
  const it = new ICAL.Event(master).iterator();
  for (let n = 0, t = it.next(); t && n < 5000; t = it.next(), n++) {
    const ms = t.toJSDate().getTime();
    if (ms === recId) return t;
    if (ms > recId) break;
  }
  return null;
}

/**
 * Apply an edit to an iCalendar object and return the new text.
 * Non-recurring: edits the event. Recurring with scope "one": adds/edits a RECURRENCE-ID override. Scope "all": edits the series.
 */
export function applyUpdate(ics: string, target: { recId: number; scope?: Scope; occ: { start: Date; end: Date } }, ch: Changes): string {
  const comp = parseIcs(ics);
  const master = masterOf(comp);
  if (!master) throw new Error("event has no main component");
  if (!isRecurringMaster(master)) {
    setFields(master, ch);
    bump(master);
    return comp.toString();
  }
  if (target.scope === "all") {
    const fields: Changes = { title: ch.title, location: ch.location, notes: ch.notes };
    if (ch.start && ch.end) {
      // shift the whole series by how far this occurrence moved, and keep its new length
      const delta = ch.start.getTime() - target.occ.start.getTime();
      const ms = new ICAL.Event(master).startDate.toJSDate().getTime();
      fields.start = new Date(ms + delta);
      fields.end = new Date(ms + delta + (ch.end.getTime() - ch.start.getTime()));
    }
    setFields(master, fields);
    bump(master);
    return comp.toString();
  }
  // just this one: an override VEVENT with the occurrence's RECURRENCE-ID
  const uid = master.getFirstPropertyValue("uid");
  let o = comp.getAllSubcomponents("vevent").find((v) => v.hasProperty("recurrence-id") && v.getFirstPropertyValue("uid") === uid && recIdOf(v) === target.recId);
  if (!o) {
    const rid = occurrenceTime(master, target.recId);
    if (!rid) throw new Error("couldn't locate that occurrence in the series");
    o = new ICAL.Component("vevent");
    o.addPropertyWithValue("uid", uid);
    addTimeProp(o, "recurrence-id", rid);
    for (const name of ["summary", "location", "description"]) {
      const val = master.getFirstPropertyValue(name);
      if (val) o.addPropertyWithValue(name, val);
    }
    o.addPropertyWithValue("dtstart", utc(target.occ.start));
    o.addPropertyWithValue("dtend", utc(target.occ.end));
    comp.addSubcomponent(o);
  }
  setFields(o, ch);
  bump(o);
  return comp.toString();
}

/** Returns the new text, or null when the whole object should be deleted. */
export function applyDelete(ics: string, target: { recId: number; scope?: Scope }): string | null {
  const comp = parseIcs(ics);
  const master = masterOf(comp);
  if (!master || !isRecurringMaster(master) || target.scope === "all") return null;
  const uid = master.getFirstPropertyValue("uid");
  const rid = occurrenceTime(master, target.recId);
  if (!rid) throw new Error("couldn't locate that occurrence in the series");
  for (const v of comp.getAllSubcomponents("vevent")) {
    if (v.hasProperty("recurrence-id") && v.getFirstPropertyValue("uid") === uid && recIdOf(v) === target.recId) comp.removeSubcomponent(v);
  }
  addTimeProp(master, "exdate", rid);
  bump(master);
  return comp.toString();
}

// ---- the store (CalDAV behind an interface so edits are testable) ----

export type StoredObject = { url: string; etag?: string; data: string; calendarUrl: string; calendar: string };

export interface CalendarStore {
  /** Objects overlapping [from, to) in calendars the user owns and can write. */
  search(from: Date, to: Date): Promise<StoredObject[]>;
  /** Like search, but across every readable event calendar (shared ones too): used to see when you're busy. */
  searchAll?(from: Date, to: Date): Promise<StoredObject[]>;
  get(calendarUrl: string, objectUrl: string): Promise<StoredObject | null>;
  put(obj: StoredObject, ics: string): Promise<void>;
  remove(obj: StoredObject): Promise<void>;
  create(ics: string, filename: string): Promise<{ url: string; calendarUrl: string }>;
}

let storeOverride: CalendarStore | undefined;
export const setStoreForTests = (s?: CalendarStore) => void (storeOverride = s);
const getStore = (): CalendarStore => storeOverride ?? icloudStore;

type Client = Awaited<ReturnType<typeof createDAVClient>>;
let clientP: Promise<Client> | undefined;

function client(): Promise<Client> {
  // the iCloud account is the owner's: nobody else may touch it, whatever the model asks for
  if (currentContext()?.role !== "owner") throw new Error("calendar is owner-only");
  const username = process.env.ICLOUD_EMAIL, password = process.env.ICLOUD_APP_PASSWORD;
  if (!username || !password) throw new Error("ICLOUD_EMAIL / ICLOUD_APP_PASSWORD not set");
  clientP ??= createDAVClient({
    serverUrl: "https://caldav.icloud.com",
    credentials: { username, password },
    authMethod: "Basic",
    defaultAccountType: "caldav",
  });
  clientP.catch(() => (clientP = undefined)); // retry connect next time
  return clientP;
}

const rtKeys = (c: Pick<DAVCalendar, "resourcetype">): string[] => {
  const rt: any = c.resourcetype ?? [];
  return (Array.isArray(rt) ? rt : Object.keys(rt)).map(String);
};

/** Readable calendars: events only, no subscribed feeds, nothing Canvas-named. */
function isEventCalendar(c: DAVCalendar): boolean {
  return (c.components ?? []).includes("VEVENT") && !rtKeys(c).includes("subscribed") && !/canvas/i.test(String(c.displayName ?? ""));
}

/**
 * Calendars the bot may change: the user's own. Subscribed feeds (the Canvas calendar) and calendars
 * shared WITH the user are excluded. A calendar the user owns and shares out ("shared-owner") is still theirs.
 */
export function isOwnedWritableCalendar(c: DAVCalendar): boolean {
  return isEventCalendar(c) && !rtKeys(c).includes("shared");
}

async function eventCalendars(): Promise<{ c: Client; cals: DAVCalendar[] }> {
  const c = await client();
  const cals = (await c.fetchCalendars()).filter(isEventCalendar);
  if (!cals.length) throw new Error("No iCloud event calendars found");
  return { c, cals };
}

async function ownedCalendars(): Promise<{ c: Client; cals: DAVCalendar[] }> {
  const c = await client();
  const cals = (await c.fetchCalendars()).filter(isOwnedWritableCalendar);
  if (!cals.length) throw new Error("No iCloud calendars of yours that I can edit");
  return { c, cals };
}

const iso = (d: Date) => d.toISOString().replace(/\.\d{3}Z$/, "Z");

const icloudStore: CalendarStore = {
  async search(from, to) {
    const { c, cals } = await ownedCalendars();
    const out: StoredObject[] = [];
    for (const cal of cals) {
      const objs = await c.fetchCalendarObjects({ calendar: cal, timeRange: { start: iso(from), end: iso(to) } });
      for (const o of objs) if (typeof o.data === "string") out.push({ url: o.url, etag: o.etag, data: o.data, calendarUrl: cal.url, calendar: String(cal.displayName ?? "") });
    }
    return out;
  },
  async searchAll(from, to) {
    const { c, cals } = await eventCalendars();
    const out: StoredObject[] = [];
    for (const cal of cals) {
      const objs = await c.fetchCalendarObjects({ calendar: cal, timeRange: { start: iso(from), end: iso(to) } });
      for (const o of objs) if (typeof o.data === "string") out.push({ url: o.url, etag: o.etag, data: o.data, calendarUrl: cal.url, calendar: String(cal.displayName ?? "") });
    }
    return out;
  },
  async get(calendarUrl, objectUrl) {
    const { c, cals } = await ownedCalendars(); // edits are refused outside owned calendars
    const cal = cals.find((x) => x.url === calendarUrl);
    if (!cal) return null;
    const [o] = await c.fetchCalendarObjects({ calendar: cal, objectUrls: [objectUrl] });
    return o && typeof o.data === "string" ? { url: o.url, etag: o.etag, data: o.data, calendarUrl: cal.url, calendar: String(cal.displayName ?? "") } : null;
  },
  async put(obj, ics) {
    const c = await client();
    const res = await c.updateCalendarObject({ calendarObject: { url: obj.url, etag: obj.etag, data: ics } });
    if (!res.ok) throw new Error(`iCloud rejected the change (${res.status})`);
  },
  async remove(obj) {
    const c = await client();
    const res = await c.deleteCalendarObject({ calendarObject: { url: obj.url, etag: obj.etag ?? "" } });
    if (!res.ok) throw new Error(`delete failed (${res.status})`);
  },
  async create(ics, filename) {
    const { c, cals } = await ownedCalendars();
    const res = await c.createCalendarObject({ calendar: cals[0]!, filename, iCalString: ics });
    if (!res.ok) throw new Error(`iCloud rejected the event (${res.status})`);
    return { url: new URL(filename, cals[0]!.url).href, calendarUrl: cals[0]!.url };
  },
};

// ---- reading ----

async function fetchEvents(from: Date, to: Date): Promise<{ events: Ev[]; multi: boolean }> {
  const { c, cals } = await eventCalendars();
  const all: Ev[] = [];
  for (const cal of cals) {
    const objs = await c.fetchCalendarObjects({ calendar: cal, timeRange: { start: iso(from), end: iso(to) } });
    for (const o of objs) if (typeof o.data === "string") all.push(...expand(o.data, from, to, String(cal.displayName ?? "")));
  }
  all.sort((a, b) => a.start.getTime() - b.start.getTime());
  return { events: all, multi: cals.length > 1 };
}

export async function listEvents(start: string, end: string): Promise<string[]> {
  const from = parseLocal(start), to = parseLocal(end, true);
  if (to <= from) throw new Error("end must be after start");
  const { events: all, multi } = await fetchEvents(from, to);
  const lines = all.slice(0, MAX_EVENTS).map((e) => {
    const when = e.allDay ? `${fmtDay(e.start)} all day` : fmtRange(e.start, e.end);
    return `${when} | ${e.title}${e.location ? ` @ ${e.location.slice(0, 60)}` : ""}${multi ? ` [${e.calendar}]` : ""}`;
  });
  if (all.length > MAX_EVENTS) lines.push(`…and ${all.length - MAX_EVENTS} more`);
  return lines.length ? lines : ["No events in that range."];
}

/** When the user is busy in [from, to): timed events only (an all-day "Exam week" label shouldn't block every hour). */
export async function busyBetween(from: Date, to: Date): Promise<{ start: Date; end: Date }[]> {
  const st = getStore();
  const objs = await (st.searchAll ? st.searchAll(from, to) : st.search(from, to));
  return objs.flatMap((o) => expand(o.data, from, to, o.calendar)).filter((e) => !e.allDay).map((e) => ({ start: e.start, end: e.end }));
}

export const calendarConfigured = () => !!(process.env.ICLOUD_EMAIL && process.env.ICLOUD_APP_PASSWORD);

/** Lines like "Mon 3-4pm Study group" for local dates [fromDate, toDate] (YYYY-MM-DD). Used by the Sunday preview. */
export async function rangeEvents(fromDate: string, toDate: string): Promise<string[]> {
  const { events } = await fetchEvents(parseLocal(fromDate), parseLocal(toDate, true));
  const lines = events.slice(0, 12).map((e) => `${e.start.toLocaleDateString("en-US", { timeZone: TZ, weekday: "short" })} ${e.allDay ? "all day" : timeOnly(e.start, e.end)} ${e.title}`);
  if (events.length > 12) lines.push(`+${events.length - 12} more`);
  return lines;
}

/** Short lines for one local day (YYYY-MM-DD), e.g. "9am-10am Title". Used by the morning brief. */
export async function dayEvents(date: string): Promise<string[]> {
  const { events } = await fetchEvents(parseLocal(date), parseLocal(date, true));
  return events.slice(0, 10).map((e) => `${e.allDay ? "all day" : `${fmtTime(e.start)}-${fmtTime(e.end)}`} ${e.title}`);
}

// ---- event handles: refs, short ids, "last" ----

/** Enough to find an event again in CalDAV (stored per user as the "last event"). */
export type EventRef = {
  calendarUrl: string; objectUrl: string; uid: string;
  /** original start of this occurrence (its RECURRENCE-ID); equals start for one-off events */
  recId: number;
  recurring: boolean;
  title: string; start: number; end: number; location: string; allDay: boolean;
};

const refOf = (e: Ev, o: StoredObject): EventRef => ({
  calendarUrl: o.calendarUrl, objectUrl: o.url, uid: e.uid, recId: e.recId, recurring: e.recurring,
  title: e.title, start: e.start.getTime(), end: e.end.getTime(), location: e.location, allDay: e.allDay,
});

const REGISTRY_TTL_MS = 30 * 60_000;
const registry = new Map<string, { at: number; byId: Map<string, EventRef> }>();

function register(key: string, refs: EventRef[]): string[] {
  const reg = { at: Date.now(), byId: new Map<string, EventRef>() };
  registry.set(key, reg);
  return refs.map((r) => {
    const h = createHash("sha1").update(`${r.uid}|${r.recId}`).digest("hex");
    let id = h.slice(0, 4);
    for (let len = 6; reg.byId.has(id) && len <= 12; len += 2) id = h.slice(0, len);
    reg.byId.set(id, r);
    return id;
  });
}

function resolveRef(key: string, id: string): EventRef | null {
  if (id.toLowerCase() === "last") return loadLastEvent<EventRef>(key);
  const reg = registry.get(key);
  if (reg && Date.now() - reg.at < REGISTRY_TTL_MS && reg.byId.has(id)) return reg.byId.get(id)!;
  return null;
}

const remember = (key: string, ref: EventRef) => saveLastEvent(key, ref);

/** What the model is told about "that event" (also lets "same", "again" and "one more" resolve). */
export function lastEventPrompt(key: string): string {
  const r = loadLastEvent<EventRef>(key);
  if (!r) return "No calendar event has been created or touched yet.";
  const s = new Date(r.start), e = new Date(r.end);
  return `Last calendar event you created or touched (id "last"): '${r.title}' from ${toLocalIso(s)} to ${toLocalIso(e)} (${fmtCompact(s, e)})${r.location ? ` at ${r.location}` : ""}${r.recurring ? ", repeats" : ""}.`;
}

// ---- do this message's tools need the calendar? (the owner's calendar/reminder/planner tools cost ~2,000 chars on every round) ----

const CAL_WORDS =
  /\b(calendar|schedul\w*|event|appointment|meeting|remind\w*|alarm|plan|study (plan|block|time|session)|block(ed)?( out)?|free (time|slot|hour)|busy|book (a|an|the|my|me|it|that|this)|reschedul\w*|postpone|push|move|shift|cancel\w*|delet\w*|remov\w*|edit|chang\w*|updat\w*|renam\w*|extend|shorten|longer|shorter|earlier|later|make (it|that)|add|put|set|same|again|one more|my (day|week|weekend)|tonight|this (morning|afternoon|evening)|all[- ]day|repeat\w*|weekly|daily|recurring)\b/i;
const TIME_OF_DAY = /\b\d{1,2}(:\d{2})?\s?(am|pm)\b|\b(noon|midnight)\b/i;
const PRONOUN = /\b(it|that|this|those|them)\b/i;

export const looksCalendarRelated = (text: string) => CAL_WORDS.test(text) || TIME_OF_DAY.test(text);

/**
 * Should the owner's request carry the calendar/reminder/planner tools? Errs toward yes (a miss would hide a feature;
 * a false alarm only costs tokens) and the agent has two safety nets for the misses. Looks at the latest message,
 * the one before it (a short follow-up like "what about Friday instead"), pending staged changes, and "it/that" when
 * there is a last event to refer to.
 */
export function needsCalendarTools(key: string, history: { role: string; content: string }[]): boolean {
  const users = history.filter((h) => h.role === "user");
  const last = users.at(-1)?.content ?? "", prev = users.at(-2)?.content ?? "";
  if (looksCalendarRelated(last)) return true;
  const p = pending.get(key), c = choices.get(key);
  if ((p && Date.now() <= p.expires) || (c && Date.now() <= c.expires)) return true;
  const short = last.trim().split(/\s+/).length <= 8;
  if (short && prev && looksCalendarRelated(prev)) return true; // a follow-up to a calendar request
  if (short && PRONOUN.test(last) && loadLastEvent(key)) return true; // "make it longer", "not that one"
  return false;
}

export const calendarPromptRules = `- Calendar changes are only STAGED: reply with exactly the question the tool returns and never say it is done. Never use create_calendar_event to edit or move an existing event.
- id "last" = "that", "it", the event just made: "edit that to 6pm" -> update_calendar_event(id "last", end ...); "move it to 5" keeps the length; "make it 2 hours" changes only the end; "delete that"/"cancel it" -> delete_calendar_event(id "last").
- Reminders: create_reminder(text, when) stages one. "my reminders" -> find_calendar_events "reminders". "cancel that reminder" -> delete_calendar_event "last" (find "reminders" first if the last event isn't one).
- "plan my week" -> plan_week; send its plan exactly (the user's reply is handled in code).
- Several possible matches: call find_calendar_events, send its numbered list exactly, then wait for the number.
- "same", "same exact", "same time", "again", "one more" = repeat the last event below with create_calendar_event unless a change is named.`;

// ---- staged changes (create / update / delete) ----

/** A proposed study block; the user picks which ones to keep. */
export type PlanBlock = { title: string; start: Date; end: Date };

type Snap = { title: string; start: Date; end: Date; location: string; notes: string; allDay: boolean };
type Action =
  | { kind: "create"; title: string; start: Date; end: Date; location?: string; notes?: string }
  | { kind: "reminder"; text: string; when: Date }
  | { kind: "plan"; blocks: PlanBlock[] }
  | { kind: "update"; ref: EventRef; before: Snap; after: Snap; recurring: boolean; scope?: Scope }
  | { kind: "delete"; ref: EventRef; before: Snap; recurring: boolean; scope?: Scope };
type Pending = { action: Action; awaiting: "scope" | "confirm"; expires: number };

const pending = new Map<string, Pending>();
const choices = new Map<string, { refs: EventRef[]; expires: number }>();

const sameDay = (a: Date, b: Date) => ymd(a) === ymd(b);

function confirmText(a: Action): string {
  const suffix = "scope" in a && a.scope ? (a.scope === "one" ? " (just this one)" : " (all events)") : "";
  if (a.kind === "create") return `Add '${a.title}' ${fmtCompact(a.start, a.end)}${a.location ? ` at ${a.location}` : ""}?`;
  if (a.kind === "reminder") return `Remind you to ${a.text} ${fmtAt(a.when)}?`;
  if (a.kind === "plan") return `Add ${a.blocks.length} study blocks?`;
  if (a.kind === "delete") return `Delete '${a.before.title}' ${fmtCompact(a.before.start, a.before.end)}${suffix}?`;
  const b = a.before, c = a.after;
  const parts: string[] = [];
  if (c.title !== b.title) parts.push(`'${c.title}'`);
  if (c.start.getTime() !== b.start.getTime() || c.end.getTime() !== b.end.getTime()) {
    parts.push(sameDay(b.start, c.start) && sameDay(c.start, c.end) ? timeOnly(c.start, c.end) : fmtCompact(c.start, c.end));
  }
  if (c.location !== b.location) parts.push(c.location ? `at ${c.location}` : "no location");
  if (c.notes !== b.notes) parts.push("new notes");
  return `Change '${b.title}' ${fmtCompact(b.start, b.end)} → ${parts.join(", ")}${suffix}?`;
}

const esc = (s: string) => s.replace(/\\/g, "\\\\").replace(/;/g, "\;").replace(/,/g, "\\,").replace(/\r?\n/g, "\\n");
const stamp = (d: Date) => d.toISOString().replace(/[-:]|\.\d{3}/g, "");

export async function createEvent(e: { title: string; start: Date; end: Date; location?: string; notes?: string; alarm?: boolean }): Promise<{ uid: string; url: string; calendarUrl: string }> {
  const uid = `${crypto.randomUUID()}@canvas-bot`;
  const ics = [
    "BEGIN:VCALENDAR", "VERSION:2.0", "PRODID:-//canvas-bot//EN", "BEGIN:VEVENT",
    `UID:${uid}`, `DTSTAMP:${stamp(new Date())}`, `DTSTART:${stamp(e.start)}`, `DTEND:${stamp(e.end)}`,
    `SUMMARY:${esc(e.title)}`,
    ...(e.location ? [`LOCATION:${esc(e.location)}`] : []),
    ...(e.notes ? [`DESCRIPTION:${esc(e.notes)}`] : []),
    // a display alarm at the event's start: this is what makes a calendar event behave like a reminder
    ...(e.alarm ? ["BEGIN:VALARM", "ACTION:DISPLAY", `DESCRIPTION:${esc(e.title)}`, "TRIGGER:PT0S", "END:VALARM"] : []),
    "END:VEVENT", "END:VCALENDAR",
  ].join("\r\n");
  const r = await getStore().create(ics, `${uid}.ics`);
  return { uid, ...r };
}

export async function deleteEvent(url: string): Promise<void> {
  await getStore().remove({ url, data: "", calendarUrl: "", calendar: "" });
}

/** Re-read an event from CalDAV right before acting on it (it may have changed since it was found). */
async function loadCurrent(ref: EventRef): Promise<{ obj: StoredObject; snap: Snap; recurring: boolean; recId: number } | null> {
  const obj = await getStore().get(ref.calendarUrl, ref.objectUrl);
  if (!obj) return null;
  const lo = new Date(Math.min(ref.recId, ref.start) - 2 * 86400_000), hi = new Date(Math.max(ref.recId, ref.end) + 2 * 86400_000);
  const evs = expand(obj.data, lo, hi, obj.calendar).filter((x) => x.uid === ref.uid);
  const ev = evs.find((x) => x.recId === ref.recId) ?? (evs.length === 1 && !evs[0]!.recurring ? evs[0] : undefined);
  if (!ev) return null;
  return { obj, recurring: ev.recurring, recId: ev.recId, snap: { title: ev.title, start: ev.start, end: ev.end, location: ev.location, notes: ev.notes, allDay: ev.allDay } };
}

const snapRef = (ref: EventRef, s: Snap, recId: number, recurring: boolean): EventRef => ({
  ...ref, recId, recurring, title: s.title, start: s.start.getTime(), end: s.end.getTime(), location: s.location, allDay: s.allDay,
});

/** Reminders are calendar events titled "Reminder: ..." with an alarm: iCloud Reminders can't be written over CalDAV on this account. */
export const REMINDER_PREFIX = "Reminder: ";
const REMINDER_MINUTES = 15;

async function execute(key: string, a: Action): Promise<string> {
  if (a.kind === "plan") throw new Error("a plan is executed by executePlan, not execute"); // handled in handleConfirmation
  if (a.kind === "reminder") {
    const title = REMINDER_PREFIX + a.text;
    const end = new Date(a.when.getTime() + REMINDER_MINUTES * 60_000);
    const r = await createEvent({ title, start: a.when, end, alarm: true });
    remember(key, { calendarUrl: r.calendarUrl, objectUrl: r.url, uid: r.uid, recId: a.when.getTime(), recurring: false, title, start: a.when.getTime(), end: end.getTime(), location: "", allDay: false });
    return `Okay, I'll remind you to ${a.text} ${fmtAt(a.when)} (calendar alert).`;
  }
  if (a.kind === "create") {
    const r = await createEvent(a);
    remember(key, {
      calendarUrl: r.calendarUrl, objectUrl: r.url, uid: r.uid, recId: a.start.getTime(), recurring: false,
      title: a.title, start: a.start.getTime(), end: a.end.getTime(), location: a.location ?? "", allDay: false,
    });
    return `Added '${a.title}' ${fmtCompact(a.start, a.end)}.`;
  }
  const cur = await loadCurrent(a.ref);
  if (!cur) return "I can't find that event anymore, so I didn't change anything.";
  if (a.kind === "delete") {
    const next = applyDelete(cur.obj.data, { recId: cur.recId, scope: a.scope });
    if (next === null) await getStore().remove(cur.obj);
    else await getStore().put(cur.obj, next);
    clearLastEvent(key);
    return `Deleted '${a.before.title}' ${fmtCompact(a.before.start, a.before.end)}${a.scope === "one" ? " (just that one)" : ""}.`;
  }
  const b = a.before, c = a.after;
  const ch: Changes = {};
  if (c.title !== b.title) ch.title = c.title;
  if (c.location !== b.location) ch.location = c.location;
  if (c.notes !== b.notes) ch.notes = c.notes;
  if (c.start.getTime() !== b.start.getTime() || c.end.getTime() !== b.end.getTime()) {
    ch.start = c.start;
    ch.end = c.end;
  }
  const next = applyUpdate(cur.obj.data, { recId: cur.recId, scope: a.scope, occ: { start: b.start, end: b.end } }, ch);
  await getStore().put(cur.obj, next);
  // the occurrence keeps its original RECURRENCE-ID after a "just this one" move; one-off events are identified by their new start
  const recId = !cur.recurring ? c.start.getTime() : a.scope === "all" ? cur.recId + (c.start.getTime() - b.start.getTime()) : cur.recId;
  remember(key, snapRef(a.ref, c, recId, cur.recurring));
  return `Updated '${c.title}' to ${fmtCompact(c.start, c.end)}${a.scope === "one" ? " (just that one)" : ""}.`;
}

/** Stage a study plan; the user's next message ("all", "1,3", "none") picks what to add. */
export function stagePlan(key: string, blocks: PlanBlock[]) {
  pending.set(key, { action: { kind: "plan", blocks }, awaiting: "confirm", expires: Date.now() + PENDING_TTL_MS });
}

/** "all" | "none" | the chosen numbers (1-based) | null when the message isn't an answer to the plan. */
export function parsePlanReply(text: string, count: number): "all" | "none" | number[] | null {
  const t = text.trim();
  if (/^(all|everything|yes|y|yep|yeah|sure|ok|okay|do it|go ahead|all of them|add all|add them all)\W*$/i.test(t)) return "all";
  if (/^(none|no|nope|nah|cancel|never ?mind|skip|skip all|n|don'?t)\W*$/i.test(t)) return "none";
  const cleaned = t.toLowerCase().replace(/\band\b|#|[,;]/g, " ").trim();
  if (!cleaned || !/^[\d\s-]+$/.test(cleaned)) return null;
  const picked = new Set<number>();
  for (const tok of cleaned.split(/\s+/)) {
    const range = tok.match(/^(\d+)-(\d+)$/);
    const single = tok.match(/^\d+$/);
    if (range) for (let i = Number(range[1]); i <= Number(range[2]); i++) picked.add(i);
    else if (single) picked.add(Number(tok));
    else return null;
  }
  const nums = [...picked].sort((a, b) => a - b);
  return nums.length && nums.every((n) => n >= 1 && n <= count) ? nums : null;
}

async function executePlan(key: string, blocks: PlanBlock[], pick: "all" | number[]): Promise<string> {
  const chosen = pick === "all" ? blocks.map((_, i) => i + 1) : pick;
  const added: string[] = [], failed: number[] = [];
  for (const n of chosen) {
    const b = blocks[n - 1]!;
    try {
      const r = await createEvent({ title: b.title, start: b.start, end: b.end });
      remember(key, { calendarUrl: r.calendarUrl, objectUrl: r.url, uid: r.uid, recId: b.start.getTime(), recurring: false, title: b.title, start: b.start.getTime(), end: b.end.getTime(), location: "", allDay: false });
      added.push(`${n}) ${fmtCompact(b.start, b.end)} ${b.title}`);
    } catch (e) {
      console.error("study block failed:", e instanceof Error ? e.message : e);
      failed.push(n);
    }
  }
  return `${added.length ? `Added ${added.length} study block${added.length > 1 ? "s" : ""}:\n${added.join("\n")}` : "I couldn't add any of them."}${failed.length ? `\nCouldn't add: ${failed.join(", ")}.` : ""}`;
}

const YES = /^(y|yes|yep|yeah|yup|sure|ok|okay|confirm|do it|go ahead|please do)\W*$/i;
const NO = /^(n|no|nope|nah|cancel|never ?mind|don'?t|stop)\W*$/i;
const ONE = /^(just |only )?(this|that|the)( one| event| occurrence)?( only)?\W*$|^(1|one)\W*$/i;
const ALL = /^(all|all of them|all of the?m|every|every one|everything|all events|them all|the whole series|whole series|2)\W*$/i;

/** Handle a reply to a staged change. Returns the text to send, or null if the message should go on to the LLM. */
export async function handleConfirmation(key: string, text: string): Promise<string | null> {
  const p = pending.get(key);
  if (!p) return null;
  const t = text.trim();
  if (Date.now() > p.expires) {
    pending.delete(key);
    return null;
  }
  if (p.awaiting === "scope") {
    const scope: Scope | null = ONE.test(t) ? "one" : ALL.test(t) ? "all" : null;
    if (scope && (p.action.kind === "update" || p.action.kind === "delete")) {
      p.action.scope = scope;
      p.awaiting = "confirm";
      p.expires = Date.now() + PENDING_TTL_MS;
      return confirmText(p.action);
    }
    pending.delete(key);
    return NO.test(t) ? "Okay, nothing changed." : null;
  }
  if (p.action.kind === "plan") {
    pending.delete(key);
    const pick = parsePlanReply(t, p.action.blocks.length);
    if (pick === null) return null; // not an answer to the plan: it goes on to the model
    if (pick === "none") return "Okay, I didn't add anything.";
    return executePlan(key, p.action.blocks, pick);
  }
  pending.delete(key);
  if (YES.test(t)) {
    try {
      return await execute(key, p.action);
    } catch (e) {
      console.error("calendar change failed:", e instanceof Error ? e.message : e);
      return p.action.kind === "create" ? "Sorry, I couldn't add that to your calendar." : "Sorry, I couldn't make that change, and nothing was changed.";
    }
  }
  return NO.test(t) ? "Okay, I didn't change anything." : null;
}

/** "2" after a numbered list of matches: remember that event and tell the model what was picked. */
export function resolveChoice(key: string, text: string): string | null {
  const c = choices.get(key);
  if (!c || Date.now() > c.expires) return null;
  const m = text.trim().match(/^#?(?:option\s*)?(\d{1,2})\.?$/i);
  if (!m) return null;
  const n = Number(m[1]);
  const ref = c.refs[n - 1];
  if (!ref) return null;
  choices.delete(key);
  remember(key, ref);
  const s = new Date(ref.start), e = new Date(ref.end);
  return `[The user picked option ${n}: '${ref.title}' ${fmtCompact(s, e)}. Continue their previous request with this event, using id "last".]`;
}

// ---- tools ----

const opt = (type: string) => ({ type: [type, "null"] });

export const calendarTools = [
  {
    type: "function" as const,
    function: {
      name: "list_calendar_events",
      description: "Events between start and end (YYYY-MM-DD[THH:MM], local time).",
      parameters: { type: "object", properties: { start: { type: "string" }, end: { type: "string" } }, required: ["start", "end"] },
    },
  },
  {
    type: "function" as const,
    function: {
      name: "create_calendar_event",
      description: "Stage a NEW event (times YYYY-MM-DDTHH:MM local).",
      parameters: {
        type: "object",
        properties: { title: { type: "string" }, start: { type: "string" }, end: { type: "string" }, location: opt("string"), notes: opt("string") },
        required: ["title", "start", "end"],
      },
    },
  },
  {
    type: "function" as const,
    function: {
      name: "create_reminder",
      description: "Stage a reminder at a time (no event until the user says yes).",
      parameters: { type: "object", properties: { text: { type: "string" }, when: { type: "string" } }, required: ["text", "when"] },
    },
  },
  {
    type: "function" as const,
    function: {
      name: "find_calendar_events",
      description: "Search events by keyword (default next 14 days); returns ids.",
      parameters: { type: "object", properties: { query: { type: "string" }, start: opt("string"), end: opt("string") }, required: ["query"] },
    },
  },
  {
    type: "function" as const,
    function: {
      name: "update_calendar_event",
      description: 'Stage a change to an event (id "last" or from find).',
      parameters: {
        type: "object",
        properties: { id: { type: "string" }, title: opt("string"), start: opt("string"), end: opt("string"), location: opt("string"), notes: opt("string") },
        required: ["id"],
      },
    },
  },
  {
    type: "function" as const,
    function: {
      name: "delete_calendar_event",
      description: 'Stage deleting an event (id "last" or from find).',
      parameters: { type: "object", properties: { id: { type: "string" } }, required: ["id"] },
    },
  },
];

/** Models sometimes send null or "" for optional fields; treat those as "not provided". */
function clean(args: any): Record<string, any> {
  const out: Record<string, any> = {};
  for (const [k, v] of Object.entries(args ?? {})) {
    if (v === null || v === undefined) continue;
    if (typeof v === "string") {
      const t = v.trim();
      if (t) out[k] = t;
    } else out[k] = v;
  }
  return out;
}

const STAGED = "STAGED, nothing has changed yet. Reply to the user with exactly this question and nothing else: ";

async function stageChange(key: string, kind: "update" | "delete", args: Record<string, any>): Promise<string> {
  if (!args.id) return "Error: id is required (use \"last\" or an id from find_calendar_events)";
  const ref = resolveRef(key, String(args.id));
  if (!ref) return 'Error: I don\'t know that event id. Call find_calendar_events first, or use id "last".';
  const cur = await loadCurrent(ref);
  if (!cur) return "Error: that event no longer exists on the calendar.";
  const before = cur.snap;
  const full = snapRef(ref, before, cur.recId, cur.recurring);
  let action: Action;
  if (kind === "delete") {
    action = { kind: "delete", ref: full, before, recurring: cur.recurring };
  } else {
    let start = args.start ? parseLocal(String(args.start)) : before.start;
    let end = args.end ? parseLocal(String(args.end)) : before.end;
    if (args.start && !args.end) end = new Date(start.getTime() + (before.end.getTime() - before.start.getTime()));
    if (end <= start) throw new Error("end must be after start");
    const after: Snap = {
      title: args.title ?? before.title, start, end, location: args.location ?? before.location, notes: args.notes ?? before.notes,
      allDay: start.getTime() === before.start.getTime() && end.getTime() === before.end.getTime() ? before.allDay : false,
    };
    if (after.title === before.title && start.getTime() === before.start.getTime() && end.getTime() === before.end.getTime() && after.location === before.location && after.notes === before.notes) {
      return "Nothing to change: the event already looks like that. Tell the user.";
    }
    action = { kind: "update", ref: full, before, after, recurring: cur.recurring };
  }
  remember(key, full);
  if (cur.recurring) {
    pending.set(key, { action, awaiting: "scope", expires: Date.now() + PENDING_TTL_MS });
    return `${STAGED}Just this one, or all of them?`;
  }
  pending.set(key, { action, awaiting: "confirm", expires: Date.now() + PENDING_TTL_MS });
  return STAGED + confirmText(action);
}

async function findTool(key: string, args: Record<string, any>): Promise<string> {
  const now = nowFn();
  const from = args.start ? parseLocal(String(args.start)) : parseLocal(ymd(now));
  let to = args.end ? parseLocal(String(args.end), true) : new Date(from.getTime() + 14 * 86400_000);
  const wantReminders = /^reminders?:?$/i.test(String(args.query ?? "").trim());
  if (wantReminders && !args.end) to = new Date(from.getTime() + 60 * 86400_000); // reminders can be weeks away
  const tokens = wantReminders ? [] : String(args.query ?? "").toLowerCase().split(/\s+/).filter(Boolean);
  const objs = await getStore().search(from, to);
  const hits: { ev: Ev; obj: StoredObject }[] = [];
  for (const obj of objs)
    for (const ev of expand(obj.data, from, to, obj.calendar)) {
      const hay = `${ev.title} ${ev.location} ${ev.notes}`.toLowerCase();
      if (wantReminders ? ev.title.startsWith(REMINDER_PREFIX) : tokens.every((t) => hay.includes(t))) hits.push({ ev, obj });
    }
  hits.sort((a, b) => a.ev.start.getTime() - b.ev.start.getTime());
  if (!hits.length) return `No matching events between ${ymd(from)} and ${ymd(to)}. Tell the user, or try other words / a wider range.`;
  const shown = hits.slice(0, 8);
  const refs = shown.map(({ ev, obj }) => refOf(ev, obj));
  const ids = register(key, refs);
  const line = (r: EventRef) => `${fmtCompact(new Date(r.start), new Date(r.end))} ${r.title}${r.recurring ? " (repeats)" : ""}`;
  if (refs.length === 1) {
    remember(key, refs[0]!);
    return `1 match, now remembered as "last": id ${ids[0]} | ${line(refs[0]!)}`;
  }
  choices.set(key, { refs, expires: Date.now() + PENDING_TTL_MS });
  const more = hits.length > shown.length ? `\n(${hits.length - shown.length} more not shown; narrow the search)` : "";
  return `${refs.length} matches:\n${refs.map((r, i) => `id ${ids[i]} | ${line(r)}`).join("\n")}${more}\nIf the user wants to change or delete one, ask which with exactly this message and wait for their number:\nWhich one?\n${refs.map((r, i) => `${i + 1}) ${line(r)}`).join("\n")}\nReply with a number.`;
}

export async function runCalendarTool(name: string, rawArgs: any, convKey: string): Promise<string> {
  try {
    const args = clean(rawArgs);
    if (name === "list_calendar_events") return (await listEvents(String(args.start), String(args.end))).join("\n");
    if (name === "find_calendar_events") return await findTool(convKey, args);
    if (name === "update_calendar_event") return await stageChange(convKey, "update", args);
    if (name === "delete_calendar_event") return await stageChange(convKey, "delete", args);
    if (name === "create_reminder") {
      if (!args.text || !args.when) throw new Error("text and when are required");
      const when = parseLocal(String(args.when));
      if (when.getTime() <= nowFn().getTime()) throw new Error("that time has already passed; ask the user for a later time");
      const text = String(args.text).replace(/^(?:remind me\s+)?(?:to\s+)/i, "").replace(/^reminder:\s*/i, "").trim();
      const action: Action = { kind: "reminder", text, when };
      pending.set(convKey, { action, awaiting: "confirm", expires: Date.now() + PENDING_TTL_MS });
      return STAGED + confirmText(action);
    }
    if (name === "create_calendar_event") {
      if (!args.title || !args.start || !args.end) throw new Error("title, start and end are required");
      const start = parseLocal(String(args.start)), end = parseLocal(String(args.end));
      if (end <= start) throw new Error("end must be after start");
      const action: Action = { kind: "create", title: String(args.title), start, end, location: args.location, notes: args.notes };
      pending.set(convKey, { action, awaiting: "confirm", expires: Date.now() + PENDING_TTL_MS });
      return STAGED + confirmText(action);
    }
    return `Error: unknown tool ${name}`;
  } catch (e) {
    return `Error: ${e instanceof Error ? e.message : String(e)}`;
  }
}

// ---- weekly class meetings ----

export type ClassEventSpec = {
  uid: string; title: string; location: string; days: number[]; startMin: number; endMin: number;
  termStart: string; termEnd: string; exdates: string[]; tz: string;
};

const NY_TZ = [
  "BEGIN:VTIMEZONE", "TZID:America/New_York",
  "BEGIN:DAYLIGHT", "TZOFFSETFROM:-0500", "TZOFFSETTO:-0400", "TZNAME:EDT", "DTSTART:19700308T020000", "RRULE:FREQ=YEARLY;BYMONTH=3;BYDAY=2SU", "END:DAYLIGHT",
  "BEGIN:STANDARD", "TZOFFSETFROM:-0400", "TZOFFSETTO:-0500", "TZNAME:EST", "DTSTART:19701101T020000", "RRULE:FREQ=YEARLY;BYMONTH=11;BYDAY=1SU", "END:STANDARD",
  "END:VTIMEZONE",
];
const BYDAY = ["SU", "MO", "TU", "WE", "TH", "FR", "SA"];

const localStamp = (ymd: string, min: number) => `${ymd.replace(/-/g, "")}T${String(Math.floor(min / 60)).padStart(2, "0")}${String(min % 60).padStart(2, "0")}00`;

export function buildClassIcs(s: ClassEventSpec): string {
  // first meeting on or after the term start
  let first = s.termStart;
  for (let i = 0; i < 7; i++) {
    const d = new Date(`${s.termStart}T12:00:00Z`);
    d.setUTCDate(d.getUTCDate() + i);
    if (s.days.includes(d.getUTCDay())) {
      first = d.toISOString().slice(0, 10);
      break;
    }
  }
  const until = new Date(`${s.termEnd}T12:00:00Z`);
  until.setUTCDate(until.getUTCDate() + 1);
  const untilStr = `${until.toISOString().slice(0, 10).replace(/-/g, "")}T040000Z`;
  const ex = [...new Set(s.exdates)].filter((d) => d >= s.termStart && d <= s.termEnd).sort();
  return [
    "BEGIN:VCALENDAR", "VERSION:2.0", "PRODID:-//canvas-bot//EN",
    ...(s.tz === "America/New_York" ? NY_TZ : []),
    "BEGIN:VEVENT",
    `UID:${s.uid}`, `DTSTAMP:${stamp(new Date())}`,
    `DTSTART;TZID=${s.tz}:${localStamp(first, s.startMin)}`, `DTEND;TZID=${s.tz}:${localStamp(first, s.endMin)}`,
    `RRULE:FREQ=WEEKLY;BYDAY=${s.days.map((d) => BYDAY[d]).join(",")};UNTIL=${untilStr}`,
    ...ex.map((d) => `EXDATE;TZID=${s.tz}:${localStamp(d, s.startMin)}`),
    `SUMMARY:${esc(s.title)}`,
    ...(s.location ? [`LOCATION:${esc(s.location)}`] : []),
    "END:VEVENT", "END:VCALENDAR",
  ].join("\r\n");
}

/** Is this class already in the calendar (same UID, or a repeating event with the same title)? */
export async function classEventExists(s: ClassEventSpec): Promise<boolean> {
  const from = new Date(`${s.termStart}T00:00:00Z`), to = new Date(`${s.termEnd}T23:59:59Z`);
  const objs = await getStore().search(from, to);
  const title = `SUMMARY:${esc(s.title)}`.toLowerCase();
  return objs.some((o) => o.data.includes(`UID:${s.uid}`) || (/RRULE:/i.test(o.data) && o.data.toLowerCase().replace(/\r?\n[ \t]/g, "").split(/\r?\n/).some((l) => l.trim() === title)));
}

export async function createRecurringClass(s: ClassEventSpec): Promise<{ url: string; calendarUrl: string }> {
  return getStore().create(buildClassIcs(s), `${s.uid}.ics`);
}
