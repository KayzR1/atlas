import { currentContext, type UserContext } from "./context.ts";
import { addTokens, tokensToday } from "./db.ts";

export const LIMIT_MSG = "daily limit reached, try tomorrow";

/** Daily LLM token cap per user. The owner gets a higher one, but is capped too so nobody can drain the shared pool by accident. */
export function dailyCap(role: UserContext["role"] = "member"): number {
  const n = Number(role === "owner" ? process.env.LLM_DAILY_TOKENS_OWNER : process.env.LLM_DAILY_TOKENS_PER_USER);
  return Number.isFinite(n) && n > 0 ? n : role === "owner" ? 100_000 : 50_000;
}

const dayKey = (ctx: UserContext) => new Date().toLocaleDateString("en-CA", { timeZone: ctx.timezone });

export function isOverBudget(ctx: UserContext | undefined = currentContext()): boolean {
  if (!ctx) return false;
  return tokensToday(ctx.key, dayKey(ctx)) >= dailyCap(ctx.role);
}

/** Record usage reported by Groq (usage.total_tokens). */
export function recordTokens(n: number | undefined, ctx: UserContext | undefined = currentContext()) {
  if (!ctx || !n || n <= 0) return;
  addTokens(ctx.key, dayKey(ctx), n);
}
