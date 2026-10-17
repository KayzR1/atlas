import { beforeEach, expect, test } from "bun:test";
import { ensureUser, getUser, initDb, setUserFlag } from "../src/db.ts";
import { courseLabel, recentMissing, runBrief, runCheck, runMissingDaily, type Deps } from "../src/notify.ts";
import type { RawAssignment } from "../src/canvas.ts";

const ME = "+19195550100";
const NOW = new Date("2026-10-15T14:00:00Z"); // 10:00 AM EDT
const iso = (h: number) => new Date(NOW.getTime() + h * 3600_000).toISOString();

let sent: string[];
let send: (k: string, t: string) => Promise<boolean>;
let assignments: RawAssignment[];
let announcements: { id: number; course_id: number; title: string; body: string; posted_at: string | null }[];
let missing: { id: number; course_id: number; name: string; due_at: string | null }[];
let summarized: number;
let now: Date;

const sub = (o: Partial<NonNullable<RawAssignment["submission"]>> = {}) => ({ score: null, workflow_state: "unsubmitted", submitted_at: null, missing: false, excused: false, ...o });
const asg = (id: number, name: string, over: Partial<RawAssignment> = {}): RawAssignment => ({
  id, name, due_at: null, points_possible: 20, submission_types: ["online_upload"], submission: sub(), ...over,
});

const deps = (): Deps => ({
  now: () => now,
  courses: async () => [{ id: 1, name: "Statistics", code: "DATA101.001/003.FA26", current_score: 95.19, current_grade: "A" }],
  assignments: async () => assignments,
  announcements: async () => announcements,
  missing: async () => missing,
  events: async () => ["9am-10am Study group"],
  summarize: async (title) => (summarized++, `summary of ${title}`),
});

beforeEach(() => {
  initDb(":memory:");
  ensureUser(ME);
  sent = [];
  send = async (_k, t) => (sent.push(t), true);
  assignments = [];
  announcements = [];
  missing = [];
  summarized = 0;
  now = NOW;
});

test("courseLabel", () => {
  expect(courseLabel({ name: "x", code: "DATA101.001/003.FA26" })).toBe("DATA 101");
  expect(courseLabel({ name: "Advising", code: "UNC.ADV" })).toBe("Advising");
});

test("first run seeds silently, then only new things are announced", async () => {
  assignments = [asg(1, "Quiz 3", { submission: sub({ score: 17, submitted_at: iso(-50) }) })];
  announcements = [{ id: 10, course_id: 1, title: "Old news", body: "b", posted_at: iso(-100) }];
  expect(await runCheck(ME, deps(), send)).toBe("seeded");
  expect(sent).toEqual([]);
  expect(await runCheck(ME, deps(), send)).toBe("nothing");

  assignments.push(asg(2, "Quiz 4", { submission: sub({ score: 18, submitted_at: iso(-5) }) }));
  announcements.push({ id: 11, course_id: 1, title: "Exam moved", body: "b", posted_at: iso(-1) });
  expect(await runCheck(ME, deps(), send)).toBe("sent");
  expect(sent).toEqual(["DATA 101 Quiz 4 graded: 18/20 (course: A 95.19%)\nDATA 101 announcement: summary of Exam moved"]);
  expect(summarized).toBe(1); // LLM only touched the one new announcement

  // nothing is ever sent twice
  expect(await runCheck(ME, deps(), send)).toBe("nothing");
  expect(sent.length).toBe(1);
});

test("a changed score notifies again", async () => {
  assignments = [asg(1, "Quiz 3", { submission: sub({ score: 17 }) })];
  await runCheck(ME, deps(), send); // seed
  assignments = [asg(1, "Quiz 3", { submission: sub({ score: 19 }) })];
  await runCheck(ME, deps(), send);
  expect(sent[0]).toMatch(/Quiz 3 graded: 19\/20/);
});

test("deadline nudges: 24h then 3h, skipping submitted, undated and non-submittable", async () => {
  assignments = [
    asg(1, "Essay", { due_at: iso(20) }),
    asg(2, "Submitted HW", { due_at: iso(20), submission: sub({ submitted_at: iso(-1), workflow_state: "submitted" }) }),
    asg(3, "No due date"),
    asg(4, "Attendance", { due_at: iso(5), submission_types: ["none"] }),
    asg(5, "Far away", { due_at: iso(60) }),
  ];
  await runCheck(ME, deps(), send); // seed
  await runCheck(ME, deps(), send);
  expect(sent).toEqual(["Due in 20h (Fri 6:00 AM): Essay [DATA 101]"]);
  await runCheck(ME, deps(), send);
  expect(sent.length).toBe(1);

  now = new Date(NOW.getTime() + 18 * 3600_000); // 2h left
  await runCheck(ME, deps(), send);
  expect(sent[1]).toBe("Due in 2h (Fri 6:00 AM): Essay [DATA 101]");
  await runCheck(ME, deps(), send);
  expect(sent.length).toBe(2);
});

test("an assignment already inside 3h skips the 24h nudge", async () => {
  assignments = [asg(1, "Soon", { due_at: iso(2) })];
  await runCheck(ME, deps(), send);
  await runCheck(ME, deps(), send);
  now = new Date(NOW.getTime() + 30 * 60_000);
  await runCheck(ME, deps(), send);
  expect(sent.length).toBe(1);
  expect(sent[0]).toMatch(/^Due in 2h/);
});

test("multiple alerts become one text", async () => {
  await runCheck(ME, deps(), send); // seed (empty)
  assignments = [asg(1, "A", { due_at: iso(2) }), asg(2, "B", { due_at: iso(10) }), asg(3, "Q", { submission: sub({ score: 5 }) })];
  await runCheck(ME, deps(), send);
  expect(sent.length).toBe(1);
  expect(sent[0]!.split("\n").length).toBe(3);
});

test("/pause and /quiet suppress notifications without losing them", async () => {
  await runCheck(ME, deps(), send); // seed
  assignments = [asg(1, "Quiz", { submission: sub({ score: 9 }) })];
  setUserFlag(ME, "notify", false);
  expect(await runCheck(ME, deps(), send)).toBe("skipped");
  setUserFlag(ME, "notify", true);
  setUserFlag(ME, "paused", true);
  expect(await runCheck(ME, deps(), send)).toBe("skipped");
  expect(await runBrief(ME, deps(), send)).toBe("skipped");
  expect(sent).toEqual([]);
  setUserFlag(ME, "paused", false);
  expect(await runCheck(ME, deps(), send)).toBe("sent");
});

test("a dropped (rate-limited) send is retried next check", async () => {
  await runCheck(ME, deps(), send); // seed
  assignments = [asg(1, "Quiz", { submission: sub({ score: 9 }) })];
  expect(await runCheck(ME, { ...deps() }, async () => false)).toBe("failed");
  expect(await runCheck(ME, deps(), send)).toBe("sent");
});

test("morning brief: calendar + 48h + missing, once per day; evening job doesn't repeat missing", async () => {
  await runCheck(ME, deps(), send); // seed
  assignments = [asg(1, "Essay", { due_at: iso(30) }), asg(2, "Later", { due_at: iso(100) })];
  missing = [{ id: 9, course_id: 1, name: "Lab 2", due_at: iso(-200) }];
  expect(await runBrief(ME, deps(), send)).toBe("sent");
  expect(sent[0]).toBe(
    "Good morning! Pallas here. Thursday, Oct 15\nToday: 9am-10am Study group\nDue in the next 48h:\n- Fri 4:00 PM DATA 101: Essay\nMissing:\n- DATA 101: Lab 2 (was due Oct 7)",
  );
  expect(await runBrief(ME, deps(), send)).toBe("skipped");
  expect(await runMissingDaily(ME, deps(), send)).toBe("nothing");

  missing.push({ id: 10, course_id: 1, name: "HW 7", due_at: iso(-3) });
  expect(await runMissingDaily(ME, deps(), send)).toBe("sent");
  expect(sent[1]).toBe("Missing work (Canvas marked these missing):\n- DATA 101: HW 7 (was due Oct 15)");
});

test("brief with an unavailable calendar still goes out", async () => {
  await runCheck(ME, deps(), send);
  const d = { ...deps(), events: async () => { throw new Error("boom"); } };
  expect(await runBrief(ME, d, send)).toBe("sent");
  expect(sent[0]).toContain("Today: (calendar unavailable)");
  expect(getUser(ME)!.seeded).toBe(1);
});

test("missing work only includes items that came due in the last 14 days", async () => {
  missing = [
    { id: 1, course_id: 1, name: "Old", due_at: iso(-24 * 20) },
    { id: 2, course_id: 1, name: "Recent", due_at: iso(-24 * 5) },
    { id: 3, course_id: 1, name: "Edge in", due_at: iso(-24 * 13.9) },
    { id: 4, course_id: 1, name: "Future", due_at: iso(5) },
    { id: 5, course_id: 1, name: "Undated", due_at: null },
  ];
  expect((await recentMissing(deps())).map((m) => m.name)).toEqual(["Recent", "Edge in"]);
  await runCheck(ME, deps(), send); // seed
  await runBrief(ME, deps(), send);
  expect(sent[0]).not.toContain("Old");
  expect(sent[0]).toContain("Recent");
});
