import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { applyScrub, checkTree, parseEnvValues, parseMap } from "../scripts/scrub.ts";

// Everything here is invented: this tests the scrubber without any real personal data in the repo.

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "atlas-scrub-test-"));
  mkdirSync(join(dir, "src"));
  mkdirSync(join(dir, "node_modules"));
  mkdirSync(join(dir, ".git"));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));
const put = (rel: string, text: string | Buffer) => writeFileSync(join(dir, rel), text);
const get = (rel: string) => readFileSync(join(dir, rel), "utf8");

const MAP = `
# comment
+15551234567=>+15555550199
5551234567=>5555550199
Zed Quill=>Alex Doe
ZED=>ALEX
Quill=>Doe
BIOL 777=>DATA 101
Spinning: Cardio=>Piano: Scales
!Forbidden Word
!99887
`;

test("the mapping file parses: replacements longest-first, forbidden list, comments ignored", () => {
  const r = parseMap(MAP);
  expect(r.forbidden).toEqual(["Forbidden Word", "99887"]);
  expect(r.replace.map(([a]) => a)[0]).toBe("Spinning: Cardio"); // longest first
  expect(r.replace.find(([a]) => a === "Zed Quill")).toEqual(["Zed Quill", "Alex Doe"]);
  expect(r.replace.length).toBe(7);
});

test("apply replaces everywhere, longest match first, and skips .git, node_modules, bun.lock and binary files", () => {
  put("src/a.ts", 'const p = "+15551234567"; // call 5551234567\nconst n = "Zed Quill"; const BIOL = "BIOL 777"; // Spinning: Cardio\n');
  put("node_modules/x.js", "Zed Quill");
  put(".git/config", "Zed Quill");
  put("bun.lock", "Zed Quill");
  put("img.bin", Buffer.from([0, 1, 2, ...Buffer.from("Zed Quill")]));
  const r = applyScrub(dir, parseMap(MAP));
  expect(r).toEqual({ files: 1, replacements: 5 }); // phone x2, name, course, event
  expect(get("src/a.ts")).toBe('const p = "+15555550199"; // call 5555550199\nconst n = "Alex Doe"; const BIOL = "DATA 101"; // Piano: Scales\n');
  for (const untouched of ["node_modules/x.js", ".git/config", "bun.lock"]) expect(get(untouched)).toBe("Zed Quill");
  expect(readFileSync(join(dir, "img.bin")).includes(Buffer.from("Zed Quill"))).toBe(true);
  // applying again changes nothing: it's idempotent, so the publish script can re-run it safely
  expect(applyScrub(dir, parseMap(MAP))).toEqual({ files: 0, replacements: 0 });
});

test("apply never rewrites local state: .env, databases, logs, history", () => {
  for (const f of [".env", "canvas-bot.db", "bot.log", "history.json"]) put(f, "Zed Quill +15551234567");
  put(".env.example", "OWNER=Zed Quill"); // the committed template IS source, so it is scrubbed
  expect(applyScrub(dir, parseMap(MAP))).toEqual({ files: 1, replacements: 1 });
  for (const f of [".env", "canvas-bot.db", "bot.log", "history.json"]) expect(get(f)).toBe("Zed Quill +15551234567");
  expect(get(".env.example")).toBe("OWNER=Alex Doe");
});

test("check finds what's left of mapped or forbidden strings, case-insensitively, and masks what it reports", () => {
  put("src/a.ts", 'x\nname = "zed quill"\nlet y = "forbidden word"\nok line\n');
  const found = checkTree(dir, parseMap(MAP));
  expect(found.map((f) => `${f.file}:${f.line}`)).toEqual(["src/a.ts:2", "src/a.ts:2", "src/a.ts:2", "src/a.ts:3"]); // line 2 trips "Zed Quill", "ZED" and "Quill"; line 3 the forbidden word
  for (const f of found) {
    expect(f.rule).not.toContain("quill");
    expect(f.rule).not.toContain("Quill"); // never echoes the real value
    expect(f.rule).toMatch(/\*\*\*|\*{2,}/);
  }
});

test("digit strings are not matched inside longer numbers (no false alarms on timestamps or ids)", () => {
  put("src/a.ts", "const t = 1998877; const u = 99887;\nconst v = 2099887;\n");
  const found = checkTree(dir, parseMap(MAP));
  expect(found.map((f) => f.line)).toEqual([1]); // only the standalone 99887
});

test("clean trees pass, and fictional placeholders (555 numbers, repeated digits, example.com and subdomains) are allowed", () => {
  put("src/a.ts", 'const phone = "+15555550199"; const email = "person@example.com"; const alt = "+19195550100"; const z = "+10000000000"; const s = "+15559998888"; const h = "https://x.edu@evil.example.com";\n');
  put("README.md", "uid g@t and r1@t and a@canvas-bot are test ids; Co-Authored-By noreply@anthropic.com; author 1234+someuser@users.noreply.github.com\n");
  expect(checkTree(dir, parseMap(MAP))).toEqual([]);
});

// Strings that LOOK real (an email, a phone number, a session link) are assembled at runtime from fragments, so the source of
// this test never contains a real-looking value that a scan of the repo would have to wave through.
const glue = (...parts: string[]) => parts.join("");
const FAKE_EMAIL = glue("someone", "@", "gmail", ".com");
const FAKE_PHONE = glue("(", "999", ") ", "123", "-", "4567"); // area code 999 is unassigned

test("generic detectors catch things no mapping mentions: emails, real-looking phones, session links, token shapes, secrets from .env", () => {
  put("src/a.ts", [
    `const mail = "${FAKE_EMAIL}";`,
    `const phone = "${FAKE_PHONE}";`,
    "// " + glue("https://claude.ai/code/", "session_01abcDEF"),
    "// " + glue("Claude-", "Session: https://example.com"),
    `const g = "${glue("gsk", "_")}${"A".repeat(30)}";`,
    `const c = "123456~${"b".repeat(50)}";`,
    'const mine = "hunter2hunter2";',
  ].join("\n"));
  const env = parseEnvValues("LLM_API_KEY=hunter2hunter2\nBOT_NAME=Atlas\nPORT=8080\n");
  expect(env).toEqual([{ name: "LLM_API_KEY", value: "hunter2hunter2" }]); // only secret-looking, long-enough values
  const rules = checkTree(dir, parseMap(""), env).map((f) => f.rule);
  expect(rules.some((r) => r.startsWith("email so"))).toBe(true);
  expect(rules.some((r) => r.startsWith("phone-shaped"))).toBe(true);
  expect(rules).toContain("Claude session link/trailer");
  expect(rules).toContain("Groq key");
  expect(rules).toContain("Canvas token");
  expect(rules).toContain("value of LLM_API_KEY");
  for (const r of rules) expect(r).not.toContain("hunter2");
});

test("phone numbers are matched by their digits, in any formatting: replaced by apply, flagged by check", () => {
  const formats = ["+15551234567", "(555) 123-4567", "555.123.4567", "+1 555 123 4567", "555-123-4567", "5551234567"];
  put("src/a.ts", formats.map((f) => `call ${f}`).join("\n") + "\n");
  // the mapping only lists two spellings, yet every spelling is the same number
  const before = checkTree(dir, parseMap(MAP));
  expect(before.filter((f) => f.rule.startsWith("mapped/forbidden phone") || f.rule.startsWith("mapped/forbidden \"+1") || f.rule.startsWith("mapped/forbidden \"55")).length).toBeGreaterThanOrEqual(formats.length);
  applyScrub(dir, parseMap(MAP));
  // every spelling becomes the fictional number; the bare form uses the mapping's own bare replacement
  expect(get("src/a.ts").split("\n").filter(Boolean)).toEqual(formats.map((f) => (f === "5551234567" ? "call 5555550199" : "call +15555550199")));
  expect(checkTree(dir, parseMap(MAP))).toEqual([]);
});

test("a number listed as forbidden, or present in .env, is caught however it is written", () => {
  put("src/a.ts", `const a = "${glue("(", "999", ") ", "888", "-", "7777")}";\nconst b = "${glue("999", ".", "111", ".", "2222")}";\n`);
  const rules = parseMap(glue("!+1", "999", "888", "7777"));
  expect(checkTree(dir, rules).some((f) => f.line === 1 && f.rule.startsWith("mapped/forbidden phone"))).toBe(true);
  const env = parseEnvValues(glue("ALLOWED_SENDERS=+1", "999", "111", "2222", ",+15555550100\n"));
  expect(checkTree(dir, parseMap(""), env).some((f) => f.line === 2 && f.rule.startsWith("mapped/forbidden phone"))).toBe(true);
});

test("the scrubber's own files are exempt only from the session-link and token-shape detectors, never from phone or email checks", () => {
  mkdirSync(join(dir, "scripts"));
  put("scripts/scrub.ts", `// ${glue("Claude-", "Session:")}\nconst a = "${FAKE_PHONE}"; const b = "${FAKE_EMAIL}";\n`);
  const found = checkTree(dir, parseMap("")).map((f) => `${f.line}:${f.rule.split(" ")[0]}`);
  expect(found).toContain("2:phone-shaped");
  expect(found).toContain("2:email");
  expect(found.some((f) => f.startsWith("1:"))).toBe(false); // the session-link line is allowed in the tool's own source
});

test("files that must never ship are reported: .env, databases, logs, history", () => {
  for (const f of [".env", "canvas-bot.db", "bot.log", "history.json"]) put(f, "x");
  const found = checkTree(dir, parseMap(""));
  expect(found.map((f) => f.file).sort()).toEqual([".env", "bot.log", "canvas-bot.db", "history.json"]);
  expect(found.every((f) => f.rule === "file that must never be committed")).toBe(true);
});

test("the scrubber's own source and tests may contain the detector patterns without tripping them", () => {
  mkdirSync(join(dir, "scripts"));
  mkdirSync(join(dir, "tests"));
  put("scripts/scrub.ts", 'const re = /claude\\.ai\\/code\\/session_|Claude-Session:/i; // + "gsk_"\n');
  put("tests/scrub.test.ts", glue("Claude-", "Session: ", "https://claude.ai/code/", "session_x\n"));
  expect(checkTree(dir, parseMap(""))).toEqual([]);
});
