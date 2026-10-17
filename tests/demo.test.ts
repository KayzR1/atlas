import { afterAll, beforeAll, beforeEach, expect, test } from "bun:test";
import { executeTool } from "../src/agent.ts";
import { runWithContext, type UserContext } from "../src/context.ts";
import { initDb } from "../src/db.ts";
import { dueText, fetchMissingRaw, listCourses } from "../src/canvas.ts";
import { gradeReport } from "../src/grades.ts";
import { askSyllabus } from "../src/syllabus.ts";
import { demoCourses, startDemoCanvas } from "../scripts/demo-canvas.ts";

// The demo server is what the README's recording instructions rely on, and also a faithful check
// that the shapes it serves are the ones every part of the bot actually reads.

let server: ReturnType<typeof startDemoCanvas>;
let ctx: UserContext;
beforeAll(() => {
  server = startDemoCanvas(0);
  ctx = { key: "+10000000000", role: "owner", timezone: "America/New_York", canvasUrl: `http://localhost:${server.port}`, canvasToken: "demo-token" };
});
afterAll(() => server.stop(true));
beforeEach(() => initDb(":memory:"));

const run = <T>(fn: () => Promise<T>) => runWithContext(ctx, fn);

test("courses come back with grades computed the same way the bot computes them", async () => {
  const courses = await run(() => listCourses());
  expect(courses.map((c) => c.name)).toEqual(["DATA 101: Intro to Data Science", "ECON 210: Microeconomics", "ENGL 150: Creative Writing"]);
  for (const c of courses) {
    expect(c.current_score).toBeGreaterThan(50);
    expect(c.current_grade).toBeTruthy();
  }
});

test("'what's due' lists the fake upcoming work, soonest first, and nothing from the far future", async () => {
  const out = await run(() => dueText("7d"));
  expect(out.split("\n")[0]).toBe("Due in the next 7 days:");
  const order = ["Lab 5: Regression", "Problem Set 4", "HW 6", "Quiz 6", "Workshop piece 3", "Project Proposal"].map((n) => out.indexOf(n));
  expect(order.every((i) => i > 0)).toBe(true);
  expect([...order].sort((a, b) => a - b)).toEqual(order);
  expect(out).not.toContain("Final Project");
  expect(out).toContain("DATA 101: Lab 5: Regression");
});

test("grade math works on all three kinds of course: weighted with drops, an empty final group, and points-based", async () => {
  const data = await run(() => gradeReport({ course: "DATA 101", target: "A", group: "Final Project" }));
  expect(data).toMatch(/matches Canvas's \d+\.\d\d%/); // the server's number and the calculator agree
  expect(data).toContain("drops lowest 1");
  expect(data).toContain('Solving for: Final Project');
  const econ = await run(() => gradeReport({ course: "econ 210", target: "A", assignment: "final exam" }));
  expect(econ).toContain("matches Canvas's");
  expect(econ).toContain("drops lowest 2");
  expect(econ).toContain("Final Exam (35% of the course, nothing graded or posted yet)");
  expect(econ).toMatch(/need \d+\.\d% on "Final Exam"|IMPOSSIBLE|ALREADY GUARANTEED/);
  const engl = await run(() => gradeReport({ course: "ENGL 150" }));
  expect(engl).toContain("points-based");
  expect(engl).toContain("matches Canvas's");
});

test("syllabus questions are answered from the fake syllabi, and a question with no answer says not found", async () => {
  expect(await run(() => askSyllabus({ course: "DATA 101", question: "what's the late policy" }))).toContain("10% per day");
  expect(await run(() => askSyllabus({ course: "ECON 210", question: "office hours" }))).toContain("Gardner 305");
  expect(await run(() => askSyllabus({ course: "ENGL 150", question: "when is the final exam" }))).toMatch(/^NOT FOUND/);
});

test("announcements and missing work are served too", async () => {
  const ann = await run(() => executeTool("list_announcements", { course_ids: [1, 2, 3], days_back: 14 }, ctx.key));
  expect(ann).toContain("Lab 5 posted");
  expect(ann).toContain("Midterm grades posted");
  const missing = await run(() => fetchMissingRaw());
  expect(missing.map((m) => m.name)).toEqual(["Reading response 3"]);
});

test("the demo data contains nothing real: no school host, no phone numbers, no email addresses, only fictional courses", () => {
  const text = JSON.stringify(demoCourses());
  expect(text).not.toMatch(/instructure|uncch|\.edu/i);
  expect(text).not.toMatch(/\+?\d{3}[\s().-]*\d{3}[\s().-]*\d{4}/); // phone-number shaped
  expect(text).not.toMatch(/[\w.+-]+@[\w-]+\.[a-z]{2,}/i); // email shaped
  expect(demoCourses().map((c) => c.code.split(".")[0])).toEqual(["DATA101", "ECON210", "ENGL150"]);
});
