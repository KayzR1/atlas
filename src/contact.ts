import { botName } from "./brand.ts";
import { createContactLink, getUser } from "./db.ts";
import type { FileAttachment } from "./outbound.ts";
import type { ContactInput } from "spectrum-ts";

// The "Save Pallas to Contacts" card: a vCard 3.0 with the user's own assigned Photon number and the app icon.
// assets/pallas-app-icon.png is the source; assets/pallas-contact-256.jpg is that icon resized to 256x256 JPEG (about 7 KB),
// so the card stays small and nothing has to resize images at runtime.

export const CONTACT_FILENAME = "Pallas.vcf";
export const CONTACT_NOTE = "Your semester, held up.";

/** A number we are willing to put in a card or a link: E.164 only. */
export const isE164 = (n: string | null | undefined): n is string => !!n && /^\+\d{7,15}$/.test(n);

let icon: Buffer | undefined;
async function iconBytes(): Promise<Buffer> {
  icon ??= Buffer.from(await Bun.file(new URL("../assets/pallas-contact-256.jpg", import.meta.url)).arrayBuffer());
  return icon;
}
const iconBase64 = async () => (await iconBytes()).toString("base64");

/** The same card as spectrum-ts's own "contact" content (it writes the photo itself); the file name comes from `name.formatted`. */
export async function contactInput(number: string): Promise<ContactInput> {
  if (!isE164(number)) throw new Error("not a phone number");
  const photo = await iconBytes();
  return {
    name: { formatted: botName(), first: botName() },
    org: { name: botName() },
    note: CONTACT_NOTE,
    phones: [{ value: number, type: "mobile" }],
    photo: { mimeType: "image/jpeg", read: async () => photo },
  };
}

/** vCard text values: backslash, comma, semicolon and newlines are escaped. */
const esc = (s: string) => s.replace(/\\/g, "\\\\").replace(/\n/g, "\\n").replace(/,/g, "\\,").replace(/;/g, "\;");

/** Lines over 75 characters are folded: CRLF plus one space (all of this card's content is ASCII, so characters are octets). */
function fold(line: string): string {
  if (line.length <= 75) return line;
  const parts = [line.slice(0, 75)];
  for (let i = 75; i < line.length; i += 74) parts.push(line.slice(i, i + 74));
  return parts.join("\r\n ");
}

export async function buildVcard(number: string): Promise<string> {
  if (!isE164(number)) throw new Error("not a phone number");
  const name = esc(botName());
  const lines = [
    "BEGIN:VCARD",
    "VERSION:3.0",
    `N:${name};;;;`,
    `FN:${name}`,
    `ORG:${name}`,
    `NOTE:${esc(CONTACT_NOTE)}`,
    `TEL;TYPE=CELL:${number}`,
    `PHOTO;ENCODING=b;TYPE=JPEG:${await iconBase64()}`,
    "END:VCARD",
  ];
  return lines.map(fold).join("\r\n") + "\r\n";
}

/** A fresh /contact/<id> link for this user, or null if we don't know their Pallas number. The id is random: no phone number, no connect token. */
export function contactPath(key: string): string | null {
  if (!isE164(getUser(key)?.photon_number)) return null;
  return `/contact/${createContactLink(key)}`;
}

/** The line under the card when it sends as an attachment (no link: the card is right above it). */
export const tapCardLine = () => `Tap the card above to save ${botName()} to your contacts.`;

/** Pallas.vcf as an attachment for this user (their own number in it), or null if we don't know their number. */
export async function contactFile(key: string, caption: string = tapCardLine()): Promise<FileAttachment | null> {
  const number = getUser(key)?.photon_number;
  if (!isE164(number)) return null;
  return { name: CONTACT_FILENAME, mimeType: "text/vcard", data: Buffer.from(await buildVcard(number), "utf8"), caption, card: await contactInput(number) };
}
