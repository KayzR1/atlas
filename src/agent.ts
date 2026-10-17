import type OpenAI from "openai";
import { runTool, tools as canvasTools } from "./canvas.ts";
import { calendarPromptRules, calendarTools, lastEventPrompt, needsCalendarTools, runCalendarTool } from "./calendar.ts";
import { isOverBudget, LIMIT_MSG, recordTokens } from "./budget.ts";
import { currentContext, requireContext, type Role } from "./context.ts";
import { dueWindow } from "./assignments.ts";
import { botName } from "./brand.ts";
import { getUser } from "./db.ts";
import { maskId } from "./mask.ts";
import { classPromptLine, looksClassRelated, normalizeLlmClasses, type ClassSpec } from "./classes.ts";
import { gradeTools, runGradeTool } from "./grades.ts";
import { gpaTools, looksGpaRelated, runGpaTool } from "./gpa.ts";
import { plannerTools, runPlannerTool } from "./planner.ts";
import { runSyllabusTool, syllabusTools } from "./syllabus.ts";

const calendarToolNames = new Set([...calendarTools, ...plannerTools].map((t) => t.function.name)); // owner-only

/**
 * Members never even see the calendar tools. For the owner they are sent only when the message looks calendar-related
 * (`calendar: false` leaves them out); the default is everything.
 */
export function toolsForRole(role: Role, opts: { calendar?: boolean; gpa?: boolean } = {}) {
  const base = [...canvasTools, ...gradeTools, ...(opts.gpa ? gpaTools : []), ...syllabusTools];
  return role === "owner" && opts.calendar !== false ? [...base, ...calendarTools, ...plannerTools] : base;
}

/** Run one tool call for the current user; calendar tools are refused for non-owners. */
export async function executeTool(name: string, args: any, convKey: string): Promise<string> {
  if (calendarToolNames.has(name)) {
    if (requireContext().role !== "owner") return `Error: unknown tool ${name}`;
    if (name === "plan_week") return runPlannerTool(convKey);
    return runCalendarTool(name, args, convKey);
  }
  if (name === "grade_calc") return runGradeTool(args);
  if (name === "gpa_calc") return runGpaTool(args);
  if (name === "ask_syllabus") return runSyllabusTool(args);
  return runTool(name, args);
}

const MAX_ROUNDS = 12;

export type Turn = { role: "user" | "assistant"; content: string };

import { callLlm, RateLimited, rateLimitedMessage } from "./llm.ts";
export { classifyRateLimit, modelChain, rateLimitedMessage, RateLimited, resetModelCooldowns, setLlmForTests, type LlmLike } from "./llm.ts";

/** Exported for tests. `key` is the conversation, used to tell the model which calendar event "that" means. */
export function buildSystemPrompt(key = "default", opts: { calendar?: boolean; classes?: boolean; gpa?: boolean } = {}): string {
  const { timezone: TZ, role } = requireContext();
  let firstName: string | null = null;
  try {
    firstName = getUser(key)?.first_name ?? null;
  } catch {
    firstName = null; // no database (a bare prompt build)
  }
  const nowDate = new Date();
  const now = nowDate.toLocaleString("en-US", { timeZone: TZ, dateStyle: "full", timeStyle: "short" });
  // "this week" runs through Sunday night: tell the model the matching `days` value so it needn't compute it
  const weekDays = Math.max(1, Math.ceil((dueWindow("week", nowDate, TZ).until.getTime() - nowDate.getTime()) / 86400_000));
  const calendarRules =
    role === "owner" && opts.calendar === false
      ? // calendar tools aren't loaded for this message: say they exist so the model can still ask for one (the agent then loads them)
        `- Calendar tools (list/create/find/update/delete_calendar_event, create_reminder, plan_week) exist but aren't loaded for this message; if the user needs one, call it by name.
`
      : role === "owner"
      ? `- Calendar: list_calendar_events reads it; for "what's my day/week" combine it with get_due_overview. Resolve weekdays against the date above.
${calendarPromptRules}
- ${lastEventPrompt(key)}
`
      : `- You have no calendar access. For "what's my day/week" use get_due_overview.
`;
  return `You are ${botName()}, a friendly, calm assistant keeping the user's semester (Canvas, UNC) under control. Be brief.${firstName ? ` The user's first name is ${firstName}.` : ""}
Now: ${now} (${TZ}).
Rules:
- Use tools; never guess grades, dates or assignments.
- list_courses gives course ids (match names/codes like "DATA 101" loosely). Canvas "due"/"posted" fields are already in ${TZ}.
- Grade math (grade needed on the final, weighted grade): call grade_calc once, relay its numbers; never compute grades yourself.
- Never say you can't compute something when a reasonable assumption exists: answer first, then one short line naming the assumption and how to change it; never end with "let me know how you'd like to proceed".${opts.gpa ? `\n- GPA (projected, what-if, goal): call gpa_calc once and relay its reply.` : ""}
- Policy questions (late policy, what's on the exam, office hours): call ask_syllabus and answer only from its text; if it says not found, say it isn't in the syllabus.
- "What's due" across courses: call get_due_overview once (default days=7; "this week" = through Sunday night = days ${weekDays}). list_assignments is for one course.
${calendarRules}${(opts.classes && classPromptLine(key)) ? `- ${classPromptLine(key)}\n` : ""}- Reply like a text: short, plain text, no markdown.`;
}

async function complete(messages: OpenAI.Chat.ChatCompletionMessageParam[], calendar = true, gpa = false, used?: Set<string>) {
  const tools = toolsForRole(requireContext().role, { calendar, gpa });
  const base = { messages, tools, tool_choice: "auto", parallel_tool_calls: false, max_completion_tokens: Number(process.env.LLM_MAX_OUTPUT_TOKENS) || 1500 };
  const { res, model, provider } = await callLlm(base);
  recordTokens(res.usage?.total_tokens);
  if (res.usage) console.log(`  llm round [${provider}/${model}]: ${res.usage.prompt_tokens} in / ${res.usage.completion_tokens} out`);
  used?.add(`${provider}/${model}`);
  return res;
}

/** Keep the last turns only, and clip long ones (a pasted announcement list shouldn't ride along on every round). */
export function trimHistory(history: Turn[], maxTurns = 12, maxChars = 700): Turn[] {
  return history.slice(-maxTurns).map((t) => (t.content.length > maxChars ? { ...t, content: t.content.slice(0, maxChars) + "…" } : t));
}

export function plain(s: string): string {
  return s.replace(/\*\*(.+?)\*\*/g, "$1").replace(/^#{1,6}\s+/gm, "").replace(/^\s*[*•]\s+/gm, "- ").replace(/`/g, "");
}

const isToolValidationError = (e: any) => e?.status === 400 && /tool call validation|tool_use_failed/i.test(String(e?.message ?? ""));

/** Groq's error when the model calls a tool that wasn't in this request's tool list. */
const isToolNotLoaded = (e: any) => e?.status === 400 && /not in request\.tools|which was not in|not in the (provided )?tools/i.test(String(e?.message ?? ""));
/** The model, without the calendar tools, saying it can't do something calendar-ish. */
const SAYS_NO_CALENDAR = /\b(can'?t|cannot|can not|don'?t have|do not have|unable to|not able to|no way to)\b[^.!?\n]{0,70}\b(calendar|reminder|schedule|event|appointment)/i;

export async function runAgent(history: Turn[], convKey = "default"): Promise<string> {
  let validationRetried = false;
  const used = new Set<string>(); // which provider/model answered (logged once per message, never the message itself)
  const isOwner = requireContext().role === "owner";
  let calendar = !isOwner || needsCalendarTools(convKey, history); // members never have them; for them the flag is moot
  let widened = false;
  const classes = looksClassRelated(history.at(-1)?.content ?? "");
  let gpa = looksGpaRelated(history.at(-1)?.content ?? ""); // the gpa tool only rides along for GPA questions
  const messages: OpenAI.Chat.ChatCompletionMessageParam[] = [{ role: "system", content: buildSystemPrompt(convKey, { calendar, classes, gpa }) }, ...trimHistory(history)];
  /** Safety net: load the calendar tools and their rules, once. */
  const widen = (why: string) => {
    if (!isOwner || calendar || widened) return false;
    widened = calendar = true;
    console.log(`  calendar tools were not loaded but are needed (${why}); retrying with the full toolset`);
    messages[0] = { role: "system", content: buildSystemPrompt(convKey, { calendar: true, classes, gpa }) };
    return true;
  };
  try {
    for (let round = 0; round < MAX_ROUNDS; round++) {
      if (isOverBudget()) return LIMIT_MSG;
      let res;
      try {
        res = await complete(messages, calendar, gpa, used);
      } catch (e: any) {
        if (isToolNotLoaded(e) && !gpa && /gpa_calc/.test(String(e?.message ?? ""))) {
          gpa = true;
          messages[0] = { role: "system", content: buildSystemPrompt(convKey, { calendar, classes, gpa }) };
          continue;
        }
        if (isToolNotLoaded(e) && widen("the model called a tool that wasn't loaded")) continue;
        // Groq rejected the model's tool arguments (e.g. null for an optional field): tell it once and retry
        if (!validationRetried && isToolValidationError(e)) {
          validationRetried = true;
          console.warn("tool call validation failed; retrying once");
          messages.push({ role: "system", content: "Your last tool call had invalid parameter types. Call it again and OMIT optional parameters you don't need instead of sending null or empty strings." });
          continue;
        }
        throw e;
      }
      const msg = res.choices[0]?.message;
      if (!msg) return "Sorry, I got an empty response.";
      if (!msg.tool_calls?.length && SAYS_NO_CALENDAR.test(msg.content ?? "") && widen("the model said it can't")) continue; // retry without keeping that answer
      messages.push(msg);
      if (!msg.tool_calls?.length) return plain(msg.content?.trim() || "Sorry, I got an empty response.");
      for (const tc of msg.tool_calls) {
        if (tc.type !== "function") continue;
        let args: any = {};
        let out: string;
        try {
          args = JSON.parse(tc.function.arguments || "{}");
          out = await executeTool(tc.function.name, args, convKey);
        } catch (e) {
          out = `Error: bad tool arguments (${e instanceof Error ? e.message : e})`;
        }
        console.log(`  tool ${tc.function.name}(${JSON.stringify(args)}) -> ${out.length} chars`);
        messages.push({ role: "tool", tool_call_id: tc.id, content: out });
      }
    }
    return "Sorry, that took too many steps. Try a simpler question.";
  } catch (e: any) {
    if (e instanceof RateLimited) {
      console.warn(`no LLM provider could answer ${maskId(convKey)} (${e.kind})`);
      return rateLimitedMessage(e);
    }
    throw e;
  } finally {
    if (used.size) console.log(`answered by ${[...used].join(" + ")} for ${maskId(convKey)}`);
  }
}

/** One short LLM call: one-line summary of an announcement. Falls back to the title on any failure. */
export async function summarizeAnnouncement(title: string, body: string): Promise<string> {
  if (isOverBudget()) return title;
  try {
    const base = {
      messages: [
        { role: "system", content: "Summarize this Canvas announcement in ONE plain-text line under 120 characters. No markdown, no quotes, no preamble." },
        { role: "user", content: `${title}\n\n${body.slice(0, 1500)}` },
      ],
      max_completion_tokens: 500,
    };
    const { res } = await callLlm(base);
    recordTokens(res.usage?.total_tokens);
    const line = res.choices?.[0]?.message?.content?.trim().replace(/\s+/g, " ");
    return line ? plain(line).slice(0, 160) : title;
  } catch {
    return title;
  }
}

/** Fallback for a messy pasted schedule (e.g. from ConnectCarolina): one cheap call, JSON out, validated by code. */
export async function llmParseClasses(text: string): Promise<ClassSpec[] | null> {
  if (isOverBudget()) return null;
  try {
    const base = {
      messages: [
        { role: "system", content: 'Extract the class meetings from this text. Reply with ONLY JSON: {"classes":[{"course":"DATA 101","days":"MWF","start":"9:05 AM","end":"9:55 AM","location":"Building 120","units":3}]}. Omit units if not shown. days use M T W Th F. Skip anything that is not a class meeting.' },
        { role: "user", content: text.slice(0, 4000) },
      ],
      max_completion_tokens: 1200,
    };
    const { res } = await callLlm(base);
    recordTokens(res.usage?.total_tokens);
    const raw = res.choices?.[0]?.message?.content ?? "";
    const json = raw.match(/\{[\s\S]*\}/)?.[0];
    return json ? normalizeLlmClasses(JSON.parse(json)) : null;
  } catch {
    return null;
  }
}
