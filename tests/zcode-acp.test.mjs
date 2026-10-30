import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { startAgent, text } from "./support/acp-client.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const agentPath = path.join(here, "..", "bin", "zcode-acp.mjs");
const fakePath = path.join(here, "support", "fake-zcbridge.mjs");

function seedModels(dir) {
  fs.mkdirSync(path.join(dir, ".zcode-bridge"), { recursive: true });
  fs.writeFileSync(path.join(dir, ".zcode-bridge", "models.json"), JSON.stringify({ models: [{ name: "GLM-5.3-Flash", enabled: true }, { name: "GLM-5.3", enabled: true }], default: "GLM-5.3-Flash", at: Math.floor(Date.now() / 1000) }));
}

function setup(extraEnv = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "zcode-acp-test-"));
  seedModels(dir);
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "zcode-acp-cwd-"));
  const env = { HOME: dir, ZCODE_ACP_BRIDGE: fakePath, FAKE_ZC_DIR: dir, FAKE_ZC_ROOT: fs.realpathSync(cwd), ZCODE_ACP_SESSIONS: path.join(dir, "sessions.json"), ...extraEnv };
  const agent = startAgent(process.execPath, [agentPath], env);
  return { dir, cwd, agent, calls: () => (fs.existsSync(path.join(dir, "calls.log")) ? fs.readFileSync(path.join(dir, "calls.log"), "utf8").trim().split("\n") : []) };
}
const prompt = (agent, sessionId, t) => agent.request("session/prompt", { sessionId, prompt: [{ type: "text", text: t }] });

test("initialize, session/new advertises models and reasoning, set_config_option", async () => {
  const { agent } = setup();
  const init = await agent.request("initialize", { protocolVersion: 1, clientCapabilities: {} });
  assert.equal(init.agentCapabilities.loadSession, true);
  const s = await agent.request("session/new", { cwd: "/tmp", mcpServers: [] });
  const model = s.configOptions.find((o) => o.category === "model");
  assert.deepEqual(model.options.map((o) => o.name), ["GLM-5.3-Flash", "GLM-5.3-Flash · Free", "GLM-5.3"]);
  assert.equal(model.currentValue, "glm-5.3-flash");
  assert.deepEqual(s.configOptions.find((o) => o.category === "thought_level").options.map((o) => o.value), ["low", "high", "max"]);
  const r = await agent.request("session/set_config_option", { sessionId: s.sessionId, configId: "effort", value: "max" });
  assert.equal(r.configOptions.find((o) => o.id === "effort").currentValue, "max");
  await assert.rejects(agent.request("session/set_config_option", { sessionId: s.sessionId, configId: "model", value: "nope" }));
  agent.close();
});

test("first turn uses send with model and effort, second turn uses continue, only new events are streamed", async () => {
  const { agent, cwd, calls } = setup();
  await agent.request("initialize", { protocolVersion: 1 });
  const s = await agent.request("session/new", { cwd, mcpServers: [] });
  await agent.request("session/set_config_option", { sessionId: s.sessionId, configId: "model", value: "glm-5.3" });
  await agent.request("session/set_config_option", { sessionId: s.sessionId, configId: "effort", value: "low" });
  const r1 = await prompt(agent, s.sessionId, "first tool please");
  assert.equal(r1.stopReason, "end_turn");
  assert.equal(r1.usage.inputTokens, 10);
  assert.equal(text(agent.updates), "ANSWER:first");
  assert.equal(text(agent.updates, "agent_thought_chunk"), "ZCode mode: Full access (plugin setting).\nthinking");
  assert.ok(agent.updates.some((u) => u.sessionUpdate === "usage_update" && u.used === 10));
  const tool = agent.updates.find((u) => u.sessionUpdate === "tool_call");
  assert.equal(tool.kind, "read");
  assert.equal(tool.status, "completed");
  const send = calls().find((c) => c.startsWith("send "));
  assert.match(send, /--model GLM-5.3 --effort low --mode full --allow-full/);
  assert.ok(send.includes(`--folder ${cwd}`));
  agent.updates.length = 0;
  const r2 = await prompt(agent, s.sessionId, "second");
  assert.equal(r2.stopReason, "end_turn");
  assert.equal(text(agent.updates), "ANSWER:second");
  assert.ok(calls().some((c) => c.startsWith("continue task_")));
  agent.close();
});

test("the Flash model is offered twice: the plain one runs on the plan, the «· Free» one only on the Start Plan", async () => {
  for (const [value, route] of [["glm-5.3-flash", "plan"], ["glm-5.3-flash-free", "free"]]) {
    const { agent, cwd, calls } = setup();
    await agent.request("initialize", { protocolVersion: 1 });
    const s = await agent.request("session/new", { cwd, mcpServers: [] });
    await agent.request("session/set_config_option", { sessionId: s.sessionId, configId: "model", value });
    await prompt(agent, s.sessionId, "hello");
    const send = calls().find((c) => c.startsWith("send "));
    assert.match(send, /--model GLM-5.3-Flash /);
    assert.match(send, new RegExp(`--route ${route}(\\s|$)`));
    agent.close();
  }
});

test("Free keeps the same physical model: two turns and close do not reset it or replay a baseline process", async () => {
  const { agent, cwd, calls } = setup();
  try {
    await agent.request("initialize", { protocolVersion: 1 });
    const s = await agent.request("session/new", { cwd, mcpServers: [] });
    await agent.request("session/set_config_option", { sessionId: s.sessionId, configId: "model", value: "glm-5.3-flash-free" });
    await prompt(agent, s.sessionId, "first");
    agent.updates.length = 0;
    await prompt(agent, s.sessionId, "second");
    assert.equal(text(agent.updates), "ANSWER:second");
    await agent.request("session/close", { sessionId: s.sessionId });
    assert.equal(calls().filter((c) => c.startsWith("mode-reset ")).length, 0);
    assert.equal(calls().filter((c) => c.startsWith("watch ")).length, 2);
  } finally { agent.close(); }
});

test("a different physical model is restored once, without another reset at session close", async () => {
  const { agent, cwd, calls } = setup();
  try {
    await agent.request("initialize", { protocolVersion: 1 });
    const s = await agent.request("session/new", { cwd, mcpServers: [] });
    await agent.request("session/set_config_option", { sessionId: s.sessionId, configId: "model", value: "glm-5.3" });
    await prompt(agent, s.sessionId, "first");
    await agent.request("session/close", { sessionId: s.sessionId });
    assert.equal(calls().filter((c) => c.startsWith("mode-reset ")).length, 1);
  } finally { agent.close(); }
});

test("a permission card becomes session/request_permission; allow runs approve, deny runs deny", async () => {
  for (const [choice, call, answer] of [["allow", "approve", "APPROVED"], ["deny", "deny", "DENIED"]]) {
    const { agent, cwd, calls } = setup();
    agent.handlers.permission = (p) => {
      assert.equal(p.toolCall.kind, "edit");
      assert.deepEqual(p.options.map((o) => o.kind), ["allow_once", "reject_once"]);
      return choice;
    };
    await agent.request("initialize", { protocolVersion: 1 });
    const s = await agent.request("session/new", { cwd, mcpServers: [] });
    const r = await prompt(agent, s.sessionId, "approve it");
    assert.equal(r.stopReason, "end_turn");
    assert.ok(!calls().some((c) => c.startsWith("approvals ")), "watch already supplies the pending card");
    assert.ok(!calls().some((c) => c.startsWith("status ")), "watch already supplies final usage");
    assert.ok(calls().some((c) => c.startsWith(call + " task_")), call);
    assert.equal(text(agent.updates), answer);
    const final = agent.updates.filter((u) => u.sessionUpdate === "tool_call_update").at(-1);
    assert.equal(final.status, choice === "allow" ? "completed" : "failed");
    agent.close();
  }
});

test("cancel stops the task and ends the turn with cancelled", async () => {
  const { agent, cwd, calls } = setup();
  await agent.request("initialize", { protocolVersion: 1 });
  const s = await agent.request("session/new", { cwd, mcpServers: [] });
  const p = prompt(agent, s.sessionId, "slow one");
  await new Promise((r) => setTimeout(r, 1500));
  agent.notify("session/cancel", { sessionId: s.sessionId });
  const r = await p;
  assert.equal(r.stopReason, "cancelled");
  assert.ok(calls().some((c) => c.startsWith("cancel task_")));
  agent.close();
});

test("a failed ZCode turn is a JSON-RPC error", async () => {
  const { agent, cwd } = setup();
  await agent.request("initialize", { protocolVersion: 1 });
  const s = await agent.request("session/new", { cwd, mcpServers: [] });
  await assert.rejects(prompt(agent, s.sessionId, "fail now"), /boom/);
  agent.close();
});

// 2026-10-30: five audit chats on the free plan failed at once with 429 «user concurrency limit exceeded».
test("a turn the plan refused for its concurrency limit is sent again after a pause", async () => {
  const { agent, cwd, calls } = setup({ ZCODE_ACP_RATE_RETRY_S: "0.2,0.2" });
  await agent.request("initialize", { protocolVersion: 1 });
  const s = await agent.request("session/new", { cwd, mcpServers: [] });
  const r = await prompt(agent, s.sessionId, "ratelimit please");
  assert.equal(r.stopReason, "end_turn");
  assert.ok(agent.updates.some((u) => u.sessionUpdate === "agent_thought_chunk" && /plan refused the request \(model_rate_limited/.test(u.content.text)));
  assert.equal(calls().filter((c) => c.startsWith("continue task_")).length, 1);
  agent.close();
});

test("a free-plan chat continues its task in the free queue", async () => {
  const { agent, cwd, calls } = setup();
  await agent.request("initialize", { protocolVersion: 1 });
  const s = await agent.request("session/new", { cwd, mcpServers: [] });
  await agent.request("session/set_config_option", { sessionId: s.sessionId, configId: "model", value: "glm-5.3-flash-free" });
  await prompt(agent, s.sessionId, "first");
  await prompt(agent, s.sessionId, "second");
  assert.ok(calls().some((c) => c.startsWith("send ") && / --route free/.test(c)));
  assert.ok(calls().some((c) => c.startsWith("continue task_") && / --pool free/.test(c)));
  agent.close();
});

function second(a, extraEnv = {}) {
  return startAgent(process.execPath, [agentPath], { HOME: a.dir, ZCODE_ACP_BRIDGE: fakePath, FAKE_ZC_DIR: a.dir, FAKE_ZC_ROOT: fs.realpathSync(a.cwd), ZCODE_ACP_SESSIONS: path.join(a.dir, "sessions.json"), ...extraEnv });
}

test("with the limit at 1 a second chat waits for the first and is told so", async () => {
  const env = { FAKE_ZC_MAX: "1" };
  const a = setup(env);
  const b = second(a, env);
  for (const x of [a.agent, b]) await x.request("initialize", { protocolVersion: 1 });
  const sa = await a.agent.request("session/new", { cwd: a.cwd, mcpServers: [] });
  const sb = await b.request("session/new", { cwd: a.cwd, mcpServers: [] });
  const pa = prompt(a.agent, sa.sessionId, "slow first");
  await new Promise((r) => setTimeout(r, 1200));
  const pb = prompt(b, sb.sessionId, "quick second");
  await b.waitFor((u) => u.sessionUpdate === "agent_thought_chunk" && /waiting for one to finish/.test(u.content.text), 8000);
  a.agent.notify("session/cancel", { sessionId: sa.sessionId });
  assert.equal((await pa).stopReason, "cancelled");
  assert.equal((await pb).stopReason, "end_turn");
  assert.equal(text(b.updates), "ANSWER:quick");
  a.agent.close();
  b.close();
});

test("with the limit at 2 two chats run together, a third waits; continue and cancel of one do not disturb the others", async () => {
  const env = { FAKE_ZC_MAX: "2" };
  const a = setup(env);
  const b = second(a, env);
  const c = second(a, env);
  try {
    for (const x of [a.agent, b, c]) await x.request("initialize", { protocolVersion: 1 });
    const [sa, sb, sc] = [await a.agent.request("session/new", { cwd: a.cwd, mcpServers: [] }), await b.request("session/new", { cwd: a.cwd, mcpServers: [] }), await c.request("session/new", { cwd: a.cwd, mcpServers: [] })];
    const pa = prompt(a.agent, sa.sessionId, "slow alpha");
    const pb = prompt(b, sb.sessionId, "slow beta");
    const sends = () => fs.readdirSync(a.dir).filter((f) => /^task_.*\.json$/.test(f)).length; // tasks created (a refused send creates none)
    for (let i = 0; i < 50 && sends() < 2; i++) await new Promise((r) => setTimeout(r, 100));
    assert.equal(sends(), 2, "both started without waiting for each other");
    const pc = prompt(c, sc.sessionId, "quick gamma");
    await c.waitFor((u) => u.sessionUpdate === "agent_thought_chunk" && /limit 2/.test(u.content.text), 8000);
    assert.equal(sends(), 2, "the third did not start");
    a.agent.notify("session/cancel", { sessionId: sa.sessionId });
    assert.equal((await pa).stopReason, "cancelled");
    assert.equal((await pc).stopReason, "end_turn");
    assert.equal(text(c.updates), "ANSWER:quick");
    b.notify("session/cancel", { sessionId: sb.sessionId });
    assert.equal((await pb).stopReason, "cancelled");
  } finally {
    for (const x of [a.agent, b, c]) x.close();
  }
});

test("without a limit chats do not wait for each other", async () => {
  const a = setup();
  const b = second(a);
  for (const x of [a.agent, b]) await x.request("initialize", { protocolVersion: 1 });
  const sa = await a.agent.request("session/new", { cwd: a.cwd, mcpServers: [] });
  const sb = await b.request("session/new", { cwd: a.cwd, mcpServers: [] });
  const pa = prompt(a.agent, sa.sessionId, "slow first");
  await new Promise((r) => setTimeout(r, 800));
  const rb = await prompt(b, sb.sessionId, "quick second");
  assert.equal(rb.stopReason, "end_turn");
  assert.equal(b.updates.some((u) => u.sessionUpdate === "agent_thought_chunk" && /waiting/.test(u.content?.text || "")), false);
  a.agent.notify("session/cancel", { sessionId: sa.sessionId });
  assert.equal((await pa).stopReason, "cancelled");
  a.agent.close();
  b.close();
});

test("session/load restores the ZCode task so the next prompt is a continue", async () => {
  const { agent, cwd, dir, calls } = setup();
  await agent.request("initialize", { protocolVersion: 1 });
  const s = await agent.request("session/new", { cwd, mcpServers: [] });
  await prompt(agent, s.sessionId, "one");
  agent.close();
  const again = startAgent(process.execPath, [agentPath], { HOME: dir, ZCODE_ACP_BRIDGE: fakePath, FAKE_ZC_DIR: dir, FAKE_ZC_ROOT: fs.realpathSync(cwd), ZCODE_ACP_SESSIONS: path.join(dir, "sessions.json") });
  await again.request("initialize", { protocolVersion: 1 });
  await again.request("session/load", { sessionId: s.sessionId, cwd, mcpServers: [] });
  const r = await prompt(again, s.sessionId, "two");
  assert.equal(r.stopReason, "end_turn");
  assert.equal(text(again.updates), "ANSWER:two");
  assert.ok(calls().some((c) => c.startsWith("continue task_")));
  again.close();
});

test("BB's <system_instructions> block is not forwarded to ZCode", async () => {
  const { agent, cwd, dir } = setup();
  await agent.request("initialize", { protocolVersion: 1 });
  const s = await agent.request("session/new", { cwd, mcpServers: [] });
  const r = await agent.request("session/prompt", { sessionId: s.sessionId, prompt: [{ type: "text", text: "<system_instructions>\nbb skills ...\n</system_instructions>" }, { type: "text", text: "real question" }] });
  assert.equal(r.stopReason, "end_turn");
  assert.equal(text(agent.updates), "ANSWER:real");
  const sent = fs.readdirSync(dir).filter((f) => f.startsWith("task_")).map((f) => JSON.parse(fs.readFileSync(path.join(dir, f), "utf8")).turns[0].events[0].text);
  assert.deepEqual(sent, ["real question"]);
  agent.close();
});

test("text grows by deltas under one id, tools go in_progress -> completed with output (streaming)", async () => {
  const { agent, cwd } = setup();
  await agent.request("initialize", { protocolVersion: 1 });
  const s = await agent.request("session/new", { cwd, mcpServers: [] });
  const r = await prompt(agent, s.sessionId, "grow it");
  assert.equal(r.stopReason, "end_turn");
  const chunks = agent.updates.filter((u) => u.sessionUpdate === "agent_message_chunk").map((u) => u.content.text);
  assert.deepEqual(chunks, ["AB", "CD", "EF"]);
  assert.equal(new Set(agent.updates.filter((u) => u.sessionUpdate === "agent_message_chunk").map((u) => u.messageId)).size, 1);
  const tool = agent.updates.filter((u) => u.toolCallId === "call_g");
  assert.deepEqual(tool.map((u) => [u.sessionUpdate, u.status]), [["tool_call", "in_progress"], ["tool_call_update", "completed"]]);
  assert.equal(tool[1].content[0].content.text, "hi");
  assert.equal(tool[1].kind, "execute");
  agent.close();
});

test("a continue turn does not replay the earlier turn's parts", async () => {
  const { agent, cwd } = setup();
  await agent.request("initialize", { protocolVersion: 1 });
  const s = await agent.request("session/new", { cwd, mcpServers: [] });
  await prompt(agent, s.sessionId, "grow one");
  agent.updates.length = 0;
  await prompt(agent, s.sessionId, "two");
  assert.equal(text(agent.updates), "ANSWER:two");
  assert.equal(agent.updates.filter((u) => u.toolCallId === "call_g").length, 0);
  agent.close();
});

test("the permission request reuses the tool card that is already on screen", async () => {
  const { agent, cwd } = setup();
  agent.handlers.permission = (p) => {
    assert.equal(p.toolCall.toolCallId, "call_1");
    return "allow";
  };
  await agent.request("initialize", { protocolVersion: 1 });
  const s = await agent.request("session/new", { cwd, mcpServers: [] });
  await prompt(agent, s.sessionId, "approve it");
  assert.equal(agent.updates.filter((u) => u.sessionUpdate === "tool_call" && u.toolCallId === "call_1").length, 1);
  agent.close();
});

test("cancelling a pending permission request cancels the turn once", async () => {
  const { agent, cwd, calls } = setup();
  agent.handlers.permission = () => "cancel";
  await agent.request("initialize", { protocolVersion: 1 });
  const s = await agent.request("session/new", { cwd, mcpServers: [] });
  const r = await prompt(agent, s.sessionId, "approve it");
  assert.equal(r.stopReason, "cancelled");
  assert.equal(calls().filter((c) => c.startsWith("cancel task_")).length, 1);
  assert.equal(calls().filter((c) => c.startsWith("deny task_")).length, 0);
  agent.close();
});

test("BB's MCP servers are merged into <cwd>/.zcode/config.json and removed again; the project's own entries stay", async () => {
  const { agent, cwd, dir } = setup();
  fs.mkdirSync(path.join(cwd, ".zcode"));
  const file = path.join(cwd, ".zcode", "config.json");
  fs.writeFileSync(file, JSON.stringify({ theme: "x", mcp: { servers: { mine: { type: "stdio", command: "own" }, "bb-keep": { type: "stdio", command: "project-owned" } } } }));
  await agent.request("initialize", { protocolVersion: 1 });
  const servers = [
    { name: "bridge", command: "/usr/bin/node", args: ["a.js"], env: [{ name: "TOKEN", value: "t" }] },
    { name: "keep", command: "ours" },
    { type: "http", name: "web", url: "https://x.test/mcp", headers: [{ name: "Authorization", value: "Bearer z" }] },
  ];
  const s = await agent.request("session/new", { cwd, mcpServers: servers });
  const cfg = JSON.parse(fs.readFileSync(file, "utf8"));
  assert.equal(cfg.theme, "x");
  assert.deepEqual(Object.keys(cfg.mcp.servers).sort(), ["bb-bridge", "bb-keep", "bb-web", "mine"]);
  assert.deepEqual(cfg.mcp.servers["bb-bridge"], { type: "stdio", command: "/usr/bin/node", args: ["a.js"], env: { TOKEN: "t" } });
  assert.deepEqual(cfg.mcp.servers["bb-web"], { type: "http", url: "https://x.test/mcp", headers: { Authorization: "Bearer z" } });
  assert.equal(cfg.mcp.servers["bb-keep"].command, "project-owned");
  await agent.request("session/close", { sessionId: s.sessionId });
  const after = JSON.parse(fs.readFileSync(file, "utf8"));
  assert.deepEqual(Object.keys(after.mcp.servers).sort(), ["bb-keep", "mine"]);
  assert.equal(after.mcp.servers.mine.command, "own");
  agent.close();
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(dir, ".zcode-bridge", "acp-mcp-injected.json"), "utf8")), {});
});

test("MCP: a project without .zcode gets one and loses it again when the process ends", async () => {
  const { agent, cwd } = setup();
  await agent.request("initialize", { protocolVersion: 1 });
  await agent.request("session/new", { cwd, mcpServers: [{ name: "bridge", command: "x" }] });
  assert.ok(fs.existsSync(path.join(cwd, ".zcode", "config.json")));
  agent.child.kill("SIGTERM");
  await new Promise((r) => agent.child.on("exit", r));
  assert.equal(fs.existsSync(path.join(cwd, ".zcode")), false);
});

test("MCP: a registry entry of a dead process is swept by the next session", async () => {
  const { agent, cwd, dir } = setup();
  const stale = path.join(cwd, ".zcode", "config.json");
  fs.mkdirSync(path.dirname(stale));
  fs.writeFileSync(stale, JSON.stringify({ mcp: { servers: { "bb-old": { type: "stdio", command: "x" } } } }));
  fs.mkdirSync(path.join(dir, ".zcode-bridge"), { recursive: true });
  fs.writeFileSync(path.join(dir, ".zcode-bridge", "acp-mcp-injected.json"), JSON.stringify({ dead: { pid: 999999, file: stale, keys: ["bb-old"], createdFile: true, createdDir: true, at: 1 } }));
  await agent.request("initialize", { protocolVersion: 1 });
  const other = fs.mkdtempSync(path.join(os.tmpdir(), "zcode-acp-other-"));
  await agent.request("session/new", { cwd: other, mcpServers: [{ name: "bridge", command: "x" }] });
  assert.equal(fs.existsSync(path.join(cwd, ".zcode")), false);
  agent.close();
});

test("MCP: oneOf tool schemas are flattened into one object (ZCode drops the server without type and cannot validate oneOf)", async () => {
  const { agent, cwd } = setup();
  await agent.request("initialize", { protocolVersion: 1 });
  const gateway = {
    $schema: "x",
    oneOf: [
      { type: "object", description: "List hosts", properties: { operation: { type: "string", const: "hosts" } }, required: ["operation"], additionalProperties: false },
      { type: "object", description: "List a folder", properties: { operation: { type: "string", const: "list" }, hostId: { type: "string" }, path: { type: "string" } }, required: ["operation", "hostId", "path"], additionalProperties: false },
    ],
  };
  const tools = [
    { name: "plain", inputSchema: { type: "object", properties: {} } },
    { name: "bb_file_gateway", inputSchema: gateway },
    { name: "loose", inputSchema: { oneOf: [{ type: "string" }, { type: "number" }] } },
  ];
  const s = await agent.request("session/new", { cwd, mcpServers: [{ name: "bb-bridge", command: "x", env: [{ name: "BB_ACP_DYNAMIC_TOOLS", value: JSON.stringify(tools) }, { name: "OTHER", value: "1" }] }] });
  const env = JSON.parse(fs.readFileSync(path.join(cwd, ".zcode", "config.json"), "utf8")).mcp.servers["bb-bridge"].env;
  const fixed = JSON.parse(env.BB_ACP_DYNAMIC_TOOLS);
  assert.deepEqual(fixed[0].inputSchema, { type: "object", properties: {} });
  const flat = fixed[1].inputSchema;
  assert.equal(flat.type, "object");
  assert.equal(flat.oneOf, undefined);
  assert.deepEqual(flat.properties.operation.enum, ["hosts", "list"]);
  assert.match(flat.properties.operation.description, /hosts: List hosts; list: List a folder/);
  assert.deepEqual(Object.keys(flat.properties).sort(), ["hostId", "operation", "path"]);
  assert.deepEqual(flat.required, ["operation"]);
  assert.equal(fixed[2].inputSchema.type, "object"); // not a union of objects: only the type is added
  assert.equal(fixed[2].inputSchema.oneOf.length, 2);
  assert.equal(env.OTHER, "1");
  await agent.request("session/close", { sessionId: s.sessionId });
  agent.close();
});

// ---------------------------------------------------------------- one provider: free via the window, paid via the ZCode CLI

function setupCli({ cache = true, extraEnv = {} } = {}) {
  const dir = fs.mkdtempSync(path.join("/tmp", "zcode-acp-cli-"));
  if (cache) seedModels(dir);
  const cwd = fs.mkdtempSync(path.join("/tmp", "zcode-acp-cli-cwd-"));
  const cliHome = path.join(dir, "cli-home");
  // A stored Coding Plan key as `zcode-cli-acp set-key` leaves it: <cli-home>/<model>/.zcode/v2/credentials.json. The agent only
  // checks that the file exists; the real set-key command runs end to end in the task check.
  for (const model of ["GLM-5.3-Flash", "GLM-5.3"]) {
    fs.mkdirSync(path.join(cliHome, model, ".zcode", "v2"), { recursive: true });
    fs.writeFileSync(path.join(cliHome, model, ".zcode", "v2", "credentials.json"), "{}\n", { mode: 0o600 });
  }
  const rec = path.join(dir, "record");
  fs.mkdirSync(rec);
  const env = {
    HOME: dir,
    ZCODE_ACP_BRIDGE: fakePath,
    FAKE_ZC_DIR: dir,
    FAKE_ZC_ROOT: fs.realpathSync(cwd),
    ZCODE_ACP_SESSIONS: path.join(dir, "sessions.json"),
    ZCODE_CLI_ENTRY: path.join(here, "support", "fake-zcode-cli.mjs"),
    ZCODE_CLI_HOME: cliHome,
    ZCODE_CLI_ACP_SESSIONS: path.join(dir, "cli-sessions.json"),
    FAKE_ZCODE_RECORD: rec,
    FAKE_ZCODE_RESPONSE: "cli-answer",
    ...extraEnv,
  };
  const agent = startAgent(process.execPath, [agentPath], env);
  return {
    dir,
    cwd,
    agent,
    rec,
    calls: () => (fs.existsSync(path.join(dir, "calls.log")) ? fs.readFileSync(path.join(dir, "calls.log"), "utf8").split("\n").filter((l) => l.startsWith("send ")) : []),
    cliTurns: () => fs.readdirSync(rec).filter((f) => /^turn-\d+\.json$/.test(f)),
  };
}

test("with a stored Coding Plan key the model list shows the · Paid tariffs, also when the model cache is missing", async () => {
  const { agent } = setupCli({ cache: false });
  await agent.request("initialize", { protocolVersion: 1 });
  const s = await agent.request("session/new", { cwd: "/tmp", mcpServers: [] });
  const names = s.configOptions.find((o) => o.category === "model").options.map((o) => o.name);
  assert.deepEqual(names, ["GLM-5.3-Flash · Paid", "GLM-5.3-Flash · Free", "GLM-5.3 · Paid"]);
  assert.equal(names.length, 3);
  agent.close();
});

test("with a stored key a turn on glm-5.3-flash runs through the ZCode CLI, the window gets no send, and the client sees the CLI's answer", async () => {
  const { agent, cwd, dir, rec, calls, cliTurns } = setupCli();
  try {
    await agent.request("initialize", { protocolVersion: 1 });
    const s = await agent.request("session/new", { cwd, mcpServers: [] });
    await agent.request("session/set_config_option", { sessionId: s.sessionId, configId: "model", value: "glm-5.3-flash" });
    const r = await prompt(agent, s.sessionId, "paid hello");
    assert.equal(r.stopReason, "end_turn");
    assert.equal(cliTurns().length, 1, "the CLI ran the turn");
    assert.equal(calls().length, 0, "the window bridge was not used");
    assert.ok(text(agent.updates).includes("cli-answer"));
    const turn = JSON.parse(fs.readFileSync(path.join(rec, "turn-1.json"), "utf8"));
    assert.ok(turn.argv.includes(cwd), "the CLI runs in the chat folder");
    assert.equal(turn.env.ZCODE_DATA_BASE_DIR, path.join(dir, "cli-home", "GLM-5.3-Flash"));
  } finally {
    agent.close();
  }
});

test("with a stored key a turn on glm-5.3-flash-free still runs through the window with --route free and does not start the CLI", async () => {
  const { agent, cwd, calls, cliTurns } = setupCli();
  try {
    await agent.request("initialize", { protocolVersion: 1 });
    const s = await agent.request("session/new", { cwd, mcpServers: [] });
    await agent.request("session/set_config_option", { sessionId: s.sessionId, configId: "model", value: "glm-5.3-flash-free" });
    const r = await prompt(agent, s.sessionId, "free hello");
    assert.equal(r.stopReason, "end_turn");
    assert.match(calls()[0], / --route free/);
    assert.equal(cliTurns().length, 0, "the CLI was not started");
  } finally {
    agent.close();
  }
});

test("without a stored key a turn on glm-5.3-flash runs through the window with --route plan", async () => {
  const { agent, cwd, calls } = setup();
  try {
    await agent.request("initialize", { protocolVersion: 1 });
    const s = await agent.request("session/new", { cwd, mcpServers: [] });
    await agent.request("session/set_config_option", { sessionId: s.sessionId, configId: "model", value: "glm-5.3-flash" });
    const r = await prompt(agent, s.sessionId, "plain hello");
    assert.equal(r.stopReason, "end_turn");
    const send = calls().find((c) => c.startsWith("send "));
    assert.match(send, /--model GLM-5.3-Flash /);
    assert.match(send, /--route plan(\s|$)/);
  } finally {
    agent.close();
  }
});

test("when the CLI child agent exits, the next paid turn starts a new child and succeeds", async () => {
  const { agent, cwd, dir, cliTurns } = setupCli();
  try {
    await agent.request("initialize", { protocolVersion: 1 });
    const s = await agent.request("session/new", { cwd, mcpServers: [] });
    await agent.request("session/set_config_option", { sessionId: s.sessionId, configId: "model", value: "glm-5.3" });
    const first = await prompt(agent, s.sessionId, "paid one");
    assert.equal(first.stopReason, "end_turn");
    // The child agent's pid is in the agent's own log; kill it between turns (no process-table tools: the sandbox denies them).
    const pid = Number(fs.readFileSync(path.join(dir, ".zcode-bridge", "acp.log"), "utf8").match(/zcode-cli-acp child agent pid (\d+)/)[1]);
    assert.ok(pid > 0, "the child agent pid is logged");
    process.kill(pid, "SIGKILL");
    await new Promise((r) => setTimeout(r, 200));
    const second = await prompt(agent, s.sessionId, "paid two");
    assert.equal(second.stopReason, "end_turn");
    assert.equal(cliTurns().length, 2, "both turns reached the CLI");
    assert.ok(text(agent.updates).includes("cli-answer"));
  } finally {
    agent.close();
  }
});
