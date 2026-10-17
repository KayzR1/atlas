import { Spectrum } from "spectrum-ts";
import { llmParseClasses, runAgent } from "./agent.ts";
import { handleClassMessage } from "./classes.ts";
import { handleGpaMessage } from "./gpa.ts";
import { maskId } from "./mask.ts";
import { photonFromEnv } from "./photon.ts";
import { runRebrandNotices } from "./rebrand.ts";
import { handleConfirmation, resolveChoice } from "./calendar.ts";
import { runWithContext } from "./context.ts";
import { parseEncryptionKey } from "./crypto.ts";
import { ensureOwner, ensureUser, getUser, initDb, listActiveUsers, setPhotonUser, normalizeId, releaseLease, tryAcquireLease } from "./db.ts";
import type { DueScope } from "./assignments.ts";
import { handleInbound, type Access } from "./handler.ts";
import { dueText } from "./canvas.ts";
import { gradeReport } from "./grades.ts";
import { planWeek } from "./planner.ts";
import { contextFor } from "./users.ts";
import { startWebServer } from "./web.ts";
import { realDeps, runAll, startScheduler } from "./notify.ts";
import { makeOutbound } from "./outbound.ts";
import { setLlmAlertHandler } from "./llm.ts";
import { hostname, tmpdir } from "node:os";
import { join } from "node:path";

const providerName = (process.env.PROVIDER || "terminal").toLowerCase();
const startedAt = Date.now();

const allowed = (process.env.ALLOWED_SENDERS || "")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean)
  .map(normalizeId);

// Invites and web onboarding are on only when both are configured; otherwise the bot behaves as a single-user bot.
const publicUrl = (process.env.PUBLIC_URL || "").trim().replace(/\/+$/, "");
const multiUser = !!(publicUrl && process.env.ENCRYPTION_KEY);
if (process.env.ENCRYPTION_KEY || publicUrl) {
  if (!multiUser) console.warn("multi-user needs both PUBLIC_URL and ENCRYPTION_KEY; running single-user");
  else {
    try {
      parseEncryptionKey();
    } catch (e) {
      console.error(e instanceof Error ? e.message : e);
      process.exit(1);
    }
    if (!publicUrl.startsWith("https://")) console.warn("PUBLIC_URL is not https; connect links would travel unencrypted");
  }
}

// The owner is the first ALLOWED_SENDERS entry and keeps using CANVAS_TOKEN from the environment.
const owner = allowed[0] ?? "terminal";
/** Enrolls invited numbers on the shared Photon plan (null off Photon cloud). */
const photon = photonFromEnv();

function isOwnerKey(key: string): boolean {
  if (providerName === "terminal") return true;
  return key === owner || (!multiUser && allowed.includes(key)); // single-user mode: every allowed sender is trusted as before
}

function access(senderId: string | undefined): Access {
  if (providerName === "terminal") return "owner";
  if (!senderId) return "stranger";
  const key = normalizeId(senderId);
  if (isOwnerKey(key)) return "owner";
  if (!multiUser) return "stranger";
  const status = getUser(key)?.status;
  if (status === "active") return "member";
  if (status === "pending") return "pending";
  return "stranger";
}

async function ctxForKey(key: string) {
  const user = getUser(key);
  if (!user) throw new Error("unknown user");
  return contextFor({ ...user, role: isOwnerKey(key) ? "owner" : "member" });
}

async function buildProvider() {
  switch (providerName) {
    case "cloud": {
      const { imessage } = await import("spectrum-ts/providers/imessage");
      return { providers: [imessage.config()], platform: imessage };
    }
    case "local": {
      const { localIMessage } = await import("@spectrum-ts/imessage-local");
      return { providers: [localIMessage.config()], platform: localIMessage };
    }
    case "terminal": {
      const { terminal } = await import("spectrum-ts/providers/terminal");
      return { providers: [terminal.config()], platform: undefined };
    }
    default:
      throw new Error(`Unknown PROVIDER "${providerName}" (use cloud|local|terminal)`);
  }
}

const dryRun = process.argv.includes("--dry-run");

if (dryRun) {
  // Work on a throwaway copy of the DB: print what would be sent, change nothing real.
  const real = process.env.DB_PATH || "canvas-bot.db";
  const copy = join(tmpdir(), `canvas-bot-dryrun-${Date.now()}.db`);
  if (await Bun.file(real).exists()) await Bun.write(copy, Bun.file(real));
  initDb(copy);
  ensureOwner(owner);
  const out = makeOutbound({ provider: providerName, dryRun: true });
  const ctx = await ctxForKey(owner);
  const flag = (n: string) => (process.argv.includes(n) ? process.argv[process.argv.indexOf(n) + 1] : undefined);
  if (flag("--grade")) {
    // grade calculator against real Canvas: no messages, no LLM.  --grade "ECON 210" [--target A] [--assignment X | --group "Final Exam"] [--assume 90]
    const assume = flag("--assume");
    console.log(await runWithContext(ctx, () => gradeReport({ course: flag("--grade")!, target: flag("--target"), assignment: flag("--assignment"), group: flag("--group"), assume_rest_percent: assume ? Number(assume) : undefined })));
    await Bun.file(copy).delete();
    process.exit(0);
  }
  await runWithContext(ctx, () => runAll(owner, realDeps, out.send, { previewAll: process.argv.includes("--preview-all") }));
  await Bun.file(copy).delete();
  process.exit(0);
}

initDb();

// Only one instance may run on a database. A second one waits, then gives up (never answers twice).
const instanceId = `${hostname()}-${process.pid}`;
for (let waited = 0; !tryAcquireLease(instanceId); waited += 5) {
  if (waited >= 180) {
    console.error("another instance still holds the lease after 3 minutes; exiting");
    process.exit(1);
  }
  if (waited === 0) console.warn("another instance is running on this database; waiting for it to stop...");
  await Bun.sleep(5000);
}
const heartbeat = setInterval(() => {
  if (!tryAcquireLease(instanceId)) {
    console.error("lost the instance lease to another process; exiting");
    process.exit(1);
  }
}, 15_000);

ensureOwner(owner);
if (!multiUser) for (const a of allowed) ensureUser(a);
else if (allowed.length > 1) console.warn("multi-user is on: extra ALLOWED_SENDERS entries are ignored; use /invite instead");

if (providerName !== "terminal" && allowed.length === 0) {
  console.error("ALLOWED_SENDERS is empty; refusing to answer anyone. Set it in .env.");
}

const { providers, platform } = await buildProvider();
const app = await Spectrum({ providers: providers as any });
const out = makeOutbound({ provider: providerName, app, platform });
setLlmAlertHandler((text) => out.send(owner, text, "notify"));
console.log(`canvas-bot running (provider=${providerName}, ${multiUser ? "multi-user" : "single-user"}). Owner: ${maskId(owner)}`);

/** Learn this person's assigned Pallas number from Photon if it isn't stored yet (read-only: never enrolls anyone). */
const ensurePallasNumber = photon
  ? async (key: string) => {
      if (getUser(key)?.photon_number) return;
      const found = await photon.lookup?.(key);
      if (found?.assignedNumber) setPhotonUser(key, found.id, found.assignedNumber);
    }
  : undefined;

const scheduler = startScheduler({
  users: () => (multiUser ? listActiveUsers() : [getUser(owner)!]),
  contextFor: (u) => ctxForKey(u.phone),
  deps: realDeps,
  send: out.send,
  welcome: multiUser ? { publicUrl, inviterName: process.env.OWNER_NAME } : undefined,
});
const web = multiUser ? startWebServer({ send: out.send, photon, ownerKey: owner, inviterName: process.env.OWNER_NAME, publicUrl }) : null;

async function shutdown(signal: string) {
  console.log(`${signal}: shutting down`);
  clearInterval(heartbeat);
  scheduler.stop();
  web?.stop();
  releaseLease(instanceId);
  try {
    await Promise.race([app.stop(), Bun.sleep(3000)]);
  } finally {
    process.exit(0);
  }
}
process.on("SIGTERM", () => void shutdown("SIGTERM"));
process.on("SIGINT", () => void shutdown("SIGINT"));

const deps = {
  provider: providerName,
  multiUser,
  inviterName: process.env.OWNER_NAME,
  access,
  send: out.send,
  rememberSpace: out.rememberSpace,
  agent: runAgent,
  confirm: handleConfirmation,
  gpa: (key: string, text: string) => handleGpaMessage(key, text),
  classes: (key: string, text: string) => handleClassMessage(key, text, { llmParse: llmParseClasses }),
  choose: resolveChoice,
  due: (scope: DueScope) => dueText(scope),
  plan: async (key: string) => (await planWeek(key)).text,
  contextFor: ctxForKey,
  startedAt,
  nextCheckAt: scheduler.nextCheckAt,
  publicUrl,
  renamePhoton: photon ? (key: string, name: { firstName: string; lastName: string | null }) => photon.rename(key, name) : undefined,
  ensurePallasNumber,
  unenroll: photon ? (key: string, photonUserId: string | null) => photon.remove(photonUserId, key) : undefined,
};

// the one-time "Atlas is now Pallas" text for people who were already using the bot (marked per person, so a restart never resends it)
setTimeout(() => {
  runRebrandNotices(listActiveUsers(), out.send, { publicUrl, ensureNumber: ensurePallasNumber }).catch((e) => console.error("rebrand notice failed:", e instanceof Error ? e.name : "error"));
}, 15_000);

for await (const [space, message] of app.messages) {
  try {
    await handleInbound(space, message, deps);
  } catch (e) {
    console.error("message handling failed:", e instanceof Error ? e.message : e);
  }
}
