import { createRecurringClass, classEventExists, calendarConfigured } from "./calendar.ts";
import { isOverBudget } from "./budget.ts";
import { requireContext } from "./context.ts";
import {
  clearClasses, insertClass, listClassOverrides, listClasses, removeClassesByCourse, removeClassOverride, replaceClasses, setClassAlerts, setClassOverride,
  upsertClassByCourse, getUser, setCredits, type ClassRow, type NewClass,
} from "./db.ts";
import { defaultTerm, termFor, TERMS } from "./terms.ts";

// Class schedules. Parsing, reading back, saving and every answer are plain code; the LLM is only a fallback for messy pastes.

export type ClassSpec = { course: string; days: number[]; startMin: number; endMin: number; location: string; units?: number };
export type ParseResult = { classes: ClassSpec[]; unparsed: string[]; term?: { start: string; end: string } };

const DAY_NUM: Record<string, number> = {
  sunday: 0, sun: 0, su: 0, monday: 1, mon: 1, m: 1, tuesday: 2, tues: 2, tue: 2, tu: 2, t: 2, wednesday: 3, wed: 3, w: 3,
  thursday: 4, thurs: 4, thur: 4, thu: 4, th: 4, r: 4, friday: 5, fri: 5, f: 5, saturday: 6, sat: 6, sa: 6,
};
const DAY_ATOM = /^(thursday|thurs|thur|thu|tuesday|tues|tue|wednesday|wed|monday|mon|friday|fri|saturday|sat|sunday|sun|th|tu|sa|su|m|t|w|r|f)/i;
const DAY_NAMES = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

// ---------- parsing ----------

/** "MWF", "TTh", "Tu/Th", "M W F", "Mon, Wed", "Tues Thurs" -> [1,3,5] and the text after the days. */
export function parseDays(s: string): { days: number[]; rest: string } | null {
  let rest = s.trimStart();
  const days: number[] = [];
  for (;;) {
    const m = rest.match(DAY_ATOM);
    if (!m) break;
    const atom = m[1]!.toLowerCase();
    const after = rest.slice(m[0].length);
    if (atom.length >= 3 && /^[a-z]/i.test(after)) break; // "Wed" glued to more letters is a different word, not a day
    days.push(DAY_NUM[atom]!);
    rest = after.replace(/^[\s,/&+-]+/, "");
  }
  if (!days.length || /^[a-z]/i.test(rest)) return null; // days are followed by a time, not another word ("Weekly" is not W)
  return { days: [...new Set(days)].sort((a, b) => a - b), rest: rest.trim() };
}

const TIME_RANGE = /^\s*(\d{1,2})(?::(\d{2}))?\s*(a\.?m\.?|p\.?m\.?)?\s*(?:-|–|—|to|until|thru|through)\s*(\d{1,2})(?::(\d{2}))?\s*(a\.?m\.?|p\.?m\.?)?(?![\d:])/i;

const to24 = (h: number, mer: string) => (mer.toLowerCase().startsWith("p") ? (h % 12) + 12 : h % 12);
/** A 12-hour time with no am/pm, as a class would plausibly be: 8-11 morning, 12 noon, 1-7 afternoon/evening. */
const guess24 = (h: number) => (h >= 8 && h <= 12 ? h : h >= 1 && h <= 7 ? h + 12 : h);

/** "9:05-9:55", "9:05-9:55 AM", "2-3:15pm", "12:30-1:45", "13:00-14:15" -> minutes since midnight. */
export function parseTimeRange(s: string): { startMin: number; endMin: number; rest: string } | null {
  const m = s.match(TIME_RANGE);
  if (!m) return null;
  const [h1, m1, mer1, h2, m2, mer2] = [Number(m[1]), Number(m[2] ?? 0), m[3], Number(m[4]), Number(m[5] ?? 0), m[6]];
  if (m1 > 59 || m2 > 59 || h1 > 24 || h2 > 24) return null;
  let sH: number, eH: number;
  if (h1 > 12 || h2 > 12) {
    sH = h1; // 24-hour clock
    eH = h2;
  } else if (mer1 && mer2) {
    sH = to24(h1, mer1);
    eH = to24(h2, mer2);
  } else if (mer2) {
    // only the end says am/pm: start in the same half of the day unless that puts it after the end
    eH = to24(h2, mer2);
    const same = to24(h1, mer2), other = to24(h1, mer2.toLowerCase().startsWith("p") ? "am" : "pm");
    sH = same * 60 + m1 < eH * 60 + m2 ? same : other;
  } else if (mer1) {
    sH = to24(h1, mer1);
    const same = to24(h2, mer1), other = to24(h2, mer1.toLowerCase().startsWith("p") ? "am" : "pm");
    eH = same * 60 + m2 > sH * 60 + m1 ? same : other;
  } else {
    sH = guess24(h1);
    eH = guess24(h2);
    if (eH * 60 + m2 <= sH * 60 + m1) eH += 12;
  }
  const startMin = sH * 60 + m1, endMin = eH * 60 + m2;
  if (endMin <= startMin || endMin - startMin > 6 * 60 || startMin < 6 * 60 || endMin > 24 * 60) return null;
  return { startMin, endMin, rest: s.slice(m[0].length).trim() };
}

const COURSE = /^([A-Za-z]{2,5})\s?(\d{2,3}[A-Za-z]?)(?:[.-]\d{1,3})?(?![A-Za-z0-9])/;

export const normalizeCourse = (s: string): string | null => {
  const m = s.trim().match(COURSE);
  return m ? `${m[1]!.toUpperCase()} ${m[2]!.toUpperCase()}` : null;
};
const courseKey = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, "");

/** "3 units", "4.00 credits" (or a trailing "4.00" as ConnectCarolina prints it) -> credit hours, and the line without it. */
export function takeUnits(line: string): { line: string; units?: number } {
  const m = line.match(/[\s,(]+(\d(?:\.\d{1,2})?)\s*(?:units?|credits?|credit hours?|cr|hrs?)\b\)?/i) ?? line.match(/\s+(\d\.\d{2})\s*$/);
  const n = m ? Number(m[1]) : NaN;
  if (!m || !(n >= 0.5 && n <= 8)) return { line };
  return { line: (line.slice(0, m.index) + line.slice(m.index! + m[0].length)).trim(), units: n };
}

/** One line like "MATH 110 MWF 9:05-9:55 Phillips 120" (a course title between the code and the days is ignored). */
export function parseClassLine(rawLine: string): ClassSpec | null {
  const { line, units } = takeUnits(rawLine.trim());
  const t = line.trim().replace(/^\s*(?:[-*•]|\d+[.)])\s+/, "");
  const cm = t.match(COURSE);
  const course = cm ? `${cm[1]!.toUpperCase()} ${cm[2]!.toUpperCase()}` : null;
  if (!cm || !course) return null;
  let rest = t.slice(cm[0].length).replace(/^[\s:,-]+/, "");
  for (let skipped = 0; skipped <= 6; skipped++) {
    const d = parseDays(rest);
    const tm = d ? parseTimeRange(d.rest) : null;
    if (d && tm) {
      const location = tm.rest.replace(/^[\s@,|:\-–—]+/, "").replace(/^in\s+/i, "").replace(/[\s,;.]+$/, "").replace(/\s+/g, " ").slice(0, 60);
      return { course, days: d.days, startMin: tm.startMin, endMin: tm.endMin, location, ...(units ? { units } : {}) };
    }
    const next = rest.match(/^\S+\s+/); // skip one word of title and try again
    if (!next) break;
    rest = rest.slice(next[0].length);
  }
  return null;
}

const HEADER = /^(?:my\s+)?(?:classes|class schedule|schedule|courses)[:\s]*$|^(?:fall|spring|summer)\s+\d{4}[:\s]*$/i;
const TERM_DATES = /^\s*(?:term|semester)\s*[:=]?\s*(\d{4}-\d{2}-\d{2})\s*(?:to|-|–|through|until)\s*(\d{4}-\d{2}-\d{2})\s*$/i;
const TERM_NAME = /^\s*(?:term|semester)\s*[:=]?\s*((?:fall|spring|summer)\s+\d{4})\s*$/i;

export function parseClassText(text: string): ParseResult {
  const out: ParseResult = { classes: [], unparsed: [] };
  let lines = text.split(/\r?\n/);
  if (lines.filter((l) => l.trim()).length === 1 && text.includes(";")) lines = text.split(";"); // "A MWF 9-10; B TTh 11-12"
  for (const raw of lines) {
    const line = raw.trim();
    if (!line || HEADER.test(line)) continue;
    const td = line.match(TERM_DATES);
    if (td) {
      out.term = { start: td[1]!, end: td[2]! };
      continue;
    }
    const tn = line.match(TERM_NAME);
    if (tn) {
      const t = TERMS.find((x) => x.name.toLowerCase() === tn[1]!.toLowerCase().replace(/\s+/g, " "));
      if (t) out.term = { start: t.start, end: t.end };
      else out.unparsed.push(line.slice(0, 80));
      continue;
    }
    const c = parseClassLine(line);
    if (c) out.classes.push(c);
    else out.unparsed.push(line.slice(0, 80));
  }
  return out;
}

/** Validate/normalise what the LLM fallback returns ({course, days:"MWF", start:"09:05", end:"09:55", location}). */
export function normalizeLlmClasses(raw: unknown): ClassSpec[] {
  const arr = Array.isArray((raw as any)?.classes) ? (raw as any).classes : Array.isArray(raw) ? raw : [];
  const out: ClassSpec[] = [];
  for (const r of arr) {
    const course = typeof r?.course === "string" ? normalizeCourse(r.course) : null;
    const d = typeof r?.days === "string" ? parseDays(r.days) : null;
    const t = typeof r?.start === "string" && typeof r?.end === "string" ? parseTimeRange(`${r.start}-${r.end}`) : null;
    if (!course || !d || d.rest || !t) continue;
    const units = Number(r.units);
    out.push({ course, days: d.days, startMin: t.startMin, endMin: t.endMin, location: String(r.location ?? "").replace(/\s+/g, " ").trim().slice(0, 60), ...(units >= 0.5 && units <= 8 ? { units } : {}) });
  }
  return out;
}

// ---------- dates and formatting ----------

export const ymdOf = (d: Date, tz: string) => d.toLocaleDateString("en-CA", { timeZone: tz });
export const weekdayOf = (ymd: string) => new Date(`${ymd}T12:00:00Z`).getUTCDay();
export function addDays(ymd: string, n: number): string {
  const d = new Date(`${ymd}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}
export function minutesOf(d: Date, tz: string): number {
  const p = Object.fromEntries(new Intl.DateTimeFormat("en-US", { timeZone: tz, hourCycle: "h23", hour: "numeric", minute: "numeric" }).formatToParts(d).map((x) => [x.type, x.value]));
  return Number(p.hour) * 60 + Number(p.minute);
}

export function fmtMin(min: number): string {
  const h = Math.floor(min / 60), m = min % 60;
  return `${h % 12 === 0 ? 12 : h % 12}:${String(m).padStart(2, "0")} ${h >= 12 ? "PM" : "AM"}`;
}
export function fmtRange(a: number, b: number): string {
  const x = fmtMin(a), y = fmtMin(b);
  return x.slice(-2) === y.slice(-2) ? `${x.slice(0, -3)}–${y}` : `${x}–${y}`;
}
export function fmtDays(days: number[] | string): string {
  const d = typeof days === "string" ? [...days].map(Number) : days;
  if (d.length === 5 && d.join("") === "12345") return "Mon–Fri";
  return d.map((n) => DAY_NAMES[n]).join("/");
}
const fmtLoc = (loc: string) => (loc ? ` (${loc})` : "");
const dayLabelOf = (ymd: string) => `${DAY_NAMES[weekdayOf(ymd)]} ${new Date(`${ymd}T12:00:00Z`).toLocaleDateString("en-US", { timeZone: "UTC", month: "short", day: "numeric" })}`;

// ---------- the schedule ----------

const daySet = (c: Pick<ClassRow, "days">) => new Set([...c.days].map(Number));

/** Why there is no class on this date, or null if classes meet. User overrides win over the university calendar. */
export function noClassReason(key: string, ymd: string, term: { start: string; end: string }): string | null {
  const o = listClassOverrides(key).get(ymd);
  if (o === true) return "a day you skipped";
  if (o === false) return null;
  return termFor(term.start, term.end)?.noClass.find((h) => h.date === ymd)?.name ?? null;
}

export const termOfClasses = (rows: ClassRow[]) => (rows[0] ? { start: rows[0].term_start, end: rows[0].term_end } : null);

/** The classes that actually meet on this local date, in time order. */
export function classesOn(key: string, ymd: string): ClassRow[] {
  const rows = listClasses(key);
  const overrides = listClassOverrides(key);
  const wd = weekdayOf(ymd);
  return rows
    .filter((c) => daySet(c).has(wd) && ymd >= c.term_start && ymd <= c.term_end && !(overrides.get(ymd) === true) && (overrides.get(ymd) === false || !termFor(c.term_start, c.term_end)?.noClass.some((h) => h.date === ymd)))
    .sort((a, b) => a.start_min - b.start_min);
}

export function nextClass(key: string, now: Date, tz: string): { cls: ClassRow; date: string; daysAhead: number; inProgress: ClassRow | null } | null {
  const today = ymdOf(now, tz), mins = minutesOf(now, tz);
  const inProgress = classesOn(key, today).find((c) => c.start_min <= mins && mins < c.end_min) ?? null;
  for (let i = 0; i <= 60; i++) {
    const date = addDays(today, i);
    const c = classesOn(key, date).find((x) => i > 0 || x.start_min > mins);
    if (c) return { cls: c, date, daysAhead: i, inProgress };
  }
  return null;
}

const rowLine = (c: Pick<ClassRow, "course" | "days" | "start_min" | "end_min" | "location">) => `${c.course}  ${fmtDays(c.days)} ${fmtRange(c.start_min, c.end_min)}${c.location ? `  ${c.location}` : ""}`;

// ---------- zero-token answers ----------

const norm = (t: string) => t.toLowerCase().replace(/[’‘]/g, "'").replace(/\s+/g, " ").trim().replace(/[?!.\s]+$/, "");
const NEXT_Q = /^(?:(?:what'?s|whats|what is|when'?s|when is)\s+)?(?:my\s+)?next class(?:\s+(?:is|today))?$/;
const DAY_Q = /^(?:(?:what|which)\s+)?(?:classes|class)(?:\s+do\s+i\s+have)?\s+(today|tomorrow)$|^do i have (?:any )?(?:class|classes)\s+(today|tomorrow)$|^(?:what'?s|whats|what is)\s+my\s+(?:class\s+)?schedule\s+(today|tomorrow)$/;
const WHERE_Q = /^(?:where(?:'s| is| are)|when(?:'s| is| does| do)|what room is|what time is)\s+(?:my\s+)?(.+?)(?:\s+class)?(?:\s+(?:meet|meets|at))?$/;

export type ClassQuery = { kind: "next" } | { kind: "day"; which: "today" | "tomorrow" } | { kind: "where"; q: string };
export function parseClassQuery(text: string): ClassQuery | null {
  const t = norm(text);
  if (NEXT_Q.test(t)) return { kind: "next" };
  const d = t.match(DAY_Q);
  if (d) return { kind: "day", which: (d[1] ?? d[2] ?? d[3]) as "today" | "tomorrow" };
  const w = t.match(WHERE_Q);
  if (w && /^[a-z]{2,5} ?\d{2,3}[a-z]?$/.test(w[1]!.trim())) return { kind: "where", q: w[1]!.trim() }; // only course-code-shaped targets: "where is the library" is not ours
  return null;
}

export function answerClassQuery(key: string, q: ClassQuery, now: Date, tz: string): string {
  const rows = listClasses(key);
  if (!rows.length) return noScheduleText();
  const today = ymdOf(now, tz);
  if (q.kind === "day") {
    const date = q.which === "today" ? today : addDays(today, 1);
    const list = classesOn(key, date);
    if (!list.length) {
      const reason = noClassReason(key, date, termOfClasses(rows)!);
      const term = termOfClasses(rows)!;
      const out = date < term.start || date > term.end ? ` (outside your term, ${term.start} to ${term.end})` : reason ? ` (${reason})` : "";
      return `No classes ${q.which}${out}.`;
    }
    return `Classes ${q.which} (${dayLabelOf(date)}):\n${list.map((c) => `${fmtRange(c.start_min, c.end_min)}  ${c.course}${fmtLoc(c.location)}`).join("\n")}`;
  }
  if (q.kind === "where") {
    const k = courseKey(q.q);
    const hits = rows.filter((c) => courseKey(c.course).includes(k) || k.includes(courseKey(c.course)));
    if (!hits.length) return `I don't have ${q.q.toUpperCase()} in your classes. Yours: ${[...new Set(rows.map((c) => c.course))].join(", ")}.`;
    return hits
      .map((c) => `${c.course} meets ${fmtDays(c.days)} ${fmtRange(c.start_min, c.end_min)}${c.location ? ` in ${c.location}` : " (I don't have a room saved)"}.`)
      .join("\n");
  }
  const n = nextClass(key, now, tz);
  if (!n) return "No more classes this term.";
  const when = n.daysAhead === 0 ? "today" : n.daysAhead === 1 ? "tomorrow" : dayLabelOf(n.date);
  const now_ = n.inProgress ? `In class now: ${n.inProgress.course} until ${fmtMin(n.inProgress.end_min)}${fmtLoc(n.inProgress.location)}. ` : "";
  return `${now_}Next class: ${n.cls.course} ${when} at ${fmtMin(n.cls.start_min)}${fmtLoc(n.cls.location)}.`;
}

const noScheduleText = () => `I don't have your classes yet. Text "my classes" and then one class per line, like:\nDATA 101 MWF 9:05-9:55 Sterling 120\nECON 210 TTh 11-12:15 Gardner 305`;

// ---------- uses elsewhere (brief, nudges, planner, alerts, prompt) ----------

/** Top line of the morning brief, or null if the user has no schedule. */
export function classesBriefLine(key: string, now: Date, tz: string): string | null {
  const rows = listClasses(key);
  if (!rows.length) return null;
  const date = ymdOf(now, tz);
  const list = classesOn(key, date);
  if (list.length) return `Classes: ${list.map((c) => `${fmtRange(c.start_min, c.end_min)} ${c.course}${fmtLoc(c.location)}`).join("; ")}`;
  const term = termOfClasses(rows)!;
  const reason = date < term.start || date > term.end ? null : noClassReason(key, date, term);
  return `Classes: none today${reason ? ` (${reason})` : ""}.`;
}

/** " (ECON 210 meets 11:00 AM–12:15 PM that day)" if that course has class on the due date. */
export function classMeetsNote(key: string, courseLabel: string, due: Date, tz: string): string {
  const k = courseKey(courseLabel);
  const c = classesOn(key, ymdOf(due, tz)).find((x) => courseKey(x.course) === k);
  return c ? ` (${c.course} meets ${fmtRange(c.start_min, c.end_min)} that day)` : "";
}

/** Class meetings as busy time between two instants (the study planner won't put a block on top of a class). */
export function classBusy(key: string, from: Date, to: Date, tz: string): { start: Date; end: Date }[] {
  const out: { start: Date; end: Date }[] = [];
  const last = ymdOf(to, tz);
  for (let d = ymdOf(from, tz); d <= last; d = addDays(d, 1)) {
    for (const c of classesOn(key, d)) {
      const start = wallTime(d, c.start_min, tz), end = wallTime(d, c.end_min, tz);
      if (end > from && start < to) out.push({ start, end });
    }
  }
  return out;
}

/** A local wall-clock moment as an instant. */
export function wallTime(ymd: string, min: number, tz: string): Date {
  const guess = Date.parse(`${ymd}T${String(Math.floor(min / 60)).padStart(2, "0")}:${String(min % 60).padStart(2, "0")}:00Z`);
  const off = (ms: number) => {
    const p = Object.fromEntries(new Intl.DateTimeFormat("en-US", { timeZone: tz, hourCycle: "h23", year: "numeric", month: "numeric", day: "numeric", hour: "numeric", minute: "numeric", second: "numeric" }).formatToParts(new Date(ms)).map((x) => [x.type, x.value]));
    return Date.UTC(+p.year!, +p.month! - 1, +p.day!, +p.hour!, +p.minute!, +p.second!) - Math.floor(ms / 1000) * 1000;
  };
  let utc = guess - off(guess);
  utc = guess - off(utc);
  return new Date(utc);
}

/** Heads-ups due right now: a class that starts in 1-15 minutes. `key` is the dedupe key (once per class per day). */
export function dueClassAlerts(userKey: string, now: Date, tz: string): { key: string; text: string }[] {
  const date = ymdOf(now, tz), mins = minutesOf(now, tz);
  return classesOn(userKey, date)
    .map((c) => ({ c, until: c.start_min - mins }))
    .filter(({ until }) => until > 0 && until <= 15)
    .map(({ c, until }) => ({ key: `classalert:${date}:${c.id}`, text: `Heads-up: ${c.course} starts in ${until} min (${fmtMin(c.start_min)})${fmtLoc(c.location)}.` }));
}

/** For the system prompt, only when the question is about classes: the schedule in one compact line. */
export function classPromptLine(key: string): string | null {
  const rows = listClasses(key);
  if (!rows.length) return null;
  return `Class schedule: ${rows.map((c) => `${c.course} ${fmtDays(c.days)} ${fmtRange(c.start_min, c.end_min)}${c.location ? ` ${c.location}` : ""}`).join("; ")}. Answer class-time questions from this.`;
}
export const looksClassRelated = (t: string) => /\b(class(es)?|lectures?|meets?|my schedule|what room|which room|building|where (is|do|does)|when (is|does|do))\b/i.test(t);

// ---------- saving: read back, then wait for yes ----------

type Pending =
  | { kind: "save"; mode: "set" | "add" | "edit"; specs: ClassSpec[]; term: { start: string; end: string }; expires: number }
  | { kind: "clear"; expires: number }
  | { kind: "calsync"; rows: ClassRow[]; expires: number };
const pending = new Map<string, Pending>();
const TTL_MS = 15 * 60_000;
/** For tests: forget every staged change. */
export const resetClassState = () => pending.clear();

const YES = /^(y|yes|yep|yeah|yup|sure|ok|okay|save|save it|correct|looks good|that'?s right|do it|go ahead)\W*$/i;
const NO = /^(n|no|nope|nah|cancel|never ?mind|wrong|stop)\W*$/i;

export type ClassDeps = {
  now?: () => Date;
  /** Fallback parser for messy pastes (an LLM); returns null if unavailable. */
  llmParse?: (text: string) => Promise<ClassSpec[] | null>;
};

function toRows(specs: ClassSpec[], term: { start: string; end: string }): NewClass[] {
  return specs.map((s) => ({ course: s.course, days: s.days.join(""), start_min: s.startMin, end_min: s.endMin, location: s.location, term_start: term.start, term_end: term.end }));
}

function termLine(term: { start: string; end: string }): string {
  const t = termFor(term.start, term.end);
  return t ? `${t.name}, ${t.start} to ${t.end}, skipping UNC's no-class days` : `${term.start} to ${term.end}`;
}

function readback(mode: "set" | "add" | "edit", specs: ClassSpec[], term: { start: string; end: string }, existing: ClassRow[], unparsed: string[]): string {
  const lines: string[] = [];
  if (mode === "edit") {
    for (const s of specs) {
      const before = existing.filter((c) => c.course === s.course);
      lines.push(before.length ? `${s.course}: ${before.map((c) => `${fmtDays(c.days)} ${fmtRange(c.start_min, c.end_min)}${c.location ? " " + c.location : ""}`).join(" + ")} → ${fmtDays(s.days)} ${fmtRange(s.startMin, s.endMin)}${s.location ? " " + s.location : ""}` : `New: ${rowLine({ course: s.course, days: s.days.join(""), start_min: s.startMin, end_min: s.endMin, location: s.location })}`);
    }
    return `Change:\n${lines.join("\n")}\nSave? Reply yes or no.`;
  }
  specs.forEach((s, i) => lines.push(`${i + 1}) ${rowLine({ course: s.course, days: s.days.join(""), start_min: s.startMin, end_min: s.endMin, location: s.location })}${s.units ? `  ${s.units} units` : ""}`));
  const head = mode === "set" ? `I read ${specs.length} class${specs.length > 1 ? "es" : ""} (${termLine(term)}):` : `Adding ${specs.length} class${specs.length > 1 ? "es" : ""}:`;
  const skip = unparsed.length ? `\nI couldn't read: ${unparsed.map((u) => `"${u}"`).join("; ")}` : "";
  const tail = mode === "set" ? (existing.length ? "This replaces your current schedule." : "") : "";
  return `${head}\n${lines.join("\n")}${skip}\n${tail ? tail + " " : ""}Save? Reply yes or no.`;
}

function apply(key: string, p: Extract<Pending, { kind: "save" }>): ClassRow[] {
  for (const s of p.specs) if (s.units) setCredits(key, s.course, s.units); // units from a ConnectCarolina paste feed the GPA
  const rows = toRows(p.specs, p.term);
  if (p.mode === "set") replaceClasses(key, rows);
  else if (p.mode === "edit") rows.forEach((r) => upsertClassByCourse(key, r));
  else rows.forEach((r) => insertClass(key, r));
  return listClasses(key);
}

/** The owner's optional extra: weekly repeating events in iCloud, without duplicating ones already there. */
async function syncToCalendar(key: string, rows: ClassRow[], tz: string): Promise<string> {
  const added: string[] = [], existed: string[] = [];
  for (const c of rows) {
    const term = termFor(c.term_start, c.term_end);
    const spec = {
      uid: classUid(key, c), title: c.course, location: c.location, days: [...c.days].map(Number), startMin: c.start_min, endMin: c.end_min,
      termStart: c.term_start, termEnd: c.term_end, exdates: (term?.noClass ?? []).map((h) => h.date).concat([...listClassOverrides(key)].filter(([, skip]) => skip).map(([d]) => d)), tz,
    };
    if (await classEventExists(spec)) existed.push(c.course);
    else {
      await createRecurringClass(spec);
      added.push(c.course);
    }
  }
  return `${added.length ? `Added ${added.length} weekly event${added.length > 1 ? "s" : ""} to your calendar: ${added.join(", ")}.` : "Nothing new to add."}${existed.length ? ` Already there: ${existed.join(", ")}.` : ""}`;
}

function classUid(key: string, c: ClassRow): string {
  const h = new Bun.CryptoHasher("sha1").update(`${key}|${c.course}|${c.days}|${c.start_min}|${c.end_min}|${c.term_end}`).digest("hex").slice(0, 20);
  return `atlas-class-${h}@canvas-bot`;
}

const HELP_EDIT = 'To change one class: /classes edit DATA 101 TTh 2:00-3:15 Sterling 110';

/**
 * Everything class-related that doesn't need a model. Returns the reply, or null if the message isn't about classes
 * (or is a pending-change reply that should go elsewhere).
 */
export async function handleClassMessage(key: string, text: string, deps: ClassDeps = {}): Promise<string | null> {
  const ctx = requireContext();
  const now = (deps.now ?? (() => new Date()))();
  const tz = ctx.timezone;
  const t = text.trim();

  // 1) a reply to something we staged
  const p = pending.get(key);
  if (p && Date.now() > p.expires) pending.delete(key);
  const live = pending.get(key);
  if (live) {
    if (YES.test(t)) {
      pending.delete(key);
      if (live.kind === "clear") {
        clearClasses(key);
        return "Cleared your class schedule.";
      }
      if (live.kind === "calsync") {
        try {
          return await syncToCalendar(key, live.rows, tz);
        } catch (e) {
          console.error("class calendar sync failed:", e instanceof Error ? e.message : e);
          return "Sorry, I couldn't add them to your calendar. Your schedule is saved either way.";
        }
      }
      const rows = apply(key, live);
      const base = `Saved ${live.specs.length} class${live.specs.length > 1 ? "es" : ""}. Ask "next class" or "classes today" anytime; /classalerts turns on 15-minute heads-ups.`;
      if (ctx.role === "owner" && calendarConfigured()) {
        pending.set(key, { kind: "calsync", rows, expires: Date.now() + TTL_MS });
        return `${base}\nAdd them to your iCloud calendar as weekly repeating events (skipping no-class days)? Reply yes or no.`;
      }
      return base;
    }
    if (NO.test(t)) {
      pending.delete(key);
      return live.kind === "calsync" ? "Okay, I won't touch your calendar." : "Okay, nothing saved.";
    }
    pending.delete(key); // some other message: the staged change is dropped and the message is handled normally below
  }

  // 2) commands
  if (/^\/classalerts\b/i.test(t)) {
    const on = !(getUser(key)?.class_alerts === 1);
    setClassAlerts(key, on);
    const quiet = getUser(key)?.notify === 0 ? " (Notifications are quiet right now, so nothing will send until you turn them back on with /quiet.)" : "";
    return on ? `Class heads-ups on: I'll text you 15 minutes before each class. Send /classalerts again to turn them off.${quiet}` : "Class heads-ups off.";
  }
  const skip = t.match(/^\/(un)?skip\s+(\d{4}-\d{2}-\d{2})\s*$/i);
  if (skip) {
    const [, un, date] = skip;
    if (Number.isNaN(Date.parse(date!))) return "That date doesn't look right. Use YYYY-MM-DD.";
    if (un) {
      // "unskip": hold class on that date even if the calendar says no class, or forget a skip you added
      const rows = listClasses(key);
      const o = listClassOverrides(key).get(date!);
      if (o === true) removeClassOverride(key, date!);
      else if (rows.length && noClassReason(key, date!, termOfClasses(rows)!)) setClassOverride(key, date!, false);
      else return `${date} already has classes.`;
      return `Okay, classes meet on ${date}.`;
    }
    setClassOverride(key, date!, true);
    return `Okay, no class on ${date}.`;
  }

  const classesCmd = t.match(/^\/classes\b\s*([\s\S]*)$/i);
  const myClasses = t.match(/^my classes\b[\s:,-]*(?:are\b[\s:,-]*)?([\s\S]*)$/i);
  const body = (classesCmd ?? myClasses)?.[1]?.trim();
  if (body !== undefined) {
    const rows = listClasses(key);
    const firstWord = body.split(/\s+/)[0]?.toLowerCase() ?? "";
    if (!body || firstWord === "show" || firstWord === "list") {
      if (!rows.length) return noScheduleText();
      const term = termOfClasses(rows)!;
      const alerts = getUser(key)?.class_alerts === 1 ? "on" : "off";
      const skipped = [...listClassOverrides(key)].filter(([, s]) => s).length;
      return `Your classes (${termLine(term)}):\n${rows.map(rowLine).join("\n")}\nHeads-ups: ${alerts} (/classalerts). /skip YYYY-MM-DD marks a no-class day${skipped ? ` (${skipped} skipped by you)` : ""}. ${HELP_EDIT}`;
    }
    if (firstWord === "clear" || firstWord === "delete" && body.split(/\s+/).length === 1) {
      if (!rows.length) return "You have no classes saved.";
      pending.set(key, { kind: "clear", expires: Date.now() + TTL_MS });
      return `Delete all ${rows.length} saved classes? Reply yes or no.`;
    }
    if (firstWord === "remove" || firstWord === "delete") {
      const target = normalizeCourse(body.slice(firstWord.length));
      if (!target) return "Which class? For example: /classes remove DATA 101";
      const n = removeClassesByCourse(key, target);
      return n ? `Removed ${target}.` : `I don't have ${target} saved.`;
    }
    const mode: "set" | "add" | "edit" = firstWord === "add" ? "add" : firstWord === "edit" ? "edit" : "set";
    const content = mode === "set" ? body : body.slice(firstWord.length).trim();
    return stageFromText(key, mode, content, rows, now, tz, deps);
  }

  // 3) zero-token questions
  const q = parseClassQuery(t);
  if (q) return answerClassQuery(key, q, now, tz);
  return null;
}

async function stageFromText(key: string, mode: "set" | "add" | "edit", content: string, existing: ClassRow[], now: Date, tz: string, deps: ClassDeps): Promise<string | null> {
  let parsed = parseClassText(content);
  const looksPasted = content.split("\n").filter((l) => l.trim()).length >= 3 || /\t/.test(content) || (content.match(/\d{1,2}:\d{2}/g) ?? []).length >= 2;
  if (!parsed.classes.length) {
    // nothing readable by rule: a messy paste (e.g. from ConnectCarolina) gets one model call; anything else is just a normal message
    if (!content || !looksPasted) return mode === "set" && !content ? noScheduleText() : content ? (mode === "set" ? null : `I couldn't read that. Try: DATA 101 MWF 9:05-9:55 Sterling 120`) : null;
    if (isOverBudget(ctx())) return `I'm out of AI quota for now, so I can't read a pasted schedule. Send one class per line instead, like: DATA 101 MWF 9:05-9:55 Sterling 120`;
    const viaLlm = (await deps.llmParse?.(content.slice(0, 4000))) ?? null;
    if (!viaLlm?.length) return `I couldn't read that schedule. Send one class per line, like:\nDATA 101 MWF 9:05-9:55 Sterling 120\nECON 210 TTh 11-12:15 Gardner 305`;
    parsed = { classes: viaLlm, unparsed: [], term: parsed.term };
  }
  const term = parsed.term ?? (existing[0] ? { start: existing[0].term_start, end: existing[0].term_end } : null) ?? defaultTerm(ymdOf(now, tz));
  if (!term) {
    return `I don't know your term dates yet (I only have UNC's Fall 2026). Add a line like: term 2027-01-13 to 2027-04-28`;
  }
  pending.set(key, { kind: "save", mode, specs: parsed.classes, term: { start: term.start, end: term.end }, expires: Date.now() + TTL_MS });
  return readback(mode, parsed.classes, { start: term.start, end: term.end }, existing, parsed.unparsed);
}

const ctx = () => requireContext();
