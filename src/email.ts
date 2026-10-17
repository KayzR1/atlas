// One account-setup email, sent right after sign-up (Resend's HTTP API). The address is the one the person typed on the join page; it is
// used for this message only (never marketing, never a list) and is never logged. No RESEND_API_KEY: nothing is sent.

export type SetupEmail = { to: string; firstName: string; /** the number, as people read it: +1 (628) 555-0199 */ number: string; smsHref: string; botName: string };
export type SendSetupEmail = (m: SetupEmail) => Promise<boolean>;

const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;");

export function setupEmailContent(m: SetupEmail): { subject: string; text: string; html: string } {
  const pretty = m.number;
  const subject = `Text ${m.botName} to get started`;
  const text = `Hi ${m.firstName},\n\nText ${m.botName} at ${pretty} to get started. Send "hi" and ${m.botName} will reply with your private link to connect Canvas.\n\nOpen Messages with "hi" ready to send: ${m.smsHref}\n\nYou're getting this one email because you signed up for ${m.botName}. We use your email only for account setup.`;
  const html = `<p>Hi ${esc(m.firstName)},</p><p>Text ${esc(m.botName)} at <b>${esc(pretty)}</b> to get started. Send "hi" and ${esc(m.botName)} will reply with your private link to connect Canvas.</p><p><a href="${esc(m.smsHref)}">Open Messages with "hi" ready to send</a></p><p style="color:#566a85;font-size:13px">You're getting this one email because you signed up for ${esc(m.botName)}. We use your email only for account setup.</p>`;
  return { subject, text, html };
}

/** The real sender from the environment, or null when RESEND_API_KEY isn't set. EMAIL_FROM must be an address on a domain verified in Resend. */
export function resendFromEnv(env = process.env, doFetch: typeof fetch = fetch): SendSetupEmail | null {
  const key = env.RESEND_API_KEY?.trim();
  if (!key) return null;
  if (process.env.NODE_ENV === "test" && doFetch === fetch) return null; // a test must never email anyone for real
  const from = env.EMAIL_FROM?.trim() || "Pallas <onboarding@resend.dev>";
  return async (m) => {
    try {
      const c = setupEmailContent(m);
      const res = await doFetch("https://api.resend.com/emails", {
        method: "POST",
        headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
        body: JSON.stringify({ from, to: [m.to], subject: c.subject, text: c.text, html: c.html }),
        signal: AbortSignal.timeout(10_000),
      });
      // never the response body or the address: only the status
      if (!res.ok) console.error(`setup email failed (${res.status})`);
      return res.ok;
    } catch (e) {
      console.error(`setup email failed (${e instanceof Error ? e.name : "error"})`);
      return false;
    }
  };
}
