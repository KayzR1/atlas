import { afterEach, beforeEach, expect, test } from "bun:test";
import { buildSystemPrompt } from "../src/agent.ts";
import {
  applyDelete, applyUpdate, calendarTools, expand, handleConfirmation, isOwnedWritableCalendar, lastEventPrompt, resolveChoice, runCalendarTool,
  setNowForTests, setStoreForTests, type CalendarStore, type StoredObject,
} from "../src/calendar.ts";
import { runWithContext, type UserContext } from "../src/context.ts";
import { initDb, loadLastEvent } from "../src/db.ts";

const KEY = "+19195550100";
const CAL = "https://caldav.example/cal/home/";
const ctx = (role: "owner" | "member"): UserContext => ({ key: KEY, role, timezone: "America/New_York", canvasUrl: "https://x.example", canvasToken: "t" });
const promptFor = (role: "owner" | "member") => runWithContext(ctx(role), () => buildSystemPrompt(KEY));
const NOW = new Date("2026-10-16T14:00:00Z"); // Fri Oct 16, 10:00 AM EDT

class FakeStore implements CalendarStore {
  objs = new Map<string, StoredObject>();
  mutations = 0;
  private n = 0;
  add(name: string, data: string): StoredObject {
    const o = { url: `${CAL}${name}.ics`, etag: `e${++this.n}`, data, calendarUrl: CAL, calendar: "Home" };
    this.objs.set(o.url, o);
    return o;
  }
  async search() { return [...this.objs.values()]; }
  async get(_c: string, url: string) { const o = this.objs.get(url); return o ? { ...o } : null; }
  async put(obj: StoredObject, ics: string) { this.mutations++; this.objs.set(obj.url, { ...obj, data: ics, etag: `e${++this.n}` }); }
  async remove(obj: StoredObject) { this.mutations++; this.objs.delete(obj.url); }
  async create(ics: string, filename: string) {
    this.mutations++;
    const o = this.add(filename.replace(/\.ics$/, ""), ics);
    return { url: o.url, calendarUrl: CAL };
  }
}

const vevent = (o: { uid: string; summary: string; start: string; end: string; extra?: string[] }) =>
  ["BEGIN:VEVENT", `UID:${o.uid}`, "DTSTAMP:20261001T000000Z", `DTSTART:${o.start}`, `DTEND:${o.end}`, `SUMMARY:${o.summary}`, ...(o.extra ?? []), "END:VEVENT"];
const ics = (...lines: string[]) => ["BEGIN:VCALENDAR", "VERSION:2.0", "PRODID:-//test//EN", ...lines, "END:VCALENDAR"].join("\r\n");
const one = (uid: string, summary: string, start: string, end: string) => ics(...vevent({ uid, summary, start, end }));
const weekly = (uid = "wk@test") => ics(...vevent({ uid, summary: "Study group", start: "20261009T200000Z", end: "20261009T210000Z", extra: ["RRULE:FREQ=WEEKLY"] }));

const NY_TZ = [
  "BEGIN:VTIMEZONE", "TZID:America/New_York",
  "BEGIN:DAYLIGHT", "TZOFFSETFROM:-0500", "TZOFFSETTO:-0400", "TZNAME:EDT", "DTSTART:19700308T020000", "RRULE:FREQ=YEARLY;BYMONTH=3;BYDAY=2SU", "END:DAYLIGHT",
  "BEGIN:STANDARD", "TZOFFSETFROM:-0400", "TZOFFSETTO:-0500", "TZNAME:EST", "DTSTART:19701101T020000", "RRULE:FREQ=YEARLY;BYMONTH=11;BYDAY=1SU", "END:STANDARD",
  "END:VTIMEZONE",
];
const weeklyTz = () =>
  ics(...NY_TZ, "BEGIN:VEVENT", "UID:tz@test", "DTSTAMP:20261001T000000Z", "DTSTART;TZID=America/New_York:20261009T160000", "DTEND;TZID=America/New_York:20261009T170000", "SUMMARY:Lab", "RRULE:FREQ=WEEKLY", "END:VEVENT");

let store: FakeStore;
beforeEach(() => {
  initDb(":memory:");
  store = new FakeStore();
  setStoreForTests(store);
  setNowForTests(() => NOW);
});
afterEach(() => {
  setStoreForTests();
  setNowForTests();
});

const tool = (name: string, args: any) => runCalendarTool(name, args, KEY);
const question = (staged: string) => staged.split("nothing else: ")[1]!;
const events = (o: StoredObject, from = "2026-10-01", to = "2026-11-30") => expand(o.data, new Date(from), new Date(to), "");
const iso = (d: Date) => d.toISOString().replace(".000", "");

/** Create "Piano: Scales/Theory" Fri 4-5pm through the real stage -> yes flow. */
async function createPiano(start = "2026-10-16T16:00", end = "2026-10-16T17:00") {
  const staged = await tool("create_calendar_event", { title: "Piano: Scales/Theory", start, end, location: null, notes: null });
  expect(await handleConfirmation(KEY, "Yes")).toMatch(/^Added 'Piano: Scales\/Theory'/);
  return staged;
}

test("create still works, and null/empty optional params from the model no longer break it (the 'something went wrong' bug)", async () => {
  const staged = await tool("create_calendar_event", { title: "Piano: Scales/Theory", start: "2026-10-16T16:00", end: "2026-10-16T18:00", location: null, notes: "" });
  expect(staged).toContain("STAGED");
  expect(question(staged)).toBe("Add 'Piano: Scales/Theory' Fri 4–6pm?");
  expect(store.mutations).toBe(0);
  for (const t of calendarTools) {
    for (const [name, spec] of Object.entries<any>(t.function.parameters.properties)) {
      const required = (t.function.parameters as any).required ?? [];
      if (!required.includes(name)) expect(JSON.stringify(spec.type), `${t.function.name}.${name}`).toContain("null"); // Groq validates against this schema
    }
  }
  expect(await handleConfirmation(KEY, "yes")).toBe("Added 'Piano: Scales/Theory' Fri 4–6pm.");
  expect(store.objs.size).toBe(1);
});

test("find: keyword search in a date range (default next 14 days), with short ids", async () => {
  store.add("a", one("a@t", "Piano: Scales/Theory", "20261016T200000Z", "20261016T210000Z"));
  store.add("b", one("b@t", "Dentist", "20261017T150000Z", "20261017T160000Z"));
  store.add("c", one("c@t", "Piano: Rehearsal", "20261110T200000Z", "20261110T210000Z")); // beyond 14 days

  const r = await tool("find_calendar_events", { query: "piano scales" });
  expect(r).toMatch(/^1 match, now remembered as "last": id [0-9a-f]{4} \| Fri 4–5pm Piano: Scales\/Theory$/);
  const dflt = await tool("find_calendar_events", { query: "piano" });
  expect(dflt).toMatch(/^1 match/); // the default 14-day range excludes the Nov 10 event
  expect(dflt).not.toContain("Legs");
  const wide = await tool("find_calendar_events", { query: "piano", end: "2026-11-30" });
  expect(wide).toMatch(/^2 matches:/);
  expect(wide).toMatch(/id [0-9a-f]{4} \| Fri 4–5pm Piano: Scales\/Theory/);
  expect(await tool("find_calendar_events", { query: "nope" })).toMatch(/^No matching events/);
  expect(await tool("find_calendar_events", { query: "dentist", start: null, end: "" })).toMatch(/Dentist/);
  expect(store.mutations).toBe(0);
});

test("'edit that to 6pm' updates the same event instead of creating a duplicate (bug 1)", async () => {
  await createPiano();
  expect(store.objs.size).toBe(1);
  const uid = [...store.objs.values()][0]!.data.match(/UID:(.+)/)![1]!.trim();
  const before = store.mutations;

  const staged = await tool("update_calendar_event", { id: "last", start: "2026-10-16T16:00", end: "2026-10-16T18:00" });
  expect(question(staged)).toBe("Change 'Piano: Scales/Theory' Fri 4–5pm → 4–6pm?");
  expect(store.mutations).toBe(before); // nothing changes until yes
  expect(events([...store.objs.values()][0]!)[0]!.end.toISOString()).toBe("2026-10-16T21:00:00.000Z");

  expect(await handleConfirmation(KEY, "yes")).toBe("Updated 'Piano: Scales/Theory' to Fri 4–6pm.");
  expect(store.objs.size).toBe(1); // no duplicate
  const obj = [...store.objs.values()][0]!;
  expect(obj.data).toContain(`UID:${uid}`);
  expect(obj.data).toContain("SEQUENCE:1");
  const [ev] = events(obj);
  expect([iso(ev!.start), iso(ev!.end), ev!.title]).toEqual(["2026-10-16T20:00:00Z", "2026-10-16T22:00:00Z", "Piano: Scales/Theory"]);
  expect(loadLastEvent<any>(KEY)).toMatchObject({ end: ev!.end.getTime(), title: "Piano: Scales/Theory" });
});

test("update confirms with before -> after, a 'no' changes nothing, and other text cancels the staged change", async () => {
  await createPiano();
  const base = store.mutations;
  await tool("update_calendar_event", { id: "last", title: "Piano: Rehearsal", location: "Rec Center" });
  expect(await handleConfirmation(KEY, "no")).toBe("Okay, I didn't change anything.");
  expect(store.mutations).toBe(base);

  const q = question(await tool("update_calendar_event", { id: "last", title: "Piano: Rehearsal", location: "Rec Center" }));
  expect(q).toBe("Change 'Piano: Scales/Theory' Fri 4–5pm → 'Piano: Rehearsal', at Rec Center?");
  expect(await handleConfirmation(KEY, "what's due this week?")).toBeNull(); // goes to the model; the staged change is dropped
  expect(await handleConfirmation(KEY, "yes")).toBeNull();
  expect(store.mutations).toBe(base);
  expect([...store.objs.values()][0]!.data).not.toContain("Piano: Rehearsal");

  expect(await tool("update_calendar_event", { id: "last", title: "Piano: Scales/Theory" })).toMatch(/Nothing to change/);
});

test("'move it to 5' keeps the length; 'make it 2 hours' changes only the end", async () => {
  await createPiano("2026-10-16T16:00", "2026-10-16T17:00");
  expect(question(await tool("update_calendar_event", { id: "last", start: "2026-10-16T17:00" }))).toBe("Change 'Piano: Scales/Theory' Fri 4–5pm → 5–6pm?");
  await handleConfirmation(KEY, "yes");
  expect(question(await tool("update_calendar_event", { id: "last", end: "2026-10-16T19:00" }))).toBe("Change 'Piano: Scales/Theory' Fri 5–6pm → 5–7pm?");
  await handleConfirmation(KEY, "yes");
  const [ev] = events([...store.objs.values()][0]!);
  expect([iso(ev!.start), iso(ev!.end)]).toEqual(["2026-10-16T21:00:00Z", "2026-10-16T23:00:00Z"]);
  expect(await tool("update_calendar_event", { id: "last", start: "2026-10-17T10:00", end: "2026-10-17T09:00" })).toMatch(/end must be after start/);
});

test("delete: confirmation first, 'delete that' / 'cancel it' use the last event", async () => {
  await createPiano();
  const base = store.mutations;
  const q = question(await tool("delete_calendar_event", { id: "last" }));
  expect(q).toBe("Delete 'Piano: Scales/Theory' Fri 4–5pm?");
  expect(store.mutations).toBe(base);
  expect(store.objs.size).toBe(1);
  expect(await handleConfirmation(KEY, "yes")).toBe("Deleted 'Piano: Scales/Theory' Fri 4–5pm.");
  expect(store.objs.size).toBe(0);
  expect(loadLastEvent(KEY)).toBeNull();
  expect(await tool("delete_calendar_event", { id: "last" })).toMatch(/don't know that event/);
  expect(await tool("update_calendar_event", { id: "zzzz", title: "x" })).toMatch(/don't know that event/);
});

test("several matches: a numbered list, and the user's number picks the event", async () => {
  store.add("fri", one("fri@t", "Piano: Scales/Theory", "20261016T200000Z", "20261016T210000Z"));
  store.add("sat", one("sat@t", "Piano: Scales/Theory", "20261017T140000Z", "20261017T150000Z"));
  const r = await tool("find_calendar_events", { query: "piano" });
  expect(r).toContain("2 matches:");
  expect(r).toContain("Which one?\n1) Fri 4–5pm Piano: Scales/Theory\n2) Sat 10–11am Piano: Scales/Theory\nReply with a number.");

  expect(resolveChoice(KEY, "what about sunday")).toBeNull();
  expect(resolveChoice(KEY, "9")).toBeNull(); // not in the list
  const picked = resolveChoice(KEY, "2")!;
  expect(picked).toContain("option 2");
  expect(picked).toContain("Sat 10–11am");
  expect(resolveChoice(KEY, "2")).toBeNull(); // used up
  expect(lastEventPrompt(KEY)).toContain("2026-10-17T10:00 to 2026-10-17T11:00");

  expect(question(await tool("update_calendar_event", { id: "last", start: "2026-10-17T12:00" }))).toBe("Change 'Piano: Scales/Theory' Sat 10–11am → 12–1pm?");
  await handleConfirmation(KEY, "yes");
  const times = [...store.objs.values()].map((o) => iso(events(o)[0]!.start)).sort();
  expect(times).toEqual(["2026-10-16T20:00:00Z", "2026-10-17T16:00:00Z"]); // Friday untouched, Saturday moved
});

test("'same exact' / 'again' resolve against the last event (bug 2: the model is told what the last event is)", async () => {
  expect(promptFor("owner")).toContain("No calendar event has been created or touched yet");
  await createPiano("2026-10-16T16:00", "2026-10-16T18:00");
  const prompt = promptFor("owner");
  expect(prompt).toContain(`'Piano: Scales/Theory' from 2026-10-16T16:00 to 2026-10-16T18:00 (Fri 4–6pm)`);
  expect(prompt).toMatch(/"same", "same exact", "same time", "again", "one more"/);
  expect(prompt).toContain("Never use create_calendar_event to edit");
  // the model then repeats it exactly, still behind a confirmation
  expect(question(await tool("create_calendar_event", { title: "Piano: Scales/Theory", start: "2026-10-16T16:00", end: "2026-10-16T18:00" }))).toBe("Add 'Piano: Scales/Theory' Fri 4–6pm?");
  await handleConfirmation(KEY, "yes");
  expect(store.objs.size).toBe(2);

  // a member's prompt never mentions the calendar or leaks the owner's last event
  const member = promptFor("member");
  expect(member).toContain("You have no calendar access");
  expect(member).not.toContain("Piano");
  expect(member).not.toContain("update_calendar_event");
  expect(member).not.toContain("same exact");
});

test("nothing is ever created, changed or deleted without a yes", async () => {
  await createPiano();
  const base = store.mutations;
  await tool("update_calendar_event", { id: "last", end: "2026-10-16T18:00" });
  await tool("delete_calendar_event", { id: "last" }); // replaces the staged update
  await tool("create_calendar_event", { title: "x", start: "2026-10-16T09:00", end: "2026-10-16T10:00" });
  await tool("find_calendar_events", { query: "piano" });
  await tool("list_calendar_events", { start: "2026-10-16", end: "2026-10-16" });
  expect(store.mutations).toBe(base);
  expect(await handleConfirmation(KEY, "maybe")).toBeNull();
  expect(await handleConfirmation(KEY, "yes")).toBeNull();
  expect(store.mutations).toBe(base);
});

test("only calendars the user owns can be edited: subscribed, shared-with-me and Canvas feeds are excluded", () => {
  const cal = (displayName: string, resourcetype: string[], components = ["VEVENT"]) => ({ displayName, resourcetype, components, url: "u" }) as any;
  expect(isOwnedWritableCalendar(cal("Home", ["collection", "calendar"]))).toBe(true);
  expect(isOwnedWritableCalendar(cal("Mine, shared out", ["collection", "calendar", "shared-owner"]))).toBe(true);
  expect(isOwnedWritableCalendar(cal("Friend's", ["collection", "calendar", "shared"]))).toBe(false);
  expect(isOwnedWritableCalendar(cal("Feed", ["collection", "subscribed"]))).toBe(false);
  expect(isOwnedWritableCalendar(cal("Canvas Calendar", ["collection", "calendar"]))).toBe(false);
  expect(isOwnedWritableCalendar(cal("Reminders", ["collection", "calendar"], ["VTODO"]))).toBe(false);
});

// ---- recurring events ----

test("recurring: asks 'just this one or all of them', then confirms with the scope", async () => {
  const obj = store.add("wk", weekly());
  expect(events(obj, "2026-10-01", "2026-11-05").map((e) => iso(e.start))).toEqual(["2026-10-09T20:00:00Z", "2026-10-16T20:00:00Z", "2026-10-23T20:00:00Z", "2026-10-30T20:00:00Z"]);
  const found = await tool("find_calendar_events", { query: "study", start: "2026-10-22", end: "2026-10-24" });
  expect(found).toContain("(repeats)");
  const staged = await tool("update_calendar_event", { id: "last", start: "2026-10-23T17:00" });
  expect(question(staged)).toBe("Just this one, or all of them?");
  expect(store.mutations).toBe(0);
  expect(await handleConfirmation(KEY, "just this one")).toBe("Change 'Study group' Fri Oct 23 4–5pm → 5–6pm (just this one)?");
  expect(store.mutations).toBe(0);
  expect(await handleConfirmation(KEY, "yes")).toBe("Updated 'Study group' to Fri Oct 23 5–6pm (just that one).");

  const o = store.objs.get(obj.url)!;
  expect(o.data).toContain("RECURRENCE-ID");
  expect(events(o, "2026-10-01", "2026-11-05").map((e) => iso(e.start))).toEqual(["2026-10-09T20:00:00Z", "2026-10-16T20:00:00Z", "2026-10-23T21:00:00Z", "2026-10-30T20:00:00Z"]);
  expect(o.data.match(/RRULE/g)!.length).toBe(1); // series intact, not duplicated
});

test("recurring: 'all of them' changes the whole series; a different reply cancels", async () => {
  const obj = store.add("wk", weekly());
  await tool("find_calendar_events", { query: "study", start: "2026-10-22", end: "2026-10-24" });
  await tool("update_calendar_event", { id: "last", title: "Study session", start: "2026-10-23T17:00" });
  expect(await handleConfirmation(KEY, "all")).toBe("Change 'Study group' Fri Oct 23 4–5pm → 'Study session', 5–6pm (all events)?");
  await handleConfirmation(KEY, "yes");
  const evs = events(store.objs.get(obj.url)!, "2026-10-01", "2026-11-05");
  expect(evs.map((e) => [e.title, iso(e.start)])).toEqual([
    ["Study session", "2026-10-09T21:00:00Z"], ["Study session", "2026-10-16T21:00:00Z"], ["Study session", "2026-10-23T21:00:00Z"], ["Study session", "2026-10-30T21:00:00Z"],
  ]);

  await tool("delete_calendar_event", { id: "last" });
  expect(await handleConfirmation(KEY, "actually what's due?")).toBeNull(); // not an answer: nothing happens
  expect(await handleConfirmation(KEY, "all")).toBeNull();
  expect(store.objs.size).toBe(1);
});

test("recurring: delete just this one adds an EXDATE; delete all removes the series", async () => {
  const obj = store.add("wk", weekly());
  await tool("find_calendar_events", { query: "study", start: "2026-10-22", end: "2026-10-24" });
  await tool("delete_calendar_event", { id: "last" });
  expect(await handleConfirmation(KEY, "this one")).toBe("Delete 'Study group' Fri Oct 23 4–5pm (just this one)?");
  expect(await handleConfirmation(KEY, "yes")).toMatch(/Deleted 'Study group' .* \(just that one\)\./);
  const o = store.objs.get(obj.url)!;
  expect(o.data).toContain("EXDATE");
  expect(events(o, "2026-10-01", "2026-11-05").map((e) => iso(e.start))).toEqual(["2026-10-09T20:00:00Z", "2026-10-16T20:00:00Z", "2026-10-30T20:00:00Z"]);

  await tool("find_calendar_events", { query: "study", start: "2026-10-15", end: "2026-10-17" });
  await tool("delete_calendar_event", { id: "last" });
  await handleConfirmation(KEY, "all of them");
  await handleConfirmation(KEY, "yes");
  expect(store.objs.size).toBe(0);
});

test("recurring events in a timezone (how iPhones save them): 'just this one' edits and deletes still line up", () => {
  const data = weeklyTz();
  const oct23 = new Date("2026-10-23T20:00:00Z").getTime();
  const moved = applyUpdate(data, { recId: oct23, scope: "one", occ: { start: new Date(oct23), end: new Date(oct23 + 3600_000) } }, { start: new Date(oct23 + 3600_000), end: new Date(oct23 + 7200_000) });
  expect(moved).toMatch(/RECURRENCE-ID;TZID=America\/New_York:20261023T160000/);
  expect(expand(moved, new Date("2026-10-01"), new Date("2026-11-05"), "").map((e) => iso(e.start))).toEqual([
    "2026-10-09T20:00:00Z", "2026-10-16T20:00:00Z", "2026-10-23T21:00:00Z", "2026-10-30T20:00:00Z",
  ]);
  const gone = applyDelete(data, { recId: oct23, scope: "one" })!;
  expect(gone).toMatch(/EXDATE;TZID=America\/New_York:20261023T160000/);
  expect(expand(gone, new Date("2026-10-01"), new Date("2026-11-05"), "").length).toBe(3);
  expect(applyDelete(data, { recId: oct23, scope: "all" })).toBeNull();
  // moving a single occurrence twice edits the same override
  const twice = applyUpdate(moved, { recId: oct23, scope: "one", occ: { start: new Date(oct23 + 3600_000), end: new Date(oct23 + 7200_000) } }, { title: "Lab (moved)" });
  expect(twice.match(/RECURRENCE-ID/g)!.length).toBe(1);
});
