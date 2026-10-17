import { afterEach, beforeEach, expect, spyOn, test } from "bun:test";
import {
  buildSystemPrompt, classifyRateLimit, executeTool, modelChain, rateLimitedMessage, RateLimited, resetModelCooldowns, runAgent, setLlmForTests, toolsForRole, trimHistory,
  type LlmLike,
} from "../src/agent.ts";
import { dueWindow, formatDue, parseDueQuery } from "../src/assignments.ts";
import { dailyCap, isOverBudget, LIMIT_MSG, recordTokens } from "../src/budget.ts";
import { dueText } from "../src/canvas.ts";
import { runWithContext, type UserContext } from "../src/context.ts";
import { addTokens, db, initDb, tokensToday } from "../src/db.ts";
import { handleConfirmation } from "../src/calendar.ts";
import { addMember, ALICE, harness, OWNER } from "./helpers.ts";

const NOW = new Date("2026-10-16T14:00:00Z"); // Fri Oct 16, 10:00 AM EDT
const ctx = (role: "owner" | "member", key = OWNER): UserContext => ({ key, role, timezone: "America/New_York", canvasUrl: "https://canvas.example", canvasToken: "tok" });
const realFetch = globalThis.fetch;
const realEnv = { ...process.env };

beforeEach(() => {
  initDb(":memory:");
  resetModelCooldowns();
});
afterEach(() => {
  globalThis.fetch = realFetch;
  setLlmForTests();
  resetModelCooldowns();
  for (const k of ["LLM_DAILY_TOKENS_OWNER", "LLM_DAILY_TOKENS_PER_USER", "LLM_MODEL", "LLM_MODELS", "LLM_REASONING_EFFORT", "LLM_MAX_OUTPUT_TOKENS"]) {
    if (realEnv[k] === undefined) delete process.env[k];
    else process.env[k] = realEnv[k];
  }
});

const json = (o: unknown) => new Response(JSON.stringify(o), { status: 200, headers: { "content-type": "application/json" } });
const sub = (o: any = {}) => ({ score: null, workflow_state: "unsubmitted", submitted_at: null, missing: false, excused: false, ...o });
const asg = (id: number, name: string, dueHoursFromNow: number | null, o: any = {}) => ({
  id, name, due_at: dueHoursFromNow === null ? null : new Date(NOW.getTime() + dueHoursFromNow * 3600_000).toISOString(),
  points_possible: 10, submission_types: ["online_upload"], submission: sub(), ...o,
});

/** Mock Canvas: courses + per-course assignments. Any other host is an error (nothing may reach Groq). */
function mockCanvas(assignments: Record<number, any[]>, failing: number[] = []) {
  const courses = [
    { id: 1, name: "Statistics", course_code: "DATA101.001.FA26", enrollments: [{ type: "student", computed_current_score: 95.19, computed_current_grade: "A" }] },
    { id: 2, name: "Econ", course_code: "ECON210.002.FA26", enrollments: [{ type: "student", computed_current_score: 92.7, computed_current_grade: "A-" }] },
  ];
  globalThis.fetch = (async (url: any) => {
    const u = String(url);
    if (!u.startsWith("https://canvas.example/")) throw new Error(`unexpected network call: ${u}`);
    const m = u.match(/\/courses\/(\d+)\/assignments/);
    if (m) return failing.includes(+m[1]!) ? new Response("boom", { status: 500 }) : json(assignments[+m[1]!] ?? []);
    if (u.includes("/courses?")) return json(courses);
    return new Response("nope", { status: 404 });
  }) as any;
}

// ---------- the zero-LLM fast path ----------

test("parseDueQuery: plain 'what's due' requests match, anything with extra words does not", () => {
  const week = ["what's due this week", "What’s due this week?", "whats due this week", "due this week", "what is due this week", "do i have anything due this week", "anything due this week?", "what do i have due this week"];
  for (const q of week) expect(parseDueQuery(q), q).toBe("week");
  for (const q of ["/due", "due", "what's due", "Whats due?", "what's due soon", "/due soon", "anything due", "what do i have due", "what's coming up"]) expect(parseDueQuery(q), q).toBe("7d");
  expect(parseDueQuery("what's due today")).toBe("today");
  expect(parseDueQuery("/due today")).toBe("today");
  expect(parseDueQuery("what's due tomorrow?")).toBe("tomorrow");
  for (const q of ["when is my data 101 quiz due", "what's due in econ", "what is due this week in data 101", "is the essay due friday", "hey", "what's my grade", "due dates for finals please", ""]) {
    expect(parseDueQuery(q), q).toBeNull(); // these need the model
  }
});

test("dueWindow: 'this week' ends Sunday night in the user's timezone", () => {
  const fri = dueWindow("week", NOW, "America/New_York");
  expect(fri.until.toISOString()).toBe("2026-10-19T03:59:59.999Z"); // Sun Oct 18 11:59:59 PM EDT
  const sun = dueWindow("week", new Date("2026-10-18T20:00:00Z"), "America/New_York"); // Sunday afternoon
  expect(sun.until.toISOString()).toBe("2026-10-19T03:59:59.999Z"); // tonight, not next week
  expect(dueWindow("today", NOW, "America/New_York").until.toISOString()).toBe("2026-10-17T03:59:59.999Z");
  expect(dueWindow("tomorrow", NOW, "America/New_York").until.toISOString()).toBe("2026-10-18T03:59:59.999Z");
  expect(dueWindow("7d", NOW, "America/New_York").until.toISOString()).toBe("2026-10-23T14:00:00.000Z");
});

test("dueText: one answer across all courses; submitted, undated, past and out-of-window work are left out", async () => {
  mockCanvas({
    1: [asg(10, "Quiz 5", 30), asg(11, "Already submitted", 5, { submission: sub({ submitted_at: "2026-10-15T00:00:00Z", workflow_state: "submitted" }) }), asg(12, "No due date", null), asg(13, "Too far", 24 * 9)],
    2: [asg(20, "Group  Assignment #6", 5), asg(21, "Attendance", 8, { submission_types: ["none"] }), asg(22, "Graded already", 6, { submission: sub({ score: 9 }) }), asg(23, "Overdue", -3)],
  });
  const out = await runWithContext(ctx("owner"), () => dueText("week", NOW));
  expect(out).toBe("Due through Sunday:\nFri 3:00 PM - ECON 210: Group Assignment #6\nSat 4:00 PM - DATA 101: Quiz 5");
  expect(await runWithContext(ctx("owner"), () => dueText("today", NOW))).toBe("Due today:\nFri 3:00 PM - ECON 210: Group Assignment #6");
  mockCanvas({});
  expect(await runWithContext(ctx("owner"), () => dueText("week", NOW))).toBe("Nothing due through Sunday.");
  mockCanvas({ 1: [asg(10, "Quiz 5", 30)] }, [2]);
  expect(await runWithContext(ctx("owner"), () => dueText("week", NOW))).toContain("(couldn't check 1 course)");
  expect(formatDue(Array.from({ length: 20 }, (_, i) => ({ due: new Date(NOW.getTime() + i * 3600_000).toISOString(), course: "X 1", name: `HW ${i}` })), "America/New_York", NOW, "Due:", "none").split("\n").at(-1)).toBe("+5 more");
});

test("'what's due' is answered by code: no LLM call, no tokens, and it works even when the quota is gone", async () => {
  mockCanvas({ 1: [asg(10, "Quiz 5", 30)] });
  let llmCalls = 0;
  setLlmForTests({ chat: { completions: { create: async () => (llmCalls++, { choices: [], usage: { total_tokens: 999 } }) } } });
  const h = await harness({ agent: runAgent });
  h.deps.due = (scope) => dueText(scope, NOW);
  await addMember(ALICE);
  // make Alice's canvas calls hit the mock instead of the real host
  db.run("UPDATE users SET canvas_url = 'https://uncch.instructure.com' WHERE phone = ?", [ALICE]);
  globalThis.fetch = ((orig) => (async (url: any, init: any) => orig(String(url).replace("https://uncch.instructure.com", "https://canvas.example"), init)) as any)(globalThis.fetch);

  addTokens(ALICE, new Date().toLocaleDateString("en-CA", { timeZone: "America/New_York" }), 60_000); // over her 50K cap
  await h.say("what's due this week", ALICE);
  expect(h.lastTo(ALICE)).toBe("Due through Sunday:\nSat 4:00 PM - DATA 101: Quiz 5");
  await h.say("/due", ALICE);
  expect(h.lastTo(ALICE)).toMatch(/^Due in the next 7 days:/);
  expect(llmCalls).toBe(0);
  expect(h.sent.filter((s) => s.to === ALICE).map((s) => s.text).includes(LIMIT_MSG)).toBe(false);
  // anything that does need the model is blocked by the quota
  await h.say("explain my syllabus", ALICE);
  expect(h.lastTo(ALICE)).toBe(LIMIT_MSG);
  expect(llmCalls).toBe(0);
});

test("a question that merely contains 'due' still goes to the model", async () => {
  const h = await harness();
  h.deps.due = async () => "SHOULD NOT BE USED";
  await h.say("when is my data 101 quiz due", OWNER);
  expect(h.lastTo(OWNER)).toBe("agent answer");
  expect(h.agentCalls()).toBe(1);
});

test("the fast path fails soft when Canvas is down, and never swallows a pending yes", async () => {
  const h = await harness();
  h.deps.due = async () => {
    throw new Error("canvas 500");
  };
  await h.say("what's due", OWNER);
  expect(h.lastTo(OWNER)).toBe("I couldn't reach Canvas just now. Try again in a bit.");
  expect(h.agentCalls()).toBe(0);
  // a confirmation reply is handled before everything else
  h.deps.confirm = async (_k, t) => (t === "yes" ? "Added it." : null);
  await h.say("yes", OWNER);
  expect(h.lastTo(OWNER)).toBe("Added it.");
});

// ---------- budgets ----------

test("the owner is capped too (100K by default), members at 50K, both configurable", () => {
  expect(dailyCap("owner")).toBe(100_000);
  expect(dailyCap("member")).toBe(50_000);
  process.env.LLM_DAILY_TOKENS_OWNER = "30000";
  process.env.LLM_DAILY_TOKENS_PER_USER = "12000";
  expect(dailyCap("owner")).toBe(30_000);
  expect(dailyCap("member")).toBe(12_000);
  delete process.env.LLM_DAILY_TOKENS_OWNER;
  const day = new Date().toLocaleDateString("en-CA", { timeZone: "America/New_York" });
  addTokens(OWNER, day, 99_999);
  expect(isOverBudget(ctx("owner"))).toBe(false);
  recordTokens(5, ctx("owner"));
  expect(tokensToday(OWNER, day)).toBe(100_004);
  expect(isOverBudget(ctx("owner"))).toBe(true);
});

test("an over-budget owner is told so, but can still confirm calendar changes (code-only) and use /due", async () => {
  const day = new Date().toLocaleDateString("en-CA", { timeZone: "America/New_York" });
  const h = await harness();
  addTokens(OWNER, day, 100_000);
  h.deps.due = async () => "Due today:\nnothing";
  await h.say("what are my grades", OWNER);
  expect(h.lastTo(OWNER)).toBe(LIMIT_MSG);
  expect(h.agentCalls()).toBe(0);
  await h.say("/due", OWNER);
  expect(h.lastTo(OWNER)).toBe("Due today:\nnothing");
  expect(await handleConfirmation(OWNER, "yes")).toBeNull(); // nothing staged -> falls through, never blocked by the cap
});

// ---------- mocked-LLM agent behaviour ----------

type Req = { model: string; messages: any[]; tools: any[]; max_completion_tokens?: number; reasoning_effort?: string };
function fakeLlm(script: Array<(req: Req) => any>) {
  const calls: Req[] = [];
  const llm: LlmLike = { chat: { completions: { create: async (p: Req) => (calls.push(JSON.parse(JSON.stringify(p))), script[Math.min(calls.length - 1, script.length - 1)]!(p)) } } };
  return { llm, calls };
}
const answer = (text: string, total = 100) => () => ({ choices: [{ message: { role: "assistant", content: text } }], usage: { prompt_tokens: total - 10, completion_tokens: 10, total_tokens: total } });
const toolCall = (name: string, args: any, total = 100) => () => ({
  choices: [{ message: { role: "assistant", content: null, tool_calls: [{ id: "c1", type: "function", function: { name, arguments: JSON.stringify(args) } }] } }],
  usage: { prompt_tokens: total - 10, completion_tokens: 10, total_tokens: total },
});
const rateLimit = (message: string, headers: Record<string, string> = {}) => () => {
  throw Object.assign(new Error(`429 ${message}`), { status: 429, error: { message, type: "tokens", code: "rate_limit_exceeded" }, headers });
};
const run = (history = [{ role: "user" as const, content: "hi" }], c = ctx("owner")) => runWithContext(c, () => runAgent(history, c.key));

test("the model asks for one composite call instead of a loop over every course", async () => {
  mockCanvas({ 1: [asg(10, "Quiz 5", 30)], 2: [asg(20, "HW", 5)] });
  const { llm, calls } = fakeLlm([toolCall("get_due_overview", { days: 3 }), answer("Two things are due.")]);
  setLlmForTests(llm);
  expect(await run([{ role: "user", content: "what's due Friday and Saturday" }])).toBe("Two things are due.");
  expect(calls.length).toBe(2);
  const toolMsg = calls[1]!.messages.at(-1);
  expect(toolMsg.role).toBe("tool");
  expect(toolMsg.content).toContain("Due in the next 3 days:");
  expect(toolMsg.content).toContain("DATA 101: Quiz 5");
  expect(calls[0]!.tools.map((t: any) => t.function.name)).toContain("get_due_overview");
  expect(calls[0]!.messages[0].content).toMatch(/call get_due_overview once/);
  expect(calls[0]!.messages[0].content).toMatch(/through Sunday night = days \d/);
  expect(tokensToday(OWNER, new Date().toLocaleDateString("en-CA", { timeZone: "America/New_York" }))).toBe(200); // Groq's usage field is recorded
});

test("requests cap output and use low reasoning for gpt-oss (not for other models)", async () => {
  const a = fakeLlm([answer("ok")]);
  setLlmForTests(a.llm);
  await run();
  expect(a.calls[0]).toMatchObject({ model: "openai/gpt-oss-120b", max_completion_tokens: 1500, reasoning_effort: "low" });
  process.env.LLM_MODEL = "llama-3.3-70b-versatile";
  const b = fakeLlm([answer("ok")]);
  setLlmForTests(b.llm);
  await run();
  expect(b.calls[0]!.reasoning_effort).toBeUndefined(); // llama would reject the parameter
  expect(b.calls[0]!.max_completion_tokens).toBe(1500);
  process.env.LLM_MODEL = "openai/gpt-oss-20b";
  process.env.LLM_REASONING_EFFORT = "medium";
  process.env.LLM_MAX_OUTPUT_TOKENS = "800";
  const c = fakeLlm([answer("ok")]);
  setLlmForTests(c.llm);
  await run();
  expect(c.calls[0]).toMatchObject({ reasoning_effort: "medium", max_completion_tokens: 800 });
});

test("429s: a daily limit is reported honestly with the wait; no pointless retry; the real error is logged", async () => {
  const warn = spyOn(console, "warn").mockImplementation(() => {});
  const { llm, calls } = fakeLlm([
    rateLimit("Rate limit reached for model `openai/gpt-oss-120b` in organization `org_01abcXYZ` service tier `on_demand` on tokens per day (TPD): Limit 200000, Used 198665, Requested 1358. Please try again in 9m12.5s.", { "retry-after": "10", "x-ratelimit-remaining-tokens": "8000" }),
  ]);
  setLlmForTests(llm);
  const reply = await run();
  expect(calls.length).toBe(1);
  expect(reply).toBe(`I've used up today's AI quota, try again in about 10 minutes. Texting "what's due" still works.`);
  const logged = warn.mock.calls.map((c) => c.join(" ")).join("\n");
  expect(logged).toContain("failed (day)");
  expect(logged).toContain("Limit 200000, Used 198665, Requested 1358");
  expect(logged).toContain("retry-after=10");
  expect(logged).not.toContain("org_01abcXYZ"); // org id masked
  warn.mockRestore();
});

test("429s: a short per-minute limit is retried once; a persistent one gets the 'rate-limited' reply", async () => {
  const warn = spyOn(console, "warn").mockImplementation(() => {});
  const tpm = "Rate limit reached for model `x` on tokens per minute (TPM): Limit 8000, Used 7900, Requested 1200. Please try again in 0.01s.";
  const ok = fakeLlm([rateLimit(tpm), answer("it worked")]);
  setLlmForTests(ok.llm);
  expect(await run()).toBe("it worked");
  expect(ok.calls.length).toBe(2);

  const bad = fakeLlm([rateLimit(tpm), rateLimit(tpm), answer("never")]);
  setLlmForTests(bad.llm);
  expect(await run()).toBe("I'm having trouble thinking right now, try again in a minute");
  expect(bad.calls.length).toBe(2); // one retry, then stop (no silent multi-minute stall)

  const long = fakeLlm([rateLimit("Rate limit reached on tokens per minute (TPM): Please try again in 45s."), answer("never")]);
  setLlmForTests(long.llm);
  expect(await run()).toBe("I'm having trouble thinking right now, try again in a minute");
  expect(long.calls.length).toBe(1); // too long to wait for inside a text conversation
  warn.mockRestore();
});

test("429 classification and wait parsing", () => {
  const c = (message: string, headers?: any) => classifyRateLimit({ status: 429, message, headers });
  expect(c("on tokens per day (TPD): ... Please try again in 7m12.96s")).toMatchObject({ kind: "day", waitSeconds: 432.96 });
  expect(c("on tokens per day (TPD): Please try again in 1h2m3s")).toMatchObject({ kind: "day", waitSeconds: 3723 });
  expect(c("on requests per day (RPD): Please try again in 9.936s")).toMatchObject({ kind: "day", waitSeconds: 9.936 });
  expect(c("on tokens per minute (TPM): Please try again in 3.5s")).toMatchObject({ kind: "minute", waitSeconds: 3.5 });
  expect(c("something unparseable", { "retry-after": "12" })).toMatchObject({ kind: "minute", waitSeconds: 12 });
  expect(classifyRateLimit({ status: 500, message: "x" })).toBeNull();
  expect(rateLimitedMessage(new RateLimited("day", 7200, ""))).toContain("2h 0m");
  expect(rateLimitedMessage(new RateLimited("day", null, ""))).toContain("try again later");
});

test("the SDK client does not retry 429s silently", async () => {
  const { OpenAI } = await import("openai").then((m) => ({ OpenAI: m.default }));
  const src = await Bun.file("src/llm.ts").text();
  expect(src).toMatch(/maxRetries: 0/);
  expect(new OpenAI({ apiKey: "x", maxRetries: 0 }).maxRetries).toBe(0);
});

test("invalid tool arguments are retried once (Groq 400), and tests cannot reach the live LLM", async () => {
  const bad = () => {
    throw Object.assign(new Error("400 Tool call validation failed: expected string, but got null"), { status: 400 });
  };
  const { llm, calls } = fakeLlm([bad, answer("fixed")]);
  setLlmForTests(llm);
  expect(await run()).toBe("fixed");
  expect(calls[1]!.messages.at(-1).content).toMatch(/OMIT optional parameters/);

  setLlmForTests(); // no mock injected: the guard must stop the call before any network
  globalThis.fetch = (async () => {
    throw new Error("network must not be used");
  }) as any;
  await expect(run()).rejects.toThrow(/refusing to call the live LLM/);
});

test("history sent to the model is trimmed", () => {
  const h = Array.from({ length: 30 }, (_, i) => ({ role: (i % 2 ? "assistant" : "user") as "user" | "assistant", content: `m${i}` }));
  expect(trimHistory(h).length).toBe(12);
  expect(trimHistory(h).at(-1)!.content).toBe("m29");
  const long = trimHistory([{ role: "assistant", content: "x".repeat(2000) }]);
  expect(long[0]!.content.length).toBe(701);
});

test("prompt + tool schemas stay small (regression guard: every round re-sends them)", () => {
  const size = (role: "owner" | "member") => runWithContext(ctx(role), () => buildSystemPrompt(OWNER).length + JSON.stringify(toolsForRole(role)).length);
  // originally: owner ~6,800 chars (~1,310 tokens), member ~2,650. Now ~6,340 / ~3,230: grade_calc, ask_syllabus, reminders,
  // the planner and the name/personality are all in there (ask_syllabus replaced get_syllabus, which could dump 6,000 chars).
  expect(size("owner")).toBeLessThan(6_500);
  expect(size("member")).toBeLessThan(3_450); // (grade_calc's description grew by ~110 chars so it is called first, with no list_courses detour)
});

test("tools: members still can't use calendar tools, and the composite tool is available to both", async () => {
  for (const role of ["owner", "member"] as const) expect(toolsForRole(role).map((t) => t.function.name)).toContain("get_due_overview");
  expect(toolsForRole("member").map((t) => t.function.name)).not.toContain("update_calendar_event");
  mockCanvas({ 1: [asg(10, "Quiz 5", 30)] });
  expect(await runWithContext(ctx("member", ALICE), () => executeTool("get_due_overview", { days: null }, ALICE))).toContain("Quiz 5");
});

// ---------- model fallback chain ----------

const TPD = (model: string) => `Rate limit reached for model \`${model}\` in organization \`org_01zzz\` on tokens per day (TPD): Limit 200000, Used 199900, Requested 1400. Please try again in 9m0s.`;
const TPM = (model: string) => `Rate limit reached for model \`${model}\` on tokens per minute (TPM): Limit 8000, Used 7900, Requested 1200. Please try again in 0.01s.`;

/** A fake whose behaviour depends on which model is asked. */
function perModel(table: Record<string, () => any>) {
  const calls: Req[] = [];
  const llm: LlmLike = {
    chat: { completions: { create: async (p: Req) => (calls.push(JSON.parse(JSON.stringify(p))), (table[p.model] ?? (() => { throw new Error(`unexpected model ${p.model}`); }))()) } },
  };
  return { llm, calls, models: () => calls.map((c) => c.model) };
}

test("LLM_MODELS: parsed, trimmed and de-duplicated; falls back to LLM_MODEL when unset", () => {
  expect(modelChain()).toEqual(["openai/gpt-oss-120b"]);
  process.env.LLM_MODEL = "llama-3.3-70b-versatile";
  expect(modelChain()).toEqual(["llama-3.3-70b-versatile"]);
  process.env.LLM_MODELS = " openai/gpt-oss-120b , openai/gpt-oss-20b,,openai/gpt-oss-120b,llama-3.3-70b-versatile ";
  expect(modelChain()).toEqual(["openai/gpt-oss-120b", "openai/gpt-oss-20b", "llama-3.3-70b-versatile"]);
});

test("on a 429 the same request goes to the next model; the model that answered is logged", async () => {
  process.env.LLM_MODELS = "openai/gpt-oss-120b,openai/gpt-oss-20b,llama-3.3-70b-versatile";
  const warn = spyOn(console, "warn").mockImplementation(() => {});
  const log = spyOn(console, "log").mockImplementation(() => {});
  const f = perModel({
    "openai/gpt-oss-120b": rateLimit(TPD("openai/gpt-oss-120b")),
    "openai/gpt-oss-20b": rateLimit(TPD("openai/gpt-oss-20b")),
    "llama-3.3-70b-versatile": answer("llama here", 123),
  });
  setLlmForTests(f.llm);
  expect(await run([{ role: "user", content: "what is my gpa" }])).toBe("llama here");
  expect(f.models()).toEqual(["openai/gpt-oss-120b", "openai/gpt-oss-20b", "llama-3.3-70b-versatile"]);
  // the exact same conversation was re-sent
  expect(f.calls[2]!.messages).toEqual(f.calls[0]!.messages);
  expect(f.calls[2]!.tools).toEqual(f.calls[0]!.tools);
  const logged = [...warn.mock.calls, ...log.mock.calls].map((c) => c.join(" ")).join("\n");
  expect(logged).toContain("groq/openai/gpt-oss-120b failed (day)");
  expect(logged).toContain("-> trying groq/openai/gpt-oss-20b");
  expect(logged).toContain("llm: answered by groq/llama-3.3-70b-versatile after 2 skipped or failed");
  expect(logged).toContain("llm round [groq/llama-3.3-70b-versatile]: 113 in / 10 out");
  expect(logged).not.toContain("org_01zzz");
  warn.mockRestore();
  log.mockRestore();
});

test("a model that just hit its limit is skipped by later requests until its wait is over", async () => {
  process.env.LLM_MODELS = "openai/gpt-oss-120b,openai/gpt-oss-20b";
  const warn = spyOn(console, "warn").mockImplementation(() => {});
  const f = perModel({ "openai/gpt-oss-120b": rateLimit(TPD("openai/gpt-oss-120b")), "openai/gpt-oss-20b": answer("from 20b") });
  setLlmForTests(f.llm);
  await run();
  await run();
  await run();
  expect(f.models()).toEqual(["openai/gpt-oss-120b", "openai/gpt-oss-20b", "openai/gpt-oss-20b", "openai/gpt-oss-20b"]); // 120b tried once, then skipped
  resetModelCooldowns(); // (the wait elapsed) the first model is tried again
  await run();
  expect(f.models().slice(-2)).toEqual(["openai/gpt-oss-120b", "openai/gpt-oss-20b"]);
  warn.mockRestore();
});

test("when the first model recovers it answers again, and each model gets only the parameters it supports", async () => {
  process.env.LLM_MODELS = "openai/gpt-oss-120b,llama-3.3-70b-versatile";
  const warn = spyOn(console, "warn").mockImplementation(() => {});
  const f = perModel({ "openai/gpt-oss-120b": rateLimit(TPD("openai/gpt-oss-120b")), "llama-3.3-70b-versatile": answer("llama") });
  setLlmForTests(f.llm);
  await run();
  expect(f.calls[0]).toMatchObject({ model: "openai/gpt-oss-120b", reasoning_effort: "low", max_completion_tokens: 1500 });
  expect(f.calls[1]!.model).toBe("llama-3.3-70b-versatile");
  expect(f.calls[1]!.reasoning_effort).toBeUndefined(); // llama would reject it
  expect(f.calls[1]!.max_completion_tokens).toBe(1500);
  warn.mockRestore();
});

test("every model limited: daily everywhere -> the daily message with the soonest wait; any per-minute limit -> 'try again in a minute'", async () => {
  process.env.LLM_MODELS = "a/model-1,b/model-2";
  const warn = spyOn(console, "warn").mockImplementation(() => {});
  setLlmForTests(perModel({ "a/model-1": rateLimit(TPD("a/model-1")), "b/model-2": rateLimit("on tokens per day (TPD): Limit 1, Used 1, Requested 1. Please try again in 2h0m0s.") }).llm);
  expect(await run()).toBe(`I've used up today's AI quota, try again in about 9 minutes. Texting "what's due" still works.`);

  resetModelCooldowns();
  const mixed = perModel({ "a/model-1": rateLimit(TPD("a/model-1")), "b/model-2": rateLimit("on tokens per minute (TPM): Please try again in 45s.") });
  setLlmForTests(mixed.llm);
  expect(await run()).toBe("I'm having trouble thinking right now, try again in a minute");
  expect(mixed.calls.length).toBe(2); // 45s is too long to wait inside a text conversation: no extra pass

  resetModelCooldowns();
  const brief = perModel({ "a/model-1": rateLimit(TPM("a/model-1")), "b/model-2": (() => { let n = 0; return () => (++n === 1 ? rateLimit(TPM("b/model-2"))() : answer("second pass worked")()); })() });
  setLlmForTests(brief.llm);
  expect(await run()).toBe("second pass worked"); // both briefly limited: one more pass over the chain after the short wait
  expect(brief.models()).toEqual(["a/model-1", "b/model-2", "a/model-1", "b/model-2"]); // pass 2: a is still limited, b answers
  warn.mockRestore();
});

test("a 400 (our own request) is not hidden by the chain and does not fail over", async () => {
  process.env.LLM_MODELS = "a/model-1,b/model-2";
  const f = perModel({ "a/model-1": () => { throw Object.assign(new Error("400 boom"), { status: 400 }); }, "b/model-2": answer("never") });
  setLlmForTests(f.llm);
  await expect(run()).rejects.toThrow(/boom/);
  expect(f.models()).toEqual(["a/model-1"]);
});

test("per-user caps still apply across the chain: usage is counted whichever model answers, and a capped user never reaches any model", async () => {
  process.env.LLM_MODELS = "openai/gpt-oss-120b,openai/gpt-oss-20b";
  process.env.LLM_DAILY_TOKENS_PER_USER = "150";
  const warn = spyOn(console, "warn").mockImplementation(() => {});
  const f = perModel({ "openai/gpt-oss-120b": rateLimit(TPD("openai/gpt-oss-120b")), "openai/gpt-oss-20b": answer("fallback answer", 100) });
  setLlmForTests(f.llm);
  const h = await harness({ agent: runAgent });
  await addMember(ALICE);
  await h.say("q1", ALICE);
  await h.say("q2", ALICE);
  expect(h.sent.filter((s) => s.to === ALICE).map((s) => s.text)).toEqual(["fallback answer", "fallback answer"]);
  const day = new Date().toLocaleDateString("en-CA", { timeZone: "America/New_York" });
  expect(tokensToday(ALICE, day)).toBe(200); // 2 x 100, counted although the 20b model answered
  const before = f.calls.length;
  await h.say("q3", ALICE); // 200 >= 150
  expect(h.lastTo(ALICE)).toBe(LIMIT_MSG);
  expect(f.calls.length).toBe(before); // no model was called
  warn.mockRestore();
});

test("announcement summaries use the chain too (and fall back to the title when everything is limited)", async () => {
  process.env.LLM_MODELS = "a/model-1,b/model-2";
  const { summarizeAnnouncement } = await import("../src/agent.ts");
  const warn = spyOn(console, "warn").mockImplementation(() => {});
  const f = perModel({ "a/model-1": rateLimit(TPD("a/model-1")), "b/model-2": answer("Office hours canceled today") });
  setLlmForTests(f.llm);
  expect(await runWithContext(ctx("owner"), () => summarizeAnnouncement("No Office Hours", "The instructor is out today"))).toBe("Office hours canceled today");
  expect(f.models()).toEqual(["a/model-1", "b/model-2"]);
  resetModelCooldowns();
  setLlmForTests(perModel({ "a/model-1": rateLimit(TPD("a/model-1")), "b/model-2": rateLimit(TPD("b/model-2")) }).llm);
  expect(await runWithContext(ctx("owner"), () => summarizeAnnouncement("No Office Hours", "x"))).toBe("No Office Hours");
  warn.mockRestore();
});
