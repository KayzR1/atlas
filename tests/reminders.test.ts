import { afterEach, beforeEach, expect, test } from "bun:test";
import { executeTool, toolsForRole } from "../src/agent.ts";
import { expand, handleConfirmation, runCalendarTool, setNowForTests, setStoreForTests, type CalendarStore, type StoredObject } from "../src/calendar.ts";
import { runWithContext, type UserContext } from "../src/context.ts";
import { initDb, loadLastEvent } from "../src/db.ts";

const KEY = "+19195550100";
const CAL = "https://caldav.example/cal/home/";
const NOW = new Date("2026-10-16T14:00:00Z"); // Fri Oct 16, 10:00 AM EDT

class FakeStore implements CalendarStore {
  objs = new Map<string, StoredObject>();
  mutations = 0;
  private n = 0;
  add(name: string, data: string) {
    const o = { url: `${CAL}${name}.ics`, etag: `e${++this.n}`, data, calendarUrl: CAL, calendar: "Home" };
    this.objs.set(o.url, o);
    return o;
  }
  async search() { return [...this.objs.values()]; }
  async get(_c: string, url: string) { const o = this.objs.get(url); return o ? { ...o } : null; }
  async put(obj: StoredObject, ics: string) { this.mutations++; this.objs.set(obj.url, { ...obj, data: ics }); }
  async remove(obj: StoredObject) { this.mutations++; this.objs.delete(obj.url); }
  async create(ics: string, filename: string) { this.mutations++; const o = this.add(filename.replace(/\.ics$/, ""), ics); return { url: o.url, calendarUrl: CAL }; }
}

const one = (uid: string, summary: string, start: string, end: string) =>
  ["BEGIN:VCALENDAR", "VERSION:2.0", "PRODID:-//t//EN", "BEGIN:VEVENT", `UID:${uid}`, "DTSTAMP:20261001T000000Z", `DTSTART:${start}`, `DTEND:${end}`, `SUMMARY:${summary}`, "END:VEVENT", "END:VCALENDAR"].join("\r\n");
const owner: UserContext = { key: KEY, role: "owner", timezone: "America/New_York", canvasUrl: "https://x", canvasToken: "t" };

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

test("'remind me to submit ECON hw Wednesday 8pm' stages a reminder behind the same yes/no as calendar events", async () => {
  const staged = await tool("create_reminder", { text: "submit ECON hw", when: "2026-10-21T20:00" });
  expect(question(staged)).toBe("Remind you to submit ECON hw Wed 8pm?");
  expect(store.mutations).toBe(0);
  expect(store.objs.size).toBe(0);
  expect(await handleConfirmation(KEY, "yes")).toBe("Okay, I'll remind you to submit ECON hw Wed 8pm (calendar alert).");
  expect(store.objs.size).toBe(1);
});

test("the reminder is a calendar event 'Reminder: …' at that time with a display alarm", async () => {
  await tool("create_reminder", { text: "submit ECON hw", when: "2026-10-21T20:00" });
  await handleConfirmation(KEY, "yes");
  const obj = [...store.objs.values()][0]!;
  expect(obj.data).toContain("SUMMARY:Reminder: submit ECON hw");
  expect(obj.data).toMatch(/BEGIN:VALARM\r\nACTION:DISPLAY\r\nDESCRIPTION:Reminder: submit ECON hw\r\nTRIGGER:PT0S\r\nEND:VALARM/);
  const [ev] = expand(obj.data, new Date("2026-10-20"), new Date("2026-10-23"), "");
  expect(ev!.start.toISOString()).toBe("2026-10-22T00:00:00.000Z"); // Wed 8:00 PM EDT
  expect(ev!.end.getTime() - ev!.start.getTime()).toBe(15 * 60_000);
  expect(ev!.title).toBe("Reminder: submit ECON hw");
});

test("a 'no' or any other reply creates nothing", async () => {
  await tool("create_reminder", { text: "call mom", when: "2026-10-17T18:00" });
  expect(await handleConfirmation(KEY, "no")).toBe("Okay, I didn't change anything.");
  await tool("create_reminder", { text: "call mom", when: "2026-10-17T18:00" });
  expect(await handleConfirmation(KEY, "what's due?")).toBeNull();
  expect(await handleConfirmation(KEY, "yes")).toBeNull();
  expect(store.mutations).toBe(0);
});

test("the wording is cleaned up and a time in the past is refused", async () => {
  for (const text of ["to submit ECON hw", "remind me to submit ECON hw", "Reminder: submit ECON hw", "  submit ECON hw  "]) {
    expect(question(await tool("create_reminder", { text, when: "2026-10-21T20:00" }))).toBe("Remind you to submit ECON hw Wed 8pm?");
  }
  expect(await tool("create_reminder", { text: "x", when: "2026-10-15T20:00" })).toMatch(/already passed/);
  expect(await tool("create_reminder", { text: "x", when: "2026-10-16T09:00" })).toMatch(/already passed/); // earlier today
  expect(await tool("create_reminder", { when: "2026-10-21T20:00" })).toMatch(/text and when are required/);
});

test("'cancel that reminder' uses the last-event memory and still asks first", async () => {
  await tool("create_reminder", { text: "submit ECON hw", when: "2026-10-21T20:00" });
  await handleConfirmation(KEY, "yes");
  expect(loadLastEvent<any>(KEY).title).toBe("Reminder: submit ECON hw");
  const base = store.mutations;
  expect(question(await tool("delete_calendar_event", { id: "last" }))).toBe("Delete 'Reminder: submit ECON hw' Wed 8–8:15pm?");
  expect(store.mutations).toBe(base);
  expect(await handleConfirmation(KEY, "yes")).toMatch(/^Deleted 'Reminder: submit ECON hw'/);
  expect(store.objs.size).toBe(0);
});

test("'my reminders' lists only reminders, up to 60 days out (a plain search stops at 14)", async () => {
  store.add("piano", one("g@t", "Piano", "20261017T200000Z", "20261017T210000Z"));
  store.add("r1", one("r1@t", "Reminder: submit ECON hw", "20261022T000000Z", "20261022T001500Z"));
  store.add("r2", one("r2@t", "Reminder: renew parking permit", "20261120T150000Z", "20261120T151500Z")); // 35 days out
  store.add("r3", one("r3@t", "Reminder: too far away", "20270301T150000Z", "20270301T151500Z"));
  store.add("note", one("n@t", "Lunch (just a reminder to bring snacks)", "20261018T160000Z", "20261018T170000Z")); // not one of ours
  const out = await tool("find_calendar_events", { query: "reminders" });
  expect(out).toMatch(/^2 matches:/);
  expect(out).toContain("Reminder: submit ECON hw");
  expect(out).toContain("Reminder: renew parking permit");
  expect(out).not.toContain("too far away");
  expect(out).not.toContain("Lunch");
  expect(out).toContain("Which one?\n1) Wed 8–8:15pm Reminder: submit ECON hw");
  // a normal 14-day search for the same word would have missed the far one
  expect(await tool("find_calendar_events", { query: "parking" })).toMatch(/No matching events/);
  // with a single reminder it is remembered as "last", so "cancel it" works
  store.objs.delete(`${CAL}r1.ics`);
  expect(await tool("find_calendar_events", { query: "reminder" })).toMatch(/^1 match, now remembered as "last"/);
});

test("reminders are owner-only", async () => {
  expect(toolsForRole("owner").map((t) => t.function.name)).toContain("create_reminder");
  expect(toolsForRole("member").map((t) => t.function.name)).not.toContain("create_reminder");
  const member: UserContext = { ...owner, role: "member", key: "+19195550101" };
  expect(await runWithContext(member, () => executeTool("create_reminder", { text: "x", when: "2026-10-21T20:00" }, member.key))).toMatch(/unknown tool/);
  expect(store.mutations).toBe(0);
});
