import { afterEach, beforeEach, expect, spyOn, test } from "bun:test";
import { executeTool, setLlmForTests, toolsForRole } from "../src/agent.ts";
import { wallToUtc } from "../src/assignments.ts";
import { handleConfirmation, parsePlanReply, setNowForTests, setStoreForTests, type CalendarStore, type StoredObject } from "../src/calendar.ts";
import { runWithContext, type UserContext } from "../src/context.ts";
import { initDb, loadLastEvent } from "../src/db.ts";
import { formatPlan, freeGaps, parsePlanQuery, placeBlocks, planWeek, type Busy, type Task } from "../src/planner.ts";
import { ALICE, harness, OWNER } from "./helpers.ts";

const TZ = "America/New_York";
const at = (d: string, h: number, m = 0) => {
  const [y, mo, da] = d.split("-").map(Number) as [number, number, number];
  return wallToUtc(y, mo, da, h, m, TZ);
};
const busy = (d: string, h1: number, m1: number, h2: number, m2: number): Busy => ({ start: at(d, h1, m1), end: at(d, h2, m2) });
const hm = (d: Date) => d.toLocaleTimeString("en-US", { timeZone: TZ, hour: "numeric", minute: "2-digit", hour12: false });
const span = (g: { start: Date; end: Date }) => `${hm(g.start)}-${hm(g.end)}`;
const NOW = at("2026-10-19", 8, 0); // Monday 8:00 AM EDT

// ---------- gap finding ----------

test("free gaps: 9am-10pm minus events, at least an hour, back-to-back and overlapping events merge", () => {
  const day = "2026-10-20";
  const gaps = freeGaps(
    [busy(day, 10, 0, 11, 0), busy(day, 13, 0, 14, 30), busy(day, 14, 0, 15, 0), busy(day, 15, 0, 15, 20), busy(day, 17, 0, 17, 40)],
    at(day, 9), at(day, 22), NOW,
  );
  expect(gaps.map(span)).toEqual(["09:00-10:00", "11:00-13:00", "15:30-17:00", "17:45-22:00"]); // 9-10 is exactly an hour and counts; 17:40->17:45 rounds to a quarter
});

test("free gaps: short gaps are dropped, events are clipped to the window, and an empty day is one big gap", () => {
  const day = "2026-10-20";
  expect(freeGaps([busy(day, 9, 30, 10, 30), busy(day, 11, 0, 12, 0)], at(day, 9), at(day, 22), NOW).map(span)).toEqual(["12:00-22:00"]); // 9-9:30 and 10:30-11 are too short
  expect(freeGaps([busy(day, 7, 0, 10, 0), busy(day, 21, 0, 23, 30)], at(day, 9), at(day, 22), NOW).map(span)).toEqual(["10:00-21:00"]);
  expect(freeGaps([], at(day, 9), at(day, 22), NOW).map(span)).toEqual(["09:00-22:00"]);
  expect(freeGaps([busy(day, 9, 0, 22, 0)], at(day, 9), at(day, 22), NOW)).toEqual([]);
});

test("free gaps never start in the past and round up to a quarter hour", () => {
  const day = "2026-10-19";
  expect(freeGaps([], at(day, 9), at(day, 22), at(day, 11, 20)).map(span)).toEqual(["11:30-22:00"]);
  expect(freeGaps([], at(day, 9), at(day, 22), at(day, 7, 0)).map(span)).toEqual(["09:00-22:00"]);
  expect(freeGaps([], at(day, 9), at(day, 22), at(day, 21, 30))).toEqual([]);
});

test("planning starts 30 minutes from now (11:20 -> 11:50 -> 12:00), not right now", () => {
  const b = placeBlocks([task("HW", at("2026-10-20", 15, 0))], [], at("2026-10-19", 11, 20), TZ).blocks[0]!;
  expect(b.start.toLocaleDateString("en-US", { timeZone: TZ, weekday: "short" })).toBe("Mon"); // due tomorrow afternoon: today is the only day before
  expect(span(b)).toBe("12:00-14:00");
});

// ---------- placing blocks ----------

const task = (name: string, due: Date): Task => ({ name, course: "ECON 210", due });

test("a block goes on the day before the deadline, in the first free gap, 2 hours long", () => {
  const { blocks, unplaced } = placeBlocks([task("HW", at("2026-10-23", 15, 0))], [], NOW, TZ); // due Fri 3pm
  expect(unplaced).toEqual([]);
  expect(blocks.map((b) => `${b.start.toLocaleDateString("en-US", { timeZone: TZ, weekday: "short" })} ${span(b)}`)).toEqual(["Thu 09:00-11:00"]);
});

test("busy days are skipped (working backwards), and the block never runs past the deadline", () => {
  const thuBusy = busy("2026-10-22", 9, 0, 22, 0);
  const wedBusy = busy("2026-10-21", 9, 0, 22, 0);
  const a = placeBlocks([task("HW", at("2026-10-23", 15, 0))], [thuBusy, wedBusy], NOW, TZ).blocks[0]!;
  expect(a.start.toLocaleDateString("en-US", { timeZone: TZ, weekday: "short" })).toBe("Tue"); // Thu and Wed are full
  // due today at 11:00: only the hour between 9 and 10:45 is usable, and it must end 15 minutes before
  const now = at("2026-10-19", 8, 0);
  const b = placeBlocks([task("Early", at("2026-10-19", 11, 0))], [], now, TZ).blocks[0]!;
  expect(span(b)).toBe("09:00-10:45");
  expect(b.end.getTime()).toBeLessThanOrEqual(at("2026-10-19", 11, 0).getTime() - 15 * 60_000);
});

test("a 90-minute gap gives a 90-minute block; under an hour is not used", () => {
  const day = "2026-10-22";
  const only = [busy(day, 9, 0, 12, 0), busy(day, 13, 30, 22, 0)]; // gap 12:00-13:30
  const b = placeBlocks([task("HW", at("2026-10-23", 15, 0))], only, NOW, TZ).blocks[0]!;
  expect(span(b)).toBe("12:00-13:30");
  const tight = [busy(day, 9, 0, 12, 0), busy(day, 12, 45, 22, 0)]; // only 45 minutes free on Thursday
  const c = placeBlocks([task("HW", at("2026-10-23", 15, 0))], tight, NOW, TZ).blocks[0]!;
  expect(c.start.toLocaleDateString("en-US", { timeZone: TZ, weekday: "short" })).toBe("Wed");
});

test("several assignments: nearest deadline first, no overlaps with events or each other, and anything that can't fit is reported", () => {
  const tasks = [task("C", at("2026-10-22", 9, 30)), task("A", at("2026-10-20", 17, 0)), task("B", at("2026-10-21", 12, 0))];
  const events = [busy("2026-10-20", 9, 0, 11, 0)];
  const { blocks, unplaced } = placeBlocks(tasks, events, NOW, TZ);
  expect(blocks.map((b) => b.name)).toEqual(["A", "B", "C"]);
  for (const b of blocks) {
    expect(b.end.getTime()).toBeLessThanOrEqual(b.due.getTime() - 15 * 60_000);
    expect(b.end.getTime() - b.start.getTime()).toBeLessThanOrEqual(2 * 3600_000);
    expect(events.some((e) => b.start < e.end && b.end > e.start)).toBe(false);
  }
  for (const [i, x] of blocks.entries()) for (const y of blocks.slice(i + 1)) expect(x.start < y.end && x.end > y.start).toBe(false);
  expect(unplaced).toEqual([]);
  // due at 9:30 today with the morning blocked: nowhere to study
  const none = placeBlocks([task("Impossible", at("2026-10-19", 9, 30))], [], at("2026-10-19", 8, 0), TZ);
  expect(none.blocks).toEqual([]);
  expect(none.unplaced.map((t) => t.name)).toEqual(["Impossible"]);
});

test("at most 8 blocks are proposed; the rest are listed as unscheduled", () => {
  const tasks = Array.from({ length: 10 }, (_, i) => task(`T${i}`, at("2026-10-24", 12, 0) ));
  const { blocks, unplaced } = placeBlocks(tasks, [], NOW, TZ);
  expect(blocks.length).toBe(8);
  expect(unplaced.length).toBe(2);
});

test("the plan text: numbered in time order, with deadlines, unplaced items and how to reply", () => {
  const blocks = [
    { ...task("Quiz 5", at("2026-10-22", 16, 0)), course: "DATA 101", start: at("2026-10-21", 14, 0), end: at("2026-10-21", 16, 0) },
    { ...task("Group  Assignment #6", at("2026-10-23", 15, 0)), start: at("2026-10-20", 10, 0), end: at("2026-10-20", 12, 0) },
  ];
  const { text, planBlocks } = formatPlan(blocks, [task("Reflection", at("2026-10-19", 9, 0))]);
  expect(text).toBe(
    [
      "Study plan for the next 7 days:",
      "1) Tue 10am–12pm Study: Group Assignment #6 (due Fri 3pm)",
      "2) Wed 2–4pm Study: Quiz 5 (due Thu 4pm)",
      "No free hour before the deadline: ECON 210 Reflection.",
      'Reply "all", "1,3" or "none". I add nothing until you do.',
    ].join("\n"),
  );
  expect(planBlocks.map((b) => b.title)).toEqual(["Study: Group Assignment #6", "Study: Quiz 5"]); // same order as the numbers
});

// ---------- the reply ----------

test("replies: all, none, numbers, lists and ranges; anything else isn't an answer", () => {
  expect(parsePlanReply("all", 4)).toBe("all");
  expect(parsePlanReply("Yes", 4)).toBe("all");
  expect(parsePlanReply("none", 4)).toBe("none");
  expect(parsePlanReply("no thanks", 4)).toBeNull();
  expect(parsePlanReply("1,3", 4)).toEqual([1, 3]);
  expect(parsePlanReply("1, 3", 4)).toEqual([1, 3]);
  expect(parsePlanReply("1 and 3", 4)).toEqual([1, 3]);
  expect(parsePlanReply("#2 #4", 4)).toEqual([2, 4]);
  expect(parsePlanReply("2-4", 4)).toEqual([2, 3, 4]);
  expect(parsePlanReply("3,3,1", 4)).toEqual([1, 3]);
  expect(parsePlanReply("5", 4)).toBeNull(); // out of range
  expect(parsePlanReply("0", 4)).toBeNull();
  expect(parsePlanReply("what's due", 4)).toBeNull();
  expect(parsePlanReply("", 4)).toBeNull();
});

test("only plain 'plan my week' requests take the no-LLM path", () => {
  for (const q of ["plan my week", "Plan my week!", "plan the week please", "plan my study week", "make me a study plan", "study plan", "schedule my study time"]) expect(parsePlanQuery(q), q).toBe(true);
  for (const q of ["plan my week around the piano", "plan my trip", "what's my week look like", "plan", "can you plan my week and add a reminder"]) expect(parsePlanQuery(q), q).toBe(false);
});

// ---------- end to end (mocked calendar and Canvas) ----------

const CAL = "https://caldav.example/cal/home/";
class FakeStore implements CalendarStore {
  objs = new Map<string, StoredObject>();
  mutations = 0;
  add(name: string, data: string) {
    const o = { url: `${CAL}${name}.ics`, etag: "e", data, calendarUrl: CAL, calendar: "Home" };
    this.objs.set(o.url, o);
    return o;
  }
  async search() { return [...this.objs.values()]; }
  async get(_c: string, url: string) { return this.objs.get(url) ?? null; }
  async put(obj: StoredObject, ics: string) { this.mutations++; this.objs.set(obj.url, { ...obj, data: ics }); }
  async remove(obj: StoredObject) { this.mutations++; this.objs.delete(obj.url); }
  async create(ics: string, filename: string) { this.mutations++; const o = this.add(filename.replace(/\.ics$/, ""), ics); return { url: o.url, calendarUrl: CAL }; }
}
const event = (uid: string, title: string, start: string, end: string) =>
  ["BEGIN:VCALENDAR", "VERSION:2.0", "PRODID:-//t//EN", "BEGIN:VEVENT", `UID:${uid}`, "DTSTAMP:20261001T000000Z", `DTSTART:${start}`, `DTEND:${end}`, `SUMMARY:${title}`, "END:VEVENT", "END:VCALENDAR"].join("\r\n");

const realFetch = globalThis.fetch;
let store: FakeStore;
const owner: UserContext = { key: OWNER, role: "owner", timezone: TZ, canvasUrl: "https://canvas.example", canvasToken: "t" };

function mockCanvas() {
  const sub = { score: null, workflow_state: "unsubmitted", submitted_at: null, missing: false, excused: false };
  const asg = (id: number, name: string, due: Date, o: any = {}) => ({ id, name, due_at: due.toISOString(), points_possible: 10, submission_types: ["online_upload"], submission: sub, ...o });
  const lists: Record<number, any[]> = {
    1: [asg(10, "Quiz 5", at("2026-10-22", 16, 0)), asg(11, "Already in", at("2026-10-21", 12, 0), { submission: { ...sub, submitted_at: "2026-10-19T00:00:00Z", workflow_state: "submitted" } })],
    2: [asg(20, "Group Assignment #6", at("2026-10-23", 15, 0)), asg(21, "Next month", at("2026-11-20", 15, 0))],
  };
  globalThis.fetch = (async (url: any) => {
    const u = String(url);
    const json = (o: unknown) => new Response(JSON.stringify(o), { status: 200, headers: { "content-type": "application/json" } });
    if (!u.startsWith("https://canvas.example/")) throw new Error(`unexpected network call: ${u}`);
    const m = u.match(/\/courses\/(\d+)\/assignments/);
    if (m) return json(lists[+m[1]!] ?? []);
    if (u.includes("/courses?")) return json([{ id: 1, name: "Stats", course_code: "DATA101.001.FA26", enrollments: [] }, { id: 2, name: "Econ", course_code: "ECON210.002.FA26", enrollments: [] }]);
    return new Response("nope", { status: 404 });
  }) as any;
}

beforeEach(() => {
  initDb(":memory:");
  store = new FakeStore();
  setStoreForTests(store);
  setNowForTests(() => NOW);
  mockCanvas();
});
afterEach(() => {
  globalThis.fetch = realFetch;
  setStoreForTests();
  setNowForTests();
  setLlmForTests();
});

const plan = () => runWithContext(owner, () => planWeek(OWNER, NOW));
const titles = () => [...store.objs.values()].map((o) => o.data.match(/SUMMARY:(.*)/)![1]!.trim()).sort();

test("plan my week: due work + your calendar -> a numbered plan; nothing is created until you reply", async () => {
  store.add("busy", event("b@t", "Busy day", "20261022T130000Z", "20261023T020000Z")); // all of Thursday 9am-10pm
  const r = await plan();
  expect(r.staged).toBe(true);
  expect(r.text).toContain("Study plan for the next 7 days:");
  expect(r.text).toContain("Study: Quiz 5 (due Thu 4pm)");
  expect(r.text).toContain("Study: Group Assignment #6 (due Fri 3pm)");
  expect(r.text).not.toContain("Already in");
  expect(r.text).not.toContain("Next month");
  expect(r.text).toContain('Reply "all", "1,3" or "none"');
  expect(store.mutations).toBe(0);
  expect(store.objs.size).toBe(1); // only the pre-existing event
  // Thursday is blocked all day, so no block may start on Thursday (the "(due Thu 4pm)" text is only a deadline)
  expect(r.text).not.toMatch(/^\d\) Thu /m);
  expect(r.text).toMatch(/^1\) Wed /m);
});

test("replying '1' adds only that block, 'all' adds every block, 'none' adds nothing; titles are 'Study: <assignment>'", async () => {
  await plan();
  expect(await handleConfirmation(OWNER, "1")).toMatch(/^Added 1 study block:\n1\) .* Study: /);
  expect(store.objs.size).toBe(1);
  expect(titles()[0]).toMatch(/^Study: (Quiz 5|Group Assignment #6)$/);
  expect(loadLastEvent<any>(OWNER).title).toMatch(/^Study: /); // "cancel that" works

  await plan();
  expect(await handleConfirmation(OWNER, "all")).toMatch(/^Added 2 study blocks:/);
  expect(store.objs.size).toBe(3);

  const before = store.mutations;
  await plan();
  expect(await handleConfirmation(OWNER, "none")).toBe("Okay, I didn't add anything.");
  expect(store.mutations).toBe(before);
});

test("'1,3' with a 3-block plan adds exactly blocks 1 and 3; an unrelated message drops the plan without adding anything", async () => {
  // three deadlines -> three blocks
  const sub = { score: null, workflow_state: "unsubmitted", submitted_at: null, missing: false, excused: false };
  const base = globalThis.fetch;
  globalThis.fetch = (async (url: any, init: any) => {
    const u = String(url);
    if (u.includes("/courses/1/assignments")) {
      return new Response(JSON.stringify([10, 11, 12].map((id, i) => ({ id, name: `HW ${i + 1}`, due_at: at(`2026-10-2${2 + i}`, 15, 0).toISOString(), points_possible: 10, submission_types: ["online_upload"], submission: sub }))), { status: 200 });
    }
    return base(url, init);
  }) as any;
  const r = await plan();
  expect(r.text).toMatch(/\n3\) /);
  expect(await handleConfirmation(OWNER, "1,3")).toMatch(/^Added 2 study blocks:\n1\) .*\n3\) /);
  expect(store.objs.size).toBe(2);

  await plan();
  const before = store.mutations;
  expect(await handleConfirmation(OWNER, "what's my grade")).toBeNull(); // goes on to the model
  expect(await handleConfirmation(OWNER, "all")).toBeNull(); // the plan is gone
  expect(store.mutations).toBe(before);
});

test("a number outside the plan is not an answer; the plan is dropped, not guessed at", async () => {
  await plan();
  expect(await handleConfirmation(OWNER, "9")).toBeNull();
  expect(store.objs.size).toBe(0);
});

test("nothing due, or no free time, says so and stages nothing", async () => {
  globalThis.fetch = (async (url: any) => {
    const u = String(url);
    const json = (o: unknown) => new Response(JSON.stringify(o), { status: 200 });
    if (u.includes("/courses?")) return json([{ id: 1, name: "Stats", course_code: "DATA101.001.FA26", enrollments: [] }]);
    return json([]);
  }) as any;
  const empty = await plan();
  expect(empty).toEqual({ staged: false, text: "Nothing is due in the next 7 days, so there's nothing to plan. Enjoy it." });
  expect(await handleConfirmation(OWNER, "all")).toBeNull();

  mockCanvas();
  for (const d of ["19", "20", "21", "22", "23", "24", "25", "26"]) store.add(`busy${d}`, event(`b${d}@t`, "Packed", `202610${d}T130000Z`, `202610${Number(d) + 1}T030000Z`));
  const packed = await plan();
  expect(packed.staged).toBe(false);
  expect(packed.text).toContain("I couldn't find a free hour");
});

test("the plan is owner-only: not offered to members, refused if requested, and the fast path ignores their messages", async () => {
  expect(toolsForRole("owner").map((t) => t.function.name)).toContain("plan_week");
  expect(toolsForRole("member").map((t) => t.function.name)).not.toContain("plan_week");
  const member: UserContext = { ...owner, role: "member", key: ALICE };
  expect(await runWithContext(member, () => executeTool("plan_week", {}, ALICE))).toMatch(/unknown tool/);
  expect(store.mutations).toBe(0);

  const h = await harness();
  let planCalls = 0;
  h.deps.plan = async () => (planCalls++, "PLAN TEXT");
  const { addMember } = await import("./helpers.ts");
  await addMember(ALICE);
  await h.say("plan my week", ALICE);
  expect(planCalls).toBe(0);
  expect(h.lastTo(ALICE)).toBe("agent answer"); // a member's message goes the normal way
  await h.say("plan my week", OWNER);
  expect(planCalls).toBe(1);
  expect(h.lastTo(OWNER)).toBe("PLAN TEXT");
  expect(h.agentCalls()).toBe(1); // only Alice's message reached the model
});

test("the planner tool returns the staged plan for the model to relay, and the fast path costs no LLM call", async () => {
  let llmCalls = 0;
  setLlmForTests({ chat: { completions: { create: async () => (llmCalls++, { choices: [], usage: { total_tokens: 1 } }) } } });
  const out = await runWithContext(owner, () => executeTool("plan_week", {}, OWNER));
  expect(out).toMatch(/^STAGED, nothing is added yet\. Send this plan to the user exactly as written, nothing else:\nStudy plan for the next 7 days:/);
  expect(llmCalls).toBe(0);
  expect(await handleConfirmation(OWNER, "1")).toMatch(/^Added 1 study block/);
  spyOn(console, "log").mockRestore();
});
