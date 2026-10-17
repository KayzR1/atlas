import type { RawAssignment } from "./canvas.ts";

/** "DATA101.001/003.FA26" -> "DATA 101"; names without a course code are used as-is. */
export function courseLabel(c?: { name: string; code?: string }): string {
  if (!c) return "Course";
  const m = (c.code ?? "").match(/^([A-Za-z]{2,5})\s?(\d{2,4}[A-Za-z]?)/);
  return m ? `${m[1]!.toUpperCase()} ${m[2]}` : c.name;
}

export const clean = (s: string) => s.replace(/\s+/g, " ").trim();

const NON_SUBMITTABLE = new Set(["none", "not_graded", "on_paper", ""]);

/** Due, not submitted, not graded/excused, and actually submittable in Canvas. */
export function isOpen(a: RawAssignment): boolean {
  if (!a.due_at) return false;
  const s = a.submission;
  if (!s || s.submitted_at || s.excused || s.score != null) return false;
  if (s.workflow_state && s.workflow_state !== "unsubmitted") return false;
  return !a.submission_types.every((t) => NON_SUBMITTABLE.has(t));
}

// ---- time in the user's timezone ----

function offsetMs(utcMs: number, tz: string): number {
  const p = Object.fromEntries(
    new Intl.DateTimeFormat("en-US", { timeZone: tz, hourCycle: "h23", year: "numeric", month: "numeric", day: "numeric", hour: "numeric", minute: "numeric", second: "numeric" })
      .formatToParts(new Date(utcMs)).map((x) => [x.type, x.value]),
  );
  return Date.UTC(+p.year!, +p.month! - 1, +p.day!, +p.hour!, +p.minute!, +p.second!) - Math.floor(utcMs / 1000) * 1000;
}

/** Wall-clock time in `tz` as a UTC Date (month is 1-12). */
export function wallToUtc(y: number, mo: number, d: number, h: number, mi: number, tz: string): Date {
  const wall = Date.UTC(y, mo - 1, d, h, mi, 0);
  let utc = wall - offsetMs(wall, tz);
  utc = wall - offsetMs(utc, tz);
  return new Date(utc);
}

const ymd = (d: Date, tz: string) => d.toLocaleDateString("en-CA", { timeZone: tz }).split("-").map(Number) as [number, number, number];

/** The last instant of the local day that is `plusDays` after d's local day. */
export function endOfLocalDay(d: Date, tz: string, plusDays = 0): Date {
  const [y, m, day] = ymd(d, tz);
  return new Date(wallToUtc(y, m, day + plusDays + 1, 0, 0, tz).getTime() - 1);
}

// ---- "what's due" ----

/** 0 = Sunday ... 6 = Saturday, in the user's timezone. */
export const localDow = (d: Date, tz: string) => new Date(d.toLocaleDateString("en-US", { timeZone: tz })).getDay();

export type DueScope = "week" | "7d" | "today" | "tomorrow";

export function dueWindow(scope: DueScope, now: Date, tz: string): { from: Date; until: Date; header: string; empty: string } {
  if (scope === "today") return { from: now, until: endOfLocalDay(now, tz), header: "Due today:", empty: "Nothing due today." };
  if (scope === "tomorrow") return { from: now, until: endOfLocalDay(now, tz, 1), header: "Due through tomorrow:", empty: "Nothing due through tomorrow." };
  if (scope === "week") {
    const dow = localDow(now, tz);
    return { from: now, until: endOfLocalDay(now, tz, (7 - dow) % 7), header: "Due through Sunday:", empty: "Nothing due through Sunday." };
  }
  return { from: now, until: new Date(now.getTime() + 7 * 86400_000), header: "Due in the next 7 days:", empty: "Nothing due in the next 7 days." };
}

/**
 * Strict match for plain "what's due" requests, which are answered by code with no LLM at all.
 * Anything with extra words ("when is my DATA 101 quiz due") is NOT matched and goes to the model.
 */
export function parseDueQuery(text: string): DueScope | null {
  const t = text.toLowerCase().replace(/[’‘]/g, "'").replace(/\s+/g, " ").trim().replace(/[?!.\s]+$/, "");
  const m = t.match(
    /^(?:\/due|(?:(?:what'?s|whats|what is|what do i have|do i have anything|anything)\s+)?due|(?:what'?s|whats|what is)\s+coming up)(?:\s+(this week|this weekend|today|tomorrow|soon))?$/,
  );
  if (!m) return null;
  switch (m[1]) {
    case "this week":
    case "this weekend":
      return "week";
    case "today":
      return "today";
    case "tomorrow":
      return "tomorrow";
    default:
      return "7d";
  }
}

export type DueItem = { due: string; course: string; name: string };

const MAX_DUE_LINES = 15;

function dueStamp(iso: string, tz: string, now: Date): string {
  const d = new Date(iso);
  const part = (o: Intl.DateTimeFormatOptions) => d.toLocaleString("en-US", { timeZone: tz, ...o });
  const far = d.getTime() - now.getTime() >= 6 * 86400_000; // a week out, the weekday alone would be ambiguous
  return [part({ weekday: "short" }), far ? part({ month: "short", day: "numeric" }) : "", part({ hour: "numeric", minute: "2-digit" })].filter(Boolean).join(" ");
}

export function formatDue(items: DueItem[], tz: string, now: Date, header: string, empty: string, note = ""): string {
  if (!items.length) return empty + note;
  const sorted = [...items].sort((a, b) => a.due.localeCompare(b.due));
  const lines = sorted.slice(0, MAX_DUE_LINES).map((i) => `${dueStamp(i.due, tz, now)} - ${i.course}: ${clean(i.name)}`);
  if (sorted.length > MAX_DUE_LINES) lines.push(`+${sorted.length - MAX_DUE_LINES} more`);
  return `${header}\n${lines.join("\n")}${note}`;
}
