import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { startAgent } from "./support/acp-client.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const agentPath = path.join(here, "..", "bin", "zcode-acp.mjs");
const fakePath = path.join(here, "support", "fake-zcbridge.mjs");

function setup({ env = {}, args = [], cwdInit } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "zcode-acp-test-"));
  const cwd = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "zcode-acp-cwd-")));
  fs.mkdirSync(path.join(dir, ".zcode-bridge"), { recursive: true });
  fs.writeFileSync(path.join(dir, ".zcode-bridge", "models.json"), JSON.stringify({ models: [{ name: "GLM-5.3-Flash", enabled: true }], default: "GLM-5.3-Flash", at: Math.floor(Date.now() / 1000) }));
  if (cwdInit) cwdInit(cwd);
  const agent = startAgent(process.execPath, [agentPath, ...args], { HOME: dir, ZCODE_ACP_BRIDGE: fakePath, FAKE_ZC_DIR: dir, FAKE_ZC_ROOT: cwd, ZCODE_ACP_SESSIONS: path.join(dir, "sessions.json"), ...env });
  const calls = () => (fs.existsSync(path.join(dir, "calls.log")) ? fs.readFileSync(path.join(dir, "calls.log"), "utf8").trim().split("\n") : []);
  return { dir, cwd, agent, calls };
}
const prompt = (agent, sessionId, t) => agent.request("session/prompt", { sessionId, prompt: [{ type: "text", text: t }] });
const git = (cwd, ...a) => execFileSync("git", ["-C", cwd, ...a], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
const bbServer = [{ name: "bridge", command: "node", args: [], env: [{ name: "BB_ACP_DYNAMIC_TOOL_TOKEN", value: "secret-token" }] }];

test("the plugin setting decides the mode: Full access by default, the setting can say Autonomous, and the mode is announced once", async () => {
  const d = setup();
  await d.agent.request("initialize", { protocolVersion: 1 });
  const s = await d.agent.request("session/new", { cwd: d.cwd, mcpServers: [] });
  await prompt(d.agent, s.sessionId, "first");
  assert.match(d.calls().find((c) => c.startsWith("send ")), /--mode full --allow-full/);
  assert.equal(d.agent.updates.filter((u) => u.sessionUpdate === "agent_thought_chunk" && /ZCode mode: Full access \(plugin setting\)/.test(u.content.text)).length, 1);
  await prompt(d.agent, s.sessionId, "second");
  assert.equal(d.agent.updates.filter((u) => /ZCode mode:/.test(u.content?.text || "")).length, 1);
  assert.match(d.calls().find((c) => c.startsWith("continue ")), /--mode full/);
  d.agent.close();
  const a = setup({ env: { ZCODE_ACP_MODE_DEFAULT: "auto" } });
  await a.agent.request("initialize", { protocolVersion: 1 });
  const s2 = await a.agent.request("session/new", { cwd: a.cwd, mcpServers: [] });
  await prompt(a.agent, s2.sessionId, "first");
  assert.match(a.calls().find((c) => c.startsWith("send ")), /--mode auto --allow-autonomous/);
  a.agent.close();
});

test("the chat's BB permission mode wins only when the setting says so", async () => {
  for (const [follow, bb, want] of [["1", "accept-edits", "auto"], ["1", "full", "full"], ["0", "accept-edits", "full"], ["1", "", "full"]]) {
    const d = setup({ env: { ZCODE_ACP_FOLLOW_CHAT: follow }, args: bb ? [`--bb-permission=${bb}`] : [] });
    await d.agent.request("initialize", { protocolVersion: 1 });
    const s = await d.agent.request("session/new", { cwd: d.cwd, mcpServers: [] });
    await prompt(d.agent, s.sessionId, "first");
    assert.match(d.calls().find((c) => c.startsWith("send ")), new RegExp(`--mode ${want}`), `follow=${follow} bb=${bb}`);
    d.agent.close();
  }
});

test("Plan mode is switched on only for a session that asks for it, and its chip is taken off afterwards", async () => {
  const d = setup({ env: { ZCODE_ACP_MODE_DEFAULT: "plan" } });
  await d.agent.request("initialize", { protocolVersion: 1 });
  const s = await d.agent.request("session/new", { cwd: d.cwd, mcpServers: [] });
  await prompt(d.agent, s.sessionId, "first");
  assert.match(d.calls().find((c) => c.startsWith("send ")), /--mode plan/);
  await new Promise((r) => setTimeout(r, 800));
  assert.ok(d.calls().some((c) => c.startsWith("mode-reset --task task_") && c.includes("--to ask")));
  d.agent.close();
  const n = setup();
  await n.agent.request("initialize", { protocolVersion: 1 });
  const s2 = await n.agent.request("session/new", { cwd: n.cwd, mcpServers: [] });
  await prompt(n.agent, s2.sessionId, "first");
  await new Promise((r) => setTimeout(r, 500));
  assert.equal(n.calls().some((c) => c.startsWith("mode-reset")), false);
  n.agent.close();
});

test("Autonomous mode lets in-project file edits through by itself, and asks BB for the rest (scope project)", async () => {
  const d = setup({ env: { ZCODE_ACP_MODE_DEFAULT: "auto" } });
  d.agent.handlers.permission = () => "deny";
  await d.agent.request("initialize", { protocolVersion: 1 });
  const s = await d.agent.request("session/new", { cwd: d.cwd, mcpServers: [] });
  // the fake card writes /tmp/x.txt: outside the project, so BB is asked (and denies)
  await prompt(d.agent, s.sessionId, "approve this");
  assert.ok(d.calls().some((c) => c.startsWith("deny task_")));
  d.agent.close();
  const a = setup({ env: { ZCODE_ACP_MODE_DEFAULT: "auto", ZCODE_ACP_AUTO_SCOPE: "all" } });
  a.agent.handlers.permission = () => "deny";
  await a.agent.request("initialize", { protocolVersion: 1 });
  const s2 = await a.agent.request("session/new", { cwd: a.cwd, mcpServers: [] });
  await prompt(a.agent, s2.sessionId, "approve this");
  assert.ok(a.calls().some((c) => c.startsWith("approve task_") && c.includes("--yes")), "scope all allows once on its own");
  a.agent.close();
});

test("the MCP entry (BB tokens) never reaches a commit: .zcode/ is excluded in the repository, the file is 0600, and it is gone after the session", async () => {
  const d = setup({ cwdInit: (cwd) => { git(cwd, "init", "-q"); git(cwd, "config", "user.email", "t@example.com"); git(cwd, "config", "user.name", "t"); } });
  await d.agent.request("initialize", { protocolVersion: 1 });
  const s = await d.agent.request("session/new", { cwd: d.cwd, mcpServers: bbServer });
  const file = path.join(d.cwd, ".zcode", "config.json");
  assert.ok(fs.existsSync(file));
  assert.equal(fs.statSync(file).mode & 0o777, 0o600);
  assert.equal(git(d.cwd, "status", "--porcelain").includes(".zcode"), false, "git does not see the folder");
  assert.match(fs.readFileSync(path.join(d.cwd, ".git", "info", "exclude"), "utf8"), /^\.zcode\/$/m);
  await d.agent.request("session/close", { sessionId: s.sessionId });
  assert.equal(fs.existsSync(file), false);
  d.agent.close();
});

test("a worktree shares the repository's exclude file, so its .zcode/ is excluded too", async () => {
  let wt;
  const d = setup({
    cwdInit: (cwd) => {
      git(cwd, "init", "-q"); git(cwd, "config", "user.email", "t@example.com"); git(cwd, "config", "user.name", "t");
      fs.writeFileSync(path.join(cwd, "a.txt"), "a"); git(cwd, "add", "."); git(cwd, "commit", "-qm", "init");
      wt = path.join(path.dirname(cwd), path.basename(cwd) + "-wt");
      git(cwd, "worktree", "add", "-q", "-b", "wt", wt);
    },
  });
  await d.agent.request("initialize", { protocolVersion: 1 });
  await d.agent.request("session/new", { cwd: wt, mcpServers: bbServer });
  assert.ok(fs.existsSync(path.join(wt, ".zcode", "config.json")));
  assert.equal(git(wt, "status", "--porcelain").includes(".zcode"), false);
  d.agent.close();
});

test("a config.json that git already tracks is left alone (no token is written into it)", async () => {
  const d = setup({
    cwdInit: (cwd) => {
      git(cwd, "init", "-q"); git(cwd, "config", "user.email", "t@example.com"); git(cwd, "config", "user.name", "t");
      fs.mkdirSync(path.join(cwd, ".zcode")); fs.writeFileSync(path.join(cwd, ".zcode", "config.json"), '{"mcp":{"servers":{}}}\n');
      git(cwd, "add", "."); git(cwd, "commit", "-qm", "init");
    },
  });
  await d.agent.request("initialize", { protocolVersion: 1 });
  await d.agent.request("session/new", { cwd: d.cwd, mcpServers: bbServer });
  assert.equal(fs.readFileSync(path.join(d.cwd, ".zcode", "config.json"), "utf8"), '{"mcp":{"servers":{}}}\n');
  d.agent.close();
});

test("closing a session cancels its still-running ZCode task and takes an auto-registered throw-away project out of ZCode's list", async () => {
  const prefix = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "zcode-acp-prefix-")));
  const cwd = path.join(prefix, "wt1");
  fs.mkdirSync(cwd);
  const d = setup({ env: { ZCODE_ACP_REMOVE_PREFIXES: prefix, FAKE_ZC_CREATED: "1" } });
  await d.agent.request("initialize", { protocolVersion: 1 });
  const s = await d.agent.request("session/new", { cwd, mcpServers: [] });
  const p = prompt(d.agent, s.sessionId, "slow one").catch(() => null);
  await new Promise((r) => setTimeout(r, 1500));
  await d.agent.request("session/close", { sessionId: s.sessionId });
  assert.ok(d.calls().some((c) => c.startsWith("cancel task_")), "task cancelled");
  assert.ok(d.calls().some((c) => c.startsWith(`project-remove ${cwd}`)), "project removed");
  await p;
  d.agent.close();
});

test("the models BB offers are the ones ZCode offers (enabled ones from its model list)", async () => {
  const d = setup();
  await d.agent.request("initialize", { protocolVersion: 1 });
  const s = await d.agent.request("session/new", { cwd: d.cwd, mcpServers: [] });
  const model = s.configOptions.find((o) => o.category === "model");
  assert.deepEqual(model.options.map((o) => o.name), ["GLM-5.3-Flash", "GLM-5.3-Flash · Free"]);
  d.agent.close();
});
