// What we ask people for on the join page, and /name.

export type Profile = { firstName: string; lastName: string; email: string };

const NAME_RE = /^\p{L}[\p{L} '’-]*$/u;

/** 1-50 characters after trimming; letters plus spaces, hyphens and apostrophes. Returns the cleaned name or an error. */
export function parseName(raw: string, what: "First name" | "Last name"): { ok: true; value: string } | { ok: false; error: string } {
  const v = raw.normalize("NFC").trim().replace(/\s+/g, " ");
  if (!v) return { ok: false, error: `${what} is required.` };
  if ([...v].length > 50) return { ok: false, error: `${what} can be at most 50 characters.` };
  if (!NAME_RE.test(v)) return { ok: false, error: `${what} can only use letters, spaces, hyphens and apostrophes.` };
  return { ok: true, value: v };
}

/** A basic format check (local part, @, a dotted domain with a letters-only ending), lowercased. */
export function parseEmail(raw: string): { ok: true; value: string } | { ok: false; error: string } {
  const v = raw.trim().toLowerCase();
  if (!v) return { ok: false, error: "Email is required." };
  if (v.length > 254 || !/^[^\s@<>()[\]\\,;:"]+@[^\s@<>()[\]\\,;:"]+\.[a-z]{2,}$/.test(v) || v.includes("..")) return { ok: false, error: "Enter a valid email, like name@example.com." };
  return { ok: true, value: v };
}

export const fullName = (u: { first_name?: string | null; last_name?: string | null } | null | undefined): string =>
  [u?.first_name, u?.last_name].filter(Boolean).join(" ");
