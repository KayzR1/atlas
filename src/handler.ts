import { parseDueQuery, type DueScope } from "./assignments.ts";
import { parsePlanQuery } from "./planner.ts";
import { botName } from "./brand.ts";
import { clearForcedOff, forceProviderOff, paidSpend, providerStatus } from "./llm.ts";
import { maskId } from "./mask.ts";
import { welcomeWithCard } from "./welcome.ts";
import { contactFile, contactPath } from "./contact.ts";
import { fullName, parseName } from "./profile.ts";
import { isOverBudget, LIMIT_MSG } from "./budget.ts";
import { runWithContext, type UserContext } from "./context.ts";
import {
  appendHistory, clearHistory, createConnectLink, createInvite, createPendingUser, ensureUser, getUser, listUsers, loadHistory, markSeenMessage,
  normalizeId, redeemInvite, sentSince, setBriefTime, setProfile, setSpaceId, setWelcomed, setStatus, setUserFlag, wipeUser,
  type Turn,
} from "./db.ts";
import { fmtBrief, parseBriefTime } from "./notify.ts";
import type { Send } from "./outbound.ts";

const MAX_TURNS = 20;
const MAX_BAD_CODES_PER_HOUR = 5;

type InMessage = {
  id: string;
  direction?: string;
  sender?: { id: string; kind?: string } | undefined;
  content: { type: string; text?: string };
};
type InSpace = { id: string; responding<T>(fn: () => T | Promise<T>): Promise<T> };

/** What we know about a sender. Strangers get no reply at all (except a "join CODE" attempt). */
export type Access = "owner" | "member" | "pending" | "stranger";

export type HandlerDeps = {
  provider: string;
  /** True when PUBLIC_URL and ENCRYPTION_KEY are set: invites and onboarding are enabled. */
  multiUser: boolean;
  access(senderId: string | undefined): Access;
  send: Send;
  rememberSpace(key: string, space: any): void;
  agent(history: Turn[], key: string): Promise<string>;
  confirm(key: string, text: string): Promise<string | null>;
  /** Class schedules (any user): save/show/edit commands, yes/no replies and next-class questions, with no LLM. */
  classes?(key: string, text: string): Promise<string | null>;
  /** GPA questions, what-ifs and /gpa, /credits (any user), computed in code with no LLM. */
  gpa?(key: string, text: string): Promise<string | null>;
  /** Answers a plain "what's due" straight from Canvas, with no LLM. */
  due?(scope: DueScope): Promise<string>;
  /** "Plan my week" (owner only): stages study blocks and returns the plan text, with no LLM. */
  plan?(key: string): Promise<string>;
  /** A numbered pick from a list of matches ("2"): returns what to tell the model, or null if it isn't a pick. */
  choose?(key: string, text: string): string | null;
  /** Build the user's context (decrypts their Canvas token). Throws if it can't. */
  contextFor(key: string): Promise<UserContext>;
  startedAt: number;
  nextCheckAt(key: string): number | null;
  publicUrl?: string;
  /** How the welcome text names whoever invited someone (OWNER_NAME). */
  inviterName?: string;
  /** Frees the user's Photon slot (by stored Photon id, or by phone). True if they're gone from Photon or there is no Photon. */
  unenroll?(key: string, photonUserId: string | null): Promise<boolean>;
  /** Make sure we know this person's assigned Pallas number (looks it up on Photon if it isn't stored yet). */
  ensurePallasNumber?(key: string): Promise<void>;
  /** Mirror /name onto the sender's OWN Photon record (never anyone else's). */
  renamePhoton?(key: string, name: { firstName: string; lastName: string | null }): Promise<"updated" | "not-enrolled" | "failed">;
};

// wrong "join CODE" attempts per sender, to stop code guessing
const badCodes = new Map<string, number[]>();
export const resetBadCodes = () => badCodes.clear();

function tooManyBadCodes(key: string): boolean {
  const cutoff = Date.now() - 3600_000;
  const recent = (badCodes.get(key) ?? []).filter((t) => t > cutoff);
  badCodes.set(key, recent);
  return recent.length >= MAX_BAD_CODES_PER_HOUR;
}

function duration(ms: number): string {
  const m = Math.floor(ms / 60_000);
  return m >= 60 ? `${Math.floor(m / 60)}h ${m % 60}m` : `${m}m`;
}

function connectMessage(d: HandlerDeps, key: string, intro: string): string {
  return `${intro}\n${d.publicUrl}/connect/${createConnectLink(key)}\nThe link works once and expires in 30 minutes.`;
}

export async function handleInbound(space: InSpace, message: InMessage, d: HandlerDeps): Promise<void> {
  // never react to the bot's own messages
  if (message.direction === "outbound" || message.sender?.kind === "agent") return;
  if (!markSeenMessage(message.id)) {
    console.log(`ignored duplicate message ${message.id}`);
    return;
  }

  const sender = message.sender?.id;
  const access = d.access(sender);
  const key = normalizeId(sender ?? "terminal");
  const isText = message.content.type === "text";
  const text = isText ? (message.content.text ?? "").trim() : "";

  // ---- strangers: silence, except a join attempt ----
  if (access === "stranger") {
    const join = d.multiUser && isText ? text.match(/^join\s+([A-Za-z0-9 -]{4,12})$/i) : null;
    if (!join) {
      console.log(`ignored message from unknown sender ${maskId(sender)}`);
      return;
    }
    if (tooManyBadCodes(key)) {
      console.log(`ignored join attempt from ${maskId(key)}: too many bad codes`);
      return;
    }
    if (!redeemInvite(join[1]!, key)) {
      badCodes.set(key, [...(badCodes.get(key) ?? []), Date.now()]);
      console.log(`invalid join code from ${maskId(key)}`);
      await d.send(key, "invalid or expired code", "reply", space);
      return;
    }
    createPendingUser(key);
    setSpaceId(key, space.id);
    setWelcomed(key); // the welcome below is their reply
    d.rememberSpace(key, space);
    console.log(`invite redeemed by ${maskId(key)}`);
    await d.send(key, connectMessage(d, key, `Welcome to ${botName()}! To connect your Canvas, open this private link:`), "reply", space);
    return;
  }

  ensureUser(key);
  setSpaceId(key, space.id);
  d.rememberSpace(key, space);

  // receipts, typing, reactions, attachments...: ignore silently
  if (!isText) {
    console.log(`ignored non-text event: ${message.content.type}`);
    return;
  }
  if (!text) return;

  const [word = "", ...args] = text.split(/\s+/);
  const cmd = word.toLowerCase();
  const reply = (t: string) => d.send(key, t, "reply", space);

  // ---- /disconnect works for anyone who isn't the owner (including pending users) ----
  if (cmd === "/disconnect") {
    if (access === "owner") {
      await reply("You're the owner; there's nothing to disconnect. Use /pause or /quiet instead.");
      return;
    }
    await reply("Disconnected. I deleted your Canvas token, history and settings. Ask for a new invite to start again.");
    const photonId = getUser(key)?.photon_user_id ?? null;
    wipeUser(key, "removed");
    console.log(`user ${maskId(key)} disconnected`);
    if (d.unenroll && !(await d.unenroll(key, photonId))) console.error(`could not free ${maskId(key)}'s Photon slot; remove them in the Photon dashboard`);
    return;
  }

  // ---- pending users: any text gets a fresh connect link ----
  if (access === "pending") {
    if (getUser(key)?.welcomed === 0) {
      // they signed up on the web but Pallas could not text first (Photon's shared plan only lets Pallas reply once you've texted):
      // their first text gets the welcome and the connect link
      const w = await welcomeWithCard(key, { publicUrl: d.publicUrl ?? "", inviterName: d.inviterName });
      await d.send(key, w.text, "reply", space, w.file);
      setWelcomed(key);
      return;
    }
    await reply(connectMessage(d, key, `You're almost set. Connect your Canvas to ${botName()} with this private link:`));
    return;
  }

  const user = getUser(key)!;

  // owner commands come before anything else
  if (user.paused) {
    if (cmd === "/resume") {
      setUserFlag(key, "paused", false);
      await reply("Resumed.");
    } else {
      console.log(`paused: ignored message from ${maskId(key)}`);
    }
    return;
  }

  const ownerOnly = (): boolean => {
    if (access === "owner") return false;
    void reply("That command is owner-only.");
    return true;
  };

  switch (cmd) {
    case "/pause":
      setUserFlag(key, "paused", true);
      await reply("Paused. I'll ignore everything (including notifications) until you send /resume.");
      return;
    case "/resume":
      await reply("I wasn't paused.");
      return;
    case "/quiet": {
      const on = !user.notify;
      setUserFlag(key, "notify", on);
      await reply(on ? "Notifications on." : "Notifications off. I'll still answer when you text me.");
      return;
    }
    case "/brief": {
      const arg = args.join(" ").trim().toLowerCase();
      if (!arg) {
        await reply(user.brief_time === "off" ? "Morning brief is off. /brief 7:00 turns it on." : `Morning brief at ${fmtBrief(user.brief_time)} (sent any time in the 3 hours after, once a day). /brief 7:00 changes it, /brief off stops it.`);
        return;
      }
      const t = parseBriefTime(arg);
      if (!t) {
        await reply('Try "/brief 7:00" (any time from 5:00 to 11:00 AM) or "/brief off".');
        return;
      }
      setBriefTime(key, t);
      await reply(t === "off" ? "Morning brief off." : `Morning brief set to ${fmtBrief(t)}.`);
      return;
    }
    case "/name": {
      if (!args.length) {
        const n = fullName(user);
        await reply(n ? `I have you as ${n}. Change it with /name First Last.` : "I don't have a name for you yet. Tell me what to call you: /name First Last");
        return;
      }
      // the first word is the first name; everything after it is the last name ("Mary Jane Smith" -> Mary / Jane Smith)
      const first = parseName(args[0]!, "First name");
      const last = args.length > 1 ? parseName(args.slice(1).join(" "), "Last name") : null;
      if (!first.ok || (last && !last.ok)) {
        await reply(`${!first.ok ? first.error : last && !last.ok ? last.error : ""} Try: /name First Last`);
        return;
      }
      const lastName = last && last.ok ? last.value : null;
      setProfile(key, { firstName: first.value, lastName });
      // the sender's own Photon record only: `key` is who is asking, and nothing else is ever passed
      const synced = d.renamePhoton ? await d.renamePhoton(key, { firstName: first.value, lastName }) : "not-enrolled";
      if (synced === "failed") console.error(`could not update ${maskId(key)}'s Photon name`);
      await reply(`Got it, I'll call you ${first.value}.${synced === "failed" ? " (Saved here, but I couldn't update your Photon profile just now.)" : ""}`);
      return;
    }
    case "/status": {
      const next = d.nextCheckAt(key);
      const nextTxt = next ? `in ${Math.max(0, Math.round((next - Date.now()) / 60_000))}m` : "not scheduled";
      await reply(
        `up ${duration(Date.now() - d.startedAt)}, ${sentSince(key, 3600_000)} messages sent in the last hour, next check ${nextTxt}, notifications ${user.notify ? "on" : "off"}`,
      );
      return;
    }
    case "/reset":
      clearHistory(key);
      await reply("History cleared.");
      return;
    case "/invite": {
      if (ownerOnly()) return;
      if (!d.multiUser) {
        await reply("Invites are off. Set PUBLIC_URL and ENCRYPTION_KEY to enable them.");
        return;
      }
      const { code } = createInvite(key);
      const link = `${d.publicUrl}/join/${code}`;
      await reply(`Invite link: ${link} (single use, valid 7 days)\n\nForward this:\nJoin ${botName()}: ${link}. You'll get your ${botName()} number. Text it 'hi' to start.`);
      return;
    }
    case "/contact": {
      if (ownerOnly()) return;
      if (!d.publicUrl) {
        await reply("Contact cards need PUBLIC_URL to be set.");
        return;
      }
      await d.ensurePallasNumber?.(key);
      const card = contactPath(key);
      if (card) await d.send(key, `Save ${botName()} to Contacts: ${d.publicUrl}${card}\nOpen it in Safari (other browsers download the file instead). The link works for 7 days.`, "reply", space, (await contactFile(key)) ?? undefined);
      else await reply(`I don't have your ${botName()} number on file yet, so I can't make a card.`);
      return;
    }
    case "/llm": {
      if (ownerOnly()) return;
      // /llm off groq [minutes]: rehearse a failover without touching any key; /llm on: back to normal
      if (args[0]?.toLowerCase() === "off" || args[0]?.toLowerCase() === "on") {
        if (args[0].toLowerCase() === "on") {
          clearForcedOff();
          await reply("All providers are back on.");
          return;
        }
        const minutes = Math.min(120, Math.max(1, Math.round(Number(args[2]) || 10)));
        const name = (args[1] ?? "").toLowerCase();
        await reply(forceProviderOff(name, minutes) ? `${name} is switched off for ${minutes} min (until a restart or /llm on). Ask me anything and the next provider answers.` : `Unknown provider "${name}". Try /llm to see the names, like /llm off groq.`);
        return;
      }
      const k = (n: number) => (n >= 10_000 ? `${Math.round(n / 1000)}K` : String(n));
      const lines = providerStatus().map((p) => {
        const use = `${p.requests} req${p.dailyRequests ? `/${k(p.dailyRequests)}` : ""} · ${k(p.tokens)} tok${p.dailyTokens ? `/${k(p.dailyTokens)}` : ""}`;
        return `${p.name}: ${p.state}${p.detail ? ` (${p.detail})` : ""} · ${use} today${p.rpm ? ` · ${p.rpm}/min pace` : ""}`;
      });
      const usd = (n: number) => `$${n.toFixed(2)}`;
      const spend = paidSpend().map((x) => `${x.label} spend (est.): ${usd(x.usdToday)} today (${k(x.tokensToday)}/${k(x.cap)} tok cap, resets midnight ET) · ${usd(x.usdMonth)} month to date`);
      await reply(`Model chain, in order (usage is for today, UTC):\n${lines.join("\n")}${spend.length ? `\n${spend.join("\n")}` : ""}`);
      return;
    }
    case "/users": {
      if (ownerOnly()) return;
      const rows = listUsers().filter((u) => u.status !== "removed").slice(0, 25);
      await reply(rows.map((u) => `${fullName(u) ? fullName(u) + " " : ""}${u.phone} ${u.role} ${u.status}`).join("\n") || "No users.");
      return;
    }
    case "/remove": {
      if (ownerOnly()) return;
      const target = args[0] ? normalizeId(args[0]) : "";
      const row = target ? getUser(target) : null;
      if (!row) {
        await reply("Usage: /remove +15551234567 (no such user)");
      } else if (row.role === "owner") {
        await reply("I can't remove the owner.");
      } else {
        const photonId = row.photon_user_id;
        wipeUser(target, "removed");
        console.log(`user ${maskId(target)} removed by owner`);
        const freed = d.unenroll ? await d.unenroll(target, photonId) : null;
        await reply(
          freed === null ? `Removed ${target} and deleted their data.`
            : freed ? `Removed ${target}, deleted their data and freed their Photon slot.`
            : `Removed ${target} and deleted their data, but I couldn't free their Photon slot. Remove them in the Photon dashboard.`,
        );
      }
      return;
    }
  }

  // ---- a normal question: run it as this user ----
  let ctx: UserContext;
  try {
    ctx = await d.contextFor(key);
  } catch (e) {
    // credentials missing or unreadable: send them back through onboarding (never log the token)
    console.error(`no usable credentials for ${maskId(key)}:`, e instanceof Error ? e.message : "unknown error");
    if (!d.multiUser) {
      await reply("Sorry, my Canvas connection isn't set up.");
      return;
    }
    setStatus(key, "pending");
    await reply(connectMessage(d, key, "I need you to reconnect your Canvas with this private link:"));
    return;
  }
  await runWithContext(ctx, async () => {
    console.log(`Q [${maskId(key)}]: ${text}`);
    let answer: string | null = null;
    let userTurn = text;
    try {
      // 1) a reply to a staged change (yes / no / just-this-one-or-all) is handled in code
      answer = (await d.classes?.(key, text)) ?? null;
      if (answer === null) answer = (await d.gpa?.(key, text)) ?? null;
      if (answer === null) answer = await d.confirm(key, text);
      // 2) a plain "what's due" is answered by code from Canvas: zero tokens, so it works even when the quota is gone
      const scope = answer === null && d.due ? parseDueQuery(text) : null;
      if (scope) {
        console.log(`fast path: due (${scope}), no LLM`);
        answer = await d.due!(scope).catch((e) => {
          console.error("due fast path failed:", e instanceof Error ? e.message : e);
          return "I couldn't reach Canvas just now. Try again in a bit.";
        });
      }
      if (answer === null && d.plan && ctx.role === "owner" && parsePlanQuery(text)) {
        console.log("fast path: study plan, no LLM");
        answer = await d.plan(key).catch((e) => {
          console.error("plan failed:", e instanceof Error ? e.message : e);
          return "I couldn't build the plan just now. Try again in a bit.";
        });
      }
      if (answer === null) {
        if (isOverBudget(ctx)) {
          console.log(`daily token budget reached for ${maskId(key)}`);
          await reply(LIMIT_MSG);
          return;
        }
        // 3) a number picked from a list of matches is rewritten so the model knows which event was chosen
        userTurn = d.choose?.(key, text) ?? text;
        appendHistory(key, "user", userTurn);
        answer = await space.responding(() => d.agent(loadHistory(key, MAX_TURNS), key));
      }
    } catch (e) {
      console.error("agent error:", e instanceof Error ? e.message : e);
      answer = "Sorry, something went wrong. Try again in a bit.";
    }
    if (userTurn === text && loadHistory(key, 1).at(-1)?.role !== "user") appendHistory(key, "user", text);
    appendHistory(key, "assistant", answer);
    console.log(`A: ${answer}`);
    const ok = await reply(answer);
    console.log(ok ? "sent reply" : "WARNING: reply not sent");
  });
}
