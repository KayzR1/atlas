import { afterEach, beforeEach, expect, test } from "bun:test";
import { setStoreForTests, type CalendarStore, type StoredObject } from "../src/calendar.ts";
import { classBusy, classesBriefLine, classesOn, classMeetsNote, handleClassMessage, nextClass, parseClassLine, parseClassText, parseDays, parseTimeRange, resetClassState } from "../src/classes.ts";
import { runWithContext, type UserContext } from "../src/context.ts";
import { ensureUser, getUser, initDb, listClasses, wipeUser } from "../src/db.ts";
import { runBrief, runClassAlerts, type Deps } from "../src/notify.ts";
import { Database } from "bun:sqlite";

const ME = "+15555550100", FRIEND = "+15555550101";
const ctx = (key: string, role: "owner" | "member"): UserContext => ({ key, role, timezone: "America/New_York", canvasUrl: "https://x.example", canvasToken: "t" });
const as = <T>(key: string, role: "owner" | "member", fn: () => Promise<T>) => runWithContext(ctx(key, role), fn);
// Mon Oct 19 2026, 8:30 AM EDT
const MON = new Date("2026-10-19T12:30:00Z");
const msg = (text: string, key = ME, role: "owner" | "member" = "owner", now = MON, llmParse?: any) => as(key, role, () => handleClassMessage(key, text, { now: () => now, llmParse }));

const SCHEDULE = "my classes\nDATA 101 MWF 9:05-9:55 Sterling 120\nECON 210 TTh 11-12:15 Gardner 305\nENGL 150 W 2:00-3:15";

class FakeStore implements CalendarStore {
  objs = new Map<string, StoredObject>();
  creates = 0;
  async search() { return [...this.objs.values()]; }
  async get() { return null; }
  async put() {}
  async remove() {}
  async create(ics: string, filename: string) {
    this.creates++;
    const url = `https://caldav.example/cal/${filename}`;
    this.objs.set(url, { url, data: ics, calendarUrl: "https://caldav.example/cal/", calendar: "Home" });
    return { url, calendarUrl: "https://caldav.example/cal/" };
  }
}
let store: FakeStore;

beforeEach(() => {
  initDb(":memory:");
  ensureUser(ME);
  ensureUser(FRIEND);
  resetClassState();
  store = new FakeStore();
  setStoreForTests(store);
  delete process.env.ICLOUD_EMAIL;
  delete process.env.ICLOUD_APP_PASSWORD;
});
afterEach(() => setStoreForTests());

async function save(key = ME, role: "owner" | "member" = "owner", text = SCHEDULE) {
  await msg(text, key, role);
  return msg("yes", key, role);
}

// ---- parsing ----

test("day atoms", () => {
  const d = (s: string) => parseDays(s)?.days;
  expect(d("MWF 9")).toEqual([1, 3, 5]);
  expect(d("TTh 9")).toEqual([2, 4]);
  expect(d("TuTh 9")).toEqual([2, 4]);
  expect(d("Tu/Th 9")).toEqual([2, 4]);
  expect(d("M W F 9")).toEqual([1, 3, 5]);
  expect(d("Mon, Wed 9")).toEqual([1, 3]);
  expect(d("Tues Thurs 9")).toEqual([2, 4]);
  expect(d("MTWRF 9")).toEqual([1, 2, 3, 4, 5]);
  expect(d("Sat 9")).toEqual([6]);
  expect(d("Wednesday 9")).toEqual([3]);
  expect(parseDays("Weekly 9")).toBeNull();
});

test("time ranges and meridiem inference", () => {
  const t = (s: string) => { const r = parseTimeRange(s); return r && [r.startMin / 60, r.endMin / 60]; };
  expect(t("9:05-9:55")).toEqual([9 + 5 / 60, 9 + 55 / 60]);
  expect(t("9:05 AM - 9:55 AM")).toEqual([9 + 5 / 60, 9 + 55 / 60]);
  expect(t("11-12:15")).toEqual([11, 12.25]);
  expect(t("12:30-1:45")).toEqual([12.5, 13.75]);
  expect(t("2-3:15pm")).toEqual([14, 15.25]);
  expect(t("2:00-3:15")).toEqual([14, 15.25]);
  expect(t("8-9:15")).toEqual([8, 9.25]);
  expect(t("11:30am-12:45pm")).toEqual([11.5, 12.75]);
  expect(t("13:00-14:15")).toEqual([13, 14.25]);
  expect(t("9 to 9:50")).toEqual([9, 9 + 50 / 60]);
  expect(t("10-9")).toBeNull();
  expect(t("hello")).toBeNull();
});

test("class lines", () => {
  expect(parseClassLine("DATA 101 MWF 9:05-9:55 Sterling 120")).toEqual({ course: "DATA 101", days: [1, 3, 5], startMin: 545, endMin: 595, location: "Sterling 120" });
  expect(parseClassLine("data101.001 TTh 11-12:15 @ Gardner 305")?.location).toBe("Gardner 305");
  expect(parseClassLine("ECON 210 Intro Economics TTh 11-12:15")?.course).toBe("ECON 210");
  expect(parseClassLine("1. ENGL 150 W 2:00-3:15")?.days).toEqual([3]);
  expect(parseClassLine("lunch at noon")).toBeNull();
  expect(parseClassLine("DATA 101 something")).toBeNull();
});

test("parseClassText: header, term line, semicolons, unreadable lines", () => {
  const r = parseClassText("Fall 2026\nDATA 101 MWF 9-9:50\nnonsense line\nterm 2027-01-13 to 2027-04-28");
  expect(r.classes.length).toBe(1);
  expect(r.unparsed).toEqual(["nonsense line"]);
  expect(r.term).toEqual({ start: "2027-01-13", end: "2027-04-28" });
  expect(parseClassText("DATA 101 MWF 9-9:50; ECON 210 TTh 11-12:15").classes.length).toBe(2);
});

// ---- the save flow ----

test("my classes reads back, nothing saved until yes", async () => {
  const r = await msg(SCHEDULE);
  expect(r).toContain("I read 3 classes");
  expect(r).toContain("1) DATA 101  Mon/Wed/Fri 9:05–9:55 AM  Sterling 120");
  expect(r).toContain("2) ECON 210  Tue/Thu 11:00 AM–12:15 PM  Gardner 305");
  expect(r).toContain("Fall 2026");
  expect(r).toContain("Reply yes or no");
  expect(listClasses(ME)).toHaveLength(0);
  expect(await msg("yes")).toMatch(/^Saved 3 classes/);
  expect(listClasses(ME)).toHaveLength(3);
});

test("no and unrelated messages drop the staged schedule", async () => {
  await msg(SCHEDULE);
  expect(await msg("no")).toBe("Okay, nothing saved.");
  expect(listClasses(ME)).toHaveLength(0);
  await msg(SCHEDULE);
  expect(await msg("what's due")).toBeNull();
  expect(await msg("yes")).toBeNull();
  expect(listClasses(ME)).toHaveLength(0);
});

test("staged change expires", async () => {
  await msg(SCHEDULE);
  const real = Date.now;
  Date.now = () => real() + 16 * 60_000;
  try {
    expect(await msg("yes")).toBeNull();
  } finally {
    Date.now = real;
  }
  expect(listClasses(ME)).toHaveLength(0);
});

test("replacing, add, edit, remove, clear", async () => {
  await save();
  expect(await msg("/classes add MATH 110 F 1:00-1:50 Phillips 100")).toContain("Adding 1 class");
  await msg("yes");
  expect(listClasses(ME)).toHaveLength(4);
  const edit = await msg("/classes edit DATA 101 TTh 2:00-3:15 Sterling 110");
  expect(edit).toContain("DATA 101: Mon/Wed/Fri 9:05–9:55 AM Sterling 120 → Tue/Thu 2:00–3:15 PM Sterling 110");
  await msg("yes");
  expect(listClasses(ME).find((c) => c.course === "DATA 101")?.days).toBe("24");
  expect(listClasses(ME)).toHaveLength(4);
  expect(await msg("/classes remove MATH 110")).toBe("Removed MATH 110.");
  expect(await msg("/classes remove MATH 110")).toBe("I don't have MATH 110 saved.");
  expect(await msg("/classes clear")).toContain("Delete all 3");
  expect(listClasses(ME)).toHaveLength(3);
  expect(await msg("yes")).toBe("Cleared your class schedule.");
  expect(listClasses(ME)).toHaveLength(0);
  const show = await msg("/classes");
  expect(show).toContain("don't have your classes yet");
});

test("/classes show lists them", async () => {
  await save();
  const r = await msg("/classes show");
  expect(r).toContain("DATA 101  Mon/Wed/Fri 9:05–9:55 AM  Sterling 120");
  expect(r).toContain("Heads-ups: off");
});

test("unreadable input is not swallowed as a schedule; a paste goes to the fallback parser", async () => {
  expect(await msg("my classes are hard this semester")).toBeNull();
  expect(await msg("/classes add nonsense")).toContain("couldn't read");
  let calls = 0;
  const llm = async () => (calls++, [{ course: "DATA 101", days: [1, 3], startMin: 545, endMin: 595, location: "" }]);
  const paste = "my classes\nDATA 101 - Intro\nSection 001 Lecture\nM W 9:05AM to 9:55AM  Sterling\nSpring\nstuff";
  const r = await msg(paste, ME, "owner", MON, llm);
  expect(calls).toBe(1);
  expect(r).toContain("I read 1 class");
  // a one-line failure never calls the model
  await msg("my classes foo bar", ME, "owner", MON, llm);
  expect(calls).toBe(1);
});

test("a date outside every known term asks for a term line instead of staging", async () => {
  const r = await msg(SCHEDULE, ME, "owner", new Date("2027-02-01T15:00:00Z"));
  expect(r).toContain("term 2027-01-13 to 2027-04-28");
  const ok = await msg(`${SCHEDULE}\nterm 2027-01-13 to 2027-04-28`, ME, "owner", new Date("2027-02-01T15:00:00Z"));
  expect(ok).toContain("2027-01-13 to 2027-04-28");
});

// ---- holidays and overrides ----

test("no classes on university no-class days; /skip and /unskip override", async () => {
  await save();
  expect(classesOn(ME, "2026-10-19").map((c) => c.course)).toEqual(["DATA 101"]);
  expect(classesOn(ME, "2026-09-07")).toEqual([]); // Labor Day (Monday)
  expect(classesOn(ME, "2026-11-25")).toEqual([]); // Thanksgiving recess
  expect(classesOn(ME, "2026-08-14")).toEqual([]); // before the term
  expect(classesOn(ME, "2026-12-07")).toEqual([]); // after the term
  expect(await msg("/skip 2026-10-19")).toBe("Okay, no class on 2026-10-19.");
  expect(classesOn(ME, "2026-10-19")).toEqual([]);
  expect(await msg("/unskip 2026-10-19")).toBe("Okay, classes meet on 2026-10-19.");
  expect(classesOn(ME, "2026-10-19")).toHaveLength(1);
  expect(await msg("/unskip 2026-09-07")).toContain("classes meet");
  expect(classesOn(ME, "2026-09-07")).toHaveLength(1);
  expect(await msg("/unskip 2026-10-19")).toBe("2026-10-19 already has classes.");
  expect(await msg("/skip 2026-13-45")).toContain("doesn't look right");
});

// ---- zero-token questions ----

test("next class, today, tomorrow, where", async () => {
  await save();
  expect(await msg("next class?")).toBe("Next class: DATA 101 today at 9:05 AM (Sterling 120).");
  expect(await msg("what's my next class")).toContain("DATA 101");
  expect(await msg("classes today")).toContain("9:05–9:55 AM  DATA 101 (Sterling 120)");
  expect(await msg("what classes do I have tomorrow?")).toContain("11:00 AM–12:15 PM  ECON 210 (Gardner 305)");
  expect(await msg("where is econ 210")).toBe("ECON 210 meets Tue/Thu 11:00 AM–12:15 PM in Gardner 305.");
  expect(await msg("where is ENGL 150")).toContain("(I don't have a room saved)");
  expect(await msg("where is math 110")).toContain("I don't have MATH 110");
  expect(await msg("where is the library")).toBeNull();
  const during = new Date("2026-10-19T13:30:00Z"); // 9:30
  expect(await msg("next class", ME, "owner", during)).toContain("In class now: DATA 101 until 9:55 AM");
  const late = new Date("2026-10-19T22:00:00Z"); // 6pm Monday -> Tuesday ECON
  expect(await msg("next class", ME, "owner", late)).toBe("Next class: ECON 210 tomorrow at 11:00 AM (Gardner 305).");
  const fri = new Date("2026-10-16T14:00:00Z"); // fall break
  expect(await msg("classes today", ME, "owner", fri)).toBe("No classes today (fall break).");
});

test("no schedule yet gives instructions", async () => {
  expect(await msg("next class")).toContain("Text \"my classes\"");
});

// ---- members have schedules too, isolated from each other ----

test("members can save and query; schedules are isolated; no calendar offer", async () => {
  await save(FRIEND, "member", "my classes\nMATH 110 TTh 8:00-9:15 Phillips 100");
  expect(listClasses(FRIEND)).toHaveLength(1);
  expect(listClasses(ME)).toHaveLength(0);
  expect(await msg("next class", FRIEND, "member")).toContain("MATH 110");
  expect(await msg("next class", ME)).toContain("don't have your classes");
  process.env.ICLOUD_EMAIL = "x@example.com";
  process.env.ICLOUD_APP_PASSWORD = "p";
  await msg("my classes\nMATH 110 TTh 8:00-9:15", FRIEND, "member");
  expect(await msg("yes", FRIEND, "member")).not.toContain("calendar");
  expect(store.creates).toBe(0);
});

test("wipeUser removes classes, overrides and the alerts flag", async () => {
  await save();
  await msg("/skip 2026-10-20");
  await msg("/classalerts");
  wipeUser(ME, "removed");
  expect(listClasses(ME)).toHaveLength(0);
  expect(getUser(ME)?.class_alerts).toBe(0);
  expect(classesOn(ME, "2026-10-19")).toEqual([]);
});

test("an old database without class tables migrates", () => {
  const raw = new Database(":memory:");
  raw.run("CREATE TABLE users (phone TEXT PRIMARY KEY, created_at INTEGER)");
  expect(() => initDb(":memory:")).not.toThrow();
  expect(listClasses(ME)).toEqual([]);
});

// ---- brief, alerts, nudges, planner ----

const emptyDeps = (now: Date): Deps => ({
  now: () => now,
  courses: async () => [{ id: 1, name: "Econ", code: "ECON210.001.FA26", current_score: null, current_grade: null }],
  assignments: async () => [],
  announcements: async () => [],
  missing: async () => [],
  events: async () => null,
  summarize: async (t) => t,
});

test("morning brief starts with today's classes", async () => {
  await save();
  const sent: string[] = [];
  const r = await as(ME, "owner", () => runBrief(ME, emptyDeps(MON), async (_k, t) => (sent.push(t), true)));
  expect(r).toBe("sent");
  const lines = sent[0]!.split("\n");
  expect(lines[1]).toBe("Classes: 9:05–9:55 AM DATA 101 (Sterling 120)");
  const tue = new Date("2026-10-20T12:30:00Z");
  sent.length = 0;
  await as(ME, "owner", () => runBrief(ME, emptyDeps(tue), async (_k, t) => (sent.push(t), true)));
  expect(sent[0]).toContain("Classes: 11:00 AM–12:15 PM ECON 210 (Gardner 305)");
  const brk = new Date("2026-10-16T12:30:00Z");
  expect(classesBriefLine(ME, brk, "America/New_York")).toBe("Classes: none today (fall break).");
});

test("members get the class line in their brief too", async () => {
  await save(FRIEND, "member", "my classes\nMATH 110 MWF 10:10-11:00 Phillips 100");
  const sent: string[] = [];
  await as(FRIEND, "member", () => runBrief(FRIEND, emptyDeps(MON), async (_k, t) => (sent.push(t), true)));
  expect(sent[0]).toContain("Classes: 10:10–11:00 AM MATH 110 (Phillips 100)");
});

test("heads-ups: off by default, 15 minutes before, once, respects quiet, retried when dropped", async () => {
  await save();
  const sent: string[] = [];
  let ok = true;
  const send = async (_k: string, t: string) => (ok ? (sent.push(t), true) : false);
  const at = (hhmm: string) => emptyDeps(new Date(`2026-10-19T${hhmm}:00Z`));
  const run = (hhmm: string) => as(ME, "owner", () => runClassAlerts(ME, at(hhmm), send));
  expect(await run("12:55")).toBe(0); // 8:55 but alerts are off
  expect(await msg("/classalerts")).toContain("on");
  expect(await run("12:30")).toBe(0); // 35 min before
  ok = false;
  expect(await run("12:55")).toBe(0); // breaker drop: not marked
  ok = true;
  expect(await run("12:56")).toBe(1);
  expect(sent[0]).toBe("Heads-up: DATA 101 starts in 9 min (9:05 AM) (Sterling 120).");
  expect(await run("12:57")).toBe(0); // once only
  expect(await run("13:06")).toBe(0); // already started
  // quiet
  const { setUserFlag } = await import("../src/db.ts");
  setUserFlag(ME, "notify", false);
  expect(await run("12:56")).toBe(0);
  expect(await msg("/classalerts")).toContain("off");
});

test("deadline nudges say when the class meets that day", async () => {
  await save();
  const due = new Date("2026-10-20T20:00:00Z"); // Tue 4pm
  expect(classMeetsNote(ME, "ECON 210", due, "America/New_York")).toBe(" (ECON 210 meets 11:00 AM–12:15 PM that day)");
  expect(classMeetsNote(ME, "DATA 101", due, "America/New_York")).toBe("");
});

test("class meetings are busy time for the study planner", async () => {
  await save();
  const busy = classBusy(ME, new Date("2026-10-19T00:00:00Z"), new Date("2026-10-21T00:00:00Z"), "America/New_York");
  expect(busy.map((b) => b.start.toISOString())).toEqual([
    "2026-10-19T13:05:00.000Z", // Mon DATA 9:05
    "2026-10-20T15:00:00.000Z", // Tue ECON 11:00
  ]);
  expect(busy[0]!.end.toISOString()).toBe("2026-10-19T13:55:00.000Z");
  expect(nextClass(ME, MON, "America/New_York")?.cls.course).toBe("DATA 101");
});

// ---- owner-only iCloud sync ----

test("owner can add weekly events to iCloud after saving; none duplicated; holidays excluded", async () => {
  process.env.ICLOUD_EMAIL = "x@example.com";
  process.env.ICLOUD_APP_PASSWORD = "p";
  await msg(SCHEDULE);
  const r = await msg("yes");
  expect(r).toContain("Add them to your iCloud calendar");
  expect(store.creates).toBe(0);
  expect(await msg("yes")).toBe("Added 3 weekly events to your calendar: DATA 101, ECON 210, ENGL 150.");
  expect(store.creates).toBe(3);
  const ics = [...store.objs.values()].find((o) => o.data.includes("SUMMARY:DATA 101"))!.data;
  expect(ics).toContain("RRULE:FREQ=WEEKLY;BYDAY=MO,WE,FR;UNTIL=20261203T040000Z");
  expect(ics).toContain("DTSTART;TZID=America/New_York:20260817T090500");
  expect(ics).toContain("EXDATE;TZID=America/New_York:20260907T090500"); // Labor Day
  expect(ics).toContain("EXDATE;TZID=America/New_York:20261125T090500");
  expect(ics).toContain("TZID:America/New_York");
  expect(ics).toContain("LOCATION:Sterling 120");
  // saving the same schedule again and syncing adds nothing
  await msg(SCHEDULE);
  await msg("yes");
  expect(await msg("yes")).toBe("Nothing new to add. Already there: DATA 101, ECON 210, ENGL 150.");
  expect(store.creates).toBe(3);
  // declining leaves the calendar alone
  await msg("my classes\nMATH 110 F 1:00-1:50");
  await msg("yes");
  expect(await msg("no")).toBe("Okay, I won't touch your calendar.");
  expect(store.creates).toBe(3);
});

test("a lookalike repeating event already in the calendar is not duplicated", async () => {
  process.env.ICLOUD_EMAIL = "x@example.com";
  process.env.ICLOUD_APP_PASSWORD = "p";
  store.objs.set("u", { url: "u", data: "BEGIN:VEVENT\r\nSUMMARY:ECON 210\r\nRRULE:FREQ=WEEKLY\r\nEND:VEVENT", calendarUrl: "c", calendar: "Home" });
  await msg("my classes\nECON 210 TTh 11-12:15");
  await msg("yes");
  expect(await msg("yes")).toBe("Nothing new to add. Already there: ECON 210.");
  expect(store.creates).toBe(0);
});
