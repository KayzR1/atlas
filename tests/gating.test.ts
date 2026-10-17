import { afterEach, beforeEach, expect, test } from "bun:test";
import { buildSystemPrompt, resetModelCooldowns, runAgent, setLlmForTests, toolsForRole, type LlmLike } from "../src/agent.ts";
import { handleConfirmation, looksCalendarRelated, needsCalendarTools, runCalendarTool, setNowForTests, setStoreForTests, type CalendarStore } from "../src/calendar.ts";
import { runWithContext, type UserContext } from "../src/context.ts";
import { initDb, saveLastEvent } from "../src/db.ts";

const KEY = "+19195550100";
const owner: UserContext = { key: KEY, role: "owner", timezone: "America/New_York", canvasUrl: "https://x", canvasToken: "t" };
const member: UserContext = { ...owner, role: "member", key: "+19195550101" };
const user = (content: string) => ({ role: "user", content });
const CAL_TOOLS = ["list_calendar_events", "create_calendar_event", "find_calendar_events", "update_calendar_event", "delete_calendar_event", "create_reminder", "plan_week"];

beforeEach(() => {
  initDb(":memory:");
  resetModelCooldowns();
});
afterEach(() => {
  setLlmForTests();
  setStoreForTests();
  setNowForTests();
});

// ---------- the detector ----------

test("calendar-ish messages are recognised (it errs toward yes)", () => {
  for (const q of [
    "remind me to submit hw Wednesday 8pm", "add piano tomorrow 4-6pm", "move it to 5", "cancel that", "delete that event", "what's on my calendar today",
    "can you plan my week", "schedule a study session", "same again", "put lunch with sam at noon", "make it 2 hours", "edit that to 6pm", "my reminders",
    "what's my day look like", "block out friday afternoon", "reschedule the meeting", "tonight at 7pm", "push it back an hour", "set an alarm for 6am",
    "can you add a recurring event", "rename that to review", "free time on thursday?", "book the lab at 3", "book a room for friday",
  ]) expect(looksCalendarRelated(q), q).toBe(true);
});

test("Canvas, grade and syllabus questions are not calendar-ish", () => {
  for (const q of [
    "what's my grade in DATA 101", "what do I need on the final to get an A", "late policy in ECON 210", "any announcements", "hey", "thanks!",
    "what does the syllabus say about office hours", "how am I doing in ENGL 150", "which assignments are missing", "explain the midterm format", "what's due friday",
    "is the quiz open book", "who is my professor", "what book do we use",
  ]) expect(looksCalendarRelated(q), q).toBe(false);
});

test("context: follow-ups, 'it/that' with a last event, and staged changes keep the calendar tools on", async () => {
  expect(needsCalendarTools(KEY, [user("what's my grade in DATA 101")])).toBe(false);
  // a short follow-up to a calendar request
  expect(needsCalendarTools(KEY, [user("add piano tomorrow at 4"), { role: "assistant", content: "Add 'Piano' Sat 4-5pm?" }, user("what about friday instead")])).toBe(true);
  // ...but a long unrelated message after one is not
  expect(needsCalendarTools(KEY, [user("add piano tomorrow at 4"), { role: "assistant", content: "ok" }, user("can you tell me what the department says about prerequisites for the next course in the sequence")])).toBe(false);
  // "make it bigger" has no calendar word, but there is a last event to mean
  expect(needsCalendarTools(KEY, [user("not that one")])).toBe(false);
  saveLastEvent(KEY, { title: "Piano", start: 0, end: 1 });
  expect(needsCalendarTools(KEY, [user("not that one")])).toBe(true);
  expect(needsCalendarTools(KEY, [user("what's my grade in DATA 101")])).toBe(false); // a last event alone doesn't switch it on
  // a staged change is waiting for an answer
  initDb(":memory:");
  const store: CalendarStore = { search: async () => [], get: async () => null, put: async () => {}, remove: async () => {}, create: async () => ({ url: "u", calendarUrl: "c" }) };
  setStoreForTests(store);
  setNowForTests(() => new Date("2026-10-16T14:00:00Z"));
  await runCalendarTool("create_reminder", { text: "x", when: "2026-10-21T20:00" }, KEY);
  expect(needsCalendarTools(KEY, [user("mm")])).toBe(true);
  await handleConfirmation(KEY, "no"); // clear the staged change (it is module state, shared by later tests)
  expect(needsCalendarTools(KEY, [user("mm")])).toBe(false);
});

// ---------- what the model actually receives ----------

type Req = { messages: any[]; tools: any[] };
function fakeLlm(script: Array<(req: Req) => any>) {
  const calls: Req[] = [];
  const llm: LlmLike = { chat: { completions: { create: async (p: any) => (calls.push(JSON.parse(JSON.stringify(p))), script[Math.min(calls.length - 1, script.length - 1)]!(p)) } } };
  return { llm, calls };
}
const answer = (text: string) => () => ({ choices: [{ message: { role: "assistant", content: text } }], usage: { total_tokens: 100 } });
const names = (r: Req) => r.tools.map((t: any) => t.function.name);
const run = (text: string, ctx = owner) => runWithContext(ctx, () => runAgent([{ role: "user", content: text }], ctx.key));

test("a Canvas question carries no calendar tools and no calendar rules, only a one-line hint", async () => {
  const f = fakeLlm([answer("You're at 95%.")]);
  setLlmForTests(f.llm);
  await run("what's my grade in DATA 101");
  const req = f.calls[0]!;
  for (const t of CAL_TOOLS) expect(names(req)).not.toContain(t);
  expect(names(req)).toEqual(expect.arrayContaining(["list_courses", "get_due_overview", "grade_calc", "ask_syllabus"]));
  const sys = req.messages[0].content;
  expect(sys).not.toContain("Calendar changes are only STAGED");
  expect(sys).not.toContain("Last calendar event");
  expect(sys).toContain("aren't loaded for this message; if the user needs one, call it by name"); // so the model can still ask
  expect(sys).toContain("grade_calc once"); // the Canvas rules are all still there
});

test("a calendar question carries the full toolset and the full rules", async () => {
  const f = fakeLlm([answer("ok")]);
  setLlmForTests(f.llm);
  await run("remind me to submit hw wednesday at 8pm");
  const req = f.calls[0]!;
  for (const t of CAL_TOOLS) expect(names(req)).toContain(t);
  expect(req.messages[0].content).toContain("Calendar changes are only STAGED");
  expect(req.messages[0].content).not.toContain("aren't loaded");
});

test("members never get calendar tools either way, and their prompt is unchanged", async () => {
  const f = fakeLlm([answer("ok")]);
  setLlmForTests(f.llm);
  await run("remind me to submit hw wednesday at 8pm", member);
  for (const t of CAL_TOOLS) expect(names(f.calls[0]!)).not.toContain(t);
  expect(f.calls[0]!.messages[0].content).toContain("You have no calendar access");
});

// ---------- safety net 1: the model asks for a tool that wasn't loaded ----------

test("if the model calls a tool that wasn't loaded, the same turn is retried once with the full toolset and rules", async () => {
  const notLoaded = () => {
    throw Object.assign(new Error("400 Tool call validation failed: attempted to call tool 'create_reminder' which was not in request.tools"), { status: 400 });
  };
  const f = fakeLlm([notLoaded, answer("Remind you to submit hw Wed 8pm?")]);
  setLlmForTests(f.llm);
  // phrased so the detector misses it, to exercise the net
  const reply = await run("ping me before the lab report is due");
  expect(reply).toBe("Remind you to submit hw Wed 8pm?");
  expect(f.calls.length).toBe(2);
  expect(names(f.calls[0]!)).not.toContain("create_reminder");
  expect(names(f.calls[1]!)).toContain("create_reminder");
  expect(f.calls[1]!.messages[0].content).toContain("Calendar changes are only STAGED");
  expect(f.calls[1]!.messages.length).toBe(f.calls[0]!.messages.length); // same conversation, only the system prompt and tools changed
});

test("that retry happens at most once: a second failure surfaces, it does not loop", async () => {
  const notLoaded = () => {
    throw Object.assign(new Error("400 attempted to call tool 'x' which was not in request.tools"), { status: 400 });
  };
  const f = fakeLlm([notLoaded, notLoaded, notLoaded]);
  setLlmForTests(f.llm);
  await expect(run("ping me before the lab report is due")).rejects.toThrow(/not in request\.tools/);
  expect(f.calls.length).toBeLessThanOrEqual(3);
});

// ---------- safety net 2: the model says it can't ----------

test("if the model says it can't do calendar things while the tools were left out, it is retried once with them", async () => {
  const f = fakeLlm([answer("Sorry, I can't access your calendar."), answer("Remind you to call the lab Thu 9am?")]);
  setLlmForTests(f.llm);
  const reply = await run("ping me before the lab report is due");
  expect(reply).toBe("Remind you to call the lab Thu 9am?");
  expect(f.calls.length).toBe(2);
  expect(names(f.calls[1]!)).toContain("create_reminder");
  // the refusal was not kept in the conversation
  expect(JSON.stringify(f.calls[1]!.messages)).not.toContain("can't access your calendar");
});

test("a non-calendar answer that merely mentions the word is left alone, and the retry is never repeated", async () => {
  const a = fakeLlm([answer("Your syllabus mentions a calendar of readings, week by week.")]);
  setLlmForTests(a.llm);
  expect(await run("what's my grade in DATA 101")).toBe("Your syllabus mentions a calendar of readings, week by week.");
  expect(a.calls.length).toBe(1);

  const b = fakeLlm([answer("I can't see your calendar."), answer("I still can't see your calendar.")]);
  setLlmForTests(b.llm);
  expect(await run("ping me before the lab report is due")).toBe("I still can't see your calendar."); // already widened: accepted as the answer
  expect(b.calls.length).toBe(2);
});

test("members are never widened (they have no calendar to load)", async () => {
  const f = fakeLlm([answer("Sorry, I can't access your calendar.")]);
  setLlmForTests(f.llm);
  expect(await run("remind me to submit hw wednesday at 8pm", member)).toBe("Sorry, I can't access your calendar.");
  expect(f.calls.length).toBe(1);
});

// ---------- the point: smaller requests ----------

test("per-round overhead: the gated request is about half the size of the full one", () => {
  const size = (opts: { calendar?: boolean }) => runWithContext(owner, () => buildSystemPrompt(KEY, opts).length + JSON.stringify(toolsForRole("owner", opts)).length);
  const full = size({}), gated = size({ calendar: false });
  expect(gated).toBeLessThan(full * 0.62);
  expect(gated).toBeLessThan(3_600);
  expect(full).toBeLessThan(6_500);
  expect(toolsForRole("owner", { calendar: false }).map((t) => t.function.name)).toEqual(toolsForRole("member").map((t) => t.function.name)); // same Canvas toolset as a member
});
