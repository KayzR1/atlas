import { Database } from "bun:sqlite";
import { randomInviteCode, randomToken, sha256Hex } from "./crypto.ts";

export type UserRow = {
  phone: string;
  timezone: string;
  notify: number;
  paused: number;
  seeded: number;
  brief_time: string;
  space_id: string | null;
  role: "owner" | "member";
  status: "active" | "pending" | "removed";
  canvas_url: string | null;
  canvas_token_enc: string | null;
  class_alerts: number;
  prior_gpa: number | null;
  prior_hours: number | null;
  gpa_hint_shown: number;
  photon_user_id: string | null;
  photon_number: string | null;
  first_name: string | null;
  last_name: string | null;
  email: string | null;
  welcomed: number;
  welcome_tries: number;
  welcome_last: number | null;
};

export let db: Database;

export function initDb(path = process.env.DB_PATH || "canvas-bot.db"): Database {
  db = new Database(path, { create: true });
  db.exec(`
    CREATE TABLE IF NOT EXISTS users (
      phone TEXT PRIMARY KEY,
      timezone TEXT NOT NULL,
      notify INTEGER NOT NULL DEFAULT 1,
      paused INTEGER NOT NULL DEFAULT 0,
      seeded INTEGER NOT NULL DEFAULT 0,
      brief_time TEXT NOT NULL DEFAULT '07:00',
      space_id TEXT,
      created_at INTEGER NOT NULL,
      role TEXT NOT NULL DEFAULT 'member',
      status TEXT NOT NULL DEFAULT 'active',
      canvas_url TEXT,
      canvas_token_enc TEXT,
      class_alerts INTEGER NOT NULL DEFAULT 0,
      prior_gpa REAL,
      prior_hours REAL,
      gpa_hint_shown INTEGER NOT NULL DEFAULT 0,
      photon_user_id TEXT,
      photon_number TEXT,
      first_name TEXT,
      last_name TEXT,
      email TEXT,
      welcomed INTEGER NOT NULL DEFAULT 0,
      welcome_tries INTEGER NOT NULL DEFAULT 0,
      welcome_last INTEGER
    );
    CREATE TABLE IF NOT EXISTS history (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      phone TEXT NOT NULL,
      role TEXT NOT NULL,
      content TEXT NOT NULL,
      ts INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS history_phone ON history (phone, id);
    CREATE TABLE IF NOT EXISTS notified (
      phone TEXT NOT NULL,
      key TEXT NOT NULL,
      ts INTEGER NOT NULL,
      PRIMARY KEY (phone, key)
    );
    CREATE TABLE IF NOT EXISTS outbox (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      phone TEXT NOT NULL,
      ts INTEGER NOT NULL,
      kind TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS outbox_phone ON outbox (phone, ts);
    CREATE TABLE IF NOT EXISTS lease (
      id INTEGER PRIMARY KEY CHECK (id = 1),
      owner TEXT NOT NULL,
      ts INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS syllabus_chunks (
      host TEXT NOT NULL,
      course_id INTEGER NOT NULL,
      idx INTEGER NOT NULL,
      source TEXT NOT NULL,
      text TEXT NOT NULL,
      PRIMARY KEY (host, course_id, idx)
    );
    CREATE TABLE IF NOT EXISTS syllabus_meta (
      host TEXT NOT NULL,
      course_id INTEGER NOT NULL,
      fetched_at INTEGER NOT NULL,
      n_chunks INTEGER NOT NULL,
      PRIMARY KEY (host, course_id)
    );
    CREATE TABLE IF NOT EXISTS classes (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      phone TEXT NOT NULL,
      course TEXT NOT NULL,
      days TEXT NOT NULL,
      start_min INTEGER NOT NULL,
      end_min INTEGER NOT NULL,
      location TEXT NOT NULL DEFAULT '',
      term_start TEXT NOT NULL,
      term_end TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS classes_phone ON classes (phone);
    CREATE TABLE IF NOT EXISTS llm_provider_usage (
      day TEXT NOT NULL,
      provider TEXT NOT NULL,
      model TEXT NOT NULL,
      requests INTEGER NOT NULL DEFAULT 0,
      tokens INTEGER NOT NULL DEFAULT 0,
      PRIMARY KEY (day, provider, model)
    );
    CREATE TABLE IF NOT EXISTS llm_paid_usage (
      day TEXT NOT NULL,
      provider TEXT NOT NULL,
      tokens INTEGER NOT NULL DEFAULT 0,
      PRIMARY KEY (day, provider)
    );
    CREATE TABLE IF NOT EXISTS llm_flags (
      name TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS course_credits (
      phone TEXT NOT NULL,
      course TEXT NOT NULL,
      credits REAL NOT NULL,
      PRIMARY KEY (phone, course)
    );
    CREATE TABLE IF NOT EXISTS class_overrides (
      phone TEXT NOT NULL,
      date TEXT NOT NULL,
      skip INTEGER NOT NULL,
      PRIMARY KEY (phone, date)
    );
    CREATE TABLE IF NOT EXISTS grade_snapshots (
      phone TEXT NOT NULL,
      course_id INTEGER NOT NULL,
      snap_date TEXT NOT NULL,
      score REAL NOT NULL,
      grade TEXT,
      PRIMARY KEY (phone, course_id, snap_date)
    );
    CREATE TABLE IF NOT EXISTS calendar_last (
      phone TEXT PRIMARY KEY,
      ref TEXT NOT NULL,
      ts INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS seen_messages (
      id TEXT PRIMARY KEY,
      ts INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS invites (
      code TEXT PRIMARY KEY,
      created_by TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      expires_at INTEGER NOT NULL,
      used_by TEXT,
      used_at INTEGER
    );
    CREATE TABLE IF NOT EXISTS connect_links (
      token_hash TEXT PRIMARY KEY,
      phone TEXT NOT NULL,
      expires_at INTEGER NOT NULL,
      used_at INTEGER
    );
    CREATE INDEX IF NOT EXISTS connect_links_phone ON connect_links (phone);
    CREATE TABLE IF NOT EXISTS contact_links (
      id_hash TEXT PRIMARY KEY,
      phone TEXT NOT NULL,
      expires_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS contact_links_phone ON contact_links (phone);
    CREATE TABLE IF NOT EXISTS llm_usage (
      phone TEXT NOT NULL,
      day TEXT NOT NULL,
      tokens INTEGER NOT NULL DEFAULT 0,
      PRIMARY KEY (phone, day)
    );
  `);
  migrate(db);
  db.run("DELETE FROM seen_messages WHERE ts < ?", [Date.now() - 7 * 86400_000]);
  return db;
}

/** Upgrade a pre-multi-user database in place (the live Railway DB). Safe to run repeatedly. */
function migrate(d: Database) {
  const cols = new Set(d.query<{ name: string }, []>("PRAGMA table_info(users)").all().map((c) => c.name));
  if (!cols.has("role")) {
    d.exec("ALTER TABLE users ADD COLUMN role TEXT NOT NULL DEFAULT 'member'");
    // every row in a pre-multi-user database belongs to the owner
    d.exec("UPDATE users SET role = 'owner'");
  }
  if (!cols.has("status")) d.exec("ALTER TABLE users ADD COLUMN status TEXT NOT NULL DEFAULT 'active'");
  if (!cols.has("canvas_url")) d.exec("ALTER TABLE users ADD COLUMN canvas_url TEXT");
  if (!cols.has("canvas_token_enc")) d.exec("ALTER TABLE users ADD COLUMN canvas_token_enc TEXT");
  if (!cols.has("class_alerts")) d.exec("ALTER TABLE users ADD COLUMN class_alerts INTEGER NOT NULL DEFAULT 0");
  if (!cols.has("prior_gpa")) d.exec("ALTER TABLE users ADD COLUMN prior_gpa REAL");
  if (!cols.has("prior_hours")) d.exec("ALTER TABLE users ADD COLUMN prior_hours REAL");
  if (!cols.has("welcomed")) {
    d.exec("ALTER TABLE users ADD COLUMN welcomed INTEGER NOT NULL DEFAULT 0");
    d.exec("UPDATE users SET welcomed = 1"); // everyone who exists already has been welcomed
  }
  if (!cols.has("welcome_tries")) d.exec("ALTER TABLE users ADD COLUMN welcome_tries INTEGER NOT NULL DEFAULT 0");
  if (!cols.has("welcome_last")) d.exec("ALTER TABLE users ADD COLUMN welcome_last INTEGER");
  if (!cols.has("first_name")) d.exec("ALTER TABLE users ADD COLUMN first_name TEXT");
  if (!cols.has("last_name")) d.exec("ALTER TABLE users ADD COLUMN last_name TEXT");
  if (!cols.has("email")) d.exec("ALTER TABLE users ADD COLUMN email TEXT");
  if (!cols.has("photon_user_id")) d.exec("ALTER TABLE users ADD COLUMN photon_user_id TEXT");
  if (!cols.has("photon_number")) d.exec("ALTER TABLE users ADD COLUMN photon_number TEXT");
  if (!cols.has("gpa_hint_shown")) d.exec("ALTER TABLE users ADD COLUMN gpa_hint_shown INTEGER NOT NULL DEFAULT 0");
  // the default brief moved from 8:00 to 7:00; nobody could change it before /brief existed, so every 08:00 is the old default
  if ((d.query<{ user_version: number }, []>("PRAGMA user_version").get()?.user_version ?? 0) < 1) {
    d.exec("UPDATE users SET brief_time = '07:00' WHERE brief_time = '08:00'");
    d.exec("PRAGMA user_version = 1");
  }
}

/** Phones become "+<digits>", emails are lowercased. */
export function normalizeId(id: string): string {
  const s = id.trim();
  if (s.includes("@")) return s.toLowerCase();
  const d = s.replace(/\D/g, "");
  return d ? `+${d}` : s;
}

// ---- users ----

export function getUser(key: string): UserRow | null {
  return db.query<UserRow, [string]>("SELECT * FROM users WHERE phone = ?").get(key);
}

export function ensureUser(key: string, timezone = process.env.TIMEZONE || "America/New_York"): UserRow {
  db.run("INSERT OR IGNORE INTO users (phone, timezone, created_at) VALUES (?, ?, ?)", [key, timezone, Date.now()]);
  return getUser(key)!;
}

export function setUserFlag(key: string, field: "notify" | "paused" | "seeded", value: boolean) {
  db.run(`UPDATE users SET ${field} = ? WHERE phone = ?`, [value ? 1 : 0, key]);
}

/** "HH:MM" (24h) or "off". */
export const setBriefTime = (key: string, value: string) => void db.run("UPDATE users SET brief_time = ? WHERE phone = ?", [value, key]);

export function setSpaceId(key: string, spaceId: string) {
  db.run("UPDATE users SET space_id = ? WHERE phone = ?", [spaceId, key]);
}

// ---- history ----

export type Turn = { role: "user" | "assistant"; content: string };

export function loadHistory(key: string, limit = 20): Turn[] {
  const rows = db
    .query<Turn, [string, number]>("SELECT role, content FROM history WHERE phone = ? ORDER BY id DESC LIMIT ?")
    .all(key, limit);
  return rows.reverse();
}

export function appendHistory(key: string, role: Turn["role"], content: string) {
  db.run("INSERT INTO history (phone, role, content, ts) VALUES (?, ?, ?, ?)", [key, role, content, Date.now()]);
  db.run("DELETE FROM history WHERE phone = ? AND id NOT IN (SELECT id FROM history WHERE phone = ? ORDER BY id DESC LIMIT 100)", [key, key]);
}

export function clearHistory(key: string) {
  db.run("DELETE FROM history WHERE phone = ?", [key]);
}

// ---- notified (never send the same notification twice) ----

export function wasNotified(key: string, k: string): boolean {
  return !!db.query("SELECT 1 FROM notified WHERE phone = ? AND key = ?").get(key, k);
}

export function markNotified(key: string, k: string) {
  db.run("INSERT OR IGNORE INTO notified (phone, key, ts) VALUES (?, ?, ?)", [key, k, Date.now()]);
}

// ---- outbox (rate limiting + /status) ----

export function recordSend(key: string, kind: string) {
  db.run("INSERT INTO outbox (phone, ts, kind) VALUES (?, ?, ?)", [key, Date.now(), kind]);
  db.run("DELETE FROM outbox WHERE ts < ?", [Date.now() - 86400_000]);
}

export function sentSince(key: string, ms: number, kind?: string): number {
  const since = Date.now() - ms;
  const q = kind
    ? db.query<{ n: number }, [string, number, string]>("SELECT COUNT(*) AS n FROM outbox WHERE phone = ? AND ts >= ? AND kind = ?").get(key, since, kind)
    : db.query<{ n: number }, [string, number]>("SELECT COUNT(*) AS n FROM outbox WHERE phone = ? AND ts >= ?").get(key, since);
  return q!.n;
}

// ---- the last calendar event the bot created or touched, per user ("edit that", "delete it") ----

export function saveLastEvent(key: string, ref: unknown) {
  db.run("INSERT INTO calendar_last (phone, ref, ts) VALUES (?, ?, ?) ON CONFLICT(phone) DO UPDATE SET ref = excluded.ref, ts = excluded.ts", [key, JSON.stringify(ref), Date.now()]);
}

export function loadLastEvent<T = any>(key: string): T | null {
  const r = db.query<{ ref: string }, [string]>("SELECT ref FROM calendar_last WHERE phone = ?").get(key);
  return r ? (JSON.parse(r.ref) as T) : null;
}

// ---- weekly grade snapshots (for "grade changes this week") ----

export type GradeSnap = { course_id: number; score: number; grade: string | null };

export function saveGradeSnapshot(key: string, date: string, rows: GradeSnap[]) {
  for (const r of rows) {
    db.run("INSERT INTO grade_snapshots (phone, course_id, snap_date, score, grade) VALUES (?, ?, ?, ?, ?) ON CONFLICT(phone, course_id, snap_date) DO UPDATE SET score = excluded.score, grade = excluded.grade", [
      key, r.course_id, date, r.score, r.grade,
    ]);
  }
}

export const hasGradeSnapshot = (key: string): boolean => !!db.query("SELECT 1 FROM grade_snapshots WHERE phone = ? LIMIT 1").get(key);

/** For each course, the newest snapshot taken before `beforeDate` (YYYY-MM-DD). */
export function previousGradeSnapshot(key: string, beforeDate: string): Map<number, GradeSnap & { snap_date: string }> {
  const rows = db
    .query<GradeSnap & { snap_date: string }, [string, string, string]>(
      `SELECT course_id, score, grade, snap_date FROM grade_snapshots g
       WHERE phone = ? AND snap_date < ? AND snap_date = (SELECT MAX(snap_date) FROM grade_snapshots WHERE phone = g.phone AND course_id = g.course_id AND snap_date < ?)`,
    )
    .all(key, beforeDate, beforeDate);
  return new Map(rows.map((r) => [r.course_id, r]));
}

export function clearLastEvent(key: string) {
  db.run("DELETE FROM calendar_last WHERE phone = ?", [key]);
}

// ---- inbound dedupe ----

/** Returns false if this message id was already processed. */
export function markSeenMessage(id: string): boolean {
  return db.run("INSERT OR IGNORE INTO seen_messages (id, ts) VALUES (?, ?)", [id, Date.now()]).changes > 0;
}

// ---- single-instance lease (only one bot may talk on this database) ----

export const LEASE_TTL_MS = 45_000;

/** Take or renew the lease. False if another live instance holds it. */
export function tryAcquireLease(owner: string, ttlMs = LEASE_TTL_MS): boolean {
  const now = Date.now();
  return (
    db.run(
      `INSERT INTO lease (id, owner, ts) VALUES (1, ?, ?)
       ON CONFLICT(id) DO UPDATE SET owner = excluded.owner, ts = excluded.ts
       WHERE lease.owner = excluded.owner OR lease.ts < ?`,
      [owner, now, now - ttlMs],
    ).changes > 0
  );
}

export function releaseLease(owner: string) {
  db.run("DELETE FROM lease WHERE id = 1 AND owner = ?", [owner]);
}

// ---- multi-user: roles, status, credentials ----

export function setRole(key: string, role: UserRow["role"]) {
  db.run("UPDATE users SET role = ? WHERE phone = ?", [role, key]);
}

export function setStatus(key: string, status: UserRow["status"]) {
  db.run("UPDATE users SET status = ? WHERE phone = ?", [status, key]);
}

export function listUsers(): UserRow[] {
  return db.query<UserRow, []>("SELECT * FROM users ORDER BY created_at, phone").all();
}

/** Users the scheduler should serve: active, and either the owner or someone with a stored token. */
export function listActiveUsers(): UserRow[] {
  return db
    .query<UserRow, []>("SELECT * FROM users WHERE status = 'active' AND (role = 'owner' OR canvas_token_enc IS NOT NULL) ORDER BY created_at, phone")
    .all();
}

/** The owner always exists, is active and holds role=owner; nobody else does. */
export function ensureOwner(key: string, timezone?: string) {
  ensureUser(key, timezone);
  db.run("UPDATE users SET role = 'owner', status = 'active' WHERE phone = ?", [key]);
  db.run("UPDATE users SET role = 'member' WHERE role = 'owner' AND phone != ?", [key]);
}

/** Start (or restart) onboarding: a pending member with no credentials and a clean slate. */
export function createPendingUser(key: string, timezone = process.env.TIMEZONE || "America/New_York") {
  ensureUser(key, timezone);
  wipeUser(key, "pending");
  db.run("UPDATE users SET role = 'member' WHERE phone = ?", [key]);
}

export function saveCanvasCredentials(key: string, canvasUrl: string, tokenEnc: string) {
  db.run("UPDATE users SET canvas_url = ?, canvas_token_enc = ?, status = 'active', seeded = 0, paused = 0, notify = 1 WHERE phone = ?", [
    canvasUrl,
    tokenEnc,
    key,
  ]);
}

/** Delete everything we hold about a user (token, history, notification state, links, usage) and set their status. */
export function wipeUser(key: string, status: UserRow["status"]) {
  db.transaction(() => {
    db.run("DELETE FROM history WHERE phone = ?", [key]);
    db.run("DELETE FROM notified WHERE phone = ?", [key]);
    db.run("DELETE FROM outbox WHERE phone = ?", [key]);
    db.run("DELETE FROM llm_usage WHERE phone = ?", [key]);
    db.run("DELETE FROM calendar_last WHERE phone = ?", [key]);
    db.run("DELETE FROM grade_snapshots WHERE phone = ?", [key]);
    db.run("DELETE FROM classes WHERE phone = ?", [key]);
    db.run("DELETE FROM class_overrides WHERE phone = ?", [key]);
    db.run("DELETE FROM course_credits WHERE phone = ?", [key]);
    db.run("DELETE FROM connect_links WHERE phone = ?", [key]);
    db.run("DELETE FROM contact_links WHERE phone = ?", [key]);
    db.run("UPDATE users SET canvas_url = NULL, canvas_token_enc = NULL, space_id = NULL, seeded = 0, paused = 0, notify = 1, class_alerts = 0, prior_gpa = NULL, prior_hours = NULL, gpa_hint_shown = 0, photon_user_id = NULL, photon_number = NULL, first_name = NULL, last_name = NULL, email = NULL, welcomed = 0, welcome_tries = 0, welcome_last = NULL, status = ? WHERE phone = ?", [
      status,
      key,
    ]);
  })();
}

// ---- invites ----

export const INVITE_TTL_MS = 7 * 86400_000;

export function createInvite(createdBy: string, now = Date.now()): { code: string; expiresAt: number } {
  for (;;) {
    const code = randomInviteCode();
    const r = db.run("INSERT OR IGNORE INTO invites (code, created_by, created_at, expires_at) VALUES (?, ?, ?, ?)", [code, createdBy, now, now + INVITE_TTL_MS]);
    if (r.changes > 0) return { code, expiresAt: now + INVITE_TTL_MS };
  }
}

/** Is this code still usable? (Looks only; the web join page uses the code up after Photon enrollment succeeds.) */
export function peekInvite(rawCode: string, now = Date.now()): boolean {
  const code = rawCode.toUpperCase().replace(/[^A-Z0-9]/g, "");
  return !!db.query<{ code: string }, [string, number]>("SELECT code FROM invites WHERE code = ? AND used_by IS NULL AND expires_at > ?").get(code, now);
}

/** Single-use, atomic: only one caller can flip used_by from NULL. */
export function redeemInvite(rawCode: string, phone: string, now = Date.now()): boolean {
  const code = rawCode.toUpperCase().replace(/[^A-Z0-9]/g, "");
  return db.run("UPDATE invites SET used_by = ?, used_at = ? WHERE code = ? AND used_by IS NULL AND expires_at > ?", [phone, now, code, now]).changes > 0;
}

// ---- one-time connect links (only a SHA-256 hash of the token is stored) ----

export const CONNECT_LINK_TTL_MS = 30 * 60_000;

/** Returns the raw token (put it in the URL). Older unused links for the same phone are invalidated. */
export function createConnectLink(phone: string, now = Date.now()): string {
  const token = randomToken();
  db.run("DELETE FROM connect_links WHERE phone = ? AND used_at IS NULL", [phone]);
  db.run("INSERT INTO connect_links (token_hash, phone, expires_at) VALUES (?, ?, ?)", [sha256Hex(token), phone, now + CONNECT_LINK_TTL_MS]);
  return token;
}

/** Who a still-valid link belongs to, without using it up (GET must not consume it). */
export function peekConnectLink(token: string, now = Date.now()): string | null {
  const r = db
    .query<{ phone: string }, [string, number]>("SELECT phone FROM connect_links WHERE token_hash = ? AND used_at IS NULL AND expires_at > ?")
    .get(sha256Hex(token), now);
  return r?.phone ?? null;
}

/** Atomically burn the link; returns the phone, or null if it was already used or expired. */
export function consumeConnectLink(token: string, now = Date.now()): string | null {
  const r = db
    .query<{ phone: string }, [number, string, number]>("UPDATE connect_links SET used_at = ? WHERE token_hash = ? AND used_at IS NULL AND expires_at > ? RETURNING phone")
    .get(now, sha256Hex(token), now);
  return r?.phone ?? null;
}

// ---- contact-card links: random id (only its hash is stored), 7 days, good for the card and nothing else ----

export const CONTACT_LINK_TTL_MS = 7 * 24 * 3600_000;

/** Returns the raw id (put it in /contact/<id>). It is random: it carries no phone number and is unrelated to any connect token. */
export function createContactLink(phone: string, now = Date.now()): string {
  const id = randomToken();
  db.run("DELETE FROM contact_links WHERE expires_at <= ?", [now]);
  db.run("INSERT INTO contact_links (id_hash, phone, expires_at) VALUES (?, ?, ?)", [sha256Hex(id), phone, now + CONTACT_LINK_TTL_MS]);
  return id;
}

/** Who a still-valid contact link belongs to. Not single-use: Safari and iMessage's link preview may both open it. */
export function peekContactLink(id: string, now = Date.now()): string | null {
  return db.query<{ phone: string }, [string, number]>("SELECT phone FROM contact_links WHERE id_hash = ? AND expires_at > ?").get(sha256Hex(id), now)?.phone ?? null;
}

// ---- per-user LLM budget ----

export function addTokens(key: string, day: string, n: number) {
  db.run("INSERT INTO llm_usage (phone, day, tokens) VALUES (?, ?, ?) ON CONFLICT(phone, day) DO UPDATE SET tokens = tokens + excluded.tokens", [key, day, n]);
}

export function tokensToday(key: string, day: string): number {
  return db.query<{ tokens: number }, [string, string]>("SELECT tokens FROM llm_usage WHERE phone = ? AND day = ?").get(key, day)?.tokens ?? 0;
}

// ---- class schedules (per user) ----

export type ClassRow = { id: number; phone: string; course: string; days: string; start_min: number; end_min: number; location: string; term_start: string; term_end: string };
export type NewClass = Omit<ClassRow, "id" | "phone">;

export const listClasses = (key: string): ClassRow[] =>
  db.query<ClassRow, [string]>("SELECT * FROM classes WHERE phone = ? ORDER BY start_min, course, id").all(key);

/** Replace the whole schedule. */
export function replaceClasses(key: string, rows: NewClass[]) {
  db.transaction(() => {
    db.run("DELETE FROM classes WHERE phone = ?", [key]);
    for (const r of rows) insertClass(key, r);
  })();
}

export function insertClass(key: string, r: NewClass) {
  db.run("INSERT INTO classes (phone, course, days, start_min, end_min, location, term_start, term_end) VALUES (?, ?, ?, ?, ?, ?, ?, ?)", [
    key, r.course, r.days, r.start_min, r.end_min, r.location, r.term_start, r.term_end,
  ]);
}

/** Replace every row of one course (an edit), or add it. */
export function upsertClassByCourse(key: string, r: NewClass) {
  db.transaction(() => {
    db.run("DELETE FROM classes WHERE phone = ? AND course = ?", [key, r.course]);
    insertClass(key, r);
  })();
}

export const removeClassesByCourse = (key: string, course: string): number => db.run("DELETE FROM classes WHERE phone = ? AND course = ?", [key, course]).changes;
export const clearClasses = (key: string) => void db.run("DELETE FROM classes WHERE phone = ?", [key]);

/** skip = true: no class that date; skip = false: class is held even though the calendar says otherwise. */
export const setClassOverride = (key: string, date: string, skip: boolean) =>
  void db.run("INSERT INTO class_overrides (phone, date, skip) VALUES (?, ?, ?) ON CONFLICT(phone, date) DO UPDATE SET skip = excluded.skip", [key, date, skip ? 1 : 0]);
export const removeClassOverride = (key: string, date: string) => void db.run("DELETE FROM class_overrides WHERE phone = ? AND date = ?", [key, date]);
export const listClassOverrides = (key: string): Map<string, boolean> =>
  new Map(db.query<{ date: string; skip: number }, [string]>("SELECT date, skip FROM class_overrides WHERE phone = ?").all(key).map((r) => [r.date, r.skip === 1]));

export const setClassAlerts = (key: string, on: boolean) => void db.run("UPDATE users SET class_alerts = ? WHERE phone = ?", [on ? 1 : 0, key]);

// ---- GPA inputs (per user) ----

export const getCredits = (key: string): Map<string, number> =>
  new Map(db.query<{ course: string; credits: number }, [string]>("SELECT course, credits FROM course_credits WHERE phone = ?").all(key).map((r) => [r.course, r.credits]));
export const setCredits = (key: string, course: string, credits: number) =>
  void db.run("INSERT INTO course_credits (phone, course, credits) VALUES (?, ?, ?) ON CONFLICT(phone, course) DO UPDATE SET credits = excluded.credits", [key, course, credits]);
export const setPriorGpa = (key: string, gpa: number, hours: number) => void db.run("UPDATE users SET prior_gpa = ?, prior_hours = ? WHERE phone = ?", [gpa, hours, key]);
export const markGpaHintShown = (key: string) => void db.run("UPDATE users SET gpa_hint_shown = 1 WHERE phone = ?", [key]);

export const setPhotonUser = (key: string, id: string | null, number: string | null) =>
  void db.run("UPDATE users SET photon_user_id = ?, photon_number = ? WHERE phone = ?", [id, number, key]);

/** Last name and email are left as they were when not given ("/name Aarav" changes only the first name). */
export const setProfile = (key: string, p: { firstName: string; lastName?: string | null; email?: string | null }) =>
  void db.run("UPDATE users SET first_name = ?, last_name = COALESCE(?, last_name), email = COALESCE(?, email) WHERE phone = ?", [p.firstName, p.lastName ?? null, p.email ?? null, key]);

// ---- the first text to a newly enrolled person ----

export const setWelcomed = (key: string) => void db.run("UPDATE users SET welcomed = 1 WHERE phone = ?", [key]);
export const markWelcomeAttempt = (key: string, now = Date.now()) =>
  void db.run("UPDATE users SET welcome_tries = welcome_tries + 1, welcome_last = ? WHERE phone = ?", [now, key]);
/** Pending people whose welcome failed, haven't been tried since `olderThan`, and have tries left. */
export const listPendingWelcomes = (olderThan: number, maxTries: number): UserRow[] =>
  db.query<UserRow, [number, number]>("SELECT * FROM users WHERE status = 'pending' AND welcomed = 0 AND welcome_tries > 0 AND welcome_tries < ? AND welcome_last <= ?").all(maxTries, olderThan);

// ---- LLM usage per provider (UTC day), alongside the per-user budget ----

export type ProviderUsage = { provider: string; model: string; requests: number; tokens: number };
export const addProviderUsage = (day: string, provider: string, model: string, tokens: number) =>
  void db.run("INSERT INTO llm_provider_usage (day, provider, model, requests, tokens) VALUES (?, ?, ?, 1, ?) ON CONFLICT(day, provider, model) DO UPDATE SET requests = requests + 1, tokens = tokens + excluded.tokens", [day, provider, model, Math.max(0, Math.round(tokens))]);
export const providerUsageToday = (day: string): ProviderUsage[] =>
  db.query<ProviderUsage, [string]>("SELECT provider, model, requests, tokens FROM llm_provider_usage WHERE day = ?").all(day);

// ---- Paid providers: tokens per local (ET) day, for the daily spend cap and the monthly estimate ----

export const addPaidUsage = (day: string, provider: string, tokens: number) =>
  void db.run("INSERT INTO llm_paid_usage (day, provider, tokens) VALUES (?, ?, ?) ON CONFLICT(day, provider) DO UPDATE SET tokens = tokens + excluded.tokens", [day, provider, Math.max(0, Math.round(tokens))]);
export const paidTokensOn = (day: string, provider: string): number =>
  db.query<{ tokens: number }, [string, string]>("SELECT tokens FROM llm_paid_usage WHERE day = ? AND provider = ?").get(day, provider)?.tokens ?? 0;
/** Tokens for every day of a month ("2026-10"). */
export const paidTokensInMonth = (month: string, provider: string): number =>
  db.query<{ t: number | null }, [string, string]>("SELECT SUM(tokens) AS t FROM llm_paid_usage WHERE day LIKE ? || '-%' AND provider = ?").get(month, provider)?.t ?? 0;

/** Small durable flags (like "the owner was already told Cerebras ran out of credits"). */
export const getLlmFlag = (name: string): string | null => db.query<{ value: string }, [string]>("SELECT value FROM llm_flags WHERE name = ?").get(name)?.value ?? null;
export const setLlmFlag = (name: string, value: string | null) =>
  void (value === null ? db.run("DELETE FROM llm_flags WHERE name = ?", [name]) : db.run("INSERT INTO llm_flags (name, value) VALUES (?, ?) ON CONFLICT(name) DO UPDATE SET value = excluded.value", [name, value]));
