/** A phone number or email for logs: never the whole thing. "+19195550142" -> "+1919•••0142"; an email -> "a•••@•••". */
export function maskId(id: string | null | undefined): string {
  const s = String(id ?? "");
  if (!s) return "";
  if (s.includes("@")) return `${s[0]}•••@•••`;
  const digits = s.replace(/\D/g, "");
  if (digits.length < 8) return s.length > 4 ? `${s.slice(0, 2)}•••` : "•••";
  return `${s.startsWith("+") ? "+" : ""}${digits.slice(0, 4)}•••${digits.slice(-4)}`;
}

/** Free text (an error message) with any phone number or email in it masked, so a real error can be logged safely. */
export function maskText(text: string): string {
  return String(text)
    .replace(/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g, (m) => maskId(m))
    .replace(/\+?\d[\d\s().-]{8,}\d/g, (m) => maskId(m));
}
