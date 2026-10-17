import { beforeEach, expect, test } from "bun:test";
import { buildSystemPrompt } from "../src/agent.ts";
import { parseClassLine, handleClassMessage, resetClassState } from "../src/classes.ts";
import { runWithContext, type UserContext } from "../src/context.ts";
import { ensureOwner, ensureUser, getCredits, getUser, initDb, wipeUser } from "../src/db.ts";
import {
  EXCLUDED, STANDARD_SCALE, UNC_POINTS, cumulativeGpa, gradeKind, gpaTools, handleGpaMessage, parseGpaCommand, parseSyllabusScale, runGpaTool, solveNeed, termGpa,
  type CourseIn, type GpaDeps,
} from "../src/gpa.ts";
import { ALICE, OWNER, addMember, harness } from "./helpers.ts";

const ME = "+15555550100";
const ctx = (key = ME, role: "owner" | "member" = "owner"): UserContext => ({ key, role, timezone: "America/New_York", canvasUrl: "https://x.example", canvasToken: "t" });
const course = (id: number, label: string, grade: string | null, score: number | null): CourseIn => ({ id, label, name: label, grade, score });

let courses: CourseIn[];
let scales: Map<number, any>;
const deps = (): GpaDeps => ({ courses: async () => courses, syllabusScale: async (c) => scales.get(c.id) ?? null });
const say = (text: string, key = ME) => handleGpaMessage(key, text, deps());

beforeEach(() => {
  initDb(":memory:");
  ensureOwner(ME);
  courses = [course(1, "ECON 210", "A-", 91), course(2, "DATA 101", "B+", 88), course(3, "ENGL 150", "A", 96)];
  scales = new Map();
});

const BANNED = [/let me know how you'?d like to proceed/i, /i can'?t compute/i, /can'?t compute/i, /unless you (give|tell|provide)/i];

// ---- scale and excluded grades ----

test("UNC scale", () => {
  expect(UNC_POINTS).toEqual({ A: 4.0, "A-": 3.7, "B+": 3.3, B: 3.0, "B-": 2.7, "C+": 2.3, C: 2.0, "C-": 1.7, "D+": 1.3, D: 1.0, F: 0.0 });
  for (const [l, p] of Object.entries(UNC_POINTS)) expect(gradeKind(l)).toEqual({ kind: "points", letter: l, points: p });
  expect(gradeKind(" b+ ")).toEqual({ kind: "points", letter: "B+", points: 3.3 });
  expect(gradeKind("A+")).toEqual({ kind: "points", letter: "A", points: 4.0 }); // UNC has no A+
  expect(gradeKind("D-")).toEqual({ kind: "points", letter: "D", points: 1.0 }); // nor D-
  expect(gradeKind("92.5%").kind).toBe("unknown");
  expect(gradeKind(null).kind).toBe("unknown");
});

test("PS, W, LP, SP, BE, PL, IN, AB are excluded", () => {
  expect([...EXCLUDED].sort()).toEqual(["AB", "BE", "IN", "LP", "PL", "PS", "SP", "W"]);
  for (const g of EXCLUDED) expect(gradeKind(g)).toEqual({ kind: "excluded", code: g });
});

test("an excluded grade is left out of the GPA and named", async () => {
  courses = [course(1, "ECON 210", "A", 95), course(2, "DATA 101", "PS", null), course(3, "ENGL 150", "W", null)];
  const r = (await say("my gpa"))!;
  expect(r.split("\n")[0]).toBe("Projected term GPA: 4.00");
  expect(r).toContain("DATA 101 (PS isn't part of the GPA)");
  expect(r).toContain("ENGL 150 (W isn't part of the GPA)");
  expect(r).not.toMatch(/ECON 210 \(/);
});

// ---- term GPA, credits ----

test("term GPA is credit-weighted; defaults to 3 credits and says so", async () => {
  const r = (await say("my gpa"))!;
  expect(r.split("\n")[0]).toBe("Projected term GPA: 3.67"); // (3.7 + 3.3 + 4.0) / 3
  expect(r.split("\n")[1]).toBe("(assuming 3 credits each; text 'ECON 210 is 4 credits' to fix; text '/gpa set 3.52 45' to add your cumulative GPA and hours)");
  expect(r).toContain("ECON 210 A- 3cr · DATA 101 B+ 3cr · ENGL 150 A 3cr");
});

test("'ECON 210 is 4 credits' and '/credits ECON 210 4' update it, per user", async () => {
  expect(await say("ECON 210 is 4 credits")).toBe("Okay, ECON 210 counts as 4 credits.");
  const r = (await say("/gpa"))!;
  expect(r.split("\n")[0]).toBe("Projected term GPA: 3.67"); // (14.8 + 9.9 + 12) / 10 = 3.67
  expect(r).toContain("ECON 210 A- 4cr");
  expect(r).toContain("assuming 3 credits for DATA 101, ENGL 150");
  expect(await say("/credits data 101 4.5")).toBe("Okay, DATA 101 counts as 4.5 credits.");
  expect(await say("/credits ECON 210 0")).toContain("1 to 6");
  expect(await say("/credits stuff 3")).toContain("Which course");
  ensureUser("+15555550101");
  expect(getCredits("+15555550101").size).toBe(0);
  expect(getCredits(ME).get("ECON 210")).toBe(4);
});

test("no assumption line once credits are all set and a cumulative is saved", async () => {
  for (const c of ["ECON 210", "DATA 101", "ENGL 150"]) await say(`/credits ${c} 3`);
  await say("/gpa set 3.5 30");
  const r = (await say("my gpa"))!;
  expect(r.split("\n")).toHaveLength(3); // GPA, cumulative, breakdown
  expect(r).toContain("Projected cumulative: 3.54 (was 3.50 over 30 hours)"); // (105 + 33) / 39 = 3.538
});

test("letters: Canvas, then syllabus scale, then an assumed standard scale (marked)", async () => {
  courses = [course(1, "ECON 210", "A-", 91), course(2, "DATA 101", null, 88), course(3, "ENGL 150", null, 88)];
  scales.set(3, [{ name: "A", min: 94 }, { name: "A-", min: 91 }, { name: "B+", min: 89 }, { name: "B", min: 85 }, { name: "F", min: 0 }]);
  const r = (await say("my gpa"))!;
  expect(r).toContain("DATA 101 B+ 3cr (assumed scale)"); // standard: 87+ is B+
  expect(r).toContain("ENGL 150 B 3cr"); // its own syllabus scale: 88 is a B
  expect(r).not.toContain("ENGL 150 B 3cr (assumed");
  expect(r).toContain("assumed scale for DATA 101");
  expect(r.split("\n")[0]).toBe("Projected term GPA: 3.33"); // (3.7 + 3.3 + 3.0) / 3
  expect(STANDARD_SCALE.map((e) => e.min)).toEqual([93, 90, 87, 83, 80, 77, 73, 70, 67, 63, 60, 0]);
});

test("a course with no grade yet is left out; no graded courses at all says so without a question", async () => {
  courses = [course(1, "ECON 210", "A", 95), course(2, "DATA 101", null, null)];
  expect(await say("my gpa")).toContain("not counted: DATA 101 (no grade yet)");
  courses = [course(1, "ECON 210", null, null)];
  const r = (await say("my gpa"))!;
  expect(r).toContain("No graded courses yet");
  for (const b of BANNED) expect(r).not.toMatch(b);
});

// ---- cumulative ----

test("cumulative math and the one-time hint", async () => {
  expect(cumulativeGpa({ gpa: 3.52, hours: 45 }, [{ points: 3.7, credits: 4 }, { points: 3.3, credits: 3 }, { points: 4, credits: 3 }])).toBeCloseTo((3.52 * 45 + 36.7) / 55, 9);
  expect(termGpa([])).toBeNull();
  const first = (await say("my gpa"))!;
  expect(first).toContain("/gpa set 3.52 45");
  expect((await say("my gpa"))!).not.toContain("/gpa set"); // mentioned once, never asked
  expect(await say("/gpa set 3.52 45")).toBe('Saved: 3.52 over 45 hours. "my gpa" now includes your projected cumulative.');
  const r = (await say("my gpa"))!;
  expect(r).toContain("Projected term GPA: 3.67");
  expect(r).toContain("Projected cumulative: 3.54 (was 3.52 over 45 hours)"); // (158.4 + 33) / 54
});

test("'my GPA is 3.52 with 45 hours' saves it; bad values do not", async () => {
  expect(await say("my GPA is 3.52 with 45 hours")).toContain("Saved: 3.52 over 45 hours");
  expect(getUser(ME)?.prior_gpa).toBe(3.52);
  expect(getUser(ME)?.prior_hours).toBe(45);
  expect(await say("/gpa set 4.7 45")).toContain("0.0 to 4.0");
  expect(await say("/gpa set 3.5")).toContain("/gpa set 3.52 45");
  expect(getUser(ME)?.prior_gpa).toBe(3.52);
});

// ---- what-ifs ----

test("what if I get a B in ECON", async () => {
  for (const c of ["ECON 210", "DATA 101", "ENGL 150"]) await say(`/credits ${c} 3`);
  await say("/gpa set 3.5 30");
  const r = (await say("what if I get a B in ECON?"))!;
  expect(r.split("\n")[0]).toBe("GPA with a B in ECON 210: 3.43 (3.67 now)"); // (3.0 + 3.3 + 4.0) / 3
  expect(r).toContain("Cumulative: 3.48 (was 3.50 over 30 hours)"); // (105 + 30.9) / 39 = 3.485
});

test("what-ifs: several courses, an A, a course with no grade yet, errors", async () => {
  courses = [course(1, "ECON 210", "A-", 91), course(2, "DATA 101", "B+", 88), course(3, "STAT 100", null, null)];
  expect((await say("what if I get an A in data and a B in stat 100"))!.split("\n")[0]).toBe("GPA with an A in DATA 101 and a B in STAT 100: 3.57 (3.50 now)"); // (3.7+4+3)/3
  expect(await say("what if I get a C in math")).toContain(`I don't see "math"`);
  courses.push(course(4, "ECON 345", "B", 85));
  expect(await say("what if I get an A in econ")).toContain("matches ECON 210 and ECON 345");
  expect(await say("what if I get a B in ECON 345")).toContain("GPA with a B in ECON 345");
  courses[0] = course(1, "ECON 210", "W", null);
  expect(await say("what if I get a B in ECON 210")).toContain("left out of the GPA");
});

// ---- the solver ----

test("solveNeed: a letter, impossible, guaranteed, exact boundaries", () => {
  const others = [{ label: "D", letter: "B+", points: 3.3, credits: 3, creditsDefault: true, source: "canvas" as const }, { label: "E", letter: "A", points: 4, credits: 3, creditsDefault: true, source: "canvas" as const }];
  expect(solveNeed(others, 3, 3.5)).toEqual({ kind: "letter", letter: "B+", points: 3.3, need: expect.closeTo(3.2, 9) as any });
  expect((solveNeed(others, 3, 3.4) as any).letter).toBe("B"); // need 2.9
  expect((solveNeed(others, 3, 3.6333333333333333) as any).letter).toBe("A-"); // need exactly 3.5: A- is the first letter at or above it
  expect((solveNeed(others, 3, 3.6) as any).letter).toBe("A-");
  const imp = solveNeed(others, 3, 3.9);
  expect(imp.kind).toBe("impossible");
  expect((imp as any).gpaAtA).toBeCloseTo(3.7667, 3);
  const ok = solveNeed(others, 3, 2.0);
  expect(ok.kind).toBe("guaranteed");
  expect((ok as any).gpaAtF).toBeCloseTo(2.4333, 3);
  // with a prior GPA: (3.5*30 + 21.9 + 3p) / 39 >= 3.5 -> p >= 3.2... plus the prior weighs more
  const withPrior = solveNeed(others, 3, 3.5, { gpa: 3.5, hours: 30 }) as any;
  expect(withPrior.need).toBeCloseTo((3.5 * 39 - 105 - 21.9) / 3, 9);
});

test("'what do I need in ECON to keep a 3.5'", async () => {
  const r = (await say("What do I need in ECON to keep a 3.5?"))!;
  expect(r.split("\n")[0]).toBe("To keep a 3.5 term GPA you need a B+ or better in ECON 210 (3.3 points).");
  expect(r.split("\n")[1]).toContain("assuming 3 credits each");
  expect((await say("what do I need in econ 210 to keep a 3.9"))!).toContain("Not possible: even an A in ECON 210 gives a term GPA of 3.77, under 3.9.");
  expect((await say("what do I need in econ 210 to get a 2.0"))!).toContain("Already guaranteed: even an F in ECON 210 leaves your term GPA at 2.43, above 2.0.");
  await say("/gpa set 3.5 30");
  expect(await say("what do I need in ECON to hit a 3.5")).toContain("3.5 cumulative GPA");
  expect(await say("what do I need in zzz to keep a 3.5")).toContain(`I don't see "zzz"`);
  expect(await say("what do I need in ECON to keep a 5.0")).toContain("between 0.0 and 4.0");
});

test("a course with no grade yet can still be solved for", async () => {
  courses = [course(1, "DATA 101", "B+", 88), course(2, "ENGL 150", "A", 96), course(3, "MATH 110", null, null)];
  expect(await say("what do I need in math 110 to keep a 3.5")).toContain("a B+ or better in MATH 110");
});

// ---- never ask, never "can't compute" ----

test("no reply ever contains the banned phrasing", async () => {
  courses = [course(1, "ECON 210", null, 91), course(2, "DATA 101", null, 70), course(3, "ENGL 150", "PS", null), course(4, "ADV", null, null)];
  const asks = ["my gpa", "/gpa", "what's my gpa", "what if I get a B in ECON", "what if I get a D in data", "what do I need in ECON to keep a 3.5", "what do I need in DATA to keep a 4.0", "what do I need in ENGL to keep a 3.0",
    "/gpa set 3.5", "/credits foo", "ECON 210 is 99 credits"];
  for (const q of asks) {
    const r = (await say(q)) ?? "";
    expect(r.length).toBeGreaterThan(0);
    for (const b of BANNED) expect(r).not.toMatch(b);
    expect(r.trim().endsWith("?")).toBe(false);
  }
  const prompt = runWithContext(ctx(), () => buildSystemPrompt(ME));
  expect(prompt).toContain("Never say you can't compute something when a reasonable assumption exists");
  expect(prompt).toContain("answer first, then one short line naming the assumption");
  expect(prompt).toContain("never end with \"let me know how you'd like to proceed\"");
  expect(prompt).not.toContain("gpa_calc"); // the tool and its line only ride along for GPA questions
  expect(runWithContext(ctx(), () => buildSystemPrompt(ME, { gpa: true }))).toContain("gpa_calc");
});

test("failures reach the user honestly, not as a question", async () => {
  const broken: GpaDeps = { courses: async () => { throw new Error("canvas 500"); }, syllabusScale: async () => null };
  expect(await handleGpaMessage(ME, "my gpa", broken)).toBe("I couldn't reach Canvas just now. Try again in a bit.");
});

// ---- parsing ----

test("command parsing is strict", () => {
  expect(parseGpaCommand("my gpa")?.kind).toBe("show");
  expect(parseGpaCommand("What's my GPA?")?.kind).toBe("show");
  expect(parseGpaCommand("/gpa")?.kind).toBe("show");
  expect(parseGpaCommand("gpa")?.kind).toBe("show");
  expect(parseGpaCommand("projected gpa")?.kind).toBe("show");
  expect(parseGpaCommand("how do I raise my gpa and study")).toBeNull();
  expect(parseGpaCommand("my gpa is bad")).toBeNull();
  expect(parseGpaCommand("what's due")).toBeNull();
  expect(parseGpaCommand("what if I get a B in ECON")).toEqual({ kind: "whatif", picks: [{ letter: "B", course: "econ" }] });
  expect(parseGpaCommand("what if I got an A- in econ 210 and a b+ in data 101")).toEqual({ kind: "whatif", picks: [{ letter: "A-", course: "econ 210" }, { letter: "B+", course: "data 101" }] });
  expect(parseGpaCommand("what if I get a in econ")).toEqual({ kind: "whatif", picks: [{ letter: "A", course: "econ" }] });
  expect(parseGpaCommand("what if I get sick")).toBeNull();
  expect(parseGpaCommand("/credits ECON 210 4")).toEqual({ kind: "credits", course: "econ 210", credits: 4 });
});

test("syllabus scale parsing", () => {
  const text = "Grading scale: A 93-100, A- 90-92, B+ 87-89, B 83-86, B- 80-82, C+ 77-79, C 73-76, C- 70-72, D+ 67-69, D 60-66, F below 60";
  const s = parseSyllabusScale(text)!;
  expect(s.map((e) => `${e.name}${e.min}`)).toEqual(["A93", "A-90", "B+87", "B83", "B-80", "C+77", "C73", "C-70", "D+67", "D60", "F0"]);
  const rev = parseSyllabusScale("100-94 = A\n93-90 = A-\n89-87 = B+\n86-83 = B\n82-80 = B-\n79-77 = C+\n76-73 = C")!;
  expect(rev[0]).toEqual({ name: "A", min: 94 });
  expect(parseSyllabusScale("A 93-100, B 83-86")).toBeNull();
  expect(parseSyllabusScale("Participation 10-20 points, A 95")).toBeNull();
  expect(parseSyllabusScale("A 60-100, A- 90-92, B+ 87-89, B 83-86, B- 80-82, C+ 77-79")).toBeNull(); // out of order
});

// ---- the model tool ----

test("gpa_calc runs the same code (and is small)", async () => {
  expect(gpaTools[0]!.function.name).toBe("gpa_calc");
  expect(JSON.stringify(gpaTools).length).toBeLessThan(1200);
  const r = await runWithContext(ctx(), () => runGpaTool({ whatif: [{ course: "econ", letter: "B" }] }, deps()));
  expect(r.split("\n")[0]).toBe("GPA with a B in ECON 210: 3.43 (3.67 now)");
  expect(await runWithContext(ctx(), () => runGpaTool({}, deps()))).toContain("Projected term GPA: 3.67");
  expect(await runWithContext(ctx(), () => runGpaTool({ credits: { course: "ECON 210", credits: 4 } }, deps()))).toBe("Okay, ECON 210 counts as 4 credits.");
});

// ---- credit hours from a pasted schedule ----

test("units from a ConnectCarolina-style paste are stored", async () => {
  expect(parseClassLine("ECON 210 TTh 11-12:15 Gardner 305 4.00")).toMatchObject({ course: "ECON 210", location: "Gardner 305", units: 4 });
  expect(parseClassLine("DATA 101 MWF 9:05-9:55 Sterling 120 (3 units)")).toMatchObject({ location: "Sterling 120", units: 3 });
  expect(parseClassLine("ENGL 150 W 2:00-3:15 3 credits")?.units).toBe(3);
  expect(parseClassLine("ENGL 150 W 2:00-3:15 Room 4.5")?.units).toBeUndefined();
  expect(parseClassLine("ENGL 150 W 2:00-3:15")?.units).toBeUndefined();
  resetClassState();
  const say2 = (t: string) => runWithContext(ctx(), () => handleClassMessage(ME, t, { now: () => new Date("2026-10-19T12:30:00Z") }));
  const rb = (await say2("my classes\nECON 210 TTh 11-12:15 Gardner 305 4.00\nDATA 101 MWF 9:05-9:55 3 units"))!;
  expect(rb).toContain("Gardner 305  4 units");
  expect(getCredits(ME).size).toBe(0); // nothing stored until yes
  await say2("yes");
  expect(getCredits(ME).get("ECON 210")).toBe(4);
  expect(getCredits(ME).get("DATA 101")).toBe(3);
  const r = (await say("my gpa"))!;
  expect(r).toContain("ECON 210 A- 4cr");
  expect(r).not.toContain("assuming 3 credits each");
});

// ---- the message pipeline: zero tokens, members too ----

test("'my gpa' is answered with no LLM call, for the owner and for members", async () => {
  const h = await harness();
  h.deps.gpa = (key, text) => handleGpaMessage(key, text, deps());
  await h.say("my gpa");
  expect(h.lastTo(OWNER)).toContain("Projected term GPA: 3.67");
  await addMember(ALICE);
  await h.say("/gpa", ALICE);
  expect(h.lastTo(ALICE)).toContain("Projected term GPA: 3.67");
  await h.say("ECON 210 is 4 credits", ALICE);
  expect(h.lastTo(ALICE)).toBe("Okay, ECON 210 counts as 4 credits.");
  expect(getCredits(ALICE).get("ECON 210")).toBe(4);
  expect(getCredits(OWNER).size).toBe(0); // per user
  expect(h.agentCalls()).toBe(0);
  await h.say("hello there");
  expect(h.agentCalls()).toBe(1);
});

test("wipeUser clears credits and the saved GPA", async () => {
  await say("/credits ECON 210 4");
  await say("/gpa set 3.5 30");
  wipeUser(ME, "removed");
  expect(getCredits(ME).size).toBe(0);
  expect(getUser(ME)?.prior_gpa).toBeNull();
  expect(getUser(ME)?.gpa_hint_shown).toBe(0);
});
