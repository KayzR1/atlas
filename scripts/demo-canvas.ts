/**
 * A tiny fake Canvas for demos and screenshots: fictional courses, assignments, grades, announcements and syllabi.
 * Dates are relative to "now" so there is always something due soon. Nothing here is real data.
 *
 *   bun run demo        (starts this plus the bot, pointed at it)
 */
import { computeGrade, normalizeGroups } from "../src/grades.ts";

const H = 3600_000;
const iso = (offsetHours: number) => new Date(Date.now() + offsetHours * H).toISOString();
let nextId = 1000;
const id = () => nextId++;

type Raw = any;
const asg = (name: string, points: number, score: number | null, dueH: number | null, o: Raw = {}): Raw => ({
  id: id(), name, points_possible: points, grading_type: "points", omit_from_final_grade: false, submission_types: ["online_upload"], published: true,
  due_at: dueH === null ? null : iso(dueH),
  submission: { score, workflow_state: score === null ? "unsubmitted" : "graded", submitted_at: score === null ? null : iso(-48), excused: false, missing: false },
  ...o,
});
const grp = (name: string, weight: number, assignments: Raw[], rules: Raw = {}): Raw => ({ id: id(), name, group_weight: weight, rules, assignments });

export type DemoCourse = { id: number; name: string; code: string; weighted: boolean; groups: Raw[]; syllabus: string; front: string; announcements: { title: string; message: string; hoursAgo: number }[] };

export function demoCourses(): DemoCourse[] {
  const p = (...t: string[]) => t.map((x) => `<p>${x}</p>`).join("");
  return [
    {
      id: 1, name: "DATA 101: Intro to Data Science", code: "DATA101.001.FA26", weighted: true,
      groups: [
        grp("Homework", 30, [asg("HW 1", 20, 19, -500), asg("HW 2", 20, 17, -400), asg("HW 3", 20, 12, -300), asg("HW 4", 20, 20, -200), asg("HW 5", 20, 18, -100), asg("HW 6", 20, null, 70)], { drop_lowest: 1 }),
        grp("Labs", 20, [asg("Lab 1", 10, 10, -450), asg("Lab 2", 10, 9, -350), asg("Lab 3", 10, 10, -250), asg("Lab 4", 10, 8, -150), asg("Lab 5: Regression", 10, null, 26)]),
        grp("Midterm", 20, [asg("Midterm Exam", 100, 84, -240)]),
        grp("Final Project", 30, [asg("Project Proposal", 20, null, 140), asg("Final Project", 100, null, 600)]),
      ],
      syllabus: p(
        "Late work policy: homework and labs lose 10% per day for up to three days. After three days late work is not accepted unless you have an approved extension from Dr. Rivera.",
        "Office hours: Dr. Rivera holds office hours Mondays and Wednesdays from 3:00 to 4:30 PM in Sterling Hall 214, and by appointment. TAs hold lab help Tuesdays 5 to 7 PM.",
        "Exams: the midterm exam covered weeks 1 to 7. The final project replaces a final exam; proposals are due in week 11 and the project is presented in the last week of class.",
        "Grading: homework 30%, labs 20%, midterm 20%, final project 30%. The lowest homework score is dropped.",
      ),
      front: p("Welcome to DATA 101! Lectures are Mondays and Wednesdays at 2:00 PM. Bring a laptop to lab sessions."),
      announcements: [
        { title: "Lab 5 posted", message: "<p>Lab 5 on regression is posted and due tomorrow at 11:59 PM. Bring questions to Tuesday lab help.</p>", hoursAgo: 5 },
        { title: "Office hours moved this week", message: "<p>Monday office hours are moved to Tuesday 3 PM because of the faculty meeting.</p>", hoursAgo: 30 },
      ],
    },
    {
      id: 2, name: "ECON 210: Microeconomics", code: "ECON210.002.FA26", weighted: true,
      groups: [
        grp("Problem Sets", 25, [asg("Problem Set 1", 50, 46, -480), asg("Problem Set 2", 50, 44, -360), asg("Problem Set 3", 50, 49, -200), asg("Problem Set 4", 50, null, 44)]),
        grp("Quizzes", 15, [asg("Quiz 1", 10, 9, -500), asg("Quiz 2", 10, 6, -420), asg("Quiz 3", 10, 10, -330), asg("Quiz 4", 10, 8, -240), asg("Quiz 5", 10, 10, -140), asg("Quiz 6", 10, null, 96)], { drop_lowest: 2 }),
        grp("Midterm", 25, [asg("Midterm", 100, 91, -260)]),
        grp("Final Exam", 35, []),
      ],
      syllabus: p(
        "Late policy: problem sets are accepted up to 24 hours late for a 20% penalty. Quizzes cannot be made up; the two lowest quiz scores are dropped.",
        "Office hours: Professor Chen is available Thursdays 1:00 to 3:00 PM in Gardner 305. Email is the best way to reach the teaching team.",
        "Final exam: cumulative, held during the university final exam period, and worth 35% of the course grade. Bring a calculator and one page of notes.",
        "Attendance: you may miss two lectures without penalty. Contact the instructor before a planned absence.",
      ),
      front: p("ECON 210. Course materials, problem sets and recorded lectures are linked from the modules page."),
      announcements: [{ title: "Midterm grades posted", message: "<p>Midterm grades are posted. The class average was 82%. Solutions are on the modules page.</p>", hoursAgo: 20 }],
    },
    {
      id: 3, name: "ENGL 150: Creative Writing", code: "ENGL150.003.FA26", weighted: false,
      groups: [
        grp("Writing", 0, [asg("Workshop piece 1", 50, 46, -400), asg("Workshop piece 2", 50, 44, -200), asg("Workshop piece 3", 50, null, 110)]),
        grp("Reading responses", 0, [asg("Reading response 1", 10, 10, -420), asg("Reading response 2", 10, 9, -280), asg("Reading response 3", 10, null, -72, { submission: { score: null, workflow_state: "unsubmitted", submitted_at: null, excused: false, missing: true } })]),
      ],
      syllabus: p("Late policy: workshop pieces lose one letter grade per class meeting late. Reading responses are accepted until the next class for half credit.", "Office hours: by appointment on Fridays.", "Grading is points-based: your grade is total points earned over total points possible."),
      front: p("Welcome to Creative Writing."),
      announcements: [{ title: "Workshop groups", message: "<p>Workshop groups for next week are posted on the modules page.</p>", hoursAgo: 50 }],
    },
  ];
}

const SCALE = [["A", 0.93], ["A-", 0.9], ["B+", 0.87], ["B", 0.83], ["B-", 0.8], ["C+", 0.77], ["C", 0.73], ["C-", 0.7], ["D", 0.6], ["F", 0]];
const letter = (pct: number) => (SCALE.find(([, min]) => pct >= (min as number) * 100) ?? ["F"])[0] as string;

export function startDemoCanvas(port = 8787) {
  const courses = demoCourses();
  const byId = new Map(courses.map((c) => [c.id, c]));
  const json = (o: unknown, status = 200) => new Response(JSON.stringify(o), { status, headers: { "content-type": "application/json" } });
  const score = (c: DemoCourse) => computeGrade({ weighted: c.weighted, groups: normalizeGroups(c.groups) }).percent;

  return Bun.serve({
    port,
    fetch(req) {
      const url = new URL(req.url);
      const path = url.pathname.replace(/^\/api\/v1/, "");
      if (path === "/users/self") return json({ id: 1, name: "Demo Student" });
      if (path === "/courses") {
        return json(courses.map((c) => {
          const s = score(c);
          return { id: c.id, name: c.name, course_code: c.code, enrollments: [{ type: "student", computed_current_score: s === null ? null : Math.round(s * 100) / 100, computed_current_grade: s === null ? null : letter(s) }] };
        }));
      }
      if (path === "/announcements") {
        const ids = url.searchParams.getAll("context_codes[]").map((c) => Number(c.replace("course_", "")));
        return json(ids.flatMap((cid, i) => (byId.get(cid)?.announcements ?? []).map((a, j) => ({ id: 9000 + cid * 10 + j, context_code: `course_${cid}`, title: a.title, message: a.message, posted_at: iso(-a.hoursAgo), user_name: "Instructor" }))));
      }
      if (path === "/users/self/todo") {
        const items = courses.flatMap((c) => c.groups.flatMap((g: Raw) => g.assignments.filter((a: Raw) => a.due_at && a.submission.score === null && new Date(a.due_at) > new Date()).map((a: Raw) => ({ type: "submitting", course_id: c.id, context_name: c.name, assignment: a }))));
        return json(items.slice(0, 8));
      }
      if (path === "/users/self/missing_submissions") {
        return json(courses.flatMap((c) => c.groups.flatMap((g: Raw) => g.assignments.filter((a: Raw) => a.submission.missing).map((a: Raw) => ({ id: a.id, course_id: c.id, name: a.name, due_at: a.due_at })))));
      }
      const m = path.match(/^\/courses\/(\d+)(\/.*)?$/);
      const c = m ? byId.get(Number(m[1])) : undefined;
      if (!c) return json({ errors: [{ message: "The specified resource does not exist." }] }, 404);
      const sub = m![2] ?? "";
      if (sub === "") return json({ id: c.id, name: c.name, apply_assignment_group_weights: c.weighted, grading_standard_id: 1, syllabus_body: url.searchParams.getAll("include[]").includes("syllabus_body") ? c.syllabus : undefined });
      if (sub === "/front_page") return json({ title: "Home Page", body: c.front });
      if (sub === "/pages") return json({ errors: [{ message: "pages are disabled" }] }, 404);
      if (sub === "/grading_standards") return json([{ id: 1, title: "Standard", grading_scheme: SCALE.map(([name, v]) => ({ name, value: v, calculated_value: (v as number) * 100 })) }]);
      if (sub === "/assignment_groups") return json(c.groups);
      if (sub === "/assignments") {
        const bucket = url.searchParams.get("bucket");
        let list = c.groups.flatMap((g: Raw) => g.assignments);
        if (bucket === "upcoming") list = list.filter((a: Raw) => a.due_at && new Date(a.due_at) > new Date());
        return json(list.sort((a: Raw, b: Raw) => String(a.due_at).localeCompare(String(b.due_at))));
      }
      const one = sub.match(/^\/assignments\/(\d+)$/);
      if (one) {
        const a = c.groups.flatMap((g: Raw) => g.assignments).find((x: Raw) => x.id === Number(one[1]));
        return a ? json({ ...a, description: "<p>Demo assignment.</p>", html_url: "" }) : json({}, 404);
      }
      return json({ errors: [{ message: "not found" }] }, 404);
    },
  });
}

if (import.meta.main) {
  const server = startDemoCanvas(Number(process.env.DEMO_PORT) || 8787);
  console.log(`demo Canvas on http://localhost:${server.port}`);
}
