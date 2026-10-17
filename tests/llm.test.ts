import { afterEach, beforeEach, expect, spyOn, test } from "bun:test";
import { RateLimited, rateLimitedMessage, resetModelCooldowns, runAgent, setLlmForTests } from "../src/agent.ts";
import { runWithContext, type UserContext } from "../src/context.ts";
import { ensureOwner, initDb, providerUsageToday, tokensToday, addProviderUsage } from "../src/db.ts";
import {
  PACE_MAX_WAIT_MS, activeEntries, callLlm, cleanMessages, configuredEntries, modelChain, paramsFor, providerStatus, setLlmAlertHandler, setLlmClockForTests, simplifySchema, type LlmLike,
} from "../src/llm.ts";
import { harness, OWNER, ALICE } from "./helpers.ts";

// Every LLM here is a mock. The keys below are dummies: nothing in this file can reach a real provider.
const KEYS = ["GROQ_API_KEY", "CEREBRAS_API_KEY", "LLM_API_KEY", "LLM_PROVIDERS", "LLM_MODELS", "LLM_MODEL", "LLM_BASE_URL", "LLM_REASONING_EFFORT", "LLM_DAILY_TOKENS_OWNER", "LLM_DAILY_TOKENS_PER_USER", "CEREBRAS_DAILY_TOKEN_CAP", "CEREBRAS_USD_PER_M_TOKENS", "TIMEZONE"];
const realEnv = { ...process.env };
const ctx: UserContext = { key: OWNER, role: "owner", timezone: "America/New_York", canvasUrl: "https://canvas.example", canvasToken: "tok" };

let t: number;
let slept: number[];
beforeEach(() => {
  initDb(":memory:");
  ensureOwner(OWNER);
  resetModelCooldowns();
  for (const k of KEYS) delete process.env[k];
  process.env.CEREBRAS_API_KEY = "dummy-cerebras-key-for-tests";
  t = Date.UTC(2026, 9, 16, 15, 0, 0); // Fri Oct 16 11:00 EDT
  slept = [];
  setLlmClockForTests({ now: () => t, sleep: async (ms) => void (slept.push(ms), (t += ms)) });
});
afterEach(() => {
  setLlmForTests();
  setLlmAlertHandler();
  setLlmClockForTests();
  resetModelCooldowns();
  for (const k of KEYS) (realEnv[k] === undefined ? delete process.env[k] : (process.env[k] = realEnv[k]));
});

// ---------- mock providers ----------

type Call = { model: string; params: any };
const err = (status: number | undefined, message: string, extra: any = {}) => Object.assign(new Error(message), status ? { status } : {}, extra);
const rate = (message: string, headers: Record<string, string> = {}) => err(429, message, { headers });
const TPM = "Rate limit reached for model `m` on tokens per minute (TPM): Limit 8000, Used 7900, Requested 1200. Please try again in 30s.";
const TPD = "Rate limit reached for model `m` in organization `org_01abc` on tokens per day (TPD): Limit 200000, Used 199900, Requested 1400. Please try again in 9m0s.";
const ok = (content: string, tokens = 100) => ({ choices: [{ message: { role: "assistant", content } }], usage: { total_tokens: tokens, prompt_tokens: tokens - 10, completion_tokens: 10 } });

/** A provider whose responses come from a script; each entry is a value, or a function that may throw. */
function provider(script: (() => any)[] | (() => any)) {
  const calls: Call[] = [];
  let n = 0;
  const llm: LlmLike = {
    chat: { completions: { create: async (params: any) => {
      calls.push({ model: params.model, params: JSON.parse(JSON.stringify(params)) });
      const step = Array.isArray(script) ? script[Math.min(n++, script.length - 1)]! : script;
      return step();
    } } },
  };
  return { llm, calls };
}
const say = (text: string, tokens = 100) => () => ok(text, tokens);
const fail = (e: any) => () => { throw e; };
const ask = (text = "hello") => runWithContext(ctx, () => runAgent([{ role: "user", content: text }], OWNER));
const quiet = () => [spyOn(console, "warn").mockImplementation(() => {}), spyOn(console, "log").mockImplementation(() => {})] as const;

// ---------- 1. the chain ----------

test("default chain: Groq, then Cerebras gpt-oss-120b, then Cerebras qwen-3.8-27b, each with a base URL, key env var and model", () => {
  const e = configuredEntries({} as any);
  expect(e.map((x) => `${x.provider}/${x.model}`)).toEqual(["groq/openai/gpt-oss-120b", "cerebras/gpt-oss-120b", "cerebras/qwen-3.8-27b"]);
  expect(e[2]).toMatchObject({ baseUrl: "https://api.cerebras.ai/v1", keyEnv: "CEREBRAS_API_KEY", rpm: 450, dailyTokens: 1_000_000_000, strict: true });
  expect(e[0]).toMatchObject({ baseUrl: "https://api.groq.com/openai/v1", keyEnv: "GROQ_API_KEY" });
  expect(e[1]).toMatchObject({ baseUrl: "https://api.cerebras.ai/v1", keyEnv: "CEREBRAS_API_KEY", rpm: 5, dailyRequests: 2400, dailyTokens: 3_000_000 });
});

test("LLM_MODELS and LLM_MODEL keep working (they list Groq's models)", () => {
  expect(modelChain({} as any)).toEqual(["openai/gpt-oss-120b"]);
  expect(modelChain({ LLM_MODEL: "llama-3.3-70b-versatile" } as any)).toEqual(["llama-3.3-70b-versatile"]);
  const e = configuredEntries({ LLM_MODELS: "openai/gpt-oss-120b, openai/gpt-oss-20b" } as any);
  expect(e.map((x) => `${x.provider}/${x.model}`)).toEqual(["groq/openai/gpt-oss-120b", "groq/openai/gpt-oss-20b", "cerebras/gpt-oss-120b", "cerebras/qwen-3.8-27b"]);
  expect(configuredEntries({ LLM_BASE_URL: "https://groq.example/v1" } as any)[0]!.baseUrl).toBe("https://groq.example/v1");
});

test("LLM_PROVIDERS: shorthand and full JSON entries", () => {
  const short = configuredEntries({ LLM_PROVIDERS: "groq:openai/gpt-oss-120b, cerebras:gpt-oss-120b ,cerebras:qwen-test-27b" } as any);
  expect(short.map((x) => `${x.provider}/${x.model}`)).toEqual(["groq/openai/gpt-oss-120b", "cerebras/gpt-oss-120b", "cerebras/qwen-test-27b"]);
  expect(short[2]).toMatchObject({ rpm: 450, keyEnv: "CEREBRAS_API_KEY" }); // qwen limits from the dashboard
  const json = configuredEntries({ LLM_PROVIDERS: JSON.stringify([{ provider: "other", baseUrl: "https://other.example/v1", keyEnv: "OTHER_KEY", model: "m-1", rpm: 20 }]) } as any);
  expect(json).toEqual([{ provider: "other", baseUrl: "https://other.example/v1", keyEnv: "OTHER_KEY", model: "m-1", rpm: 20 }]);
  expect(() => configuredEntries({ LLM_PROVIDERS: "nonsense" } as any)).toThrow(/not provider:model/);
  expect(() => configuredEntries({ LLM_PROVIDERS: '[{"provider":"x"}]' } as any)).toThrow(/need provider/);
});

test("a provider whose key isn't set is skipped", () => {
  setLlmForTests({ groq: provider(say("g")).llm, cerebras: provider(say("c")).llm });
  expect(activeEntries().map((e) => `${e.provider}/${e.model}`)).toEqual(["groq/openai/gpt-oss-120b", "cerebras/gpt-oss-120b", "cerebras/qwen-3.8-27b"]);
  delete process.env.CEREBRAS_API_KEY;
  expect(activeEntries().map((e) => e.provider)).toEqual(["groq"]);
  expect(providerStatus().find((p) => p.name.startsWith("cerebras"))).toMatchObject({ state: "no key", detail: "set CEREBRAS_API_KEY" });
  setLlmForTests();
  process.env.GROQ_API_KEY = "dummy-groq";
  expect(activeEntries().map((e) => e.provider)).toEqual(["groq"]); // a key (not a mock) is what activates it
  delete process.env.GROQ_API_KEY;
  process.env.LLM_API_KEY = "dummy-legacy"; // the older Groq variable still counts
  expect(activeEntries().map((e) => e.provider)).toEqual(["groq"]);
});

// ---------- 2. failover ----------

test("Groq 429 -> Cerebras answers", async () => {
  const groq = provider(fail(rate(TPM))), cerebras = provider(say("cerebras answer"));
  setLlmForTests({ groq: groq.llm, cerebras: cerebras.llm });
  const [warn, log] = quiet();
  expect(await ask()).toBe("cerebras answer");
  expect(groq.calls).toHaveLength(1); // tried once, then the next provider
  expect(groq.calls[0]!.model).toBe("openai/gpt-oss-120b");
  expect(cerebras.calls[0]!.model).toBe("gpt-oss-120b");
  warn.mockRestore(); log.mockRestore();
});

test("5xx, timeouts and network errors fail over; so does a bad key", async () => {
  for (const e of [err(503, "service unavailable"), err(500, "boom"), err(undefined, "Request timed out.", { name: "APIConnectionTimeoutError" }), err(undefined, "Connection error.", { name: "APIConnectionError" }), err(undefined, "fetch failed", { code: "ECONNRESET" }), err(401, "invalid api key"), err(404, "model not found")]) {
    resetModelCooldowns();
    const groq = provider(fail(e)), cerebras = provider(say("from cerebras"));
    setLlmForTests({ groq: groq.llm, cerebras: cerebras.llm });
    const [warn, log] = quiet();
    expect(await ask(), String(e.message)).toBe("from cerebras");
    warn.mockRestore(); log.mockRestore();
  }
});

test("a 400 caused by our own request does not fail over: Cerebras is never called", async () => {
  const groq = provider(fail(err(400, "bad request: unknown field"))), cerebras = provider(say("never"));
  setLlmForTests({ groq: groq.llm, cerebras: cerebras.llm });
  const [warn, log] = quiet();
  await expect(ask()).rejects.toThrow(/unknown field/);
  expect(cerebras.calls).toHaveLength(0);
  expect(groq.calls).toHaveLength(1);
  // 422 and 413 are our fault too
  for (const s of [422, 413]) {
    const g = provider(fail(err(s, "nope"))), c = provider(say("never"));
    setLlmForTests({ groq: g.llm, cerebras: c.llm });
    await expect(ask()).rejects.toThrow(/nope/);
    expect(c.calls).toHaveLength(0);
  }
  warn.mockRestore(); log.mockRestore();
});

test("a 400 from the SECOND provider isn't hidden either", async () => {
  const groq = provider(fail(rate(TPM))), cerebras = provider(fail(err(400, "bad schema")));
  setLlmForTests({ groq: groq.llm, cerebras: cerebras.llm });
  const [warn, log] = quiet();
  await expect(ask()).rejects.toThrow(/bad schema/);
  warn.mockRestore(); log.mockRestore();
});

test("both down -> the friendly reply, for 429s, 5xx and a mix", async () => {
  const FRIENDLY = "I'm having trouble thinking right now, try again in a minute";
  for (const [g, c] of [[rate(TPM), rate(TPM)], [err(500, "x"), err(503, "y")], [rate(TPM), err(502, "bad gateway")], [err(undefined, "Request timed out.", { name: "APIConnectionTimeoutError" }), rate(TPM)]] as const) {
    resetModelCooldowns();
    setLlmForTests({ groq: provider(fail(g)).llm, cerebras: provider(fail(c)).llm });
    const [warn, log] = quiet();
    expect(await ask()).toBe(FRIENDLY);
    warn.mockRestore(); log.mockRestore();
  }
  expect(rateLimitedMessage(new RateLimited("minute", 30, ""))).toBe(FRIENDLY);
});

test("both out for the day -> the honest daily-quota message with the soonest wait", async () => {
  setLlmForTests({ groq: provider(fail(rate(TPD))).llm, cerebras: provider(fail(rate("Tokens per day limit exceeded", { "x-ratelimit-reset-tokens-day": "7200" }))).llm });
  const [warn, log] = quiet();
  const reply = await ask();
  expect(reply).toMatch(/^I've used up today's AI quota, try again in about \d+ minutes\. Texting "what's due" still works\.$/);
  warn.mockRestore(); log.mockRestore();
});

test("a short minute limit gets one more pass after the wait; a persistent one then gives up", async () => {
  const g = provider([fail(rate("Rate limit on tokens per minute (TPM). Please try again in 2s.")), say("g ok")]);
  setLlmForTests({ groq: g.llm, cerebras: provider(fail(err(500, "x"))).llm });
  const [warn, log] = quiet();
  expect(await ask()).toBe("g ok");
  expect(slept).toEqual([2500]);
  warn.mockRestore(); log.mockRestore();
});

// ---------- remembering a provider that hit its daily cap ----------

test("a provider that hit its daily cap is not retried on every message, only after its reset", async () => {
  const groq = provider([fail(rate(TPD)), say("groq is back")]), cerebras = provider(say("cerebras", 50));
  setLlmForTests({ groq: groq.llm, cerebras: cerebras.llm });
  const [warn, log] = quiet();
  expect(await ask()).toBe("cerebras");
  expect(groq.calls).toHaveLength(1);
  t += 30_000;
  expect(await ask()).toBe("cerebras");
  t += 30_000;
  expect(await ask()).toBe("cerebras");
  expect(groq.calls).toHaveLength(1); // not asked again
  expect(providerStatus().find((p) => p.name.startsWith("groq"))).toMatchObject({ state: "daily cap" });
  t += 11 * 60_000; // past the 9m it asked for
  resetPacingOnly();
  expect(await ask()).toBe("groq is back");
  expect(groq.calls).toHaveLength(2);
  warn.mockRestore(); log.mockRestore();
});

test("a daily cap with no wait given is remembered until midnight UTC", async () => {
  const groq = provider([fail(rate("daily request quota exceeded")), say("groq")]), cerebras = provider(say("c"));
  setLlmForTests({ groq: groq.llm, cerebras: cerebras.llm });
  const [warn, log] = quiet();
  await ask();
  t += 6 * 3600_000; // 21:00 UTC, still the same day
  resetPacingOnly();
  await ask();
  expect(groq.calls).toHaveLength(1);
  t = Date.UTC(2026, 9, 17, 0, 1, 0); // just after midnight UTC
  resetPacingOnly();
  expect(await ask()).toBe("groq");
  warn.mockRestore(); log.mockRestore();
});

test("everyone out for the day: no calls at all until the reset", async () => {
  const groq = provider(fail(rate(TPD))), cerebras = provider(fail(rate(TPD)));
  setLlmForTests({ groq: groq.llm, cerebras: cerebras.llm });
  const [warn, log] = quiet();
  await ask();
  const before = groq.calls.length + cerebras.calls.length;
  t += 60_000;
  resetPacingOnly();
  expect(await ask()).toContain("used up today's AI quota");
  expect(groq.calls.length + cerebras.calls.length).toBe(before);
  warn.mockRestore(); log.mockRestore();
});

/** pacing is separate from the daily-cap memory; tests that jump the clock free the pacing slots by moving past them */
function resetPacingOnly() {
  t += 15_000;
}

// ---------- pacing ----------

test("Cerebras gpt-oss-120b is paced to 5/min: a reply that would wait over 5s skips to the next model", async () => {
  expect(PACE_MAX_WAIT_MS).toBe(5000);
  process.env.LLM_PROVIDERS = "cerebras:gpt-oss-120b,cerebras:qwen-test-27b";
  const [warn, log] = quiet();
  const calls: string[] = [];
  const both: LlmLike = { chat: { completions: { create: async (p: any) => (calls.push(p.model), ok(`${p.model} says hi`)) } } };
  setLlmForTests({ cerebras: both });
  expect(await ask()).toBe("gpt-oss-120b says hi"); // the first call goes straight out
  expect(slept).toEqual([]);
  t += 1000;
  expect(await ask()).toBe("qwen-test-27b says hi"); // 11s to wait: skipped, qwen answers
  expect(calls).toEqual(["gpt-oss-120b", "qwen-test-27b"]);
  t += 7_000; // now 8s since the last gpt-oss call: 4s wait is acceptable
  expect(await ask()).toBe("gpt-oss-120b says hi");
  expect(slept).toEqual([4000]);
  expect(await ask()).toBe("qwen-test-27b says hi"); // immediately again: a full 12s gap is too long
  // pacing is spaced 12s apart, never denser than 5 a minute
  t += 12_000;
  await ask();
  warn.mockRestore(); log.mockRestore();
});

test("a Cerebras-only chain whose pace is exhausted gives the friendly reply instead of hanging", async () => {
  process.env.LLM_PROVIDERS = "cerebras:gpt-oss-120b";
  const c = provider(say("ok"));
  setLlmForTests({ cerebras: c.llm });
  const [warn, log] = quiet();
  expect(await ask()).toBe("ok");
  expect(await ask()).toBe("I'm having trouble thinking right now, try again in a minute");
  expect(c.calls).toHaveLength(1);
  warn.mockRestore(); log.mockRestore();
});

test("pacing never exceeds the limit: 5 requests per 60s at most across many attempts", async () => {
  process.env.LLM_PROVIDERS = "cerebras:gpt-oss-120b";
  const stamps: number[] = [];
  setLlmForTests({ cerebras: { chat: { completions: { create: async () => (stamps.push(t), ok("x")) } } } });
  const [warn, log] = quiet();
  for (let i = 0; i < 200; i++) { await ask(); t += 3_000; }
  warn.mockRestore(); log.mockRestore();
  for (let i = 0; i + 5 < stamps.length; i++) expect(stamps[i + 5]! - stamps[i]!).toBeGreaterThanOrEqual(60_000);
  expect(stamps.length).toBeGreaterThan(20);
});

// ---------- 3. provider differences ----------

const probeTools = [{ type: "function", function: { name: "t", description: "d", parameters: { type: "object", properties: { a: { type: ["string", "null"] }, b: { type: ["array", "null"], items: { type: "object", properties: { c: { type: ["number", "null"] } } } }, d: { type: "string" } }, required: ["d"] } } }];

test("Groq's request is unchanged; Cerebras gets plain schemas, no parallel_tool_calls and cleaned messages", () => {
  const [groq, cerebras] = configuredEntries({} as any);
  const base = {
    messages: [
      { role: "system", content: "s" }, { role: "user", content: "u" },
      { role: "assistant", content: null, reasoning: "thinking...", refusal: null, tool_calls: [{ id: "1", type: "function", index: 0, function: { name: "t", arguments: "{}" } }] },
      { role: "tool", tool_call_id: "1", content: "r", extra: "x" },
    ],
    tools: probeTools, tool_choice: "auto", parallel_tool_calls: false, max_completion_tokens: 1500,
  };
  const g = paramsFor(groq!, base);
  expect(g).toEqual({ ...base, model: "openai/gpt-oss-120b", reasoning_effort: "low" });
  expect(g.tools[0].function.parameters.properties.a.type).toEqual(["string", "null"]); // nullable optional fields stay on Groq
  const c = paramsFor(cerebras!, base);
  expect(c.model).toBe("gpt-oss-120b");
  expect(c.reasoning_effort).toBe("low");
  expect("parallel_tool_calls" in c).toBe(false);
  const props = c.tools[0].function.parameters.properties;
  expect(props.a.type).toBe("string");
  expect(props.b.type).toBe("array");
  expect(props.b.items.properties.c.type).toBe("number");
  expect(c.tools[0].function.parameters.required).toEqual(["d"]);
  expect(JSON.stringify(c.tools)).not.toContain('"null"');
  expect(c.messages[2]).toEqual({ role: "assistant", content: "", tool_calls: [{ id: "1", type: "function", function: { name: "t", arguments: "{}" } }] });
  expect(c.messages[3]).toEqual({ role: "tool", tool_call_id: "1", content: "r" });
  expect(base.tools[0]!.function.parameters.properties.a.type).toEqual(["string", "null"]); // the original is not mutated
  // a model that isn't gpt-oss gets no reasoning_effort
  expect("reasoning_effort" in paramsFor(configuredEntries({ LLM_PROVIDERS: "cerebras:qwen-test-27b" } as any)[0]!, base)).toBe(false);
});

test("every real tool schema survives simplification (names, required fields, no nulls)", async () => {
  const { toolsForRole } = await import("../src/agent.ts");
  const tools = toolsForRole("owner", { calendar: true, gpa: true });
  const simple = simplifySchema(tools);
  expect(simple.map((x: any) => x.function.name)).toEqual(tools.map((x) => x.function.name));
  expect(JSON.stringify(simple)).not.toContain('"null"');
  for (const [i, x] of tools.entries()) expect((simple[i] as any).function.parameters.required).toEqual((x as any).function.parameters.required);
  expect(JSON.stringify(tools)).toContain('"null"'); // (and the originals really did have nullable fields)
  expect(cleanMessages([{ role: "user", content: "hi", name: "x" }])).toEqual([{ role: "user", content: "hi" }]);
});

test("mid-conversation failover: Groq's tool call, then Cerebras finishes with Groq's messages cleaned up", async () => {
  const toolCall = { role: "assistant", content: null, reasoning: "thinking", tool_calls: [{ id: "call_1", type: "function", function: { name: "grade_calc", arguments: JSON.stringify({ course: "zzz-no-such-course" }) } }] };
  const groq = provider([() => ({ choices: [{ message: toolCall }], usage: { total_tokens: 80 } }), fail(rate(TPM))]);
  const cerebras = provider(say("done on cerebras"));
  setLlmForTests({ groq: groq.llm, cerebras: cerebras.llm });
  const [warn, log] = quiet();
  // the tool runs for real code but needs Canvas: make it fail fast with no network
  const realFetch = globalThis.fetch;
  globalThis.fetch = (async () => { throw new Error("no network in tests"); }) as any;
  try {
    expect(await ask("what is my grade in zzz")).toBe("done on cerebras");
  } finally {
    globalThis.fetch = realFetch;
  }
  const sent = cerebras.calls[0]!.params.messages;
  const assistant = sent.find((m: any) => m.role === "assistant");
  expect(assistant.reasoning).toBeUndefined();
  expect(assistant.tool_calls[0]).toEqual({ id: "call_1", type: "function", function: { name: "grade_calc", arguments: JSON.stringify({ course: "zzz-no-such-course" }) } });
  expect(sent.find((m: any) => m.role === "tool").tool_call_id).toBe("call_1");
  warn.mockRestore(); log.mockRestore();
});

// ---------- 4. usage per provider and the user's budget ----------

test("usage is tracked per provider/model, and the per-user budget still counts every provider's tokens", async () => {
  const groq = provider([say("g1", 120), fail(rate(TPM)), fail(rate(TPM))]), cerebras = provider(say("c1", 300));
  setLlmForTests({ groq: groq.llm, cerebras: cerebras.llm });
  const [warn, log] = quiet();
  await ask(); // Groq answers (120)
  t += 100_000;
  await ask(); // Groq 429 -> Cerebras (300)
  t += 13_000; // (past Cerebras's 12s pace)
  await ask(); // Groq still cooling -> Cerebras (300)
  const day = new Date(t).toISOString().slice(0, 10);
  const usage = providerUsageToday(day);
  expect(usage.find((u) => u.provider === "groq")).toMatchObject({ model: "openai/gpt-oss-120b", requests: 1, tokens: 120 }); // failed calls aren't usage
  expect(usage.find((u) => u.provider === "cerebras")).toMatchObject({ model: "gpt-oss-120b", requests: 2, tokens: 600 });
  expect(tokensToday(OWNER, new Date().toLocaleDateString("en-CA", { timeZone: "America/New_York" }))).toBe(720);
  warn.mockRestore(); log.mockRestore();
});

test("a provider at ~97% of its daily cap (by our own count) is skipped without spending a request", async () => {
  const groq = provider(say("g")), cerebras = provider(say("c"));
  setLlmForTests({ groq: groq.llm, cerebras: cerebras.llm });
  addProviderUsage(new Date(t).toISOString().slice(0, 10), "groq", "openai/gpt-oss-120b", 195_000); // 97.5% of 200K
  const [warn, log] = quiet();
  expect(await ask()).toBe("c");
  expect(groq.calls).toHaveLength(0);
  warn.mockRestore(); log.mockRestore();
});

// ---------- 5. logging ----------

test("which provider answered is logged, with the number masked and no message content", async () => {
  const groq = provider(fail(rate(TPM))), cerebras = provider(say("the reply text"));
  setLlmForTests({ groq: groq.llm, cerebras: cerebras.llm });
  const lines: string[] = [];
  const grab = (...a: unknown[]) => void lines.push(a.map(String).join(" "));
  const w = spyOn(console, "warn").mockImplementation(grab), l = spyOn(console, "log").mockImplementation(grab);
  await ask("my secret question about mysterious things");
  w.mockRestore(); l.mockRestore();
  const all = lines.join("\n");
  expect(all).toContain("answered by cerebras/gpt-oss-120b for +1919•••0100");
  expect(all).toContain("llm: groq/openai/gpt-oss-120b failed (minute)");
  expect(all).not.toContain(OWNER);
  expect(all).not.toContain("mysterious");
  expect(all).not.toContain("the reply text");
  expect(all).not.toContain("dummy-cerebras-key-for-tests");
});

test("/llm (owner only) shows the chain, state and usage, and nothing sensitive", async () => {
  const h = await harness();
  await h.say("/llm", ALICE);
  setLlmForTests({ groq: provider(fail(rate(TPD))).llm, cerebras: provider(say("c", 500)).llm });
  const [warn, log] = quiet();
  await ask();
  warn.mockRestore(); log.mockRestore();
  await h.say("/llm", OWNER);
  const text = h.lastTo(OWNER)!;
  expect(text).toContain("groq/openai/gpt-oss-120b: daily cap");
  expect(text).toContain("cerebras/gpt-oss-120b: ready · 1 req/2400 · 500 tok/3000K today · 5/min pace");
  expect(text).not.toMatch(/https?:|api\.|dummy|KEY|org_/i);
  expect(h.sent.filter((s) => s.to === ALICE).every((s) => !/groq|cerebras/i.test(s.text))).toBe(true);
});

// ---------- 6. tests never reach a live provider ----------

test("with no mock installed a live call is refused before any network", async () => {
  setLlmForTests();
  process.env.GROQ_API_KEY = "dummy";
  const realFetch = globalThis.fetch;
  let networked = false;
  globalThis.fetch = (async () => ((networked = true), new Response("{}"))) as any;
  try {
    await expect(callLlm({ messages: [] })).rejects.toThrow(/refusing to call the live LLM/);
  } finally {
    globalThis.fetch = realFetch;
  }
  expect(networked).toBe(false);
});

// ---------- rehearsing a failover safely ----------

test("/llm off groq switches Groq off without touching any key: the next provider answers; /llm on restores it", async () => {
  const h = await harness();
  const groq = provider(say("from groq")), cerebras = provider(say("from cerebras"));
  setLlmForTests({ groq: groq.llm, cerebras: cerebras.llm });
  const [warn, log] = quiet();
  await h.say("/llm off groq", ALICE);
  expect(h.sent.filter((s) => s.to === ALICE)).toEqual([]); // owner only: silence for anyone else
  await h.say("/llm off groq 5", OWNER);
  expect(h.lastTo(OWNER)).toContain("groq is switched off for 5 min");
  expect(await ask()).toBe("from cerebras");
  expect(groq.calls).toHaveLength(0);
  await h.say("/llm", OWNER);
  expect(h.lastTo(OWNER)).toContain("groq/openai/gpt-oss-120b: forced off (5 min, by /llm)");
  expect(h.lastTo(OWNER)).toContain("cerebras/gpt-oss-120b: ready · 1 req");
  await h.say("/llm on", OWNER);
  expect(h.lastTo(OWNER)).toBe("All providers are back on.");
  t += 15_000;
  expect(await ask()).toBe("from groq");
  await h.say("/llm off nonsense", OWNER);
  expect(h.lastTo(OWNER)).toContain('Unknown provider "nonsense"');
  warn.mockRestore(); log.mockRestore();
});

test("the forced-off switch expires by itself, is capped at 2 hours, and with everything off the reply is the friendly one", async () => {
  const h = await harness();
  const groq = provider(say("from groq")), cerebras = provider(say("from cerebras"));
  setLlmForTests({ groq: groq.llm, cerebras: cerebras.llm });
  const [warn, log] = quiet();
  await h.say("/llm off groq 600", OWNER);
  expect(h.lastTo(OWNER)).toContain("switched off for 120 min");
  await h.say("/llm off cerebras 1", OWNER);
  expect(await ask()).toBe("I'm having trouble thinking right now, try again in a minute");
  expect(groq.calls.length + cerebras.calls.length).toBe(0);
  t += 61_000; // Cerebras's minute is up
  expect(await ask()).toBe("from cerebras");
  warn.mockRestore(); log.mockRestore();
});

test("qwen is the last resort: it answers only when Groq and Cerebras gpt-oss-120b are both unavailable", async () => {
  const groq = provider(fail(rate(TPM))), cerebras = provider((): any => { throw err(503, "down"); });
  const models: string[] = [];
  const both: LlmLike = { chat: { completions: { create: async (p: any) => {
    models.push(p.model);
    if (p.model === "gpt-oss-120b") throw err(503, "gpt-oss down");
    return ok("qwen answered");
  } } } };
  setLlmForTests({ groq: groq.llm, cerebras: both });
  const [warn, log] = quiet();
  expect(await ask()).toBe("qwen answered");
  expect(models).toEqual(["gpt-oss-120b", "qwen-3.8-27b"]);
  expect(cerebras.calls).toHaveLength(0);
  // qwen takes no reasoning_effort (that is a gpt-oss option) and gets the plain schemas
  warn.mockRestore(); log.mockRestore();
});

// ---------- 7. Cerebras is paid: out-of-credits, daily token cap, spend in /llm ----------

const noCredits = () => err(402, "Payment required: your prepaid credits are exhausted");

test("Cerebras out of credits (402): falls through, is marked unavailable, and the owner is texted exactly once", async () => {
  const texts: string[] = [];
  setLlmAlertHandler((x) => void texts.push(x));
  const cerebras = provider(fail(noCredits()));
  setLlmForTests({ groq: provider(fail(rate(TPD))).llm, cerebras: cerebras.llm });
  const [warn, log] = quiet();
  // groq is capped, every Cerebras model refuses with 402: the friendly "out for the day" reply, no crash
  expect(await ask()).toContain("used up today's AI quota");
  expect(texts).toEqual(["Cerebras credits ran out."]);
  const calls = cerebras.calls.length;
  await ask();
  expect(cerebras.calls).toHaveLength(calls); // not tried again today
  expect(texts).toHaveLength(1);
  expect(providerStatus().find((p) => p.name.startsWith("cerebras/gpt-oss"))!.state).toBe("daily cap");
  warn.mockRestore(); log.mockRestore();
});

test("an out-of-credits Cerebras hands the request to the next provider; the 402 text says nothing sensitive", async () => {
  const texts: string[] = [];
  setLlmAlertHandler((x) => void texts.push(x));
  setLlmForTests({ groq: provider(fail(rate(TPD))).llm, cerebras: provider([fail(noCredits()), say("qwen answered")]).llm });
  const [warn, log] = quiet();
  expect(await ask()).toBe("qwen answered"); // gpt-oss refused on credits, the next entry (same provider's key, other model) was still tried
  expect(texts).toEqual(["Cerebras credits ran out."]);
  warn.mockRestore(); log.mockRestore();
});

test("a billing refusal worded as 429 or 403 also counts as out of credits; a plain rate limit does not", async () => {
  const texts: string[] = [];
  setLlmAlertHandler((x) => void texts.push(x));
  setLlmForTests({ groq: provider(say("g")).llm, cerebras: provider(fail(err(429, "Insufficient credits to complete this request"))).llm });
  await h_off();
  const [warn, log] = quiet();
  await ask();
  expect(texts).toEqual(["Cerebras credits ran out."]);
  resetModelCooldowns();
  texts.length = 0;
  setLlmForTests({ groq: provider(say("g")).llm, cerebras: provider(fail(rate(TPM))).llm });
  await h_off();
  await ask();
  expect(texts).toEqual([]);
  warn.mockRestore(); log.mockRestore();
});
async function h_off() {
  const { forceProviderOff } = await import("../src/llm.ts");
  forceProviderOff("groq", 60);
}

test("after a top-up, /llm on clears the credits mark, and the next outage texts the owner again", async () => {
  const texts: string[] = [];
  setLlmAlertHandler((x) => void texts.push(x));
  let broke = true;
  setLlmForTests({ groq: provider(fail(rate(TPD))).llm, cerebras: provider(() => { if (broke) throw noCredits(); return ok("back"); }).llm });
  const h = await harness();
  const [warn, log] = quiet();
  await ask();
  expect(texts).toHaveLength(1);
  broke = false;
  await h.say("/llm on", OWNER);
  expect(await ask()).toBe("back");
  broke = true;
  t += 24 * 3600_000; // the next day: tried again, refused again
  await ask();
  expect(texts).toHaveLength(2);
  warn.mockRestore(); log.mockRestore();
});

test("daily token cap: once Cerebras has used CEREBRAS_DAILY_TOKEN_CAP it is skipped until midnight ET, then used again", async () => {
  process.env.CEREBRAS_DAILY_TOKEN_CAP = "1000";
  const groq = provider(fail(rate(TPD))), cerebras = provider(say("c", 600));
  setLlmForTests({ groq: groq.llm, cerebras: cerebras.llm });
  const [warn, log] = quiet();
  expect(await ask()).toBe("c");
  expect(await ask()).toBe("c"); // 1200 tokens now: over the cap of 1000
  expect(cerebras.calls).toHaveLength(2);
  expect(await ask()).toContain("used up today's AI quota");
  expect(cerebras.calls).toHaveLength(2); // skipped without a request
  t = Date.UTC(2026, 9, 17, 3, 59, 0); // 23:59 EDT, same ET day
  await ask();
  expect(cerebras.calls).toHaveLength(2);
  t = Date.UTC(2026, 9, 17, 4, 1, 0); // 00:01 EDT, next day
  groq.calls.length = 0;
  expect(await ask()).toBe("c");
  expect(cerebras.calls).toHaveLength(3);
  warn.mockRestore(); log.mockRestore();
});

test("the default cap is 300000 tokens a day, and a bad value falls back to it", async () => {
  process.env.CEREBRAS_DAILY_TOKEN_CAP = "lots";
  process.env.LLM_DAILY_TOKENS_OWNER = "100000000"; // the per-user budget is not what is under test
  setLlmForTests({ groq: provider(fail(rate(TPD))).llm, cerebras: provider(say("c", 200_000)).llm });
  const [warn, log] = quiet();
  await ask(); // 200K
  await ask(); // 400K: over 300K
  expect(await ask()).toContain("used up today's AI quota");
  warn.mockRestore(); log.mockRestore();
});

test("/llm shows Cerebras spend today and month to date, with the cap, at the configured price", async () => {
  process.env.LLM_DAILY_TOKENS_OWNER = "100000000";
  const h = await harness();
  setLlmForTests({ groq: provider(fail(rate(TPD))).llm, cerebras: provider(say("c", 100_000)).llm });
  const [warn, log] = quiet();
  await ask();
  t += 24 * 3600_000; // tomorrow, same month
  await ask();
  await ask();
  await h.say("/llm", OWNER);
  warn.mockRestore(); log.mockRestore();
  const text = h.lastTo(OWNER)!;
  expect(text).toContain("Cerebras spend (est.): $0.14 today (200K/300K tok cap, resets midnight ET) · $0.21 month to date");
  process.env.CEREBRAS_USD_PER_M_TOKENS = "1";
  await h.say("/llm", OWNER);
  expect(h.lastTo(OWNER)).toContain("$0.20 today (200K/300K tok cap, resets midnight ET) · $0.30 month to date");
});

test("a Groq-only chain shows no spend line", async () => {
  process.env.LLM_PROVIDERS = "groq:openai/gpt-oss-120b";
  process.env.GROQ_API_KEY = "dummy";
  const h = await harness();
  await h.say("/llm", OWNER);
  expect(h.lastTo(OWNER)).not.toContain("spend");
});
