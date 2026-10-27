// zcode-acp: an Agent Client Protocol agent (JSON-RPC over stdio) that drives the owner's ZCode desktop app
// through `zcbridge` (a CLI; this file never edits it and never touches ZCode, Z.ai tokens or endpoints itself).
//
//   session/new       remembers cwd (the ZCode task is created lazily, on the first prompt)
//   session/prompt    first turn `zcbridge send`, later turns `zcbridge continue`; then `zcbridge watch` is turned into
//                     session/update events; permission cards become session/request_permission (allow once / deny)
//   session/cancel    `zcbridge cancel` (Stop through accessibility, a pending permission card denied first; a few seconds)
//   mcpServers        the servers BB passes in session/new / session/load are merged into <cwd>/.zcode/config.json (`mcp.servers`,
//                     names prefixed `bb-`) and taken out again when the session or the process ends; the project's own entries stay
//   parallel          ZCode runs different tasks at once, so sessions run side by side. The limit is ZCODE_MAX_PARALLEL (default 3,
//                     0 = none), counted by zcbridge over running ZCode tasks across every zcode-acp process and every other bridge
//                     user; a session over the limit waits (and is told so) and starts when a task finishes, or times out
//
// Settings (the BB plugin passes them as environment and one argv flag; the defaults below apply when run by hand):
//   --bb-permission=accept-edits|full   BB's permission mode of the chat (argv, set by the plugin's permissionCli)
//   ZCODE_ACP_MODE_DEFAULT   plan|ask|auto|full: ZCode's mode for a session (default full = Full access)
//   ZCODE_ACP_FOLLOW_CHAT=1  the chat's BB permission mode decides instead (accept-edits -> Autonomous, full -> Full access)
//   ZCODE_ACP_AUTO_SCOPE     project|all: what Autonomous mode answers "Allow once" to on its own (default project = file edits
//                            inside the chat folder; everything else is put to BB as before). "Always allow" is never pressed.
//   ZCODE_ACP_MODEL          model override (a ZCode model name); empty = ZCode's own default model
//   ZCODE_ROUTE              keep|auto|plan|promo: which plan pays for a task (see `zcbridge route`)
//   ZCODE_ACP_REMOVE_PREFIXES  folders (colon or newline separated, ~ allowed) whose auto-registered projects are removed from ZCode's
//                            list when the session ends (default ~/.lane-pilot/worktrees)
//   ZCODE_ACP_AUTOADD=0      do not register unknown folders as ZCode projects
//   ZCODE_ACP_KEEP_INSTRUCTIONS=1   forward BB's <system_instructions> block to ZCode (dropped by default)
//   ZCODE_ACP_BRIDGE (path of zcbridge), ZCODE_MAX_PARALLEL (read by zcbridge), ZCODE_ACP_QUEUE_TIMEOUT (seconds, default 900),
//   ZCODE_ACP_PERMISSION_TIMEOUT (seconds, default 600)
import { execFileSync, spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import readline from "node:readline";

const VERSION = "0.4.0";
const HOME = os.homedir();
const STATE_DIR = path.join(HOME, ".zcode-bridge");
const BRIDGE = process.env.ZCODE_ACP_BRIDGE || [path.join(path.dirname(fs.realpathSync(process.argv[1] || ".")), "zcbridge"), path.join(HOME, ".local", "bin", "zcbridge"), path.join(HOME, ".agents", "bin", "zcbridge")].find((f) => fs.existsSync(f)) || "zcbridge";
const SESSIONS_FILE = process.env.ZCODE_ACP_SESSIONS || path.join(STATE_DIR, "acp-sessions.json");
const PROMPT_DIR = path.join(STATE_DIR, "acp-prompts");
const QUEUE_TIMEOUT_MS = Number(process.env.ZCODE_ACP_QUEUE_TIMEOUT || 900) * 1000;
const PERMISSION_TIMEOUT_MS = Number(process.env.ZCODE_ACP_PERMISSION_TIMEOUT || 600) * 1000;
const TURN_TIMEOUT_S = Number(process.env.ZCODE_ACP_TURN_TIMEOUT || 14400);
const AUTOADD = process.env.ZCODE_ACP_AUTOADD !== "0";
const KEEP_INSTRUCTIONS = process.env.ZCODE_ACP_KEEP_INSTRUCTIONS === "1";
const MODE_NAMES = { plan: "Plan mode", ask: "Ask before changes", auto: "Autonomous mode", full: "Full access" };
const MODE_DEFAULT = Object.hasOwn(MODE_NAMES, process.env.ZCODE_ACP_MODE_DEFAULT || "") ? process.env.ZCODE_ACP_MODE_DEFAULT : "full";
const FOLLOW_CHAT = process.env.ZCODE_ACP_FOLLOW_CHAT === "1";
const AUTO_SCOPE = process.env.ZCODE_ACP_AUTO_SCOPE === "all" ? "all" : "project";
const MODEL_OVERRIDE = (process.env.ZCODE_ACP_MODEL || "").trim();
const ROUTE = ["plan", "promo", "auto"].includes(process.env.ZCODE_ROUTE || "") ? process.env.ZCODE_ROUTE : "keep";
const BB_PERMISSION = (process.argv.find((a) => a.startsWith("--bb-permission=")) || "").split("=")[1] || "";
const MODELS_FILE = path.join(STATE_DIR, "models.json");
const MODELS_MAX_AGE_MS = 24 * 3600 * 1000;

// The models BB offers are the ones this machine's ZCode offers: `zcbridge models` reads its Model settings (enabled switches) and its
// composer default, and caches the answer in ~/.zcode-bridge/models.json; a stale or missing cache is refreshed in the background.
const slug = (name) => name.toLowerCase().replace(/[^a-z0-9.]+/g, "-").replace(/^-+|-+$/g, "");
const FALLBACK_MODELS = [{ value: "glm-5.3-flash", name: "GLM-5.3-Flash", bridge: "GLM-5.3-Flash" }];
function loadModels() {
  let cache = null;
  try {
    cache = JSON.parse(fs.readFileSync(MODELS_FILE, "utf8"));
  } catch {}
  const list = (cache?.models || []).filter((m) => m.enabled).map((m) => ({ value: slug(m.name), name: m.name, bridge: m.name }));
  const models = list.length ? list : FALLBACK_MODELS;
  const wanted = MODEL_OVERRIDE && models.find((m) => m.name.toLowerCase() === MODEL_OVERRIDE.toLowerCase() || m.value === slug(MODEL_OVERRIDE));
  const own = cache?.default && models.find((m) => m.name === cache.default);
  return { models, defaultModel: (wanted || own || models[0]).value, stale: !cache || Date.now() - (cache.at || 0) * 1000 > MODELS_MAX_AGE_MS };
}
let MODELS = FALLBACK_MODELS;
let DEFAULT_MODEL = FALLBACK_MODELS[0].value;
function refreshModelList() {
  const m = loadModels();
  MODELS = m.models;
  DEFAULT_MODEL = m.defaultModel;
  if (m.stale && !refreshModelList.running) {
    refreshModelList.running = true;
    runBridge(["models"], { timeoutMs: 120000 })
      .then((r) => {
        if (r.ok) {
          const n = loadModels();
          MODELS = n.models;
          DEFAULT_MODEL = n.defaultModel;
        } else log("could not read ZCode's model list:", JSON.stringify(r.error));
      })
      .finally(() => (refreshModelList.running = false));
  }
}
const EFFORTS = [
  { value: "low", name: "Low" },
  { value: "high", name: "High" },
  { value: "max", name: "Max" },
];
const DEFAULT_EFFORT = "high";

const sessions = new Map();
let nextClientId = 1;
const pendingClient = new Map();

// ---------------------------------------------------------------- wire
function send(message) {
  process.stdout.write(JSON.stringify({ jsonrpc: "2.0", ...message }) + "\n");
}
function log(...parts) {
  const line = `${new Date().toISOString()} ${parts.join(" ")}`;
  process.stderr.write(line + "\n");
  try {
    fs.mkdirSync(STATE_DIR, { recursive: true });
    fs.appendFileSync(path.join(STATE_DIR, "acp.log"), line + "\n");
  } catch {}
}
function update(sessionId, upd) {
  send({ method: "session/update", params: { sessionId, update: upd } });
}
function requestClient(method, params) {
  const id = `zc-${nextClientId++}`;
  return new Promise((resolve, reject) => {
    pendingClient.set(id, { resolve, reject });
    send({ id, method, params });
  });
}
class AcpError extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
  }
}

// ---------------------------------------------------------------- session state
function loadStore() {
  try {
    return JSON.parse(fs.readFileSync(SESSIONS_FILE, "utf8"));
  } catch {
    return {};
  }
}
function saveSession(s) {
  if (!s.taskId) return;
  try {
    fs.mkdirSync(STATE_DIR, { recursive: true });
    const store = loadStore();
    store[s.id] = { taskId: s.taskId, cwd: s.cwd, model: s.model, effort: s.effort, at: Date.now() };
    const keep = Object.entries(store).sort((a, b) => b[1].at - a[1].at).slice(0, 200);
    fs.writeFileSync(SESSIONS_FILE, JSON.stringify(Object.fromEntries(keep)));
  } catch (e) {
    log("could not save session map:", String(e));
  }
}
function configOptions(s) {
  return [
    { id: "model", name: "Model", category: "model", type: "select", currentValue: s.model, options: MODELS.map((m) => ({ value: m.value, name: m.name })) },
    { id: "effort", name: "Reasoning", category: "thought_level", type: "select", currentValue: s.effort, options: EFFORTS },
  ];
}
function sessionState(s) {
  return {
    configOptions: configOptions(s),
    models: { currentModelId: s.model, availableModels: MODELS.map((m) => ({ modelId: m.value, name: m.name })) },
  };
}
function newSession(id, cwd) {
  const s = { id, cwd, taskId: null, model: DEFAULT_MODEL, effort: DEFAULT_EFFORT, active: null, cancelled: false, cancelling: null, cancelDone: false, mcpRecord: null, firstModel: null, firstEffort: null };
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
    if (!EFFORTS.some((e) => e.value === value)) throw new AcpError(-32602, `unknown reasoning level ${value}`);
    s.effort = value;
  } else throw new AcpError(-32602, `unknown config option ${configId}`);
}

// ---------------------------------------------------------------- BB's MCP servers inside ZCode
// ZCode reads project MCP servers from <folder>/.zcode/config.json (`mcp.servers.<name>`) when a task starts. The servers BB hands over in
// session/new are merged in under `bb-<name>` keys (an entry the project already has under that key wins), recorded in a registry file,
// and removed again when the session or this process ends; a registry entry of a dead process is swept at the next start. Only the keys
// we added are removed, so edits ZCode or the owner made to the file meanwhile stay; the file and its .zcode folder go only if we made them.
const MCP_REGISTRY = path.join(STATE_DIR, "acp-mcp-injected.json");
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
    keep = fs.statSync(file).mode & 0o777; // an existing file keeps its permissions
  } catch {}
  fs.writeFileSync(tmp, JSON.stringify(value, null, 2) + "\n", { mode: keep });
  fs.renameSync(tmp, file);
}
function mcpKey(name) {
  return /^bb[-_]/i.test(name) ? name : `bb-${name}`;
}
// ZCode's MCP client rejects a whole server when one tool's inputSchema has no top-level `type: "object"`. BB's bridge advertises a few
// tools (bb_file_gateway, bb_browser_session_import) as a bare `oneOf`, so the tool list BB hands the bridge in BB_ACP_DYNAMIC_TOOLS
// gets `type: "object"` added where it is missing; every `oneOf` branch is an object already, so the schema means the same.
function fixDynamicTools(env) {
  const raw = env.BB_ACP_DYNAMIC_TOOLS;
  if (typeof raw !== "string") return env;
  try {
    const tools = JSON.parse(raw);
    if (!Array.isArray(tools)) return env;
    let changed = false;
    for (const t of tools) {
      const schema = t && t.inputSchema;
      if (schema && typeof schema === "object" && schema.type !== "object") {
        t.inputSchema = { type: "object", ...schema };
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
function describeMcp(servers) {
  return servers.map((x) => `${x.name}(${x.type || "stdio"}${x.url ? " url" : ""}${x.command ? " cmd" : ""}${x.env?.length ? ` env:${x.env.length}` : ""}${x.headers?.length ? ` headers:${x.headers.length}` : ""})`).join(", ");
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
// The MCP entry holds BB tokens. It must never end up in a commit: the project's .zcode/ is added to the repository's shared
// info/exclude (a worktree shares it), and a config file that git already tracks is left alone.
function git(cwd, args) {
  try {
    return execFileSync("git", ["-C", cwd, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], timeout: 10000 }).trim();
  } catch {
    return null;
  }
}
function excludeFromGit(cwd) {
  const exclude = git(cwd, ["rev-parse", "--path-format=absolute", "--git-path", "info/exclude"]);
  if (!exclude) return; // not a git folder: nothing to commit into
  try {
    const have = fs.existsSync(exclude) ? fs.readFileSync(exclude, "utf8") : "";
    if (have.split("\n").some((l) => l.trim() === ".zcode/" || l.trim() === "/.zcode/")) return;
    fs.mkdirSync(path.dirname(exclude), { recursive: true });
    fs.appendFileSync(exclude, `${have && !have.endsWith("\n") ? "\n" : ""}# zcode-acp: BB's MCP entry with tokens lives here while a session runs\n.zcode/\n`);
  } catch (e) {
    log("could not extend", exclude, String(e?.message || e));
  }
}
function injectMcp(s, servers) {
  if (!Array.isArray(servers) || !servers.length || !s.cwd) return;
  log(`session ${s.id} mcpServers: ${describeMcp(servers)}`);
  if (process.env.ZCODE_ACP_MCP === "0") return;
  const dir = path.join(s.cwd, ".zcode");
  const file = path.join(dir, "config.json");
  try {
    sweepMcpRegistry();
    const reg = readJson(MCP_REGISTRY, {}) || {};
    const cfg = readJson(file, {});
    if (cfg === null) return log(`not touching ${file}: it is not valid JSON`);
    if (git(s.cwd, ["ls-files", "--error-unmatch", "--", ".zcode/config.json"]) !== null) {
      log(`${file} is tracked by git: BB's MCP servers are not written into it (their tokens would reach a commit)`);
      return;
    }
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
      if (key in cfg.mcp.servers && !ours.has(key)) {
        log(`project already has MCP server ${key} in ${file}; leaving it`);
        continue;
      }
      cfg.mcp.servers[key] = entry;
      keys.push(key);
    }
    if (!keys.length) return;
    fs.mkdirSync(dir, { recursive: true });
    writeJsonAtomic(file, cfg, 0o600); // may hold BB tokens: owner-only
    reg[s.id] = { pid: process.pid, file, keys, createdFile, createdDir, at: Date.now() };
    fs.mkdirSync(STATE_DIR, { recursive: true });
    writeJsonAtomic(MCP_REGISTRY, reg, 0o600);
    s.mcpRecord = s.id;
    log(`session ${s.id}: ${keys.length} BB MCP server(s) added to ${file}`);
  } catch (e) {
    log("could not add BB MCP servers:", String(e?.message || e));
  }
}
// A session ends (BB closed it, the thread was stopped, or this process is going away): its ZCode task is cancelled when it is still
// going (a pending card is denied, Stop pressed), which also frees its slot; the MCP entry is removed; a project this session registered
// under a throw-away folder prefix (a tool's temporary worktrees; setting "Remove auto-created projects under") is taken out of
// ZCode's list again. Only the list entry goes; ZCode never touches the folder's files.
const REMOVE_PREFIXES = (process.env.ZCODE_ACP_REMOVE_PREFIXES ?? "~/.lane-pilot/worktrees")
  .split(/[\n:]/)
  .map((x) => x.trim().replace(/^~(?=\/|$)/, HOME))
  .filter((x) => x && x !== "-");
async function endSession(s) {
  if (s.ended) return;
  s.ended = true;
  try {
    if (s.taskId) {
      const st = await runBridge(["status", s.taskId], { timeoutMs: 30000 });
      if (st.ok && !["completed", "error", "cancelled"].includes(st.state)) await ensureCancel(s);
    }
  } catch (e) {
    log("end of session: cancel failed:", String(e?.message || e));
  }
  endSessionMcp(s);
  if (s.projectCreated && REMOVE_PREFIXES.some((pre) => s.cwd === pre || s.cwd.startsWith(pre + path.sep))) {
    const r = await runBridge(["project-remove", s.cwd], { timeoutMs: 120000 });
    if (!r.ok) log("project-remove failed:", JSON.stringify(r.error));
  }
  if (s.usedPlan || (s.usedModel && s.usedModel !== DEFAULT_MODEL)) restoreComposer(s);
  await resetChain;
}
function endSessionMcp(s) {
  if (!s.mcpRecord) return;
  s.mcpRecord = null;
  removeMcp(s.id);
}
function endAllMcp() {
  for (const s of sessions.values()) endSessionMcp(s);
}

// ---------------------------------------------------------------- zcbridge
function bridgeEnv() {
  return { ...process.env, HOME, ZCBRIDGE_OWNER_PID: String(process.pid), PATH: ["/opt/homebrew/bin", "/usr/local/bin", "/usr/bin", "/bin", path.join(HOME, ".agents/bin"), process.env.PATH || ""].join(":") };
}
function runBridge(args, { timeoutMs = 300000 } = {}) {
  return new Promise((resolve) => {
    const child = spawn(BRIDGE, args, { env: bridgeEnv(), stdio: ["ignore", "pipe", "pipe"] });
    let out = "";
    let err = "";
    const timer = setTimeout(() => child.kill("SIGTERM"), timeoutMs);
    child.stdout.on("data", (d) => (out += d));
    child.stderr.on("data", (d) => (err += d));
    child.on("error", (e) => {
      clearTimeout(timer);
      resolve({ ok: false, error: { code: "spawn_failed", message: `${BRIDGE}: ${e.message}` } });
    });
    child.on("close", () => {
      clearTimeout(timer);
      const lines = out.trim().split("\n").filter(Boolean);
      try {
        resolve(JSON.parse(lines[lines.length - 1]));
      } catch {
        resolve({ ok: false, error: { code: "bad_output", message: (err || out || "no output").trim().slice(-400) } });
      }
    });
  });
}
function bridgeError(res) {
  const e = res.error || {};
  const msg = `ZCode (${e.code || "error"}): ${e.message || "unknown error"}`;
  if (e.code === "session_expired") return new AcpError(-32000, "Authentication required: sign in inside the ZCode app. " + msg);
  return new AcpError(-32603, msg);
}
function promptFile(text) {
  fs.mkdirSync(PROMPT_DIR, { recursive: true });
  const file = path.join(PROMPT_DIR, `${randomUUID()}.txt`);
  fs.writeFileSync(file, text, { mode: 0o600 });
  return file;
}
async function withPromptFile(text, fn) {
  const file = promptFile(text);
  try {
    return await fn(file);
  } finally {
    fs.rmSync(file, { force: true });
  }
}

// ---------------------------------------------------------------- parallel limit
function pidAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return e.code === "EPERM";
  }
}
// `zcbridge send` / `continue` take one of ZCODE_MAX_PARALLEL slots (a counting lock over running ZCode tasks, shared by every process)
// and, with --queue-timeout 0, answer `parallel_limit` at once when none is free. The session then waits here, polling, so a
// cancel is noticed within a fraction of a second and nothing holds the ZCode window while it waits.
async function runBridgeQueued(s, args, opts = {}) {
  const started = Date.now();
  let told = false;
  for (;;) {
    const res = await runBridge([...args, "--queue-timeout", "0"], { timeoutMs: 420000, ...opts });
    if (res.ok || res.error?.code !== "parallel_limit") return res;
    if (s.cancelled) throw new AcpError(-32800, "cancelled");
    if (Date.now() - started > QUEUE_TIMEOUT_MS) {
      throw new AcpError(-32000, `ZCode is already running ${res.error.running ?? "its maximum of"} tasks (limit ${res.error.limit ?? "ZCODE_MAX_PARALLEL"}); try again in a few minutes.`);
    }
    if (!told) {
      told = true;
      update(s.id, { sessionUpdate: "agent_thought_chunk", content: { type: "text", text: `ZCode is running ${res.error.running ?? "its maximum of"} tasks (limit ${res.error.limit ?? "ZCODE_MAX_PARALLEL"}); waiting for one to finish.\n` } });
    }
    for (let i = 0; i < 8 && !s.cancelled; i++) await new Promise((r) => setTimeout(r, 250));
  }
}

// ---------------------------------------------------------------- prompt rendering and tool mapping
function renderPrompt(blocks) {
  const parts = [];
  for (const b of Array.isArray(blocks) ? blocks : []) {
    if (b.type === "text") {
      // BB prepends its own <system_instructions> block (rules + a list of every BB skill) to a chat's first prompt. ZCode has
      // its own system prompt and reads AGENTS.md itself, and a pasted wall of text costs tokens and can fail to paste.
      if (!KEEP_INSTRUCTIONS && /^\s*<system_instructions>[\s\S]*<\/system_instructions>\s*$/.test(b.text)) continue;
      parts.push(b.text);
    }
    else if (b.type === "resource_link") parts.push(`[file: ${b.uri.replace(/^file:\/\//, "")}]`);
    else if (b.type === "resource" && b.resource) parts.push(b.resource.text ? `[${b.resource.uri}]\n${b.resource.text}` : `[file: ${b.resource.uri}]`);
  }
  return parts.join("\n\n").trim();
}
const KIND = { Read: "read", Glob: "search", Grep: "search", Write: "edit", Edit: "edit", MultiEdit: "edit", ApplyPatch: "edit", NotebookEdit: "edit", Bash: "execute", WebFetch: "fetch", WebSearch: "fetch" };
function toolKind(tool) {
  return KIND[tool] || "other";
}
function inputPath(input) {
  if (!input || typeof input !== "object") return undefined;
  for (const k of ["file_path", "path", "notebook_path", "filePath"]) if (typeof input[k] === "string") return input[k];
  return undefined;
}
function toolTitle(tool, input) {
  const p = inputPath(input);
  if (p) return `${tool} ${p}`;
  if (input && typeof input.command === "string") return `${tool}: ${input.command.slice(0, 120)}`;
  if (input && typeof input.pattern === "string") return `${tool}: ${input.pattern.slice(0, 120)}`;
  return tool;
}
function toolContent(tool, input) {
  const p = inputPath(input);
  if (!p || !input) return undefined;
  if (tool === "Write" && typeof input.content === "string") return [{ type: "diff", path: p, oldText: null, newText: input.content }];
  if (tool === "Edit" && typeof input.old_string === "string" && typeof input.new_string === "string") return [{ type: "diff", path: p, oldText: input.old_string, newText: input.new_string }];
  return undefined;
}
const TOOL_STATUS = { pending: "pending", running: "in_progress", completed: "completed", error: "failed" };
const STATUS_RANK = { pending: 0, running: 1, completed: 2, error: 2 };
const OUTPUT_LIMIT = 20000;
function toolCallUpdate(id, tool, input, status, output, error) {
  const p = inputPath(input);
  const diff = toolContent(tool, input);
  const text = typeof output === "string" && output ? output : typeof error === "string" && error ? error : "";
  const content = diff || (text ? [{ type: "content", content: { type: "text", text: text.length > OUTPUT_LIMIT ? text.slice(0, OUTPUT_LIMIT) + "\n[output cut]" : text } }] : undefined);
  return {
    toolCallId: id,
    title: toolTitle(tool, input),
    kind: toolKind(tool),
    status,
    rawInput: input ?? {},
    ...(typeof output === "string" ? { rawOutput: output } : {}),
    ...(p ? { locations: [{ path: p }] } : {}),
    ...(content ? { content } : {}),
  };
}

// ---------------------------------------------------------------- one turn
class Turn {
  constructor(s) {
    this.s = s;
    this.text = new Map(); // text/reasoning part id -> text already sent (survives watch restarts)
    this.tools = new Map(); // tool call id -> last status sent
    this.emitted = false;
    this.child = null;
  }
  // Runs `zcbridge watch` once and calls onEvent for every event; resolves with the final state event ({state, pending_approvals?}).
  // watch lists the task from the start on every run, so the maps above decide what is new.
  watchOnce(onEvent) {
    return new Promise((resolve, reject) => {
      const child = spawn(BRIDGE, ["watch", this.s.taskId, "--poll", "0.7", "--timeout", String(TURN_TIMEOUT_S)], { env: bridgeEnv(), stdio: ["ignore", "pipe", "pipe"] });
      this.child = child;
      let final = null;
      let err = "";
      child.stderr.on("data", (d) => (err += d));
      readline.createInterface({ input: child.stdout }).on("line", (line) => {
        let ev;
        try {
          ev = JSON.parse(line);
        } catch {
          return;
        }
        if (ev.event === "state") final = ev;
        else onEvent(ev);
      });
      child.on("error", reject);
      child.on("close", () => {
        this.child = null;
        if (final) resolve(final);
        else if (this.s.cancelled) resolve({ state: "cancelled" });
        else reject(new AcpError(-32603, `ZCode watch ended without a final state: ${err.trim().slice(-300)}`));
      });
    });
  }
  async baseline() {
    // Mark everything already in the task (earlier turns) as sent.
    await this.watchOnce((ev) => this.handle(ev, true));
  }
  handle(ev, silent = false) {
    if (ev.role === "user") return;
    const sid = this.s.id;
    if ((ev.event === "text" || ev.event === "reasoning") && ev.id && ev.text) {
      const sent = this.text.get(ev.id) ?? "";
      if (ev.text === sent || sent.startsWith(ev.text)) return;
      this.text.set(ev.id, ev.text);
      if (silent) return;
      // an in-place rewrite (not an extension) cannot be taken back in ACP: send only what extends what was sent, the rest is skipped
      const delta = ev.text.startsWith(sent) ? ev.text.slice(sent.length) : "";
      if (!delta) return;
      if (ev.event === "text") {
        this.emitted = true;
        update(sid, { sessionUpdate: "agent_message_chunk", messageId: ev.id, content: { type: "text", text: delta } });
      } else update(sid, { sessionUpdate: "agent_thought_chunk", messageId: ev.id, content: { type: "text", text: delta } });
    } else if (ev.event === "tool" && ev.id) {
      const prev = this.tools.get(ev.id);
      if (prev === ev.status || (prev !== undefined && STATUS_RANK[ev.status] < STATUS_RANK[prev])) return; // a status never goes back
      this.tools.set(ev.id, ev.status);
      if (silent) return;
      const status = TOOL_STATUS[ev.status] || "in_progress";
      const body = toolCallUpdate(ev.id, ev.tool, ev.input, status, ev.output, ev.error);
      if (prev === undefined) update(sid, { sessionUpdate: "tool_call", ...body });
      else update(sid, { sessionUpdate: "tool_call_update", ...body });
    }
  }
  announce(card) {
    // The card's call id is the tool part's call id: normally the running tool is on BB's screen already.
    if (this.tools.has(card.call_id)) return;
    this.tools.set(card.call_id, "running");
    update(this.s.id, { sessionUpdate: "tool_call", ...toolCallUpdate(card.call_id, card.tool, card.input, "in_progress") });
  }
  async askPermission(card) {
    const id = card.call_id || `zc-${randomUUID()}`;
    card.call_id = id;
    this.announce(card);
    // Autonomous mode: ZCode itself asks only for risky calls. Scope "project" lets file edits inside the chat folder through on their
    // own; "all" lets every call through; anything else is put to BB. Only "Allow once" is ever pressed, never "Always allow".
    if (effectiveMode().mode === "auto" && (AUTO_SCOPE === "all" || inProjectEdit(card, this.s.cwd))) {
      const res = await runBridge(["approve", this.s.taskId, "--yes"]);
      if (!res.ok) throw bridgeError(res);
      log(`autonomous: allowed once ${card.tool} (${AUTO_SCOPE})`);
      return true;
    }
    const timeout = new Promise((r) => setTimeout(() => r("timeout"), PERMISSION_TIMEOUT_MS));
    const answer = requestClient("session/request_permission", {
      sessionId: this.s.id,
      toolCall: toolCallUpdate(id, card.tool, card.input, "pending"),
      options: [
        { optionId: "allow", name: "Allow once", kind: "allow_once" },
        { optionId: "deny", name: "Deny", kind: "reject_once" },
      ],
    }).then(
      (r) => (r?.outcome?.outcome === "selected" ? r.outcome.optionId : "cancelled"),
      () => "error",
    );
    const choice = await Promise.race([answer, timeout]);
    if (choice === "allow") {
      const res = await runBridge(["approve", this.s.taskId, "--yes"]);
      if (!res.ok) throw bridgeError(res);
      return true;
    }
    if (choice === "cancelled" || choice === "error") {
      // BB dropped the card (the chat was stopped): one fast cancel denies the card and presses Stop
      this.s.cancelled = true;
      await ensureCancel(this.s);
      return false;
    }
    const res = await runBridge(["deny", this.s.taskId, "--yes"]);
    if (!res.ok) log("deny failed:", JSON.stringify(res.error));
    return false;
  }
  async stream() {
    for (let round = 0; round < 200; round++) {
      const final = await this.watchOnce((ev) => this.handle(ev));
      if (final.state !== "waiting_approval") return final.state;
      if (this.s.cancelled) return "cancelled";
      const ap = await runBridge(["approvals", this.s.taskId]);
      const card = ap.ok && ap.pending && ap.pending[0];
      if (!card) {
        await new Promise((r) => setTimeout(r, 1000));
        continue;
      }
      await this.askPermission(card);
      if (this.s.cancelled) return "cancelled";
    }
    throw new AcpError(-32603, "too many permission rounds in one ZCode turn");
  }
}

// The mode ZCode runs a session in: the plugin setting, or (when the setting says so) the chat's own BB permission mode.
function effectiveMode() {
  if (FOLLOW_CHAT && BB_PERMISSION === "full") return { mode: "full", why: "the chat's permission mode is Full" };
  if (FOLLOW_CHAT && BB_PERMISSION === "accept-edits") return { mode: "auto", why: "the chat's permission mode is Accept edits" };
  return { mode: MODE_DEFAULT, why: "plugin setting" };
}
function modeArgs(mode) {
  return ["--mode", mode, ...(mode === "auto" ? ["--allow-autonomous"] : mode === "full" ? ["--allow-full"] : [])];
}
const EDIT_TOOLS = new Set(["Write", "Edit", "MultiEdit", "ApplyPatch", "NotebookEdit"]);
function inProjectEdit(card, root) {
  if (!EDIT_TOOLS.has(card.tool)) return false;
  const input = card.input || {};
  const paths = ["file_path", "path", "notebook_path", "filePath"].map((k) => input[k]).filter((v) => typeof v === "string");
  for (const k of ["patch", "input", "diff"]) if (typeof input[k] === "string") for (const m of input[k].matchAll(/^\*\*\* (?:Add|Update|Delete) File: (.+)$/gm)) paths.push(m[1]);
  if (!paths.length) return false;
  let base;
  try {
    base = fs.realpathSync(root);
  } catch {
    return false;
  }
  return paths.every((p) => {
    const abs = path.resolve(base, p);
    let real = abs;
    try {
      real = fs.realpathSync(abs);
    } catch {
      try {
        real = path.join(fs.realpathSync(path.dirname(abs)), path.basename(abs));
      } catch {}
    }
    return real === base || real.startsWith(base + path.sep);
  });
}
// After a session ran in Plan mode, ZCode's composer for that task keeps the Plan chip: take it off again and leave the task on the
// resting mode. A model other than ZCode's own default is also put back on the New task composer (ZCode remembers the last one used).
function restoreComposer(s) {
  const doReset = async () => {
    if (s.usedPlan && s.taskId) {
      const rest = MODE_DEFAULT === "plan" ? "ask" : MODE_DEFAULT;
      const r = await runBridge(["mode-reset", "--task", s.taskId, "--to", rest], { timeoutMs: 120000 });
      if (!r.ok) log("mode reset failed:", JSON.stringify(r.error));
      s.usedPlan = false;
    }
    if (s.usedModel && s.usedModel !== DEFAULT_MODEL) {
      const m = MODELS.find((x) => x.value === DEFAULT_MODEL);
      if (m) {
        const r = await runBridge(["mode-reset", "--to", "none", "--model", m.bridge], { timeoutMs: 120000 });
        if (!r.ok) log("model reset failed:", JSON.stringify(r.error));
      }
    }
  };
  resetChain = resetChain.then(doReset).catch((e) => log("composer reset failed:", String(e?.message || e)));
}
let resetChain = Promise.resolve();

// A chat's folder works in the ZCode project of that folder (or of the git repository it lies in); an unknown folder is registered by the
// bridge through ZCode's own open-folder link, unless ZCODE_ACP_AUTOADD=0.
async function runPrompt(s, params) {
  const text = renderPrompt(params.prompt);
  if (!text) throw new AcpError(-32602, "empty prompt");
  if (s.active) throw new AcpError(-32000, "a prompt is already running in this session");
  s.cancelled = false;
  s.cancelDone = false;
  s.active = new Turn(s);
  const turn = s.active;
  try {
    const eff = effectiveMode();
    if (!s.announced) {
      s.announced = true;
      update(s.id, { sessionUpdate: "agent_thought_chunk", content: { type: "text", text: `ZCode mode: ${MODE_NAMES[eff.mode]} (${eff.why}).\n` } });
    }
    s.usedPlan = s.usedPlan || eff.mode === "plan";
    if (!s.taskId) {
      const model = MODELS.find((m) => m.value === s.model) || MODELS[0];
      s.usedModel = model.value;
      const args = ["send", "--folder", s.cwd, "--prompt-file", "<file>", "--model", model.bridge, "--effort", s.effort, ...modeArgs(eff.mode)];
      if (ROUTE !== "keep") args.push("--route", ROUTE);
      if (!AUTOADD) args.push("--no-create-project");
      const res = await withPromptFile(text, (file) => runBridgeQueued(s, args.map((a) => (a === "<file>" ? file : a))));
      if (!res.ok) throw bridgeError(res);
      s.taskId = res.task_id;
      s.projectCreated = res.project_created === true;
      s.firstModel = s.model;
      s.firstEffort = s.effort;
      saveSession(s);
    } else {
      if (s.firstModel && (s.firstModel !== s.model || s.firstEffort !== s.effort)) {
        update(s.id, { sessionUpdate: "agent_thought_chunk", content: { type: "text", text: `ZCode keeps the model and reasoning level a task started with (${s.firstModel}, ${s.firstEffort}); the change applies to a new chat.\n` } });
      }
      await turn.baseline();
      const res = await withPromptFile(text, (file) => runBridgeQueued(s, ["continue", s.taskId, "--prompt-file", file, ...modeArgs(eff.mode)]));
      if (!res.ok) throw bridgeError(res);
    }
    if (s.cancelled) {
      await ensureCancel(s);
      return { stopReason: "cancelled" };
    }
    const state = await turn.stream();
    const status = await runBridge(["status", s.taskId]);
    const tok = status.ok && status.tokens ? status.tokens : null;
    if (tok) update(s.id, { sessionUpdate: "usage_update", used: tok.input ?? 0, size: 1000000, _meta: { zcode: { inputTokens: tok.input ?? 0, cacheReadTokens: tok.cache_read ?? 0, freshInputTokens: Math.max(0, (tok.input ?? 0) - (tok.cache_read ?? 0)), outputTokens: tok.output ?? 0, reasoningTokens: tok.reasoning ?? 0, taskId: s.taskId } } });
    const usage = tok ? { inputTokens: tok.input ?? 0, outputTokens: tok.output ?? 0, thoughtTokens: tok.reasoning ?? 0, cachedReadTokens: tok.cache_read ?? 0, totalTokens: (tok.input ?? 0) + (tok.output ?? 0) } : undefined;
    if (state === "cancelled" || s.cancelled) {
      await ensureCancel(s); // idempotent; also stops a task whose card BB cancelled (the deny lets the model go on)
      return { stopReason: "cancelled", ...(usage ? { usage } : {}) };
    }
    if (state === "error") throw new AcpError(-32603, `ZCode turn failed: ${(status.ok && status.error) || "unknown error"}`);
    if (!turn.emitted) {
      const result = await runBridge(["result", s.taskId]);
      if (result.ok && result.answer) update(s.id, { sessionUpdate: "agent_message_chunk", content: { type: "text", text: result.answer } });
    }
    return { stopReason: "end_turn", ...(usage ? { usage } : {}) };
  } catch (e) {
    if (e instanceof AcpError && e.code === -32800) return { stopReason: "cancelled" };
    throw e;
  } finally {
    s.active = null;
    if (s.usedPlan || (s.usedModel && s.usedModel !== DEFAULT_MODEL)) restoreComposer(s);
  }
}

// One cancel per session at a time: the watch is stopped first (nothing more to stream), then `zcbridge cancel` denies a pending
// card, presses Stop and returns once ZCode has recorded the turn as cancelled (about 3 s).
function ensureCancel(s) {
  if (s.cancelling) return s.cancelling;
  s.cancelled = true;
  if (s.cancelDone) return Promise.resolve();
  if (s.active?.child) s.active.child.kill("SIGTERM");
  s.cancelling = (async () => {
    if (!s.taskId) return;
    const res = await runBridge(["cancel", s.taskId]);
    if (!res.ok) log("cancel failed:", JSON.stringify(res.error));
    s.cancelDone = true;
  })().finally(() => {
    s.cancelling = null;
  });
  return s.cancelling;
}
async function cancelSession(s) {
  if (s.active) await ensureCancel(s);
}

// ---------------------------------------------------------------- dispatch
async function handle(method, params) {
  switch (method) {
    case "initialize":
      refreshModelList();
      return {
        protocolVersion: 1,
        agentCapabilities: { loadSession: true, promptCapabilities: { image: false, audio: false, embeddedContext: true }, mcpCapabilities: { http: true, sse: true } },
        agentInfo: { name: "zcode-acp", title: "ZCode", version: VERSION },
        authMethods: [],
      };
    case "session/new": {
      refreshModelList();
      const s = newSession(`zc-${randomUUID()}`, params.cwd);
      injectMcp(s, params.mcpServers);
      return { sessionId: s.id, ...sessionState(s) };
    }
    case "session/load": {
      const saved = loadStore()[params.sessionId];
      const s = newSession(params.sessionId, params.cwd || saved?.cwd || HOME);
      if (saved) {
        s.taskId = saved.taskId;
        s.model = saved.model || s.model;
        s.effort = saved.effort || s.effort;
        s.firstModel = s.model;
        s.firstEffort = s.effort;
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

const rl = readline.createInterface({ input: process.stdin });
rl.on("line", (line) => {
  let msg;
  try {
    msg = JSON.parse(line);
  } catch {
    return;
  }
  if (msg.method === undefined) {
    const p = pendingClient.get(msg.id);
    if (!p) return;
    pendingClient.delete(msg.id);
    if (msg.error) p.reject(new Error(msg.error.message || "client error"));
    else p.resolve(msg.result);
    return;
  }
  if (msg.method === "session/cancel") {
    const s = sessions.get(msg.params?.sessionId);
    if (s) void cancelSession(s);
    return;
  }
  if (msg.id === undefined) return; // other notifications
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
  Promise.race([Promise.all(ends), new Promise((r) => setTimeout(r, 45000))]).finally(() => {
    endAllMcp();
    process.exit(0);
  });
  setTimeout(() => process.exit(0), 60000).unref();
}
rl.on("close", shutdown);
process.on("SIGTERM", () => {
  shutdown();
});
process.on("SIGINT", () => {
  shutdown();
});
process.on("exit", endAllMcp);
