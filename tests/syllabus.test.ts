import { afterEach, beforeEach, expect, test } from "bun:test";
import { executeTool, resetModelCooldowns, runAgent, setLlmForTests, toolsForRole, type LlmLike } from "../src/agent.ts";
import { runWithContext, type UserContext } from "../src/context.ts";
import { db, initDb } from "../src/db.ts";
import { askSyllabus, CACHE_TTL_MS, cachedChunks, chunkText, MAX_CONTEXT_CHARS, rank, runSyllabusTool, stem, tokenize, type Chunk } from "../src/syllabus.ts";

const owner: UserContext = { key: "+19195550100", role: "owner", timezone: "America/New_York", canvasUrl: "https://canvas.example", canvasToken: "t" };
const member: UserContext = { ...owner, key: "+19195550101", role: "member" };
const realFetch = globalThis.fetch;

// ---------- a syllabus like a real one ----------

const LATE = "Late work policy: assignments submitted late lose 10% per day, up to 3 days. After 3 days the assignment is not accepted unless you have an approved extension from the instructor.";
const EXAMS = "Exams: the midterm exam is on October 13 from 3:30 to 4:45 PM in the regular classroom. The final exam is cumulative and is worth 20% of your grade. Bring a calculator and one page of notes.";
const HOURS = "Office hours: Professor Lee holds office hours Tuesdays and Thursdays from 2:00 to 3:30 PM in Gardner 305, or by appointment. Email is the best way to reach the teaching team.";
const ATTEND = "Attendance: you may miss two class sessions without penalty. Additional absences lower your participation grade by 2 points each. Contact the instructor before a planned absence.";
const HONOR = "Academic integrity: all work must follow the UNC Honor Code. Plagiarism or cheating on any assignment will be reported to the Office of Student Conduct.";
const SCHEDULE = "Weekly schedule: Week 1 introductions and course overview. Week 2 empathy interviews. Week 3 problem definition. Week 4 prototyping. Week 5 testing. Week 6 midterm review.";

function html(...paras: string[]) {
  return paras.map((p) => `<p>${p}</p>`).join("\n");
}

let calls: string[];
function mockCanvas(courses: Record<number, { code: string; name: string; syllabus?: string; front?: string; pages?: { title: string; body: string }[]; broken?: boolean }>) {
  calls = [];
  globalThis.fetch = (async (url: any) => {
    const u = String(url);
    const json = (o: unknown) => new Response(JSON.stringify(o), { status: 200, headers: { "content-type": "application/json" } });
    if (!u.startsWith("https://canvas.example/api/v1/")) throw new Error(`unexpected network call: ${u}`);
    calls.push(u.replace("https://canvas.example/api/v1", ""));
    if (u.includes("/courses?")) return json(Object.entries(courses).map(([id, c]) => ({ id: +id, name: c.name, course_code: c.code, enrollments: [] })));
    const m = u.match(/\/courses\/(\d+)(\/[a-z_]+)?/);
    const c = m ? courses[+m[1]!] : undefined;
    if (!c) return new Response("nope", { status: 404 });
    if (c.broken) return new Response("boom", { status: 500 });
    if (!m![2]) return json({ id: +m![1]!, syllabus_body: c.syllabus ?? "" });
    if (m![2] === "/front_page") return c.front ? json({ title: "Course Home", body: c.front }) : new Response("nope", { status: 404 });
    if (m![2] === "/pages") return c.pages ? json(c.pages.map((p, i) => ({ url: `p${i}`, title: p.title, body: p.body }))) : new Response("nope", { status: 404 });
    return new Response("nope", { status: 404 });
  }) as any;
}
const fetchesFor = (id: number) => calls.filter((c) => c.startsWith(`/courses/${id}`) && !c.startsWith("/courses?")).length;

beforeEach(() => {
  initDb(":memory:");
  resetModelCooldowns();
});
afterEach(() => {
  globalThis.fetch = realFetch;
  setLlmForTests();
});

const ask = (q: string, course = "ECON 210", ctx = owner, now = new Date("2026-10-16T14:00:00Z")) => runWithContext(ctx, () => askSyllabus({ course, question: q }, now));

// ---------- chunking ----------

test("chunks are about 800 characters, split on paragraph boundaries, and lose no words", () => {
  const paras = Array.from({ length: 12 }, (_, i) => `Paragraph ${i}. ` + "word ".repeat(40).trim() + ".");
  const chunks = chunkText(paras.join("\n\n"));
  expect(chunks.length).toBeGreaterThan(2);
  for (const c of chunks) {
    expect(c.length).toBeLessThanOrEqual(800);
    expect(c.length).toBeGreaterThan(0);
  }
  expect(chunks.join(" ").split(/\s+/).filter(Boolean).length).toBe(paras.join(" ").split(/\s+/).filter(Boolean).length);
  // short paragraphs are merged up to the size, not one chunk each
  expect(chunkText("a one.\n\nb two.\n\nc three.")).toEqual(["a one.\n\nb two.\n\nc three."]);
});

test("one huge paragraph is split at sentences, and a single huge sentence at word boundaries", () => {
  const sentences = Array.from({ length: 30 }, (_, i) => `Sentence number ${i} is here.`).join(" ");
  const a = chunkText(sentences);
  expect(a.length).toBeGreaterThan(1);
  for (const c of a) expect(c.length).toBeLessThanOrEqual(800);
  for (const c of a) expect(c.endsWith(".")).toBe(true);
  const one = chunkText("word ".repeat(500).trim());
  expect(one.length).toBeGreaterThan(2);
  for (const c of one) {
    expect(c.length).toBeLessThanOrEqual(800);
    expect(c.startsWith("word") && c.endsWith("word")).toBe(true); // never cut mid-word
  }
  expect(chunkText("")).toEqual([]);
  expect(chunkText("   \n\n  ")).toEqual([]);
});

// ---------- retrieval ----------

const CHUNKS: Chunk[] = [LATE, EXAMS, HOURS, ATTEND, HONOR, SCHEDULE].map((text) => ({ source: "Syllabus", text }));

test("BM25 finds the right passage for typical questions, including paraphrases", () => {
  const top = (q: string) => rank(q, CHUNKS)[0]?.chunk.text.split(":")[0];
  expect(top("what's the late policy")).toBe("Late work policy");
  expect(top("can I turn it in late")).toBe("Late work policy");
  expect(top("what's on the midterm")).toBe("Exams");
  expect(top("when is the final")).toBe("Exams");
  expect(top("office hours")).toBe("Office hours");
  expect(top("when can I see the professor")).toBe("Office hours");
  expect(top("how many absences are allowed")).toBe("Attendance");
  expect(top("what happens if I cheat")).toBe("Academic integrity");
  expect(top("what do we cover in week 4")).toBe("Weekly schedule");
});

test("a phrase beats a repeated word: 'office hours' finds the office-hours passage, not the one that says 'hours late' a lot", () => {
  const distractor: Chunk = { source: "Syllabus", text: "Homework and labs will be accepted up to 48 hours late. Anything more than 48 hours late is a zero, and 24 hours late costs a quarter of the credit; hours late are counted from the deadline." };
  const real: Chunk = { source: "Syllabus", text: "Office Hours During the times listed below, the instructional assistants and I will be available in person and by video; no appointment is needed." };
  expect(rank("when are office hours", [distractor, real])[0]!.chunk).toBe(real);
  expect(rank("when are office hours", [real, distractor])[0]!.chunk).toBe(real);
  // the phrase bonus doesn't invent matches
  expect(rank("office hours", [{ source: "Syllabus", text: "Nothing relevant here at all." }])).toEqual([]);
});

test("only the top 3 passages come back, ranked, and matches need to be real", () => {
  expect(rank("exam policy attendance late", CHUNKS).length).toBe(3);
  expect(rank("the", CHUNKS)).toEqual([]); // only stop words
  expect(rank("", CHUNKS)).toEqual([]);
  expect(rank("zebra xylophone", CHUNKS)).toEqual([]);
  expect(rank("anything", [])).toEqual([]);
  expect(tokenize("What is the Late Policy?")).toEqual(["late", "policy"]);
  expect(stem("assignments")).toBe("assignment");
  expect(stem("grading")).toBe("grad");
  expect(stem("policies")).toBe("policy");
});

// ---------- asking (mocked Canvas, no network, no LLM) ----------

const ECON = { code: "ECON210.002.FA26", name: "ECON210.002.FA26", syllabus: html(LATE, EXAMS), front: html(HOURS, ATTEND), pages: [{ title: "Course Policies", body: html(HONOR, SCHEDULE) }] };

test("answers come from the syllabus, front page and pages, labelled with where they came from", async () => {
  mockCanvas({ 1: ECON });
  const late = await ask("what's the late policy?");
  expect(late.startsWith("From ECON 210's syllabus/pages")).toBe(true);
  expect(late).toContain("[Syllabus] ");
  expect(late).toContain("lose 10% per day");
  const hours = await ask("office hours?");
  expect(hours).toContain("[Front page: Course Home]");
  expect(hours).toContain("Gardner 305");
  expect((await ask("honor code")).includes("[Page: Course Policies]")).toBe(true);
});

test("no more than 3 passages and ~2,400 characters of context ever reach the model", async () => {
  const big = Array.from({ length: 40 }, (_, i) => `Exam section ${i}: ${"The exam covers material from the readings and lectures. ".repeat(14)}`);
  mockCanvas({ 1: { ...ECON, syllabus: html(...big), front: "", pages: undefined } });
  const out = await ask("what is on the exam");
  const body = out.split("\n").slice(1).join("\n");
  expect(out.split("\n---\n").length).toBeLessThanOrEqual(3);
  expect(body.length).toBeLessThanOrEqual(MAX_CONTEXT_CHARS + 60); // + labels and the ellipsis
  expect(out.length).toBeLessThan(2_700);
});

test("when the answer isn't there, it says so plainly instead of guessing", async () => {
  mockCanvas({ 1: ECON });
  const out = await ask("what is the capital of France");
  expect(out).toMatch(/^NOT FOUND in ECON 210's syllabus or pages \(searched \d+ passages\)/);
  expect(out).toContain("Don't guess");
  expect(await ask("what is the wifi password for the building")).toMatch(/^NOT FOUND/);
});

test("a course whose syllabus is a PDF (nothing readable) says that, and PDFs are the stated limit", async () => {
  mockCanvas({ 1: { code: "ENGL150.003.FA26", name: "ENGL150.003.FA26", syllabus: "", front: undefined, pages: undefined } });
  const out = await ask("late policy", "ENGL 150");
  expect(out).toContain("ENGL 150 has no syllabus text or pages I can read");
  expect(out).toContain("PDF");
});

test("the text is cached per course for a day: the second question doesn't touch Canvas, a day later it refreshes", async () => {
  mockCanvas({ 1: ECON });
  const t0 = new Date("2026-10-16T14:00:00Z");
  await ask("late policy", "ECON 210", owner, t0);
  const first = fetchesFor(1);
  expect(first).toBeGreaterThanOrEqual(3); // syllabus, front page, pages
  await ask("office hours", "ECON 210", owner, new Date(t0.getTime() + 3 * 3600_000));
  await ask("exam", "ECON 210", owner, new Date(t0.getTime() + CACHE_TTL_MS - 60_000));
  expect(fetchesFor(1)).toBe(first); // still cached
  await ask("exam", "ECON 210", owner, new Date(t0.getTime() + CACHE_TTL_MS + 60_000));
  expect(fetchesFor(1)).toBe(first * 2); // refreshed
  expect(cachedChunks("canvas.example", 1).length).toBeGreaterThan(0);
  expect(db.query("SELECT COUNT(*) AS n FROM syllabus_meta").get()).toEqual({ n: 1 });
});

test("if Canvas is down, yesterday's cached text is still used; with no cache the error is reported", async () => {
  mockCanvas({ 1: ECON });
  const t0 = new Date("2026-10-16T14:00:00Z");
  await ask("late policy", "ECON 210", owner, t0);
  mockCanvas({ 1: { ...ECON, broken: true } });
  const out = await ask("late policy", "ECON 210", owner, new Date(t0.getTime() + 2 * CACHE_TTL_MS));
  expect(out).toContain("lose 10% per day");
  initDb(":memory:");
  expect(await runWithContext(owner, () => runSyllabusTool({ course: "ECON 210", question: "late policy" }))).toMatch(/^(Error: |No active course)/);
});

test("courses stay separate: each answer comes only from the course asked about, and unknown or ambiguous courses are refused", async () => {
  mockCanvas({
    1: ECON,
    2: { code: "DATA101.001.FA26", name: "DATA101.001.FA26", syllabus: html("Late work policy: no late work is accepted in DATA 101, no exceptions, and the lowest two quizzes are dropped."), front: undefined, pages: undefined },
  });
  const stor = await ask("late policy", "DATA 101");
  expect(stor).toContain("no late work is accepted");
  expect(stor).not.toContain("10% per day");
  const econ = await ask("late policy", "ECON 210");
  expect(econ).toContain("10% per day");
  expect(econ).not.toContain("no late work is accepted");
  expect(await ask("late policy", "BIOL 101")).toContain('No active course matches "BIOL 101"');
  expect(await ask("late policy", "1")).toMatch(/^From |^More than one/); // by id
  expect(db.query("SELECT COUNT(*) AS n FROM syllabus_meta").get()).toEqual({ n: 2 });
});

test("members can use it too (their own Canvas token and course list), and it costs no extra model call", async () => {
  mockCanvas({ 1: ECON });
  expect(toolsForRole("member").map((t) => t.function.name)).toContain("ask_syllabus");
  expect(toolsForRole("owner").map((t) => t.function.name)).toContain("ask_syllabus");
  expect(toolsForRole("owner").map((t) => t.function.name)).not.toContain("get_syllabus"); // replaced: it dumped up to 6,000 characters
  const out = await runWithContext(member, () => executeTool("ask_syllabus", { course: "econ 210", question: "when is the midterm" }, member.key));
  expect(out).toContain("midterm exam is on October 13");
});

test("tool arguments are validated", async () => {
  mockCanvas({ 1: ECON });
  expect(await runSyllabusTool({ course: "ECON 210" })).toMatch(/^Error: question is required/);
  expect(await runSyllabusTool({ question: "late policy" })).toMatch(/^Error: course is required/);
  expect(await runSyllabusTool(null)).toMatch(/^Error: question is required/);
  const long = "late policy ".repeat(100);
  expect(await runWithContext(owner, () => runSyllabusTool({ course: "ECON 210", question: long }))).toContain("lose 10% per day"); // an overlong question is clipped, not rejected
});

test("end to end with a mocked model: one lookup, a grounded answer, small token use", async () => {
  mockCanvas({ 1: ECON });
  const reqs: any[] = [];
  const llm: LlmLike = {
    chat: {
      completions: {
        create: async (p: any) => {
          reqs.push(JSON.parse(JSON.stringify(p)));
          if (reqs.length === 1)
            return { choices: [{ message: { role: "assistant", content: null, tool_calls: [{ id: "c", type: "function", function: { name: "ask_syllabus", arguments: JSON.stringify({ course: "ECON 210", question: "what is the late policy" }) } }] } }], usage: { total_tokens: 700 } };
          return { choices: [{ message: { role: "assistant", content: "Late work loses 10% per day for up to 3 days." } }], usage: { total_tokens: 900 } };
        },
      },
    },
  };
  setLlmForTests(llm);
  const reply = await runWithContext(member, () => runAgent([{ role: "user", content: "what's the late policy in econ 210" }], member.key));
  expect(reply).toBe("Late work loses 10% per day for up to 3 days.");
  expect(reqs.length).toBe(2);
  const toolMsg = reqs[1].messages.at(-1);
  expect(toolMsg.content).toContain("lose 10% per day");
  expect(toolMsg.content.length).toBeLessThan(2_700);
  expect(reqs[0].messages[0].content).toMatch(/call ask_syllabus and answer only from its text/);
});
