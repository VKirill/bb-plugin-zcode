#!/usr/bin/env node
// Fake bundled ZCode CLI for tests. Records argv/env, optionally sleeps, prints one --json object.
import fs from "node:fs";
import path from "node:path";

const argv = process.argv.slice(2);
function flag(name) {
  const i = argv.indexOf(name);
  return i >= 0 ? argv[i + 1] : undefined;
}
const recDir = process.env.FAKE_ZCODE_RECORD;
if (!recDir) {
  process.stderr.write("FAKE_ZCODE_RECORD is required\n");
  process.exit(2);
}
fs.mkdirSync(recDir, { recursive: true });
const n = fs.readdirSync(recDir).filter((f) => /^turn-\d+\.json$/.test(f)).length + 1;
const attach = flag("--attach");
let attachText = null;
if (attach && fs.existsSync(attach)) attachText = fs.readFileSync(attach, "utf8");
fs.writeFileSync(
  path.join(recDir, `turn-${n}.json`),
  JSON.stringify({
    argv,
    env: { ZCODE_DATA_BASE_DIR: process.env.ZCODE_DATA_BASE_DIR || "", HOME: process.env.HOME || "" },
    pid: process.pid,
    attach,
    attachText,
  }),
);
if (process.env.FAKE_ZCODE_FAIL === "login") {
  process.stderr.write("project_token_login_failed\n");
  process.exit(1);
}
if (process.env.FAKE_ZCODE_FAIL === "model") {
  process.stderr.write("Select a model before sending a message\n");
  process.exit(1);
}
const sleepMs = Number(process.env.FAKE_ZCODE_SLEEP_MS || 0);
if (sleepMs > 0) await new Promise((r) => setTimeout(r, sleepMs));
const sessionId = process.env.FAKE_ZCODE_SESSION_ID || "sess_fake_1";
const payload = {
  sessionId,
  traceId: "tr_fake",
  turnId: `turn_${n}`,
  response: process.env.FAKE_ZCODE_RESPONSE || "fake-response",
  usage: {
    inputTokens: Number(process.env.FAKE_ZCODE_INPUT || 11),
    outputTokens: Number(process.env.FAKE_ZCODE_OUTPUT || 7),
    cacheReadTokens: Number(process.env.FAKE_ZCODE_CACHE || 3),
  },
};
if (process.env.FAKE_ZCODE_PRETTY === "1") {
  process.stdout.write("ZCode Built-in skipped (not-due)\n" + JSON.stringify(payload, null, 2) + "\n");
} else {
  process.stdout.write(JSON.stringify(payload) + "\n");
}
