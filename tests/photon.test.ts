import { beforeEach, expect, test } from "bun:test";
import { createInvite, ensureOwner, getUser, initDb, peekConnectLink, peekInvite, redeemInvite, setPhotonUser, wipeUser, createPendingUser } from "../src/db.ts";
import { DEFAULT_USER_LIMIT, looksLikeLimitError, makePhoton, photonFromEnv, userLimit, type Enroll, type Photon } from "../src/photon.ts";
import { makeWebHandler, parseUsMobile, prettyNumber } from "../src/web.ts";
import { ALICE, OWNER, addMember, harness } from "./helpers.ts";
import { maskId } from "../src/mask.ts";
import { fullName, parseEmail, parseName } from "../src/profile.ts";
import { runBrief } from "../src/notify.ts";
import { buildSystemPrompt } from "../src/agent.ts";
import { runWithContext } from "../src/context.ts";

const PROJECT = "11111111-2222-4333-8444-555555555555", SECRET = "fake-secret-not-real";
const PHONE = "+19195550142", ASSIGNED = "+16285550199";
const BASIC = "Basic " + btoa(`${PROJECT}:${SECRET}`);

// ---------- the Photon client, with a fake fetch (never the network) ----------

type Call = { method: string; url: string; auth: string | null; body: any };
function fakeApi(opts: { users?: any[]; total?: number; listStatus?: number; create?: { status: number; json: any }; del?: number } = {}) {
  const calls: Call[] = [];
  const users = opts.users ?? [];
  const f = (async (url: string, init: RequestInit) => {
    const method = init.method ?? "GET";
    calls.push({ method, url, auth: (init.headers as any)?.Authorization ?? null, body: init.body ? JSON.parse(String(init.body)) : null });
    const reply = (status: number, json: any) => new Response(JSON.stringify(json), { status, headers: { "Content-Type": "application/json" } });
    if (method === "GET") return opts.listStatus && opts.listStatus !== 200 ? reply(opts.listStatus, { succeed: false, data: null, code: "ERR", message: "x" }) : reply(200, { succeed: true, data: { users, total: opts.total ?? users.length } });
    if (method === "POST") return opts.create ? reply(opts.create.status, opts.create.json) : reply(200, { succeed: true, data: { id: "u-new", type: "shared", phoneNumber: JSON.parse(String(init.body)).phoneNumber, assignedPhoneNumber: ASSIGNED } });
    return reply(opts.del ?? 200, { succeed: true, data: { userId: "x" } });
  }) as unknown as typeof fetch;
  return { f, calls };
}
const mk = (api: ReturnType<typeof fakeApi>, limit = 10) => makePhoton({ projectId: PROJECT, secret: SECRET, limit, fetch: api.f });
const fill = (n: number) => Array.from({ length: n }, (_, i) => ({ id: `u${i}`, phoneNumber: `+1919555${String(1000 + i)}`, assignedPhoneNumber: ASSIGNED }));

test("enroll: Basic auth with project id and secret, shared type, returns the assigned number", async () => {
  const api = fakeApi({ users: fill(4) });
  const r = await mk(api).enroll(PHONE);
  expect(r).toEqual({ ok: true, id: "u-new", assignedNumber: ASSIGNED, existing: false });
  const post = api.calls.find((c) => c.method === "POST")!;
  expect(post.url).toBe(`https://spectrum.photon.codes/projects/${PROJECT}/users/`);
  expect(post.body).toEqual({ type: "shared", phoneNumber: PHONE });
  expect(post.auth).toBe(BASIC);
  expect(api.calls[0]!.url).toBe(`https://spectrum.photon.codes/projects/${PROJECT}/users/?type=shared`);
});

test("enroll: a number that's already enrolled is returned as is, not created or counted again, even when full", async () => {
  const api = fakeApi({ users: [...fill(9), { id: "mine", phoneNumber: PHONE, assignedPhoneNumber: ASSIGNED }] });
  expect(await mk(api).enroll(PHONE)).toEqual({ ok: true, id: "mine", assignedNumber: ASSIGNED, existing: true });
  expect(api.calls.some((c) => c.method === "POST")).toBe(false);
});

test("the proactive count refuses at the limit without calling create", async () => {
  const api = fakeApi({ users: fill(10) });
  const r = await mk(api, 10).enroll(PHONE);
  expect(r).toMatchObject({ ok: false, reason: "full" });
  expect(api.calls.some((c) => c.method === "POST")).toBe(false);
  expect(await mk(fakeApi({ users: fill(9) }), 10).enroll(PHONE)).toMatchObject({ ok: true });
});

test("the limit is a setting: PHOTON_USER_LIMIT (default 10) and Pro's 100", async () => {
  expect(DEFAULT_USER_LIMIT).toBe(10);
  expect(userLimit({})).toBe(10);
  expect(userLimit({ PHOTON_USER_LIMIT: "100" } as any)).toBe(100);
  expect(userLimit({ PHOTON_USER_LIMIT: "abc" } as any)).toBe(10);
  expect(userLimit({ PHOTON_USER_LIMIT: "-5" } as any)).toBe(10);
  expect(userLimit({ PHOTON_USER_LIMIT: "0" } as any)).toBe(10);
  const full = fakeApi({ users: fill(10) });
  expect(await mk(full, 10).enroll(PHONE)).toMatchObject({ ok: false, reason: "full" });
  expect(await mk(fakeApi({ users: fill(10) }), 100).enroll(PHONE)).toMatchObject({ ok: true }); // same 10 users, Pro limit
  expect(photonFromEnv({ PROVIDER: "cloud", SPECTRUM_PROJECT_ID: PROJECT, SPECTRUM_PROJECT_SECRET: SECRET, PHOTON_USER_LIMIT: "100" } as any)?.limit).toBe(100);
  expect(photonFromEnv({ PROVIDER: "cloud", SPECTRUM_PROJECT_ID: PROJECT, SPECTRUM_PROJECT_SECRET: SECRET } as any)?.limit).toBe(10);
  expect(photonFromEnv({ PROVIDER: "terminal", SPECTRUM_PROJECT_ID: PROJECT, SPECTRUM_PROJECT_SECRET: SECRET } as any)).toBeNull();
  expect(photonFromEnv({ PROVIDER: "cloud" } as any)).toBeNull();
});

test("backup: if the count can't be read, a limit refusal from create still counts as full", async () => {
  for (const create of [
    { status: 403, json: { succeed: false, data: null, code: "USER_LIMIT_REACHED", message: "Shared user limit reached for this plan" } },
    { status: 400, json: { succeed: false, data: null, code: "BAD", message: "maxSharedUsers exceeded" } },
    { status: 402, json: { succeed: false, data: null, code: "PAYMENT", message: "x" } },
  ]) {
    const api = fakeApi({ listStatus: 500, create });
    expect(await mk(api).enroll(PHONE)).toMatchObject({ ok: false, reason: "full" });
  }
  // a different failure is an error, not "full"
  const other = fakeApi({ listStatus: 500, create: { status: 500, json: { succeed: false, data: null, code: "INTERNAL", message: "boom" } } });
  expect(await mk(other).enroll(PHONE)).toMatchObject({ ok: false, reason: "error" });
  // and a refusal from create after a good count still maps to full
  const late = fakeApi({ users: fill(3), create: { status: 409, json: { succeed: false, data: null, code: "QUOTA", message: "limit" } } });
  expect(await mk(late).enroll(PHONE)).toMatchObject({ ok: false, reason: "full" });
  expect(looksLikeLimitError(422, "VALIDATION_ERROR", "phoneNumber must be e164")).toBe(false);
});

test("remove: by id, by phone when the id isn't known, gone already, and failure", async () => {
  const a = fakeApi();
  expect(await mk(a).remove("u-1", PHONE)).toBe(true);
  expect(a.calls).toEqual([{ method: "DELETE", url: `https://spectrum.photon.codes/projects/${PROJECT}/users/u-1/`, auth: BASIC, body: null }]);
  const b = fakeApi({ users: [{ id: "found", phoneNumber: PHONE }] });
  expect(await mk(b).remove(null, PHONE)).toBe(true);
  expect(b.calls.at(-1)).toMatchObject({ method: "DELETE", url: `https://spectrum.photon.codes/projects/${PROJECT}/users/found/` });
  const c = fakeApi({ users: [] });
  expect(await mk(c).remove(null, PHONE)).toBe(true);
  expect(c.calls.some((x) => x.method === "DELETE")).toBe(false);
  expect(await mk(fakeApi({ del: 500 })).remove("u-1", PHONE)).toBe(false);
  expect(await mk(fakeApi({ del: 404 })).remove("u-1", PHONE)).toBe(true);
});

// ---------- phone validation ----------

const us = (area: string, exch: string, line = "0142") => `(${area}) ${exch}-${line}`;
const intl = (cc: string, rest: string) => `+${cc} ${rest}`;

test("US mobile numbers in any format become E.164; everything else is refused", () => {
  for (const ok of ["(919) 555-0142", "919-555-0142", "919.555.0142", "9195550142", "+1 919 555 0142", "1 (919) 555-0142", "+19195550142"]) expect(parseUsMobile(ok)).toBe("+19195550142");
  // built from parts: these are deliberately invalid numbers (service codes, toll-free, other countries), not data
  const bad = ["", "12345", "919555014", "91955501421", intl("44", "7700 900123"), intl("52", "55 1234 5678"), us("800", "555"), us("888", "555"), us("911", "555"), us("919", "911"), us("019", "555"), us("919", "055"), "abc", "<script>"];
  for (const b of bad) expect(parseUsMobile(b)).toBeNull();
  expect(prettyNumber("+16285550199")).toBe("+1 (628) 555-0199");
  expect(prettyNumber(intl("44", "000"))).toBe("+44 000"); // anything that is not a US number is shown as given
});

// ---------- the join page ----------

let sent: { to: string; text: string; kind: string }[];
let enrolled: string[];
let removed: string[];
let result: Enroll;
let sendOk: boolean;
let onEnroll: (() => void) | undefined;
const photon: Photon = {
  limit: 10,
  count: async () => 4,
  enroll: async (p) => { enrolled.push(p); onEnroll?.(); return result; },
  remove: async (id, p) => { removed.push(`${id}|${p}`); return true; },
  rename: async () => "updated",
};
let t0: number;
const handle = (opts: { photon?: Photon | null } = {}) =>
  makeWebHandler({
    send: async (to, text, kind) => (sent.push({ to, text, kind }), sendOk),
    photon: opts.photon === undefined ? photon : opts.photon,
    ownerKey: OWNER, inviterName: "Sam", publicUrl: "https://bot.example.com", now: () => t0,
  });
const WHO = { first: "Jordan", last: "Rivers", email: "Jordan.Rivers@Example.com" };
const post = (h: ReturnType<typeof handle>, code: string, phone: string, ip = "203.0.113.7", who: Partial<typeof WHO> = {}) =>
  h(new Request(`https://bot.example.com/join/${code}`, { method: "POST", body: new URLSearchParams({ ...WHO, ...who, phone }), headers: { "x-real-ip": ip } }));

beforeEach(() => {
  initDb(":memory:");
  ensureOwner(OWNER);
  sent = []; enrolled = []; removed = []; sendOk = true; onEnroll = undefined; t0 = Date.now();
  result = { ok: true, id: "photon-1", assignedNumber: ASSIGNED, existing: false };
});

test("GET /join/<code>: the branded form with the same strict CSP, no script or frame; bad codes get a 410", async () => {
  const { code } = createInvite(OWNER);
  const res = await handle()(new Request(`https://bot.example.com/join/${code}`));
  expect(res.status).toBe(200);
  const html = await res.text();
  for (const f of ["first", "last", "email", "phone"]) expect(html).toContain(`name="${f}"`);
  expect(html).toContain("<title>Join Pallas</title>");
  // Midnight Gold: light, dark, deadline and error colors
  for (const c of ["#f7f6f1", "#ffffff", "#15173a", "#575a78", "#1d2156", "#8a8ca6", "#0e1030", "#171a45", "#eeecf7", "#aeb0cc", "#f2b33d", "#6d72b5", "#b45309", "#fdba74", "#b42318", "#ff8a7a"]) expect(html).toContain(c);
  for (const old of ["#f5f7fa", "#0d1626", "#13294b", "#7bafd4"]) expect(html).not.toContain(old);
  // the owl, inline, in the spec's geometry
  expect(html).toContain('viewBox="0 0 100 100"');
  expect(html).toContain('<circle class="eye" cx="35" cy="43" r="15"/><circle class="eye" cx="65" cy="43" r="15"/>');
  expect(html).toContain('<circle class="pupil" cx="37" cy="44" r="6"/><circle class="pupil" cx="67" cy="44" r="6"/>');
  expect(html).toContain('d="M50 57 L55 64 L50 72 L45 64 Z"');
  expect(html).toContain(".owl .eye,.owl .beak{fill:var(--brand)}.owl .pupil{fill:var(--card)}");
  expect(html).toContain("family=Bricolage+Grotesque");
  expect(html).toContain("<svg");
  expect(html).not.toContain("<script");
  expect(html).not.toContain("<iframe");
  const csp = res.headers.get("Content-Security-Policy")!;
  expect(csp.replace(/nonce-[\w-]+/g, "nonce-X")).toBe("default-src 'none'; style-src 'nonce-X' https://fonts.googleapis.com; font-src https://fonts.gstatic.com; img-src https://i.ytimg.com; frame-src https://www.youtube-nocookie.com; form-action 'self'; base-uri 'none'; frame-ancestors 'none'");
  expect(res.headers.get("Referrer-Policy")).toBe("no-referrer");
  expect(peekInvite(code)).toBe(true); // a GET never uses the code
  expect((await handle()(new Request("https://bot.example.com/join/NOPE00"))).status).toBe(410);
  expect((await handle()(new Request("https://bot.example.com/join/x"))).status).toBe(410);
});

test("a valid code and number: enrolled on Photon, pending user, Pallas texts FIRST with the connect link, page says check your texts", async () => {
  const { code } = createInvite(OWNER);
  const res = await post(handle(), code, "(919) 555-0142");
  expect(res.status).toBe(200);
  const html = await res.text();
  expect(html).toContain("Check your texts");
  expect(html).toContain("from +1 (628) 555-0199");
  expect(enrolled).toEqual([PHONE]);
  expect(getUser(PHONE)).toMatchObject({ status: "pending", role: "member", photon_user_id: "photon-1", photon_number: ASSIGNED });
  expect(peekInvite(code)).toBe(false); // used up
  expect(sent).toHaveLength(1);
  expect(sent[0]!.to).toBe(PHONE);
  expect(sent[0]!.kind).toBe("notify");
  const m = sent[0]!.text.match(/^Hi Jordan, I'm Pallas\. Sam invited you\. Connect your Canvas here: (https:\/\/bot\.example\.com\/connect\/([\w-]{43}))\nSave Pallas to Contacts: https:\/\/bot\.example\.com\/contact\/[\w-]{43}$/);
  expect(m).not.toBeNull();
  expect(peekConnectLink(m![2]!)).toBe(PHONE); // the link in the text is live
  expect(sent[0]!.text).not.toContain(ASSIGNED);
  // the same code cannot be used again
  expect((await post(handle(), code, "(919) 555-0143")).status).toBe(410);
  expect(enrolled).toEqual([PHONE]);
});

test("invalid numbers are refused before Photon is called, and the invite is not used up", async () => {
  const { code } = createInvite(OWNER);
  for (const bad of ["12345", "+44 7700 900123", "(800) 555-0142", ""]) {
    const res = await post(handle(), code, bad, `198.51.100.${bad.length + 1}`);
    expect(res.status).toBe(400);
    expect(await res.text()).toContain("US mobile number");
  }
  expect(enrolled).toEqual([]);
  expect(sent).toEqual([]);
  expect(peekInvite(code)).toBe(true);
});

test("plan full: 'Pallas is full right now' on the page, invite kept, owner told once an hour", async () => {
  const { code } = createInvite(OWNER);
  result = { ok: false, reason: "full", message: "10 of 10 users enrolled" };
  const h = handle();
  const res = await post(h, code, "(919) 555-0142");
  expect(res.status).toBe(503);
  expect(await res.text()).toContain("Pallas is full right now");
  expect(sent).toEqual([{ to: OWNER, text: "Invite failed: Photon user limit reached.", kind: "notify" }]);
  expect(getUser(PHONE)).toBeNull();
  expect(peekInvite(code)).toBe(true);
  await post(h, code, "(919) 555-0143", "198.51.100.9"); // another try in the same hour: no second alert
  expect(sent).toHaveLength(1);
  t0 += 2 * 3600_000; // later: told again
  await post(h, code, "(919) 555-0144", "198.51.100.10");
  expect(sent).toHaveLength(2);
});

test("a Photon error is a retryable page, the invite is kept, and the owner hears about it", async () => {
  const { code } = createInvite(OWNER);
  result = { ok: false, reason: "error", message: "photon create user failed (500 INTERNAL)" };
  const res = await post(handle(), code, "(919) 555-0142");
  expect(res.status).toBe(502);
  expect(await res.text()).toContain("Couldn't set you up just now");
  expect(sent).toEqual([{ to: OWNER, text: "Invite failed: couldn't reach Photon to enroll a number.", kind: "notify" }]);
  expect(peekInvite(code)).toBe(true);
  expect(getUser(PHONE)).toBeNull();
});

test("rate limits: per code and per IP", async () => {
  const a = createInvite(OWNER).code;
  const h = handle();
  for (let i = 0; i < 5; i++) expect((await post(h, a, "nope", `198.51.100.${i + 20}`)).status).toBe(400); // different IPs, same code
  expect((await post(h, a, "nope", "198.51.100.99")).status).toBe(429);
  const codes = Array.from({ length: 11 }, () => createInvite(OWNER).code);
  for (let i = 0; i < 10; i++) expect((await post(h, codes[i]!, "nope", "192.0.2.1")).status).toBe(400); // same IP, different codes
  expect((await post(h, codes[10]!, "nope", "192.0.2.1")).status).toBe(429);
  expect((await post(h, codes[10]!, "nope", "192.0.2.2")).status).toBe(400); // another IP is fine
  t0 += 3600_001; // the window slides
  expect((await post(h, a, "nope", "192.0.2.1")).status).toBe(400);
  // the client IP is the proxy's address, not a first hop the client can invent
  const spoof = (i: number, xff: string) => h(new Request(`https://bot.example.com/join/${codes[i % 11]}`, { method: "POST", body: new URLSearchParams({ phone: "x" }), headers: { "x-forwarded-for": xff } }));
  for (let i = 0; i < 10; i++) expect((await spoof(i, `1.1.1.${i}, 203.0.113.50`)).status).toBe(400); // a different made-up first hop each time
  expect((await spoof(10, "9.9.9.9, 203.0.113.50")).status).toBe(429); // still the same real client
});

test("an already active number isn't enrolled again", async () => {
  createPendingUser(ALICE);
  const { code } = createInvite(OWNER);
  const { saveCanvasCredentials } = await import("../src/db.ts");
  saveCanvasCredentials(ALICE, "https://uncch.instructure.com", "enc");
  const res = await post(handle(), code, ALICE.replace("+1", ""));
  expect(await res.text()).toContain("already set up");
  expect(enrolled).toEqual([]);
  expect(peekInvite(code)).toBe(true);
});

test("if the code is used between the check and the enrollment, a freshly enrolled number is removed again", async () => {
  const { code } = createInvite(OWNER);
  onEnroll = () => void redeemInvite(code, "+19195559999");
  const res = await post(handle(), code, "(919) 555-0142");
  expect(res.status).toBe(410);
  expect(removed).toEqual([`photon-1|${PHONE}`]);
  expect(getUser(PHONE)).toBeNull();
  expect(sent).toEqual([]);
  // an already-enrolled number is left alone
  const again = createInvite(OWNER).code;
  result = { ok: true, id: "old", assignedNumber: ASSIGNED, existing: true };
  removed.length = 0;
  onEnroll = () => void redeemInvite(again, "+19195559998");
  await post(handle(), again, "(919) 555-0142", "198.51.100.77");
  expect(removed).toEqual([]);
});

test("if the first text can't be sent: no fake success, and the page leads with the one last step and the big Open Messages button", async () => {
  const { code } = createInvite(OWNER);
  sendOk = false;
  const res = await post(handle(), code, "(919) 555-0142");
  const html = await res.text();
  expect(res.status).toBe(200);
  expect(html).not.toContain("Check your texts");
  expect(html).not.toContain("just messaged you");
  expect(html).toContain("One last step: text Pallas 'hi'");
  expect(html).not.toMatch(/couldn't send|couldn&#39;t send|\byet\b/);
  expect(getUser(PHONE)).toMatchObject({ status: "pending", welcomed: 0, welcome_tries: 1 });
  expect(html).toContain("<b>+1 (628) 555-0199</b>"); // the number in plain text
  // the raw HTML escapes the ampersand (valid HTML); the browser reads it back as sms:<number>&body=hi
  expect(html).toContain(`<a class="btn big" href="sms:${ASSIGNED}&amp;body=hi">Open Messages</a>`);
});

test("the success page ALWAYS shows the assigned number and the big Open Messages (sms) button, sent or not", async () => {
  for (const ok of [true, false]) {
    sendOk = ok;
    const { code } = createInvite(OWNER);
    const html = await (await post(handle(), code, "(919) 555-0142", `198.51.100.${ok ? 40 : 41}`)).text();
    expect(html).toContain(ok ? "Check your texts" : "One last step: text Pallas 'hi'");
    expect(html).toContain(`<a class="btn big" href="sms:${ASSIGNED}&amp;body=hi">Open Messages</a>`);
    expect(html).toContain("+1 (628) 555-0199");
    expect(html.includes("Check your texts")).toBe(ok);
    createPendingUser(PHONE); // reset between rounds
  }
});

test("the connect token never appears on the join page or in the sms link", async () => {
  for (const ok of [true, false]) {
    sent.length = 0;
    sendOk = ok;
    const { code } = createInvite(OWNER);
    const html = await (await post(handle(), code, "(919) 555-0142", `198.51.100.${ok ? 50 : 51}`)).text();
    const token = sent[0]!.text.match(/\/connect\/([\w-]{43})/)![1]!;
    expect(html).not.toContain(token);
    expect(html).not.toContain("/connect/");
    expect(html.match(/sms:[^"]+/g)).toEqual([`sms:${ASSIGNED}&amp;body=hi`]); // only the number and "hi"
    createPendingUser(PHONE);
  }
});

test("a weird assigned number never becomes an sms link", async () => {
  const { code } = createInvite(OWNER);
  result = { ok: true, id: "photon-1", assignedNumber: 'x"><b>', existing: false };
  const html = await (await post(handle(), code, "(919) 555-0142")).text();
  expect(html).not.toContain("sms:");
  expect(html).not.toContain("<b>x");
  expect(html).toContain("Pallas just messaged you");
});

test("a full plan still shows 'Pallas is full right now' (never a fake success)", async () => {
  const { code } = createInvite(OWNER);
  result = { ok: false, reason: "full", message: "10 of 10 users enrolled" };
  const res = await post(handle(), code, "(919) 555-0142");
  const html = await res.text();
  expect(res.status).toBe(503);
  expect(html).toContain("Pallas is full right now");
  expect(html).not.toContain("One last step");
  expect(html).not.toContain("sms:");
  expect(sent.every((m) => m.to === OWNER)).toBe(true);
});

test("without Photon (local/terminal) the join flow still works, with no number shown", async () => {
  const { code } = createInvite(OWNER);
  const html = await (await post(handle({ photon: null }), code, "(919) 555-0142")).text();
  expect(html).toContain("Check your texts");
  expect(html).not.toContain("from +1");
  expect(sent[0]!.text).toContain("Hi Jordan, I'm Pallas. Sam invited you.");
});

test("a missing inviter name falls back to 'a friend'", async () => {
  const { code } = createInvite(OWNER);
  const h = makeWebHandler({ send: async (to, text, kind) => (sent.push({ to, text, kind }), true), photon, ownerKey: OWNER, publicUrl: "https://bot.example.com" });
  await post(h, code, "(919) 555-0142");
  expect(sent[0]!.text).toContain("a friend invited you.");
});

// ---------- /invite, /remove, /disconnect ----------

test("/invite gives a /join link and keeps the 'join CODE' text path, with no bot number", async () => {
  const h = await harness();
  await h.say("/invite", OWNER);
  const text = h.lastTo(OWNER)!;
  const c = text.match(/https:\/\/bot\.example\.com\/join\/([A-Z0-9]{6})/)![1]!;
  expect(text).toContain("Text it 'hi' to start.");
  expect(text).not.toContain("+15555550199");
  expect(text).not.toContain("Invite code:");
  await h.say(`join ${c}`, ALICE); // the text path still works for an enrolled number
  expect(getUser(ALICE)?.status).toBe("pending");
});

test("/remove frees the Photon slot (by stored id), and says so; a failure says so honestly", async () => {
  const h = await harness();
  const calls: string[] = [];
  let ok = true;
  h.deps.unenroll = async (key, id) => (calls.push(`${key}|${id}`), ok);
  createPendingUser(ALICE);
  setPhotonUser(ALICE, "photon-7", ASSIGNED);
  await h.say(`/remove ${ALICE}`, OWNER);
  expect(calls).toEqual([`${ALICE}|photon-7`]);
  expect(h.lastTo(OWNER)).toBe(`Removed ${ALICE}, deleted their data and freed their Photon slot.`);
  expect(getUser(ALICE)).toMatchObject({ status: "removed", photon_user_id: null, photon_number: null });
  createPendingUser("+19195550177");
  ok = false;
  await h.say("/remove +19195550177", OWNER);
  expect(h.lastTo(OWNER)).toContain("couldn't free their Photon slot");
  await h.say(`/remove ${OWNER}`, OWNER);
  expect(calls).toHaveLength(2); // the owner is never removed, and never un-enrolled
});

test("/disconnect frees the member's Photon slot too (and not the owner's)", async () => {
  const h = await harness();
  const calls: string[] = [];
  h.deps.unenroll = async (key, id) => (calls.push(`${key}|${id}`), true);
  createPendingUser(ALICE);
  setPhotonUser(ALICE, "photon-8", ASSIGNED);
  await h.say("/disconnect", ALICE);
  expect(calls).toEqual([`${ALICE}|photon-8`]);
  expect(getUser(ALICE)?.status).toBe("removed");
  await h.say("/disconnect", OWNER);
  expect(calls).toHaveLength(1);
});

test("without Photon, /remove doesn't mention a Photon slot", async () => {
  const h = await harness();
  createPendingUser(ALICE);
  await h.say(`/remove ${ALICE}`, OWNER);
  expect(h.lastTo(OWNER)).toBe(`Removed ${ALICE} and deleted their data.`);
});

test("wipeUser clears the stored Photon ids", () => {
  createPendingUser(ALICE);
  setPhotonUser(ALICE, "photon-9", ASSIGNED);
  wipeUser(ALICE, "removed");
  expect(getUser(ALICE)).toMatchObject({ photon_user_id: null, photon_number: null });
});

// ---------- name and email on the join page ----------

test("name rules: 1-50 characters, trimmed, letters plus spaces, hyphens and apostrophes", () => {
  const ok = (raw: string) => { const r = parseName(raw, "First name"); return r.ok ? r.value : null; };
  expect(ok("  Jordan  ")).toBe("Jordan");
  expect(ok("Mary-Ann")).toBe("Mary-Ann");
  expect(ok("O'Neil")).toBe("O'Neil");
  expect(ok("D’Arcy")).toBe("D’Arcy");
  expect(ok("Mary  Ann")).toBe("Mary Ann"); // inner whitespace collapses
  expect(ok("José")).toBe("José");
  expect(ok("Zoë Łukasz")).toBe("Zoë Łukasz");
  expect(ok("A")).toBe("A");
  expect(ok("a".repeat(50))).toBe("a".repeat(50));
  for (const bad of ["", "   ", "a".repeat(51), "Jordan3", "Jo_rdan", "<b>Jo</b>", "-Jordan", "'Jordan", "Jordan!", "jordan@x", "J.R."]) expect(parseName(bad, "Last name").ok).toBe(false);
  expect(parseName("", "Last name")).toEqual({ ok: false, error: "Last name is required." });
  expect(fullName({ first_name: "Jordan", last_name: "Rivers" })).toBe("Jordan Rivers");
  expect(fullName({ first_name: null, last_name: null })).toBe("");
});

test("email rules: basic format, lowercased", () => {
  expect(parseEmail("  Jordan.Rivers@Example.COM ")).toEqual({ ok: true, value: "jordan.rivers@example.com" });
  expect(parseEmail("a+tag@mail.example.com")).toEqual({ ok: true, value: "a+tag@mail.example.com" });
  const at = (local: string, domain: string) => `${local}@${domain}`; // deliberately malformed addresses, built from parts
  const bad = ["", "plain", at("a", "b"), at("a", "b.c"), at("", "example.com"), at("a@", "example.com"), at("a b", "example.com"), at("a", "exa mple.com"), at("a..b", "example.com"), at("<x>", "example.com"), at("a".repeat(250), "example.com")];
  for (const b of bad) expect(parseEmail(b).ok).toBe(false);
});

test("the form asks for all four fields with labels and autocomplete attributes", async () => {
  const { code } = createInvite(OWNER);
  const html = await (await handle()(new Request(`https://bot.example.com/join/${code}`))).text();
  for (const [id, label, ac] of [["first", "First name", "given-name"], ["last", "Last name", "family-name"], ["email", "Email", "email"], ["phone", "Mobile number", "tel"]]) {
    expect(html).toContain(`<label for="${id}">${label}</label>`);
    expect(html).toContain(`autocomplete="${ac}"`);
    expect(html).toMatch(new RegExp(`<input id="${id}" name="${id}"[^>]* required`));
  }
  expect(html).toContain("We use your name and email only to set up your Pallas account. We never share them.");
  expect(html).not.toContain(`aria-invalid="true"`);
});

test("inline errors per field, typed values kept, nothing enrolled and the invite kept", async () => {
  const { code } = createInvite(OWNER);
  const res = await post(handle(), code, "12345", "198.51.100.1", { first: "Jo3", last: "", email: "nope" });
  expect(res.status).toBe(400);
  const html = await res.text();
  expect(html).toContain('id="first-err"');
  expect(html).toContain("First name can only use letters, spaces, hyphens and apostrophes.");
  expect(html).toContain("Last name is required.");
  expect(html).toContain("Enter a valid email, like name@example.com.");
  expect(html).toContain("Enter a US mobile number, like (919) 555-0123.");
  expect(html.match(/aria-invalid="true"/g)).toHaveLength(4);
  expect(html).toContain('value="Jo3"');
  expect(html).toContain('value="nope"');
  expect(html).not.toContain("<script");
  // an error in one field only flags that field
  const one = await (await post(handle(), code, "(919) 555-0142", "198.51.100.2", { email: "bad" })).text();
  expect(one.match(/aria-invalid="true"/g)).toHaveLength(1);
  expect(one).toContain('value="Jordan"');
  expect(enrolled).toEqual([]);
  expect(peekInvite(code)).toBe(true);
  // markup in a name never reaches the page unescaped
  const xss = await (await post(handle(), code, "(919) 555-0142", "198.51.100.3", { first: '"><script>x</script>' })).text();
  expect(xss).not.toContain("<script>x");
  expect(xss).toContain("&lt;script&gt;");
});

test("the profile goes to Photon in the create call, and is saved on our row", async () => {
  const api = fakeApi({ users: fill(4) });
  const { code } = createInvite(OWNER);
  const h = makeWebHandler({ send: async (to, text, kind) => (sent.push({ to, text, kind }), true), photon: mk(api), ownerKey: OWNER, inviterName: "Sam", publicUrl: "https://bot.example.com" });
  const res = await post(h, code, "(919) 555-0142", "198.51.100.4", { first: "  Jordan ", email: " Jordan.Rivers@Example.com " });
  expect(res.status).toBe(200);
  const create = api.calls.find((c) => c.method === "POST")!;
  expect(create.body).toEqual({ type: "shared", phoneNumber: PHONE, firstName: "Jordan", lastName: "Rivers", email: "jordan.rivers@example.com" });
  expect(getUser(PHONE)).toMatchObject({ first_name: "Jordan", last_name: "Rivers", email: "jordan.rivers@example.com", status: "pending" });
  expect(sent[0]!.text).toMatch(/^Hi Jordan, I'm Pallas\./);
});

test("an already-enrolled number is not changed on Photon (no create call), but our row still gets the name", async () => {
  const api = fakeApi({ users: [{ id: "old", phoneNumber: PHONE, assignedPhoneNumber: ASSIGNED }] });
  const { code } = createInvite(OWNER);
  const h = makeWebHandler({ send: async () => true, photon: mk(api), ownerKey: OWNER, publicUrl: "https://bot.example.com" });
  await post(h, code, "(919) 555-0142");
  expect(api.calls.some((c) => c.method === "POST")).toBe(false);
  expect(getUser(PHONE)).toMatchObject({ first_name: "Jordan", photon_user_id: "old" });
});

test("/users shows names; people added in the dashboard have none until they /name", async () => {
  const h = await harness();
  await addMember(ALICE);
  await h.say("/users", OWNER);
  expect(h.lastTo(OWNER)).toBe(`${OWNER} owner active\n${ALICE} member active`); // untouched: no names invented
  await h.say("/name Priya Raman-Iyer", ALICE);
  await h.say("/name Mary Ann Smith", OWNER);
  await h.say("/users", OWNER);
  expect(h.lastTo(OWNER)).toBe(`Mary Ann Smith ${OWNER} owner active\nPriya Raman-Iyer ${ALICE} member active`);
});

test("/name: one word sets the first name, two set first and last, three or more split after the first word", async () => {
  const h = await harness();
  await addMember(ALICE);
  const name = () => [getUser(ALICE)?.first_name, getUser(ALICE)?.last_name];
  await h.say("/name Aarav", ALICE);
  expect(h.lastTo(ALICE)).toBe("Got it, I'll call you Aarav.");
  expect(name()).toEqual(["Aarav", null]);
  await h.say("/name Aarav Parakh", ALICE);
  expect(h.lastTo(ALICE)).toBe("Got it, I'll call you Aarav.");
  expect(name()).toEqual(["Aarav", "Parakh"]);
  await h.say("/name Mary Jane Smith", ALICE);
  expect(h.lastTo(ALICE)).toBe("Got it, I'll call you Mary.");
  expect(name()).toEqual(["Mary", "Jane Smith"]);
  await h.say("/name Mary Ann Van Der Berg", ALICE);
  expect(name()).toEqual(["Mary", "Ann Van Der Berg"]);
  await h.say("/name   Zoë   O'Neil-Park  ", ALICE); // extra spaces are fine
  expect(name()).toEqual(["Zoë", "O'Neil-Park"]);
  await h.say("/name Sam", ALICE); // a lone first name keeps the saved last name
  expect(name()).toEqual(["Sam", "O'Neil-Park"]);
  await h.say("/NAME priya", ALICE); // the command is case-insensitive
  expect(name()).toEqual(["priya", "O'Neil-Park"]);
});

test("/name with no argument shows what's saved", async () => {
  const h = await harness();
  await addMember(ALICE);
  await h.say("/name", ALICE);
  expect(h.lastTo(ALICE)).toBe("I don't have a name for you yet. Tell me what to call you: /name First Last");
  await h.say("/name Aarav Parakh", ALICE);
  await h.say("/name", ALICE);
  expect(h.lastTo(ALICE)).toBe("I have you as Aarav Parakh. Change it with /name First Last.");
  await h.say("/name Sam", OWNER);
  await h.say("/name", OWNER);
  expect(h.lastTo(OWNER)).toBe("I have you as Sam. Change it with /name First Last.");
});

test("/name rejects bad input and changes nothing", async () => {
  const h = await harness();
  await addMember(ALICE);
  await h.say("/name Aarav Parakh", ALICE);
  await h.say("/name R2D2 Droid", ALICE);
  expect(h.lastTo(ALICE)).toBe("First name can only use letters, spaces, hyphens and apostrophes. Try: /name First Last");
  await h.say("/name Sam K9", ALICE);
  expect(h.lastTo(ALICE)).toContain("Last name can only use letters");
  await h.say(`/name ${"a".repeat(51)}`, ALICE);
  expect(h.lastTo(ALICE)).toContain("at most 50 characters");
  expect(getUser(ALICE)).toMatchObject({ first_name: "Aarav", last_name: "Parakh" });
});

test("/name is Pallas-only: it never calls Photon (its API has no update-user call)", async () => {
  const h = await harness();
  await addMember(ALICE);
  const calls: string[] = [];
  h.deps.unenroll = async (k) => (calls.push(k), true);
  await h.say("/name Aarav Parakh", ALICE);
  expect(calls).toEqual([]);
});

test("Pallas greets by first name in the morning brief and the system prompt (only when it knows it)", async () => {
  const dep = { now: () => new Date("2026-10-19T11:00:00Z"), courses: async () => [], assignments: async () => [], announcements: async () => [], missing: async () => [], events: async () => null, summarize: async (t: string) => t };
  const out: string[] = [];
  await runBrief(OWNER, dep as any, async (_k, t) => (out.push(t), true));
  expect(out[0]).toMatch(/^Good morning! Pallas here\./);
  const { setProfile } = await import("../src/db.ts");
  setProfile(OWNER, { firstName: "Jordan", lastName: "Rivers" });
  await runBrief(OWNER, dep as any, async (_k, t) => (out.push(t), true), { force: true });
  expect(out[1]).toMatch(/^Good morning, Jordan! Pallas here\./);
  const ctx = { key: OWNER, role: "owner" as const, timezone: "America/New_York", canvasUrl: "https://x.example", canvasToken: "t" };
  expect(runWithContext(ctx, () => buildSystemPrompt(OWNER))).toContain("The user's first name is Jordan.");
  setProfile(OWNER, { firstName: "", lastName: "" });
  expect(runWithContext(ctx, () => buildSystemPrompt("someone-else"))).not.toContain("first name is");
});

test("/disconnect and /remove delete name and email from our DB along with the Photon user", async () => {
  const h = await harness();
  const calls: string[] = [];
  h.deps.unenroll = async (key, id) => (calls.push(`${key}|${id}`), true);
  const { code } = createInvite(OWNER);
  await post(handle(), code, "(919) 555-0142", "198.51.100.5");
  expect(getUser(PHONE)?.email).toBe("jordan.rivers@example.com");
  await h.say(`/remove ${PHONE}`, OWNER);
  expect(getUser(PHONE)).toMatchObject({ status: "removed", first_name: null, last_name: null, email: null, photon_user_id: null });
  expect(calls).toEqual([`${PHONE}|photon-1`]);
  // self-service
  const again = createInvite(OWNER).code;
  await post(handle(), again, "(919) 555-0142", "198.51.100.6");
  expect(getUser(PHONE)?.first_name).toBe("Jordan");
  await h.say("/disconnect", PHONE);
  expect(getUser(PHONE)).toMatchObject({ first_name: null, last_name: null, email: null });
  expect(calls).toHaveLength(2);
});

test("logs never contain an email or a full phone number", async () => {
  const lines: string[] = [];
  const keep = { log: console.log, error: console.error, warn: console.warn };
  const grab = (...a: unknown[]) => void lines.push(a.map(String).join(" "));
  console.log = grab; console.error = grab; console.warn = grab;
  try {
    const { code } = createInvite(OWNER);
    result = { ok: false, reason: "error", message: "photon create user failed (500 INTERNAL)" };
    await post(handle(), code, "(919) 555-0142", "198.51.100.7"); // refused
    result = { ok: true, id: "photon-1", assignedNumber: ASSIGNED, existing: false };
    await post(handle(), code, "(919) 555-0142", "198.51.100.8"); // enrolled
    const h = await harness();
    await h.say(`/remove ${PHONE}`, OWNER);
    await h.say("/disconnect", PHONE);
    await h.say("what's due", PHONE);
  } finally {
    Object.assign(console, keep);
  }
  const all = lines.join("\n");
  expect(all).toContain("join:"); // we did log something
  expect(all).not.toMatch(/jordan\.rivers|@example\.com/i);
  expect(all).not.toContain("9195550142");
  expect(all).not.toContain(PHONE);
  expect(all).not.toContain(ASSIGNED);
  expect(all).toContain(maskId(PHONE));
});

test("maskId", () => {
  expect(maskId("+12625559594")).toBe("+1262•••9594");
  expect(maskId("+19195550142")).toBe("+1919•••0142");
  expect(maskId("9195550142")).toBe("9195•••0142");
  expect(maskId("someone@example.com")).toBe("s•••@•••");
  expect(maskId("terminal")).toBe("te•••");
  expect(maskId("")).toBe("");
  expect(maskId(undefined)).toBe("");
});

// ---------- /name mirrors onto the person's OWN Photon record ----------

const ownRecord = (phone: string, id = "mine") => ({ id, phoneNumber: phone, assignedPhoneNumber: ASSIGNED });
const renameApi = (users: any[], id = "mine") =>
  fakeApi({ users, create: { status: 200, json: { succeed: true, data: { id, type: "shared", phoneNumber: PHONE, assignedPhoneNumber: ASSIGNED } } } });
const posts = (api: ReturnType<typeof fakeApi>) => api.calls.filter((c) => c.method === "POST");

test("rename: re-posts only the caller's own number with their name (Spectrum has no update call; this is its documented upsert)", async () => {
  const api = renameApi([...fill(3), ownRecord(PHONE)]);
  expect(await mk(api).rename(PHONE, { firstName: "Aarav", lastName: "Parakh" })).toBe("updated");
  expect(posts(api)).toHaveLength(1);
  expect(posts(api)[0]!.body).toEqual({ type: "shared", phoneNumber: PHONE, firstName: "Aarav", lastName: "Parakh" }); // no email: left as it was
  expect(posts(api)[0]!.auth).toBe(BASIC);
  expect(api.calls.some((c) => c.method === "DELETE")).toBe(false);
});

test("rename: a first name alone leaves the last name out of the call (so Photon keeps it)", async () => {
  const api = renameApi([ownRecord(PHONE)]);
  await mk(api).rename(PHONE, { firstName: "Aarav", lastName: null });
  expect(posts(api)[0]!.body).toEqual({ type: "shared", phoneNumber: PHONE, firstName: "Aarav" });
});

test("rename never creates anyone: not enrolled means no call, and failures are reported", async () => {
  const none = renameApi(fill(4));
  expect(await mk(none).rename(PHONE, { firstName: "Aarav" })).toBe("not-enrolled");
  expect(posts(none)).toHaveLength(0);
  expect(await mk(renameApi([ownRecord(PHONE, "mine")], "someone-else")).rename(PHONE, { firstName: "Aarav" })).toBe("failed"); // Photon answered about a different user
  expect(await mk(fakeApi({ users: [ownRecord(PHONE)], create: { status: 500, json: { succeed: false, data: null, code: "X", message: "y" } } })).rename(PHONE, { firstName: "Aarav" })).toBe("failed");
  expect(await mk(fakeApi({ listStatus: 500 })).rename(PHONE, { firstName: "Aarav" })).toBe("failed");
});

test("/name from the app: updates the sender's own Photon record only; others are never touched", async () => {
  const h = await harness();
  await addMember(ALICE);
  const others = [ownRecord("+19195550100", "owner-rec"), ownRecord("+19195550102", "bob-rec")];
  const api = renameApi([...others, ownRecord(ALICE, "alice-rec")], "alice-rec");
  const photonLive = mk(api);
  const asked: string[] = [];
  h.deps.renamePhoton = async (key, name) => (asked.push(key), photonLive.rename(key, name));
  await h.say("/name Aarav Parakh", ALICE);
  expect(h.lastTo(ALICE)).toBe("Got it, I'll call you Aarav.");
  expect(asked).toEqual([ALICE]);
  expect(posts(api)).toHaveLength(1);
  expect(posts(api)[0]!.body).toEqual({ type: "shared", phoneNumber: ALICE, firstName: "Aarav", lastName: "Parakh" });
  expect(JSON.stringify(api.calls)).not.toContain("+19195550102");
  expect(getUser(ALICE)).toMatchObject({ first_name: "Aarav", last_name: "Parakh" });
  // the owner running it changes the owner's own record, not Alice's
  await h.say("/name Sam", OWNER);
  expect(asked).toEqual([ALICE, OWNER]);
  expect(posts(api)[1]!.body).toMatchObject({ phoneNumber: OWNER, firstName: "Sam" });
});

test("/name can't be aimed at someone else's number, and bad input never reaches Photon", async () => {
  const h = await harness();
  await addMember(ALICE);
  const asked: string[] = [];
  h.deps.renamePhoton = async (key) => (asked.push(key), "updated");
  await h.say("/name +19195550102 Sam", ALICE); // a phone number isn't a name
  expect(h.lastTo(ALICE)).toContain("First name can only use letters");
  await h.say("/name Sam K9", ALICE);
  await h.say("/name", ALICE);
  expect(asked).toEqual([]);
});

test("/name for someone who isn't on Photon stays Pallas-only with the normal reply; a Photon failure is said honestly", async () => {
  const h = await harness();
  await addMember(ALICE);
  let outcome: "updated" | "not-enrolled" | "failed" = "not-enrolled";
  h.deps.renamePhoton = async () => outcome;
  await h.say("/name Aarav", ALICE);
  expect(h.lastTo(ALICE)).toBe("Got it, I'll call you Aarav.");
  outcome = "failed";
  await h.say("/name Priya", ALICE);
  expect(h.lastTo(ALICE)).toBe("Got it, I'll call you Priya. (Saved here, but I couldn't update your Photon profile just now.)");
  expect(getUser(ALICE)?.first_name).toBe("Priya");
});

// ---------- the first text: retried, and answered when they text first ----------

import { listPendingWelcomes, saveCanvasCredentials } from "../src/db.ts";
import { WELCOME_MAX_TRIES, WELCOME_RETRY_EVERY_MS, retryWelcomes, trySendWelcome, welcomeText } from "../src/welcome.ts";
import { makeOutbound } from "../src/outbound.ts";
import { maskText } from "../src/mask.ts";

const WCTX = { publicUrl: "https://bot.example.com", inviterName: "Sam" };

test("handler: a newly enrolled person's first text gets the welcome and their connect link, once", async () => {
  const h = await harness();
  createPendingUser(ALICE);
  setPhotonUser(ALICE, "photon-5", ASSIGNED);
  const { setProfile } = await import("../src/db.ts");
  setProfile(ALICE, { firstName: "Aarav", lastName: "Parakh" });
  h.deps.inviterName = "Sam";
  await h.say("hi", ALICE);
  const first = h.lastTo(ALICE)!;
  const m = first.match(/^Hi Aarav, I'm Pallas\. Sam invited you\. Connect your Canvas here: (https:\/\/bot\.example\.com\/connect\/([\w-]{43}))\nTap the card above to save Pallas to your contacts\.$/);
  expect(m).not.toBeNull();
  expect(peekConnectLink(m![2]!)).toBe(ALICE);
  expect(getUser(ALICE)?.welcomed).toBe(1);
  await h.say("hello?", ALICE); // already welcomed: the usual reminder, with a fresh link
  expect(h.lastTo(ALICE)).toContain("You're almost set.");
  expect(h.lastTo(ALICE)).not.toContain("invited you");
  expect(h.agentCalls()).toBe(0);
});

test("handler: someone already welcomed (the text went through) isn't welcomed again on their first text", async () => {
  const h = await harness();
  createPendingUser(ALICE);
  (await import("../src/db.ts")).setWelcomed(ALICE);
  await h.say("hi", ALICE);
  expect(h.lastTo(ALICE)).toContain("You're almost set.");
});

test("the 'join CODE' text path marks them welcomed (its reply is the welcome)", async () => {
  const h = await harness();
  await h.say("/invite", OWNER);
  const c = h.lastTo(OWNER)!.match(/\/join\/([A-Z0-9]{6})/)![1]!;
  await h.say(`join ${c}`, ALICE);
  expect(getUser(ALICE)).toMatchObject({ status: "pending", welcomed: 1 });
  await h.say("hi", ALICE);
  expect(h.lastTo(ALICE)).toContain("You're almost set.");
});

test("no welcome retries: one attempt at sign-up (it delivers if the plan allows it), then nothing until they text first", async () => {
  expect(WELCOME_MAX_TRIES).toBe(1);
  createPendingUser(ALICE);
  let t = 1_000_000;
  const attempts: string[] = [];
  const send = async (k: string, text: string) => (attempts.push(`${k}|${text.slice(0, 8)}`), false);
  expect(await trySendWelcome(ALICE, WCTX, send, t)).toBe(false); // the sign-up attempt, refused like on the shared plan
  expect(getUser(ALICE)).toMatchObject({ welcome_tries: 1, welcomed: 0 });
  for (let i = 0; i < 12; i++) { t += WELCOME_RETRY_EVERY_MS; expect(await retryWelcomes(WCTX, send, t)).toBe(0); }
  expect(attempts).toHaveLength(1); // never retried
  expect(listPendingWelcomes(t + 1e9, WELCOME_MAX_TRIES)).toEqual([]);
  // if the plan lets Pallas message first, that one attempt is the delivery
  createPendingUser(ALICE);
  expect(await trySendWelcome(ALICE, WCTX, async () => true, t)).toBe(true);
  expect(getUser(ALICE)?.welcomed).toBe(1);
});

test("welcomeText uses their first name, the inviter, and a fresh one-use link each time", () => {
  createPendingUser(ALICE);
  const a = welcomeText(ALICE, WCTX), b = welcomeText(ALICE, WCTX);
  expect(a).toMatch(/^Hi, I'm Pallas\. Sam invited you\. Connect your Canvas here: https:\/\/bot\.example\.com\/connect\//);
  const ta = a.match(/connect\/([\w-]{43})/)![1]!, tb = b.match(/connect\/([\w-]{43})/)![1]!;
  expect(ta).not.toBe(tb);
  expect(peekConnectLink(ta)).toBeNull(); // the older link was replaced
  expect(peekConnectLink(tb)).toBe(ALICE);
});

test("a failed send logs the real error with the phone number masked, and reports failure", async () => {
  const lines: string[] = [];
  const keep = { error: console.error, log: console.log };
  console.error = (...a: unknown[]) => void lines.push(a.map(String).join(" "));
  console.log = () => {};
  const out = makeOutbound({
    provider: "cloud", app: {},
    platform: () => ({ space: { get: async () => ({}), create: async (key: string) => { throw new Error(`[spectrum-imessage] Target not allowed for this project (${key})`); } } }),
  });
  let ok: boolean;
  try {
    createPendingUser(ALICE);
    ok = await out.send(ALICE, "hello", "notify");
  } finally {
    Object.assign(console, keep);
  }
  expect(ok).toBe(false);
  const text = lines.join("\n");
  expect(text).toContain("Target not allowed for this project"); // the real error, not a generic one
  expect(text).not.toContain(ALICE);
  expect(text).toContain(maskId(ALICE));
  expect(maskText("fail +19195550142 or a@example.com, call (919) 555-0142")).toBe("fail +1919•••0142 or a•••@•••, call (9195•••0142");
});
