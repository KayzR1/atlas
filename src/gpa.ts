import { courseLabel } from "./assignments.ts";
import { listCourses } from "./canvas.ts";
import { requireContext } from "./context.ts";
import { getCredits, getUser, markGpaHintShown, setCredits, setPriorGpa } from "./db.ts";
import { letterFor, type ScaleEntry } from "./grades.ts";
import { courseChunks } from "./syllabus.ts";

// UNC GPA. Every number here is computed in code; the model only relays the text.

export const UNC_POINTS: Record<string, number> = { A: 4.0, "A-": 3.7, "B+": 3.3, B: 3.0, "B-": 2.7, "C+": 2.3, C: 2.0, "C-": 1.7, "D+": 1.3, D: 1.0, F: 0.0 };
/** Grades that are not part of the GPA. */
export const EXCLUDED = new Set(["PS", "W", "LP", "SP", "BE", "PL", "IN", "AB"]);
export const DEFAULT_CREDITS = 3;
/** The usual 93/90/87/83/80/77/73/70/67/63/60 cutoffs, used when neither Canvas nor the syllabus gives a scale. */
export const STANDARD_SCALE: ScaleEntry[] = [
  { name: "A", min: 93 }, { name: "A-", min: 90 }, { name: "B+", min: 87 }, { name: "B", min: 83 }, { name: "B-", min: 80 }, { name: "C+", min: 77 },
  { name: "C", min: 73 }, { name: "C-", min: 70 }, { name: "D+", min: 67 }, { name: "D", min: 63 }, { name: "D", min: 60 }, { name: "F", min: 0 },
];
const LETTERS_ASC = ["F", "D", "D+", "C-", "C", "C+", "B-", "B", "B+", "A-", "A"];

export type GradeKind = { kind: "points"; letter: string; points: number } | { kind: "excluded"; code: string } | { kind: "unknown" };

/** A letter as Canvas or a person writes it. UNC has no A+ or D-, so those count as A and D. */
export function gradeKind(raw: string | null | undefined): GradeKind {
  const g = String(raw ?? "").trim().toUpperCase().replace(/\s+/g, "");
  if (EXCLUDED.has(g)) return { kind: "excluded", code: g };
  const letter = g === "A+" ? "A" : g === "D-" ? "D" : g;
  return letter in UNC_POINTS ? { kind: "points", letter, points: UNC_POINTS[letter]! } : { kind: "unknown" };
}

// ---------- reading a grading scale out of a syllabus ----------

/** "A 93-100", "A- 90-92", "93-100 = A", "B+: 87%": needs at least six letters in a consistent order, or nothing. */
export function parseSyllabusScale(text: string): ScaleEntry[] | null {
  const found = new Map<string, number>();
  const L = "([A-D][+-]?|F)";
  const N = "(\\d{2,3}(?:\\.\\d+)?)";
  const put = (letter: string, min: number) => {
    const l = letter.toUpperCase();
    if (l in UNC_POINTS && min >= 0 && min <= 100) found.set(l, Math.min(found.get(l) ?? 101, min));
  };
  const sp = "[ \\t]*"; // never across a line break
  for (const m of text.matchAll(new RegExp(`\\b${L}${sp}[:=\\-–]?${sp}${N}${sp}%?${sp}(?:-|–|to)${sp}${N}`, "g"))) put(m[1]!, Math.min(Number(m[2]), Number(m[3])));
  for (const m of text.matchAll(new RegExp(`${N}${sp}%?${sp}(?:-|–|to)${sp}${N}${sp}%?${sp}[:=\\-–]?${sp}${L}(?![A-Za-z0-9+-])`, "g"))) put(m[3]!, Math.min(Number(m[1]), Number(m[2])));
  for (const m of text.matchAll(new RegExp(`\\b${L}${sp}[:=]${sp}(?:≥|>=)?${sp}${N}${sp}%`, "g"))) put(m[1]!, Number(m[2]));
  if (found.size < 6 || !found.has("A")) return null;
  const entries = LETTERS_ASC.filter((l) => found.has(l) || l === "F").reverse().map((l) => ({ name: l, min: l === "F" ? 0 : found.get(l)! }));
  for (let i = 1; i < entries.length; i++) if (entries[i]!.min > entries[i - 1]!.min) return null; // out of order: not a real scale
  return entries;
}

// ---------- the numbers ----------

export type CourseIn = { id: number; label: string; name: string; score: number | null; grade: string | null };
export type GpaDeps = {
  courses(): Promise<CourseIn[]>;
  /** The course's own grading scale from its syllabus, if it has one. */
  syllabusScale(course: CourseIn): Promise<ScaleEntry[] | null>;
};

export type Line = { label: string; letter: string; points: number; credits: number; creditsDefault: boolean; source: "canvas" | "syllabus" | "assumed" };
export type Skipped = { label: string; why: "no grade yet" | "not counted"; detail: string; credits: number; creditsDefault: boolean };
export type Snapshot = { lines: Line[]; skipped: Skipped[] };

export async function snapshot(key: string, deps: GpaDeps): Promise<Snapshot> {
  const courses = await deps.courses();
  const credits = getCredits(key);
  const out: Snapshot = { lines: [], skipped: [] };
  for (const c of courses) {
    const cr = credits.get(c.label) ?? DEFAULT_CREDITS, creditsDefault = !credits.has(c.label);
    const skip = (why: Skipped["why"], detail: string) => out.skipped.push({ label: c.label, why, detail, credits: cr, creditsDefault });
    const g = gradeKind(c.grade);
    if (g.kind === "excluded") {
      skip("not counted", `${g.code} isn't part of the GPA`);
      continue;
    }
    if (g.kind === "points") {
      out.lines.push({ label: c.label, letter: g.letter, points: g.points, credits: cr, creditsDefault, source: "canvas" });
      continue;
    }
    if (c.score === null) {
      skip("no grade yet", "no grade yet");
      continue;
    }
    // no usable letter from Canvas: the syllabus scale if it has one, else the standard one (marked as assumed)
    let scale: ScaleEntry[] | null = null;
    try {
      scale = await deps.syllabusScale(c);
    } catch {
      scale = null;
    }
    const letter = letterFor(c.score, scale ?? STANDARD_SCALE) ?? "F";
    const k = gradeKind(letter);
    if (k.kind !== "points") {
      skip("not counted", `couldn't read the grade ${letter}`);
      continue;
    }
    out.lines.push({ label: c.label, letter: k.letter, points: k.points, credits: cr, creditsDefault, source: scale ? "syllabus" : "assumed" });
  }
  return out;
}

const sumCredits = (ls: { credits: number }[]) => ls.reduce((a, l) => a + l.credits, 0);
const sumPoints = (ls: { points: number; credits: number }[]) => ls.reduce((a, l) => a + l.points * l.credits, 0);
export const termGpa = (ls: { points: number; credits: number }[]): number | null => (sumCredits(ls) > 0 ? sumPoints(ls) / sumCredits(ls) : null);

export function cumulativeGpa(prior: { gpa: number; hours: number }, ls: { points: number; credits: number }[]): number | null {
  const hours = prior.hours + sumCredits(ls);
  return hours > 0 ? (prior.gpa * prior.hours + sumPoints(ls)) / hours : null;
}

const f2 = (n: number) => (Math.round(n * 100) / 100).toFixed(2);
const fCr = (n: number) => String(Math.round(n * 100) / 100);

// ---------- what-ifs and goals ----------

export type NeedResult =
  | { kind: "guaranteed"; gpaAtF: number }
  | { kind: "impossible"; gpaAtA: number }
  | { kind: "letter"; letter: string; points: number; need: number };

/** The lowest letter in `course` that brings the GPA to `goal`, given everything else. `base` = prior work counted in the GPA. */
export function solveNeed(others: Line[], credits: number, goal: number, prior?: { gpa: number; hours: number }): NeedResult {
  const ph = prior?.hours ?? 0, pp = (prior?.gpa ?? 0) * ph;
  const total = ph + sumCredits(others) + credits;
  const base = pp + sumPoints(others);
  const gpaWith = (p: number) => (base + p * credits) / total;
  const need = (goal * total - base) / credits;
  if (need <= 1e-9) return { kind: "guaranteed", gpaAtF: gpaWith(0) };
  if (need > 4 + 1e-9) return { kind: "impossible", gpaAtA: gpaWith(4) };
  const letter = LETTERS_ASC.find((l) => UNC_POINTS[l]! >= need - 1e-9)!;
  return { kind: "letter", letter, points: UNC_POINTS[letter]!, need };
}

// ---------- phrasing (code writes the whole reply) ----------

const article = (letter: string) => (/^[AF]/.test(letter) ? "an" : "a");

/** The one short line naming what was assumed and how to change it. */
function assumptionLine(key: string, counted: { label: string; creditsDefault: boolean; source?: Line["source"] }[], hasPrior: boolean): string {
  const parts: string[] = [];
  const defaulted = counted.filter((c) => c.creditsDefault);
  if (defaulted.length) {
    parts.push(defaulted.length === counted.length ? `assuming ${DEFAULT_CREDITS} credits each` : `assuming ${DEFAULT_CREDITS} credits for ${defaulted.map((c) => c.label).join(", ")}`);
    parts.push(`text '${defaulted[0]!.label} is 4 credits' to fix`);
  }
  const assumed = counted.filter((c) => c.source === "assumed");
  if (assumed.length) parts.push(`assumed scale for ${assumed.map((c) => c.label).join(", ")}`);
  if (!hasPrior && getUser(key)?.gpa_hint_shown === 0) {
    parts.push("text '/gpa set 3.52 45' to add your cumulative GPA and hours");
    markGpaHintShown(key);
  }
  return parts.length ? `(${parts.join("; ")})` : "";
}

const NO_GRADES = "No graded courses yet, so there's no GPA to project. It will show up as soon as Canvas has a grade.";

function priorOf(key: string): { gpa: number; hours: number } | undefined {
  const u = getUser(key);
  return u && u.prior_gpa !== null && u.prior_hours !== null ? { gpa: u.prior_gpa, hours: u.prior_hours } : undefined;
}

function breakdown(snap: Snapshot): string {
  const bits = snap.lines.map((l) => `${l.label} ${l.letter} ${fCr(l.credits)}cr${l.source === "assumed" ? " (assumed scale)" : ""}`);
  const skipped = snap.skipped.map((s) => `${s.label} (${s.detail})`);
  return bits.join(" · ") + (skipped.length ? `${bits.length ? " · " : ""}not counted: ${skipped.join(", ")}` : "");
}

export async function gpaReport(key: string, deps: GpaDeps): Promise<string> {
  const snap = await snapshot(key, deps);
  const gpa = termGpa(snap.lines);
  if (gpa === null) return NO_GRADES;
  const prior = priorOf(key);
  const cum = prior ? cumulativeGpa(prior, snap.lines) : null;
  const lines = [`Projected term GPA: ${f2(gpa)}`];
  if (prior && cum !== null) lines.push(`Projected cumulative: ${f2(cum)} (was ${f2(prior.gpa)} over ${fCr(prior.hours)} hours)`);
  const a = assumptionLine(key, snap.lines, !!prior);
  if (a) lines.push(a);
  lines.push(breakdown(snap));
  return lines.join("\n");
}

export type Resolved = { ok: true; label: string } | { ok: false; message: string };

/** "econ", "ECON 210", "econ210" -> one of the user's courses (counted or waiting for a grade). */
export function resolveCourse(text: string, snap: Snapshot): Resolved {
  const all = [...snap.lines.map((l) => l.label), ...snap.skipped.map((s) => s.label)];
  const n = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, "");
  const q = n(text);
  if (!q) return { ok: false, message: `Which course? Yours: ${all.join(", ")}.` };
  const exact = all.filter((l) => n(l) === q);
  const hits = exact.length ? exact : all.filter((l) => n(l).startsWith(q) || n(l).includes(q));
  if (hits.length === 1) return { ok: true, label: hits[0]! };
  if (!hits.length) return { ok: false, message: `I don't see "${text.trim()}" in your courses. Yours: ${all.join(", ")}.` };
  return { ok: false, message: `"${text.trim()}" matches ${hits.join(" and ")}. Say which one, like "${hits[0]}".` };
}

function withLetter(snap: Snapshot, label: string, letter: string): { lines: Line[]; err?: string } {
  const k = gradeKind(letter);
  if (k.kind !== "points") return { lines: snap.lines, err: `${letter.toUpperCase()} isn't a letter that counts in the GPA. UNC's are A, A-, B+, B, B-, C+, C, C-, D+, D, F.` };
  const existing = snap.lines.find((l) => l.label === label);
  const skipped = snap.skipped.find((s) => s.label === label);
  if (skipped && skipped.why === "not counted") return { lines: snap.lines, err: `${label} has ${skipped.detail}, so it's left out of the GPA.` };
  const replaced: Line = { label, letter: k.letter, points: k.points, credits: existing?.credits ?? skipped?.credits ?? DEFAULT_CREDITS, creditsDefault: existing?.creditsDefault ?? skipped?.creditsDefault ?? true, source: "canvas" };
  return { lines: existing ? snap.lines.map((l) => (l.label === label ? replaced : l)) : [...snap.lines, replaced] };
}

export async function whatIfReport(key: string, deps: GpaDeps, picks: { course: string; letter: string }[]): Promise<string> {
  const snap = await snapshot(key, deps);
  const base = termGpa(snap.lines);
  let lines = snap.lines;
  const named: string[] = [];
  for (const p of picks) {
    const r = resolveCourse(p.course, snap);
    if (!r.ok) return r.message;
    const w = withLetter({ lines, skipped: snap.skipped }, r.label, p.letter);
    if (w.err) return w.err;
    lines = w.lines;
    const k = gradeKind(p.letter) as Extract<GradeKind, { kind: "points" }>;
    named.push(`${article(k.letter)} ${k.letter} in ${r.label}`);
  }
  const gpa = termGpa(lines);
  if (gpa === null) return NO_GRADES;
  const prior = priorOf(key);
  const out = [`GPA with ${named.join(" and ")}: ${f2(gpa)}${base !== null ? ` (${f2(base)} now)` : ""}`];
  if (prior) out.push(`Cumulative: ${f2(cumulativeGpa(prior, lines)!)} (was ${f2(prior.gpa)} over ${fCr(prior.hours)} hours)`);
  const a = assumptionLine(key, lines, !!prior);
  if (a) out.push(a);
  return out.join("\n");
}

export async function needReport(key: string, deps: GpaDeps, courseText: string, goal: number): Promise<string> {
  if (!(goal > 0 && goal <= 4)) return "A GPA goal is between 0.0 and 4.0, like 3.5.";
  const snap = await snapshot(key, deps);
  const r = resolveCourse(courseText, snap);
  if (!r.ok) return r.message;
  const target = snap.lines.find((l) => l.label === r.label) ?? snap.skipped.find((s) => s.label === r.label)!;
  if ("why" in target && target.why === "not counted") return `${r.label} has ${target.detail}, so it's left out of the GPA.`;
  const others = snap.lines.filter((l) => l.label !== r.label);
  const prior = priorOf(key);
  const basis = prior ? "cumulative" : "term";
  const res = solveNeed(others, target.credits, goal, prior);
  const g = f2(goal).replace(/0$/, "");
  const lines: string[] = [];
  if (res.kind === "letter") lines.push(`To keep a ${g} ${basis} GPA you need ${article(res.letter)} ${res.letter} or better in ${r.label} (${res.points.toFixed(1)} points).`);
  else if (res.kind === "guaranteed") lines.push(`Already guaranteed: even an F in ${r.label} leaves your ${basis} GPA at ${f2(res.gpaAtF)}, above ${g}.`);
  else lines.push(`Not possible: even an A in ${r.label} gives a ${basis} GPA of ${f2(res.gpaAtA)}, under ${g}.`);
  const counted = [...others, { label: r.label, creditsDefault: target.creditsDefault, source: undefined as Line["source"] | undefined }];
  const a = assumptionLine(key, counted, !!prior);
  if (a) lines.push(a);
  return lines.join("\n");
}

// ---------- saving inputs ----------

export function setPrior(key: string, gpa: number, hours: number): string {
  if (!(gpa >= 0 && gpa <= 4) || !(hours > 0 && hours <= 400)) return "Use a GPA from 0.0 to 4.0 and your completed hours, like: /gpa set 3.52 45";
  setPriorGpa(key, gpa, hours);
  return `Saved: ${f2(gpa)} over ${fCr(hours)} hours. "my gpa" now includes your projected cumulative.`;
}

export function setCourseCredits(key: string, courseText: string, credits: number): string {
  const m = courseText.trim().match(/^([A-Za-z]{2,5})\s?(\d{2,3}[A-Za-z]?)$/);
  if (!m) return "Which course? For example: /credits ECON 210 4";
  if (!(credits > 0 && credits <= 8)) return "Credits are usually 1 to 6, like: /credits ECON 210 4";
  const label = `${m[1]!.toUpperCase()} ${m[2]!.toUpperCase()}`;
  setCredits(key, label, credits);
  return `Okay, ${label} counts as ${fCr(credits)} credits.`;
}

// ---------- plain-text entry points (zero tokens) ----------

const norm = (t: string) => t.toLowerCase().replace(/[’‘]/g, "'").replace(/\s+/g, " ").trim().replace(/[?!.\s]+$/, "");
const NUM = "(\\d(?:\\.\\d+)?)";
const SHOW = /^(?:\/gpa|(?:what(?:'s| is|s)? )?(?:my )?(?:projected |current |term |semester )?gpa(?: (?:right now|now|this semester|this term))?)$/;
const SET1 = new RegExp(`^/gpa set ${NUM}\\s+(\\d+(?:\\.\\d+)?)$`);
const SET2 = new RegExp(`^my (?:cumulative |overall )?gpa is ${NUM}\\s*(?:with|over|and|,)?\\s*(?:i have |i've got |i've completed |i have completed )?(\\d+(?:\\.\\d+)?)\\s*(?:credit )?(?:hours|credits|units)$`);
const CREDITS1 = /^\/credits\s+(.+?)\s+(\d+(?:\.\d+)?)$/;
const CREDITS2 = /^([a-z]{2,5} ?\d{2,3}[a-z]?) (?:is|are|has|have|=|counts as|is worth|worth) (\d+(?:\.\d+)?) (?:credits?|units?|credit hours?|hours?|hrs?)$/;
const WHATIF = /^(?:what if|what happens if|how would|if) i (?:get|got|earn|make|receive|end up with|finish with|ended up with)\b(.*)$/;
const PICK = /(?:an?\s+)?\b([a-f][+-]?)\s+(?:in|for|on)\s+([a-z]{2,5}(?: ?\d{2,3}[a-z]?)?)\b/g;
const NEED = new RegExp(`^(?:what (?:grade )?do i need|what grade would i need|what'?s needed|what must i get) in (.+?) to (?:keep|get|have|reach|hit|stay at|maintain|stay above|make|bring my gpa to)\\s*(?:a |an |at least a |at least |my gpa (?:at|above) )?${NUM}(?: gpa)?$`);

export type GpaCommand =
  | { kind: "show" }
  | { kind: "set"; gpa: number; hours: number }
  | { kind: "setBad" }
  | { kind: "credits"; course: string; credits: number }
  | { kind: "whatif"; picks: { course: string; letter: string }[] }
  | { kind: "need"; course: string; goal: number };

export function parseGpaCommand(text: string): GpaCommand | null {
  const t = norm(text);
  if (SHOW.test(t)) return { kind: "show" };
  const s = t.match(SET1) ?? t.match(SET2);
  if (s) return { kind: "set", gpa: Number(s[1]), hours: Number(s[2]) };
  if (/^\/gpa set\b/.test(t)) return { kind: "setBad" };
  const c = t.match(CREDITS1) ?? t.match(CREDITS2);
  if (c) return { kind: "credits", course: c[1]!, credits: Number(c[2]) };
  if (/^\/credits\b/.test(t)) return { kind: "credits", course: t.slice(8).trim(), credits: NaN }; // usage reply
  const w = t.match(WHATIF);
  if (w) {
    const picks = [...w[1]!.matchAll(PICK)].map((m) => ({ letter: m[1]!.toUpperCase(), course: m[2]!.trim() }));
    if (picks.length) return { kind: "whatif", picks };
  }
  const n = t.match(NEED);
  if (n) return { kind: "need", course: n[1]!, goal: Number(n[2]) };
  return null;
}

export const realDeps: GpaDeps = {
  courses: async () =>
    (await listCourses()).map((c) => ({ id: c.id, label: courseLabel(c), name: c.name, score: c.current_score, grade: c.current_grade })),
  syllabusScale: async (c) => {
    const chunks = await courseChunks(new URL(requireContext().canvasUrl).host, c.id);
    return parseSyllabusScale(chunks.map((x) => x.text).join("\n"));
  },
};

export async function runGpaCommand(key: string, cmd: GpaCommand, deps: GpaDeps): Promise<string> {
  try {
    switch (cmd.kind) {
      case "show": return await gpaReport(key, deps);
      case "set": return setPrior(key, cmd.gpa, cmd.hours);
      case "setBad": return "Use your GPA and completed hours, like: /gpa set 3.52 45";
      case "credits": return setCourseCredits(key, cmd.course, cmd.credits);
      case "whatif": return await whatIfReport(key, deps, cmd.picks);
      case "need": return await needReport(key, deps, cmd.course, cmd.goal);
    }
  } catch (e) {
    console.error("gpa failed:", e instanceof Error ? e.message : e);
    return "I couldn't reach Canvas just now. Try again in a bit.";
  }
}

/** The message handler's zero-token path: null if the text isn't about GPA. */
export async function handleGpaMessage(key: string, text: string, deps: GpaDeps = realDeps): Promise<string | null> {
  const cmd = parseGpaCommand(text);
  return cmd ? runGpaCommand(key, cmd, deps) : null;
}

export const looksGpaRelated = (t: string) => /\b(gpa|grade point|credit hours?|credits?|units?)\b/i.test(t);

// ---------- the tool the model sees (for phrasings the patterns above miss) ----------

export const gpaTools = [
  {
    type: "function" as const,
    function: {
      name: "gpa_calc",
      description: "UNC GPA math in code. Call once and relay the reply as is. No args: projected GPA. whatif: [{course, letter}]. need: {course, goal}. credits: {course, credits}. prior: {gpa, hours}.",
      parameters: {
        type: "object",
        properties: {
          whatif: { type: ["array", "null"], items: { type: "object", properties: { course: { type: "string" }, letter: { type: "string" } }, required: ["course", "letter"] } },
          need: { type: ["object", "null"], properties: { course: { type: "string" }, goal: { type: "number" } } },
          credits: { type: ["object", "null"], properties: { course: { type: "string" }, credits: { type: "number" } } },
          prior: { type: ["object", "null"], properties: { gpa: { type: "number" }, hours: { type: "number" } } },
        },
      },
    },
  },
];

export async function runGpaTool(rawArgs: any, deps: GpaDeps = realDeps): Promise<string> {
  const key = requireContext().key;
  const a = rawArgs ?? {};
  const num = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : Number(v));
  let cmd: GpaCommand = { kind: "show" };
  if (Array.isArray(a.whatif) && a.whatif.length) cmd = { kind: "whatif", picks: a.whatif.map((p: any) => ({ course: String(p?.course ?? ""), letter: String(p?.letter ?? "") })) };
  else if (a.need?.course) cmd = { kind: "need", course: String(a.need.course), goal: num(a.need.goal) };
  else if (a.credits?.course) cmd = { kind: "credits", course: String(a.credits.course), credits: num(a.credits.credits) };
  else if (a.prior) cmd = { kind: "set", gpa: num(a.prior.gpa), hours: num(a.prior.hours) };
  return runGpaCommand(key, cmd, deps);
}
