/**
 * Run Pallas against FAKE data so you can record a demo without showing anything real.
 *   bun run demo          (needs your normal .env for PROVIDER / Photon credentials / ALLOWED_SENDERS)
 * Only one process may answer a Photon line: stop the production deployment first (see docs/DEMO.md).
 */
import { rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startDemoCanvas } from "./demo-canvas.ts";

const port = Number(process.env.DEMO_PORT) || 8787;
const server = startDemoCanvas(port);
const db = join(tmpdir(), "pallas-demo.db");
for (const f of [db, `${db}-journal`]) rmSync(f, { force: true }); // every demo starts clean

Object.assign(process.env, {
  CANVAS_URL: `http://localhost:${server.port}`,
  CANVAS_TOKEN: "demo-token",
  DB_PATH: db,
  // no calendar, no onboarding web server, no multi-user: just the Canvas features, on fake data
  ICLOUD_EMAIL: "",
  ICLOUD_APP_PASSWORD: "",
  PUBLIC_URL: "",
  ENCRYPTION_KEY: "",
});

console.log(`
  Pallas DEMO MODE: all Canvas data is fake (fictional courses DATA 101, ECON 210, ENGL 150).
  fake Canvas: http://localhost:${server.port}    demo database: ${db}
  Try: "what's due this week", "what do I need on the final to get an A in econ 210", "late policy in data 101", "any announcements"
  Stop with Ctrl+C. Then restore production (docs/DEMO.md, last section).
`);
await import("../src/index.ts");
