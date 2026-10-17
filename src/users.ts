import type { UserContext } from "./context.ts";
import { decrypt } from "./crypto.ts";
import type { UserRow } from "./db.ts";

const DEFAULT_HOSTS = "uncch.instructure.com";

export function allowedCanvasHosts(): string[] {
  return (process.env.ALLOWED_CANVAS_HOSTS || DEFAULT_HOSTS)
    .split(",")
    .map((h) => h.trim().toLowerCase())
    .filter(Boolean);
}

/**
 * Turn what a user typed ("uncch.instructure.com" or a full URL) into "https://host",
 * but only for hosts on the allowlist. Anything else is rejected (SSRF protection).
 */
export function normalizeCanvasUrl(input: string, hosts = allowedCanvasHosts()): string | null {
  let raw = input.trim();
  if (!raw) return null;
  if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(raw)) raw = `https://${raw}`;
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    return null;
  }
  if (u.protocol !== "https:" || u.username || u.password || u.port) return null;
  const host = u.hostname.toLowerCase();
  return hosts.includes(host) ? `https://${host}` : null;
}

/** Build the per-request context. The owner uses the env token; members use their decrypted one. */
export async function contextFor(user: UserRow): Promise<UserContext> {
  if (user.role === "owner") {
    return {
      key: user.phone,
      role: "owner",
      timezone: user.timezone,
      canvasUrl: process.env.CANVAS_URL || "https://uncch.instructure.com",
      canvasToken: process.env.CANVAS_TOKEN || "",
    };
  }
  if (!user.canvas_token_enc || !user.canvas_url) throw new Error("no Canvas credentials stored");
  return { key: user.phone, role: "member", timezone: user.timezone, canvasUrl: user.canvas_url, canvasToken: await decrypt(user.canvas_token_enc) };
}
