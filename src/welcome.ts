import { botName } from "./brand.ts";
import { contactFile, contactPath, tapCardLine } from "./contact.ts";
import { createConnectLink, getUser, listPendingWelcomes, markWelcomeAttempt, setWelcomed } from "./db.ts";
import { maskId } from "./mask.ts";
import type { FileAttachment, Send } from "./outbound.ts";

// The first text to a newly enrolled person. On Photon's shared plan Pallas cannot message someone who has not texted it
// first ("Target not allowed for this project"), so this is tried once when they sign up and otherwise
// sent as the reply to their first text (see handler.ts). The connect token only ever goes in this text, never on a web page.

// On the shared plan every attempt before they text first is refused, so there is exactly one (at sign-up) and no retries.
// If the plan ever lets Pallas message first, that one attempt delivers. Raise this to bring the retries back.
export const WELCOME_RETRY_EVERY_MS = 10 * 60_000;
export const WELCOME_MAX_TRIES = 1;

export type WelcomeCtx = { publicUrl: string; inviterName?: string };

/** "Hi Jordan, I'm Pallas. Sam invited you. Connect your Canvas here: <link>" with a fresh one-use link. */
export const welcomeText = (key: string, c: WelcomeCtx): string => welcomeMessage(key, c).text;

/**
 * The welcome as one text plus, when we know their number, the contact card. The connect link is in both versions (it is the point of
 * the message). The text has the card's fallback link under it; with the card attached, that line becomes "Tap the card above ...".
 */
export async function welcomeWithCard(key: string, c: WelcomeCtx): Promise<{ text: string; file?: FileAttachment }> {
  const m = welcomeMessage(key, c);
  const file = await contactFile(key, `${m.connect}\n${tapCardLine()}`);
  return { text: m.text, file: file ?? undefined };
}

function welcomeMessage(key: string, c: WelcomeCtx): { text: string; connect: string } {
  const u = getUser(key);
  const hi = u?.first_name ? `Hi ${u.first_name}` : "Hi";
  const inviter = c.inviterName?.trim() || "a friend";
  const connect = `${hi}, I'm ${botName()}. ${inviter} invited you. Connect your Canvas here: ${c.publicUrl}/connect/${createConnectLink(key)}`;
  const card = contactPath(key);
  return { connect, text: card ? `${connect}\nSave ${botName()} to Contacts: ${c.publicUrl}${card}` : connect };
}

/** Try to send the welcome now. Records the attempt; success marks them welcomed. Failures are logged by the sender (masked). */
export async function trySendWelcome(key: string, c: WelcomeCtx, send: Send, now = Date.now()): Promise<boolean> {
  const w = await welcomeWithCard(key, c);
  const ok = await send(key, w.text, "notify", undefined, w.file);
  if (ok) setWelcomed(key);
  else markWelcomeAttempt(key, now);
  return ok;
}

/** Scheduler: keep trying the first text for people who signed up but were never reached (every 10 minutes, up to 6 tries). */
export async function retryWelcomes(c: WelcomeCtx, send: Send, now = Date.now()): Promise<number> {
  let sent = 0;
  for (const u of listPendingWelcomes(now - WELCOME_RETRY_EVERY_MS, WELCOME_MAX_TRIES)) {
    const ok = await trySendWelcome(u.phone, c, send, now);
    const tries = getUser(u.phone)?.welcome_tries ?? 0;
    console.log(`welcome retry ${ok ? "delivered" : `${tries}/${WELCOME_MAX_TRIES} failed`} for ${maskId(u.phone)}${!ok && tries >= WELCOME_MAX_TRIES ? "; giving up until they text first" : ""}`);
    if (ok) sent++;
  }
  return sent;
}
