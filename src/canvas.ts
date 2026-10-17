import { convert } from "html-to-text";
import { courseLabel, dueWindow, formatDue, isOpen, type DueItem, type DueScope } from "./assignments.ts";
import { requireContext } from "./context.ts";

const MAX_RESULT_CHARS = 4500;

// Credentials come from the current user's context, never from process.env directly.
function baseUrl(): string {
  return requireContext().canvasUrl.replace(/\/+$/, "");
}

function headers(): Record<string, string> {
  const token = requireContext().canvasToken;
  if (!token) throw new Error("no Canvas token for this user");
  return { Authorization: `Bearer ${token}` };
}

function nextLink(link: string | null): string | null {
  if (!link) return null;
  for (const part of link.split(",")) {
    const m = part.match(/<([^>]+)>;\s*rel="next"/);
    if (m) return m[1]!;
  }
  return null;
}

/** GET a Canvas path, following Link-header pagination. */
async function getAll(path: string, maxPages = 10): Promise<any[]> {
  const sep = path.includes("?") ? "&" : "?";
  let url: string | null = `${baseUrl()}/api/v1${path}${sep}per_page=100`;
  const out: any[] = [];
  for (let page = 0; url && page < maxPages; page++) {
    const res: Response = await fetch(url, { headers: headers() });
    if (!res.ok) throw new Error(`Canvas ${res.status} for ${path}: ${(await res.text()).slice(0, 200)}`);
    const data = await res.json();
    if (Array.isArray(data)) out.push(...data);
    else return [data];
    url = nextLink(res.headers.get("link"));
  }
  return out;
}

async function getOne(path: string): Promise<any> {
  const res = await fetch(`${baseUrl()}/api/v1${path}`, { headers: headers() });
  if (!res.ok) throw new Error(`Canvas ${res.status} for ${path}: ${(await res.text()).slice(0, 200)}`);
  return res.json();
}

function local(iso: string | null | undefined): string | null {
  if (!iso) return null;
  return new Date(iso).toLocaleString("en-US", {
    timeZone: requireContext().timezone,
    weekday: "short",
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}

/** Readable plain text from Canvas HTML: paragraphs kept apart, headings not shouted, links and images dropped. */
export function htmlToText(s: string | null | undefined): string {
  if (!s) return "";
  const headings = ["h1", "h2", "h3", "h4", "h5", "h6"].map((selector) => ({ selector, options: { uppercase: false } }));
  return convert(s, { wordwrap: false, selectors: [{ selector: "a", options: { ignoreHref: true } }, { selector: "img", format: "skip" }, ...headings] }).trim();
}

function html(s: string | null | undefined): string {
  if (!s) return "";
  return convert(s, { wordwrap: false, selectors: [{ selector: "a", options: { ignoreHref: true } }, { selector: "img", format: "skip" }] }).trim();
}

function cap(s: string, n: number): string {
  return s.length > n ? s.slice(0, n) + "…[truncated]" : s;
}

function trimAssignment(a: any) {
  const sub = a.submission;
  return {
    id: a.id,
    name: a.name,
    due: local(a.due_at),
    due_utc: a.due_at,
    points_possible: a.points_possible,
    submitted: sub ? !!sub.submitted_at : undefined,
    missing: sub?.missing || undefined,
    late: sub?.late || undefined,
    score: sub?.score ?? undefined,
    grade: sub?.grade ?? undefined,
    submission_types: a.submission_types,
  };
}

export async function listCourses() {
  const courses = await getAll("/courses?enrollment_state=active&include[]=total_scores");
  return courses
    .filter((c) => c && c.name)
    .map((c) => {
      const e = (c.enrollments || []).find((x: any) => x.type === "student") || c.enrollments?.[0];
      return {
        id: c.id,
        name: c.name,
        code: c.course_code,
        current_score: e?.computed_current_score ?? null,
        current_grade: e?.computed_current_grade ?? null,
      };
    });
}

export async function getTodo() {
  const items = await getAll("/users/self/todo");
  return items.map((t) => ({
    type: t.type,
    course_id: t.course_id,
    course: t.context_name,
    assignment_id: t.assignment?.id,
    name: t.assignment?.name ?? t.quiz?.title,
    due: local(t.assignment?.due_at),
    due_utc: t.assignment?.due_at,
    points_possible: t.assignment?.points_possible,
  }));
}

export async function listAssignments(courseId: number, bucket?: string) {
  const b = bucket ? `&bucket=${encodeURIComponent(bucket)}` : "";
  const items = await getAll(`/courses/${courseId}/assignments?include[]=submission&order_by=due_at${b}`);
  return items.map(trimAssignment);
}

export async function getAssignment(courseId: number, assignmentId: number) {
  const a = await getOne(`/courses/${courseId}/assignments/${assignmentId}?include[]=submission`);
  return { ...trimAssignment(a), description: cap(html(a.description), 4000), html_url: a.html_url };
}

export async function listAnnouncements(courseIds: number[], daysBack = 14) {
  const end = new Date();
  const start = new Date(end.getTime() - daysBack * 86400_000);
  const codes = courseIds.map((id) => `context_codes[]=course_${id}`).join("&");
  const items = await getAll(
    `/announcements?${codes}&start_date=${start.toISOString().slice(0, 10)}&end_date=${new Date(end.getTime() + 86400_000).toISOString().slice(0, 10)}`,
  );
  return items.slice(0, 8).map((a) => ({
    course: String(a.context_code ?? "").replace("course_", ""),
    title: a.title,
    posted: local(a.posted_at),
    author: a.user_name,
    message: cap(html(a.message), 250),
  }));
}


// ---- raw fetchers for the proactive checks (not exposed as LLM tools) ----

export type RawAssignment = {
  id: number;
  name: string;
  due_at: string | null;
  points_possible: number | null;
  submission_types: string[];
  submission?: { score: number | null; workflow_state?: string; submitted_at: string | null; missing: boolean; excused: boolean };
};

export async function fetchAssignmentsRaw(courseId: number): Promise<RawAssignment[]> {
  const items = await getAll(`/courses/${courseId}/assignments?include[]=submission&order_by=due_at`);
  return items.map((a) => ({
    id: a.id,
    name: a.name,
    due_at: a.due_at ?? null,
    points_possible: a.points_possible ?? null,
    submission_types: a.submission_types ?? [],
    submission: a.submission
      ? {
          score: a.submission.score ?? null,
          workflow_state: a.submission.workflow_state,
          submitted_at: a.submission.submitted_at ?? null,
          missing: !!a.submission.missing,
          excused: !!a.submission.excused,
        }
      : undefined,
  }));
}

/** A course's readable text: syllabus body, front page and (where the course has them) pages. Missing pieces are simply absent. */
export async function fetchCourseContentRaw(courseId: number): Promise<{ syllabus: string; front: { title: string; body: string } | null; pages: { title: string; body: string }[] }> {
  // 404/403 = this course has no front page / pages tool enabled. Anything else (5xx, network) is a real failure and must not look like "empty".
  const soft = async <T>(p: Promise<T>): Promise<T | null> =>
    p.catch((e) => {
      if (/Canvas (404|403) /.test(String(e?.message))) return null;
      throw e;
    });
  const [course, front, pages] = await Promise.all([
    soft(getOne(`/courses/${courseId}?include[]=syllabus_body`)),
    soft(getOne(`/courses/${courseId}/front_page`)),
    soft(getAll(`/courses/${courseId}/pages?sort=title&published=true&include[]=body`)),
  ]);
  return {
    syllabus: htmlToText(course?.syllabus_body),
    front: front?.body ? { title: String(front.title ?? "Front page"), body: htmlToText(front.body) } : null,
    pages: (pages ?? []).filter((p: any) => p?.body).slice(0, 40).map((p: any) => ({ title: String(p.title ?? "Page"), body: htmlToText(p.body) })),
  };
}

/** Raw Canvas objects for the grade calculator. */
export const fetchCourseRaw = (courseId: number) => getOne(`/courses/${courseId}`);
export const fetchAssignmentGroupsRaw = (courseId: number) => getAll(`/courses/${courseId}/assignment_groups?include[]=assignments&include[]=submission`);
export const fetchGradingStandardsRaw = (courseId: number) => getAll(`/courses/${courseId}/grading_standards`);

export type RawAnnouncement = { id: number; course_id: number; title: string; body: string; posted_at: string | null };

export async function fetchAnnouncementsRaw(courseIds: number[], daysBack = 14): Promise<RawAnnouncement[]> {
  if (!courseIds.length) return [];
  const end = new Date();
  const start = new Date(end.getTime() - daysBack * 86400_000);
  const codes = courseIds.map((id) => `context_codes[]=course_${id}`).join("&");
  const items = await getAll(
    `/announcements?${codes}&start_date=${start.toISOString().slice(0, 10)}&end_date=${new Date(end.getTime() + 86400_000).toISOString().slice(0, 10)}`,
  );
  return items.map((a) => ({
    id: a.id,
    course_id: Number(String(a.context_code ?? "").replace("course_", "")),
    title: a.title ?? "",
    body: cap(html(a.message), 1500),
    posted_at: a.posted_at ?? null,
  }));
}

export type RawMissing = { id: number; course_id: number; name: string; due_at: string | null };

/** Assignments Canvas itself marks as missing. */
export async function fetchMissingRaw(): Promise<RawMissing[]> {
  const items = await getAll("/users/self/missing_submissions?filter[]=submittable");
  return items.map((a) => ({ id: a.id, course_id: a.course_id, name: a.name, due_at: a.due_at ?? null }));
}

// ---- "what's due" across every course in one call ----

/** Unsubmitted, submittable assignments due in [from, until] across all active courses. */
export async function dueItems(from: Date, until: Date): Promise<{ items: DueItem[]; failedCourses: number }> {
  const courses = await listCourses();
  let failedCourses = 0;
  const per = await Promise.all(
    courses.map(async (c) => {
      try {
        return { c, list: await fetchAssignmentsRaw(c.id) };
      } catch {
        failedCourses++;
        return { c, list: [] as RawAssignment[] };
      }
    }),
  );
  const items: DueItem[] = [];
  for (const { c, list } of per)
    for (const a of list) {
      if (!isOpen(a)) continue;
      const t = new Date(a.due_at!).getTime();
      if (t >= from.getTime() && t <= until.getTime()) items.push({ due: a.due_at!, course: courseLabel(c), name: a.name });
    }
  return { items, failedCourses };
}

/** The finished text for a standard window. Used by the zero-LLM fast path and the get_due_overview tool. */
export async function dueText(scope: DueScope, now = new Date()): Promise<string> {
  const tz = requireContext().timezone;
  const w = dueWindow(scope, now, tz);
  const { items, failedCourses } = await dueItems(w.from, w.until);
  return formatDue(items, tz, now, w.header, w.empty, failedCourses ? `
(couldn't check ${failedCourses} course${failedCourses > 1 ? "s" : ""})` : "");
}

export async function dueTextDays(days: number, now = new Date()): Promise<string> {
  const tz = requireContext().timezone;
  const n = Math.min(30, Math.max(1, Math.round(days)));
  const { items, failedCourses } = await dueItems(now, new Date(now.getTime() + n * 86400_000));
  return formatDue(items, tz, now, `Due in the next ${n} day${n > 1 ? "s" : ""}:`, `Nothing due in the next ${n} day${n > 1 ? "s" : ""}.`, failedCourses ? `\n(couldn't check ${failedCourses} course${failedCourses > 1 ? "s" : ""})` : "");
}

// ---- tool definitions (OpenAI function format) ----

const nullable = (type: string) => ({ type: [type, "null"] });

export const tools = [
  { type: "function" as const, function: { name: "list_courses", description: "Active courses with ids and current grades.", parameters: { type: "object", properties: {} } } },
  { type: "function" as const, function: { name: "get_todo", description: "Canvas to-do list.", parameters: { type: "object", properties: {} } } },
  {
    type: "function" as const,
    function: {
      name: "get_due_overview",
      description: "Unsubmitted work due soon across ALL courses, in one call.",
      parameters: { type: "object", properties: { days: nullable("integer") } },
    },
  },
  {
    type: "function" as const,
    function: {
      name: "list_assignments",
      description: "One course's assignments with due dates and status.",
      parameters: {
        type: "object",
        properties: {
          course_id: { type: "integer" },
          bucket: { type: ["string", "null"], enum: ["past", "overdue", "undated", "ungraded", "unsubmitted", "upcoming", "future", null] },
        },
        required: ["course_id"],
      },
    },
  },
  {
    type: "function" as const,
    function: {
      name: "get_assignment",
      description: "One assignment's details.",
      parameters: { type: "object", properties: { course_id: { type: "integer" }, assignment_id: { type: "integer" } }, required: ["course_id", "assignment_id"] },
    },
  },
  {
    type: "function" as const,
    function: {
      name: "list_announcements",
      description: "Recent announcements for courses.",
      parameters: { type: "object", properties: { course_ids: { type: "array", items: { type: "integer" } }, days_back: nullable("integer") }, required: ["course_ids"] },
    },
  },
];

/** Run a tool by name. Never throws: errors are returned as text for the model. Result is capped at ~8k chars. */
export async function runTool(name: string, args: any): Promise<string> {
  try {
    let result: unknown;
    switch (name) {
      case "list_courses":
        result = await listCourses();
        break;
      case "get_todo":
        result = await getTodo();
        break;
      case "get_due_overview":
        // already plain text, return as-is
        return cap(await dueTextDays(Number(args.days ?? 7)), MAX_RESULT_CHARS);
      case "list_assignments":
        result = await listAssignments(Number(args.course_id), args.bucket);
        break;
      case "get_assignment":
        result = await getAssignment(Number(args.course_id), Number(args.assignment_id));
        break;
      case "list_announcements":
        result = await listAnnouncements((args.course_ids ?? []).map(Number), Number(args.days_back ?? 14));
        break;
      default:
        return `Error: unknown tool ${name}`;
    }
    return cap(JSON.stringify(result), MAX_RESULT_CHARS);
  } catch (e) {
    return `Error: ${e instanceof Error ? e.message : String(e)}`;
  }
}
