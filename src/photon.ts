// Enrolling people on the shared Photon (Spectrum) plan, so an unknown number can reach Pallas.
// Cloud API: Basic auth with projectId:projectSecret (the same SPECTRUM_PROJECT_ID / SECRET the bot runs on).
//   POST   /projects/{id}/users/            {type:"shared", phoneNumber}  -> data.{id, assignedPhoneNumber, ...}
//   GET    /projects/{id}/users/?type=shared -> data.{users, total}
//   DELETE /projects/{id}/users/{userId}/    soft delete (drops out of the active list)

export type Enroll =
  | { ok: true; id: string; assignedNumber: string | null; existing: boolean }
  | { ok: false; reason: "full" | "error"; message: string };

export interface Photon {
  /** Most shared users the plan allows (PHOTON_USER_LIMIT). */
  limit: number;
  /** Enroll a number. Idempotent: a number already enrolled comes back as `existing` and is not counted again. */
  enroll(phone: string, profile?: { firstName: string; lastName: string; email: string }): Promise<Enroll>;
  /** Remove a user (by Photon id, or by phone if the id isn't known). True if they are gone afterwards. */
  remove(userId: string | null, phone: string): Promise<boolean>;
  /** Read-only: this number's Photon id and assigned number if it is enrolled, else null. Never enrolls anyone. */
  lookup?(phone: string): Promise<{ id: string; assignedNumber: string | null } | null>;
  /** Active shared users right now. */
  count(): Promise<number>;
  /**
   * Update the name on THIS phone number's own Photon record, and nothing else. Spectrum has no update call, but re-posting an
   * existing shared user's phone updates its name (the documented behaviour). A number that isn't enrolled is never created here.
   */
  rename(phone: string, name: { firstName: string; lastName?: string | null }): Promise<"updated" | "not-enrolled" | "failed">;
}

export type PhotonOpts = { projectId: string; secret: string; limit?: number; baseUrl?: string; fetch?: typeof fetch };

type ApiUser = { id: string; phoneNumber?: string; assignedPhoneNumber?: string | null };

export const DEFAULT_USER_LIMIT = 10;

export function userLimit(env = process.env): number {
  const n = Number(env.PHOTON_USER_LIMIT);
  return Number.isInteger(n) && n > 0 ? n : DEFAULT_USER_LIMIT;
}

/** What a refusal for being over the plan's user limit looks like, for the cases the proactive count can't see. */
export function looksLikeLimitError(status: number, code: string, message: string): boolean {
  if (status === 402) return true;
  return /limit|max(imum)?[ _-]?(shared|users?)|quota|upgrade|capacity|plan[ _-]?(is )?full|too many users|exceed/i.test(`${code} ${message}`);
}

export function makePhoton(opts: PhotonOpts): Photon {
  const base = (opts.baseUrl ?? "https://spectrum.photon.codes").replace(/\/$/, "");
  const doFetch = opts.fetch ?? fetch;
  const limit = opts.limit ?? DEFAULT_USER_LIMIT;
  const url = (path: string) => `${base}/projects/${opts.projectId}${path}`;
  const headers = { Authorization: `Basic ${btoa(`${opts.projectId}:${opts.secret}`)}`, "Content-Type": "application/json" };

  async function call(method: string, path: string, body?: unknown): Promise<{ status: number; json: any }> {
    const res = await doFetch(url(path), { method, headers, body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(15_000) });
    let json: any = null;
    try {
      json = await res.json();
    } catch {
      json = null;
    }
    return { status: res.status, json };
  }

  async function activeUsers(): Promise<{ users: ApiUser[]; total: number }> {
    const { status, json } = await call("GET", "/users/?type=shared");
    if (status !== 200 || !json?.succeed) throw new Error(`photon list users failed (${status})`);
    const users: ApiUser[] = json.data?.users ?? [];
    return { users, total: typeof json.data?.total === "number" ? json.data.total : users.length };
  }

  const digits = (s: string | undefined | null) => String(s ?? "").replace(/\D/g, "");

  return {
    limit,
    async count() {
      return (await activeUsers()).total;
    },
    async enroll(phone, profile) {
      let listed: { users: ApiUser[]; total: number } | null = null;
      try {
        listed = await activeUsers();
      } catch (e) {
        console.error("photon:", e instanceof Error ? e.message : e); // fall through: the create call's own refusal is the backup
      }
      if (listed) {
        const have = listed.users.find((u) => digits(u.phoneNumber) === digits(phone));
        if (have) return { ok: true, id: have.id, assignedNumber: have.assignedPhoneNumber ?? null, existing: true };
        if (listed.total >= limit) return { ok: false, reason: "full", message: `${listed.total} of ${limit} users enrolled` };
      }
      let r;
      try {
        r = await call("POST", "/users/", { type: "shared", phoneNumber: phone, ...(profile ? { firstName: profile.firstName, lastName: profile.lastName, email: profile.email } : {}) });
      } catch (e) {
        return { ok: false, reason: "error", message: e instanceof Error ? e.message : "request failed" };
      }
      if (r.status === 200 && r.json?.succeed && r.json.data?.id) {
        return { ok: true, id: String(r.json.data.id), assignedNumber: r.json.data.assignedPhoneNumber ?? null, existing: false };
      }
      const code = String(r.json?.code ?? ""), message = String(r.json?.message ?? "");
      if (looksLikeLimitError(r.status, code, message)) return { ok: false, reason: "full", message: `${r.status} ${code}` };
      return { ok: false, reason: "error", message: `photon create user failed (${r.status} ${code})` };
    },
    async lookup(phone) {
      try {
        const have = (await activeUsers()).users.find((u) => digits(u.phoneNumber) === digits(phone));
        return have ? { id: have.id, assignedNumber: have.assignedPhoneNumber ?? null } : null;
      } catch (e) {
        console.error("photon lookup failed:", e instanceof Error ? e.message : e);
        return null;
      }
    },
    async rename(phone, name) {
      try {
        const have = (await activeUsers()).users.find((u) => digits(u.phoneNumber) === digits(phone));
        if (!have) return "not-enrolled"; // never create a user (and use up a slot) just to set a name
        const r = await call("POST", "/users/", { type: "shared", phoneNumber: have.phoneNumber ?? phone, firstName: name.firstName, ...(name.lastName ? { lastName: name.lastName } : {}) });
        return r.status === 200 && r.json?.succeed && String(r.json.data?.id) === String(have.id) ? "updated" : "failed";
      } catch (e) {
        console.error("photon rename failed:", e instanceof Error ? e.message : e);
        return "failed";
      }
    },
    async remove(userId, phone) {
      try {
        let id = userId;
        if (!id) {
          const have = (await activeUsers()).users.find((u) => digits(u.phoneNumber) === digits(phone));
          if (!have) return true; // not enrolled: nothing to free
          id = have.id;
        }
        const r = await call("DELETE", `/users/${encodeURIComponent(id)}/`);
        return r.status === 200 || r.status === 404;
      } catch (e) {
        console.error("photon remove failed:", e instanceof Error ? e.message : e);
        return false;
      }
    },
  };
}

/** The real client from the environment, or null when this isn't a Photon cloud deployment. */
export function photonFromEnv(env = process.env): Photon | null {
  const projectId = env.SPECTRUM_PROJECT_ID, secret = env.SPECTRUM_PROJECT_SECRET;
  if ((env.PROVIDER ?? "").toLowerCase() !== "cloud" || !projectId || !secret) return null;
  return makePhoton({ projectId, secret, limit: userLimit(env) });
}
