/**
 * Scrub real personal data out of a source tree, or check that none is left.
 *
 *   bun scripts/scrub.ts apply <dir> [--map FILE]    replace real identifiers with fictional ones
 *   bun scripts/scrub.ts check <dir> [--map FILE] [--env FILE] [--git]   fail (exit 1) if anything personal remains
 *                                      (--git: only files a commit would contain, not local state like .env)
 *
 * The real -> fake mapping lives in a LOCAL, gitignored file (default <repo>/.scrub.local), so this tool
 * itself contains no personal data. Format, one per line:
 *   REAL=>FAKE     replace everywhere (longest first), and `check` fails if REAL remains
 *   !REAL          `check` fails if REAL appears (no replacement)
 *   # comment
 * `check` also looks for things that should never be public regardless of the mapping: values from your .env,
 * email addresses, phone-shaped numbers (other than 555 test numbers), Claude session links/trailers,
 * Canvas/Groq token shapes, and files like .env, *.db and *.log.
 * Findings are printed as file:line with the matched text masked.
 */
import { existsSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join, relative, resolve } from "node:path";

export type Rules = { replace: [string, string][]; forbidden: string[] };
export type Finding = { file: string; line: number; rule: string };

const SKIP_DIRS = new Set([".git", "node_modules", ".railway"]);
const SKIP_FILES = new Set(["bun.lock", ".scrub.local"]);

export function parseMap(text: string): Rules {
  const rules: Rules = { replace: [], forbidden: [] };
  for (const raw of text.split("\n")) {
    const line = raw.replace(/\r$/, "");
    if (!line.trim() || line.trimStart().startsWith("#")) continue;
    if (line.startsWith("!")) rules.forbidden.push(line.slice(1));
    else {
      const i = line.indexOf("=>");
      if (i > 0) rules.replace.push([line.slice(0, i), line.slice(i + 2)]);
    }
  }
  rules.replace.sort((a, b) => b[0].length - a[0].length); // longest first, so "ECON 210" wins over "125"
  return rules;
}

export function* walk(dir: string): Generator<string> {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    const st = statSync(p);
    if (st.isDirectory()) {
      if (!SKIP_DIRS.has(name)) yield* walk(p);
    } else if (!SKIP_FILES.has(name)) yield p;
  }
}

const isText = (buf: Buffer) => !buf.subarray(0, 4096).includes(0);
const mask = (s: string) => (s.length <= 3 ? "***" : `${s.slice(0, 2)}${"*".repeat(Math.min(s.length - 2, 8))}`);
const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** Digits-only / phone-like strings must not match inside longer numbers; words are matched case-insensitively. */
function matcher(s: string): RegExp {
  const body = esc(s);
  return /^[+\d\s().-]+$/.test(s) ? new RegExp(`(?<!\\d)${body}(?!\\d)`) : new RegExp(body, "i");
}

// these files spell out the secret-shape patterns themselves (phone, email, mapped and .env checks still apply to them)
const SELF = new Set(["scripts/scrub.ts", "tests/scrub.test.ts"]);
const BAD_FILES = /(^|\/)(\.env|history\.json|canvas-bot\.db.*|.*\.db|.*\.db-journal|.*\.log|.*\.pem|id_rsa.*|\.scrub\.local)$/;

export function applyScrub(dir: string, rules: Rules): { files: number; replacements: number } {
  let files = 0, replacements = 0;
  const phones = phoneMap(rules);
  for (const f of walk(dir)) {
    if (BAD_FILES.test(relative(dir, f))) continue; // never rewrite .env, databases or logs: they are local state, not source
    const buf = readFileSync(f);
    if (!isText(buf)) continue;
    let text = buf.toString("utf8");
    const before = text;
    for (const [real, fake] of rules.replace) {
      const parts = text.split(real);
      if (parts.length > 1) {
        replacements += parts.length - 1;
        text = parts.join(fake);
      }
    }
    if (phones.size) {
      text = text.replace(PHONE_G(), (m) => {
        const k = last10(m);
        if (k && phones.has(k)) {
          replacements++;
          return (m.match(/^\s*/)?.[0] ?? "") + phones.get(k)!; // keep the space the pattern swallowed in front of the number
        }
        return m;
      });
    }
    if (text !== before) {
      writeFileSync(f, text);
      files++;
    }
  }
  return { files, replacements };
}

// Phone numbers are compared by their last 10 digits, so "+15551234567", "(555) 123-4567" and "555.123.4567" are the same number.
const PHONE_G = () => new RegExp(/\+?\d?[\s.(-]*\b[2-9]\d{2}[\s.)-]*\d{3}[\s.-]*\d{4}\b|\+1\d{10}/.source, "g");
const last10 = (s: string): string | null => {
  const d = s.replace(/\D/g, "");
  return d.length >= 10 ? d.slice(-10) : null;
};
const isPhoneLike = (s: string) => /^[+\d\s().-]+$/.test(s) && last10(s) !== null;

/** last-10-digits -> the fictional replacement, for every phone-like entry in the mapping. */
export function phoneMap(rules: Rules): Map<string, string> {
  const m = new Map<string, string>();
  for (const [real, fake] of rules.replace) {
    const k = isPhoneLike(real) ? last10(real) : null;
    if (k && (!m.has(k) || real.startsWith("+"))) m.set(k, fake); // prefer the "+1…" entry's replacement
  }
  return m;
}

const EMAIL = /[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)+/g;
const EMAIL_OK = /(@([a-z0-9-]+\.)*example\.(com|org)$|noreply@anthropic\.com$|^onboarding@resend\.dev$|@users\.noreply\.github\.com$|@(t|test|canvas-bot|atlas-test|email\.invalid)$|\.(ts|js|json|md)$|^[^@]*@\d)/i;
const PHONE = /\+?\d?[\s.(-]*\b[2-9]\d{2}[\s.)-]*\d{3}[\s.-]*\d{4}\b|\+1\d{10}/g;
const SECRET_SHAPES: [string, RegExp][] = [
  ["Groq key", /gsk_[A-Za-z0-9]{20,}/],
  ["Canvas token", /\b\d{3,6}~[A-Za-z0-9]{40,}/],
  ["private key", /-----BEGIN [A-Z ]*PRIVATE KEY-----/],
  ["Claude session link/trailer", /claude\.ai\/code\/session_|Claude-Session:/i],
  ["literal bearer token", /Bearer [A-Za-z0-9._~+/-]{30,}/],
];
export function parseEnvValues(text: string): { name: string; value: string }[] {
  const out: { name: string; value: string }[] = [];
  for (const line of text.split("\n")) {
    const m = line.match(/^([A-Z][A-Z0-9_]*)=(.*)$/);
    const value = m?.[2]?.trim().replace(/^["']|["']$/g, "");
    if (m && value && value.length >= 8 && /(TOKEN|KEY|SECRET|PASSWORD|EMAIL|ID|SENDERS)/.test(m[1]!)) out.push({ name: m[1]!, value });
  }
  return out;
}

export function checkTree(dir: string, rules: Rules, envValues: { name: string; value: string }[] = [], files?: string[]): Finding[] {
  const findings: Finding[] = [];
  const reals = [...rules.replace.map(([r]) => r), ...rules.forbidden].map((r) => ({ r, re: matcher(r) }));
  const bannedPhones = new Set<string>(phoneMap(rules).keys());
  for (const r of rules.forbidden) if (isPhoneLike(r)) bannedPhones.add(last10(r)!);
  for (const { value } of envValues) for (const part of value.split(",")) if (isPhoneLike(part.trim())) bannedPhones.add(last10(part)!);
  for (const f of files ?? walk(dir)) {
    const rel = relative(dir, f);
    if (BAD_FILES.test(rel)) findings.push({ file: rel, line: 0, rule: "file that must never be committed" });
    const buf = readFileSync(f);
    if (!isText(buf)) continue;
    const generic = !SELF.has(rel);
    buf.toString("utf8").split("\n").forEach((line, i) => {
      const add = (rule: string) => findings.push({ file: rel, line: i + 1, rule });
      for (const { r, re } of reals) if (re.test(line)) add(`mapped/forbidden "${mask(r)}"`);
      for (const m of line.matchAll(PHONE_G())) {
        const k = last10(m[0]);
        if (k && bannedPhones.has(k)) add(`mapped/forbidden phone ${mask(m[0].trim())}`);
      }
      for (const { name, value } of envValues) if (line.includes(value)) add(`value of ${name}`);
      for (const e of line.match(EMAIL) ?? []) if (!EMAIL_OK.test(e) && !rel.endsWith("bun.lock")) add(`email ${mask(e)}`);
      for (const p of line.match(PHONE) ?? []) {
        const n = p.replace(/\D/g, "").slice(-10);
        // fictional by convention: 555 area code or exchange, or one repeated digit (a placeholder like 0000000000)
        const fake = n.slice(0, 3) === "555" || n.slice(3, 6) === "555" || /^(\d)\1{9}$/.test(n);
        if (n.length === 10 && !fake) add(`phone-shaped ${mask(p)}`);
      }
      // this tool's own source and tests have to spell out the session-link / token patterns, so only THOSE detectors skip them
      if (generic) for (const [name, re] of SECRET_SHAPES) if (re.test(line)) add(name);
    });
  }
  return findings;
}

if (import.meta.main) {
  const [mode, dirArg, ...rest] = process.argv.slice(2);
  const flag = (n: string) => (rest.includes(n) ? rest[rest.indexOf(n) + 1] : undefined);
  if (!["apply", "check"].includes(mode ?? "") || !dirArg) {
    console.error("usage: bun scripts/scrub.ts apply|check <dir> [--map FILE] [--env FILE]");
    process.exit(2);
  }
  const dir = resolve(dirArg);
  const mapFile = flag("--map") ?? join(import.meta.dir, "..", ".scrub.local");
  if (!existsSync(mapFile)) {
    console.error(`no mapping file at ${mapFile}. Create it (REAL=>FAKE lines, !REAL for must-not-appear); see the header of scripts/scrub.ts.`);
    process.exit(2);
  }
  const rules = parseMap(readFileSync(mapFile, "utf8"));
  if (mode === "apply") {
    const r = applyScrub(dir, rules);
    console.log(`scrubbed ${r.replacements} occurrence(s) in ${r.files} file(s) (${rules.replace.length} replacement rules)`);
  } else {
    const envFile = flag("--env");
    const env = envFile && existsSync(envFile) ? parseEnvValues(readFileSync(envFile, "utf8")) : [];
    // --git: only what a commit would contain (tracked + new files that aren't gitignored), so local-only state like .env is out of scope
    const listed = rest.includes("--git") ? Bun.spawnSync(["git", "-C", dir, "ls-files", "-co", "--exclude-standard"]).stdout.toString().split("\n").filter(Boolean).filter((f) => !SKIP_FILES.has(f.split("/").pop()!)).map((f) => join(dir, f)) : undefined;
    const found = checkTree(dir, rules, env, listed);
    console.log(`checked ${(listed ?? [...walk(dir)]).length} files against ${rules.replace.length + rules.forbidden.length} mapped/forbidden strings, ${env.length} .env values and the generic detectors`);
    if (!found.length) console.log("RESULT: clean, nothing personal found");
    else {
      console.log(`RESULT: ${found.length} finding(s)`);
      for (const f of found.slice(0, 60)) console.log(`  ${f.file}${f.line ? ":" + f.line : ""}  ${f.rule}`);
      process.exit(1);
    }
  }
}
