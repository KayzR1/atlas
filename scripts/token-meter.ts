/**
 * Estimates what a question costs in LLM tokens WITHOUT calling any provider, then what each provider in the chain can carry.
 * It replays the tool-call sequence the model makes, builds the exact request each round would send
 * (real system prompt, real tool schemas, real tool results from your Canvas), and converts size to tokens.
 *
 *   bun scripts/token-meter.ts
 *
 * Calibration: Groq reported 1,358 tokens for a 7,051-char request, so ~5.19 chars/token.
 * Output tokens are assumed (80 per round + tool-call arguments) and are the same before/after any change.
 */
import { buildSystemPrompt, executeTool, toolsForRole } from "../src/agent.ts";
import { handleConfirmation, needsCalendarTools } from "../src/calendar.ts";
import { runWithContext, type UserContext } from "../src/context.ts";
import { courseLabel } from "../src/assignments.ts";
import { ensureOwner, initDb } from "../src/db.ts";
import { configuredEntries } from "../src/llm.ts";

const CHARS_PER_TOKEN = 7051 / 1358;
const OUT_PER_ROUND = 80;
const KEY = "+10000000000";

initDb(":memory:");
ensureOwner(KEY);
const ctx: UserContext = {
  key: KEY, role: "owner", timezone: process.env.TIMEZONE || "America/New_York",
  canvasUrl: process.env.CANVAS_URL || "https://uncch.instructure.com", canvasToken: process.env.CANVAS_TOKEN || "",
};

const history = [
  { role: "user", content: "hey" }, { role: "assistant", content: "Hey! What can I help you with today?" },
  { role: "user", content: "what's my grade in data 101" }, { role: "assistant", content: "Your current grade in DATA 101 is 95.19% (an A)." },
  { role: "user", content: "any announcements" }, { role: "assistant", content: "Here are the latest announcements: No office hours today (DATA 101), midterm reminder (ECON 210)." },
];

type Call = { tool: string; args: any };
const roundsLog: number[] = [];

async function meter(question: string, plan: (run: (c: Call) => Promise<string>) => Promise<Call[]>, finalAnswer: string | ((lastResult: string) => string)) {
  // the same decision the bot makes: calendar tools only ride along when the message looks calendar-related
  const calendar = needsCalendarTools(KEY, [{ role: "user", content: question }]);
  const tools = toolsForRole("owner", { calendar });
  const system = buildSystemPrompt(KEY, { calendar });
  const messages: any[] = [{ role: "system", content: system }, ...history, { role: "user", content: question }];
  let totalIn = 0, totalOut = 0, rounds = 0, lastResult = "";
  const rows: string[] = [];
  const request = () => JSON.stringify({ model: "m", messages, tools, tool_choice: "auto", parallel_tool_calls: false });

  const calls = await plan(async (c) => executeTool(c.tool, c.args, KEY));
  for (const [i, c] of calls.entries()) {
    const result = await executeTool(c.tool, c.args, KEY);
    lastResult = result;
    const inTok = request().length / CHARS_PER_TOKEN;
    const outTok = OUT_PER_ROUND + JSON.stringify(c.args).length / 4;
    totalIn += inTok; totalOut += outTok; rounds++;
    if (i < 3 || i === calls.length - 1) rows.push(`    round ${rounds}: in ${Math.round(inTok)} (${c.tool}, result ${result.length} chars)`);
    else if (i === 3) rows.push("    ...");
    messages.push({ role: "assistant", content: null, tool_calls: [{ id: `c${i}`, type: "function", function: { name: c.tool, arguments: JSON.stringify(c.args) } }] });
    messages.push({ role: "tool", tool_call_id: `c${i}`, content: result });
  }
  const inTok = request().length / CHARS_PER_TOKEN;
  const answerText = typeof finalAnswer === "function" ? finalAnswer(lastResult) : finalAnswer;
  const outTok = OUT_PER_ROUND + answerText.length / 4;
  totalIn += inTok; totalOut += outTok; rounds++;
  rows.push(`    round ${rounds}: in ${Math.round(inTok)} (final answer)`);
  await handleConfirmation(KEY, "no"); // drop whatever this question staged; a pending change would (correctly) switch the calendar tools on for the next one
  const total = Math.round(totalIn + totalOut);
  roundsLog.push(rounds);
  console.log(`\n"${question}": ${rounds} round(s) -> ~${total.toLocaleString()} tokens (${Math.round(totalIn).toLocaleString()} in + ${Math.round(totalOut)} out)  [calendar tools ${calendar ? "ON" : "off"}]`);
  for (const r of rows) console.log(r);
  return total;
}

await runWithContext(ctx, async () => {
  const base = (calendar: boolean) => {
    const chars = buildSystemPrompt(KEY, { calendar }).length + JSON.stringify(toolsForRole("owner", { calendar })).length;
    return `${chars} chars = ~${Math.round(chars / CHARS_PER_TOKEN)} tokens per round`;
  };
  console.log(`owner request base, full toolset (calendar question):  ${base(true)}`);
  console.log(`owner request base, Canvas-only (calendar tools gated out): ${base(false)}`);
  const hasOverview = toolsForRole("owner").some((t) => t.function.name === "get_due_overview");
  // questions use the first course that has a grade in whichever Canvas this runs against (no course names baked in)
  const mine = (JSON.parse(await executeTool("list_courses", {}, KEY)) as { name: string; code?: string; current_score: number | null }[]).filter((c) => c.current_score !== null);
  const label = courseLabel(mine.find((c) => /^[A-Za-z]{2,5}\d/.test(c.code ?? "")) ?? mine[0] ?? { name: "DATA 101" });

  const results: Record<string, number> = {};
  results["what's due this week"] = await meter("what's due this week", async () => {
    if (hasOverview) return [{ tool: "get_due_overview", args: { days: 7 } }];
    const courses = JSON.parse(await executeTool("list_courses", {}, KEY)) as { id: number }[];
    return [
      { tool: "list_courses", args: {} },
      ...courses.map((c) => ({ tool: "list_assignments", args: { course_id: c.id, bucket: "upcoming" } })),
      { tool: "get_todo", args: {} },
    ];
  }, "You have nothing due before Sunday. Next up is a project due Thursday at 3 PM.");
  results["what's my grade in <course>"] = await meter(`what's my grade in ${label}`, async () => [{ tool: "list_courses", args: {} }], `Your current grade in ${label} is an A- (92.73%).`);
  results["what do I need on the final for an A"] = await meter(`what do I need on the final to get an A in ${label}`, async () => [{ tool: "grade_calc", args: { course: label, target: "A", assignment: "final exam" } }], "You'd need about 97.5% on the final for an A if nothing else changes, and an A isn't reachable if your other ungraded groups score like you do now.");
  const tomorrow8pm = new Date(Date.now() + 86400_000).toLocaleDateString("en-CA", { timeZone: ctx.timezone }) + "T20:00";
  results["remind me to submit the homework tomorrow 8pm"] = await meter("remind me to submit the homework tomorrow at 8pm", async () => [{ tool: "create_reminder", args: { text: "submit the homework", when: tomorrow8pm } }], (r) => r.split("nothing else: ")[1] ?? r);
  results["plan my week (model path)"] = await meter("can you plan my week", async () => [{ tool: "plan_week", args: {} }], (r) => r.split("exactly as written, nothing else:\n")[1] ?? r);
  results["late policy question"] = await meter(`what's the late policy in ${label}`, async () => [{ tool: "ask_syllabus", args: { course: label, question: "what is the late policy" } }], "Homework and labs are accepted up to 48 hours late: under 24 hours late earns at most 3/4 credit, and 24 to 48 hours late earns less.");
  results["small talk (hey)"] = await meter("hey", async () => [], "Hey! What can I help you with today?");
  console.log("\nNo-LLM paths (0 tokens): plain \"what's due\", \"plan my week\", the morning brief, the Sunday preview, nudges, and yes/no/1,3 replies.");
  // what each provider in the chain can carry, from its limits (no provider is called)
  const tokens = Object.values(results), avgTok = tokens.reduce((a, b) => a + b, 0) / tokens.length, avgRounds = roundsLog.reduce((a, b) => a + b, 0) / roundsLog.length;
  console.log(`\nPer provider (average question above: ~${Math.round(avgTok).toLocaleString()} tokens over ~${avgRounds.toFixed(1)} requests; fast paths cost 0):`);
  for (const e of configuredEntries()) {
    const byTokens = e.dailyTokens ? Math.floor(e.dailyTokens / avgTok) : null, byRequests = e.dailyRequests ? Math.floor(e.dailyRequests / avgRounds) : null;
    const perDay = Math.min(...[byTokens, byRequests, e.rpm ? Math.floor((e.rpm * 60 * 24) / avgRounds) : null].filter((n): n is number => n !== null));
    const perMin = e.rpm ? (e.rpm / avgRounds).toFixed(1) : "no pace limit";
    console.log(`  ${e.provider}/${e.model}: ~${Number.isFinite(perDay) ? perDay.toLocaleString() : "unlimited"} questions/day (by tokens ${byTokens?.toLocaleString() ?? "-"}, by requests ${byRequests?.toLocaleString() ?? "-"}), sustained ${perMin}/min`);
  }
  console.log("\nSUMMARY " + JSON.stringify(results));
});
