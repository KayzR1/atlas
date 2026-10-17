import { afterEach, beforeEach, expect, test } from "bun:test";
import { setLlmForTests } from "../src/agent.ts";
import { runWithContext } from "../src/context.ts";
import { addMember, ALICE, OWNER } from "./helpers.ts";
import { ensureOwner, getUser, hasGradeSnapshot, initDb, listActiveUsers, previousGradeSnapshot, saveGradeSnapshot, setUserFlag, wasNotified } from "../src/db.ts";
import { realDeps, runCheck, runSunday, seed, startScheduler, type Deps } from "../src/notify.ts";

const SUN = new Date("2026-10-18T22:10:00Z"); // Sunday 6:10 PM EDT
let now: Date;
let sent: string[];
let llmCalls: number;
let weekEvents: Deps["weekEvents"];

const sub = (o: any = {}) => ({ score: null, workflow_state: "unsubmitted", submitted_at: null, missing: false, excused: false, ...o });
const asg = (id: number, name: string, due: string | null, o: any = {}) => ({ id, name, due_at: due, points_possible: 10, submission_types: ["online_upload"], submission: sub(), ...o });
let assignments: any[];
let missing: any[];
let courses: any[];

const deps = (): Deps => ({
  now: () => now,
  courses: async () => courses,
  assignments: async (id) => (id === 1 ? assignments : []),
  announcements: async () => [],
  missing: async () => missing,
  events: async () => null,
  weekEvents,
  summarize: async (t) => (llmCalls++, t),
});
const send = async (_k: string, t: string) => (sent.push(t), true);

beforeEach(() => {
  initDb(":memory:");
  ensureOwner(OWNER);
  setUserFlag(OWNER, "seeded", true);
  now = SUN;
  sent = [];
  llmCalls = 0;
  weekEvents = undefined;
  missing = [];
  courses = [
    { id: 1, name: "Statistics", code: "DATA101.001.FA26", current_score: 95.2, current_grade: "A" },
    { id: 2, name: "Econ", code: "ECON210.002.FA26", current_score: 91.7, current_grade: "A-" },
  ];
  assignments = [
    asg(1, "HW 1", "2026-10-19T13:00:00Z"), // Mon 9:00 AM
    asg(2, "Quiz  5", "2026-10-21T20:00:00Z"), // Wed 4:00 PM
    asg(3, "Due tonight", "2026-10-19T03:59:00Z"), // Sun 11:59 PM, i.e. still tonight
    asg(4, "Next Sunday night", "2026-10-26T02:00:00Z"), // Sun Oct 25, 10:00 PM
    asg(5, "Too late", "2026-10-26T14:00:00Z"), // Mon Oct 26
    asg(6, "Already submitted", "2026-10-20T14:00:00Z", { submission: sub({ submitted_at: "2026-10-18T00:00:00Z", workflow_state: "submitted" }) }),
    asg(7, "No due date", null),
    asg(8, "Passed", "2026-10-17T14:00:00Z"),
  ];
});
afterEach(() => setLlmForTests());

test("the Sunday preview lists what's due through next Sunday, unsubmitted only, in order", async () => {
  expect(await runSunday(OWNER, deps(), send)).toBe("sent");
  const text = sent[0]!;
  expect(text.split("\n")[0]).toBe("Sunday preview from Pallas. The week ahead, through Sun Oct 25.");
  expect(text).toContain(
    "Due:\nSun 11:59 PM - DATA 101: Due tonight\nMon 9:00 AM - DATA 101: HW 1\nWed 4:00 PM - DATA 101: Quiz 5\nSun Oct 25 10:00 PM - DATA 101: Next Sunday night",
  );
  for (const excluded of ["Too late", "Already submitted", "No due date", "Passed"]) expect(text).not.toContain(excluded);
  expect(llmCalls).toBe(0); // code only
});

test("an empty week says so; missing work from the last 14 days is listed", async () => {
  assignments = [];
  missing = [{ id: 9, course_id: 1, name: "Lab 2", due_at: "2026-10-12T14:00:00Z" }, { id: 10, course_id: 1, name: "Ancient", due_at: "2026-08-12T14:00:00Z" }];
  await runSunday(OWNER, deps(), send);
  expect(sent[0]).toContain("Due: nothing. Enjoy it.");
  expect(sent[0]).toContain("Missing:\n- DATA 101: Lab 2 (was due Oct 12)");
  expect(sent[0]).not.toContain("Ancient");
});

test("grade changes this week: old -> new per course, with letters when they change", async () => {
  saveGradeSnapshot(OWNER, "2026-10-11", [{ course_id: 1, score: 94, grade: "A" }, { course_id: 2, score: 89.9, grade: "B+" }]);
  await runSunday(OWNER, deps(), send);
  expect(sent[0]).toContain("Grade changes this week:\n- DATA 101: 94% -> 95.2% (A)\n- ECON 210: 89.9% -> 91.7% (B+ -> A-)");
});

test("no change, and no snapshot yet, are both handled", async () => {
  saveGradeSnapshot(OWNER, "2026-10-11", [{ course_id: 1, score: 95.2, grade: "A" }, { course_id: 2, score: 91.7, grade: "A-" }]);
  await runSunday(OWNER, deps(), send);
  expect(sent[0]).toContain("Grades: no changes this week.");
  initDb(":memory:");
  ensureOwner(OWNER);
  await runSunday(OWNER, deps(), send);
  expect(sent[1]).toContain("Grades now: DATA 101 95.2% | ECON 210 91.7%");
});

test("the weekly snapshot: saved after sending, and next week compares against it", async () => {
  saveGradeSnapshot(OWNER, "2026-10-11", [{ course_id: 1, score: 94, grade: "A" }]);
  await runSunday(OWNER, deps(), send);
  expect(previousGradeSnapshot(OWNER, "2026-10-19").get(1)).toMatchObject({ score: 95.2, snap_date: "2026-10-18" });
  now = new Date("2026-10-25T22:10:00Z");
  courses[0].current_score = 96.0;
  await runSunday(OWNER, deps(), send);
  expect(sent[1]).toContain("- DATA 101: 95.2% -> 96% (A)");
});

test("first sign-up saves a baseline snapshot, and an older account gets one on its next check", async () => {
  initDb(":memory:");
  ensureOwner(OWNER);
  expect(hasGradeSnapshot(OWNER)).toBe(false);
  await seed(OWNER, deps());
  expect(previousGradeSnapshot(OWNER, "2026-10-19").size).toBe(2);

  initDb(":memory:");
  ensureOwner(OWNER);
  setUserFlag(OWNER, "seeded", true); // seeded before snapshots existed
  expect(hasGradeSnapshot(OWNER)).toBe(false);
  await runCheck(OWNER, deps(), send);
  expect(hasGradeSnapshot(OWNER)).toBe(true);
});

test("once only per Sunday; /quiet and /pause are respected without using up the slot", async () => {
  expect(await runSunday(OWNER, deps(), send)).toBe("sent");
  expect(wasNotified(OWNER, "sunday:2026-10-18")).toBe(true);
  expect(await runSunday(OWNER, deps(), send)).toBe("skipped");
  expect(await runSunday(OWNER, deps(), send, { force: true })).toBe("sent"); // dry-run style override
  expect(sent.length).toBe(2);

  initDb(":memory:");
  ensureOwner(OWNER);
  setUserFlag(OWNER, "notify", false);
  expect(await runSunday(OWNER, deps(), send)).toBe("skipped");
  setUserFlag(OWNER, "notify", true);
  setUserFlag(OWNER, "paused", true);
  expect(await runSunday(OWNER, deps(), send)).toBe("skipped");
  setUserFlag(OWNER, "paused", false);
  expect(await runSunday(OWNER, deps(), send)).toBe("sent"); // still available once they're back
});

test("a dropped send is retried later, not marked as sent", async () => {
  expect(await runSunday(OWNER, deps(), async () => false)).toBe("failed");
  expect(wasNotified(OWNER, "sunday:2026-10-18")).toBe(false);
  expect(await runSunday(OWNER, deps(), send)).toBe("sent");
});

test("calendar lines are the owner's only, and a calendar outage doesn't stop the preview", async () => {
  weekEvents = async (from, to) => {
    expect([from, to]).toEqual(["2026-10-18", "2026-10-25"]);
    return ["Mon 1:15–2:15pm Dentist"];
  };
  await runSunday(OWNER, deps(), send);
  expect(sent[0]).toContain("Calendar:\n- Mon 1:15–2:15pm Dentist");

  weekEvents = async () => null; // a member has no calendar: no section, not even a header
  initDb(":memory:");
  ensureOwner(OWNER);
  await runSunday(OWNER, deps(), send);
  expect(sent[1]).not.toContain("Calendar");

  weekEvents = async () => [];
  initDb(":memory:");
  ensureOwner(OWNER);
  await runSunday(OWNER, deps(), send);
  expect(sent[2]).toContain("Calendar: nothing scheduled.");

  weekEvents = async () => {
    throw new Error("icloud down");
  };
  initDb(":memory:");
  ensureOwner(OWNER);
  await runSunday(OWNER, deps(), send);
  expect(sent[3]).toContain("Calendar: (unavailable)");
  expect(sent[3]).toContain("Due:"); // the rest still went out
});

test("the real deps never hand a member the owner's calendar", async () => {
  process.env.ICLOUD_EMAIL = "x@example.com";
  process.env.ICLOUD_APP_PASSWORD = "x";
  const member = { key: ALICE, role: "member" as const, timezone: "America/New_York", canvasUrl: "x", canvasToken: "x" };
  expect(await runWithContext(member, () => realDeps.weekEvents!("2026-10-18", "2026-10-25"))).toBeNull();
  delete process.env.ICLOUD_EMAIL;
  delete process.env.ICLOUD_APP_PASSWORD;
});

test("the scheduler sends it on Sundays from 6pm (once), and never on other days or hours", async () => {
  const run = async (at: string) => {
    now = new Date(at);
    const before = sent.filter((t) => t.startsWith("Sunday preview")).length;
    const sched = startScheduler({ users: () => listActiveUsers(), contextFor: async (u) => ({ key: u.phone, role: "owner", timezone: u.timezone, canvasUrl: "x", canvasToken: "x" }), deps: deps(), send });
    await sched.tick();
    sched.stop();
    return sent.filter((t) => t.startsWith("Sunday preview")).length - before;
  };
  expect(await run("2026-10-17T22:10:00Z")).toBe(0); // Saturday 6:10 PM
  expect(await run("2026-10-18T20:50:00Z")).toBe(0); // Sunday 4:50 PM: too early
  expect(await run("2026-10-18T22:10:00Z")).toBe(1); // Sunday 6:10 PM
  expect(await run("2026-10-18T22:40:00Z")).toBe(0); // same Sunday again: already sent
  expect(await run("2026-10-19T02:30:00Z")).toBe(0); // Sunday 10:30 PM: past the window
  expect(llmCalls).toBe(0);
});

test("the preview works for a member too (Canvas only), with their own timezone", async () => {
  await addMember(ALICE);
  setUserFlag(ALICE, "seeded", true);
  expect(getUser(ALICE)).toBeTruthy();
  assignments = [asg(1, "Essay", "2026-10-20T14:00:00Z")];
  await runSunday(ALICE, deps(), send);
  expect(sent[0]).toContain("Tue 10:00 AM - DATA 101: Essay");
  expect(sent[0]).not.toContain("Calendar");
});
