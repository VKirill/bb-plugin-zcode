// Live proof that ZCode tasks run side by side through zcode-acp (Mac mini, real zcbridge, real ZCode; spends a little of the owner's plan).
// usage: node scripts/live-parallel.mjs <project folder known to ZCode> [reads per task, default 25]
// Three ACP agent processes (like three BB chats) start a task each, back to back. Each task reads N small files one tool call at a time, so it
// runs for about a minute. While the others run, task C is cancelled, and task A gets a second turn (continue) as soon as its first turn ends.
// Prints the time line, then the check of every answer. Exit code 1 when an answer is wrong or the tasks did not overlap.
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { startAgent, text } from "../tests/support/acp-client.mjs";

const cwd = process.argv[2];
const N = Number(process.argv[3] || 25);
if (!cwd) throw new Error("usage: live-parallel.mjs <folder> [reads]");
const dir = path.join(cwd, "par-live");
fs.mkdirSync(dir, { recursive: true });
const codes = {};
for (const t of ["A", "B", "C"]) {
  codes[t] = [];
  for (let i = 1; i <= N; i++) {
    const code = `${t}${i}-${Math.floor(Math.random() * 90000 + 10000)}`;
    codes[t].push(code);
    fs.writeFileSync(path.join(dir, `${t}${i}.txt`), code + "\n");
  }
}
const bin = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "bin", "zcode-acp");
const t0 = Date.now();
const lap = (s) => console.log(`[${((Date.now() - t0) / 1000).toFixed(1)}s] ${s}`);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const ask = (t) => `Read the ${N} files par-live/${t}1.txt to par-live/${t}${N}.txt in this folder, ONE file per Read call, strictly one after another (no Glob, no Bash). Then reply with exactly the ${N} file contents joined by a single space and nothing else.`;

const agents = {};
const sess = {};
for (const t of ["A", "B", "C"]) {
  agents[t] = startAgent(bin, [], {});
  await agents[t].request("initialize", { protocolVersion: 1 });
  sess[t] = await agents[t].request("session/new", { cwd, mcpServers: [] });
  await agents[t].request("session/set_config_option", { sessionId: sess[t].sessionId, configId: "effort", value: "low" });
}
const prompt = (t, text_) => agents[t].request("session/prompt", { sessionId: sess[t].sessionId, prompt: [{ type: "text", text: text_ }] });
const done = {};
const run = (t, text_) => {
  agents[t].updates.length = 0;
  return prompt(t, text_).then((r) => {
    done[t] = Date.now();
    lap(`${t} -> ${r.stopReason}`);
    return r;
  });
};

lap("start A, B, C back to back");
const pa = run("A", ask("A"));
await sleep(500);
const pb = run("B", ask("B"));
await sleep(500);
const pc = run("C", ask("C"));

// wait until all three ZCode tasks exist and are running, then cancel C while A and B keep going
const tasks = () => JSON.parse(fs.readFileSync(path.join(os.homedir(), ".zcode-bridge", "acp-sessions.json"), "utf8"));
for (let i = 0; i < 240; i++) {
  const m = tasks();
  if (["A", "B", "C"].every((t) => m[sess[t].sessionId]?.taskId)) break;
  await sleep(500);
}
lap("all three ZCode tasks started: " + ["A", "B", "C"].map((t) => tasks()[sess[t].sessionId]?.taskId?.slice(0, 16)).join(", "));
await sleep(12000);
const tc = Date.now();
agents.C.notify("session/cancel", { sessionId: sess.C.sessionId });
const rc = await pc;
lap(`C cancelled while A and B run (${((Date.now() - tc) / 1000).toFixed(1)} s)`);

const ra = await pa;
const textA = text(agents.A.updates).trim();
lap(`A first turn done; B still running: ${done.B ? "no" : "yes"}`);
agents.A.updates.length = 0;
const pa2 = run("A", `Now reply with only the content of par-live/A1.txt (read it again if needed) and nothing else.`);
const rb = await pb;
const textB = text(agents.B.updates).trim();
const ra2 = await pa2;
const textA2 = text(agents.A.updates).trim();

const ids = ["A", "B", "C"].map((t) => tasks()[sess[t].sessionId].taskId);
console.log("task ids", ids.join(" "));
const rows = execFileSync("sqlite3", ["-readonly", path.join(os.homedir(), ".zcode/cli/db/db.sqlite"), `select substr(session_id,1,18), status, strftime('%H:%M:%S', started_at/1000,'unixepoch','localtime'), strftime('%H:%M:%S', completed_at/1000,'unixepoch','localtime'), tool_call_count from turn_usage where session_id in (${ids.map((i) => `'${i}'`).join(",")}) order by started_at`], { encoding: "utf8" });
console.log("turn_usage (session|status|started|completed|tools):\n" + rows);
const iv = execFileSync("sqlite3", ["-readonly", path.join(os.homedir(), ".zcode/cli/db/db.sqlite"), `select session_id, min(time_created), max(time_created) from part where session_id in (${ids.map((i) => `'${i}'`).join(",")}) group by session_id`], { encoding: "utf8" }).trim().split("\n").map((l) => l.split("|").map((x, i) => (i ? Number(x) : x)));
const overlap = Math.min(...iv.map((x) => x[2])) - Math.max(...iv.map((x) => x[1]));
console.log(`all three tasks had parts in the db at the same time for ${(overlap / 1000).toFixed(1)} s`);

const want = (t) => codes[t].join(" ");
const checks = [
  ["A answer", textA.endsWith(want("A"))],
  ["B answer", textB.endsWith(want("B"))],
  ["C cancelled", rc.stopReason === "cancelled"],
  ["A continue answer", textA2.endsWith(codes.A[0])],
  ["A/B ended end_turn", ra.stopReason === "end_turn" && rb.stopReason === "end_turn" && ra2.stopReason === "end_turn"],
  ["three tasks overlapped", overlap > 5000],
];
for (const [name, ok] of checks) console.log(`${ok ? "PASS" : "FAIL"} ${name}`);
if (!checks.every((c) => c[1])) {
  console.log("A:", textA.slice(0, 300), "\nB:", textB.slice(0, 300), "\nA2:", textA2.slice(0, 100));
}
for (const a of Object.values(agents)) a.close();
setTimeout(() => process.exit(checks.every((c) => c[1]) ? 0 : 1), 500);
