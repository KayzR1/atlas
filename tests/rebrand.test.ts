import { beforeEach, expect, test } from "bun:test";
import { ensureOwner, initDb, getUser, getLlmFlag, listActiveUsers, setPhotonUser, setUserFlag, wasNotified, createPendingUser, db } from "../src/db.ts";
import { REBRAND_KEY, runRebrandNotices } from "../src/rebrand.ts";
import type { FileAttachment } from "../src/outbound.ts";
import { ALICE, BOB, OWNER, addMember } from "./helpers.ts";

// Mocks only: nothing here can message anyone.
const NUMBER = "+16285550199";
type Sent = { to: string; text: string; file?: FileAttachment };
let sent: Sent[];
let ok: boolean;
const send = async (to: string, text: string, _k: string, _s?: unknown, file?: FileAttachment) => (sent.push({ to, text, file }), ok);
const TEXT = "Quick update: Atlas is now Pallas. Same assistant, new name. Tap the card to update your contact.";

beforeEach(async () => {
  initDb(":memory:");
  ensureOwner(OWNER);
  await addMember(ALICE);
  setPhotonUser(OWNER, "po", NUMBER);
  setPhotonUser(ALICE, "pa", NUMBER);
  sent = [];
  ok = true;
  delete process.env.BOT_NAME;
});

test("existing active users each get one text with the new contact card, and the card's own line is the instruction", async () => {
  const r = await runRebrandNotices(listActiveUsers(), send, { publicUrl: "https://bot.example.com" });
  expect(r).toEqual({ sent: 2, failed: 0, skipped: 0 });
  expect(sent.map((s) => s.to).sort()).toEqual([ALICE, OWNER].sort());
  for (const s of sent) {
    expect(s.file?.caption).toBe(TEXT); // with the card: the short line
    expect(s.file?.card?.name?.formatted).toBe("Pallas");
    expect(s.file?.card?.phones?.[0]?.value).toBe(NUMBER);
    expect(s.text).toContain("Update your contact: https://bot.example.com/contact/"); // the fallback if the card can't go out
    expect(s.text).not.toContain("Tap the card");
  }
});

test("once only: marked before sending, so a restart (a second run on the same database) sends nothing", async () => {
  await runRebrandNotices(listActiveUsers(), send);
  expect(wasNotified(ALICE, REBRAND_KEY) && wasNotified(OWNER, REBRAND_KEY)).toBe(true);
  expect(getLlmFlag("rebrand-done")).toBe("1");
  await runRebrandNotices(listActiveUsers(), send); // restart
  expect(sent).toHaveLength(2);
  // marked before the send: even a send that is in flight when the process dies is never repeated
  let markedDuringSend = false;
  initDb(":memory:"); ensureOwner(OWNER); setPhotonUser(OWNER, "po", NUMBER);
  await runRebrandNotices(listActiveUsers(), async (to) => { markedDuringSend = wasNotified(to, REBRAND_KEY); return true; });
  expect(markedDuringSend).toBe(true);
});

test("people who sign up after the first run never get it (they never knew the old name)", async () => {
  await runRebrandNotices(listActiveUsers(), send);
  sent.length = 0;
  db.run("DELETE FROM llm_flags WHERE name = 'rebrand-done'"); // as if the first run had left someone waiting
  await new Promise((r) => setTimeout(r, 5));
  await addMember(BOB);
  await runRebrandNotices(listActiveUsers(), send);
  expect(sent.map((s) => s.to)).not.toContain(BOB);
});

test("pending users are skipped; paused or quiet users wait (not marked) and get it once they are back", async () => {
  createPendingUser("+19195550177");
  setUserFlag(ALICE, "paused", true);
  const r = await runRebrandNotices(listActiveUsers(), send);
  expect(sent.map((s) => s.to)).toEqual([OWNER]);
  expect(r.sent).toBe(1);
  expect(wasNotified(ALICE, REBRAND_KEY)).toBe(false);
  expect(getLlmFlag("rebrand-done")).toBeNull(); // someone is still waiting, so the next start tries again
  setUserFlag(ALICE, "paused", false);
  await runRebrandNotices(listActiveUsers(), send);
  expect(sent.map((s) => s.to)).toEqual([OWNER, ALICE]);
  expect(getLlmFlag("rebrand-done")).toBe("1");
});

test("a failed send is unmarked and retried on the next start, never duplicated once it lands", async () => {
  ok = false;
  const r1 = await runRebrandNotices(listActiveUsers(), send);
  expect(r1.failed).toBe(2);
  expect(wasNotified(OWNER, REBRAND_KEY)).toBe(false);
  expect(getLlmFlag("rebrand-done")).toBeNull();
  ok = true;
  sent.length = 0;
  const r2 = await runRebrandNotices(listActiveUsers(), send);
  expect(r2.sent).toBe(2);
  await runRebrandNotices(listActiveUsers(), send);
  expect(sent).toHaveLength(2);
});

test("no number on file: plain text without 'Tap the card', no attachment", async () => {
  setPhotonUser(ALICE, null, null);
  await runRebrandNotices(listActiveUsers(), send);
  const a = sent.find((s) => s.to === ALICE)!;
  expect(a.text).toBe("Quick update: Atlas is now Pallas. Same assistant, new name.");
  expect(a.file).toBeUndefined();
});

test("a number we can look up is learned first, so the owner gets the card too", async () => {
  setPhotonUser(OWNER, null, null);
  await runRebrandNotices(listActiveUsers(), send, { ensureNumber: async (k) => void setPhotonUser(k, "po", NUMBER) });
  expect(sent.find((s) => s.to === OWNER)!.file?.card?.phones?.[0]?.value).toBe(NUMBER);
  expect(getUser(OWNER)?.photon_number).toBe(NUMBER);
});

test("it only goes out when the bot really is named Pallas (BOT_NAME in the environment can still say Atlas)", async () => {
  process.env.BOT_NAME = "Atlas";
  const r = await runRebrandNotices(listActiveUsers(), send);
  delete process.env.BOT_NAME;
  expect(r).toEqual({ sent: 0, failed: 0, skipped: 0 });
  expect(sent).toEqual([]);
  expect(wasNotified(OWNER, REBRAND_KEY)).toBe(false);
  expect(getLlmFlag("rebrand-cutoff")).toBeNull();
});
