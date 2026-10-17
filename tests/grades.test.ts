import { afterEach, beforeEach, expect, test } from "bun:test";
import { executeTool, resetModelCooldowns, runAgent, setLlmForTests, toolsForRole, type LlmLike } from "../src/agent.ts";
import { runWithContext, type UserContext } from "../src/context.ts";
import { initDb } from "../src/db.ts";
import { gradeTools } from "../src/grades.ts";
import {
  applyDrops, buildReport, computeGrade, DEFAULT_SCALE, gradeReport, letterFor, normalizeGroups, normalizeScale, parseGoal, resolveTarget, runGradeTool, solve,
  type GCourse, type Target,
} from "../src/grades.ts";

const ctx: UserContext = { key: "+10000000000", role: "owner", timezone: "America/New_York", canvasUrl: "https://canvas.example", canvasToken: "tok" };
const realFetch = globalThis.fetch;
beforeEach(() => {
  initDb(":memory:");
  resetModelCooldowns();
});
afterEach(() => {
  globalThis.fetch = realFetch;
  setLlmForTests();
});

// ---------- fixtures: the shape of the real ECON 210 course ----------

let nextId = 1;
const sub = (score: number | null | undefined, o: any = {}) => ({ score, workflow_state: score == null ? "unsubmitted" : "graded", excused: false, ...o });
const asg = (name: string, points: number, score: number | null | undefined, o: any = {}) => ({ id: nextId++, name, points_possible: points, grading_type: "points", omit_from_final_grade: false, submission: sub(score), ...o });
const grp = (name: string, weight: number, assignments: any[], rules: any = {}) => ({ id: nextId++, name, group_weight: weight, rules, assignments });

function econRaw() {
  nextId = 1;
  const quizScores = [3, null, 2, 3, 3, 3, 3, 3, 3, 3, 3];
  return [
    grp("Participation", 0, Array.from({ length: 13 }, (_, i) => asg(`Participation ${i + 1}`, 100, 100))),
    grp("Projects", 40, [
      asg("Project 1", 100, 100), asg("Project 2", 100, 92), asg("Project 3", 100, 84), asg("Project 4", 100, 76),
      asg("Project 5", 100, undefined, { omit_from_final_grade: true }), asg("Project 6", 100, null, { omit_from_final_grade: true }),
    ]),
    grp("Midterm Exam", 15, [asg("Midterm", 100, 91)]),
    grp("Final Exam", 20, []),
    grp("Quizzes", 15, [...quizScores.map((sc, i) => asg(`Quiz ${i + 1}`, 3, sc)), asg("Survey A", 1, 1), asg("Survey B", 1, 1)], { drop_lowest: 2 }),
    grp("Lab Final", 10, []),
    grp("Project Final Grade", 40, []),
  ];
}
// the course's own scale (Canvas grading standard 4242)
const ECON_SCALE = normalizeScale({ grading_scheme: [["A", 93], ["A-", 90], ["B+", 86], ["B", 83], ["B-", 80], ["C+", 77], ["C", 73], ["C-", 70], ["D+", 67], ["D", 60], ["F", 0]].map(([name, v]) => ({ name, calculated_value: v })) });
const course = (raw: any[], over: Partial<GCourse> = {}): GCourse => ({ name: "ECON 210", weighted: true, groups: normalizeGroups(raw), scale: ECON_SCALE, scaleSource: 'the course\'s "ECON 210" scale', canvasScore: null, canvasGrade: null, ...over });
const group = (c: GCourse, name: string) => c.groups.find((g) => g.name === name)!;
const target = (c: GCourse, name: string): Target => ({ kind: "group", group: group(c, name) });

// ---------- current grade ----------

test("weighted current grade on a course with weights adding to 140, an empty Final group, drop-lowest-2 and omitted work", () => {
  const c = course(econRaw());
  const r = computeGrade(c);
  expect(r.percent!).toBeCloseTo(91.214, 3); // (40*88 + 15*91 + 15*100) / 70 = 6385 / 70
  expect(r.totalWeight).toBe(70); // only groups with grades count, rescaled
  const by = Object.fromEntries(r.rows.map((x) => [x.group.name, x]));
  expect(by["Projects"]!.pct).toBe(88); // projects 5 and 6 are omitted from the final grade
  expect(by["Midterm Exam"]!.pct).toBe(91);
  expect(by["Quizzes"]!.pct).toBe(100); // lowest 2 dropped: the 2/3 and one perfect score
  expect(by["Quizzes"]!.dropped.length).toBe(2);
  expect(by["Final Exam"]!.pct).toBeNull(); // nothing graded: left out
  expect(by["Participation"]!.group.weight).toBe(0); // zero-weight group never counts
  expect(letterFor(r.percent!, c.scale)).toBe("A-");
});

test("the report says it matches Canvas, or admits when it doesn't", () => {
  expect(buildReport(course(econRaw(), { canvasScore: 91.21 }), "ECON 210", {})).toContain("current 91.21% (A-), matches Canvas's 91.21%");
  expect(buildReport(course(econRaw(), { canvasScore: 88.2, canvasGrade: "B+" }), "ECON 210", {})).toContain("Canvas shows 88.20% (B+) so treat this as approximate");
  const text = buildReport(course(econRaw()), "ECON 210", {});
  expect(text).toContain("Projects 40%: 88.0% | Midterm Exam 15%: 91.0% | Quizzes 15%: 100.0% (drops lowest 2)");
  expect(text).toContain("Not graded yet, so not counted: Final Exam 20%, Lab Final 10%, Project Final Grade 40%");
  expect(text).toContain("add up to 140%, not 100%");
});

test("weights that add up to 100 with every group graded: plain weighted average", () => {
  nextId = 1;
  const c = course([grp("HW", 30, [asg("a", 10, 9), asg("b", 10, 7)]), grp("Exams", 70, [asg("e", 100, 80)])]);
  expect(computeGrade(c).percent!).toBeCloseTo(0.3 * 80 + 0.7 * 80, 6); // HW 80%, exams 80%
  nextId = 1;
  const d = course([grp("HW", 30, [asg("a", 10, 10)]), grp("Exams", 70, [asg("e", 100, 50)])]);
  expect(computeGrade(d).percent!).toBeCloseTo(0.3 * 100 + 0.7 * 50, 6);
});

test("ungraded, excused, omitted and not-graded work is ignored; zero-point extra credit counts", () => {
  nextId = 1;
  const c = course([grp("HW", 100, [asg("graded", 10, 8), asg("ungraded", 10, null), asg("excused", 10, 0, { submission: sub(0, { excused: true }) }), asg("omitted", 10, 0, { omit_from_final_grade: true }), asg("ungradedtype", 10, 0, { grading_type: "not_graded" })])]);
  expect(computeGrade(c).percent).toBe(80);
  nextId = 1;
  const extra = course([grp("HW", 100, [asg("a", 10, 10), asg("bonus", 0, 2)])]);
  expect(computeGrade(extra).percent!).toBeCloseTo(120, 6); // 12 / 10
});

// ---------- drop rules ----------

const it = (id: number, points: number, score: number) => ({ id, points, score });

test("drop lowest picks the set that gives the best grade, even when assignments are worth different points", () => {
  // dropping the 2/5 gives 50/60=83.3%; dropping 40/50 gives 12/15=80%; dropping 10/10 gives 42/55=76%
  const r = applyDrops({ dropLowest: 1, dropHighest: 0, neverDrop: [] }, [it(1, 10, 10), it(2, 5, 2), it(3, 50, 40)]);
  expect(r.dropped).toEqual([2]);
  expect(r.earned / r.possible).toBeCloseTo(50 / 60, 9);
  // the item whose RATIO is lowest is not always the best to drop: 1/1 (100%) vs 8/20 (40%) -> drop the 8/20
  expect(applyDrops({ dropLowest: 1, dropHighest: 0, neverDrop: [] }, [it(1, 1, 1), it(2, 20, 8), it(3, 20, 19)]).dropped).toEqual([2]);
});

test("never_drop protects an assignment, at least one item always stays, drop_highest drops the best", () => {
  const protectedLow = applyDrops({ dropLowest: 1, dropHighest: 0, neverDrop: [2] }, [it(1, 10, 10), it(2, 5, 2), it(3, 50, 40)]);
  expect(protectedLow.dropped).toEqual([3]); // can't drop the 2/5, so the next best drop is 40/50 (leaves 12/15 = 80%)
  expect(protectedLow.earned / protectedLow.possible).toBeCloseTo(12 / 15, 9);
  const many = applyDrops({ dropLowest: 5, dropHighest: 0, neverDrop: [] }, [it(1, 10, 5), it(2, 10, 6), it(3, 10, 7)]);
  expect(many.dropped.length).toBe(2); // keeps one
  expect(many.earned).toBe(7);
  const hi = applyDrops({ dropLowest: 0, dropHighest: 1, neverDrop: [] }, [it(1, 10, 10), it(2, 10, 6), it(3, 10, 7)]);
  expect(hi.dropped).toEqual([1]);
});

test("a drop rule changes what you need: the lowest quiz is forgiven", () => {
  nextId = 1;
  const raw = [grp("Quizzes", 100, [asg("q1", 10, 4), asg("q2", 10, 10), asg("q3", 10, 10), asg("q4", 10, null)], { drop_lowest: 1 })];
  const c = course(raw);
  expect(computeGrade(c).percent).toBe(100); // the 4/10 is dropped
  const t = resolveTarget(c, "q4");
  expect(t.ok).toBe(true);
  // a 0 on q4 would be the lowest and get dropped, but then the 4/10 counts again: 24/30 = 80%.
  // Scoring x% on q4 (once x > 40%, the 4/10 is the one dropped): (20 + x/10)/30 >= .95  ->  x = 85
  const s = solve(c, (t as any).target, 95, null);
  expect(s).toMatchObject({ verdict: "need", need: 85 });
  expect((s as any).at0).toBe(80);
  expect((s as any).at100).toBe(100);
});

// ---------- what do I need ----------

test("ECON 210, what the Final Exam group must score for an A, A-, B (hand-checked numbers)", () => {
  const c = course(econRaw());
  const T = target(c, "Final Exam");
  // Canvas's rule (only graded groups count): grade = (6385 + 20x) / 90
  const a = solve(c, T, 93, null);
  expect(a).toMatchObject({ verdict: "need", need: 99.3 }); // x = 99.25, rounded UP to a tenth
  expect((a as any).at0).toBeCloseTo(70.944, 3);
  expect((a as any).at100).toBeCloseTo(93.167, 3);
  expect(solve(c, T, 90, null)).toMatchObject({ verdict: "need", need: 85.8 }); // 85.75
  expect(solve(c, T, 83, null)).toMatchObject({ verdict: "need", need: 54.3 }); // 54.25
  // if the other two empty groups also score the current 91.214%: grade = (6385 + 20x + 50*91.214) / 140
  const rest = computeGrade(c).percent!;
  const bA = solve(c, T, 93, rest);
  expect(bA.verdict).toBe("impossible"); // an A is out of reach once the other groups are assumed to score like the rest
  expect((bA as any).at100).toBeCloseTo(92.469, 3); // (8385 + 50*91.214) / 140
  expect(solve(c, T, 90, rest)).toMatchObject({ verdict: "need", need: 82.8 }); // 82.71
  const bImp = solve(c, T, 95, rest);
  expect(bImp.verdict).toBe("impossible");
  expect((bImp as any).at100).toBeCloseTo(92.469, 3);
});

test("already guaranteed, and impossible, are stated plainly", () => {
  const c = course(econRaw());
  const T = target(c, "Final Exam");
  expect(solve(c, T, 70, null)).toMatchObject({ verdict: "guaranteed" }); // 70.9% even with a 0
  expect(solve(c, T, 95, null)).toMatchObject({ verdict: "impossible" }); // max 93.2%
  const text = buildReport(c, "ECON 210", { target: "95", group: "Final Exam" });
  expect(text).toMatch(/IMPOSSIBLE\. Even 100% on "Final Exam" only reaches 93\.2% \(goal 95%\)/);
  expect(buildReport(c, "ECON 210", { target: "C-", group: "Final Exam" })).toMatch(/ALREADY GUARANTEED\. Even 0% on "Final Exam" leaves you at 70\.9% \(goal C- \(70%\+\)\)/);
  expect(buildReport(c, "ECON 210", { target: "A", group: "Final Exam" })).toContain('need 99.3% on "Final Exam"');
});

test("a specific assignment: points needed; a group with several ungraded items: the average needed on all of them", () => {
  nextId = 1;
  const raw = [grp("Homework", 40, [asg("HW1", 10, 10), asg("HW2", 10, 8)]), grp("Exams", 60, [asg("Midterm", 100, 80), asg("Final Exam", 200, null)])];
  const c = course(raw);
  // Homework 90%, Exams so far 80% -> current (40*90+60*80)/100 = 84; after the final: exams = (80 + f)/300
  expect(computeGrade(c).percent!).toBeCloseTo(84, 6);
  const text = buildReport(c, "ECON 210", { target: "90", assignment: "final exam" });
  // exams group % = (80+2*x)/(300) ... solve: 0.4*90 + 0.6*((80+2x)/3) = 90 -> (80+2x)/3 = 90 -> x = 95
  expect(text).toContain('need 95.0% on "Final Exam" (190.0 of 200 pts)');

  nextId = 1;
  const multi = course([grp("Homework", 100, [asg("HW1", 10, 5), asg("HW2", 10, null), asg("HW3", 10, null)])]);
  const t = buildReport(multi, "X", { target: "75", group: "Homework" });
  // (5 + 10x/100*2)/30 >= .75 -> 5 + 0.2x >= 22.5 -> x = 87.5
  expect(t).toContain('need 87.5% on "Homework"');
});

test("a points-based course (no group weights): total points earned over total possible", () => {
  nextId = 1;
  const raw = [grp("Everything", 0, [asg("a", 100, 90), asg("b", 100, 90), asg("Final", 100, null)])];
  const c = course(raw, { weighted: false });
  expect(computeGrade(c).percent).toBe(90);
  expect(buildReport(c, "X", {})).toContain("points-based");
  // (180 + x) / 300 >= 0.9 -> x = 90
  expect(solve(c, resolveTarget(c, "Final").ok ? (resolveTarget(c, "Final") as any).target : null, 90, null)).toMatchObject({ verdict: "need", need: 90 });
  // impossible when too far behind: (100 + x)/300 <= 66.7% < 90%
  nextId = 1;
  const behind = course([grp("Everything", 0, [asg("a", 100, 50), asg("b", 100, 50), asg("Final", 100, null)])], { weighted: false });
  const s = solve(behind, (resolveTarget(behind, "Final") as any).target, 90, null);
  expect(s.verdict).toBe("impossible");
  expect((s as any).at100).toBeCloseTo(200 / 3, 6);
  expect(buildReport(behind, "X", { target: "90", assignment: "Final" })).toContain("IMPOSSIBLE");
});

test("a group with zero weight can't change the grade; a fully graded group has nothing left to score", () => {
  nextId = 1;
  const c = course([grp("Exams", 100, [asg("m", 100, 80)]), grp("Extra practice", 0, [asg("p1", 10, 10), asg("p2", 10, null)])]);
  expect(solve(c, { kind: "group", group: group(c, "Extra practice") }, 95, null)).toMatchObject({ verdict: "no_effect" });
  expect(buildReport(c, "X", { target: "A", group: "Extra practice" })).toContain("would not change your grade");
  expect(buildReport(course(econRaw()), "ECON 210", { target: "A", group: "Participation" })).toContain("nothing left to score");
});

// ---------- parsing and resolution ----------

test("goals: letters (with +/-), 'an A', percents, fractions; unknown letters are rejected", () => {
  expect(parseGoal("A", ECON_SCALE)).toEqual({ pct: 93, label: "A (93%+)" });
  expect(parseGoal("an A-", ECON_SCALE)!.pct).toBe(90);
  expect(parseGoal("b+", ECON_SCALE)!.pct).toBe(86);
  expect(parseGoal("A−", ECON_SCALE)!.pct).toBe(90); // unicode minus
  expect(parseGoal("90", ECON_SCALE)).toEqual({ pct: 90, label: "90%" });
  expect(parseGoal("92.5%", ECON_SCALE)!.pct).toBe(92.5);
  expect(parseGoal("0.9", ECON_SCALE)!.pct).toBe(90);
  expect(parseGoal("A+", ECON_SCALE)).toBeNull(); // not on this scale
  expect(parseGoal("banana", ECON_SCALE)).toBeNull();
  expect(DEFAULT_SCALE.find((e) => e.name === "A")!.min).toBe(94);
});

test("naming the target: 'final' finds the Final Exam group even though other groups say 'final'; ambiguity is reported, not guessed", () => {
  const c = course(econRaw());
  const q = (a?: string, g?: string) => resolveTarget(c, a, g);
  expect((q() as any).target.group.name).toBe("Final Exam"); // nothing named: the one real "final exam"
  expect((q("final") as any).target.group.name).toBe("Final Exam");
  expect((q("the final exam") as any).target.group.name).toBe("Final Exam");
  expect((q(undefined, "final") as any).target.group.name).toBe("Final Exam");
  const amb = q(undefined, "exam");
  expect(amb.ok).toBe(false);
  expect((amb as any).message).toContain("Midterm Exam; Final Exam");
  expect((q("Midterm") as any).message).toContain("already graded (91/100)");
  expect((q("Project 6") as any).message).toContain("not counted toward the final grade");
  expect((q("Quizzes", undefined) as any).target.group.name).toBe("Quizzes");
  expect((q("zzz") as any).message).toContain("No assignment or group matches");
  const graded = q(undefined, "Midterm Exam");
  expect(graded.ok).toBe(false);
  expect((graded as any).message).toContain("nothing left to score");
  // several ungraded things and nothing named: everything remaining
  nextId = 1;
  const none = course([grp("HW", 50, [asg("a", 10, null)]), grp("Tests", 50, [asg("t", 10, null)])]);
  expect((resolveTarget(none) as any).target.kind).toBe("remaining");
});

// ---------- end to end with mocked Canvas (no network, no LLM) ----------

function mockCanvas(opts: { standards?: "ok" | "forbidden"; canvasScore?: number } = {}) {
  const standard = { id: 4242, title: "ECON 210", grading_scheme: ECON_SCALE.map((e) => ({ name: e.name, calculated_value: e.min })) };
  globalThis.fetch = (async (url: any) => {
    const u = String(url);
    const json = (o: unknown) => new Response(JSON.stringify(o), { status: 200, headers: { "content-type": "application/json" } });
    if (!u.startsWith("https://canvas.example/api/v1/")) throw new Error(`unexpected network call: ${u}`);
    if (u.includes("/courses?")) return json([{ id: 9001, name: "ECON210.002.FA26", course_code: "ECON210.002.FA26", enrollments: [{ type: "student", computed_current_score: opts.canvasScore ?? 91.21, computed_current_grade: "A-" }] }, { id: 7, name: "DATA101.001.FA26", course_code: "DATA101.001.FA26", enrollments: [] }]);
    if (u.endsWith("/courses/9001")) return json({ id: 9001, apply_assignment_group_weights: true, grading_standard_id: 4242 });
    if (u.includes("/courses/9001/assignment_groups")) return json(econRaw());
    if (u.includes("/courses/9001/grading_standards")) return opts.standards === "forbidden" ? new Response("no", { status: 403 }) : json([{ id: 1, title: "other", grading_scheme: [] }, standard]);
    return new Response("nope", { status: 404 });
  }) as any;
}

test("gradeReport against Canvas: finds the course by loose name, uses the course's own scale, matches Canvas", async () => {
  mockCanvas();
  const text = await runWithContext(ctx, () => gradeReport({ course: "econ 210", target: "A", assignment: "final" }));
  expect(text).toContain("ECON 210: current 91.21% (A-), matches Canvas's 91.21%.");
  expect(text).toContain('Scale used: the course\'s "ECON 210" scale.');
  expect(text).toContain('need 99.3% on "Final Exam"');
  expect(text).toContain("IMPOSSIBLE"); // second scenario: an A is out of reach
  expect(await runWithContext(ctx, () => gradeReport({ course: "9001" }))).toContain("current 91.21%"); // by id
  expect(await runWithContext(ctx, () => gradeReport({ course: "biology" }))).toContain('No active course matches "biology"');
  mockCanvas({ canvasScore: 80 });
  expect(await runWithContext(ctx, () => gradeReport({ course: "ECON 210" }))).toContain("Canvas shows 80.00% (A-) so treat this as approximate");
});

test("if the course's grading scale can't be read, Canvas's default scale is used and the answer says so", async () => {
  mockCanvas({ standards: "forbidden" });
  const text = await runWithContext(ctx, () => gradeReport({ course: "ECON 210", target: "A", group: "Final Exam" }));
  expect(text).toContain("Canvas's default scale");
  expect(text).toContain("letter cutoffs are assumed");
  expect(text).toContain("Goal: A (94%+)"); // the default A is 94, not this course's 93
});

test("grade_calc is available to every user, routed through the tool runner, and tolerant of null arguments", async () => {
  for (const role of ["owner", "member"] as const) expect(toolsForRole(role).map((t) => t.function.name)).toContain("grade_calc");
  mockCanvas();
  const out = await runWithContext(ctx, () => executeTool("grade_calc", { course: "ECON 210", target: null, assignment: null, group: "", assume_rest_percent: null }, "k"));
  expect(out).toContain("current 91.21%");
  expect(out).not.toContain("Goal:");
  expect(await runWithContext(ctx, () => runGradeTool({ target: "A" }))).toMatch(/^Error: course is required/);
  globalThis.fetch = (async () => new Response("boom", { status: 500 })) as any;
  expect(await runWithContext(ctx, () => runGradeTool({ course: "ECON 210" }))).toMatch(/^Error: /);
});

test("the model only phrases the result: one tool call, the numbers come from code (mocked LLM)", async () => {
  mockCanvas();
  const calls: any[] = [];
  const llm: LlmLike = {
    chat: {
      completions: {
        create: async (p: any) => {
          calls.push(JSON.parse(JSON.stringify(p)));
          if (calls.length === 1)
            return { choices: [{ message: { role: "assistant", content: null, tool_calls: [{ id: "c1", type: "function", function: { name: "grade_calc", arguments: JSON.stringify({ course: "ECON 210", target: "A-", assignment: "final exam" }) } }] } }], usage: { total_tokens: 900 } };
          return { choices: [{ message: { role: "assistant", content: "You need about 86% on the final to finish with an A-." } }], usage: { total_tokens: 1100 } };
        },
      },
    },
  };
  setLlmForTests(llm);
  const reply = await runWithContext(ctx, () => runAgent([{ role: "user", content: "what do I need on the final to get an A- in econ 210" }], "k"));
  expect(reply).toBe("You need about 86% on the final to finish with an A-.");
  expect(calls.length).toBe(2); // one tool round, then the answer
  const toolResult = calls[1].messages.at(-1);
  expect(toolResult.role).toBe("tool");
  expect(toolResult.content).toContain('need 85.8% on "Final Exam"');
  expect(calls[0].messages[0].content).toMatch(/call grade_calc once, relay its numbers; never compute grades yourself/);
});

test("grade_calc's description sends 'what do I need on the final' straight to it, without a list_courses first", () => {
  const d = gradeTools[0]!.function.description;
  expect(d).toContain("Call it FIRST");
  expect(d).toContain("what's needed (e.g. on the final)");
  expect(d).toContain("finds the course itself, so skip list_courses");
  // the course argument takes the name as said, and that is all it needs
  expect(gradeTools[0]!.function.parameters.required).toEqual(["course"]);
});
