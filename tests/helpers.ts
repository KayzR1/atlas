import { resolveContents } from "spectrum-ts";
import { encrypt } from "../src/crypto.ts";
import { createPendingUser, ensureOwner, saveCanvasCredentials, initDb, normalizeId } from "../src/db.ts";
import { getUser } from "../src/db.ts";
import { handleInbound, type Access, type HandlerDeps } from "../src/handler.ts";
import { makeOutbound } from "../src/outbound.ts";
import { contextFor } from "../src/users.ts";

export const OWNER = "+19195550100";
export const ALICE = "+19195550101";
export const BOB = "+19195550102";

process.env.ENCRYPTION_KEY = Buffer.alloc(32, 7).toString("base64");

export type Sent = { to: string; text: string; files?: { name: string; mimeType: string; data: Buffer }[]; card?: { name?: string; phones: string[]; photoMime?: string; photo?: Buffer } };

/** A multi-user handler harness on a fresh in-memory DB. */
export async function harness(opts: { multiUser?: boolean; agent?: HandlerDeps["agent"] } = {}) {
  initDb(":memory:");
  ensureOwner(OWNER);
  const sent: Sent[] = [];
  const spaces = new Map<string, any>();
  const spaceFor = (from: string) => {
    let s = spaces.get(from);
    if (!s) {
      s = { id: `chat-${from}`, responding: <T>(fn: () => T | Promise<T>) => Promise.resolve(fn()), send: async (content: unknown) => {
          if (typeof content === "string") return void sent.push({ to: from, text: content });
          // a text with files (what outbound sends for a contact card): open the content up to see both
          const [top] = (await resolveContents([content as any])) as any[];
          const parts = top.type === "group" ? top.items.map((i: any) => i.content) : [top];
          const files = await Promise.all(parts.filter((p: any) => p.type === "attachment").map(async (p: any) => ({ name: p.name, mimeType: p.mimeType, data: await p.read() })));
          const c = parts.find((p: any) => p.type === "contact");
          const card = c && { name: c.name?.formatted, phones: (c.phones ?? []).map((x: any) => x.value), photoMime: c.photo?.mimeType, photo: c.photo ? await c.photo.read() : undefined };
          sent.push({ to: from, text: parts.find((p: any) => p.type === "text")?.text ?? "", files, card });
        } };
      spaces.set(from, s);
    }
    return s;
  };
  const out = makeOutbound({ provider: "cloud" });
  const multiUser = opts.multiUser ?? true;
  let agentCalls = 0;
  const access = (id?: string): Access => {
    if (!id) return "stranger";
    const key = normalizeId(id);
    if (key === OWNER) return "owner";
    if (!multiUser) return "stranger";
    const st = getUser(key)?.status;
    return st === "active" ? "member" : st === "pending" ? "pending" : "stranger";
  };
  const deps: HandlerDeps = {
    provider: "cloud",
    multiUser,
    access,
    send: out.send,
    rememberSpace: out.rememberSpace,
    agent: opts.agent ?? (async () => (agentCalls++, "agent answer")),
    confirm: async () => null,
    contextFor: async (key) => {
      const u = getUser(key)!;
      return contextFor({ ...u, role: key === OWNER ? "owner" : "member" });
    },
    startedAt: Date.now(),
    nextCheckAt: (key) => (key === OWNER ? Date.now() + 10 * 60_000 : null),
    publicUrl: "https://bot.example.com",
  };
  let n = 0;
  const say = (text: string | null, from = OWNER) =>
    handleInbound(
      spaceFor(from),
      { id: `m${++n}`, direction: "inbound", sender: { id: from }, content: text === null ? { type: "reaction" } : { type: "text", text } },
      deps,
    );
  const lastTo = (who: string) => sent.filter((s) => s.to === who).at(-1)?.text;
  return { sent, say, deps, lastTo, agentCalls: () => agentCalls };
}

/** An active member with an encrypted Canvas token. */
export async function addMember(key: string, token = "member-token") {
  createPendingUser(key);
  saveCanvasCredentials(key, "https://uncch.instructure.com", await encrypt(token));
}
