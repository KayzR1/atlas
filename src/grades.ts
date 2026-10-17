import { courseLabel } from "./assignments.ts";
import { fetchAssignmentGroupsRaw, fetchCourseRaw, fetchGradingStandardsRaw, listCourses } from "./canvas.ts";

// All grade math lives here, in plain code. The model only phrases the text this module returns.

export type GAssignment = { id: number; name: string; points: number; score: number | null; excused: boolean; omit: boolean };
export type GGroup = {
  id: number; name: string; weight: number;
  dropLowest: number; dropHighest: number; neverDrop: number[];
  assignments: GAssignment[];
};
export type ScaleEntry = { name: string; min: number };
export type GCourse = { name: string; weighted: boolean; groups: GGroup[]; scale: ScaleEntry[]; scaleSource: string; canvasScore: number | null; canvasGrade: string | null };

/** Canvas's built-in scale, used only when the course's own can't be read. */
export const DEFAULT_SCALE: ScaleEntry[] = [
  { name: "A", min: 94 }, { name: "A-", min: 90 }, { name: "B+", min: 87 }, { name: "B", min: 84 }, { name: "B-", min: 80 },
  { name: "C+", min: 77 }, { name: "C", min: 74 }, { name: "C-", min: 70 }, { name: "D+", min: 67 }, { name: "D", min: 64 }, { name: "D-", min: 61 }, { name: "F", min: 0 },
];

// ---------- Canvas JSON -> model ----------

export function normalizeGroups(raw: any[]): GGroup[] {
  return raw.map((g) => ({
    id: Number(g.id),
    name: String(g.name ?? "").replace(/\s+/g, " ").trim(),
    weight: Number(g.group_weight ?? 0) || 0,
    dropLowest: Number(g.rules?.drop_lowest ?? 0) || 0,
    dropHighest: Number(g.rules?.drop_highest ?? 0) || 0,
    neverDrop: (g.rules?.never_drop ?? []).map(Number),
    assignments: (g.assignments ?? []).map((a: any) => ({
      id: Number(a.id),
      name: String(a.name ?? "").replace(/\s+/g, " ").trim(),
      points: Number(a.points_possible ?? 0) || 0,
      score: typeof a.submission?.score === "number" ? a.submission.score : null,
      excused: !!a.submission?.excused,
      omit: !!a.omit_from_final_grade || a.grading_type === "not_graded",
    })),
  }));
}

export function normalizeScale(standard: any): ScaleEntry[] {
  return (standard?.grading_scheme ?? [])
    .map((e: any) => ({ name: String(e.name), min: Number(e.calculated_value ?? Number(e.value) * 100) }))
    .sort((a: ScaleEntry, b: ScaleEntry) => b.min - a.min);
}

export const letterFor = (pct: number, scale: ScaleEntry[]) => scale.find((e) => pct + 1e-9 >= e.min)?.name ?? null;

// ---------- the calculation ----------

type Item = { id: number; points: number; score: number };

/** What-if overrides: a percent for specific assignments, and a percent for groups that have no assignments yet. */
export type Scenario = { assignmentPct: Map<number, number>; virtualGroupPct: Map<number, number> };
const emptyScenario = (): Scenario => ({ assignmentPct: new Map(), virtualGroupPct: new Map() });

export const isRemaining = (a: GAssignment) => !a.omit && !a.excused && a.score === null && a.points > 0;

function itemsOf(g: GGroup, sc: Scenario): Item[] {
  const out: Item[] = [];
  for (const a of g.assignments) {
    if (a.omit || a.excused) continue;
    const forced = sc.assignmentPct.get(a.id);
    const score = forced !== undefined ? (forced / 100) * a.points : a.score;
    if (score === null) continue; // not graded yet: Canvas leaves it out of the current grade
    if (a.points <= 0 && score <= 0) continue;
    out.push({ id: a.id, points: a.points, score });
  }
  return out;
}

const ratio = (i: { points: number; score: number }) => (i.points > 0 ? i.score / i.points : i.score > 0 ? Infinity : 0);

/** Every k-subset of idx (capped so a huge group can't blow up). */
function* combos(n: number, k: number): Generator<number[]> {
  const cur: number[] = [];
  function* rec(start: number): Generator<number[]> {
    if (cur.length === k) return yield [...cur];
    for (let i = start; i < n; i++) {
      cur.push(i);
      yield* rec(i + 1);
      cur.pop();
    }
  }
  yield* rec(0);
}
const binom = (n: number, k: number) => {
  let r = 1;
  for (let i = 1; i <= k; i++) r = (r * (n - k + i)) / i;
  return r;
};

/**
 * Apply a group's drop rules the way Canvas does: drop_lowest drops the set that gives the group its best grade
 * (this matters when assignments are worth different points), never_drop items are protected, and at least one item is kept.
 */
export function applyDrops(g: Pick<GGroup, "dropLowest" | "dropHighest" | "neverDrop">, items: Item[]): { earned: number; possible: number; dropped: number[] } {
  let kept = [...items];
  const dropped: number[] = [];
  const protectedIds = new Set(g.neverDrop);
  const low = Math.min(g.dropLowest, Math.max(0, kept.length - 1));
  const candidates = kept.filter((i) => !protectedIds.has(i.id));
  const k = Math.min(low, candidates.length);
  if (k > 0) {
    let best: number[] | null = null;
    if (binom(candidates.length, k) <= 20_000) {
      let bestRatio = -1;
      const totE = kept.reduce((s, i) => s + i.score, 0), totP = kept.reduce((s, i) => s + i.points, 0);
      for (const c of combos(candidates.length, k)) {
        const e = totE - c.reduce((s, ix) => s + candidates[ix]!.score, 0);
        const p = totP - c.reduce((s, ix) => s + candidates[ix]!.points, 0);
        const r = p > 0 ? e / p : e > 0 ? Infinity : 0;
        if (r > bestRatio + 1e-12) {
          bestRatio = r;
          best = c;
        }
      }
    }
    const drop = best ? best.map((ix) => candidates[ix]!) : [...candidates].sort((a, b) => ratio(a) - ratio(b)).slice(0, k);
    for (const d of drop) dropped.push(d.id);
    kept = kept.filter((i) => !dropped.includes(i.id));
  }
  const high = Math.min(g.dropHighest, Math.max(0, kept.length - 1));
  if (high > 0) {
    const hi = kept.filter((i) => !protectedIds.has(i.id)).sort((a, b) => ratio(b) - ratio(a)).slice(0, high);
    for (const d of hi) dropped.push(d.id);
    kept = kept.filter((i) => !dropped.includes(i.id));
  }
  return { earned: kept.reduce((s, i) => s + i.score, 0), possible: kept.reduce((s, i) => s + i.points, 0), dropped };
}

export type GroupRow = { group: GGroup; pct: number | null; earned: number; possible: number; dropped: number[]; virtual: boolean };

export function computeGrade(course: Pick<GCourse, "weighted" | "groups">, sc: Scenario = emptyScenario()): { percent: number | null; rows: GroupRow[]; totalWeight: number } {
  const rows: GroupRow[] = course.groups.map((group) => {
    const items = itemsOf(group, sc);
    const virtual = sc.virtualGroupPct.get(group.id);
    if (items.length === 0) {
      if (virtual !== undefined && course.weighted) return { group, pct: virtual, earned: virtual, possible: 100, dropped: [], virtual: true };
      return { group, pct: null, earned: 0, possible: 0, dropped: [], virtual: false };
    }
    const r = applyDrops(group, items);
    return { group, pct: r.possible > 0 ? (r.earned / r.possible) * 100 : null, earned: r.earned, possible: r.possible, dropped: r.dropped, virtual: false };
  });
  if (!course.weighted) {
    // points-based course: total earned / total possible over everything that counts
    const earned = rows.reduce((s, r) => s + r.earned, 0), possible = rows.reduce((s, r) => s + r.possible, 0);
    return { percent: possible > 0 ? (earned / possible) * 100 : null, rows, totalWeight: 0 };
  }
  // weighted: only groups that have grades count, and their weights are rescaled to 100% (Canvas's "current grade" rule)
  const used = rows.filter((r) => r.pct !== null && r.group.weight > 0);
  const totalWeight = used.reduce((s, r) => s + r.group.weight, 0);
  if (totalWeight <= 0) return { percent: null, rows, totalWeight: 0 };
  return { percent: used.reduce((s, r) => s + r.group.weight * r.pct!, 0) / totalWeight, rows, totalWeight };
}

// ---------- solving "what do I need" ----------

export type Target = { kind: "assignment"; group: GGroup; assignment: GAssignment } | { kind: "group"; group: GGroup } | { kind: "remaining" };

/** The scenario where the unknown work scores x%, and (optionally) every other remaining item scores `rest`%. */
export function buildScenario(course: Pick<GCourse, "groups">, target: Target, x: number, rest: number | null): Scenario {
  const sc = emptyScenario();
  const targetIds = new Set<number>(), targetGroups = new Set<number>();
  if (target.kind === "assignment") targetIds.add(target.assignment.id);
  else if (target.kind === "group") {
    const remaining = target.group.assignments.filter(isRemaining);
    if (remaining.length) remaining.forEach((a) => targetIds.add(a.id));
    else if (!target.group.assignments.some((a) => !a.omit && !a.excused)) targetGroups.add(target.group.id); // an empty group: the group itself is the unknown
  } else {
    for (const g of course.groups) {
      g.assignments.filter(isRemaining).forEach((a) => targetIds.add(a.id));
      if (g.weight > 0 && !g.assignments.some((a) => !a.omit && !a.excused)) targetGroups.add(g.id);
    }
  }
  for (const g of course.groups) {
    for (const a of g.assignments.filter(isRemaining)) {
      if (targetIds.has(a.id)) sc.assignmentPct.set(a.id, x);
      else if (rest !== null) sc.assignmentPct.set(a.id, rest);
    }
    if (g.weight > 0 && !g.assignments.some((a) => !a.omit && !a.excused)) {
      if (targetGroups.has(g.id)) sc.virtualGroupPct.set(g.id, x);
      else if (rest !== null) sc.virtualGroupPct.set(g.id, rest);
    }
  }
  return sc;
}

export type Solution =
  | { verdict: "guaranteed"; at0: number; at100: number }
  | { verdict: "impossible"; at0: number; at100: number }
  | { verdict: "need"; need: number; at0: number; at100: number }
  | { verdict: "no_effect"; at0: number; at100: number }
  | { verdict: "no_data" };

/** Smallest x in [0,100] with grade(x) >= target. The grade never falls as x rises, so this is a simple search. */
export function solve(course: Pick<GCourse, "weighted" | "groups">, target: Target, goal: number, rest: number | null): Solution {
  const f = (x: number) => computeGrade(course, buildScenario(course, target, x, rest)).percent;
  const at0 = f(0), at100 = f(100);
  if (at0 === null || at100 === null) return { verdict: "no_data" };
  if (Math.abs(at100 - at0) < 1e-9) return { verdict: "no_effect", at0, at100 };
  if (at0 >= goal - 1e-9) return { verdict: "guaranteed", at0, at100 };
  if (at100 < goal - 1e-9) return { verdict: "impossible", at0, at100 };
  let lo = 0, hi = 100;
  for (let i = 0; i < 60; i++) {
    const mid = (lo + hi) / 2;
    if ((f(mid) ?? -1) >= goal) hi = mid;
    else lo = mid;
  }
  let need = Math.ceil(hi * 10 - 1e-9) / 10; // round UP to a tenth so the answer is never optimistic
  while (need < 100 && (f(need) ?? -1) < goal - 1e-9) need = Math.round((need + 0.1) * 10) / 10;
  return { verdict: "need", need: Math.min(100, need), at0, at100 };
}

// ---------- parsing what the user asked for ----------

export function parseGoal(text: string, scale: ScaleEntry[]): { pct: number; label: string } | null {
  const t = text.trim().replace(/^(?:an?|the)\s+/i, "").replace(/[−–]/g, "-");
  const letter = t.match(/^([A-Fa-f])\s*([+-]?)$/);
  if (letter) {
    const name = letter[1]!.toUpperCase() + letter[2];
    const e = scale.find((x) => x.name.toUpperCase() === name);
    return e ? { pct: e.min, label: `${e.name} (${e.min}%+)` } : null;
  }
  const num = t.match(/^(\d+(?:\.\d+)?)\s*%?$/);
  if (num) {
    let n = parseFloat(num[1]!);
    if (n <= 1.5 && num[1]!.includes(".") && !t.includes("%")) n *= 100; // "0.9" means 90%
    return n > 0 && n <= 200 ? { pct: n, label: `${n}%` } : null;
  }
  return null;
}

const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, "");

export type Resolved = { ok: true; target: Target; description: string } | { ok: false; message: string };

/** Turn the model's loose "assignment"/"group" text into a concrete target, or say what's ambiguous. */
export function resolveTarget(course: Pick<GCourse, "groups">, assignment?: string, group?: string): Resolved {
  const pickGroup = (text: string): Resolved | GGroup | null => {
    const n = norm(text);
    const hits = course.groups.filter((g) => norm(g.name).includes(n) || (n.length > 2 && norm(g.name).length > 2 && n.includes(norm(g.name))));
    if (hits.length <= 1) return hits[0] ?? null;
    // several matches: take the clearly best one (exact name, then name starting with the text), else ask
    const score = (g: GGroup) => (norm(g.name) === n ? 3 : norm(g.name).startsWith(n) ? 2 : 1);
    const top = Math.max(...hits.map(score));
    const best = hits.filter((g) => score(g) === top);
    if (best.length === 1) return best[0]!;
    return { ok: false, message: `More than one group matches "${text}": ${hits.map((g) => g.name).join("; ")}. Ask the user which.` };
  };
  const describeGroup = (g: GGroup) => `${g.name} (${g.weight}% of the course${g.assignments.length ? "" : ", nothing graded or posted yet"})`;

  if (assignment) {
    const n = norm(assignment);
    const all = course.groups.flatMap((g) => g.assignments.map((a) => ({ g, a })));
    let hits = all.filter(({ a }) => String(a.id) === assignment.trim() || norm(a.name) === n);
    if (!hits.length) hits = all.filter(({ a }) => norm(a.name).includes(n));
    if (hits.length === 1) {
      const { g, a } = hits[0]!;
      if (a.omit) return { ok: false, message: `"${a.name}" is not counted toward the final grade.` };
      if (a.score !== null) return { ok: false, message: `"${a.name}" is already graded (${a.score}/${a.points}).` };
      return { ok: true, target: { kind: "assignment", group: g, assignment: a }, description: `"${a.name}" (${a.points} pts, in ${describeGroup(g)})` };
    }
    if (hits.length > 1) {
      const open = hits.filter(({ a }) => isRemaining(a));
      if (open.length === 1) return { ok: true, target: { kind: "assignment", group: open[0]!.g, assignment: open[0]!.a }, description: `"${open[0]!.a.name}" (${open[0]!.a.points} pts, in ${describeGroup(open[0]!.g)})` };
      return { ok: false, message: `More than one assignment matches "${assignment}": ${hits.slice(0, 6).map(({ a }) => a.name).join("; ")}. Ask the user which.` };
    }
    const g = pickGroup(assignment); // e.g. "the final" when the final is a group, not yet an assignment
    if (g && "id" in g) return { ok: true, target: { kind: "group", group: g }, description: describeGroup(g) };
    if (g) return g;
    return { ok: false, message: `No assignment or group matches "${assignment}". Groups: ${course.groups.filter((x) => x.weight > 0).map((x) => x.name).join("; ")}.` };
  }
  if (group) {
    const g = pickGroup(group);
    if (g && "id" in g) {
      const remaining = g.assignments.some(isRemaining), empty = !g.assignments.some((a) => !a.omit && !a.excused);
      if (!remaining && !empty) return { ok: false, message: `Everything in "${g.name}" is already graded, so there is nothing left to score there.` };
      return { ok: true, target: { kind: "group", group: g }, description: describeGroup(g) };
    }
    return g ?? { ok: false, message: `No group matches "${group}". Groups: ${course.groups.filter((x) => x.weight > 0).map((x) => x.name).join("; ")}.` };
  }
  // nothing named: if there is exactly one unfinished "final", that's it; otherwise everything that is still ungraded
  const unfinished = (g: GGroup) => g.weight > 0 && (g.assignments.some(isRemaining) || !g.assignments.some((a) => !a.omit && !a.excused));
  const finals = course.groups.filter((g) => /final/i.test(g.name) && unfinished(g));
  const exams = finals.filter((g) => /final\s*exam/i.test(g.name) || /^final$/i.test(g.name.trim()));
  if (exams.length === 1) return { ok: true, target: { kind: "group", group: exams[0]! }, description: describeGroup(exams[0]!) };
  if (finals.length === 1) return { ok: true, target: { kind: "group", group: finals[0]! }, description: describeGroup(finals[0]!) };
  return { ok: true, target: { kind: "remaining" }, description: "all remaining ungraded work (each scoring the same percent)" };
}

// ---------- the report ----------

const f1 = (n: number) => (Math.round(n * 10) / 10).toFixed(1);
const f2 = (n: number) => (Math.round(n * 100) / 100).toFixed(2);

function otherRemaining(course: Pick<GCourse, "groups">, target: Target): string[] {
  const names: string[] = [];
  const skipGroup = target.kind === "group" ? target.group.id : null;
  for (const g of course.groups) {
    if (g.weight <= 0 && course.groups.some((x) => x.weight > 0)) continue;
    if (g.id === skipGroup || target.kind === "remaining") continue;
    const empty = !g.assignments.some((a) => !a.omit && !a.excused);
    const open = g.assignments.filter(isRemaining).filter((a) => !(target.kind === "assignment" && target.assignment.id === a.id));
    if (empty) names.push(`${g.name} (${g.weight}%)`);
    else if (open.length) names.push(`${open.length} ungraded in ${g.name}`);
  }
  return names;
}

function solutionLine(label: string, s: Solution, goal: { pct: number; label: string }, unknown: string, points?: number): string {
  switch (s.verdict) {
    case "guaranteed":
      return `${label}: ALREADY GUARANTEED. Even 0% on ${unknown} leaves you at ${f1(s.at0)}% (goal ${goal.label}).`;
    case "impossible":
      return `${label}: IMPOSSIBLE. Even 100% on ${unknown} only reaches ${f1(s.at100)}% (goal ${goal.label}).`;
    case "need":
      return `${label}: need ${f1(s.need)}% on ${unknown}${points ? ` (${f1((s.need / 100) * points)} of ${points} pts)` : ""}. At 0% you'd have ${f1(s.at0)}%, at 100% ${f1(s.at100)}%.`;
    case "no_effect":
      return `${label}: ${unknown} would not change your grade (it has no weight or no effect).`;
    default:
      return `${label}: not enough graded work to calculate.`;
  }
}

export type GradeArgs = { course: string; target?: string; assignment?: string; group?: string; assume_rest_percent?: number };

/** Pure part of the report (testable without Canvas). */
export function buildReport(course: GCourse, label: string, args: Omit<GradeArgs, "course">): string {
  const cur = computeGrade(course);
  const lines: string[] = [];
  if (cur.percent === null) return `${label}: no graded work counts yet, so there is no current grade to calculate.`;
  const letter = letterFor(cur.percent, course.scale);
  const match = course.canvasScore === null ? "" : Math.abs(course.canvasScore - cur.percent) <= 0.06 ? `, matches Canvas's ${f2(course.canvasScore)}%` : `; Canvas shows ${f2(course.canvasScore)}%${course.canvasGrade ? ` (${course.canvasGrade})` : ""} so treat this as approximate`;
  lines.push(`${label}: current ${f2(cur.percent)}%${letter ? ` (${letter})` : ""}${match}.`);

  if (course.weighted) {
    const used = cur.rows.filter((r) => r.pct !== null && r.group.weight > 0);
    lines.push(`By group (weight: your %): ${used.map((r) => `${r.group.name} ${r.group.weight}%: ${f1(r.pct!)}%${r.dropped.length ? ` (drops lowest ${r.dropped.length})` : ""}`).join(" | ")}.`);
    const waiting = cur.rows.filter((r) => r.pct === null && r.group.weight > 0).map((r) => `${r.group.name} ${r.group.weight}%`);
    if (waiting.length) lines.push(`Not graded yet, so not counted: ${waiting.join(", ")}.`);
    const sum = course.groups.reduce((s, g) => s + g.weight, 0);
    if (Math.abs(sum - 100) > 0.01) lines.push(`Note: the course's group weights add up to ${sum}%, not 100%; Canvas rescales the groups that have grades.`);
  } else {
    lines.push("This course is points-based (no group weights): total points earned over total points possible.");
  }

  if (!args.target) return lines.join("\n");
  const goal = parseGoal(args.target, course.scale);
  if (!goal) return [...lines, `Couldn't read the goal "${args.target}". Letters on this scale: ${course.scale.map((e) => e.name).join(", ")}; or a percent like 90.`].join("\n");
  lines.push(`Goal: ${goal.label}. Scale used: ${course.scaleSource}.`);

  const res = resolveTarget(course, args.assignment, args.group);
  if (!res.ok) return [...lines, res.message].join("\n");
  const unknown = res.target.kind === "assignment" ? `"${res.target.assignment.name}"` : res.target.kind === "group" ? `"${res.target.group.name}"` : "all remaining work";
  lines.push(`Solving for: ${res.description}.`);
  const points = res.target.kind === "assignment" ? res.target.assignment.points : undefined;

  const a = solve(course, res.target, goal.pct, null);
  lines.push(solutionLine("If nothing else gets graded (Canvas's rule: only graded groups count)", a, goal, unknown, points));
  const others = otherRemaining(course, res.target);
  if (others.length && cur.percent !== null) {
    const rest = args.assume_rest_percent ?? cur.percent;
    const b = solve(course, res.target, goal.pct, rest);
    lines.push(solutionLine(`If the other ungraded work (${others.join(", ")}) also scores ${f1(rest)}%`, b, goal, unknown, points));
  }
  return lines.join("\n");
}

export function matchCourse(text: string, courses: Awaited<ReturnType<typeof listCourses>>) {
  const n = norm(text);
  const exactId = courses.filter((c) => String(c.id) === text.trim());
  if (exactId.length) return exactId;
  return courses.filter((c) => norm(courseLabel(c)) === n || norm(c.code ?? "").startsWith(n) || norm(c.name).includes(n) || norm(courseLabel(c)).includes(n));
}

export async function gradeReport(args: GradeArgs): Promise<string> {
  const courses = await listCourses();
  const hits = matchCourse(args.course, courses);
  if (hits.length === 0) return `No active course matches "${args.course}". Courses: ${courses.map((c) => courseLabel(c)).join("; ")}.`;
  if (hits.length > 1) return `More than one course matches "${args.course}": ${hits.map((c) => `${courseLabel(c)} (${c.name})`).join("; ")}. Ask which.`;
  const c = hits[0]!;
  const [info, raw, standards] = await Promise.all([
    fetchCourseRaw(c.id),
    fetchAssignmentGroupsRaw(c.id),
    fetchGradingStandardsRaw(c.id).catch(() => null),
  ]);
  const std = standards?.find((s: any) => s.id === info.grading_standard_id);
  const scale = std ? normalizeScale(std) : [];
  const course: GCourse = {
    name: c.name,
    weighted: !!info.apply_assignment_group_weights,
    groups: normalizeGroups(raw),
    scale: scale.length ? scale : DEFAULT_SCALE,
    scaleSource: scale.length ? `the course's "${std.title}" scale` : "Canvas's default scale (this course's own scale couldn't be read, so letter cutoffs are assumed)",
    canvasScore: c.current_score,
    canvasGrade: c.current_grade,
  };
  return buildReport(course, courseLabel(c), args);
}

// ---------- the tool the model sees ----------

export const gradeTools = [
  {
    type: "function" as const,
    function: {
      name: "grade_calc",
      description: "Grade math in code: the weighted grade, or what's needed (e.g. on the final) to reach a goal. Call it FIRST with the course name as the student says it; it finds the course itself, so skip list_courses.",
      parameters: {
        type: "object",
        properties: {
          course: { type: "string" },
          target: { type: ["string", "null"] },
          assignment: { type: ["string", "null"] },
          group: { type: ["string", "null"] },
          assume_rest_percent: { type: ["number", "null"] },
        },
        required: ["course"],
      },
    },
  },
];

export async function runGradeTool(rawArgs: any): Promise<string> {
  try {
    const a = rawArgs ?? {};
    const text = (v: unknown) => (typeof v === "string" && v.trim() ? v.trim() : undefined);
    const rest = typeof a.assume_rest_percent === "number" && Number.isFinite(a.assume_rest_percent) ? a.assume_rest_percent : undefined;
    if (!text(a.course) && typeof a.course !== "number") return "Error: course is required (e.g. \"ECON 210\")";
    return await gradeReport({ course: String(a.course).trim(), target: text(a.target), assignment: text(a.assignment), group: text(a.group), assume_rest_percent: rest });
  } catch (e) {
    return `Error: ${e instanceof Error ? e.message : String(e)}`;
  }
}
