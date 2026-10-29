#!/usr/bin/env node
// Fake zcbridge for tests. State in $FAKE_ZC_DIR/<task>.json: {turns:[{prompt, events:[...], state}], pending, cancelled}
// Behaviour is chosen by the prompt text: "tool" -> a Write tool call; "approve" -> a permission card; "slow" -> long running; "fail" -> error;
// "grow" -> a text part that grows over several watch polls and a tool call that goes running -> completed with output.
// Events carry ids like the real `zcbridge watch` (part id for text, call id for tools); an event with a `tick` shows up from that poll on.
import fs from "node:fs";
import path from "node:path";
const dir = process.env.FAKE_ZC_DIR;
const [cmd, ...rest] = process.argv.slice(2);
const flag = (n) => { const i = rest.indexOf(n); return i >= 0 ? rest[i + 1] : undefined; };
const out = (o) => { console.log(JSON.stringify(o)); process.exit(o.ok === false ? 1 : 0); };
const file = (t) => path.join(dir, `${t}.json`);
const load = (t) => JSON.parse(fs.readFileSync(file(t), "utf8"));
const save = (t, d) => fs.writeFileSync(file(t), JSON.stringify(d));
const log = (l) => fs.appendFileSync(path.join(dir, "calls.log"), l + "\n");
log([cmd, ...rest].join(" "));
const promptOf = () => flag("--prompt-file") ? fs.readFileSync(flag("--prompt-file"), "utf8") : flag("--prompt");
let n = 0;
const nid = () => "part_" + Date.now() + "_" + n++;
function newTurn(prompt) {
  const events = [{ event: "text", id: nid(), role: "user", text: prompt }];
  let state = "completed", pending = null;
  if (prompt.includes("grow")) {
    const t = nid();
    events.push({ event: "tool", id: "call_g", role: "assistant", tool: "Bash", status: "running", input: { command: "echo hi" }, tick: 1 }, { event: "text", id: t, role: "assistant", text: "AB", tick: 1 }, { event: "tool", id: "call_g", role: "assistant", tool: "Bash", status: "completed", input: { command: "echo hi" }, output: "hi", tick: 3 }, { event: "text", id: t, role: "assistant", text: "ABCD", delta: "CD", tick: 3 }, { event: "text", id: t, role: "assistant", text: "ABCDEF", delta: "EF", tick: 5 });
    return { events, state, pending };
  }
  if (prompt.includes("ratelimit")) return { events, state: "error", pending, error: "model_rate_limited: user concurrency limit exceeded" };
  if (prompt.includes("fail")) state = "error";
  else if (prompt.includes("slow")) state = "running";
  else if (prompt.includes("approve")) { state = "waiting_approval"; pending = { call_id: "call_1", tool: "Write", input: { file_path: "/tmp/x.txt", content: "hi" } }; }
  else if (prompt.includes("tool")) events.push({ event: "tool", id: "call_r", role: "assistant", tool: "Read", status: "completed", input: { file_path: "/tmp/a" } });
  if (state === "completed") events.push({ event: "reasoning", id: nid(), role: "assistant", text: "thinking" }, { event: "text", id: nid(), role: "assistant", text: "ANSWER:" + prompt.split(/\s+/)[0] });
  return { events, state, pending };
}
// FAKE_ZC_MAX emulates zcbridge's parallel limit: send/continue answer parallel_limit while that many tasks are running (cancelled ones are not)
function limitCheck() {
  const max = Number(process.env.FAKE_ZC_MAX || 0);
  if (!max) return;
  const running = fs.readdirSync(dir).filter((f) => /^task_.*\.json$/.test(f)).map((f) => JSON.parse(fs.readFileSync(path.join(dir, f), "utf8"))).filter((d) => !d.cancelled && ["running", "waiting_approval"].includes(d.turns.at(-1).state)).length;
  if (running >= max) out({ ok: false, error: { code: "parallel_limit", message: `${running} of ${max} ZCode tasks are running`, running, limit: max } });
}
if (cmd === "models") out({ ok: true, models: [{ name: "GLM-5.3-Flash", enabled: true }, { name: "GLM-5.3", enabled: true }], default: "GLM-5.3-Flash" });
if (cmd === "mode-reset" || cmd === "project-remove") out({ ok: true });
if (cmd === "projects") out({ ok: true, projects: [{ id: "p", name: "p", roots: [process.env.FAKE_ZC_ROOT || "/"] }] });
if (cmd === "send") { limitCheck(); const t = "task_" + Date.now() + "_" + Math.random().toString(36).slice(2, 7); save(t, { turns: [newTurn(promptOf())], cwd: flag("--folder"), model: flag("--model"), effort: flag("--effort") }); out({ ok: true, task_id: t, project_created: process.env.FAKE_ZC_CREATED === "1" }); }
if (cmd === "continue") { limitCheck(); const t = rest[0]; const d = load(t); d.turns.push(newTurn(promptOf())); save(t, d); out({ ok: true, task_id: t }); }
if (cmd === "status") { const d = load(rest[0]); const tu = d.turns.at(-1); out({ ok: true, state: d.cancelled ? "cancelled" : tu.state, tokens: { input: 10, output: 2, reasoning: 1, cache_read: 0 }, error: tu.state === "error" ? tu.error || "boom" : null }); }
if (cmd === "result") out({ ok: true, answer: "RESULT" });
if (cmd === "approvals") { const d = load(rest[0]); const tu = d.turns.at(-1); out({ ok: true, pending: tu.pending ? [tu.pending] : [] }); }
if (cmd === "approve" || cmd === "deny") {
  const t = rest[0]; const d = load(t); const tu = d.turns.at(-1); const card = tu.pending; tu.pending = null; tu.state = "completed";
  tu.events.push({ event: "tool", id: card.call_id, role: "assistant", tool: card.tool, status: cmd === "approve" ? "completed" : "error", input: card.input });
  tu.events.push({ event: "text", id: nid(), role: "assistant", text: cmd === "approve" ? "APPROVED" : "DENIED" });
  save(t, d); out({ ok: true, actions: [{ applied: cmd }] });
}
if (cmd === "cancel") { const d = load(rest[0]); d.cancelled = true; d.turns.at(-1).state = "cancelled"; save(rest[0], d); out({ ok: true, state: "cancelled" }); }
if (cmd === "watch") {
  const t = rest[0]; const sent = new Set(); const end = Date.now() + 20000; let polls = 0;
  const tick = () => {
    const d = load(t); const all = d.turns.flatMap((x) => x.events); polls++;
    all.forEach((e, i) => { if (!sent.has(i) && (e.tick || 0) <= polls) { sent.add(i); const { tick: _t, delta: _d, ...ev } = e; console.log(JSON.stringify(ev)); } });
    const tu = d.turns.at(-1); let state = d.cancelled ? "cancelled" : tu.state;
    if (sent.size < all.length && state === "completed") state = "running";
    if (["completed", "error", "cancelled", "waiting_approval"].includes(state) || Date.now() > end) { console.log(JSON.stringify({ event: "state", state, pending_approvals: tu.pending ? [tu.pending] : [], tokens: { input: 10, output: 2, reasoning: 1, cache_read: 0 }, error: state === "error" ? tu.error || "boom" : null })); process.exit(0); }
    setTimeout(tick, 100);
  };
  tick();
} else if (!["projects", "send", "continue", "status", "result", "approvals", "approve", "deny", "cancel", "models", "mode-reset", "project-remove"].includes(cmd)) out({ ok: false, error: { code: "unknown", message: cmd } });
