import { afterEach, beforeEach, expect, test } from "bun:test";
import { runWithContext, type UserContext } from "../src/context.ts";
import { ensureOwner, initDb } from "../src/db.ts";
import { resetModelCooldowns, setLlmClockForTests, setLlmForTests } from "../src/llm.ts";
import { PROMPTS, runTarget, scriptedModel, table } from "../scripts/llm-eval.ts";

const ctx: UserContext = { key: "+10000000000", role: "owner", timezone: "America/New_York", canvasUrl: "https://canvas.example", canvasToken: "fake" };
let fakeT: number;
const realEnv = { ...process.env };

beforeEach(() => {
  initDb(":memory:");
  ensureOwner(ctx.key);
  resetModelCooldowns();
  fakeT = 0;
  setLlmClockForTests({ now: () => fakeT, sleep: async (ms) => void (fakeT += ms) });
  setLlmForTests({ groq: scriptedModel("good"), cerebras: scriptedModel("sloppy") });
  process.env.CEREBRAS_API_KEY = "dummy";
});
afterEach(() => {
  setLlmForTests();
  setLlmClockForTests();
  for (const k of ["LLM_PROVIDERS", "CEREBRAS_API_KEY"]) (realEnv[k] === undefined ? delete process.env[k] : (process.env[k] = realEnv[k]));
});

const run = (target: string, phase: "tools" | "answers", maxCalls = 100) =>
  runWithContext(ctx, () => runTarget(target, phase, { maxCalls, used: { n: 0 }, pace: async (ms) => void (fakeT += ms) }));

test("the eval has 10 prompts over fake data only, covering due dates, grades, calendar edit, GPA and the day view", () => {
  expect(PROMPTS).toHaveLength(10);
  const ids = PROMPTS.map((p) => p.id);
  for (const want of ["due-week", "grade", "final", "calendar-edit", "reminder", "gpa", "day", "late-policy", "small-talk"]) expect(ids).toContain(want);
  const text = JSON.stringify(PROMPTS.map((p) => [p.say, p.result]));
  expect(text).toMatch(/DATA 101|ECON 210/);
  expect(text).not.toMatch(/\+1\d{10}|@[a-z]+\.(com|edu)/);
});

test("a model that picks the right tools and answers from the results scores 10/10; a sloppy one does not", async () => {
  const good = await run("groq:openai/gpt-oss-120b", "answers");
  expect(good.rows.map((r) => `${r.id}:${r.toolOk && r.argsOk && r.answerOk !== false}`).filter((x) => x.endsWith("false"))).toEqual([]);
  expect(good.calls).toBe(19); // 9 tool prompts x 2 requests + 1 small talk
  const bad = await run("cerebras:gpt-oss-120b", "answers");
  expect(bad.rows.filter((r) => r.toolOk && r.argsOk && r.answerOk !== false).length).toBeLessThan(3);
  expect(bad.rows.reduce((n, r) => n + r.nullArgs, 0)).toBeGreaterThan(0); // null / empty arguments are counted
  const t = table([good, bad], "answers");
  expect(t).toContain("groq:openai/gpt-oss-120b");
  expect(t).toMatch(/score\s+10\/10\s+[0-2]\/10/);
});

test("the tools phase makes one request per prompt, and --max-calls stops a run", async () => {
  const r = await run("groq:openai/gpt-oss-120b", "tools");
  expect(r.calls).toBe(10);
  const capped = await runWithContext(ctx, () => runTarget("groq:openai/gpt-oss-120b", "tools", { maxCalls: 4, used: { n: 0 }, pace: async () => {} }));
  expect(capped.calls).toBe(4);
  expect(capped.rows.filter((x) => x.note.includes("--max-calls 4 reached"))).toHaveLength(6);
});

test("a live run is refused without ALLOW_LIVE_EVAL=1, before any network", async () => {
  const env = { ...process.env, ALLOW_LIVE_EVAL: "" };
  delete (env as any).ALLOW_LIVE_EVAL;
  const p = Bun.spawn(["bun", "scripts/llm-eval.ts", "--live"], { env, stdout: "pipe", stderr: "pipe" });
  const [out, err, code] = [await new Response(p.stdout).text(), await new Response(p.stderr).text(), await p.exited];
  expect(code).toBe(2);
  expect(err).toContain("Refusing a live run: set ALLOW_LIVE_EVAL=1");
  expect(out).not.toContain("LIVE eval");
});

const reply = (message: any) => ({ choices: [{ message }], usage: { total_tokens: 10 } });
const toolCall = (name: string, args: any) => ({ role: "assistant", content: null, tool_calls: [{ id: "c", type: "function", function: { name, arguments: JSON.stringify(args) } }] });

test("answers are judged after the bot's own markdown clean-up (bold is not a failure)", async () => {
  setLlmForTests({ groq: { chat: { completions: { create: async (p: any) => (p.messages.at(-1).role === "tool" ? reply({ role: "assistant", content: "**Lab 5** is due Saturday and **Problem Set 4** is due Sunday." }) : reply(toolCall("get_due_overview", { days: 3 }))) } } } });
  const r = await runWithContext(ctx, () => runTarget("groq:openai/gpt-oss-120b", "answers", { maxCalls: 100, used: { n: 0 }, only: ["due-week"] }));
  expect(r.rows).toHaveLength(1);
  expect(r.rows[0]).toMatchObject({ toolOk: true, argsOk: true, answerOk: true });
});

test("a model that continues with another step is 'pass*', not a failure; a missing fact is reported in full", async () => {
  setLlmForTests({ groq: { chat: { completions: { create: async (p: any) => {
    const last = p.messages.at(-1);
    if (last.role !== "tool") return reply(toolCall(p.messages.at(-1).content.includes("dentist") ? "find_calendar_events" : "get_due_overview", { days: 3, query: "dentist" }));
    return p.messages.some((m: any) => m.role === "user" && m.content.includes("dentist")) ? reply(toolCall("update_calendar_event", { id: "e1" })) : reply({ role: "assistant", content: "You have a lab." });
  } } } } });
  const r = await runWithContext(ctx, () => runTarget("groq:openai/gpt-oss-120b", "answers", { maxCalls: 100, used: { n: 0 }, only: ["calendar-edit", "due-week"] }));
  const edit = r.rows.find((x) => x.id === "calendar-edit")!, due = r.rows.find((x) => x.id === "due-week")!;
  expect(edit).toMatchObject({ toolOk: true, stepped: true, answerOk: null });
  expect(edit!.note).toBe("continued with update_calendar_event");
  expect(due!.answerOk).toBe(false);
  expect(due!.note).toContain("missing /lab 5/i /problem set 4/i in: You have a lab.");
  const t = table([r], "answers");
  expect(t).toContain("pass*");
  expect(t).toMatch(/score\s+1\/2/);
  expect(t).toContain("Details:");
  expect(t).toContain("groq:openai/gpt-oss-120b / due-week: missing");
});

test("--only reruns just the named prompts", async () => {
  const r = await runWithContext(ctx, () => runTarget("groq:openai/gpt-oss-120b", "tools", { maxCalls: 100, used: { n: 0 }, only: ["gpa", "small-talk"] }));
  expect(r.rows.map((x) => x.id)).toEqual(["gpa", "small-talk"]);
  expect(r.calls).toBe(2);
});

test("non-breaking spaces and fancy dashes in an answer are not a wrong answer", async () => {
  const nb = "\u00a0", nnb = "\u202f";
  setLlmForTests({ groq: { chat: { completions: { create: async (p: any) => (p.messages.at(-1).role === "tool" ? reply({ role: "assistant", content: `DATA${nb}101 \u2013 Lab${nb}5 due Sat; ECON${nnb}210 \u2013 Problem${nb}Set${nb}4 due Sun.` }) : reply(toolCall("get_due_overview", { days: 3 }))) } } } });
  const r = await runWithContext(ctx, () => runTarget("groq:openai/gpt-oss-120b", "answers", { maxCalls: 100, used: { n: 0 }, only: ["due-week"] }));
  expect(r.rows[0]).toMatchObject({ toolOk: true, answerOk: true });
  const { normalize } = await import("../scripts/llm-eval.ts");
  expect(normalize(`a${nb}b${nnb}c \u2011 d`)).toBe("a b c - d");
});
