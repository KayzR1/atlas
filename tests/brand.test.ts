import { afterEach, beforeEach, expect, test } from "bun:test";
import { buildSystemPrompt } from "../src/agent.ts";
import { botName } from "../src/brand.ts";
import { runWithContext, type UserContext } from "../src/context.ts";
import { createConnectLink, createPendingUser, ensureOwner, getUser, initDb } from "../src/db.ts";
import { runBrief, type Deps } from "../src/notify.ts";
import { makeWebHandler } from "../src/web.ts";
import { ALICE, harness, OWNER } from "./helpers.ts";

const realName = process.env.BOT_NAME;
beforeEach(() => void delete process.env.BOT_NAME);
afterEach(() => (realName === undefined ? delete process.env.BOT_NAME : (process.env.BOT_NAME = realName)));

const owner: UserContext = { key: OWNER, role: "owner", timezone: "America/New_York", canvasUrl: "https://x", canvasToken: "t" };

test("the name defaults to Pallas, is configurable, and ignores blank values", () => {
  expect(botName()).toBe("Pallas");
  process.env.BOT_NAME = "  Nova ";
  expect(botName()).toBe("Nova");
  process.env.BOT_NAME = "   ";
  expect(botName()).toBe("Pallas");
});

test("the system prompt introduces the assistant by name, with the personality, and stays compact", () => {
  const prompt = runWithContext(owner, () => buildSystemPrompt(OWNER));
  expect(prompt).toContain("You are Pallas, a friendly, calm assistant keeping the user's semester");
  expect(prompt).toContain("semester");
  expect(prompt).toContain("Be brief");
  expect(prompt).toContain("plain text, no markdown"); // still a text-message style
  process.env.BOT_NAME = "Nova";
  expect(runWithContext(owner, () => buildSystemPrompt(OWNER))).toContain("You are Nova,");
  expect(runWithContext(owner, () => buildSystemPrompt(OWNER))).not.toContain("Pallas");
});

test("the morning brief greets as the assistant", async () => {
  initDb(":memory:");
  ensureOwner(OWNER);
  const deps: Deps = {
    now: () => new Date("2026-10-16T12:00:00Z"), courses: async () => [], assignments: async () => [], announcements: async () => [], missing: async () => [],
    events: async () => null, summarize: async (t: string) => t,
  } as any;
  const sent: string[] = [];
  await runBrief(OWNER, deps, async (_k, t) => (sent.push(t), true));
  expect(sent[0]).toMatch(/^Good morning! Pallas here\. Friday, Oct 16\n/);
  process.env.BOT_NAME = "Nova";
  await runBrief(OWNER, deps, async (_k, t) => (sent.push(t), true), { force: true });
  expect(sent[1]).toMatch(/^Good morning! Nova here\./);
});

test("invite text, join welcome and the pending-user prompts all use the name", async () => {
  const h = await harness();
  await h.say("/invite", OWNER);
  expect(h.lastTo(OWNER)).toContain("Join Pallas: https://bot.example.com/join/");
  expect(h.lastTo(OWNER)).toContain("You'll get your Pallas number. Text it 'hi' to start.");
  const code = h.lastTo(OWNER)!.match(/\/join\/([A-Z0-9]{6})/)![1]!;
  await h.say(`join ${code}`, ALICE);
  expect(h.lastTo(ALICE)).toMatch(/^Welcome to Pallas! To connect your Canvas/);
  await h.say("hello?", ALICE);
  expect(h.lastTo(ALICE)).toContain("Connect your Canvas to Pallas with this private link");
});

test("welcome text and the connect page use the name, and the page escapes it", async () => {
  initDb(":memory:");
  ensureOwner(OWNER);
  createPendingUser(ALICE);
  const token = createConnectLink(ALICE);
  const texts: string[] = [];
  const handle = makeWebHandler({ send: async (_t, text) => (texts.push(text), true), validate: async () => true });
  const page = await (await handle(new Request(`https://bot.example.com/connect/${token}`))).text();
  expect(page).toContain("<title>Connect your Canvas</title>");
  expect(page).toContain("<h1>Connect your Canvas</h1>");
  expect(page).toContain("To let Pallas read your Canvas");

  process.env.BOT_NAME = `<img src=x onerror=alert(1)>`;
  const evil = await (await handle(new Request(`https://bot.example.com/connect/${token}`))).text();
  expect(evil).not.toContain("<img src=x");
  expect(evil).toContain("&lt;img src=x onerror=alert(1)&gt;");

  process.env.BOT_NAME = "Pallas";
  const res = await handle(new Request(`https://bot.example.com/connect/${token}`, { method: "POST", body: new URLSearchParams({ canvas_url: "uncch.instructure.com", canvas_token: "tok" }) }));
  expect(res.status).toBe(200);
  expect(await res.text()).toContain("You're connected to Pallas");
  expect(texts[0]).toMatch(/^You're connected! I'm Pallas\./);
  expect(getUser(ALICE)!.status).toBe("active");
});
