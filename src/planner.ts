import { clean, wallToUtc, type DueItem } from "./assignments.ts";
import { classBusy } from "./classes.ts";
import { busyBetween, fmtAt, fmtCompact, stagePlan, type PlanBlock } from "./calendar.ts";
import { dueItems } from "./canvas.ts";
import { requireContext } from "./context.ts";

// The study planner. Finding gaps and placing blocks is plain code; the model only relays the plan.

export const DAY_START_HOUR = 9;
export const DAY_END_HOUR = 22;
export const MIN_GAP_MIN = 60;
export const MAX_BLOCK_MIN = 120;
export const MAX_BLOCKS = 8;
const BEFORE_DEADLINE_MIN = 15; // a block ends at least this long before the thing is due
const LEAD_MIN = 30; // never schedule right now: start at least this far ahead
const MIN = 60_000;

export type Busy = { start: Date; end: Date };
export type Gap = { start: Date; end: Date };
export type Task = { name: string; course: string; due: Date };
export type Block = Task & { start: Date; end: Date };

const ceilQuarter = (d: Date) => new Date(Math.ceil(d.getTime() / (15 * MIN)) * 15 * MIN);

/** Free stretches of at least an hour inside [dayStart, dayEnd), after `notBefore`, skipping busy time. */
export function freeGaps(busy: Busy[], dayStart: Date, dayEnd: Date, notBefore: Date): Gap[] {
  const from = ceilQuarter(new Date(Math.max(dayStart.getTime(), notBefore.getTime())));
  if (from >= dayEnd) return [];
  const spans = busy
    .filter((b) => b.end > from && b.start < dayEnd)
    .map((b) => ({ s: Math.max(b.start.getTime(), from.getTime()), e: Math.min(b.end.getTime(), dayEnd.getTime()) }))
    .sort((a, b) => a.s - b.s);
  const gaps: Gap[] = [];
  let cursor = from.getTime();
  for (const sp of spans) {
    if (sp.s > cursor) gaps.push({ start: new Date(cursor), end: new Date(sp.s) });
    cursor = Math.max(cursor, sp.e); // overlapping and back-to-back events merge
  }
  if (cursor < dayEnd.getTime()) gaps.push({ start: new Date(cursor), end: dayEnd });
  return gaps
    .map((g) => ({ start: ceilQuarter(g.start), end: g.end }))
    .filter((g) => g.end.getTime() - g.start.getTime() >= MIN_GAP_MIN * MIN);
}

const ymd = (d: Date, tz: string) => d.toLocaleDateString("en-CA", { timeZone: tz });

/** The next `n` local days starting today, as [y, m, d] (plain calendar arithmetic, so DST can't skip or repeat a day). */
function localDays(now: Date, tz: string, n: number): [number, number, number][] {
  const [y, m, d] = ymd(now, tz).split("-").map(Number) as [number, number, number];
  return Array.from({ length: n }, (_, i) => {
    const t = new Date(Date.UTC(y, m - 1, d + i));
    return [t.getUTCFullYear(), t.getUTCMonth() + 1, t.getUTCDate()];
  });
}

/**
 * One block of up to 2 hours per assignment, nearest deadline first. A block goes on the day before the deadline when it can
 * (then earlier days, and the due day itself last), always ends before the deadline, and never overlaps a busy time or another block.
 */
export function placeBlocks(tasks: Task[], busy: Busy[], now: Date, tz: string, horizonDays = 7): { blocks: Block[]; unplaced: Task[] } {
  const notBefore = new Date(now.getTime() + LEAD_MIN * MIN);
  const days = localDays(now, tz, horizonDays).map(([y, m, d]) => ({
    key: `${y}-${String(m).padStart(2, "0")}-${String(d).padStart(2, "0")}`,
    gaps: freeGaps(busy, wallToUtc(y, m, d, DAY_START_HOUR, 0, tz), wallToUtc(y, m, d, DAY_END_HOUR, 0, tz), notBefore),
  }));
  const blocks: Block[] = [], unplaced: Task[] = [];
  const sorted = [...tasks].sort((a, b) => a.due.getTime() - b.due.getTime());
  for (const [i, task] of sorted.entries()) {
    if (i >= MAX_BLOCKS) {
      unplaced.push(task);
      continue;
    }
    const dueKey = ymd(task.due, tz);
    let di = days.findIndex((d) => d.key === dueKey);
    if (di < 0) di = days.length - 1;
    const order = [...Array.from({ length: di }, (_, k) => di - 1 - k), di];
    const cutoff = task.due.getTime() - BEFORE_DEADLINE_MIN * MIN;
    let placed = false;
    for (const idx of order) {
      for (const gap of days[idx]!.gaps) {
        const end = Math.min(gap.end.getTime(), cutoff);
        const len = end - gap.start.getTime();
        if (len < MIN_GAP_MIN * MIN) continue;
        const block = { ...task, start: new Date(gap.start), end: new Date(gap.start.getTime() + Math.min(MAX_BLOCK_MIN * MIN, len)) };
        blocks.push(block);
        gap.start = block.end; // what is left of the gap stays available
        placed = true;
        break;
      }
      if (placed) break;
    }
    if (!placed) unplaced.push(task);
  }
  return { blocks, unplaced };
}

const titleFor = (t: Task) => `Study: ${clean(t.name)}`.slice(0, 80);

/** The text the user sees. Blocks are numbered in time order, and PlanBlock[i] is item i+1. */
export function formatPlan(blocks: Block[], unplaced: Task[]): { text: string; planBlocks: PlanBlock[] } {
  const ordered = [...blocks].sort((a, b) => a.start.getTime() - b.start.getTime());
  const lines = ["Study plan for the next 7 days:"];
  ordered.forEach((b, i) => lines.push(`${i + 1}) ${fmtCompact(b.start, b.end)} ${titleFor(b)} (due ${fmtAt(b.due)})`));
  if (unplaced.length) lines.push(`No free hour before the deadline: ${unplaced.map((t) => `${t.course} ${clean(t.name)}`).join("; ")}.`);
  lines.push('Reply "all", "1,3" or "none". I add nothing until you do.');
  return { text: lines.join("\n"), planBlocks: ordered.map((b) => ({ title: titleFor(b), start: b.start, end: b.end })) };
}

/** Strict match for a plain "plan my week" request (answered by code, no LLM). */
export function parsePlanQuery(text: string): boolean {
  const t = text.toLowerCase().replace(/[’‘]/g, "'").replace(/\s+/g, " ").trim().replace(/[?!.\s]+$/, "");
  return /^(?:please )?(?:plan (?:my|the) (?:study )?(?:week|studying|time)|(?:make|build|create) (?:me )?a (?:study )?plan|study plan|schedule my study time)(?: please)?$/.test(t);
}

/** Look at what's due and when the owner is free, stage a plan, and return its text. Nothing is created yet. */
export async function planWeek(key: string, now = new Date()): Promise<{ staged: boolean; text: string }> {
  const tz = requireContext().timezone;
  const until = new Date(now.getTime() + 7 * 86400_000);
  const [{ items }, calBusy] = await Promise.all([dueItems(now, until), busyBetween(now, new Date(until.getTime() + 86400_000))]);
  const busy = [...calBusy, ...classBusy(key, now, new Date(until.getTime() + 86400_000), tz)];
  if (!items.length) return { staged: false, text: "Nothing is due in the next 7 days, so there's nothing to plan. Enjoy it." };
  const tasks: Task[] = items.map((i: DueItem) => ({ name: i.name, course: i.course, due: new Date(i.due) }));
  const { blocks, unplaced } = placeBlocks(tasks, busy, now, tz);
  if (!blocks.length) {
    return { staged: false, text: `I couldn't find a free hour between ${DAY_START_HOUR}am and ${DAY_END_HOUR - 12}pm before any deadline: ${unplaced.map((t) => `${t.course} ${clean(t.name)}`).join("; ")}.` };
  }
  const { text, planBlocks } = formatPlan(blocks, unplaced);
  stagePlan(key, planBlocks);
  return { staged: true, text };
}

export const plannerTools = [
  {
    type: "function" as const,
    function: { name: "plan_week", description: "Stage study blocks for work due in the next 7 days; the user picks which to add.", parameters: { type: "object", properties: {} } },
  },
];

export async function runPlannerTool(key: string): Promise<string> {
  try {
    const r = await planWeek(key);
    return r.staged ? `STAGED, nothing is added yet. Send this plan to the user exactly as written, nothing else:\n${r.text}` : r.text;
  } catch (e) {
    return `Error: ${e instanceof Error ? e.message : String(e)}`;
  }
}
