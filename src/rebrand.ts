import { botName } from "./brand.ts";
import { contactFile, contactPath } from "./contact.ts";
import { db, getLlmFlag, markNotified, setLlmFlag, wasNotified, type UserRow } from "./db.ts";
import { maskId } from "./mask.ts";
import type { Send } from "./outbound.ts";

// The one-time "Atlas is now Pallas" text for people who were already using the bot. It runs once at startup after the rename ships:
//  - only users who existed before the first run of this code (stamped as a cutoff), so new sign-ups never hear about a name they never knew
//  - each user is marked BEFORE the send, so a crash or restart can never send it twice; a send that fails is unmarked and retried on a later start
//  - only when the bot really is called Pallas (BOT_NAME in the environment can still say otherwise)

export const REBRAND_KEY = "rebrand:pallas";
const CUTOFF_FLAG = "rebrand-cutoff", DONE_FLAG = "rebrand-done";

const clearNotified = (key: string, k: string) => void db.run("DELETE FROM notified WHERE phone = ? AND key = ?", [key, k]);

export const rebrandText = (withCard: boolean) => `Quick update: Atlas is now Pallas. Same assistant, new name.${withCard ? " Tap the card to update your contact." : ""}`;

export type RebrandOpts = { publicUrl?: string; ensureNumber?: (key: string) => Promise<void>; now?: number };

export async function runRebrandNotices(users: UserRow[], send: Send, opts: RebrandOpts = {}): Promise<{ sent: number; failed: number; skipped: number }> {
  const out = { sent: 0, failed: 0, skipped: 0 };
  if (botName() !== "Pallas" || getLlmFlag(DONE_FLAG)) return out;
  const now = opts.now ?? Date.now();
  let cutoff = Number(getLlmFlag(CUTOFF_FLAG));
  if (!Number.isFinite(cutoff) || cutoff <= 0) {
    cutoff = now;
    setLlmFlag(CUTOFF_FLAG, String(cutoff));
  }
  let waiting = 0; // eligible people who did not get it this time (failed, paused, or quiet)
  for (const u of users) {
    const key = u.phone;
    const { created_at } = db.query<{ created_at: number }, [string]>("SELECT created_at FROM users WHERE phone = ?").get(key) ?? { created_at: Infinity };
    if (u.status !== "active" || created_at > cutoff || wasNotified(key, REBRAND_KEY)) {
      out.skipped++;
      continue;
    }
    if (u.paused || !u.notify) {
      waiting++;
      out.skipped++;
      continue;
    }
    try {
      await opts.ensureNumber?.(key);
      const card = await contactFile(key, rebrandText(true));
      const link = contactPath(key);
      // if the card can't go out, the text carries a link instead (it must not tell them to tap a card that isn't there)
      const plain = card && link && opts.publicUrl ? `${rebrandText(false)} Update your contact: ${opts.publicUrl}${link}` : rebrandText(false);
      markNotified(key, REBRAND_KEY);
      const ok = await send(key, plain, "notify", undefined, card ?? undefined);
      if (ok) out.sent++;
      else {
        clearNotified(key, REBRAND_KEY);
        out.failed++;
        waiting++;
      }
    } catch (e) {
      clearNotified(key, REBRAND_KEY);
      out.failed++;
      waiting++;
      console.error(`rebrand notice for ${maskId(key)} failed:`, e instanceof Error ? e.name : "error");
    }
  }
  if (!waiting) setLlmFlag(DONE_FLAG, "1");
  console.log(`rebrand notice: ${out.sent} sent, ${out.failed} failed, ${out.skipped} skipped`);
  return out;
}
