import OpenAI from "openai";
import { addPaidUsage, addProviderUsage, getLlmFlag, paidTokensInMonth, paidTokensOn, providerUsageToday, setLlmFlag } from "./db.ts";

// The model layer: a chain of OpenAI-compatible providers (Groq, Cerebras, ...). One request goes to the first healthy entry
// and falls over to the next on 429, 5xx, timeouts, network errors, a daily cap or a bad key. A 400 caused by our own request
// never falls over (it would fail everywhere): it is thrown for the caller to fix or retry.

export type ProviderEntry = {
  provider: string;
  baseUrl: string;
  /** Name of the env var that holds the API key (never the key itself). */
  keyEnv: string;
  model: string;
  /** Requests per minute the provider allows for this model; requests are paced to stay under it. */
  rpm?: number;
  dailyTokens?: number;
  dailyRequests?: number;
  /** Send tool schemas as plain types (no ["string","null"] unions) and strip extra fields from echoed messages. */
  strict?: boolean;
  parallelToolCalls?: boolean;
};

export interface LlmLike {
  chat: { completions: { create(params: any): Promise<any> } };
}

// ---------- configuration ----------

const GROQ_URL = "https://api.groq.com/openai/v1";
const CEREBRAS_URL = "https://api.cerebras.ai/v1";

/** Known providers: where they live, which env var holds the key, and how they differ. */
export const PRESETS: Record<string, Omit<ProviderEntry, "model">> = {
  groq: { provider: "groq", baseUrl: GROQ_URL, keyEnv: "GROQ_API_KEY", parallelToolCalls: true },
  cerebras: { provider: "cerebras", baseUrl: CEREBRAS_URL, keyEnv: "CEREBRAS_API_KEY", strict: true },
};

/** What each model is limited to (from the providers' dashboards), unless an entry says otherwise. */
const MODEL_LIMITS: { provider: string; model: RegExp; rpm?: number; dailyTokens?: number; dailyRequests?: number }[] = [
  { provider: "groq", model: /gpt-oss-120b/, dailyTokens: 200_000, dailyRequests: 1_000 },
  { provider: "cerebras", model: /gpt-oss-120b/, rpm: 5, dailyTokens: 3_000_000, dailyRequests: 2_400 },
  { provider: "cerebras", model: /qwen/, rpm: 450, dailyTokens: 1_000_000_000 },
];

const withLimits = (e: ProviderEntry): ProviderEntry => {
  const l = MODEL_LIMITS.find((x) => x.provider === e.provider && x.model.test(e.model));
  return l ? { rpm: l.rpm, dailyTokens: l.dailyTokens, dailyRequests: l.dailyRequests, ...e } : e;
};

// Paid providers (prepaid credits): a daily token cap of our own, a spend estimate, and a one-time text to the owner when the credits run out.
const PAID: Record<string, { label: string; capEnv: string; defaultCap: number; priceEnv: string; defaultUsdPerMTok: number }> = {
  cerebras: { label: "Cerebras", capEnv: "CEREBRAS_DAILY_TOKEN_CAP", defaultCap: 300_000, priceEnv: "CEREBRAS_USD_PER_M_TOKENS", defaultUsdPerMTok: 0.7 },
};
const paidCap = (provider: string, env = process.env): number | null => {
  const p = PAID[provider];
  if (!p) return null;
  const n = env[p.capEnv]?.trim() ? Number(env[p.capEnv]) : NaN;
  return Number.isFinite(n) && n >= 0 ? n : p.defaultCap;
};
const usdPerMTok = (provider: string, env = process.env) => {
  const p = PAID[provider]!;
  const n = Number(env[p.priceEnv]);
  return Number.isFinite(n) && n > 0 ? n : p.defaultUsdPerMTok;
};

let alertOwner: ((text: string) => Promise<unknown> | unknown) | undefined;
/** The app registers how to text the owner (tests register a spy). */
export const setLlmAlertHandler = (f?: (text: string) => Promise<unknown> | unknown) => void (alertOwner = f);

const entryKey = (e: Pick<ProviderEntry, "provider" | "model">) => `${e.provider}/${e.model}`;

/** Groq's models, as before: LLM_MODELS ("a,b,c") wins, otherwise the single LLM_MODEL. */
export function modelChain(env = process.env): string[] {
  const list = (env.LLM_MODELS || "").split(",").map((m) => m.trim()).filter(Boolean);
  return list.length ? [...new Set(list)] : [env.LLM_MODEL || "openai/gpt-oss-120b"];
}

/**
 * The configured chain, in order, before keys are checked.
 *   LLM_PROVIDERS = "groq:openai/gpt-oss-120b,cerebras:gpt-oss-120b"   (shorthand, uses the built-in providers)
 *   LLM_PROVIDERS = [{"provider":"x","baseUrl":"https://…/v1","keyEnv":"X_API_KEY","model":"m"}, …]   (full entries)
 * Unset: Groq (LLM_MODELS / LLM_MODEL), then Cerebras gpt-oss-120b, then Cerebras qwen-3.8-27b.
 */
export function configuredEntries(env = process.env): ProviderEntry[] {
  const raw = (env.LLM_PROVIDERS || "").trim();
  if (raw.startsWith("[")) {
    const arr = JSON.parse(raw) as Partial<ProviderEntry>[];
    return arr.map((x) => {
      if (!x.provider || !x.baseUrl || !x.keyEnv || !x.model) throw new Error("LLM_PROVIDERS entries need provider, baseUrl, keyEnv and model");
      return withLimits(x as ProviderEntry);
    });
  }
  if (raw) {
    return raw.split(",").map((s) => s.trim()).filter(Boolean).map((s) => {
      const i = s.indexOf(":");
      const name = i < 0 ? s : s.slice(0, i), model = i < 0 ? "" : s.slice(i + 1);
      const preset = PRESETS[name];
      if (!preset || !model) throw new Error(`LLM_PROVIDERS: "${s}" is not provider:model (known providers: ${Object.keys(PRESETS).join(", ")})`);
      return withLimits({ ...preset, ...(name === "groq" && env.LLM_BASE_URL ? { baseUrl: env.LLM_BASE_URL } : {}), model });
    });
  }
  const groqUrl = env.LLM_BASE_URL || GROQ_URL;
  return [
    ...modelChain(env).map((model) => withLimits({ ...PRESETS.groq!, baseUrl: groqUrl, model })),
    withLimits({ ...PRESETS.cerebras!, model: "gpt-oss-120b" }),
    // last resort: far larger limits (about 450/min, 1B tokens/day). It passed the 10-prompt eval on fake data (scripts/llm-eval.ts)
    withLimits({ ...PRESETS.cerebras!, model: "qwen-3.8-27b" }),
  ];
}

let fake: LlmLike | Record<string, LlmLike> | undefined;
/** Tests inject a mock: one for every provider, or {groq: …, cerebras: …} per provider. */
export const setLlmForTests = (l?: LlmLike | Record<string, LlmLike>) => void (fake = l);
const fakeFor = (provider: string): LlmLike | undefined => (!fake ? undefined : "chat" in fake ? (fake as LlmLike) : (fake as Record<string, LlmLike>)[provider]);

/** The API key for an entry: its own env var, or (Groq only) the older LLM_API_KEY. Never logged. */
const keyFor = (e: ProviderEntry, env = process.env): string | undefined => env[e.keyEnv] || (e.provider === "groq" ? env.LLM_API_KEY : undefined) || undefined;

/** Entries that can be used: key present (a test's mock stands in for a key). Providers without a key are skipped. */
export function activeEntries(env = process.env): ProviderEntry[] {
  return configuredEntries(env).filter((e) => keyFor(e, env) || (fake && fakeFor(e.provider) && e.provider === "groq"));
}

// ---------- clock (injectable for tests) ----------

let clock = { now: () => Date.now(), sleep: (ms: number) => new Promise<void>((r) => setTimeout(r, ms)) };
export const setLlmClockForTests = (c?: Partial<typeof clock>) => void (clock = { now: () => Date.now(), sleep: (ms) => new Promise<void>((r) => setTimeout(r, ms)), ...c });

// ---------- health: cooldowns, daily caps and pacing ----------

const cooldown = new Map<string, number>(); // short pauses (a minute limit, a server error)
const dayCapped = new Map<string, { until: number; why: string; credits?: boolean }>(); // out for the day: remembered until the reset
const lastSlot = new Map<string, number>(); // pacing
const forcedOff = new Map<string, number>(); // the owner's /llm off <provider>: a safe way to rehearse a failover
export const resetModelCooldowns = () => (cooldown.clear(), dayCapped.clear(), lastSlot.clear(), forcedOff.clear());

/** Pretend a provider is down for a while (in memory only; a restart clears it). Returns false for an unknown provider. */
export function forceProviderOff(provider: string, minutes: number, env = process.env): boolean {
  if (!configuredEntries(env).some((e) => e.provider === provider)) return false;
  forcedOff.set(provider, clock.now() + minutes * 60_000);
  return true;
}
/** /llm on: also forgets "out of credits" marks, so a top-up takes effect without waiting for midnight. */
export const clearForcedOff = () => {
  forcedOff.clear();
  for (const [k, c] of dayCapped) if (c.credits) dayCapped.delete(k);
};

export const PACE_MAX_WAIT_MS = 5_000;
const MAX_AUTO_RETRY_WAIT_S = 8;

const nextUtcMidnight = (now: number) => {
  const d = new Date(now);
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() + 1);
};
const utcDay = (now: number) => new Date(now).toISOString().slice(0, 10);

// Paid spend is counted by the owner's local day (ET by default), so "midnight ET" is when the cap resets.
const zone = (env = process.env) => env.TIMEZONE || "America/New_York";
const localDay = (now: number, env = process.env) => new Intl.DateTimeFormat("en-CA", { timeZone: zone(env), year: "numeric", month: "2-digit", day: "2-digit" }).format(now);
function nextLocalMidnight(now: number, env = process.env): number {
  const today = localDay(now, env);
  let lo = now, hi = now + 25 * 3600_000; // the day changes somewhere in between
  while (hi - lo > 1000) {
    const mid = Math.floor((lo + hi) / 2);
    if (localDay(mid, env) === today) lo = mid;
    else hi = mid;
  }
  return hi;
}

/** Wait (ms) before this model may be called without exceeding its requests-per-minute, or null if that would be too long. */
function reserveSlot(e: ProviderEntry): number | null {
  if (!e.rpm) return 0;
  const gap = Math.ceil(60_000 / e.rpm);
  const now = clock.now();
  const slot = Math.max(now, (lastSlot.get(entryKey(e)) ?? -Infinity) + gap);
  if (slot - now > PACE_MAX_WAIT_MS) return null;
  lastSlot.set(entryKey(e), slot);
  return slot - now;
}

// ---------- failures ----------

/** Every provider is limited or down. `day`: all out for the day; `minute`: busy or down, worth a retry shortly. */
export class RateLimited extends Error {
  constructor(public kind: "minute" | "day", public waitSeconds: number | null, message: string) {
    super(message);
  }
}

function parseWaitSeconds(text: string): number | null {
  const m = text.match(/try again in\s+((?:\d+h)?(?:\d+m)?(?:[\d.]+s)?)/i);
  if (!m || !m[1]) return null;
  const parts = m[1].match(/(\d+)h|(\d+)m|([\d.]+)s/g) ?? [];
  let sec = 0;
  for (const p of parts) sec += p.endsWith("h") ? parseFloat(p) * 3600 : p.endsWith("m") ? parseFloat(p) * 60 : parseFloat(p);
  return parts.length ? sec : null;
}

const header = (e: any, k: string) => (typeof e?.headers?.get === "function" ? e.headers.get(k) : e?.headers?.[k]);

export function classifyRateLimit(e: any): { kind: "minute" | "day"; waitSeconds: number | null; text: string } | null {
  if (e?.status !== 429) return null;
  const text = String(e?.error?.message ?? e?.message ?? "").replace(/org_\w+/g, "org_***");
  const retryAfter = Number(header(e, "retry-after"));
  // Cerebras reports the daily reset in x-ratelimit-reset-*-day; Groq says "try again in 7m12s"
  const dayReset = Number(header(e, "x-ratelimit-reset-tokens-day") ?? header(e, "x-ratelimit-reset-requests-day"));
  const isDay = /per day|\(TPD\)|\(RPD\)|daily|day limit|requests_per_day|tokens_per_day|quota/i.test(text);
  return {
    kind: isDay ? "day" : "minute",
    waitSeconds: parseWaitSeconds(text) ?? (isDay && Number.isFinite(dayReset) && dayReset > 0 ? dayReset : null) ?? (Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter : null),
    text,
  };
}

type Failure = { kind: "minute" | "day" | "down" | "auth" | "credits"; waitSeconds: number | null; text: string };

/** What a thrown error means for failover. null = our own request was bad (a 400): never fail over for that. */
function classifyFailure(e: any): Failure | null {
  const status0 = Number(e?.status);
  const text0 = String(e?.error?.message ?? e?.message ?? "").replace(/org_\w+/g, "org_***").slice(0, 300);
  // prepaid credits used up: 402 Payment Required, or a refusal that says so in words
  if (status0 === 402 || ([403, 429].includes(status0) && /insufficient (credit|balance|fund)|out of credit|no (more )?credits|credits? (have been )?(exhausted|depleted|used)|billing|payment required/i.test(text0))) return { kind: "credits", waitSeconds: null, text: `${status0} ${text0}` };
  const rl = classifyRateLimit(e);
  if (rl) return rl;
  const status = Number(e?.status);
  const text = String(e?.error?.message ?? e?.message ?? "").replace(/org_\w+/g, "org_***").slice(0, 300);
  if (status >= 500) return { kind: "down", waitSeconds: 30, text: `${status} ${text}` };
  if (status === 408) return { kind: "down", waitSeconds: 30, text: `timeout ${text}` };
  if (status === 401 || status === 403) return { kind: "auth", waitSeconds: 600, text: `${status} ${text}` };
  if (status === 404) return { kind: "auth", waitSeconds: 3600, text: `404 ${text}` }; // model or endpoint not found: a config problem on that provider
  if (!Number.isFinite(status) || !status) {
    // no HTTP status: a timeout, a dropped connection, DNS. Not an error in what we sent.
    if (/timeout|timed out|abort|ECONN|ENOTFOUND|EAI_AGAIN|socket|network|fetch failed|connection/i.test(`${e?.name} ${e?.code} ${e?.message}`)) return { kind: "down", waitSeconds: 30, text: `network ${text}` };
  }
  return null;
}

// ---------- clients ----------

const clients = new Map<string, LlmLike>();
function clientFor(e: ProviderEntry): LlmLike {
  const f = fakeFor(e.provider);
  if (f) return f;
  // automated tests must never spend a live key's quota
  if (process.env.NODE_ENV === "test") throw new Error("refusing to call the live LLM from a test: use setLlmForTests() with a mock");
  const key = keyFor(e);
  if (!key) throw new Error(`no API key for ${e.provider}`);
  const id = `${e.baseUrl}|${e.keyEnv}`;
  let c = clients.get(id);
  // maxRetries 0: the SDK would otherwise retry 429s silently and stall a reply; the chain does the failing over
  if (!c) clients.set(id, (c = new OpenAI({ baseURL: e.baseUrl, apiKey: key, maxRetries: 0, timeout: Number(process.env.LLM_TIMEOUT_MS) || 30_000 }) as unknown as LlmLike));
  return c;
}

// ---------- per-provider request shaping ----------

/** ["string","null"] -> "string": optional fields are simply left out, which every provider accepts. */
export function simplifySchema<T>(node: T): T {
  if (Array.isArray(node)) return node.map(simplifySchema) as unknown as T;
  if (node && typeof node === "object") {
    const o: any = {};
    for (const [k, v] of Object.entries(node as any)) {
      if (k === "type" && Array.isArray(v)) {
        const real = v.filter((t) => t !== "null");
        o[k] = real.length === 1 ? real[0] : real;
      } else o[k] = simplifySchema(v);
    }
    return o;
  }
  return node;
}

/** Only the fields the OpenAI chat format defines (another provider's extras, like Groq's "reasoning", can get a 400). */
export function cleanMessages(messages: any[]): any[] {
  return messages.map((m) => {
    if (m.role === "assistant") {
      const out: any = { role: "assistant", content: m.content ?? "" };
      if (m.tool_calls?.length) out.tool_calls = m.tool_calls.map((t: any) => ({ id: t.id, type: "function", function: { name: t.function?.name, arguments: t.function?.arguments ?? "{}" } }));
      return out;
    }
    if (m.role === "tool") return { role: "tool", tool_call_id: m.tool_call_id, content: m.content };
    return { role: m.role, content: m.content };
  });
}

/** The request for one entry. Groq's request is left exactly as it was. */
export function paramsFor(e: ProviderEntry, base: any): any {
  const p: any = { ...base, model: e.model };
  if (/gpt-oss/i.test(e.model)) p.reasoning_effort = process.env.LLM_REASONING_EFFORT || "low"; // reasoning tokens are billed as output
  if (e.parallelToolCalls === false || (e.strict && "parallel_tool_calls" in p)) delete p.parallel_tool_calls;
  if (e.strict) {
    if (p.tools) p.tools = simplifySchema(p.tools);
    if (p.messages) p.messages = cleanMessages(p.messages);
  }
  return p;
}

// ---------- the call ----------

const trunc = (s: string) => s.slice(0, 300);

/** Our own spend cap for a paid provider: its tokens today (local day) have reached CEREBRAS_DAILY_TOKEN_CAP. */
function overPaidCap(e: ProviderEntry): boolean {
  const cap = paidCap(e.provider);
  if (cap === null) return false;
  try {
    return paidTokensOn(localDay(clock.now()), e.provider) >= cap;
  } catch {
    return false;
  }
}

/** Past ~97% of a daily cap we know of, skip the model instead of spending a request on a refusal. */
async function nearDailyCap(e: ProviderEntry): Promise<boolean> {
  if (!e.dailyTokens && !e.dailyRequests) return false;
  const u = providerUsageToday(utcDay(clock.now())).find((r) => r.provider === e.provider && r.model === e.model);
  if (!u) return false;
  return (!!e.dailyTokens && u.tokens >= e.dailyTokens * 0.97) || (!!e.dailyRequests && u.requests >= e.dailyRequests * 0.97);
}

async function tellOwnerOnce(provider: string) {
  if (!alertOwner) return;
  try {
    if (getLlmFlag(`credits-alert:${provider}`)) return;
    setLlmFlag(`credits-alert:${provider}`, "sent");
    await alertOwner(`${PAID[provider]?.label ?? provider} credits ran out.`);
  } catch {
    /* an alert must never break an answer */
  }
}

/**
 * One request through the chain. Returns the response and who answered. Throws RateLimited when nothing could answer,
 * and rethrows (without failing over) any error that is our own request's fault.
 */
export async function callLlm(base: any): Promise<{ res: any; model: string; provider: string }> {
  const chain = activeEntries();
  if (!chain.length) throw new Error("no LLM provider is configured (set GROQ_API_KEY or CEREBRAS_API_KEY)");
  for (let pass = 0; ; pass++) {
    const now = clock.now();
    // out for the day: not tried again until the reset. Cooling for a minute: tried last-resort only if nothing else is left
    const live = chain.filter((e) => (dayCapped.get(entryKey(e))?.until ?? 0) <= now && (forcedOff.get(e.provider) ?? 0) <= now);
    let order = live.filter((e) => (cooldown.get(entryKey(e)) ?? 0) <= now);
    if (!order.length) order = [...live].sort((a, b) => (cooldown.get(entryKey(a)) ?? 0) - (cooldown.get(entryKey(b)) ?? 0));
    const failures: Failure[] = [];
    for (const e of live.length ? [] : chain.filter((x) => dayCapped.has(entryKey(x)))) {
      const c = dayCapped.get(entryKey(e))!;
      failures.push({ kind: "day", waitSeconds: Math.ceil((c.until - now) / 1000), text: `${entryKey(e)} out for the day (${c.why})` });
    }
    for (const [i, e] of order.entries()) {
      const k = entryKey(e);
      const nextName = order[i + 1] ? ` -> trying ${entryKey(order[i + 1]!)}` : "";
      if (overPaidCap(e)) {
        failures.push({ kind: "day", waitSeconds: Math.ceil((nextLocalMidnight(now) - now) / 1000), text: `${k} is at our daily spend cap` });
        console.warn(`llm: ${k} is at our daily spend cap (${PAID[e.provider]!.capEnv}); skipping until midnight${nextName}`);
        continue;
      }
      if (await nearDailyCap(e)) {
        failures.push({ kind: "day", waitSeconds: Math.ceil((nextUtcMidnight(now) - now) / 1000), text: `${k} is at its daily cap` });
        console.warn(`llm: ${k} is at its daily cap by our own count; skipping${nextName}`);
        continue;
      }
      const wait = reserveSlot(e);
      if (wait === null) {
        failures.push({ kind: "minute", waitSeconds: Math.ceil(((lastSlot.get(k) ?? now) + Math.ceil(60_000 / (e.rpm ?? 1)) - now) / 1000), text: `${k} paced` });
        console.warn(`llm: ${k} is at its ${e.rpm}/min pace and would make this reply wait over ${PACE_MAX_WAIT_MS / 1000}s; skipping${nextName}`);
        continue;
      }
      if (wait > 0) await clock.sleep(wait);
      try {
        const res = await clientFor(e).chat.completions.create(paramsFor(e, base));
        cooldown.delete(k);
        try {
          addProviderUsage(utcDay(clock.now()), e.provider, e.model, res?.usage?.total_tokens ?? 0);
          if (PAID[e.provider]) {
            addPaidUsage(localDay(clock.now()), e.provider, res?.usage?.total_tokens ?? 0);
            setLlmFlag(`credits-alert:${e.provider}`, null); // it answered, so credits are back: the next outage gets a new text
          }
        } catch {
          /* usage tracking must never break an answer */
        }
        if (i > 0 || e !== chain[0]) console.warn(`llm: answered by ${k}${failures.length ? ` after ${failures.length} skipped or failed` : ""}`);
        return { res, model: e.model, provider: e.provider };
      } catch (err: any) {
        const f = classifyFailure(err);
        if (!f) throw err; // our own request was refused: failing over would only fail again
        failures.push(f.kind === "credits" ? { ...f, kind: "day", waitSeconds: Math.ceil((nextLocalMidnight(clock.now()) - clock.now()) / 1000) } : f);
        if (f.kind === "credits") {
          // like a daily cap: out until tomorrow (or /llm on after a top-up), and the owner hears about it once
          dayCapped.set(k, { until: nextLocalMidnight(clock.now()), why: "out of credits", credits: true });
          await tellOwnerOnce(e.provider);
        } else if (f.kind === "day") {
          // remember it until its reset: the longer of what it asked for and (when it gave no time) midnight UTC
          const until = f.waitSeconds && f.waitSeconds > 60 ? clock.now() + f.waitSeconds * 1000 : nextUtcMidnight(clock.now());
          dayCapped.set(k, { until: Math.min(until, clock.now() + 24 * 3600_000), why: trunc(f.text) });
        } else {
          cooldown.set(k, clock.now() + Math.min(3600, f.kind === "minute" ? (f.waitSeconds ?? 5) + 0.5 : (f.waitSeconds ?? 30)) * 1000);
        }
        // never the key, never an org id; the message is the provider's own text
        console.warn(`llm: ${k} failed (${f.kind}): ${trunc(f.text)} | retry-after=${header(err, "retry-after") ?? "-"} remaining-tokens=${header(err, "x-ratelimit-remaining-tokens") ?? "-"}${f.kind === "day" ? " | out until reset" : ""}${nextName}`);
      }
    }
    const shortWaits = failures.filter((f) => f.kind === "minute" && (f.waitSeconds ?? 5) <= MAX_AUTO_RETRY_WAIT_S).map((f) => f.waitSeconds ?? 5);
    if (pass === 0 && shortWaits.length) {
      await clock.sleep((Math.min(...shortWaits) + 0.5) * 1000);
      continue;
    }
    const allDay = failures.length > 0 && failures.every((f) => f.kind === "day");
    const waits = failures.map((f) => f.waitSeconds).filter((w): w is number => w !== null && w > 0);
    throw new RateLimited(allDay ? "day" : "minute", waits.length ? Math.min(...waits) : null, failures.map((f) => f.text).join(" | "));
  }
}

const human = (sec: number) => (sec < 90 ? "a minute" : sec < 5400 ? `${Math.ceil(sec / 60)} minutes` : `${Math.floor(sec / 3600)}h ${Math.round((sec % 3600) / 60)}m`);

export function rateLimitedMessage(e: RateLimited): string {
  if (e.kind === "minute") return "I'm having trouble thinking right now, try again in a minute";
  return `I've used up today's AI quota${e.waitSeconds ? `, try again in about ${human(e.waitSeconds)}` : ", try again later"}. Texting "what's due" still works.`;
}

// ---------- status (owner's /llm) ----------

export type ProviderStatus = { name: string; state: "ready" | "cooling" | "daily cap" | "no key" | "forced off"; detail: string; requests: number; tokens: number; rpm?: number; dailyTokens?: number; dailyRequests?: number };

/** What the owner sees for /llm: names, state and usage. No keys, no URLs. */
export function providerStatus(env = process.env): ProviderStatus[] {
  const now = clock.now();
  const usage = providerUsageToday(utcDay(now));
  return configuredEntries(env).map((e) => {
    const k = entryKey(e);
    const u = usage.find((r) => r.provider === e.provider && r.model === e.model);
    const base = { name: k, requests: u?.requests ?? 0, tokens: u?.tokens ?? 0, rpm: e.rpm, dailyTokens: e.dailyTokens, dailyRequests: e.dailyRequests };
    if (!(keyFor(e, env) || (fake && fakeFor(e.provider) && e.provider === "groq"))) return { ...base, state: "no key" as const, detail: `set ${e.keyEnv}` };
    if ((forcedOff.get(e.provider) ?? 0) > now) return { ...base, state: "forced off" as const, detail: `${Math.ceil(((forcedOff.get(e.provider) ?? 0) - now) / 60_000)} min, by /llm` };
    const c = dayCapped.get(k);
    if (c && c.until > now) return { ...base, state: "daily cap" as const, detail: c.credits ? "out of credits, /llm on after a top-up" : `until ${new Date(c.until).toISOString().slice(11, 16)} UTC` };
    if (overPaidCap(e)) return { ...base, state: "daily cap" as const, detail: "spend cap, until midnight" };
    const cd = cooldown.get(k) ?? 0;
    if (cd > now) return { ...base, state: "cooling" as const, detail: `${Math.ceil((cd - now) / 1000)}s` };
    return { ...base, state: "ready" as const, detail: "" };
  });
}

export type PaidSpend = { label: string; cap: number; tokensToday: number; usdToday: number; tokensMonth: number; usdMonth: number; month: string };

/** Estimated spend on paid providers (our own token count x the per-million price), today and this month, by local day. */
export function paidSpend(env = process.env): PaidSpend[] {
  const now = clock.now();
  const day = localDay(now, env);
  return Object.keys(PAID).filter((p) => configuredEntries(env).some((e) => e.provider === p)).map((p) => {
    const tokensToday = paidTokensOn(day, p), tokensMonth = paidTokensInMonth(day.slice(0, 7), p);
    return { label: PAID[p]!.label, cap: paidCap(p, env)!, tokensToday, usdToday: (tokensToday / 1e6) * usdPerMTok(p, env), tokensMonth, usdMonth: (tokensMonth / 1e6) * usdPerMTok(p, env), month: day.slice(0, 7) };
  });
}
