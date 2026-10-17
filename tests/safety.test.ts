import { beforeEach, expect, test } from "bun:test";
import { releaseLease, tryAcquireLease, appendHistory, clearHistory, ensureUser, getUser, initDb, loadHistory, markNotified, markSeenMessage, normalizeId, recordSend, sentSince, wasNotified } from "../src/db.ts";
import { handleInbound, type HandlerDeps } from "../src/handler.ts";
import { makeOutbound } from "../src/outbound.ts";

const ME = "+19195550100";
let sent: string[];
let agentCalls: number;

function setup(allowedIds = [ME]) {
  initDb(":memory:");
  sent = [];
  agentCalls = 0;
  const space = { id: "chat1", responding: <T>(fn: () => T | Promise<T>) => Promise.resolve(fn()), send: async (t: string) => void sent.push(t) };
  // outbound with no app: replies go through the real limiter to space.send
  const out = makeOutbound({ provider: "cloud" });
  const deps: HandlerDeps = {
    provider: "cloud",
    multiUser: false,
    access: (id) => (!!id && allowedIds.includes(normalizeId(id)) ? "owner" : "stranger"),
    send: out.send,
    rememberSpace: out.rememberSpace,
    agent: async () => (agentCalls++, "agent answer"),
    confirm: async () => null,
    contextFor: async (key) => ({ key, role: "owner", timezone: "America/New_York", canvasUrl: "https://x.example", canvasToken: "t" }),
    startedAt: Date.now() - 125 * 60_000,
    nextCheckAt: () => Date.now() + 17 * 60_000,
  };
  let n = 0;
  const msg = (text: string | null, over: any = {}) => ({
    id: `m${++n}`,
    direction: "inbound",
    sender: { id: ME },
    content: text === null ? { type: "reaction" } : { type: "text", text },
    ...over,
  });
  return { space, deps, msg };
}

beforeEach(() => void 0);

test("non-text events are ignored silently", async () => {
  const { space, deps, msg } = setup();
  await handleInbound(space, msg(null), deps);
  expect(sent).toEqual([]);
  expect(agentCalls).toBe(0);
});

test("own messages and duplicates are ignored", async () => {
  const { space, deps, msg } = setup();
  await handleInbound(space, msg("hi", { direction: "outbound" }), deps);
  await handleInbound(space, msg("hi", { sender: { id: ME, kind: "agent" } }), deps);
  expect(agentCalls).toBe(0);
  const m = msg("hello");
  await handleInbound(space, m, deps);
  await handleInbound(space, m, deps);
  expect(agentCalls).toBe(1);
  expect(sent).toEqual(["agent answer"]);
});

test("unauthorized senders are ignored", async () => {
  const { space, deps, msg } = setup();
  await handleInbound(space, msg("hi", { sender: { id: "+15559998888" } }), deps);
  expect(sent).toEqual([]);
  expect(agentCalls).toBe(0);
});

test("/pause ignores everything but /resume", async () => {
  const { space, deps, msg } = setup();
  await handleInbound(space, msg("/pause"), deps);
  expect(getUser(ME)!.paused).toBe(1);
  sent.length = 0;
  await handleInbound(space, msg("what's due"), deps);
  await handleInbound(space, msg("/status"), deps);
  await handleInbound(space, msg("/quiet"), deps);
  expect(sent).toEqual([]);
  expect(agentCalls).toBe(0);
  await handleInbound(space, msg("/resume"), deps);
  expect(sent).toEqual(["Resumed."]);
  expect(getUser(ME)!.paused).toBe(0);
});

test("/quiet toggles, /status reports", async () => {
  const { space, deps, msg } = setup();
  await handleInbound(space, msg("/quiet"), deps);
  expect(getUser(ME)!.notify).toBe(0);
  await handleInbound(space, msg("/status"), deps);
  expect(sent[1]).toMatch(/up 2h 5m, 1 messages sent in the last hour, next check in 17m, notifications off/);
  await handleInbound(space, msg("/QUIET"), deps);
  expect(getUser(ME)!.notify).toBe(1);
});

test("circuit breaker: notifications are capped at 5/min, but replies in a fast conversation are not dropped", async () => {
  const { space, deps, msg } = setup();
  ensureUser(ME);
  for (let i = 0; i < 5; i++) recordSend(ME, "notify");
  // a 6th proactive notification is refused...
  const out = makeOutbound({ provider: "cloud" });
  expect(await out.send(ME, "notification", "notify", space)).toBe(false);
  expect(sent).toEqual([]);
  // ...but replies still go out (this is the "Same exact got no reply" bug: replies used to share the 5/min cap)
  for (let i = 0; i < 12; i++) await handleInbound(space, msg("/status"), deps);
  expect(sent.length).toBe(12);
  // and there is still a ceiling against a runaway loop
  for (let i = 0; i < 20; i++) await handleInbound(space, msg("/status"), deps);
  expect(sent.length).toBe(20);
  expect(sentSince(ME, 60_000, "reply")).toBe(20);
});

test("history persists in SQLite and /reset clears it", async () => {
  const { space, deps, msg } = setup();
  await handleInbound(space, msg("first"), deps);
  expect(loadHistory(ME)).toEqual([{ role: "user", content: "first" }, { role: "assistant", content: "agent answer" }]);
  await handleInbound(space, msg("/reset"), deps);
  expect(loadHistory(ME)).toEqual([]);
});

test("db: history cap, notified is idempotent, ids normalize", () => {
  initDb(":memory:");
  ensureUser(ME);
  for (let i = 0; i < 30; i++) appendHistory(ME, "user", `m${i}`);
  expect(loadHistory(ME, 20).length).toBe(20);
  expect(loadHistory(ME, 20).at(-1)!.content).toBe("m29");
  expect(wasNotified(ME, "k")).toBe(false);
  markNotified(ME, "k");
  markNotified(ME, "k");
  expect(wasNotified(ME, "k")).toBe(true);
  expect(normalizeId("(919) 555-0100")).toBe("+9195550100");
  expect(normalizeId("A@Example.com")).toBe("a@example.com");
  expect(markSeenMessage("x")).toBe(true);
  expect(markSeenMessage("x")).toBe(false);
  clearHistory(ME);
  expect(loadHistory(ME)).toEqual([]);
});

test("single-instance lease: second owner is blocked until the first releases or goes stale", () => {
  initDb(":memory:");
  expect(tryAcquireLease("a")).toBe(true);
  expect(tryAcquireLease("a")).toBe(true); // renew
  expect(tryAcquireLease("b")).toBe(false);
  releaseLease("b"); // not the owner: no effect
  expect(tryAcquireLease("b")).toBe(false);
  releaseLease("a");
  expect(tryAcquireLease("b")).toBe(true);
  expect(tryAcquireLease("a", -1)).toBe(true); // ttl elapsed: stale leases can be taken over
});
