import { summarizeAnnouncement } from "./agent.ts";
import { clean, courseLabel, endOfLocalDay, formatDue, isOpen, localDow } from "./assignments.ts";
import { botName } from "./brand.ts";
import { maskId, maskText } from "./mask.ts";
import { retryWelcomes, type WelcomeCtx } from "./welcome.ts";
import { classMeetsNote, classesBriefLine, dueClassAlerts } from "./classes.ts";
import { calendarConfigured, dayEvents, rangeEvents } from "./calendar.ts";
import {
  fetchAnnouncementsRaw, fetchAssignmentsRaw, fetchMissingRaw, listCourses,
  type RawAnnouncement, type RawAssignment, type RawMissing,
} from "./canvas.ts";
import { currentContext, runWithContext, type UserContext } from "./context.ts";
import { getUser, hasGradeSnapshot, markNotified, previousGradeSnapshot, saveGradeSnapshot, setUserFlag, wasNotified, type UserRow } from "./db.ts";
import type { Send } from "./outbound.ts";

type Course = Awaited<ReturnType<typeof listCourses>>[number];

export type Deps = {
  now(): Date;
  courses(): Promise<Course[]>;
  assignments(courseId: number): Promise<RawAssignment[]>;
  announcements(courseIds: number[], daysBack: number): Promise<RawAnnouncement[]>;
  missing(): Promise<RawMissing[]>;
  /** Short event lines for a local date, or null if no calendar is configured. */
  events(date: string): Promise<string[] | null>;
  /** Event lines for local dates [from, to] (owner only), or null if there's no calendar for this user. */
  weekEvents?(fromDate: string, toDate: string): Promise<string[] | null>;
  summarize(title: string, body: string): Promise<string>;
};

export const realDeps: Deps = {
  now: () => new Date(),
  courses: listCourses,
  assignments: fetchAssignmentsRaw,
  announcements: fetchAnnouncementsRaw,
  missing: fetchMissingRaw,
  // iCloud is owner-only: members' briefs have no calendar section
  events: async (date) => (calendarConfigured() && currentContext()?.role === "owner" ? dayEvents(date) : null),
  weekEvents: async (from, to) => (calendarConfigured() && currentContext()?.role === "owner" ? rangeEvents(from, to) : null),
  summarize: summarizeAnnouncement,
};

export { courseLabel, isOpen };

export const CHECK_MS = 30 * 60_000;
const MAX_LINES = 12;
const MAX_SUMMARIES = 5;
const MAX_MISSING = 5;
const MISSING_WINDOW_MS = 14 * 24 * 3600_000;
const HOUR = 3600_000;

// ---- formatting helpers ----

const num = (n: number) => String(Math.round(n * 100) / 100);
const localDate = (d: Date, tz: string) => d.toLocaleDateString("en-CA", { timeZone: tz });
const fmtDue = (iso: string, tz: string) =>
  new Date(iso).toLocaleString("en-US", { timeZone: tz, weekday: "short", hour: "numeric", minute: "2-digit" });
const fmtDay = (iso: string, tz: string) => new Date(iso).toLocaleDateString("en-US", { timeZone: tz, month: "short", day: "numeric" });

function localMinutes(d: Date, tz: string): number {
  const p = Object.fromEntries(
    new Intl.DateTimeFormat("en-US", { timeZone: tz, hourCycle: "h23", hour: "numeric", minute: "numeric" }).formatToParts(d).map((x) => [x.type, x.value]),
  );
  return Number(p.hour) * 60 + Number(p.minute);
}

const parseHM = (s: string) => {
  const [h, m] = s.split(":").map(Number);
  return (h ?? 7) * 60 + (m ?? 0);
};

/** "/brief" argument -> "HH:MM" (5:00-11:00 AM), "off", "07:00" for "on", or null. */
export function parseBriefTime(arg: string): string | null {
  const a = arg.trim().toLowerCase();
  if (a === "off" || a === "stop" || a === "none") return "off";
  if (a === "on") return "07:00";
  const m = a.match(/^(\d{1,2})(?::(\d{2}))?\s*(am|a\.m\.)?$/);
  if (!m) return null;
  const h = Number(m[1]), min = Number(m[2] ?? 0);
  if (min > 59 || h < 5 || h > 11 || (h === 11 && min > 0)) return null;
  return `${String(h).padStart(2, "0")}:${String(min).padStart(2, "0")}`;
}

export const fmtBrief = (hm: string) => {
  const [h = 7, m = 0] = hm.split(":").map(Number);
  return `${h}:${String(m).padStart(2, "0")} AM`;
};

/** Brief window: from the chosen time for 3 hours (a bot that was down at 7 still sends it, but not at 3pm). */
export const BRIEF_WINDOW_MIN = 180;

type Item = { line: string; keys: string[] };
type CourseData = { course: Course; assignments: RawAssignment[] };

async function gather(deps: Deps): Promise<CourseData[]> {
  const out: CourseData[] = [];
  for (const course of await deps.courses()) {
    try {
      out.push({ course, assignments: await deps.assignments(course.id) });
    } catch (e) {
      console.error(`could not fetch assignments for course ${course.id}:`, e instanceof Error ? e.message : e);
    }
  }
  return out;
}

// ---- first run: remember what already exists ----

export async function seed(userKey: string, deps: Deps) {
  const data = await gather(deps);
  let grades = 0;
  for (const { assignments } of data)
    for (const a of assignments)
      if (a.submission?.score != null) {
        markNotified(userKey, `grade:${a.id}:${a.submission.score}`);
        grades++;
      }
  const anns = await deps.announcements(data.map((d) => d.course.id), 14);
  for (const a of anns) markNotified(userKey, `ann:${a.id}`);
  const tz = getUser(userKey)?.timezone ?? "America/New_York";
  saveGradeSnapshot(userKey, localDate(deps.now(), tz), gradeRows(data.map((d) => d.course)));
  setUserFlag(userKey, "seeded", true);
  return { grades, announcements: anns.length };
}

// ---- the 30-minute check: grades, announcements, deadline nudges ----

export async function runCheck(userKey: string, deps: Deps, send: Send, opts: { previewAll?: boolean } = {}): Promise<"seeded" | "skipped" | "sent" | "nothing" | "failed"> {
  const user = getUser(userKey);
  if (!user) return "skipped";
  if (!user.seeded && !opts.previewAll) {
    const r = await seed(userKey, deps);
    console.log(`first run: recorded ${r.grades} existing grades and ${r.announcements} announcements as already seen`);
    return "seeded";
  }
  if (user.paused || !user.notify) return "skipped";

  const tz = user.timezone;
  const now = deps.now();
  const data = await gather(deps);
  const labels = new Map(data.map((d) => [d.course.id, courseLabel(d.course)]));
  // an account that predates grade snapshots gets a baseline now, so its first Sunday can already show changes
  if (!hasGradeSnapshot(userKey)) saveGradeSnapshot(userKey, localDate(now, tz), gradeRows(data.map((d) => d.course)));
  const items: Item[] = [];

  // new or changed grades
  for (const { course, assignments } of data)
    for (const a of assignments) {
      const score = a.submission?.score;
      if (score == null) continue;
      const key = `grade:${a.id}:${score}`;
      if (wasNotified(userKey, key)) continue;
      const total = a.points_possible != null ? `/${num(a.points_possible)}` : "";
      const cg = course.current_grade ?? (course.current_score != null ? `${num(course.current_score)}%` : null);
      const cgTxt = cg ? ` (course: ${cg}${course.current_grade && course.current_score != null ? ` ${num(course.current_score)}%` : ""})` : "";
      items.push({ line: `${labels.get(course.id)} ${clean(a.name)} graded: ${num(score)}${total}${cgTxt}`, keys: [key] });
    }

  // deadline nudges: 24h and 3h before anything unsubmitted
  for (const { course, assignments } of data)
    for (const a of assignments) {
      if (!isOpen(a)) continue;
      const remaining = new Date(a.due_at!).getTime() - now.getTime();
      if (remaining <= 0 || remaining > 24 * HOUR) continue;
      const k3 = `nudge3:${a.id}:${a.due_at}`;
      const k24 = `nudge24:${a.id}:${a.due_at}`;
      const inside3 = remaining <= 3 * HOUR;
      if (wasNotified(userKey, inside3 ? k3 : k24)) continue;
      const left = remaining < HOUR ? `${Math.max(1, Math.round(remaining / 60_000))}m` : `${Math.round(remaining / HOUR)}h`;
      items.push({
        line: `Due in ${left} (${fmtDue(a.due_at!, tz)}): ${clean(a.name)} [${labels.get(course.id)}]${classMeetsNote(userKey, labels.get(course.id) ?? "", new Date(a.due_at!), tz)}`,
        keys: inside3 ? [k3, k24] : [k24],
      });
    }

  // new announcements (the only LLM use: one short call each)
  const anns = (await deps.announcements(data.map((d) => d.course.id), 14)).filter((a) => !wasNotified(userKey, `ann:${a.id}`));
  anns.sort((a, b) => (a.posted_at ?? "").localeCompare(b.posted_at ?? ""));
  let summaries = 0;
  for (const a of anns) {
    const text = summaries++ < MAX_SUMMARIES ? await deps.summarize(a.title, a.body) : a.title;
    items.push({ line: `${labels.get(a.course_id) ?? "Course"} announcement: ${text}`, keys: [`ann:${a.id}`] });
  }

  if (!items.length) return "nothing";
  const shown = items.slice(0, MAX_LINES);
  const more = items.length - shown.length;
  const text = shown.map((i) => i.line).join("\n") + (more > 0 ? `\n+${more} more next check` : "");
  if (!(await send(userKey, text, "notify"))) return "failed";
  for (const i of shown) for (const k of i.keys) markNotified(userKey, k);
  return "sent";
}

// ---- daily: missing work + morning brief ----

/** Canvas-flagged missing work that came due in the last 14 days (older items drop off). */
export async function recentMissing(deps: Deps): Promise<RawMissing[]> {
  const now = deps.now().getTime();
  return (await deps.missing()).filter((m) => {
    const due = m.due_at ? new Date(m.due_at).getTime() : NaN;
    return due <= now && now - due <= MISSING_WINDOW_MS;
  });
}


function missingLines(missing: RawMissing[], labels: Map<number, string>, tz: string): string[] {
  const lines = missing.slice(0, MAX_MISSING).map((m) => `- ${labels.get(m.course_id) ?? "Course"}: ${clean(m.name)}${m.due_at ? ` (was due ${fmtDay(m.due_at, tz)})` : ""}`);
  if (missing.length > MAX_MISSING) lines.push(`+${missing.length - MAX_MISSING} more`);
  return lines;
}

export async function runMissingDaily(userKey: string, deps: Deps, send: Send, opts: { force?: boolean } = {}): Promise<"skipped" | "sent" | "nothing" | "failed"> {
  const user = getUser(userKey);
  if (!user || user.paused || !user.notify) return "skipped";
  const tz = user.timezone;
  const date = localDate(deps.now(), tz);
  const courses = await deps.courses();
  const labels = new Map(courses.map((c) => [c.id, courseLabel(c)]));
  // anything the morning brief already listed today isn't repeated
  const fresh = (await recentMissing(deps)).filter((m) => !wasNotified(userKey, `missingseen:${date}:${m.id}`));
  if (!fresh.length) return "nothing";
  const text = `Missing work (Canvas marked these missing):\n${missingLines(fresh, labels, tz).join("\n")}`;
  if (!(await send(userKey, text, "notify"))) return "failed";
  for (const m of fresh.slice(0, MAX_MISSING)) markNotified(userKey, `missingseen:${date}:${m.id}`);
  return "sent";
}

export async function runBrief(userKey: string, deps: Deps, send: Send, opts: { force?: boolean } = {}): Promise<"skipped" | "sent" | "failed"> {
  const user = getUser(userKey);
  if (!user || user.paused || !user.notify) return "skipped";
  if (user.brief_time === "off" && !opts.force) return "skipped";
  const tz = user.timezone;
  const now = deps.now();
  const date = localDate(now, tz);
  const key = `brief:${date}`;
  if (!opts.force && wasNotified(userKey, key)) return "skipped";

  const data = await gather(deps);
  const labels = new Map(data.map((d) => [d.course.id, courseLabel(d.course)]));
  const lines = [`Good morning${user.first_name ? `, ${user.first_name}` : ""}! ${botName()} here. ${now.toLocaleDateString("en-US", { timeZone: tz, weekday: "long", month: "short", day: "numeric" })}`];

  const classLine = classesBriefLine(userKey, now, tz);
  if (classLine) lines.push(classLine);

  // reminders are calendar events titled "Reminder: ..."; they get their own section at the end
  let reminders: string[] = [];
  try {
    const ev = await deps.events(date);
    if (ev) {
      const isReminder = (l: string) => /\bReminder: /.test(l);
      const plain = ev.filter((l) => !isReminder(l));
      reminders = ev.filter(isReminder).map((l) => l.replace(/^(\S+\s?(?:AM|PM)?)-\S+\s?(?:AM|PM)?\s+Reminder: /, "$1 ").replace("Reminder: ", ""));
      lines.push(plain.length ? `Today: ${plain.join("; ")}` : "Today: nothing on your calendar");
    }
  } catch (e) {
    console.error("calendar unavailable for brief:", e instanceof Error ? e.message : e);
    lines.push("Today: (calendar unavailable)");
  }

  const horizon = now.getTime() + 48 * HOUR;
  const due = data
    .flatMap(({ course, assignments }) => assignments.filter(isOpen).map((a) => ({ a, label: labels.get(course.id)! })))
    .filter(({ a }) => new Date(a.due_at!).getTime() > now.getTime() && new Date(a.due_at!).getTime() <= horizon)
    .sort((x, y) => x.a.due_at!.localeCompare(y.a.due_at!));
  if (due.length) {
    lines.push("Due in the next 48h:");
    for (const { a, label } of due.slice(0, 8)) lines.push(`- ${fmtDue(a.due_at!, tz)} ${label}: ${clean(a.name)}`);
  } else lines.push("Due in the next 48h: nothing");

  let missing: RawMissing[] = [];
  try {
    missing = await recentMissing(deps);
  } catch (e) {
    console.error("could not fetch missing work:", e instanceof Error ? e.message : e);
  }
  if (missing.length) {
    lines.push("Missing:");
    lines.push(...missingLines(missing, labels, tz));
  }
  if (reminders.length) lines.push(`Reminders today: ${reminders.join("; ")}`);

  if (!(await send(userKey, lines.join("\n"), "notify"))) return "failed";
  markNotified(userKey, key);
  for (const m of missing) markNotified(userKey, `missingseen:${date}:${m.id}`);
  return "sent";
}

// ---- class heads-ups: 15 minutes before a class, once each, only if the user turned them on ----

export async function runClassAlerts(userKey: string, deps: Deps, send: Send): Promise<number> {
  const user = getUser(userKey);
  if (!user || user.paused || !user.notify || user.class_alerts !== 1) return 0;
  let sent = 0;
  for (const a of dueClassAlerts(userKey, deps.now(), user.timezone)) {
    if (wasNotified(userKey, a.key)) continue;
    if (await send(userKey, a.text, "notify")) {
      markNotified(userKey, a.key);
      sent++;
    } // a dropped send (breaker) is retried on the next tick while the class hasn't started
  }
  return sent;
}

// ---- Sunday preview: the week ahead, in code (no LLM) ----

const gradeRows = (courses: Course[]) =>
  courses.filter((c) => c.current_score !== null).map((c) => ({ course_id: c.id, score: c.current_score as number, grade: c.current_grade }));

const pct = (n: number) => `${Math.round(n * 10) / 10}%`;

export const SUNDAY_HOUR = 18;

export async function runSunday(userKey: string, deps: Deps, send: Send, opts: { force?: boolean } = {}): Promise<"skipped" | "sent" | "failed"> {
  const user = getUser(userKey);
  if (!user || user.paused || !user.notify) return "skipped";
  const tz = user.timezone;
  const now = deps.now();
  const date = localDate(now, tz);
  const key = `sunday:${date}`;
  if (!opts.force && wasNotified(userKey, key)) return "skipped";

  // through the end of the coming Sunday (on a Sunday evening that is a full week from tonight)
  const until = endOfLocalDay(now, tz, ((7 - localDow(now, tz)) % 7) + 7);
  const untilLabel = until.toLocaleDateString("en-US", { timeZone: tz, weekday: "short", month: "short", day: "numeric" }).replace(",", "");
  const data = await gather(deps);
  const labels = new Map(data.map((d) => [d.course.id, courseLabel(d.course)]));
  const lines = [`Sunday preview from ${botName()}. The week ahead, through ${untilLabel}.`];

  const due = data
    .flatMap(({ course, assignments }) => assignments.filter(isOpen).map((a) => ({ due: a.due_at!, course: labels.get(course.id)!, name: a.name })))
    .filter((i) => new Date(i.due).getTime() > now.getTime() && new Date(i.due).getTime() <= until.getTime());
  lines.push(formatDue(due, tz, now, "Due:", "Due: nothing. Enjoy it."));

  let missing: RawMissing[] = [];
  try {
    missing = await recentMissing(deps);
  } catch (e) {
    console.error("could not fetch missing work:", e instanceof Error ? e.message : e);
  }
  if (missing.length) lines.push("Missing:", ...missingLines(missing, labels, tz));

  // grade changes since the last snapshot (taken at sign-up, then every Sunday)
  const prev = previousGradeSnapshot(userKey, date);
  const changes: string[] = [];
  const current: string[] = [];
  for (const { course } of data) {
    if (course.current_score === null) continue;
    const label = labels.get(course.id)!;
    const was = prev.get(course.id);
    current.push(`${label} ${pct(course.current_score)}`);
    if (was && Math.abs(course.current_score - was.score) >= 0.05) {
      const letters = was.grade && course.current_grade && was.grade !== course.current_grade ? ` (${was.grade} -> ${course.current_grade})` : course.current_grade ? ` (${course.current_grade})` : "";
      changes.push(`${label}: ${pct(was.score)} -> ${pct(course.current_score)}${letters}`);
    }
  }
  if (changes.length) lines.push("Grade changes this week:", ...changes.map((c) => `- ${c}`));
  else if (prev.size) lines.push("Grades: no changes this week.");
  else if (current.length) lines.push(`Grades now: ${current.join(" | ")}`);

  // calendar lines are the owner's only
  try {
    const ev = await deps.weekEvents?.(localDate(now, tz), localDate(until, tz));
    if (ev) lines.push(ev.length ? "Calendar:" : "Calendar: nothing scheduled.", ...ev.map((e) => `- ${e}`));
  } catch (e) {
    console.error("calendar unavailable for the Sunday preview:", e instanceof Error ? e.message : e);
    lines.push("Calendar: (unavailable)");
  }

  if (!(await send(userKey, lines.join("\n"), "notify"))) return "failed";
  markNotified(userKey, key);
  saveGradeSnapshot(userKey, date, gradeRows(data.map((d) => d.course)));
  return "sent";
}

// ---- scheduling ----

type UserState = { nextCheckAt: number | null };

export type SchedulerOpts = {
  /** Users to serve right now (active ones). */
  users(): UserRow[];
  /** Build a user's context; throws if their credentials are unusable (that user is skipped, others continue). */
  contextFor(user: UserRow): Promise<UserContext>;
  deps: Deps;
  send: Send;
  /** Multi-user: keep retrying the first text to people who signed up on the web but haven't been reached. */
  welcome?: WelcomeCtx;
};

/** Everything scheduled for one user, run inside their context. */
async function userTick(user: UserRow, state: UserState, opts: SchedulerOpts) {
  const { deps, send } = opts;
  const userKey = user.phone;
  const now = deps.now();
  if (state.nextCheckAt === null || now.getTime() >= state.nextCheckAt) {
    const r = await runCheck(userKey, deps, send);
    console.log(`scheduled check [${maskId(userKey)}]: ${r}`);
    state.nextCheckAt = Date.now() + CHECK_MS;
  }
  const fresh = getUser(userKey) ?? user;
  const tz = fresh.timezone;
  const date = localDate(now, tz);
  const mins = localMinutes(now, tz);
  const briefAt = parseHM(fresh.brief_time);
  await runClassAlerts(userKey, deps, send);
  if (fresh.brief_time !== "off" && mins >= briefAt && mins < briefAt + BRIEF_WINDOW_MIN && !wasNotified(userKey, `brief:${date}`)) {
    console.log(`morning brief [${maskId(userKey)}]: ${await runBrief(userKey, deps, send)}`);
  }
  // Sunday preview: Sundays from 6pm until 10pm
  if (localDow(now, tz) === 0 && mins >= SUNDAY_HOUR * 60 && mins < 22 * 60 && !wasNotified(userKey, `sunday:${date}`)) {
    console.log(`sunday preview [${maskId(userKey)}]: ${await runSunday(userKey, deps, send)}`);
  }
  // missing work, once a day in the evening
  if (mins >= 18 * 60 && mins < 22 * 60 && !wasNotified(userKey, `missingdaily:${date}`)) {
    const r = await runMissingDaily(userKey, deps, send);
    console.log(`daily missing-work check [${maskId(userKey)}]: ${r}`);
    if (r !== "failed" && r !== "skipped") markNotified(userKey, `missingdaily:${date}`);
  }
}

export function startScheduler(opts: SchedulerOpts) {
  const states = new Map<string, UserState>();
  let running = false;

  /** One pass over all active users, sequentially. A failure for one user never affects the others. */
  async function tick() {
    if (running) return;
    running = true;
    try {
      for (const user of opts.users()) {
        const state = states.get(user.phone) ?? { nextCheckAt: null };
        states.set(user.phone, state);
        try {
          const ctx = await opts.contextFor(user);
          await runWithContext(ctx, () => userTick(user, state, opts));
        } catch (e) {
          console.error(`scheduler: ${maskId(user.phone)} failed:`, e instanceof Error ? e.message : e);
        }
      }
      if (opts.welcome) await retryWelcomes(opts.welcome, opts.send).catch((e) => console.error("welcome retry failed:", e instanceof Error ? maskText(e.message) : "unknown error"));
    } catch (e) {
      console.error("scheduler tick failed:", e instanceof Error ? e.message : e);
    } finally {
      running = false;
    }
  }

  const first = setTimeout(tick, 5_000);
  const timer = setInterval(tick, 60_000);
  return {
    tick,
    nextCheckAt: (key: string) => states.get(key)?.nextCheckAt ?? null,
    stop: () => (clearTimeout(first), clearInterval(timer)),
  };
}

/** Run every job once, ignoring the clock. Used by --dry-run. */
export async function runAll(userKey: string, deps: Deps, send: Send, opts: { previewAll?: boolean } = {}) {
  let r = await runCheck(userKey, deps, send, opts);
  if (r === "seeded") r = await runCheck(userKey, deps, send, opts);
  console.log(`check: ${r}`);
  // same order as a real day: the 8am brief lists missing work first, the evening job only adds what's new
  console.log(`morning brief: ${await runBrief(userKey, deps, send, { force: true })}`);
  console.log(`evening missing-work job: ${await runMissingDaily(userKey, deps, send, { force: true })}`);
  console.log(`sunday preview: ${await runSunday(userKey, deps, send, { force: true })}`);
}
