import { courseLabel } from "./assignments.ts";
import { fetchCourseContentRaw, listCourses } from "./canvas.ts";
import { requireContext } from "./context.ts";
import { db } from "./db.ts";
import { matchCourse } from "./grades.ts";

// "Ask my syllabus": cache a course's readable text in SQLite, find the few passages that matter with plain BM25
// (no embeddings, no new services), and hand only those to the model.

export const CHUNK_CHARS = 800;
export const TOP_K = 3;
export const MAX_CONTEXT_CHARS = 2_400; // about 450 tokens: the most the model ever sees from a syllabus
export const MAX_CHUNKS_PER_COURSE = 300;
export const CACHE_TTL_MS = 24 * 3600_000;
export const MIN_SCORE = 0.25;
const PHRASE_BONUS = 1.5; // two query words that sit next to each other in a passage ("office hours") are strong evidence
const MIN_IDF = 0.3; // in a course with one or two passages every term is "common"; a match must still count

export type Chunk = { source: string; text: string };

// ---------- chunking ----------

function splitLong(p: string, size: number): string[] {
  const out: string[] = [];
  let cur = "";
  for (const sentence of p.split(/(?<=[.!?])\s+/)) {
    if (cur && (cur + " " + sentence).length > size) {
      out.push(cur);
      cur = "";
    }
    if (sentence.length > size) {
      // a single sentence longer than a chunk: cut at word boundaries
      for (const word of sentence.split(/\s+/)) {
        if (cur && (cur + " " + word).length > size) {
          out.push(cur);
          cur = "";
        }
        cur = cur ? cur + " " + word : word;
      }
    } else cur = cur ? cur + " " + sentence : sentence;
  }
  if (cur) out.push(cur);
  return out;
}

/** About `size` characters per chunk, split on paragraph boundaries where possible (never mid-word). */
export function chunkText(text: string, size = CHUNK_CHARS): string[] {
  const out: string[] = [];
  let cur = "";
  const flush = () => {
    if (cur.trim()) out.push(cur.trim());
    cur = "";
  };
  for (const para of text.split(/\n{2,}/).map((p) => p.trim()).filter(Boolean)) {
    if (para.length > size) {
      flush();
      out.push(...splitLong(para, size));
      continue;
    }
    if (cur && (cur + "\n\n" + para).length > size) flush();
    cur = cur ? cur + "\n\n" + para : para;
  }
  flush();
  return out;
}

// ---------- BM25 ----------

const STOP = new Set(
  "a an and are as at be but by can could do does for from had has have how i if in is it its me my of on or our should so than that the their then there these they this to was we were what when where which who will with would you your about any much many get got".split(" "),
);

// small, deliberately boring: words people use vs words syllabi use
const SYNONYMS: Record<string, string[]> = {
  late: ["deadline", "extension", "penalty"],
  midterm: ["exam", "test"],
  final: ["exam"],
  exam: ["test", "midterm", "final"],
  test: ["exam", "quiz"],
  hour: ["office"],
  office: ["hour"],
  grade: ["grading", "point"],
  grading: ["grade", "point"],
  cheat: ["plagiarism", "integrity", "honor"],
  attendance: ["absence", "absent", "miss"],
  absent: ["attendance", "absence"],
  miss: ["absence", "makeup", "attendance"],
  textbook: ["book", "reading", "material"],
  email: ["contact", "instructor"],
  professor: ["instructor", "faculty"],
  drop: ["withdraw"],
};

export function stem(w: string): string {
  if (w.length <= 4) return w;
  return w.replace(/ies$/, "y").replace(/(ing|ed|es|s)$/, "");
}

export function tokenize(s: string): string[] {
  return s.toLowerCase().split(/[^a-z0-9]+/).filter((w) => w.length > 1 && !STOP.has(w)).map(stem);
}

type Scored = { chunk: Chunk; score: number };

export function rank(query: string, chunks: Chunk[], k = TOP_K): Scored[] {
  const ordered = tokenize(query);
  const pairs: [string, string][] = [];
  for (let i = 0; i + 1 < ordered.length; i++) if (ordered[i] !== ordered[i + 1]) pairs.push([ordered[i]!, ordered[i + 1]!]);
  const base = [...new Set(ordered)];
  const weights = new Map<string, number>(base.map((t) => [t, 1]));
  for (const t of base) for (const syn of SYNONYMS[t] ?? []) if (!weights.has(stem(syn))) weights.set(stem(syn), 0.5);
  if (!weights.size || !chunks.length) return [];

  const docs = chunks.map((c) => tokenize(`${c.source} ${c.text}`));
  const N = docs.length, avg = docs.reduce((s, d) => s + d.length, 0) / N || 1;
  const df = new Map<string, number>();
  for (const d of docs) for (const t of new Set(d)) df.set(t, (df.get(t) ?? 0) + 1);
  const k1 = 1.5, b = 0.75;

  return chunks
    .map((chunk, i) => {
      const d = docs[i]!;
      const tf = new Map<string, number>();
      for (const t of d) tf.set(t, (tf.get(t) ?? 0) + 1);
      let score = 0;
      for (const [term, w] of weights) {
        const f = tf.get(term) ?? 0;
        if (!f) continue;
        const n = df.get(term) ?? 0;
        const idf = Math.max(MIN_IDF, Math.log(1 + (N - n + 0.5) / (n + 0.5)));
        score += w * idf * ((f * (k1 + 1)) / (f + k1 * (1 - b + (b * d.length) / avg)));
      }
      if (score > 0) for (const [a, z] of pairs) for (let i = 0; i + 1 < d.length; i++) if (d[i] === a && d[i + 1] === z) { score += PHRASE_BONUS; break; }
      return { chunk, score };
    })
    .filter((s) => s.score > 0)
    .sort((a, z) => z.score - a.score)
    .slice(0, k);
}

// ---------- the per-course cache ----------

function build(content: Awaited<ReturnType<typeof fetchCourseContentRaw>>): Chunk[] {
  const out: Chunk[] = [];
  const add = (source: string, text: string) => chunkText(text).forEach((t) => out.push({ source, text: t }));
  add("Syllabus", content.syllabus);
  if (content.front) add(content.front.title === "Front page" ? "Front page" : `Front page: ${content.front.title}`, content.front.body);
  for (const p of content.pages) add(`Page: ${p.title}`, p.body);
  return out.slice(0, MAX_CHUNKS_PER_COURSE);
}

export function cachedChunks(host: string, courseId: number): Chunk[] {
  return db.query<Chunk, [string, number]>("SELECT source, text FROM syllabus_chunks WHERE host = ? AND course_id = ? ORDER BY idx").all(host, courseId);
}

function store(host: string, courseId: number, chunks: Chunk[], now: Date) {
  db.transaction(() => {
    db.run("DELETE FROM syllabus_chunks WHERE host = ? AND course_id = ?", [host, courseId]);
    chunks.forEach((c, i) => db.run("INSERT INTO syllabus_chunks (host, course_id, idx, source, text) VALUES (?, ?, ?, ?, ?)", [host, courseId, i, c.source, c.text]));
    db.run("INSERT INTO syllabus_meta (host, course_id, fetched_at, n_chunks) VALUES (?, ?, ?, ?) ON CONFLICT(host, course_id) DO UPDATE SET fetched_at = excluded.fetched_at, n_chunks = excluded.n_chunks", [host, courseId, now.getTime(), chunks.length]);
  })();
}

/** Chunks for a course, refreshed from Canvas at most once a day (a stale cache is used if Canvas is unreachable). */
export async function courseChunks(host: string, courseId: number, now = new Date()): Promise<Chunk[]> {
  const meta = db.query<{ fetched_at: number }, [string, number]>("SELECT fetched_at FROM syllabus_meta WHERE host = ? AND course_id = ?").get(host, courseId);
  if (meta && now.getTime() - meta.fetched_at < CACHE_TTL_MS) return cachedChunks(host, courseId);
  try {
    const chunks = build(await fetchCourseContentRaw(courseId));
    store(host, courseId, chunks, now);
    return chunks;
  } catch (e) {
    if (meta) return cachedChunks(host, courseId);
    throw e;
  }
}

// ---------- the answer ----------

export async function askSyllabus(args: { course: string; question: string }, now = new Date()): Promise<string> {
  const ctx = requireContext();
  const question = args.question.trim().slice(0, 300);
  const courses = await listCourses();
  const hits = matchCourse(args.course, courses);
  if (!hits.length) return `No active course matches "${args.course}". Courses: ${courses.map((c) => courseLabel(c)).join("; ")}.`;
  if (hits.length > 1) return `More than one course matches "${args.course}": ${hits.map((c) => courseLabel(c)).join("; ")}. Ask which.`;
  const course = hits[0]!;
  const label = courseLabel(course);

  const chunks = await courseChunks(new URL(ctx.canvasUrl).host, course.id, now);
  if (!chunks.length) return `${label} has no syllabus text or pages I can read (its syllabus may be a PDF or file, which I can't open yet). Tell the user.`;

  const top = rank(question, chunks);
  if (!top.length || top[0]!.score < MIN_SCORE) {
    return `NOT FOUND in ${label}'s syllabus or pages (searched ${chunks.length} passages). Tell the user it isn't there; it may be in a PDF or the professor may need to say. Don't guess.`;
  }
  let budget = MAX_CONTEXT_CHARS;
  const parts: string[] = [];
  for (const { chunk } of top) {
    if (budget <= 80) break;
    const text = chunk.text.length > budget ? chunk.text.slice(0, budget) + "…" : chunk.text;
    parts.push(`[${chunk.source}] ${text}`);
    budget -= text.length;
  }
  return `From ${label}'s syllabus/pages (answer only from this; keep dates, numbers and policy wording exact):\n${parts.join("\n---\n")}`;
}

export const syllabusTools = [
  {
    type: "function" as const,
    function: {
      name: "ask_syllabus",
      description: "Look up a course's policy/exam/office-hours answer in its syllabus and pages.",
      parameters: { type: "object", properties: { course: { type: "string" }, question: { type: "string" } }, required: ["course", "question"] },
    },
  },
];

export async function runSyllabusTool(rawArgs: any): Promise<string> {
  try {
    const a = rawArgs ?? {};
    if (typeof a.question !== "string" || !a.question.trim()) return "Error: question is required";
    if (a.course == null || !String(a.course).trim()) return 'Error: course is required (e.g. "ECON 210")';
    return await askSyllabus({ course: String(a.course).trim(), question: a.question });
  } catch (e) {
    return `Error: ${e instanceof Error ? e.message : String(e)}`;
  }
}
