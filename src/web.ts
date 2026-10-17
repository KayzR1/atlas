import { botName } from "./brand.ts";
import { maskId } from "./mask.ts";
import { trySendWelcome } from "./welcome.ts";
import { parseEmail, parseName } from "./profile.ts";
import { encrypt, randomToken, sha256Hex } from "./crypto.ts";
import { resendFromEnv, type SendSetupEmail } from "./email.ts";
import { buildVcard, contactPath, CONTACT_FILENAME, isE164 } from "./contact.ts";
import { consumeConnectLink, createPendingUser, getUser, markNotified, peekConnectLink, peekContactLink, peekInvite, redeemInvite, saveCanvasCredentials, setPhotonUser, setProfile, wasNotified } from "./db.ts";
import type { Photon } from "./photon.ts";
import type { Send } from "./outbound.ts";
import { allowedCanvasHosts, normalizeCanvasUrl } from "./users.ts";

const TOKEN_RE = /^[A-Za-z0-9_-]{43}$/;
const MAX_FAILED_TRIES = 5;

export const escapeHtml = (s: string) =>
  s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;");

/** Ask Canvas who this token belongs to. No redirects are followed and nothing is logged. */
export async function validateCanvasToken(canvasUrl: string, token: string): Promise<boolean> {
  try {
    const res = await fetch(`${canvasUrl}/api/v1/users/self`, {
      headers: { Authorization: `Bearer ${token}` },
      redirect: "error",
      signal: AbortSignal.timeout(10_000),
    });
    return res.ok;
  } catch {
    return false;
  }
}

type WebDeps = {
  send: Send;
  validate?: (canvasUrl: string, token: string) => Promise<boolean>;
  hosts?: string[];
  /** Enrolls numbers on the shared Photon plan (null/absent: not a Photon deployment, so enrollment is skipped). */
  photon?: Photon | null;
  /** Who gets "Invite failed" alerts, and how the first text names whoever invited. */
  ownerKey?: string;
  inviterName?: string;
  publicUrl?: string;
  now?: () => number;
  /** The one account-setup email after sign-up. Absent: Resend from RESEND_API_KEY, or nothing if that isn't set. */
  sendSetupEmail?: SendSetupEmail | null;
};

// ---- the join page: a phone number in, Photon enrollment, and Pallas texts first ----

const JOIN_CODE_RE = /^[A-Za-z0-9-]{4,12}$/;
const JOIN_IP_LIMIT = 10, JOIN_CODE_LIMIT = 5, JOIN_WINDOW_MS = 3600_000;

/** A US number typed any way ("(919) 555-0123", "+1 919 555 0123", "19195550123") -> "+19195550123", or null. */
export function parseUsMobile(input: string): string | null {
  const t = input.trim();
  if (/^\+/.test(t) && !/^\+\s*1/.test(t)) return null; // some other country
  let d = t.replace(/\D/g, "");
  if (d.length === 11 && d.startsWith("1")) d = d.slice(1);
  if (!/^[2-9]\d{2}[2-9]\d{6}$/.test(d)) return null;
  const area = d.slice(0, 3), exch = d.slice(3, 6);
  if (/^[2-9]11$/.test(area) || /^[2-9]11$/.test(exch)) return null; // 211, 911 and friends
  if (/^(800|833|844|855|866|877|888|900)$/.test(area)) return null; // toll-free and premium: never a mobile
  return `+1${d}`;
}

export const prettyNumber = (e164: string): string => {
  const m = e164.match(/^\+1(\d{3})(\d{3})(\d{4})$/);
  return m ? `+1 (${m[1]}) ${m[2]}-${m[3]}` : e164;
};

/** Sliding-window counter, in memory (a restart clears it, which only ever loosens a limit briefly). */
class Hits {
  private m = new Map<string, number[]>();
  constructor(private max: number, private windowMs: number) {}
  /** Records an attempt; false if this one is over the limit. */
  take(key: string, now: number): boolean {
    const recent = (this.m.get(key) ?? []).filter((t) => t > now - this.windowMs);
    if (recent.length >= this.max) {
      this.m.set(key, recent);
      return false;
    }
    recent.push(now);
    this.m.set(key, recent);
    if (this.m.size > 5000) for (const [k, v] of this.m) if (!v.some((t) => t > now - this.windowMs)) this.m.delete(k);
    return true;
  }
}

/** Behind Railway's proxy the client is the last address it appended; a client-supplied first hop can't be trusted. */
function clientIp(req: Request): string {
  const real = req.headers.get("x-real-ip");
  if (real) return real.trim();
  const xff = req.headers.get("x-forwarded-for");
  return xff ? xff.split(",").at(-1)!.trim() : "unknown";
}

// the owl is inlined; fonts come from Google Fonts only
const FONTS = "https://fonts.googleapis.com/css2?family=Bricolage+Grotesque:opsz,wght@12..96,600;12..96,700&family=Figtree:wght@400;600&display=swap";
const VIDEO_ID = "cZ5cn8stjM0";
const VIDEO_LABEL = "Watch: how to get your Canvas token";
// click-to-load: the page shows a thumbnail only; the iframe lives in an inert <template> until the click swaps it in
const VIDEO = `<p class="vlabel">${VIDEO_LABEL}</p>
<div class="video" id="yt"><a href="https://www.youtube.com/watch?v=${VIDEO_ID}" target="_blank" rel="noopener noreferrer" aria-label="Play video: how to get your Canvas token"><img src="https://i.ytimg.com/vi/${VIDEO_ID}/hqdefault.jpg" alt="" width="480" height="360"><svg class="play" viewBox="0 0 68 48" width="68" height="48" aria-hidden="true"><rect width="68" height="48" rx="12" fill="#1d2156" fill-opacity=".92"/><path d="M27 14l18 10-18 10z" fill="#fff"/></svg></a></div>
<template id="yt-frame"><iframe src="https://www.youtube-nocookie.com/embed/${VIDEO_ID}?autoplay=1&amp;rel=0" title="${VIDEO_LABEL}" allow="autoplay; encrypted-media; picture-in-picture" allowfullscreen loading="lazy" referrerpolicy="strict-origin-when-cross-origin"></iframe></template>`;
const VIDEO_SCRIPT = `document.querySelector("#yt a").addEventListener("click",function(e){e.preventDefault();document.getElementById("yt").replaceChildren(document.getElementById("yt-frame").content.cloneNode(true))});`;

// Pallas's owl: two eyes with pupils and a beak, 100x100. Colors come from the page's CSS variables, so it follows light and dark.
const MARK = `<svg class="owl" xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100" width="56" height="56" role="img" aria-label="Pallas"><circle class="eye" cx="35" cy="43" r="15"/><circle class="eye" cx="65" cy="43" r="15"/><circle class="pupil" cx="37" cy="44" r="6"/><circle class="pupil" cx="67" cy="44" r="6"/><path class="beak" d="M50 57 L55 64 L50 72 L45 64 Z"/></svg>`;

function page(status: number, title: string, body: string, script?: string): Response {
  const nonce = randomToken().slice(0, 22);
  const html = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex"><title>${escapeHtml(title)}</title><link rel="stylesheet" href="${FONTS}"><style nonce="${nonce}">
:root{--paper:#f7f6f1;--card:#ffffff;--edge:#e4e2d6;--ink:#15173a;--muted:#575a78;--brand:#1d2156;--btn-ink:#ffffff;--line:#8a8ca6;--focus:#1d2156;--field:#ffffff;--due:#b45309;--err:#b42318}
@media(prefers-color-scheme:dark){:root{--paper:#0e1030;--card:#171a45;--edge:#2b2f6b;--ink:#eeecf7;--muted:#aeb0cc;--brand:#f2b33d;--btn-ink:#1d2156;--line:#6d72b5;--focus:#f2b33d;--field:#0e1030;--due:#fdba74;--err:#ff8a7a}}
*{box-sizing:border-box}
body{margin:0;padding:2rem 1rem;font:16px/1.55 Figtree,-apple-system,system-ui,sans-serif;color:var(--ink);background:var(--paper)}
.card{max-width:30rem;margin:0 auto;padding:1.75rem 1.5rem;background:var(--card);border:1px solid var(--edge);border-radius:12px}
.mark{display:block;margin:0 0 1rem}.mark svg{display:block}.owl .eye,.owl .beak{fill:var(--brand)}.owl .pupil{fill:var(--card)}
h1{font:700 1.6rem/1.2 "Bricolage Grotesque",Figtree,system-ui,sans-serif;margin:0 0 1rem;letter-spacing:-.01em}
label{display:block;margin:1rem 0 .25rem;font-weight:600}
input{width:100%;padding:.65rem .75rem;font:inherit;color:var(--ink);background:var(--field);border:1px solid var(--line);border-radius:8px}
input:focus{outline:2px solid var(--focus);outline-offset:1px}
h2{font:700 1.15rem/1.3 "Bricolage Grotesque",Figtree,system-ui,sans-serif;margin:1.5rem 0 .5rem}
.actions{display:flex;flex-wrap:wrap;gap:.75rem;margin-top:1rem}.actions a.btn{flex:1 1 11rem;margin-top:0}.actions a.btn.big{flex-basis:100%;padding:1.1rem 1.2rem;font-size:1.2rem}a.btn.alt{background:transparent;color:var(--ink);border:1px solid var(--line)}
a.btn{display:block;margin-top:1rem;padding:.75rem 1.2rem;text-align:center;font:600 1rem Figtree,system-ui,sans-serif;text-decoration:none;border-radius:8px;background:var(--brand);color:var(--btn-ink)}
button{margin-top:1.25rem;width:100%;padding:.75rem 1.2rem;font:600 1rem Figtree,system-ui,sans-serif;border:0;border-radius:8px;background:var(--brand);color:var(--btn-ink);cursor:pointer}
button:hover{filter:brightness(1.15)}
.vlabel{margin:1.25rem 0 .5rem;font-weight:600}
.video{position:relative;aspect-ratio:16/9;border-radius:12px;overflow:hidden;background:#000}
.video a{display:block;width:100%;height:100%}.video img{width:100%;height:100%;object-fit:cover;display:block}
.video .play{position:absolute;top:50%;left:50%;transform:translate(-50%,-50%)}
.video iframe{position:absolute;inset:0;width:100%;height:100%;border:0}
.err{color:var(--err);font-weight:600}.err.field{margin:.25rem 0 0;font-size:.9rem}input[aria-invalid=true]{border-color:var(--err)}.muted{color:var(--muted);font-size:.9rem}ol{padding-left:1.2rem}
</style></head><body><main class="card"><span class="mark">${MARK}</span>${body}</main>${script ? `<script nonce="${nonce}">${script}</script>` : ""}</body></html>`;
  return new Response(html, {
    status,
    headers: {
      "Content-Type": "text/html; charset=utf-8",
      "Cache-Control": "no-store",
      "Referrer-Policy": "no-referrer",
      "X-Content-Type-Options": "nosniff",
      "X-Frame-Options": "DENY",
      "Content-Security-Policy": `default-src 'none'; ${script ? `script-src 'nonce-${nonce}'; ` : ""}style-src 'nonce-${nonce}' https://fonts.googleapis.com; font-src https://fonts.gstatic.com; img-src https://i.ytimg.com; frame-src https://www.youtube-nocookie.com; form-action 'self'; base-uri 'none'; frame-ancestors 'none'`,
    },
  });
}

const gone = () =>
  page(410, "Link expired", `<h1>This link has expired or was already used</h1><p>Text the bot any message to get a fresh link.</p>`);

/** The sms: link that opens Messages to Pallas with "hi" typed. The connect token is never part of it (or of this page). */
export const smsHref = (assigned: string) => `sms:${assigned}&body=hi`;

function joinDone(welcomed: boolean, assigned: string | null, card: string | null = null): Response {
  const name = escapeHtml(botName());
  const ok = assigned && /^\+\d{7,15}$/.test(assigned) ? assigned : null;
  const lead = welcomed
    ? `<h1>Check your texts</h1><p>${name} just messaged you${ok ? ` from ${escapeHtml(prettyNumber(ok))}` : ""}. Open the link in that message to connect your Canvas.</p>`
    : ok
      ? `<h1>One last step: text ${name} 'hi'</h1><p>Send 'hi' to <b>${escapeHtml(prettyNumber(ok))}</b>. ${name} will reply with your private link to connect Canvas.</p>`
      : `<h1>You're in</h1><p>Text ${name} 'hi' to get started. ${name} will reply with your private link to connect Canvas.</p>`;
  const start = ok
    ? `<div class="actions"><a class="btn big" href="${escapeHtml(smsHref(ok))}">Open Messages</a>${card ? `<a class="btn alt" href="${escapeHtml(card)}">Save ${name} to Contacts</a>` : ""}</div>
<p class="muted">The big button opens Messages with "hi" already typed.${card ? ` The contact card needs Safari: in another browser (like Arc) it downloads a file instead, so open this page in Safari.` : ""} Or text <b>${escapeHtml(prettyNumber(ok))}</b> yourself.</p>`
    : "";
  return page(200, welcomed ? "Check your texts" : `Text ${botName()}`, `${lead}\n${start}`);
}

const joinGone = () =>
  page(410, "Invite expired", `<h1>This invite has expired or was already used</h1><p>Ask whoever invited you for a new one.</p>`);

type JoinFields = { first: string; last: string; email: string; phone: string };
type JoinErrors = Partial<Record<keyof JoinFields, string>>;

function joinForm(code: string, errors: JoinErrors = {}, v: Partial<JoinFields> = {}, banner?: string): Response {
  const bad = Object.keys(errors).length > 0 || !!banner;
  const field = (id: keyof JoinFields, label: string, attrs: string) =>
    `<label for="${id}">${label}</label>
<input id="${id}" name="${id}" value="${escapeHtml(v[id] ?? "")}" ${attrs} required${errors[id] ? ` aria-invalid="true" aria-describedby="${id}-err"` : ""}>
${errors[id] ? `<p class="err field" id="${id}-err">${escapeHtml(errors[id]!)}</p>` : ""}`;
  return page(
    bad ? 400 : 200,
    `Join ${botName()}`,
    `<h1>Join ${escapeHtml(botName())}</h1>
${banner ? `<p class="err">${escapeHtml(banner)}</p>` : ""}
<p>${escapeHtml(botName())} answers questions about your Canvas over iMessage. After you sign up, you'll text ${escapeHtml(botName())} 'hi' to get started.</p>
<form method="post" action="/join/${escapeHtml(code)}" autocomplete="on">
${field("first", "First name", 'type="text" autocomplete="given-name" maxlength="60"')}
${field("last", "Last name", 'type="text" autocomplete="family-name" maxlength="60"')}
${field("email", "Email", 'type="email" inputmode="email" autocomplete="email" maxlength="254"')}
${field("phone", "Mobile number", 'type="tel" inputmode="tel" autocomplete="tel" placeholder="(919) 555-0123"')}
<button type="submit">Get started</button>
</form>
<p class="muted">We use your name and email only to set up your Pallas account. We never share them. You can stop any time by texting /disconnect.</p>`,
  );
}

function form(token: string, hosts: string[], error?: string, canvasUrl?: string): Response {
  const defaultHost = canvasUrl ?? hosts[0] ?? "uncch.instructure.com";
  return page(
    error ? 400 : 200,
    "Connect your Canvas",
    `<h1>Connect your Canvas</h1>
${error ? `<p class="err">${escapeHtml(error)}</p>` : ""}
<p>To let ${escapeHtml(botName())} read your Canvas, create an access token:</p>
<ol>
<li>Open Canvas, then <b>Account</b>, then <b>Settings</b>.</li>
<li>Scroll to <b>Approved Integrations</b> and tap <b>+ New Access Token</b>.</li>
<li>Purpose: <i>canvas-bot</i>. Set an expiry if you like, then <b>Generate Token</b>.</li>
<li>Copy the token and paste it below.</li>
</ol>
${VIDEO}
<form method="post" action="/connect/${escapeHtml(token)}" autocomplete="off">
<label for="canvas_url">Canvas address</label>
<input id="canvas_url" name="canvas_url" value="${escapeHtml(defaultHost)}" required>
<label for="canvas_token">Access token</label>
<input id="canvas_token" name="canvas_token" type="password" autocomplete="off" required>
<button type="submit">Connect</button>
</form>
<p class="muted">The bot only reads your courses, assignments, grades and announcements. Your token is stored encrypted, and texting /disconnect deletes it.</p>`,
    VIDEO_SCRIPT,
  );
}

/** Build the request handler (testable without opening a port). */
export function makeWebHandler(deps: WebDeps) {
  const hosts = deps.hosts ?? allowedCanvasHosts();
  const validate = deps.validate ?? validateCanvasToken;
  const failures = new Map<string, number>();

  const ipHits = new Hits(JOIN_IP_LIMIT, JOIN_WINDOW_MS), codeHits = new Hits(JOIN_CODE_LIMIT, JOIN_WINDOW_MS);
  const clock = deps.now ?? Date.now;
  const sendSetupEmail = deps.sendSetupEmail === undefined ? resendFromEnv() : deps.sendSetupEmail;

  /** Tell the owner, at most once an hour per kind (a full plan shouldn't mean a text per page view). */
  async function alertOwner(kind: string, text: string) {
    if (!deps.ownerKey) return;
    const key = `joinalert:${kind}:${Math.floor(clock() / 3600_000)}`;
    if (wasNotified(deps.ownerKey, key)) return;
    markNotified(deps.ownerKey, key);
    await deps.send(deps.ownerKey, text, "notify");
  }

  async function join(req: Request, code: string): Promise<Response> {
    if (!JOIN_CODE_RE.test(code) || !peekInvite(code)) return joinGone();
    if (req.method === "GET") return joinForm(code);
    if (req.method !== "POST") return new Response("Method not allowed", { status: 405, headers: { Allow: "GET, POST" } });

    const now = clock();
    if (!ipHits.take(clientIp(req), now) || !codeHits.take(code.toUpperCase(), now)) {
      return page(429, "Slow down", `<h1>Too many tries</h1><p>Please wait a bit and try again.</p>`);
    }
    let fd: Awaited<ReturnType<Request["formData"]>>;
    try {
      fd = await req.formData();
    } catch {
      return joinForm(code, {}, {}, "Something went wrong with that form. Please try again.");
    }
    const get = (k: string) => String(fd.get(k) ?? "");
    const typed: JoinFields = { first: get("first").slice(0, 80), last: get("last").slice(0, 80), email: get("email").slice(0, 300), phone: get("phone").slice(0, 40) };
    const errors: JoinErrors = {};
    const first = parseName(typed.first, "First name"), last = parseName(typed.last, "Last name"), email = parseEmail(typed.email);
    const phone = parseUsMobile(typed.phone);
    if (!first.ok) errors.first = first.error;
    if (!last.ok) errors.last = last.error;
    if (!email.ok) errors.email = email.error;
    if (!phone) errors.phone = "Enter a US mobile number, like (919) 555-0123.";
    if (!first.ok || !last.ok || !email.ok || !phone) return joinForm(code, errors, typed);
    const profile = { firstName: first.value, lastName: last.value, email: email.value };

    const existing = getUser(phone);
    if (existing && (existing.status === "active" || existing.role === "owner")) {
      return page(200, "Already set up", `<h1>You're already set up</h1><p>Just text ${escapeHtml(botName())} like you normally do.</p>`);
    }

    // enroll first: if the plan is full or Photon is down, the invite is not used up
    let photonId: string | null = null, assigned: string | null = null, newlyEnrolled = false;
    if (deps.photon) {
      const r = await deps.photon.enroll(phone, profile);
      if (!r.ok) {
        console.error(`join: photon enrollment refused for ${maskId(phone)} (${r.reason}): ${r.message}`);
        if (r.reason === "full") {
          await alertOwner("full", "Invite failed: Photon user limit reached.");
          return page(503, `${botName()} is full`, `<h1>${escapeHtml(botName())} is full right now</h1><p>There isn't room for another person yet. Ask whoever invited you to try again later; your invite is still good.</p>`);
        }
        await alertOwner("error", "Invite failed: couldn't reach Photon to enroll a number.");
        return page(502, "Try again", `<h1>Couldn't set you up just now</h1><p>Please try again in a minute. Your invite is still good.</p>`);
      }
      photonId = r.id;
      assigned = r.assignedNumber;
      newlyEnrolled = !r.existing;
    }

    if (!redeemInvite(code, phone)) {
      // someone else used the code between the check and now: don't leave a number enrolled for it
      if (newlyEnrolled && deps.photon) await deps.photon.remove(photonId, phone);
      return joinGone();
    }
    createPendingUser(phone);
    setProfile(phone, profile);
    setPhotonUser(phone, photonId, assigned);
    // Pallas tries to text first. On Photon's shared plan that is refused until the person has texted the assigned number once,
    // so the page never claims it worked unless it did, and always gives them the one-tap way to start the chat.
    const sent = await trySendWelcome(phone, { publicUrl: deps.publicUrl ?? process.env.PUBLIC_URL ?? "", inviterName: deps.inviterName }, deps.send, clock());
    console.log(`join: ${maskId(phone)} enrolled${deps.photon ? " on Photon" : ""}; welcome text ${sent ? "sent" : "not delivered (it goes out as the reply to their first text)"}`);
    // the backup: one setup email with their number and the same sms: link (skipped without an assigned number or RESEND_API_KEY)
    if (isE164(assigned) && sendSetupEmail) {
      const ok = await sendSetupEmail({ to: profile.email, firstName: profile.firstName, number: prettyNumber(assigned), smsHref: smsHref(assigned), botName: botName() });
      console.log(`join: setup email for ${maskId(phone)} ${ok ? "sent" : "not sent"}`);
    }
    return joinDone(sent, assigned, isE164(assigned) ? contactPath(phone) : null);
  }

  /** The vCard. The id is the only thing in the URL; it maps to a user server-side, and neither it nor the number is logged. */
  async function contact(req: Request, id: string): Promise<Response> {
    if (req.method !== "GET") return new Response("Method not allowed", { status: 405, headers: { Allow: "GET" } });
    const phone = TOKEN_RE.test(id) ? peekContactLink(id, clock()) : null;
    const number = phone ? getUser(phone)?.photon_number : null;
    if (!phone || !isE164(number)) return page(410, "Link expired", `<h1>This link has expired</h1><p>Text ${escapeHtml(botName())} /contact for a fresh one.</p>`);
    console.log(`contact card served for ${maskId(phone)}`);
    return new Response(await buildVcard(number), {
      headers: {
        "Content-Type": "text/vcard; charset=utf-8",
        "Content-Disposition": `inline; filename="${CONTACT_FILENAME}"`,
        "Cache-Control": "no-store",
        "Referrer-Policy": "no-referrer",
        "X-Content-Type-Options": "nosniff",
        "X-Frame-Options": "DENY",
        "Content-Security-Policy": "default-src 'none'; frame-ancestors 'none'",
      },
    });
  }

  return async function handle(req: Request): Promise<Response> {
    const url = new URL(req.url);

    if (url.pathname === "/health") {
      return new Response("ok", { headers: { "Cache-Control": "no-store", "Content-Type": "text/plain" } });
    }

    const j = url.pathname.match(/^\/join\/([^/]+)$/);
    if (j) return join(req, j[1]!);

    const c = url.pathname.match(/^\/contact\/([^/]+)$/);
    if (c) return contact(req, c[1]!);

    const m = url.pathname.match(/^\/connect\/([^/]+)$/);
    if (!m) return new Response("Not found", { status: 404, headers: { "Cache-Control": "no-store" } });
    const token = m[1]!;
    if (!TOKEN_RE.test(token)) return gone();

    if (req.method === "GET") {
      return peekConnectLink(token) ? form(token, hosts) : gone();
    }
    if (req.method !== "POST") return new Response("Method not allowed", { status: 405, headers: { Allow: "GET, POST" } });

    const phone = peekConnectLink(token);
    if (!phone) return gone();
    const user = getUser(phone);
    if (!user || user.status !== "pending") return gone();

    let canvasUrlInput = "", canvasToken = "";
    try {
      const fd = await req.formData();
      canvasUrlInput = String(fd.get("canvas_url") ?? "");
      canvasToken = String(fd.get("canvas_token") ?? "").trim();
    } catch {
      return form(token, hosts, "Something went wrong with that form. Please try again.");
    }

    const fail = (msg: string) => {
      const h = sha256Hex(token);
      const n = (failures.get(h) ?? 0) + 1;
      failures.set(h, n);
      if (n >= MAX_FAILED_TRIES) {
        consumeConnectLink(token); // too many wrong tries: burn the link
        return gone();
      }
      return form(token, hosts, msg, canvasUrlInput);
    };

    const canvasUrl = normalizeCanvasUrl(canvasUrlInput, hosts);
    if (!canvasUrl) return fail(`That Canvas address isn't supported. Allowed: ${hosts.join(", ")}`);
    if (!canvasToken || canvasToken.length > 512) return fail("Please paste your Canvas access token.");
    if (!(await validate(canvasUrl, canvasToken))) return fail("Canvas didn't accept that token. Check you copied all of it and try again.");

    // single use: only one request can win this
    const owner = consumeConnectLink(token);
    if (!owner) return gone();
    saveCanvasCredentials(owner, canvasUrl, await encrypt(canvasToken));
    console.log(`user ${maskId(owner)} connected Canvas`);
    await deps.send(owner, `You're connected! I'm ${botName()}. Ask me things like \"what's due this week?\" or \"what's my grade in DATA 101?\". I'll also text you new grades, announcements and deadlines. Send /disconnect anytime to delete your data.`, "notify");
    return page(200, "Connected", `<h1>You're connected to ${escapeHtml(botName())}</h1><p>Head back to iMessage. I just texted you.</p>`);
  };
}

export function startWebServer(deps: WebDeps, port = Number(process.env.PORT) || 3000) {
  const handle = makeWebHandler(deps);
  const server = Bun.serve({
    port,
    maxRequestBodySize: 16 * 1024,
    fetch: async (req) => {
      try {
        return await handle(req);
      } catch (e) {
        console.error("web error:", e instanceof Error ? e.message : "unknown");
        return new Response("Server error", { status: 500, headers: { "Cache-Control": "no-store" } });
      }
    },
  });
  console.log(`web onboarding listening on :${server.port}`);
  return server;
}
