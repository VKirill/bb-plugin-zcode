// Minimal ACP client for tests and the live smoke script: spawns an agent, correlates requests, records updates.
import { spawn } from "node:child_process";
import readline from "node:readline";

export function startAgent(command, args, env = {}) {
  const child = spawn(command, args, { env: { ...process.env, ...env }, stdio: ["pipe", "pipe", "inherit"] });
  let id = 0;
  const pending = new Map();
  const updates = [];
  const waiters = [];
  const handlers = { permission: () => "allow" };
  const write = (m) => child.stdin.write(JSON.stringify({ jsonrpc: "2.0", ...m }) + "\n");
  readline.createInterface({ input: child.stdout }).on("line", (line) => {
    const m = JSON.parse(line);
    if (m.method === "session/update") {
      updates.push(m.params.update);
      for (const w of [...waiters]) w();
    } else if (m.method === "session/request_permission") {
      const choice = handlers.permission(m.params);
      write({ id: m.id, result: choice === "cancel" ? { outcome: { outcome: "cancelled" } } : { outcome: { outcome: "selected", optionId: choice } } });
    } else if (m.id !== undefined && pending.has(m.id)) {
      const p = pending.get(m.id);
      pending.delete(m.id);
      m.error ? p.reject(Object.assign(new Error(m.error.message), { code: m.error.code })) : p.resolve(m.result);
    }
  });
  return {
    child,
    updates,
    handlers,
    request(method, params) {
      const i = ++id;
      return new Promise((resolve, reject) => {
        pending.set(i, { resolve, reject });
        write({ id: i, method, params });
      });
    },
    notify: (method, params) => write({ method, params }),
    waitFor(pred, ms = 15000) {
      return new Promise((resolve, reject) => {
        const t = setTimeout(() => reject(new Error("timeout waiting for update")), ms);
        const check = () => {
          const hit = updates.find(pred);
          if (hit) {
            clearTimeout(t);
            waiters.splice(waiters.indexOf(check), 1);
            resolve(hit);
          }
        };
        waiters.push(check);
        check();
      });
    },
    close() {
      child.stdin.end();
      child.kill("SIGTERM");
    },
  };
}
export const text = (updates, kind = "agent_message_chunk") => updates.filter((u) => u.sessionUpdate === kind).map((u) => u.content.text).join("");
