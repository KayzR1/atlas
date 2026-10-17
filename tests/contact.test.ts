import { beforeEach, expect, spyOn, test } from "bun:test";
import { CONTACT_LINK_TTL_MS, createConnectLink, createInvite, createPendingUser, ensureOwner, getUser, initDb, peekContactLink, setPhotonUser, wipeUser } from "../src/db.ts";
import { buildVcard, contactInput, contactPath } from "../src/contact.ts";
import { welcomeText } from "../src/welcome.ts";
import { makeWebHandler } from "../src/web.ts";
import type { Photon } from "../src/photon.ts";
import { handleInbound } from "../src/handler.ts";
import { ALICE, OWNER, addMember, harness } from "./helpers.ts";

// All mocks: no network, no real Photon.
const ASSIGNED = "+16285550199", PHONE = "+19195550142";
const BASE = "https://bot.example.com";
const unfold = (s: string) => s.replace(/\r\n /g, "");
const field = (vcf: string, name: string) => unfold(vcf).split("\r\n").find((l) => l.startsWith(name));

let sent: { to: string; text: string }[];
let t0: number;
const photon: Photon = { limit: 10, count: async () => 1, enroll: async () => ({ ok: true, id: "p1", assignedNumber: ASSIGNED, existing: false }), remove: async () => true, rename: async () => "updated" };
const handle = () => makeWebHandler({ send: async (to, text) => (sent.push({ to, text }), true), photon, ownerKey: OWNER, inviterName: "Sam", publicUrl: BASE, now: () => t0 });
const join = (h: ReturnType<typeof handle>, code: string) =>
  h(new Request(`${BASE}/join/${code}`, { method: "POST", body: new URLSearchParams({ first: "Jordan", last: "Rivers", email: "j@example.com", phone: "(919) 555-0142" }), headers: { "x-real-ip": "203.0.113.7" } }));

beforeEach(() => {
  initDb(":memory:");
  ensureOwner(OWNER);
  sent = [];
  t0 = Date.now();
});

test("the vCard is valid 3.0: required fields, CRLF, folded lines, escaped text, the user's own number", async () => {
  const vcf = await buildVcard(ASSIGNED);
  expect(vcf.startsWith("BEGIN:VCARD\r\nVERSION:3.0\r\n")).toBe(true);
  expect(vcf.endsWith("END:VCARD\r\n")).toBe(true);
  expect(vcf.split("\r\n").every((l) => l.length <= 75)).toBe(true);
  expect(vcf).not.toMatch(/[^\r]\n/); // every newline is CRLF
  expect(field(vcf, "N:")).toBe("N:Pallas;;;;");
  expect(field(vcf, "FN:")).toBe("FN:Pallas");
  expect(field(vcf, "ORG:")).toBe("ORG:Pallas");
  expect(field(vcf, "NOTE:")).toBe("NOTE:Your semester\\, held up."); // the comma is escaped
  expect(field(vcf, "TEL")).toBe(`TEL;TYPE=CELL:${ASSIGNED}`);
  await expect(buildVcard('+1"x')).rejects.toThrow();
});

test("the photo is embedded: base64 that decodes to a 256x256 JPEG, and the whole card stays small", async () => {
  const vcf = await buildVcard(ASSIGNED);
  const photo = field(vcf, "PHOTO;")!;
  expect(photo.startsWith("PHOTO;ENCODING=b;TYPE=JPEG:")).toBe(true);
  const bytes = Buffer.from(photo.split(":")[1]!, "base64");
  expect([bytes[0], bytes[1], bytes[2]]).toEqual([0xff, 0xd8, 0xff]); // JPEG magic
  // find the start-of-frame marker for the size: height then width, big-endian
  let i = 2, w = 0, h = 0;
  while (i < bytes.length) {
    const marker = bytes[i + 1]!;
    if (marker >= 0xc0 && marker <= 0xc3) { h = bytes.readUInt16BE(i + 5); w = bytes.readUInt16BE(i + 7); break; }
    i += 2 + bytes.readUInt16BE(i + 2);
  }
  expect([w, h]).toEqual([256, 256]);
  expect(vcf.length).toBeLessThan(15_000);
});

test("/contact/<id> serves the card as text/vcard named Pallas.vcf, with safe headers", async () => {
  createPendingUser(PHONE);
  setPhotonUser(PHONE, "p1", ASSIGNED);
  const path = contactPath(PHONE)!;
  const res = await handle()(new Request(`${BASE}${path}`));
  expect(res.status).toBe(200);
  expect(res.headers.get("Content-Type")).toMatch(/^text\/vcard/);
  expect(res.headers.get("Content-Disposition")).toBe('inline; filename="Pallas.vcf"');
  expect(res.headers.get("Cache-Control")).toBe("no-store");
  expect(res.headers.get("X-Content-Type-Options")).toBe("nosniff");
  expect(res.headers.get("Content-Security-Policy")).toBe("default-src 'none'; frame-ancestors 'none'");
  expect(field(await res.text(), "TEL")).toBe(`TEL;TYPE=CELL:${ASSIGNED}`);
});

test("the link expires after 7 days; wrong, malformed, other-method and post-wipe requests all fail", async () => {
  createPendingUser(PHONE);
  setPhotonUser(PHONE, "p1", ASSIGNED);
  const path = contactPath(PHONE)!;
  const id = path.split("/")[2]!;
  const at = (ms: number) => makeWebHandler({ send: async () => true, publicUrl: BASE, now: () => t0 + ms });
  expect((await at(CONTACT_LINK_TTL_MS - 1000)(new Request(`${BASE}${path}`))).status).toBe(200);
  const late = await at(CONTACT_LINK_TTL_MS + 1000)(new Request(`${BASE}${path}`));
  expect(late.status).toBe(410);
  expect(await late.text()).not.toContain("BEGIN:VCARD");
  expect(peekContactLink(id, t0 + CONTACT_LINK_TTL_MS + 1000)).toBeNull();
  expect((await handle()(new Request(`${BASE}/contact/${"x".repeat(43)}`))).status).toBe(410);
  expect((await handle()(new Request(`${BASE}/contact/short`))).status).toBe(410);
  expect((await handle()(new Request(`${BASE}${path}`, { method: "POST" }))).status).toBe(405);
  // a connect token is not a contact id
  expect((await handle()(new Request(`${BASE}/contact/${createConnectLink(PHONE)}`))).status).toBe(410);
  wipeUser(PHONE, "removed"); // removing someone kills their links
  expect((await handle()(new Request(`${BASE}${path}`))).status).toBe(410);
});

test("the id is random and leaks nothing: no phone digits, no connect token, hashed at rest, number never logged", async () => {
  createPendingUser(PHONE);
  setPhotonUser(PHONE, "p1", ASSIGNED);
  const connect = createConnectLink(PHONE);
  const a = contactPath(PHONE)!, b = contactPath(PHONE)!;
  expect(a).not.toBe(b);
  for (const p of [a, b]) {
    const id = p.split("/")[2]!;
    expect(id).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(id).not.toBe(connect);
    expect(p).not.toContain(PHONE.slice(1));
    expect(p).not.toContain(ASSIGNED.slice(1));
    expect(p).not.toContain("919");
    expect(peekContactLink(id)).toBe(PHONE);
  }
  const { db } = await import("../src/db.ts");
  const rows = db.query<{ id_hash: string; phone: string }, []>("SELECT id_hash FROM contact_links").all();
  expect(rows.some((r) => r.id_hash === a.split("/")[2])).toBe(false); // only the hash is stored
  const logs: string[] = [];
  const log = spyOn(console, "log").mockImplementation((...x: unknown[]) => void logs.push(x.join(" ")));
  const err = spyOn(console, "error").mockImplementation((...x: unknown[]) => void logs.push(x.join(" ")));
  await handle()(new Request(`${BASE}${a}`));
  log.mockRestore(); err.mockRestore();
  expect(logs.join("\n")).not.toContain(PHONE);
  expect(logs.join("\n")).not.toContain(ASSIGNED);
  expect(logs.join("\n")).not.toContain(a.split("/")[2]!);
});

test("no known Pallas number means no link and no card", async () => {
  createPendingUser(PHONE);
  expect(contactPath(PHONE)).toBeNull();
  expect(contactPath(OWNER)).toBeNull();
});

test("join success page: 'Save Pallas to Contacts' next to Open Messages, a bare /contact/<id> link, and the CSP is unchanged", async () => {
  const { code } = createInvite(OWNER);
  const res = await join(handle(), code);
  expect(res.status).toBe(200);
  const html = await res.text();
  expect(html).toContain(`<a class="btn big" href="sms:${ASSIGNED}&amp;body=hi">Open Messages</a><a class="btn alt" href="/contact/`);
  expect(html).toContain("Save Pallas to Contacts</a>");
  expect(html).toContain("needs Safari");
  const id = html.match(/href="\/contact\/([\w-]{43})"/)![1]!;
  expect(peekContactLink(id)).toBe(PHONE);
  const welcome = sent[0]!.text;
  const token = welcome.match(/\/connect\/([\w-]{43})/)![1]!;
  expect(html).not.toContain(token); // the connect token still never reaches the page
  expect(html).not.toContain("/connect/");
  expect(html).not.toContain("919");
  expect(html).not.toContain("<script");
  const csp = res.headers.get("Content-Security-Policy")!;
  expect(csp.replace(/nonce-[\w-]+/g, "nonce-X")).toBe("default-src 'none'; style-src 'nonce-X' https://fonts.googleapis.com; font-src https://fonts.gstatic.com; img-src https://i.ytimg.com; frame-src https://www.youtube-nocookie.com; form-action 'self'; base-uri 'none'; frame-ancestors 'none'");
});

test("the welcome text carries the same kind of link; without a number it is just the connect link", () => {
  createPendingUser(ALICE);
  expect(welcomeText(ALICE, { publicUrl: BASE })).not.toContain("/contact/");
  setPhotonUser(ALICE, "p2", ASSIGNED);
  const text = welcomeText(ALICE, { publicUrl: BASE, inviterName: "Sam" });
  expect(text).toMatch(/^Hi, I'm Pallas\. Sam invited you\. Connect your Canvas here: https:\/\/bot\.example\.com\/connect\/[\w-]{43}\nSave Pallas to Contacts: https:\/\/bot\.example\.com\/contact\/[\w-]{43}$/);
  expect(peekContactLink(text.match(/contact\/([\w-]{43})/)![1]!)).toBe(ALICE);
});

test("/contact: owner only, returns a fresh link for the sender, looks the number up if it isn't stored", async () => {
  const h = await harness();
  h.deps.publicUrl = BASE;
  await addMember(ALICE);
  await h.say("/contact", ALICE);
  expect(h.lastTo(ALICE)).toBe("That command is owner-only.");
  await h.say("/contact", OWNER);
  expect(h.lastTo(OWNER)).toContain("don't have your Pallas number");
  h.deps.ensurePallasNumber = async (key) => void setPhotonUser(key, "p-owner", ASSIGNED);
  await h.say("/contact", OWNER);
  expect(h.sent.at(-1)!.card?.phones).toEqual([ASSIGNED]); // spectrum-ts's contact card (with the photo), one short line under it
  expect(h.lastTo(OWNER)).toBe("Tap the card above to save Pallas to your contacts.");
  const { db } = await import("../src/db.ts");
  const links = () => db.query<{ n: number }, []>("SELECT COUNT(*) AS n FROM contact_links WHERE phone = '" + OWNER + "'").get()!.n;
  const before = links();
  await h.say("/contact", OWNER);
  expect(links()).toBe(before + 1); // a fresh link is made for the fallback each time
  expect(getUser(OWNER)?.photon_number).toBe(ASSIGNED);
});

// ---------- the card as an iMessage attachment (spectrum-ts attachment() inside group(), sent as one message) ----------

import { makeOutbound } from "../src/outbound.ts";
import { resolveContents } from "spectrum-ts";

test("/contact and the welcome reply send spectrum-ts's contact card (the user's own number, the photo) with one short line under it, no link", async () => {
  const h = await harness();
  h.deps.publicUrl = BASE;
  h.deps.ensurePallasNumber = async (key) => void setPhotonUser(key, "p-owner", ASSIGNED);
  await h.say("/contact", OWNER);
  const m = h.sent.at(-1)!;
  // the native contact content comes first, and it carries the photo
  expect(m.files).toEqual([]);
  expect(m.card).toMatchObject({ name: "Pallas", phones: [ASSIGNED], photoMime: "image/jpeg" });
  expect(m.card!.photo!.subarray(0, 3)).toEqual(Buffer.from([0xff, 0xd8, 0xff]));
  expect(m.card!.photo!.length).toBeLessThan(15_000);
  expect(m.text).toBe("Tap the card above to save Pallas to your contacts."); // one short line, no link
  expect(m.text).not.toContain("http");

  // a newly enrolled person's first text: the welcome comes with the card
  createPendingUser(ALICE);
  setPhotonUser(ALICE, "p2", ASSIGNED);
  await h.say("hi", ALICE);
  const w = h.sent.filter((s) => s.to === ALICE).at(-1)!;
  expect(w.card).toMatchObject({ name: "Pallas", phones: [ASSIGNED], photoMime: "image/jpeg" });
  // the Canvas connect link stays (it is the point of the welcome); the contact-link line becomes the short line
  expect(w.text).toMatch(/Connect your Canvas here: https:\/\/bot\.example\.com\/connect\/[\w-]{43}\nTap the card above to save Pallas to your contacts\.$/);
  expect(w.text).not.toContain("/contact/");
});

test("no known number: no attachment at all, just text", async () => {
  const h = await harness();
  createPendingUser(ALICE);
  await h.say("hi", ALICE);
  expect(h.sent.filter((s) => s.to === ALICE).at(-1)!.files).toBeUndefined(); // plain string send
});

test("outbound: the file goes out with its short caption, not the long text", async () => {
  const sentContent: unknown[] = [];
  const out = makeOutbound({ provider: "cloud" });
  await out.send(PHONE, "LONG fallback with link", "reply", { send: async (c: unknown) => void sentContent.push(c) }, { name: "Pallas.vcf", mimeType: "text/vcard", data: Buffer.from("x"), caption: "short line" });
  expect(sentContent).toHaveLength(1);
  const [top] = (await resolveContents(sentContent as any)) as any[];
  expect(top.items.map((i: any) => i.content.type === "text" ? i.content.text : i.content.name)).toEqual(["Pallas.vcf", "short line"]);
});

test("outbound: the contact card goes first with the photo; if it is refused the .vcf attachment is sent; if that fails too, the text", async () => {
  const mk = (accept: (kind: string) => boolean) => {
    const seen: string[] = [];
    return { seen, target: { send: async (c: unknown) => {
      if (typeof c === "string") return void seen.push("text");
      const [top] = (await resolveContents([c as any])) as any[];
      const kind = top.items[0].content.type as string;
      if (!accept(kind)) throw new Error("refused");
      seen.push(kind);
    } } };
  };
  const file = { name: "Pallas.vcf", mimeType: "text/vcard", data: Buffer.from("x"), caption: "short line", card: await contactInput(ASSIGNED) };
  const warn = spyOn(console, "warn").mockImplementation(() => {});
  const out = makeOutbound({ provider: "cloud" });
  const a = mk(() => true), b = mk((k) => k === "attachment"), c = mk(() => false);
  for (const x of [a, b, c]) await out.send(PHONE, "link text", "reply", x.target, file);
  warn.mockRestore();
  expect([a.seen, b.seen, c.seen]).toEqual([["contact"], ["attachment"], ["text"]]);
});

test("outbound: if the provider refuses the file, the text alone still goes out (and the number is masked in the log)", async () => {
  const calls: unknown[] = [];
  const target = { send: async (c: unknown) => { calls.push(c); if (typeof c !== "string") throw new Error(`attachments not allowed for ${PHONE}`); } };
  const warn = spyOn(console, "warn").mockImplementation(() => {});
  const out = makeOutbound({ provider: "cloud" });
  const ok = await out.send(PHONE, "link here", "reply", target, { name: "Pallas.vcf", mimeType: "text/vcard", data: Buffer.from("x"), caption: "short line" });
  const logged = warn.mock.calls.map((c) => c.join(" ")).join("\n");
  warn.mockRestore();
  expect(ok).toBe(true);
  expect(calls).toHaveLength(2); // no contact card given: the .vcf attachment, then the plain text
  expect(calls[1]).toBe("link here");
  expect(logged).toContain("attachment to");
  expect(logged).not.toContain(PHONE);
});

test("outbound: with no file the send is exactly the plain text, as before", async () => {
  const calls: unknown[] = [];
  const out = makeOutbound({ provider: "cloud" });
  await out.send(PHONE, "hello", "reply", { send: async (c: unknown) => void calls.push(c) });
  expect(calls).toEqual(["hello"]);
});

test("when the attachment fails, /contact falls back to the link and the Safari note; the welcome falls back to the connect link plus the contact link", async () => {
  const h = await harness();
  h.deps.publicUrl = BASE;
  h.deps.ensurePallasNumber = async (key) => void setPhotonUser(key, "p-owner", ASSIGNED);
  const warn = spyOn(console, "warn").mockImplementation(() => {});
  // a chat that refuses anything but plain text, like a provider without attachment support
  const sentText: string[] = [];
  const refusing = { send: async (c: unknown) => { if (typeof c !== "string") throw new Error("no attachments"); sentText.push(c); } };
  await handleInbound(refusing as any, { id: "m-x", direction: "inbound", sender: { id: OWNER }, content: { type: "text", text: "/contact" } } as any, h.deps);
  expect(sentText.at(-1)).toMatch(/^Save Pallas to Contacts: https:\/\/bot\.example\.com\/contact\/[\w-]{43}\nOpen it in Safari \(other browsers download the file instead\)\. The link works for 7 days\.$/);
  createPendingUser(ALICE);
  setPhotonUser(ALICE, "p2", ASSIGNED);
  await handleInbound(refusing as any, { id: "m-y", direction: "inbound", sender: { id: ALICE }, content: { type: "text", text: "hi" } } as any, h.deps);
  expect(sentText.at(-1)).toMatch(/\/connect\/[\w-]{43}\nSave Pallas to Contacts: https:\/\/bot\.example\.com\/contact\/[\w-]{43}$/);
  warn.mockRestore();
});

test("the PHOTO line is exactly ENCODING=b;TYPE=JPEG:<base64>, folded as CRLF+space at 75 octets, and unfolds to the clean 256x256 JPEG file", async () => {
  const vcf = await buildVcard(ASSIGNED);
  const lines = vcf.split("\r\n");
  const i = lines.findIndex((l) => l.startsWith("PHOTO"));
  expect(lines[i]!.startsWith("PHOTO;ENCODING=b;TYPE=JPEG:/9j/")).toBe(true); // "/9j/" is a JPEG's first bytes in base64
  expect(lines[i]!.length).toBe(75);
  let j = i + 1;
  while (lines[j]!.startsWith(" ")) { expect(lines[j]!.length).toBeLessThanOrEqual(75); j++; }
  expect(lines[j]).toBe("END:VCARD");
  const file = Buffer.from(await Bun.file(new URL("../assets/pallas-contact-256.jpg", import.meta.url)).arrayBuffer());
  const b64 = unfold(vcf).split("\r\n").find((l) => l.startsWith("PHOTO"))!.split(":")[1]!;
  expect(Buffer.from(b64, "base64").equals(file)).toBe(true);
  // no Exif / Photoshop metadata segments in the JPEG (only the image and its JFIF header)
  const markers: number[] = [];
  for (let p = 2; p < file.length && file[p] === 0xff && file[p + 1] !== 0xda; p += 2 + file.readUInt16BE(p + 2)) markers.push(file[p + 1]!);
  expect(markers.filter((m) => m === 0xe1 || (m >= 0xed && m <= 0xef))).toEqual([]);
});
