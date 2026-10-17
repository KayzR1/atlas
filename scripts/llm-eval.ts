/**
 * A small quality check for a model behind the provider chain: 10 prompts over FAKE Canvas data, checking that it picks the
 * right tool with valid arguments (phase "tools", one request per prompt) and answers correctly from the tool result
 * (phase "answers", a second request per prompt with a canned result). No real user data is involved: the courses are
 * DATA 101, ECON 210 and ENGL 150, and every tool result is a fixture below.
 *
 *   bun scripts/llm-eval.ts                       # a scripted mock model: checks the harness itself, calls nothing
 *   ALLOW_LIVE_EVAL=1 bun scripts/llm-eval.ts --live --targets groq:openai/gpt-oss-120b,cerebras:gpt-oss-120b --phase tools
 *
 * --live needs ALLOW_LIVE_EVAL=1 as well, so it can never run by accident. --max-calls (default 24) stops the run when
 * that many requests have been made. Requests are paced to each target's rpm. Reads the provider keys from the environment.
 */
import { buildSystemPrompt, plain, toolsForRole } from "../src/agent.ts";
import { runWithContext, type UserContext } from "../src/context.ts";
import { ensureOwner, initDb } from "../src/db.ts";
import { looksGpaRelated } from "../src/gpa.ts";
import { callLlm, configuredEntries, setLlmClockForTests, setLlmForTests, type LlmLike } from "../src/llm.ts";
import { needsCalendarTools } from "../src/calendar.ts";

const KEY = "+10000000000";
const ctx: UserContext = { key: KEY, role: "owner", timezone: "America/New_York", canvasUrl: "https://canvas.example", canvasToken: "fake" };

export type Prompt = {
  id: string;
  say: string;
  /** Tool names that are an acceptable first move (empty: it should just answer). */
  tools: string[];
  /** Extra check on the arguments of the first tool call; returns a problem or null. */
  args?: (name: string, a: any) => string | null;
  /** The canned result of that tool, fed back for the answers phase. */
  result?: string;
  /** What a correct final answer must contain (each regex), after the tool result. */
  answer: RegExp[];
};

const tomorrow = new Date(Date.UTC(2026, 9, 17, 15, 0)); // the fake "now" is Fri Oct 16 2026, 11:00 AM ET
export const NOW = new Date(Date.UTC(2026, 9, 16, 15, 0));

export const PROMPTS: Prompt[] = [
  { id: "due-week", say: "what's due this week", tools: ["get_due_overview"], args: (_n, a) => (a.days >= 1 && a.days <= 8 ? null : `days=${a.days}`),
    result: JSON.stringify({ items: [{ course: "DATA 101", name: "Lab 5", due: "Sat Oct 17 4:00 PM" }, { course: "ECON 210", name: "Problem Set 4", due: "Sun Oct 18 11:59 PM" }] }), answer: [/lab 5/i, /problem set 4/i] },
  { id: "due-tomorrow", say: "what do I have due tomorrow?", tools: ["get_due_overview"], args: (_n, a) => (a.days >= 1 && a.days <= 2 ? null : `days=${a.days}`),
    result: JSON.stringify({ items: [{ course: "DATA 101", name: "Lab 5", due: "Sat Oct 17 4:00 PM" }] }), answer: [/lab 5/i] },
  { id: "grade", say: "what's my grade in data 101", tools: ["list_courses", "grade_calc"],
    result: JSON.stringify([{ id: 1, name: "Statistics", code: "DATA101.001.FA26", current_score: 95.19, current_grade: "A" }, { id: 2, name: "Economics", code: "ECON210.001.FA26", current_score: 88.4, current_grade: "B+" }]), answer: [/95\.1|\bA\b/] },
  { id: "final", say: "what do I need on the final to get an A in econ 210", tools: ["grade_calc"], args: (_n, a) => (/econ/i.test(String(a.course)) ? null : `course=${a.course}`),
    result: "ECON 210: to finish with an A (93%) you need 94.2% on Final Exam (35% of the grade), assuming nothing else changes.", answer: [/94(\.2)?/] },
  { id: "calendar-edit", say: "move my dentist appointment tomorrow to 4pm", tools: ["find_calendar_events", "list_calendar_events", "update_calendar_event"],
    result: JSON.stringify({ matches: [{ id: "e1", title: "Dentist", start: "2026-10-17T10:00", end: "2026-10-17T11:00" }] }), answer: [/dentist/i] },
  { id: "reminder", say: "remind me to submit the lab tomorrow at 8pm", tools: ["create_reminder"], args: (_n, a) => (/lab/i.test(String(a.text)) && /T20:00/.test(String(a.when)) ? null : `text=${a.text} when=${a.when}`),
    result: "STAGED. Reply to the user with exactly the question below and nothing else: Remind you to submit the lab Sat 8pm?", answer: [/remind you to submit the lab/i, /8\s?pm/i] },
  { id: "gpa", say: "how would a B in econ 210 change my gpa this term?", tools: ["gpa_calc"], args: (_n, a) => (Array.isArray(a.whatif) && a.whatif.some((w: any) => /econ/i.test(String(w.course)) && /^b/i.test(String(w.letter))) ? null : `whatif=${JSON.stringify(a.whatif)}`),
    result: "GPA with a B in ECON 210: 3.43 (3.67 now)\n(assuming 3 credits each; text 'ECON 210 is 4 credits' to fix)", answer: [/3\.43/, /3\.67/] },
  { id: "day", say: "what does my day look like today?", tools: ["list_calendar_events", "get_due_overview"],
    result: JSON.stringify(["9:05am-9:55am DATA 101 (Sterling 120)", "2pm-3:15pm ENGL 150"]), answer: [/data 101/i, /engl 150/i] },
  { id: "late-policy", say: "what's the late policy in data 101", tools: ["ask_syllabus"], args: (_n, a) => (/data/i.test(String(a.course)) ? null : `course=${a.course}`),
    result: "From DATA 101's syllabus: Homework is accepted up to 48 hours late with a 10% penalty per day.", answer: [/10\s?%/, /48/] },
  { id: "small-talk", say: "hey", tools: [], answer: [/./] },
];

export type Row = { id: string; toolOk: boolean; argsOk: boolean; nullArgs: number; answerOk: boolean | null; note: string; stepped?: boolean };
export type TargetResult = { target: string; rows: Row[]; calls: number; ms: number; tokens: number };

/** Models like gpt-oss write non-breaking spaces and fancy dashes ("Lab\u00a05"); that is not a wrong answer. */
export const normalize = (t: string) => t.replace(/[\u00a0\u202f\u2009\u2007]/g, " ").replace(/[\u2010-\u2015\u2212]/g, "-");
const BAD_STYLE = /\*\*|^#{1,6}\s|`|let me know how you'd like to proceed|i can'?t compute/im;
const nullish = (v: any): number => (v === null || v === "" ? 1 : v && typeof v === "object" ? Object.values(v).reduce((n: number, x: any) => n + nullish(x), 0) : 0);

export async function runTarget(target: string, phase: "tools" | "answers", opts: { maxCalls: number; used: { n: number }; pace?: (ms: number) => Promise<void>; only?: string[] }): Promise<TargetResult> {
  const [provider, ...rest] = target.split(":");
  process.env.LLM_PROVIDERS = `${provider}:${rest.join(":")}`;
  const entry = configuredEntries()[0]!;
  const gap = entry.rpm ? Math.ceil(60_000 / entry.rpm) + 500 : 0;
  const res: TargetResult = { target, rows: [], calls: 0, ms: 0, tokens: 0 };
  const call = async (messages: any[], tools: any[]) => {
    if (opts.used.n >= opts.maxCalls) throw new Error(`--max-calls ${opts.maxCalls} reached`);
    opts.used.n++;
    if (gap && res.calls > 0) await (opts.pace ?? ((ms) => Bun.sleep(ms)))(gap);
    const t0 = Date.now();
    const r = await callLlm({ messages, tools, tool_choice: "auto", parallel_tool_calls: false, max_completion_tokens: 600 });
    res.ms += Date.now() - t0; res.calls++; res.tokens += r.res.usage?.total_tokens ?? 0;
    return r.res.choices?.[0]?.message ?? {};
  };
  for (const p of PROMPTS.filter((x) => !opts.only?.length || opts.only.includes(x.id))) {
    const calendar = needsCalendarTools(KEY, [{ role: "user", content: p.say }]);
    const tools = toolsForRole("owner", { calendar, gpa: looksGpaRelated(p.say) });
    const system = buildSystemPrompt(KEY, { calendar, gpa: looksGpaRelated(p.say) });
    const base = [{ role: "system", content: system }, { role: "user", content: p.say }];
    const row: Row = { id: p.id, toolOk: false, argsOk: true, nullArgs: 0, answerOk: null, note: "" };
    try {
      const m = await call(base, tools);
      const tc = m.tool_calls?.[0];
      if (!p.tools.length) {
        row.toolOk = !tc && !!m.content;
        row.answerOk = row.toolOk && !BAD_STYLE.test(plain(String(m.content))) && String(m.content).length < 400;
        row.note = tc ? `called ${tc.function?.name} for small talk` : "";
      } else if (!tc) {
        row.note = "answered without a tool";
      } else {
        const name = tc.function?.name as string;
        let args: any = null;
        try { args = JSON.parse(tc.function?.arguments || "{}"); } catch { row.argsOk = false; row.note = "arguments were not JSON"; }
        row.toolOk = p.tools.includes(name) && tools.some((t) => t.function.name === name);
        if (!row.toolOk) row.note = `chose ${name}`;
        if (args) {
          row.nullArgs = nullish(args);
          const problem = p.args?.(name, args) ?? null;
          if (problem && p.tools[0] === name) { row.argsOk = false; row.note = problem; }
        }
        if (phase === "answers" && row.toolOk && p.result) {
          const follow = await call([...base, { role: "assistant", content: null, tool_calls: [tc] }, { role: "tool", tool_call_id: tc.id, content: p.result }], tools);
          if (follow.tool_calls?.length) {
            // a read followed by another step (find an event, then update it) is normal; the answer isn't judged until the chain ends
            row.stepped = true;
            row.answerOk = null;
            row.note ||= `continued with ${follow.tool_calls[0]?.function?.name}`;
          } else {
            // judged the way the user sees it: after the same markdown clean-up the bot applies
            const text = normalize(plain(String(follow.content ?? "")));
            const missing = p.answer.filter((r) => !r.test(text)).map((r) => String(r));
            row.answerOk = !missing.length && !BAD_STYLE.test(text);
            if (!row.answerOk) row.note ||= missing.length ? `missing ${missing.join(" ")} in: ${text.slice(0, 160).replace(/\s+/g, " ")}` : `style: ${text.slice(0, 160).replace(/\s+/g, " ")}`;
          }
        }
      }
    } catch (e) {
      row.note = `error: ${e instanceof Error ? e.message.slice(0, 80) : e}`;
    }
    res.rows.push(row);
  }
  return res;
}

export function table(results: TargetResult[], phase: string): string {
  const ids = PROMPTS.map((p) => p.id).filter((id) => results.some((r) => r.rows.some((x) => x.id === id))); // (a --only run shows just its prompts)
  const mark = (r: Row) => (r.toolOk && r.argsOk && r.answerOk !== false ? (r.stepped ? "pass*" : "pass") : "FAIL");
  const w = Math.max(...results.map((r) => r.target.length), 12);
  const lines = [`${"prompt".padEnd(14)}${results.map((r) => r.target.padEnd(w + 2)).join("")}`];
  for (const id of ids) lines.push(`${id.padEnd(14)}${results.map((r) => { const row = r.rows.find((x) => x.id === id) ?? { id, toolOk: false, argsOk: true, nullArgs: 0, answerOk: false, note: "not run" } as Row; return (mark(row) + (row.note ? ` (${row.note})` : "")).slice(0, w + 1).padEnd(w + 2); }).join("")}`);
  lines.push(`${"score".padEnd(14)}${results.map((r) => `${r.rows.filter((x) => mark(x) !== "FAIL").length}/${r.rows.length}`.padEnd(w + 2)).join("")}`);
  lines.push(`${"null/'' args".padEnd(14)}${results.map((r) => String(r.rows.reduce((n, x) => n + x.nullArgs, 0)).padEnd(w + 2)).join("")}`);
  lines.push(`${"requests".padEnd(14)}${results.map((r) => String(r.calls).padEnd(w + 2)).join("")}`);
  lines.push(`${"avg latency".padEnd(14)}${results.map((r) => `${Math.round(r.ms / Math.max(1, r.calls))}ms`.padEnd(w + 2)).join("")}`);
  lines.push(`${"tokens".padEnd(14)}${results.map((r) => String(r.tokens).padEnd(w + 2)).join("")}   (phase: ${phase})`);
  lines.push("\npass* = right tool, then the model continued with another step (not judged further).");
  const details = results.flatMap((r) => r.rows.filter((x) => x.note).map((x) => `  ${r.target} / ${x.id}: ${x.note}`));
  if (details.length) lines.push("\nDetails:", ...details);
  return lines.join("\n");
}

/** A scripted stand-in so the harness can be checked with no provider at all: it answers each prompt the way a good model would. */
export function scriptedModel(skill: "good" | "sloppy"): LlmLike {
  const first = (say: string) => PROMPTS.find((p) => p.say === say)!;
  const toolArgs: Record<string, any> = {
    "due-week": { days: 3 }, "due-tomorrow": { days: 1 }, grade: {}, final: { course: "ECON 210", target: "A", assignment: "final exam" },
    "calendar-edit": { query: "dentist" }, reminder: { text: "submit the lab", when: "2026-10-17T20:00" }, gpa: { whatif: [{ course: "econ 210", letter: "B" }] },
    day: { date: "2026-10-16" }, "late-policy": { course: "DATA 101", question: "late policy" },
  };
  return { chat: { completions: { create: async (p: any) => {
    const last = p.messages.at(-1);
    const user = [...p.messages].reverse().find((m: any) => m.role === "user");
    const prompt = first(user.content);
    const usage = { total_tokens: 100 };
    if (last.role === "tool") return { choices: [{ message: { role: "assistant", content: skill === "good" ? `${prompt.answer.map((r) => r.source.replace(/\\/g, "").replace(/[()?|]/g, " ").split(" ")[0]).join(" and ")} ${last.content}`.slice(0, 300) : "**Sure!** let me know how you'd like to proceed" } }], usage };
    if (!prompt.tools.length) return { choices: [{ message: { role: "assistant", content: "Hey! What can I help you with?" } }], usage };
    const name = skill === "good" ? prompt.tools[0]! : "list_courses";
    const args = skill === "good" ? toolArgs[prompt.id] : { x: null, y: "" };
    return { choices: [{ message: { role: "assistant", content: null, tool_calls: [{ id: "c1", type: "function", function: { name, arguments: JSON.stringify(args) } }] } }], usage };
  } } } };
}

if (import.meta.main) {
  const argv = process.argv.slice(2);
  const flag = (n: string) => argv.includes(`--${n}`);
  const val = (n: string, d: string) => argv[argv.indexOf(`--${n}`) + 1] && argv.includes(`--${n}`) ? argv[argv.indexOf(`--${n}`) + 1]! : d;
  const phase = val("phase", "tools") as "tools" | "answers";
  const maxCalls = Number(val("max-calls", "24"));
  const only = val("only", "").split(",").filter(Boolean);
  initDb(":memory:");
  ensureOwner(KEY);
  const used = { n: 0 };
  let fakeT = 0;
  if (flag("live")) {
    if (process.env.ALLOW_LIVE_EVAL !== "1") {
      console.error("Refusing a live run: set ALLOW_LIVE_EVAL=1 as well as --live. (It makes about 1 request per prompt per target, 2 with --phase answers.)");
      process.exit(2);
    }
  } else {
    setLlmForTests({ groq: scriptedModel("good"), cerebras: scriptedModel("sloppy") });
    process.env.CEREBRAS_API_KEY ||= "unused-mock";
    setLlmClockForTests({ now: () => fakeT, sleep: async (ms) => void (fakeT += ms) }); // pacing without waiting
  }
  const targets = flag("live") ? val("targets", "groq:openai/gpt-oss-120b,cerebras:gpt-oss-120b").split(",") : ["groq:openai/gpt-oss-120b", "cerebras:gpt-oss-120b"];
  const results: TargetResult[] = [];
  await runWithContext(ctx, async () => {
    for (const t of targets) results.push(await runTarget(t, phase, { maxCalls, used, only, pace: flag("live") ? undefined : async (ms) => void (fakeT += ms) }));
  });
  console.log(`${flag("live") ? "LIVE" : "MOCK (scripted models, no provider called)"} eval, fake Canvas data, ${used.n} request(s):\n`);
  console.log(table(results, phase));
}
