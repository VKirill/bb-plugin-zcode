// zcode-cli-acp: ACP stdio agent that runs ZCode's bundled CLI headless with a Coding Plan API key.
// Never reads or writes ~/.zcode/v2 (the desktop app's sign-in). The key is never printed or logged.
import { execFileSync, spawn } from "node:child_process";
import crypto, { randomUUID } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import readline from "node:readline";

const VERSION = "0.5.3";
const HOME = os.homedir();
const STATE_DIR = path.join(HOME, ".zcode-bridge");
const CLI_HOME = process.env.ZCODE_CLI_HOME || path.join(HOME, ".zcode-bridge", "cli-home");
const CLI_ENTRY = process.env.ZCODE_CLI_ENTRY || "/Applications/ZCode.app/Contents/Resources/glm/zcode.cjs";
const BUILTIN_CONFIG = process.env.ZCODE_BUILTIN_PROVIDER_CONFIG_FILE || "/Applications/ZCode.app/Contents/Resources/config/provider/zcode-builtin.json";
const CLI_DB = process.env.ZCODE_CLI_DB || path.join(HOME, ".zcode", "cli", "db", "db.sqlite");
const SESSIONS_FILE = process.env.ZCODE_CLI_ACP_SESSIONS || path.join(STATE_DIR, "cli-acp-sessions.json");
const ATTACH_LIMIT = 16000;
const PLAN = "zai-individual-coding-plan";
const PROVIDER_ID = `account:${PLAN}`;
const MODELS = [
  { value: "GLM-5.3-Flash", name: "GLM-5.3-Flash" },
  { value: "GLM-5.3", name: "GLM-5.3" },
];
const DEFAULT_MODEL = "GLM-5.3-Flash";
const MODE_CLI = { full: "yolo", auto: "guarded", ask: "edit", plan: "plan" };
const MODE_DEFAULT = Object.hasOwn(MODE_CLI, process.env.ZCODE_ACP_MODE_DEFAULT || "") ? process.env.ZCODE_ACP_MODE_DEFAULT : "full";
const FOLLOW_CHAT = process.env.ZCODE_ACP_FOLLOW_CHAT === "1";
const BB_PERMISSION = (process.argv.find((a) => a.startsWith("--bb-permission=")) || "").split("=")[1] || "";
const KEEP_INSTRUCTIONS = process.env.ZCODE_ACP_KEEP_INSTRUCTIONS === "1";
const MCP_REGISTRY = path.join(STATE_DIR, "cli-acp-mcp-injected.json");
const KEY_ERROR = "Authentication required: run `zcode-cli-acp set-key` with your Coding Plan API key on stdin.";

const sessions = new Map();

function send(message) {
  process.stdout.write(JSON.stringify({ jsonrpc: "2.0", ...message }) + "\n");
}
function log(...parts) {
  const line = `${new Date().toISOString()} ${parts.join(" ")}`;
  process.stderr.write(line + "\n");
  try {
    fs.mkdirSync(STATE_DIR, { recursive: true });
    fs.appendFileSync(path.join(STATE_DIR, "cli-acp.log"), line + "\n");
  } catch {}
}
function update(sessionId, upd) {
  send({ method: "session/update", params: { sessionId, update: upd } });
}
class AcpError extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
  }
}

function credentialKey() {
  const secret = process.env.ZCODE_CREDENTIAL_SECRET || `zcode-credential-fallback:${os.platform()}:${os.homedir()}:${os.userInfo().username}`;
  return crypto.createHash("sha256").update(secret).digest();
}
function encryptValue(plain, key) {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", key, iv);
  const ct = Buffer.concat([cipher.update(String(plain), "utf8"), cipher.final()]);
  return `enc:v1:${iv.toString("base64url")}.${cipher.getAuthTag().toString("base64url")}.${ct.toString("base64url")}`;
}
function providerConfig(modelId) {
  return {
    schemaVersion: 1,
    config: {
      providerConfigRules: { providerRules: [] },
      modelConfigRules: { providerModelRules: [], manualProviderModelRules: [] },
      defaultModelSelection: { providerId: PROVIDER_ID, modelId },
    },
  };
}
function writeKeyStore(apiKey) {
  const key = credentialKey();
  const identity = "key-" + crypto.createHash("sha256").update(apiKey).digest("hex").slice(0, 24);
  const encoded = encodeURIComponent(identity);
  const entries = {
    [`account-provider:${PROVIDER_ID}:identity`]: identity,
    [`account-provider:${PROVIDER_ID}:auth-source`]: "manual",
    [`account-provider:coding-plan:${PROVIDER_ID}:account:${encoded}:api-key`]: apiKey,
  };
  for (const model of MODELS) {
    const dir = path.join(CLI_HOME, model.value, ".zcode", "v2");
    fs.mkdirSync(dir, { recursive: true });
    const creds = Object.fromEntries(Object.entries(entries).map(([k, v]) => [k, encryptValue(v, key)]));
    const credFile = path.join(dir, "credentials.json");
    fs.writeFileSync(credFile, JSON.stringify(creds) + "\n", { mode: 0o600 });
    fs.chmodSync(credFile, 0o600);
    fs.writeFileSync(path.join(dir, "provider_config.json"), JSON.stringify(providerConfig(model.value)) + "\n", { mode: 0o600 });
  }
}
function keyStored(modelId) {
  try {
    const creds = JSON.parse(fs.readFileSync(path.join(CLI_HOME, modelId, ".zcode", "v2", "credentials.json"), "utf8"));
    return Object.keys(creds).some((k) => k.includes("api-key") && String(creds[k]).startsWith("enc:v1:"));
  } catch {
    return false;
  }
}
async function cmdSetKey() {
  const chunks = [];
  for await (const c of process.stdin) chunks.push(c);
  const apiKey = Buffer.concat(chunks).toString("utf8").trim();
  if (!apiKey) {
    process.stderr.write("zcode-cli-acp set-key: expected the Coding Plan API key on stdin\n");
    process.exit(1);
  }
  writeKeyStore(apiKey);
  process.stdout.write(JSON.stringify({ ok: true, models: MODELS.map((m) => m.value) }) + "\n");
}
function cmdStatus() {
  process.stdout.write(
    JSON.stringify({
      cliEntryFound: fs.existsSync(CLI_ENTRY),
      cliHome: CLI_HOME,
      models: MODELS.map((m) => ({ modelId: m.value, keyStored: keyStored(m.value) })),
    }) + "\n",
  );
}

function loadStore() {
  try {
    return JSON.parse(fs.readFileSync(SESSIONS_FILE, "utf8"));
  } catch {
    return {};
  }
}
function saveSession(s) {
  if (!s.zcodeSessionId) return;
  try {
    fs.mkdirSync(STATE_DIR, { recursive: true });
    const store = loadStore();
    store[s.id] = { zcodeSessionId: s.zcodeSessionId, cwd: s.cwd, model: s.model, at: Date.now() };
    const keep = Object.entries(store).sort((a, b) => b[1].at - a[1].at).slice(0, 200);
    fs.writeFileSync(SESSIONS_FILE, JSON.stringify(Object.fromEntries(keep)));
  } catch (e) {
    log("could not save session map:", String(e));
  }
}
function configOptions(s) {
  return [
    { id: "model", name: "Model", category: "model", type: "select", currentValue: s.model, options: MODELS.map((m) => ({ value: m.value, name: m.name })) },
    { id: "effort", name: "Reasoning", category: "thought_level", type: "select", currentValue: s.effort, options: [{ value: "low", name: "Low" }, { value: "high", name: "High" }, { value: "max", name: "Max" }] },
  ];
}
function sessionState(s) {
  return { configOptions: configOptions(s), models: { currentModelId: s.model, availableModels: MODELS.map((m) => ({ modelId: m.value, name: m.name })) } };
}
function newSession(id, cwd) {
  const s = { id, cwd, zcodeSessionId: null, model: DEFAULT_MODEL, effort: "high", active: null, cancelled: false, mcpRecord: null };
  sessions.set(id, s);
  return s;
}
function getSession(id) {
  const s = sessions.get(id);
  if (!s) throw new AcpError(-32602, `unknown session ${id}`);
  return s;
}
function setOption(s, configId, value) {
  if (configId === "model") {
    if (!MODELS.some((m) => m.value === value)) throw new AcpError(-32602, `unknown model ${value}`);
    s.model = value;
  } else if (configId === "effort") {
    if (!["low", "high", "max"].includes(value)) throw new AcpError(-32602, `unknown reasoning level ${value}`);
    s.effort = value;
  } else throw new AcpError(-32602, `unknown config option ${configId}`);
}
function effectiveMode() {
  if (FOLLOW_CHAT && BB_PERMISSION === "full") return "full";
  if (FOLLOW_CHAT && BB_PERMISSION === "accept-edits") return "auto";
  return MODE_DEFAULT;
}

function readJson(file, fallback) {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch (e) {
    return e.code === "ENOENT" ? fallback : null;
  }
}
function writeJsonAtomic(file, value, mode) {
  const tmp = `${file}.${process.pid}.tmp`;
  let keep = mode;
  try {
    keep = fs.statSync(file).mode & 0o777;
  } catch {}
  fs.writeFileSync(tmp, JSON.stringify(value, null, 2) + "\n", { mode: keep });
  fs.renameSync(tmp, file);
}
function mcpKey(name) {
  return /^bb[-_]/i.test(name) ? name : `bb-${name}`;
}
function flattenUnion(schema) {
  const branches = Array.isArray(schema.oneOf) ? schema.oneOf : Array.isArray(schema.anyOf) ? schema.anyOf : null;
  if (!branches || schema.properties || !branches.length || !branches.every((b) => b && typeof b === "object" && b.properties && typeof b.properties === "object")) {
    return schema.type === "object" ? schema : { type: "object", ...schema };
  }
  const properties = {};
  for (const b of branches) {
    for (const [key, prop] of Object.entries(b.properties)) {
      const values = branches.map((x) => x.properties[key]).filter(Boolean);
      const consts = values.map((v) => ("const" in v ? [v.const] : Array.isArray(v.enum) ? v.enum : null));
      if (values.length === branches.length && consts.every(Boolean)) {
        const enumValues = [...new Set(consts.flat())];
        const notes = branches.map((x) => x.description && `${[].concat(x.properties[key].const ?? x.properties[key].enum).join("|")}: ${x.description}`).filter(Boolean);
        properties[key] = { type: typeof enumValues[0] === "number" ? "number" : "string", enum: enumValues, ...(notes.length ? { description: notes.join("; ") } : {}) };
      } else if (!(key in properties)) properties[key] = prop;
    }
  }
  const required = Object.keys(properties).filter((key) => branches.every((b) => Array.isArray(b.required) && b.required.includes(key)));
  const { oneOf: _oneOf, anyOf: _anyOf, $schema: _schema, ...rest } = schema;
  return { ...rest, type: "object", properties, ...(required.length ? { required } : {}) };
}
function fixDynamicTools(env) {
  const raw = env.BB_ACP_DYNAMIC_TOOLS;
  if (typeof raw !== "string") return env;
  try {
    const tools = JSON.parse(raw);
    if (!Array.isArray(tools)) return env;
    let changed = false;
    for (const t of tools) {
      const schema = t && t.inputSchema;
      if (!schema || typeof schema !== "object") continue;
      const fixed = flattenUnion(schema);
      if (fixed !== schema) {
        t.inputSchema = fixed;
        changed = true;
      }
    }
    return changed ? { ...env, BB_ACP_DYNAMIC_TOOLS: JSON.stringify(tools) } : env;
  } catch {
    return env;
  }
}
function zcodeServer(srv) {
  const kv = (list) => Object.fromEntries((Array.isArray(list) ? list : []).filter((x) => x && x.name).map((x) => [x.name, x.value ?? ""]));
  if (srv.type === "http" || srv.type === "sse") return srv.url ? { type: srv.type, url: srv.url, ...(srv.headers?.length ? { headers: kv(srv.headers) } : {}) } : null;
  if (!srv.command) return null;
  return { type: "stdio", command: srv.command, args: srv.args || [], ...(srv.env?.length ? { env: fixDynamicTools(kv(srv.env)) } : {}) };
}
function pidAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return e.code === "EPERM";
  }
}
function sweepMcpRegistry() {
  const reg = readJson(MCP_REGISTRY, {}) || {};
  for (const [id, rec] of Object.entries(reg)) if (!pidAlive(rec.pid)) removeMcp(id);
}
function removeMcp(id) {
  const reg = readJson(MCP_REGISTRY, {}) || {};
  const rec = reg[id];
  if (!rec) return;
  delete reg[id];
  try {
    const cfg = readJson(rec.file, null);
    if (cfg && cfg.mcp && cfg.mcp.servers) {
      for (const key of rec.keys) {
        const claimed = Object.values(reg).some((o) => o.file === rec.file && o.keys.includes(key));
        if (!claimed) delete cfg.mcp.servers[key];
      }
      if (!Object.keys(cfg.mcp.servers).length) delete cfg.mcp.servers;
      if (!Object.keys(cfg.mcp).length) delete cfg.mcp;
      if (!Object.keys(cfg).length && rec.createdFile) {
        fs.rmSync(rec.file, { force: true });
        if (rec.createdDir) fs.rmdirSync(path.dirname(rec.file));
      } else writeJsonAtomic(rec.file, cfg);
    }
  } catch (e) {
    log("mcp cleanup failed for", rec.file, String(e?.message || e));
  }
  fs.mkdirSync(STATE_DIR, { recursive: true });
  writeJsonAtomic(MCP_REGISTRY, reg, 0o600);
}
function git(cwd, args) {
  try {
    return execFileSync("git", ["-C", cwd, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], timeout: 10000 }).trim();
  } catch {
    return null;
  }
}
function excludeFromGit(cwd) {
  const exclude = git(cwd, ["rev-parse", "--path-format=absolute", "--git-path", "info/exclude"]);
  if (!exclude) return;
  try {
    const have = fs.existsSync(exclude) ? fs.readFileSync(exclude, "utf8") : "";
    if (have.split("\n").some((l) => l.trim() === ".zcode/" || l.trim() === "/.zcode/")) return;
    fs.mkdirSync(path.dirname(exclude), { recursive: true });
    fs.appendFileSync(exclude, `${have && !have.endsWith("\n") ? "\n" : ""}# zcode-cli-acp: BB's MCP entry with tokens lives here while a session runs\n.zcode/\n`);
  } catch (e) {
    log("could not extend", exclude, String(e?.message || e));
  }
}
function injectMcp(s, servers) {
  if (!Array.isArray(servers) || !servers.length || !s.cwd) return;
  if (process.env.ZCODE_ACP_MCP === "0") return;
  const dir = path.join(s.cwd, ".zcode");
  const file = path.join(dir, "config.json");
  try {
    sweepMcpRegistry();
    const reg = readJson(MCP_REGISTRY, {}) || {};
    const cfg = readJson(file, {});
    if (cfg === null) return;
    if (git(s.cwd, ["ls-files", "--error-unmatch", "--", ".zcode/config.json"]) !== null) return;
    excludeFromGit(s.cwd);
    const ours = new Set(Object.values(reg).filter((o) => o.file === file).flatMap((o) => o.keys));
    const createdDir = !fs.existsSync(dir);
    const createdFile = !fs.existsSync(file);
    cfg.mcp = cfg.mcp && typeof cfg.mcp === "object" ? cfg.mcp : {};
    cfg.mcp.servers = cfg.mcp.servers && typeof cfg.mcp.servers === "object" ? cfg.mcp.servers : {};
    const keys = [];
    for (const srv of servers) {
      const key = mcpKey(String(srv.name || "server"));
      const entry = zcodeServer(srv);
      if (!entry) continue;
      if (key in cfg.mcp.servers && !ours.has(key)) continue;
      cfg.mcp.servers[key] = entry;
      keys.push(key);
    }
    if (!keys.length) return;
    fs.mkdirSync(dir, { recursive: true });
    writeJsonAtomic(file, cfg, 0o600);
    reg[s.id] = { pid: process.pid, file, keys, createdFile, createdDir, at: Date.now() };
    fs.mkdirSync(STATE_DIR, { recursive: true });
    writeJsonAtomic(MCP_REGISTRY, reg, 0o600);
    s.mcpRecord = s.id;
  } catch (e) {
    log("could not add BB MCP servers:", String(e?.message || e));
  }
}
function endSessionMcp(s) {
  if (!s.mcpRecord) return;
  s.mcpRecord = null;
  removeMcp(s.id);
}
function endAllMcp() {
  for (const s of sessions.values()) endSessionMcp(s);
}
async function endSession(s) {
  if (s.ended) return;
  s.ended = true;
  s.cancelled = true;
  if (s.active?.child) killGroup(s.active.child);
  endSessionMcp(s);
}

function renderPrompt(blocks) {
  const parts = [];
  for (const b of Array.isArray(blocks) ? blocks : []) {
    if (b.type === "text") {
      if (!KEEP_INSTRUCTIONS && /^\s*<system_instructions>[\s\S]*<\/system_instructions>\s*$/.test(b.text)) continue;
      parts.push(b.text);
    } else if (b.type === "resource_link") parts.push(`[file: ${b.uri.replace(/^file:\/\//, "")}]`);
    else if (b.type === "resource" && b.resource) parts.push(b.resource.text ? `[${b.resource.uri}]\n${b.resource.text}` : `[file: ${b.resource.uri}]`);
  }
  return parts.join("\n\n").trim();
}

const KIND = { Read: "read", Glob: "search", Grep: "search", Write: "edit", Edit: "edit", MultiEdit: "edit", ApplyPatch: "edit", NotebookEdit: "edit", Bash: "execute", WebFetch: "fetch", WebSearch: "fetch" };
const TOOL_STATUS = { pending: "pending", running: "in_progress", completed: "completed", error: "failed" };
const STATUS_RANK = { pending: 0, running: 1, completed: 2, error: 2 };
function toolKind(tool) {
  return KIND[tool] || "other";
}
function sqliteParts(sessionId, since) {
  if (!sessionId || !fs.existsSync(CLI_DB)) return [];
  const script = `import json,sqlite3,sys
db,sid,since=sys.argv[1],sys.argv[2],int(sys.argv[3])
con=sqlite3.connect("file:%s?mode=ro"%db,uri=True)
con.row_factory=sqlite3.Row
try:
  rows=con.execute("select p.id,p.data,coalesce(p.time_updated,p.time_created) updated,json_extract(m.data,'$.role') role from part p join message m on m.id=p.message_id where p.session_id=? and coalesce(p.time_updated,p.time_created)>=? order by m.time_created,p.sequence,p.id",(sid,since)).fetchall()
except sqlite3.Error:
  print("[]"); raise SystemExit
print(json.dumps([{"id":r["id"],"role":r["role"],"updated":r["updated"] or 0,"data":json.loads(r["data"])} for r in rows]))`;
  try {
    const out = execFileSync("python3", ["-c", script, CLI_DB, sessionId, String(since)], { encoding: "utf8", timeout: 5000, stdio: ["ignore", "pipe", "ignore"] });
    return JSON.parse(out || "[]");
  } catch {
    return [];
  }
}
function applyParts(s, rows, silent) {
  s.seenText = s.seenText || new Map();
  s.seenTools = s.seenTools || new Map();
  let since = s.watchSince || 0;
  for (const row of rows) {
    since = Math.max(since, row.updated || 0);
    if (row.role === "user") continue;
    const j = row.data || {};
    if ((j.type === "text" || j.type === "reasoning") && row.id && j.text) {
      const sent = s.seenText.get(row.id) ?? "";
      if (j.text === sent || sent.startsWith(j.text)) continue;
      s.seenText.set(row.id, j.text);
      const delta = j.text.startsWith(sent) ? j.text.slice(sent.length) : "";
      if (!delta || silent) continue;
      s.emitted = true;
      const kind = j.type === "text" ? "agent_message_chunk" : "agent_thought_chunk";
      update(s.id, { sessionUpdate: kind, messageId: row.id, content: { type: "text", text: delta } });
    } else if (j.type === "tool" && (j.callID || row.id)) {
      const id = j.callID || row.id;
      const st = j.state || {};
      const status = st.status;
      const prev = s.seenTools.get(id);
      if (prev === status || (prev !== undefined && STATUS_RANK[status] < STATUS_RANK[prev])) continue;
      s.seenTools.set(id, status);
      if (silent) continue;
      const body = { toolCallId: id, title: j.tool || "tool", kind: toolKind(j.tool), status: TOOL_STATUS[status] || "in_progress", rawInput: st.input ?? {} };
      update(s.id, { sessionUpdate: prev === undefined ? "tool_call" : "tool_call_update", ...body });
    }
  }
  s.watchSince = since ? since - 1000 : 0;
}

function killGroup(child) {
  if (!child?.pid) return;
  try {
    child.kill("SIGTERM");
  } catch {}
}

function parseJsonResult(out) {
  const s = String(out);
  try {
    const j = JSON.parse(s.trim());
    if (j && typeof j === "object") return j;
  } catch {}
  const lines = s.split("\n");
  let from = -1;
  for (let i = 0; i < lines.length; i++) if (lines[i].startsWith("{")) from = i;
  if (from >= 0) {
    try {
      const j = JSON.parse(lines.slice(from).join("\n"));
      if (j && typeof j === "object") return j;
    } catch {}
  }
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i].trim();
    if (!line) continue;
    try {
      const j = JSON.parse(line);
      if (j && typeof j === "object") return j;
    } catch {}
  }
  return null;
}

function cliEnv(model) {
  return {
    ...process.env,
    HOME,
    ZCODE_DATA_BASE_DIR: path.join(CLI_HOME, model),
    ZCODE_BUILTIN_PROVIDER_CONFIG_FILE: BUILTIN_CONFIG,
  };
}

function runTurn(s, promptText) {
  const model = MODELS.some((m) => m.value === s.model) ? s.model : DEFAULT_MODEL;
  const mode = MODE_CLI[effectiveMode()] || "yolo";
  const args = ["-p", promptText, "--json", "--mode", mode, "--cwd", s.cwd];
  let attachFile = null;
  if (promptText.length > ATTACH_LIMIT) {
    attachFile = path.join(os.tmpdir(), `zcode-cli-acp-${randomUUID()}.txt`);
    fs.writeFileSync(attachFile, promptText, { mode: 0o600 });
    args[1] = "Follow the attached file.";
    args.push("--attach", attachFile);
  }
  if (s.zcodeSessionId) args.push("--resume", s.zcodeSessionId);
  const child = spawn(process.execPath, [CLI_ENTRY, ...args], { env: cliEnv(model), stdio: ["ignore", "pipe", "pipe"] });
  s.active = { child, attachFile };
  let stdout = "";
  let stderr = "";
  child.stdout?.setEncoding("utf8");
  child.stderr?.setEncoding("utf8");
  child.stdout?.on("data", (d) => (stdout += d));
  child.stderr?.on("data", (d) => (stderr += d));
  const poll = setInterval(() => {
    if (s.zcodeSessionId) applyParts(s, sqliteParts(s.zcodeSessionId, s.watchSince || 0), false);
  }, 400);
  return new Promise((resolve, reject) => {
    const finish = (fn) => {
      clearInterval(poll);
      if (attachFile) fs.rmSync(attachFile, { force: true });
      s.active = null;
      fn();
    };
    child.on("error", (e) => finish(() => reject(new AcpError(-32603, `zcode CLI: ${e.message}`))));
    child.on("close", (code) => {
      finish(() => {
        const json = parseJsonResult(stdout);
        if (s.cancelled && !json) return resolve({ cancelled: true });
        if (!s.cancelled && (code !== 0 || /project_token_login_failed|Select a model/.test(stderr))) {
          return reject(new AcpError(-32000, `${KEY_ERROR} (${(stderr || stdout || `exit ${code}`).trim().slice(-200)})`));
        }
        if (!json) {
          if (s.cancelled) return resolve({ cancelled: true });
          return reject(new AcpError(-32603, `ZCode CLI produced no JSON: ${(stderr || stdout).trim().slice(-300)}`));
        }
        resolve({ json });
      });
    });
  });
}

async function runPrompt(s, params) {
  const text = renderPrompt(params.prompt);
  if (!text) throw new AcpError(-32602, "empty prompt");
  if (s.active) throw new AcpError(-32000, "a prompt is already running in this session");
  s.cancelled = false;
  s.emitted = false;
  try {
    const result = await runTurn(s, text);
    if (result.cancelled || s.cancelled) return { stopReason: "cancelled" };
    const json = result.json;
    if (json.sessionId) {
      s.zcodeSessionId = json.sessionId;
      saveSession(s);
      applyParts(s, sqliteParts(s.zcodeSessionId, s.watchSince || 0), false);
    }
    const response = typeof json.response === "string" ? json.response : "";
    if (response && !s.emitted) update(s.id, { sessionUpdate: "agent_message_chunk", content: { type: "text", text: response } });
    const u = json.usage || {};
    const inputTokens = u.inputTokens ?? 0;
    const outputTokens = u.outputTokens ?? 0;
    const cacheReadTokens = u.cacheReadTokens ?? 0;
    update(s.id, { sessionUpdate: "usage_update", inputTokens, outputTokens, cacheReadTokens, used: inputTokens, size: 1000000 });
    return { stopReason: "end_turn", usage: { inputTokens, outputTokens, cachedReadTokens: cacheReadTokens, totalTokens: inputTokens + outputTokens } };
  } finally {
    if (s.active?.child) killGroup(s.active.child);
    if (s.active?.attachFile) fs.rmSync(s.active.attachFile, { force: true });
    s.active = null;
  }
}
function cancelSession(s) {
  s.cancelled = true;
  if (s.active?.child) killGroup(s.active.child);
}

async function handle(method, params) {
  switch (method) {
    case "initialize":
      return {
        protocolVersion: 1,
        agentCapabilities: { loadSession: true, promptCapabilities: { image: false, audio: false, embeddedContext: true }, mcpCapabilities: { http: true, sse: true } },
        agentInfo: { name: "zcode-cli-acp", title: "ZCode CLI", version: VERSION },
        authMethods: [],
      };
    case "session/new": {
      const s = newSession(`zcli-${randomUUID()}`, params.cwd);
      injectMcp(s, params.mcpServers);
      return { sessionId: s.id, ...sessionState(s) };
    }
    case "session/load": {
      const saved = loadStore()[params.sessionId];
      const s = newSession(params.sessionId, params.cwd || saved?.cwd || HOME);
      if (saved) {
        s.zcodeSessionId = saved.zcodeSessionId;
        s.model = saved.model || s.model;
      }
      injectMcp(s, params.mcpServers);
      return sessionState(s);
    }
    case "session/close": {
      const s = sessions.get(params.sessionId);
      if (s) await endSession(s);
      return {};
    }
    case "session/set_config_option": {
      const s = getSession(params.sessionId);
      setOption(s, params.configId, params.value);
      return { configOptions: configOptions(s) };
    }
    case "session/set_model": {
      setOption(getSession(params.sessionId), "model", params.modelId);
      return {};
    }
    case "session/prompt":
      return runPrompt(getSession(params.sessionId), params);
    default:
      throw new AcpError(-32601, `method not found: ${method}`);
  }
}

const sub = process.argv[2];
if (sub === "set-key") {
  await cmdSetKey();
  process.exit(0);
}
if (sub === "status") {
  cmdStatus();
  process.exit(0);
}

const rl = readline.createInterface({ input: process.stdin });
rl.on("line", (line) => {
  let msg;
  try {
    msg = JSON.parse(line);
  } catch {
    return;
  }
  if (msg.method === undefined) return;
  if (msg.method === "session/cancel") {
    const s = sessions.get(msg.params?.sessionId);
    if (s) cancelSession(s);
    return;
  }
  if (msg.id === undefined) return;
  handle(msg.method, msg.params || {}).then(
    (result) => send({ id: msg.id, result: result ?? {} }),
    (e) => {
      log("error in", msg.method, String(e?.message || e));
      send({ id: msg.id, error: { code: e instanceof AcpError ? e.code : -32603, message: String(e?.message || e) } });
    },
  );
});
let shuttingDown = false;
function shutdown() {
  if (shuttingDown) return;
  shuttingDown = true;
  const ends = [...sessions.values()].map((s) => endSession(s).catch((e) => log("end of session failed:", String(e?.message || e))));
  Promise.race([Promise.all(ends), new Promise((r) => setTimeout(r, 5000))]).finally(() => {
    endAllMcp();
    process.exit(0);
  });
  setTimeout(() => process.exit(0), 8000).unref();
}
rl.on("close", shutdown);
process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);
process.on("exit", endAllMcp);
