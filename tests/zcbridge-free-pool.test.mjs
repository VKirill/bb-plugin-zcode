import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const bridge = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "bin", "zcbridge");
const py = (code, env = {}) => execFileSync("python3", ["-c", [
  "import importlib.machinery, importlib.util, json",
  `loader = importlib.machinery.SourceFileLoader('zcb', ${JSON.stringify(bridge)})`,
  "m = importlib.util.module_from_spec(importlib.util.spec_from_loader('zcb', loader)); loader.exec_module(m)",
  "m.task_state = lambda t: dict(state='running')",
  code,
].join("\n")], { encoding: "utf8", env: { ...process.env, HOME: fs.mkdtempSync(path.join(os.tmpdir(), "zcb-pool-")), ...env } }).trim();

// 2026-10-30: the free plan answers 429 past about two requests; free tasks get their own limit inside the general one.
test("free tasks queue behind the free limit while plan tasks still start", () => {
  const out = py([
    "a = m.slot_acquire(0, 'send', 'free'); m.slot_update(a, task_id='t1')",
    "try:\n    m.slot_acquire(0, 'send', 'free'); print('second free started')\nexcept m.BridgeError as e:\n    print(e.code, e.extra.get('pool') if hasattr(e, 'extra') else '')",
    "b = m.slot_acquire(0, 'send'); m.slot_update(b, task_id='t2'); print('plan started')",
    "print(json.dumps({k: v for k, v in m.do_slots(None).items() if k in ('limit', 'limit_free', 'held', 'held_free')}, sort_keys=True))",
  ].join("\n"), { ZCODE_MAX_PARALLEL: "3" });
  const lines = out.split("\n");
  assert.match(lines[0], /^parallel_limit/);
  assert.equal(lines[1], "plan started");
  assert.deepEqual(JSON.parse(lines[2]), { held: 2, held_free: 1, limit: 3, limit_free: 1 });
});

test("ZCODE_MAX_PARALLEL_FREE raises the free limit", () => {
  const out = py("a = m.slot_acquire(0, 'send', 'free'); m.slot_update(a, task_id='t1')\nb = m.slot_acquire(0, 'send', 'free'); print('two free')", { ZCODE_MAX_PARALLEL_FREE: "2" });
  assert.equal(out, "two free");
});
