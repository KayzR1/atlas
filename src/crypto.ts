import { createHash } from "node:crypto";

const VERSION = "v1";

/** Parse ENCRYPTION_KEY (32 bytes, base64). Throws a clear error if it's missing or malformed. */
export function parseEncryptionKey(b64 = process.env.ENCRYPTION_KEY): Uint8Array {
  if (!b64) throw new Error("ENCRYPTION_KEY is not set");
  const raw = Buffer.from(b64, "base64");
  if (raw.length !== 32) throw new Error(`ENCRYPTION_KEY must be 32 bytes, base64-encoded (got ${raw.length} bytes). Generate one with: openssl rand -base64 32`);
  return new Uint8Array(raw);
}

const keyCache = new Map<string, Promise<CryptoKey>>();

function aesKey(b64 = process.env.ENCRYPTION_KEY): Promise<CryptoKey> {
  const raw = parseEncryptionKey(b64);
  let k = keyCache.get(b64!);
  if (!k) {
    k = crypto.subtle.importKey("raw", raw as any, "AES-GCM", false, ["encrypt", "decrypt"]);
    keyCache.set(b64!, k);
  }
  return k;
}

/** AES-256-GCM. Output: "v1:" + base64(12-byte IV || ciphertext+tag). A fresh random IV is used every time. */
export async function encrypt(plaintext: string): Promise<string> {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv }, await aesKey(), new TextEncoder().encode(plaintext)));
  const out = new Uint8Array(iv.length + ct.length);
  out.set(iv);
  out.set(ct, iv.length);
  return `${VERSION}:${Buffer.from(out).toString("base64")}`;
}

export async function decrypt(blob: string): Promise<string> {
  const [v, data] = blob.split(":");
  if (v !== VERSION || !data) throw new Error("unrecognized ciphertext format");
  const raw = new Uint8Array(Buffer.from(data, "base64"));
  if (raw.length < 12 + 16) throw new Error("ciphertext too short");
  // throws if the key is wrong or the data was tampered with (GCM authentication)
  const pt = await crypto.subtle.decrypt({ name: "AES-GCM", iv: raw.slice(0, 12) }, await aesKey(), raw.slice(12));
  return new TextDecoder().decode(pt);
}

export const sha256Hex = (s: string) => createHash("sha256").update(s).digest("hex");

/** 32 random bytes as base64url (43 chars). */
export function randomToken(): string {
  return Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString("base64url");
}

/** No 0/O/1/I: 32 symbols, so (byte & 31) is uniform. */
export const INVITE_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";

export function randomInviteCode(len = 6): string {
  const bytes = crypto.getRandomValues(new Uint8Array(len));
  return Array.from(bytes, (b) => INVITE_ALPHABET[b & 31]).join("");
}
