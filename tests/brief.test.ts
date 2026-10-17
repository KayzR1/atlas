import { Database } from "bun:sqlite";
import { beforeEach, expect, test } from "bun:test";
import { runWithContext } from "../src/context.ts";
import { initDb, ensureOwner, getUser, listActiveUsers, setBriefTime } from "../src/db.ts";
import { parseBriefTime, runBrief, startScheduler, type Deps } from "../src/notify.ts";
import { handleClassMessage } from "../src/classes.ts";
import { harness, OWNER } from "./helpers.ts";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const ME = "+15555550100";
let now: Date;
let events: string[] | null;
let sent: string[];
const send = async (_k: string, t: string) => (sent.push(t), true);
const deps = (): Deps => ({
  now: () => now,
  courses: async () => [{ id: 1, name: "Econ", code: "ECON210.001.FA26", current_score: null, current_grade: null }],
  assignments: async () => [{ id: 5, name: "Essay", due_at: new Date(now.getTime() + 20 * 3600_000).toISOString(), points_possible: 10, submission_types: ["online_upload"], submission: { score: null, workflow_state: "unsubmitted", submitted_at: null, missing: false, excused: false } }],
  announcements: async () => [],
  missing: async () => [{ id: 9, course_id: 1, name: "Quiz 2", due_at: new Date(now.getTime() - 3 * 86400_000).toISOString() }],
  events: async () => events,
  summarize: async (t) => t,
});

beforeEach(() => {
  initDb(":memory:");
  ensureOwner(ME);
  sent = [];
  now = new Date("2026-10-19T11:00:00Z"); // Mon 7:00 AM EDT
  events = ["10am-11am Study group", "3pm-3:15pm Reminder: Email the advisor"];
});

test("parseBriefTime", () => {
  expect(parseBriefTime("7:00")).toBe("07:00");
  expect(parseBriefTime("7")).toBe("07:00");
  expect(parseBriefTime("6:30 am")).toBe("06:30");
  expect(parseBriefTime("off")).toBe("off");
  expect(parseBriefTime("on")).toBe("07:00");
  expect(parseBriefTime("11:00")).toBe("11:00");
  expect(parseBriefTime("11:30")).toBeNull();
  expect(parseBriefTime("3")).toBeNull();
  expect(parseBriefTime("25:00")).toBeNull();
  expect(parseBriefTime("soon")).toBeNull();
});

test("a new user's brief time defaults to 7:00", () => {
  expect(getUser(ME)?.brief_time).toBe("07:00");
});

test("section order: classes, calendar events, due, missing, reminders", async () => {
  await runWithContext({ key: ME, role: "owner", timezone: "America/New_York", canvasUrl: "x", canvasToken: "x" }, async () => {
    await handleClassMessage(ME, "my classes\nECON 210 MWF 9:05-9:55 Gardner 305", { now: () => now });
    await handleClassMessage(ME, "yes", { now: () => now });
    expect(await runBrief(ME, deps(), send)).toBe("sent");
  });
  const text = sent[0]!;
  const at = (s: string) => text.indexOf(s);
  expect(at("Classes:")).toBeGreaterThan(0);
  expect(at("Today: 10am-11am Study group")).toBeGreaterThan(at("Classes:"));
  expect(at("Due in the next 48h")).toBeGreaterThan(at("Today:"));
  expect(at("Missing:")).toBeGreaterThan(at("Due in the next 48h"));
  expect(at("Reminders today:")).toBeGreaterThan(at("Missing:"));
  expect(text).not.toContain("Today: 10am-11am Study group; 3pm");
  expect(text).toContain("Reminders today: 3pm Email the advisor");
});

test("members (no calendar) get no calendar or reminder sections", async () => {
  events = null;
  await runBrief(ME, deps(), send);
  expect(sent[0]).not.toContain("Today:");
  expect(sent[0]).not.toContain("Reminders");
});

const tickAt = async (iso: string) => {
  now = new Date(iso);
  const before = sent.filter((t) => t.startsWith("Good morning")).length;
  const sched = startScheduler({ users: () => listActiveUsers(), contextFor: async (u) => ({ key: u.phone, role: "owner", timezone: u.timezone, canvasUrl: "x", canvasToken: "x" }), deps: deps(), send });
  await sched.tick();
  sched.stop();
  return sent.filter((t) => t.startsWith("Good morning")).length - before;
};

test("scheduler: 7:00-10:00 window, once a day", async () => {
  expect(await tickAt("2026-10-19T10:50:00Z")).toBe(0); // 6:50 AM
  expect(await tickAt("2026-10-19T11:05:00Z")).toBe(1); // 7:05 AM
  expect(await tickAt("2026-10-19T11:30:00Z")).toBe(0); // already sent
  expect(await tickAt("2026-10-20T13:59:00Z")).toBe(1); // next day, 9:59 AM catch-up
  expect(await tickAt("2026-10-21T14:01:00Z")).toBe(0); // 10:01 AM: window over
});

test("a custom time and 'off' are respected", async () => {
  setBriefTime(ME, "08:30");
  expect(await tickAt("2026-10-19T11:05:00Z")).toBe(0);
  expect(await tickAt("2026-10-19T12:35:00Z")).toBe(1);
  setBriefTime(ME, "off");
  expect(await tickAt("2026-10-20T11:05:00Z")).toBe(0);
  expect(await tickAt("2026-10-20T12:00:00Z")).toBe(0);
  expect(await runBrief(ME, deps(), send)).toBe("skipped");
});

test("/brief command shows, sets, validates", async () => {
  const h = await harness();
  await h.say("/brief");
  expect(h.lastTo(OWNER)).toContain("Morning brief at 7:00 AM");
  await h.say("/brief 6:30");
  expect(h.lastTo(OWNER)).toBe("Morning brief set to 6:30 AM.");
  expect(getUser(OWNER)?.brief_time).toBe("06:30");
  await h.say("/brief 3pm");
  expect(h.lastTo(OWNER)).toContain("Try");
  expect(getUser(OWNER)?.brief_time).toBe("06:30");
  await h.say("/brief off");
  expect(h.lastTo(OWNER)).toBe("Morning brief off.");
  await h.say("/brief");
  expect(h.lastTo(OWNER)).toContain("is off");
  await h.say("/brief on");
  expect(getUser(OWNER)?.brief_time).toBe("07:00");
});

test("existing databases: the old 08:00 default becomes 07:00 once; later choices stick", () => {
  const dir = mkdtempSync(join(tmpdir(), "brief-migrate-"));
  const path = join(dir, "test.db");
  const raw = new Database(path, { create: true });
  raw.exec(`CREATE TABLE users (phone TEXT PRIMARY KEY, timezone TEXT NOT NULL, notify INTEGER NOT NULL DEFAULT 1, paused INTEGER NOT NULL DEFAULT 0, seeded INTEGER NOT NULL DEFAULT 0, brief_time TEXT NOT NULL DEFAULT '08:00', space_id TEXT, created_at INTEGER NOT NULL);
    INSERT INTO users (phone, timezone, created_at) VALUES ('+15555550100', 'America/New_York', 1);`);
  raw.close();
  try {
    initDb(path);
    expect(getUser(ME)?.brief_time).toBe("07:00");
    setBriefTime(ME, "08:00"); // the user picks 8:00 on purpose
    initDb(path); // restart
    expect(getUser(ME)?.brief_time).toBe("08:00");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
