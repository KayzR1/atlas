import { Database } from "bun:sqlite";
import { afterEach, expect, test } from "bun:test";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { executeTool, toolsForRole } from "../src/agent.ts";
import { isOverBudget, LIMIT_MSG, recordTokens } from "../src/budget.ts";
import { listEvents } from "../src/calendar.ts";
import { fetchAssignmentsRaw, listCourses } from "../src/canvas.ts";
import { runWithContext, type UserContext } from "../src/context.ts";
import { decrypt, encrypt, INVITE_ALPHABET, parseEncryptionKey, sha256Hex } from "../src/crypto.ts";
import {
  addTokens, appendHistory, loadLastEvent, saveLastEvent, consumeConnectLink, createConnectLink, createInvite, db, ensureOwner, ensureUser, getUser, initDb, listActiveUsers, loadHistory,
  markNotified, peekConnectLink, redeemInvite, tokensToday, wasNotified,
} from "../src/db.ts";
import { resetBadCodes } from "../src/handler.ts";
import { realDeps, startScheduler, type Deps } from "../src/notify.ts";
import { allowedCanvasHosts, normalizeCanvasUrl } from "../src/users.ts";
import { makeWebHandler } from "../src/web.ts";
import { addMember, ALICE, BOB, harness, OWNER } from "./helpers.ts";

afterEach(() => {
  resetBadCodes();
  delete process.env.LLM_DAILY_TOKENS_PER_USER;
});

const ctx = (key: string, role: "owner" | "member" = "member"): UserContext => ({
  key, role, timezone: "America/New_York", canvasUrl: "https://uncch.instructure.com", canvasToken: `token-of-${key}`,
});
const code = (text: string) => text.match(/\/join\/([A-Z0-9]{6})/)![1]!;

// ---------- 1. data ----------

test("migration: an old-schema database upgrades in place and keeps its data", () => {
  const path = join(tmpdir(), `canvas-bot-mig-${Date.now()}.db`);
  const old = new Database(path, { create: true });
  old.exec(`
    CREATE TABLE users (phone TEXT PRIMARY KEY, timezone TEXT NOT NULL, notify INTEGER NOT NULL DEFAULT 1, paused INTEGER NOT NULL DEFAULT 0,
      seeded INTEGER NOT NULL DEFAULT 0, brief_time TEXT NOT NULL DEFAULT '08:00', space_id TEXT, created_at INTEGER NOT NULL);
    CREATE TABLE history (id INTEGER PRIMARY KEY AUTOINCREMENT, phone TEXT NOT NULL, role TEXT NOT NULL, content TEXT NOT NULL, ts INTEGER NOT NULL);
    CREATE TABLE notified (phone TEXT NOT NULL, key TEXT NOT NULL, ts INTEGER NOT NULL, PRIMARY KEY (phone, key));
    INSERT INTO users (phone, timezone, seeded, space_id, created_at) VALUES ('${OWNER}', 'America/New_York', 1, 'chat-1', 1);
    INSERT INTO history (phone, role, content, ts) VALUES ('${OWNER}', 'user', 'hello', 1);
    INSERT INTO notified (phone, key, ts) VALUES ('${OWNER}', 'grade:1:5', 1);
  `);
  old.close();

  initDb(path);
  const u = getUser(OWNER)!;
  expect(u.status).toBe("active");
  expect(u.role).toBe("owner");
  expect(u.canvas_url).toBeNull();
  expect(u.canvas_token_enc).toBeNull();
  expect([u.seeded, u.space_id]).toEqual([1, "chat-1"]);
  expect(loadHistory(OWNER)).toEqual([{ role: "user", content: "hello" }]);
  expect(wasNotified(OWNER, "grade:1:5")).toBe(true);
  const tables = db.query<{ name: string }, []>("SELECT name FROM sqlite_master WHERE type='table'").all().map((t) => t.name);
  for (const t of ["invites", "connect_links", "llm_usage"]) expect(tables).toContain(t);
  expect(listActiveUsers().map((x) => x.phone)).toEqual([OWNER]);

  initDb(path); // running it again is harmless
  expect(getUser(OWNER)!.role).toBe("owner");
  db.close();
});

test("invite codes: 6 unambiguous chars, single use, 7-day expiry, atomic", () => {
  initDb(":memory:");
  const { code: c, expiresAt } = createInvite(OWNER);
  expect(c).toMatch(/^[A-Z2-9]{6}$/);
  for (const ch of c) expect(INVITE_ALPHABET).toContain(ch);
  expect(INVITE_ALPHABET).not.toMatch(/[01OI]/);
  expect(expiresAt - Date.now()).toBeGreaterThan(6.9 * 86400_000);

  expect(redeemInvite(c.toLowerCase().replace(/(...)(...)/, "$1 $2"), ALICE)).toBe(true); // tolerant of case/spaces
  expect(redeemInvite(c, BOB)).toBe(false); // reused
  expect(db.query("SELECT used_by FROM invites WHERE code = ?").get(c)).toEqual({ used_by: ALICE });

  const expired = createInvite(OWNER, Date.now() - 8 * 86400_000);
  expect(redeemInvite(expired.code, ALICE)).toBe(false);
  expect(redeemInvite("ZZZZZZ", ALICE)).toBe(false);

  const race = createInvite(OWNER);
  const wins = [ALICE, BOB, "+19195550103"].map((p) => redeemInvite(race.code, p)).filter(Boolean);
  expect(wins.length).toBe(1);
});

test("connect links: only a hash is stored, single use, 30-minute expiry", () => {
  initDb(":memory:");
  ensureUser(ALICE);
  const t = createConnectLink(ALICE);
  expect(t).toMatch(/^[A-Za-z0-9_-]{43}$/);
  const row = db.query<{ token_hash: string }, []>("SELECT token_hash FROM connect_links").get()!;
  expect(row.token_hash).toBe(sha256Hex(t));
  expect(JSON.stringify(db.query("SELECT * FROM connect_links").all())).not.toContain(t);

  expect(peekConnectLink(t)).toBe(ALICE);
  expect(peekConnectLink(t)).toBe(ALICE); // peeking never uses it up
  expect(consumeConnectLink(t)).toBe(ALICE);
  expect(consumeConnectLink(t)).toBeNull();
  expect(peekConnectLink(t)).toBeNull();

  const stale = createConnectLink(ALICE, Date.now() - 31 * 60_000);
  expect(peekConnectLink(stale)).toBeNull();
  expect(consumeConnectLink(stale)).toBeNull();

  const a = createConnectLink(ALICE);
  const b = createConnectLink(ALICE); // a fresh link replaces older unused ones
  expect(peekConnectLink(a)).toBeNull();
  expect(peekConnectLink(b)).toBe(ALICE);
});

// ---------- 2. secrets ----------

test("encryption: AES-256-GCM round trip, random IV, tamper and wrong key fail", async () => {
  const blob = await encrypt("1234~secret-canvas-token");
  expect(blob.startsWith("v1:")).toBe(true);
  expect(blob).not.toContain("secret-canvas-token");
  expect(await decrypt(blob)).toBe("1234~secret-canvas-token");
  expect(await encrypt("1234~secret-canvas-token")).not.toBe(blob); // fresh IV each time

  const raw = Buffer.from(blob.slice(3), "base64");
  raw[raw.length - 1]! ^= 1;
  await expect(decrypt("v1:" + raw.toString("base64"))).rejects.toThrow();
  await expect(decrypt("garbage")).rejects.toThrow();

  const original = process.env.ENCRYPTION_KEY;
  process.env.ENCRYPTION_KEY = Buffer.alloc(32, 9).toString("base64");
  await expect(decrypt(blob)).rejects.toThrow();
  process.env.ENCRYPTION_KEY = Buffer.alloc(16, 1).toString("base64");
  expect(() => parseEncryptionKey()).toThrow(/32 bytes/);
  process.env.ENCRYPTION_KEY = original;
  expect(parseEncryptionKey().length).toBe(32);
});

// ---------- 3. per-user context ----------

test("Canvas calls use the token from the current user's context, and fail without one", async () => {
  const calls: { url: string; auth: string }[] = [];
  const realFetch = globalThis.fetch;
  globalThis.fetch = (async (url: any, init: any) => {
    calls.push({ url: String(url), auth: init?.headers?.Authorization });
    return new Response("[]", { status: 200 });
  }) as any;
  try {
    await runWithContext(ctx("a"), () => listCourses());
    await runWithContext({ ...ctx("b"), canvasUrl: "https://other.instructure.com" }, () => fetchAssignmentsRaw(7));
    await Promise.all([runWithContext(ctx("c"), () => listCourses()), runWithContext(ctx("d"), () => listCourses())]); // concurrent users don't mix
    await expect(listCourses()).rejects.toThrow(/no user context/);
  } finally {
    globalThis.fetch = realFetch;
  }
  expect(calls[0]).toMatchObject({ auth: "Bearer token-of-a" });
  expect(calls[0]!.url.startsWith("https://uncch.instructure.com/api/v1/courses")).toBe(true);
  expect(calls[1]).toMatchObject({ auth: "Bearer token-of-b" });
  expect(calls[1]!.url.startsWith("https://other.instructure.com/")).toBe(true);
  expect(calls.slice(2).map((c) => c.auth).sort()).toEqual(["Bearer token-of-c", "Bearer token-of-d"]);
});

test("members can't use the calendar: tools hidden, calls refused, even if the model asks", async () => {
  const names = (role: "owner" | "member") => toolsForRole(role).map((t) => t.function.name);
  const calendar = ["list_calendar_events", "create_calendar_event", "find_calendar_events", "update_calendar_event", "delete_calendar_event"];
  for (const t of calendar) {
    expect(names("owner")).toContain(t);
    expect(names("member")).not.toContain(t);
  }

  const member = ctx(ALICE);
  expect(await runWithContext(member, () => executeTool("list_calendar_events", { start: "2026-10-16", end: "2026-10-16" }, ALICE))).toMatch(/unknown tool/);
  expect(await runWithContext(member, () => executeTool("create_calendar_event", { title: "x", start: "2026-10-16T10:00", end: "2026-10-16T11:00" }, ALICE))).toMatch(/unknown tool/);
  for (const t of ["find_calendar_events", "update_calendar_event", "delete_calendar_event"]) {
    expect(await runWithContext(member, () => executeTool(t, { query: "piano", id: "last" }, ALICE))).toMatch(/unknown tool/);
  }
  // defense in depth: the calendar module itself refuses non-owners
  await expect(runWithContext(member, () => listEvents("2026-10-16", "2026-10-16"))).rejects.toThrow(/owner-only/);
  // and the morning brief has no calendar section for members
  process.env.ICLOUD_EMAIL = "x@example.com";
  process.env.ICLOUD_APP_PASSWORD = "x";
  expect(await runWithContext(member, () => realDeps.events("2026-10-16"))).toBeNull();
  delete process.env.ICLOUD_EMAIL;
  delete process.env.ICLOUD_APP_PASSWORD;
});

test("per-user daily token budget: members are capped at 50K, the owner at a higher 100K", async () => {
  process.env.LLM_DAILY_TOKENS_PER_USER = "100";
  const h = await harness({
    agent: async () => {
      recordTokens(80); // what runAgent does from Groq's usage field
      return "answer";
    },
  });
  await addMember(ALICE);
  await h.say("q1", ALICE);
  await h.say("q2", ALICE);
  expect(h.lastTo(ALICE)).toBe("answer");
  await h.say("q3", ALICE); // 160 tokens used >= 100
  expect(h.lastTo(ALICE)).toBe(LIMIT_MSG);
  expect(h.sent.filter((s) => s.to === ALICE).map((s) => s.text)).toEqual(["answer", "answer", LIMIT_MSG]);

  for (let i = 0; i < 3; i++) await h.say(`owner q${i}`, OWNER); // the owner isn't held to the member cap (100 here)
  expect(h.sent.filter((s) => s.to === OWNER).every((s) => s.text === "answer")).toBe(true);
  process.env.LLM_DAILY_TOKENS_OWNER = "150"; // ...but is capped too
  await h.say("owner q3", OWNER); // 240 tokens used so far
  expect(h.lastTo(OWNER)).toBe(LIMIT_MSG);
  delete process.env.LLM_DAILY_TOKENS_OWNER;

  // unit level: separate users and days
  initDb(":memory:");
  addTokens(ALICE, "2026-10-15", 99_999);
  expect(tokensToday(ALICE, "2026-10-15")).toBe(99_999);
  expect(tokensToday(ALICE, "2026-10-16")).toBe(0);
  const today = new Date().toLocaleDateString("en-CA", { timeZone: "America/New_York" });
  addTokens(ALICE, today, 99_999);
  expect(isOverBudget(ctx(ALICE, "owner"))).toBe(false); // 99,999 < the owner's 100,000
  expect(isOverBudget(ctx(ALICE, "member"))).toBe(true); // ...but far over a member's 50,000
});

// ---------- 4. message flow ----------

test("strangers are ignored silently; a bad join code gets one short reply, then silence", async () => {
  const h = await harness();
  await h.say("hello", BOB);
  await h.say(null, BOB);
  await h.say("what's due", BOB);
  expect(h.sent).toEqual([]);
  expect(getUser(BOB)).toBeNull();

  await h.say("join ABC234", BOB);
  expect(h.sent).toEqual([{ to: BOB, text: "invalid or expired code" }]);
  expect(getUser(BOB)).toBeNull();
  for (let i = 0; i < 8; i++) await h.say(`join ZZZ22${i}`, BOB);
  expect(h.sent.length).toBe(5); // after 5 wrong guesses in an hour: nothing at all
  expect(h.agentCalls()).toBe(0);
});

test("with multi-user off, strangers are ignored even with a valid code", async () => {
  const h = await harness({ multiUser: false });
  initDb(":memory:");
  ensureOwner(OWNER);
  const { code: c } = createInvite(OWNER);
  await h.say(`join ${c}`, BOB);
  expect(h.sent).toEqual([]);
});

test("join with a valid code creates a pending user and texts a connect link", async () => {
  const h = await harness();
  await h.say("/invite", OWNER);
  const c = code(h.lastTo(OWNER)!);
  expect(h.lastTo(OWNER)).toContain(`https://bot.example.com/join/${c}`);
  expect(h.lastTo(OWNER)).toContain("Text it 'hi' to start."); // the 'join CODE' text path still works, but isn't what we tell people to do
  expect(h.lastTo(OWNER)).not.toContain("+15555550199"); // no bot number: each user gets their own on the shared plan

  await h.say(`join ${c}`, ALICE);
  expect(getUser(ALICE)).toMatchObject({ status: "pending", role: "member", canvas_token_enc: null });
  const welcome = h.lastTo(ALICE)!;
  const link1 = welcome.match(/https:\/\/bot\.example\.com\/connect\/([A-Za-z0-9_-]{43})/)![1]!;
  expect(peekConnectLink(link1)).toBe(ALICE);

  await h.say(`join ${c}`, BOB); // code already used
  expect(h.lastTo(BOB)).toBe("invalid or expired code");
  expect(getUser(BOB)).toBeNull();

  // pending: any text (even a question) gets a fresh link, never an answer
  await h.say("what's due this week?", ALICE);
  const link2 = h.lastTo(ALICE)!.match(/connect\/([A-Za-z0-9_-]{43})/)![1]!;
  expect(link2).not.toBe(link1);
  expect(peekConnectLink(link1)).toBeNull();
  expect(peekConnectLink(link2)).toBe(ALICE);
  expect(h.agentCalls()).toBe(0);
});

test("owner commands: /invite, /users, /remove; members can't use them", async () => {
  const h = await harness();
  await addMember(ALICE);
  await h.say("/invite", ALICE);
  await h.say("/users", ALICE);
  await h.say(`/remove ${OWNER}`, ALICE);
  expect(h.sent.map((s) => s.text)).toEqual(["That command is owner-only.", "That command is owner-only.", "That command is owner-only."]);

  await h.say("/users", OWNER);
  expect(h.lastTo(OWNER)).toBe(`${OWNER} owner active\n${ALICE} member active`);
  await h.say(`/remove ${OWNER}`, OWNER);
  expect(h.lastTo(OWNER)).toBe("I can't remove the owner.");

  appendHistory(ALICE, "user", "hi");
  await h.say(`/remove ${ALICE}`, OWNER);
  expect(h.lastTo(OWNER)).toBe(`Removed ${ALICE} and deleted their data.`);
  expect(getUser(ALICE)).toMatchObject({ status: "removed", canvas_token_enc: null });
  expect(loadHistory(ALICE)).toEqual([]);
  const before = h.sent.length;
  await h.say("hello?", ALICE); // removed users are strangers again
  expect(h.sent.length).toBe(before);
  await h.say("/users", OWNER); // ...and /users no longer lists them
  expect(h.lastTo(OWNER)).toBe(`${OWNER} owner active`);
});

test("/users hides removed users (owner removal and self /disconnect) but keeps pending ones", async () => {
  const h = await harness();
  await addMember(ALICE);
  await addMember(BOB);
  await h.say("/disconnect", ALICE); // removed themselves
  await h.say(`/remove ${BOB}`, OWNER); // removed by the owner
  await h.say("/invite", OWNER);
  await h.say(`join ${code(h.lastTo(OWNER)!)}`, "+19195550103"); // pending
  await h.say("/users", OWNER);
  expect(h.lastTo(OWNER)).toBe(`${OWNER} owner active\n+19195550103 member pending`);
  expect(h.lastTo(OWNER)).not.toContain("removed");
});

test("/disconnect wipes the token, history, notification state and usage", async () => {
  const h = await harness();
  await addMember(ALICE);
  appendHistory(ALICE, "user", "my grades?");
  markNotified(ALICE, "grade:1:5");
  addTokens(ALICE, "2026-10-15", 500);
  createConnectLink(ALICE);
  saveLastEvent(ALICE, { title: "x" });

  await h.say("/disconnect", ALICE);
  expect(h.lastTo(ALICE)).toMatch(/^Disconnected\./);
  expect(getUser(ALICE)).toMatchObject({ status: "removed", canvas_token_enc: null, canvas_url: null, space_id: null, seeded: 0 });
  expect(loadHistory(ALICE)).toEqual([]);
  expect(wasNotified(ALICE, "grade:1:5")).toBe(false);
  expect(tokensToday(ALICE, "2026-10-15")).toBe(0);
  expect(loadLastEvent(ALICE)).toBeNull();
  expect(db.query("SELECT COUNT(*) AS n FROM connect_links WHERE phone = ?").get(ALICE)).toEqual({ n: 0 });
  expect(listActiveUsers().map((u) => u.phone)).toEqual([OWNER]);

  const before = h.sent.length;
  await h.say("hello", ALICE);
  expect(h.sent.length).toBe(before); // now a stranger

  // the owner has nothing to disconnect and keeps their data
  await h.say("/disconnect", OWNER);
  expect(h.lastTo(OWNER)).toMatch(/nothing to disconnect/);
  expect(getUser(OWNER)!.status).toBe("active");
});

test("existing safety still holds in multi-user mode: pause, quiet, status, dedupe, non-text", async () => {
  const h = await harness();
  await addMember(ALICE);
  await h.say(null, ALICE);
  expect(h.sent).toEqual([]);
  await h.say("/quiet", ALICE);
  expect(getUser(ALICE)!.notify).toBe(0);
  await h.say("/status", ALICE);
  expect(h.lastTo(ALICE)).toMatch(/next check not scheduled, notifications off/); // her own schedule, not the owner's
  await h.say("/status", OWNER);
  expect(h.lastTo(OWNER)).toMatch(/next check in (9|10)m/);
  await h.say("/pause", ALICE);
  const n = h.sent.length;
  await h.say("hi", ALICE);
  expect(h.sent.length).toBe(n);
  expect(getUser(OWNER)!.paused).toBe(0); // pausing one user doesn't pause another
});

test("a member whose token can't be decrypted is sent back through onboarding", async () => {
  const h = await harness();
  await addMember(ALICE);
  db.run("UPDATE users SET canvas_token_enc = 'v1:AAAA' WHERE phone = ?", [ALICE]);
  await h.say("what's due?", ALICE);
  expect(h.lastTo(ALICE)).toContain("/connect/");
  expect(getUser(ALICE)!.status).toBe("pending");
  expect(h.agentCalls()).toBe(0);
});

// ---------- 5. web onboarding ----------

async function pendingUserWithLink() {
  initDb(":memory:");
  ensureOwner(OWNER);
  const { createPendingUser } = await import("../src/db.ts");
  createPendingUser(ALICE);
  return createConnectLink(ALICE);
}

const post = (h: (r: Request) => Promise<Response>, token: string, fields: Record<string, string>) =>
  h(new Request(`https://bot.example.com/connect/${token}`, { method: "POST", body: new URLSearchParams(fields) }));

test("web: form page has strict headers and escapes everything", async () => {
  const token = await pendingUserWithLink();
  const handle = makeWebHandler({ send: async () => true, validate: async () => true });
  const res = await handle(new Request(`https://bot.example.com/connect/${token}`));
  expect(res.status).toBe(200);
  expect(res.headers.get("Cache-Control")).toBe("no-store");
  expect(res.headers.get("Referrer-Policy")).toBe("no-referrer");
  const csp = res.headers.get("Content-Security-Policy")!;
  expect(csp).toContain("default-src 'none'");
  expect(csp).toContain("form-action 'self'");
  expect(csp).toMatch(/style-src 'nonce-[\w-]+'/);
  // the only script is the click-to-load video swap, allowed by the page's nonce and nothing broader
  expect(csp).toMatch(/script-src 'nonce-[\w-]+';/);
  expect(csp).not.toContain("unsafe-inline");
  expect(csp).not.toContain("unsafe-eval");
  // fonts: Google Fonts hosts only, nothing else loosened
  expect(csp).toContain("style-src 'nonce-");
  expect(csp).toContain("https://fonts.googleapis.com; font-src https://fonts.gstatic.com;");
  // video: exactly these two additions, nothing else
  expect(csp).toContain("img-src https://i.ytimg.com;");
  expect(csp).toContain("frame-src https://www.youtube-nocookie.com;");
  expect(csp.match(/https?:\/\/[^\s;]+/g)?.sort()).toEqual(["https://fonts.googleapis.com", "https://fonts.gstatic.com", "https://i.ytimg.com", "https://www.youtube-nocookie.com"]);
  expect(csp.replace(/nonce-[\w-]+/g, "nonce-X")).toBe(
    "default-src 'none'; script-src 'nonce-X'; style-src 'nonce-X' https://fonts.googleapis.com; font-src https://fonts.gstatic.com; img-src https://i.ytimg.com; frame-src https://www.youtube-nocookie.com; form-action 'self'; base-uri 'none'; frame-ancestors 'none'",
  );
  expect(res.headers.get("Referrer-Policy")).toBe("no-referrer");
  const html = await res.text();
  // brand: colours, fonts, inline mark, title
  // Midnight Gold: light, dark, deadline and error colors
  for (const c of ["#f7f6f1", "#ffffff", "#15173a", "#575a78", "#1d2156", "#8a8ca6", "#0e1030", "#171a45", "#eeecf7", "#aeb0cc", "#f2b33d", "#6d72b5", "#b45309", "#fdba74", "#b42318", "#ff8a7a"]) expect(html).toContain(c);
  for (const old of ["#f5f7fa", "#0d1626", "#13294b", "#7bafd4"]) expect(html).not.toContain(old);
  // the owl, inline, in the spec's geometry
  expect(html).toContain('viewBox="0 0 100 100"');
  expect(html).toContain('<circle class="eye" cx="35" cy="43" r="15"/><circle class="eye" cx="65" cy="43" r="15"/>');
  expect(html).toContain('<circle class="pupil" cx="37" cy="44" r="6"/><circle class="pupil" cx="67" cy="44" r="6"/>');
  expect(html).toContain('d="M50 57 L55 64 L50 72 L45 64 Z"');
  expect(html).toContain(".owl .eye,.owl .beak{fill:var(--brand)}.owl .pupil{fill:var(--card)}");
  expect(html).toContain("border-radius:12px");
  expect(html).toContain("family=Bricolage+Grotesque");
  expect(html).toContain("family=Figtree");
  expect(html).toContain("<svg");
  expect(html).toContain("<h1>Connect your Canvas</h1>");
  expect(html).toContain('type="password"');
  expect(html).toContain("uncch.instructure.com");
  // the help video: label, thumbnail first, iframe only inside an inert template, referrer-restricted
  expect(html).toContain("Watch: how to get your Canvas token");
  expect(html).toContain("https://i.ytimg.com/vi/cZ5cn8stjM0/hqdefault.jpg");
  expect(html.split("<form")[0]).toContain("Watch: how to get your Canvas token"); // above the form
  expect(html.indexOf("</ol>")).toBeLessThan(html.indexOf("Watch: how"));
  const iframes = html.match(/<iframe[^>]*>/g) ?? [];
  expect(iframes).toHaveLength(1);
  expect(html.indexOf("<template")).toBeLessThan(html.indexOf("<iframe"));
  expect(html.indexOf("<iframe")).toBeLessThan(html.indexOf("</template>"));
  expect(iframes[0]).toContain('referrerpolicy="strict-origin-when-cross-origin"');
  expect(iframes[0]).toContain('src="https://www.youtube-nocookie.com/embed/cZ5cn8stjM0?autoplay=1&amp;rel=0"');
  expect(iframes[0]).toContain('allow="autoplay; encrypted-media; picture-in-picture"');
  expect(iframes[0]).toContain("allowfullscreen");
  expect(iframes[0]).toContain('loading="lazy"');
  expect(iframes[0]).toContain("title=");
  expect(html.match(/<script nonce="[\w-]+">/g)).toHaveLength(1);
  expect(html).not.toMatch(/<script(?![^>]*nonce=)/);
  expect(html).not.toMatch(/\son(click|load|error)=/);
  expect(peekConnectLink(token)).toBe(ALICE); // a GET (or link-preview fetch) does not use the link up

  expect((await handle(new Request("https://bot.example.com/connect/short"))).status).toBe(410);
  expect((await handle(new Request(`https://bot.example.com/connect/${"x".repeat(43)}`))).status).toBe(410);
  expect((await handle(new Request("https://bot.example.com/health"))).status).toBe(200);
  expect((await handle(new Request("https://bot.example.com/etc/passwd"))).status).toBe(404);
  expect((await handle(new Request(`https://bot.example.com/connect/${token}`, { method: "DELETE" }))).status).toBe(405);

  // hostile input comes back escaped
  const bad = await post(handle, token, { canvas_url: `"><script>alert(1)</script>`, canvas_token: "x" });
  const body = await bad.text();
  expect(bad.status).toBe(400);
  expect(body).not.toContain("<script>alert");
  expect(body).toContain("&lt;script&gt;");
});

test("web: only allowlisted Canvas hosts are ever contacted (SSRF)", async () => {
  let token = await pendingUserWithLink();
  const contacted: string[] = [];
  const handle = makeWebHandler({ send: async () => true, validate: async (u) => (contacted.push(u), true) });
  for (const evil of [
    "http://169.254.169.254/latest/meta-data",
    "https://evil.example.com",
    "https://uncch.instructure.com@evil.example.com",
    "https://uncch.instructure.com.evil.example.com",
    "https://uncch.instructure.com:8443",
    "http://uncch.instructure.com",
    "file:///etc/passwd",
  ]) {
    const res = await post(handle, token, { canvas_url: evil, canvas_token: "tok" });
    expect(res.status).toBe(400);
    token = createConnectLink(ALICE); // each wrong try counts toward burning the link, so use a fresh one
  }
  expect(contacted).toEqual([]);
  expect(normalizeCanvasUrl("uncch.instructure.com")).toBe("https://uncch.instructure.com");
  expect(normalizeCanvasUrl("https://UNCCH.instructure.com/profile")).toBe("https://uncch.instructure.com");
  expect(allowedCanvasHosts()).toEqual(["uncch.instructure.com"]);
  expect(normalizeCanvasUrl("duke.instructure.com", ["uncch.instructure.com", "duke.instructure.com"])).toBe("https://duke.instructure.com");
});

test("web: a valid token activates the user once, stored encrypted, welcome texted", async () => {
  const token = await pendingUserWithLink();
  const texts: { to: string; text: string }[] = [];
  const handle = makeWebHandler({ send: async (to, text) => (texts.push({ to, text }), true), validate: async (_u, t) => t === "good-token" });

  const wrong = await post(handle, token, { canvas_url: "uncch.instructure.com", canvas_token: "bad-token" });
  expect(wrong.status).toBe(400);
  expect(getUser(ALICE)!.status).toBe("pending");
  expect(peekConnectLink(token)).toBe(ALICE); // a wrong token doesn't burn the link

  const ok = await post(handle, token, { canvas_url: "uncch.instructure.com", canvas_token: "good-token" });
  expect(ok.status).toBe(200);
  const u = getUser(ALICE)!;
  expect(u).toMatchObject({ status: "active", canvas_url: "https://uncch.instructure.com", seeded: 0 });
  expect(u.canvas_token_enc).not.toContain("good-token");
  expect(await decrypt(u.canvas_token_enc!)).toBe("good-token");
  expect(texts).toHaveLength(1);
  expect(texts[0]!.to).toBe(ALICE);
  expect(JSON.stringify(db.query("SELECT * FROM users").all())).not.toContain("good-token");

  const again = await post(handle, token, { canvas_url: "uncch.instructure.com", canvas_token: "good-token" });
  expect(again.status).toBe(410); // single use
  expect(texts).toHaveLength(1);
  expect(listActiveUsers().map((x) => x.phone)).toContain(ALICE);
});

test("web: five wrong tries burn the link", async () => {
  const token = await pendingUserWithLink();
  const handle = makeWebHandler({ send: async () => true, validate: async () => false });
  let last = 0;
  for (let i = 0; i < 5; i++) last = (await post(handle, token, { canvas_url: "uncch.instructure.com", canvas_token: `guess${i}` })).status;
  expect(last).toBe(410);
  expect(peekConnectLink(token)).toBeNull();
});

test("web: a user removed after the link was issued can't connect", async () => {
  const token = await pendingUserWithLink();
  const { wipeUser } = await import("../src/db.ts");
  wipeUser(ALICE, "removed");
  const handle = makeWebHandler({ send: async () => true, validate: async () => true });
  expect((await post(handle, token, { canvas_url: "uncch.instructure.com", canvas_token: "t" })).status).toBe(410);
  expect(getUser(ALICE)!.status).toBe("removed");
});

// ---------- 6. scheduler ----------

test("scheduler: every active user runs in their own context; one user's failure doesn't stop the rest", async () => {
  initDb(":memory:");
  ensureOwner(OWNER);
  await addMember(ALICE);
  await addMember(BOB);
  const seen: string[] = [];
  const { currentContext } = await import("../src/context.ts");
  const deps: Deps = {
    now: () => new Date("2026-10-15T14:00:00Z"),
    courses: async () => (seen.push(`${currentContext()!.key}:${currentContext()!.canvasToken}`), []),
    assignments: async () => [],
    announcements: async () => [],
    missing: async () => [],
    events: async () => null,
    summarize: async (t) => t,
  };
  const sched = startScheduler({
    users: () => listActiveUsers(),
    contextFor: async (u) => {
      if (u.phone === ALICE) throw new Error("cannot decrypt");
      return { key: u.phone, role: u.role, timezone: u.timezone, canvasUrl: "https://x", canvasToken: `tok-${u.phone}` };
    },
    deps,
    send: async () => true,
  });
  await sched.tick();
  sched.stop();

  expect(seen.some((s) => s.startsWith(`${OWNER}:tok-${OWNER}`))).toBe(true);
  expect(seen.some((s) => s.startsWith(`${BOB}:tok-${BOB}`))).toBe(true);
  expect(seen.some((s) => s.startsWith(ALICE))).toBe(false);
  expect(sched.nextCheckAt(OWNER)).not.toBeNull();
  expect(sched.nextCheckAt(BOB)).not.toBeNull();
  expect(sched.nextCheckAt(ALICE)).toBeNull(); // her own schedule, untouched
  expect(getUser(BOB)!.seeded).toBe(1); // new users get the silent first-run seed
  expect(getUser(OWNER)!.seeded).toBe(1);
});
