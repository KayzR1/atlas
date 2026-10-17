import { recordSend, sentSince, getUser } from "./db.ts";
import { attachment, contact, group, type ContactInput } from "spectrum-ts";
import { maskId, maskText } from "./mask.ts";

/**
 * Circuit breaker, per user per minute. Notifications are proactive, so they get the tight limit.
 * Replies answer a text the user just sent; a fast back-and-forth (ask, confirm, ask...) legitimately
 * sends several a minute, and dropping one silently looks like the bot ignoring you, so replies get more room.
 */
export const MAX_NOTIFY_PER_MINUTE = 5;
export const MAX_REPLIES_PER_MINUTE = 20;

export type SendKind = "reply" | "notify";
/**
 * A contact card to send with the message. Tried in this order, each one in a single message with `caption` under it:
 *   1. spectrum-ts's native "contact" content built from `card` (it carries the photo),
 *   2. the same card as a plain .vcf file (`data`),
 *   3. the message's own text alone (so that one must work without any card).
 */
export type FileAttachment = { name: string; mimeType: string; data: Buffer; caption: string; card?: ContactInput };
export type Send = (key: string, text: string, kind: SendKind, space?: any, file?: FileAttachment) => Promise<boolean>;

type Opts = {
  provider: string;
  /** Spectrum app + platform definition (e.g. imessage), needed to message someone who hasn't just texted us. */
  app?: any;
  platform?: any;
  dryRun?: boolean;
};

/**
 * The only place the bot sends messages. Enforces the circuit breaker
 * (per-user, per-minute limits; see above).
 */
export function makeOutbound(opts: Opts) {
  const spaces = new Map<string, any>();

  async function resolveSpace(key: string): Promise<any | undefined> {
    const cached = spaces.get(key);
    if (cached) return cached;
    if (!opts.app || !opts.platform) return undefined;
    const inst = opts.platform(opts.app);
    const sid = getUser(key)?.space_id;
    const space = sid ? await inst.space.get(sid) : await inst.space.create(key);
    spaces.set(key, space);
    return space;
  }

  const send: Send = async (key, text, kind, space, file) => {
    if (opts.dryRun) {
      console.log(`[dry-run → ${maskId(key)}] (${kind})${file ? ` [+ attachment ${file.name}]` : ""}\n${text}\n`);
      return true;
    }
    const limit = kind === "notify" ? MAX_NOTIFY_PER_MINUTE : MAX_REPLIES_PER_MINUTE;
    if (sentSince(key, 60_000, kind) >= limit) {
      console.warn(`circuit breaker: dropped ${kind} to ${maskId(key)} (${limit}/min limit)`);
      return false;
    }
    try {
      const target = space ?? (await resolveSpace(key));
      if (!target) {
        // terminal provider (or no stored chat): nothing to deliver to but the console
        console.log(`[notify → ${maskId(key)}] ${text}`);
      } else {
        if (file) {
          const tries: [string, () => unknown][] = [];
          if (file.card) tries.push(["contact card", () => group(contact(file.card!), file.caption)]);
          tries.push(["attachment", () => group(attachment(file.data, { name: file.name, mimeType: file.mimeType }), file.caption)]);
          let delivered = false;
          for (const [what, build] of tries) {
            try {
              await target.send(build());
              delivered = true;
              break;
            } catch (e) {
              console.warn(`${what} to ${maskId(key)} failed:`, maskText(e instanceof Error ? e.message : String(e)));
            }
          }
          if (!delivered) await target.send(text); // the plain text, with the link
        } else await target.send(text);
      }
      recordSend(key, kind);
      return true;
    } catch (e) {
      console.error(`send to ${maskId(key)} failed:`, maskText(e instanceof Error ? e.message : String(e))); // the real error, with any number in it masked
      return false;
    }
  };

  return { send, rememberSpace: (key: string, space: any) => void spaces.set(key, space) };
}
