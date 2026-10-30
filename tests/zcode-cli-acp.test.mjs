import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { startAgent, text } from "./support/acp-client.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const agentPath = path.join(here, "..", "bin", "zcode-cli-acp.mjs");
const fakePath = path.join(here, "support", "fake-zcode-cli.mjs");
const launcherPath = path.join(here, "..", "bin", "zcode-cli-acp");

function decrypt(enc, key) {
  const body = enc.slice("enc:v1:".length);
  const [ivB, tagB, ctB] = body.split(".");
  const d = crypto.createDecipheriv("aes-256-gcm", key, Buffer.from(ivB, "base64url"));
  d.setAuthTag(Buffer.from(tagB, "base64url"));
  return Buffer.concat([d.update(Buffer.from(ctB, "base64url")), d.final()]).toString("utf8");
}

function setup(extraEnv = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "zcode-cli-acp-"));
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "zcode-cli-cwd-"));
  const rec = path.join(dir, "record");
  fs.mkdirSync(rec);
  const db = path.join(dir, "cli.sqlite");
  fs.writeFileSync(db, "");
  const env = {
    HOME: dir,
    ZCODE_CLI_ENTRY: fakePath,
    ZCODE_CLI_HOME: path.join(dir, "cli-home"),
    ZCODE_CLI_DB: db,
    ZCODE_CLI_ACP_SESSIONS: path.join(dir, "sessions.json"),
    FAKE_ZCODE_RECORD: rec,
    FAKE_ZCODE_RESPONSE: "fake-response",
    FAKE_ZCODE_INPUT: "11",
    FAKE_ZCODE_OUTPUT: "7",
    FAKE_ZCODE_CACHE: "3",
    FAKE_ZCODE_SESSION_ID: "sess_fake_1",
    ...extraEnv,
  };
  const agent = startAgent(process.execPath, [agentPath], env);
  const turns = () =>
    fs
      .readdirSync(rec)
      .filter((f) => /^turn-\d+\.json$/.test(f))
      .sort()
      .map((f) => JSON.parse(fs.readFileSync(path.join(rec, f), "utf8")));
  return { dir, cwd, agent, rec, turns, env };
}
const prompt = (agent, sessionId, t) => agent.request("session/prompt", { sessionId, prompt: [{ type: "text", text: t }] });

test("turn 1 argv and env, turn 2 resumes, usage and response, model dir after set_config_option", async () => {
  const { agent, cwd, turns, dir } = setup();
  try {
    await agent.request("initialize", { protocolVersion: 1 });
    const s = await agent.request("session/new", { cwd, mcpServers: [] });
    const r1 = await prompt(agent, s.sessionId, "hello");
    assert.equal(r1.stopReason, "end_turn");
    assert.equal(text(agent.updates), "fake-response");
    const usage = agent.updates.find((u) => u.sessionUpdate === "usage_update");
    assert.equal(usage.inputTokens, 11);
    assert.equal(usage.outputTokens, 7);
    assert.equal(usage.cacheReadTokens, 3);
    const t1 = turns()[0];
    const joined1 = t1.argv.join(" ");
    assert.ok(t1.argv.includes("-p"));
    assert.ok(t1.argv.includes("--json"));
    assert.ok(joined1.includes("--mode yolo"));
    assert.ok(joined1.includes(`--cwd ${cwd}`));
    assert.equal(t1.env.ZCODE_DATA_BASE_DIR, path.join(dir, "cli-home", "GLM-5.3-Flash"));
    assert.equal(t1.env.HOME, dir);
    await agent.request("session/set_config_option", { sessionId: s.sessionId, configId: "model", value: "GLM-5.3" });
    agent.updates.length = 0;
    const r2 = await prompt(agent, s.sessionId, "again");
    assert.equal(r2.stopReason, "end_turn");
    const t2 = turns()[1];
    assert.ok(t2.argv.join(" ").includes("--resume sess_fake_1"));
    assert.equal(t2.env.ZCODE_DATA_BASE_DIR, path.join(dir, "cli-home", "GLM-5.3"));
    assert.equal(t2.env.HOME, dir);
  } finally {
    agent.close();
  }
});

test("a 20000-character prompt is passed with --attach and the file is removed after the turn", async () => {
  const { agent, cwd, turns } = setup();
  try {
    await agent.request("initialize", { protocolVersion: 1 });
    const s = await agent.request("session/new", { cwd, mcpServers: [] });
    const long = "L".repeat(20000);
    const r = await prompt(agent, s.sessionId, long);
    assert.equal(r.stopReason, "end_turn");
    const t1 = turns()[0];
    const i = t1.argv.indexOf("--attach");
    assert.ok(i >= 0);
    const file = t1.argv[i + 1];
    assert.equal(t1.attachText, long);
    assert.equal(fs.existsSync(file), false);
  } finally {
    agent.close();
  }
});

test("session/cancel during a sleeping turn returns cancelled and the fake process is gone", async () => {
  const { agent, cwd, turns } = setup({ FAKE_ZCODE_SLEEP_MS: "20000" });
  try {
    await agent.request("initialize", { protocolVersion: 1 });
    const s = await agent.request("session/new", { cwd, mcpServers: [] });
    const p = prompt(agent, s.sessionId, "slow");
    let rec;
    for (let i = 0; i < 50 && !rec; i++) {
      await new Promise((r) => setTimeout(r, 50));
      try {
        rec = turns()[0];
      } catch {}
    }
    assert.ok(rec?.pid, "fake CLI should have recorded a pid");
    agent.notify("session/cancel", { sessionId: s.sessionId });
    const r = await p;
    assert.equal(r.stopReason, "cancelled");
    await new Promise((x) => setTimeout(x, 200));
    let alive = true;
    try {
      process.kill(rec.pid, 0);
    } catch {
      alive = false;
    }
    assert.equal(alive, false);
  } finally {
    agent.close();
  }
});

test("set-key writes encrypted credentials per model and never prints the dummy key", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "zcode-cli-key-"));
  const dummy = "dummy-coding-plan-key-TEST-not-real";
  const child = spawn(process.execPath, [agentPath, "set-key"], {
    env: { ...process.env, HOME: dir, ZCODE_CLI_HOME: path.join(dir, "cli-home") },
    stdio: ["pipe", "pipe", "pipe"],
  });
  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (d) => (stdout += d));
  child.stderr.on("data", (d) => (stderr += d));
  child.stdin.end(dummy + "\n");
  const code = await new Promise((resolve) => child.on("close", resolve));
  assert.equal(code, 0, stderr);
  assert.equal(stdout.includes(dummy), false);
  assert.equal(stderr.includes(dummy), false);
  const key = crypto.createHash("sha256").update(`zcode-credential-fallback:${os.platform()}:${dir}:${os.userInfo().username}`).digest();
  const identity = "key-" + crypto.createHash("sha256").update(dummy).digest("hex").slice(0, 24);
  for (const modelId of ["GLM-5.3-Flash", "GLM-5.3"]) {
    const file = path.join(dir, "cli-home", modelId, ".zcode", "v2", "credentials.json");
    const st = fs.statSync(file);
    assert.equal(st.mode & 0o777, 0o600);
    const creds = JSON.parse(fs.readFileSync(file, "utf8"));
    const keys = Object.keys(creds);
    assert.equal(keys.length, 3);
    assert.ok(keys.every((k) => k.startsWith("account-provider:")));
    assert.ok(Object.values(creds).every((v) => String(v).startsWith("enc:v1:")));
    const plain = Object.fromEntries(Object.entries(creds).map(([k, v]) => [k, decrypt(v, key)]));
    const values = Object.values(plain);
    assert.ok(values.includes("manual"));
    assert.ok(values.includes(identity));
    assert.ok(values.includes(dummy));
  }
});

test("launcher exists next to the agent", () => {
  assert.equal(fs.existsSync(launcherPath), true);
});
