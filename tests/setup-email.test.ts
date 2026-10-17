import { beforeEach, expect, spyOn, test } from "bun:test";
import { createInvite, ensureOwner, initDb } from "../src/db.ts";
import { resendFromEnv, setupEmailContent, type SendSetupEmail, type SetupEmail } from "../src/email.ts";
import { makeWebHandler } from "../src/web.ts";
import type { Photon } from "../src/photon.ts";
import { OWNER } from "./helpers.ts";

// Mocks only: no network, no real Resend, no real Photon.
const ASSIGNED = "+16285550199", EMAIL = "jordan.rivers@example.com";
const BASE = "https://bot.example.com";

const photon = (assigned: string | null): Photon => ({ limit: 10, count: async () => 1, enroll: async () => ({ ok: true, id: "p1", assignedNumber: assigned, existing: false }), remove: async () => true, rename: async () => "updated" });
const join = (h: ReturnType<typeof makeWebHandler>, code: string, ip = "203.0.113.7") =>
  h(new Request(`${BASE}/join/${code}`, { method: "POST", body: new URLSearchParams({ first: "Jordan", last: "Rivers", email: EMAIL, phone: "(919) 555-0142" }), headers: { "x-real-ip": ip } }));
const handler = (assigned: string | null, email: SendSetupEmail | null | undefined) =>
  makeWebHandler({ send: async () => false, photon: photon(assigned), ownerKey: OWNER, publicUrl: BASE, sendSetupEmail: email });

beforeEach(() => {
  initDb(":memory:");
  ensureOwner(OWNER);
});

test("right after sign-up: one setup email with their number, the same sms: link and their address, and nothing else", async () => {
  const sent: SetupEmail[] = [];
  const res = await join(handler(ASSIGNED, async (m) => (sent.push(m), true)), createInvite(OWNER).code);
  expect(res.status).toBe(200);
  expect(sent).toEqual([{ to: EMAIL, firstName: "Jordan", number: "+1 (628) 555-0199", smsHref: `sms:${ASSIGNED}&body=hi`, botName: "Pallas" }]);
});

test("no setup email without an assigned number, or without a sender (no RESEND_API_KEY): sign-up still works", async () => {
  const sent: SetupEmail[] = [];
  const mock: SendSetupEmail = async (m) => (sent.push(m), true);
  expect((await join(handler(null, mock), createInvite(OWNER).code)).status).toBe(200);
  expect((await join(handler(ASSIGNED, null), createInvite(OWNER).code, "203.0.113.8")).status).toBe(200);
  const prev = process.env.RESEND_API_KEY;
  delete process.env.RESEND_API_KEY;
  expect((await join(handler(ASSIGNED, undefined), createInvite(OWNER).code, "203.0.113.9")).status).toBe(200); // falls back to the environment: no key, no email
  if (prev !== undefined) process.env.RESEND_API_KEY = prev;
  expect(sent).toEqual([]);
  expect(resendFromEnv({} as any)).toBeNull();
  expect(resendFromEnv({ RESEND_API_KEY: "  " } as any)).toBeNull();
});

test("a failing or throwing email send never breaks sign-up, and the address is never logged", async () => {
  const logs: string[] = [];
  const grab = (...x: unknown[]) => void logs.push(x.map(String).join(" "));
  const log = spyOn(console, "log").mockImplementation(grab), err = spyOn(console, "error").mockImplementation(grab), warn = spyOn(console, "warn").mockImplementation(grab);
  const res = await join(handler(ASSIGNED, async () => false), createInvite(OWNER).code);
  log.mockRestore(); err.mockRestore(); warn.mockRestore();
  expect(res.status).toBe(200);
  expect(logs.join("\n")).toContain("setup email for");
  expect(logs.join("\n")).not.toContain(EMAIL);
  expect(logs.join("\n")).not.toContain("919555");
});

test("Resend: one POST with the bearer key to the person only; a failure logs just the status", async () => {
  const calls: { url: string; init: any }[] = [];
  const mk = (status: number, body = "{}") => (async (url: string, init: any) => (calls.push({ url, init }), new Response(body, { status }))) as unknown as typeof fetch;
  const msg: SetupEmail = { to: EMAIL, firstName: "Jordan", number: "+1 (628) 555-0199", smsHref: `sms:${ASSIGNED}&body=hi`, botName: "Pallas" };
  const send = resendFromEnv({ RESEND_API_KEY: "re_test_dummy", EMAIL_FROM: "Pallas <hello@example.com>" } as any, mk(200))!;
  expect(await send(msg)).toBe(true);
  expect(calls).toHaveLength(1);
  expect(calls[0]!.url).toBe("https://api.resend.com/emails");
  expect(calls[0]!.init.headers.Authorization).toBe("Bearer re_test_dummy");
  const body = JSON.parse(calls[0]!.init.body);
  expect(body.to).toEqual([EMAIL]); // one recipient, no cc/bcc, no list
  expect(body).not.toHaveProperty("cc");
  expect(body).not.toHaveProperty("bcc");
  expect(body.from).toBe("Pallas <hello@example.com>");
  expect(body.subject).toBe("Text Pallas to get started");
  const logs: string[] = [];
  const err = spyOn(console, "error").mockImplementation((...x: unknown[]) => void logs.push(x.map(String).join(" ")));
  expect(await resendFromEnv({ RESEND_API_KEY: "re_test_dummy" } as any, mk(422, `{"message":"invalid to ${EMAIL}"}`))!(msg)).toBe(false);
  expect(await resendFromEnv({ RESEND_API_KEY: "re_test_dummy" } as any, (async () => { throw new Error(`boom ${EMAIL}`); }) as unknown as typeof fetch)!(msg)).toBe(false);
  err.mockRestore();
  expect(logs).toEqual(["setup email failed (422)", "setup email failed (Error)"]);
});

test("the email is for setup only: number, sms link, the way to start; escaped; no marketing, no unsubscribe-list talk", () => {
  const c = setupEmailContent({ to: EMAIL, firstName: "<b>Jo</b>", number: "+1 (628) 555-0199", smsHref: `sms:${ASSIGNED}&body=hi`, botName: "Pallas" });
  expect(c.text).toContain("Text Pallas at +1 (628) 555-0199 to get started");
  expect(c.text).toContain(`sms:${ASSIGNED}&body=hi`);
  expect(c.html).toContain(`href="sms:${ASSIGNED}&amp;body=hi"`);
  expect(c.html).not.toContain("<b>Jo</b>");
  expect(c.text).toContain("only for account setup");
  expect(c.text).not.toMatch(/newsletter|promo|offer|discount/i);
});

test("a test can never email for real: the env sender is off under NODE_ENV=test", () => {
  expect(process.env.NODE_ENV).toBe("test");
  expect(resendFromEnv({ RESEND_API_KEY: "re_live_looking_key" } as any)).toBeNull();
});

test("the join form says they'll text Pallas 'hi' after signing up, and the button is 'Get started'", async () => {
  const res = await handler(ASSIGNED, null)(new Request(`${BASE}/join/${createInvite(OWNER).code}`));
  const html = await res.text();
  expect(html).toContain("After you sign up, you&#39;ll text Pallas &#39;hi&#39; to get started.".replace(/&#39;/g, "'"));
  expect(html).not.toMatch(/text you first/i);
  expect(html).toContain('<button type="submit">Get started</button>');
  expect(html).not.toContain("Text me");
});
