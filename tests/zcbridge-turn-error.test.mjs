import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const bridge = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "bin", "zcbridge");
const py = (code) => execFileSync("python3", ["-c", [
  "import importlib.machinery, importlib.util, json, sqlite3",
  `loader = importlib.machinery.SourceFileLoader('zcb', ${JSON.stringify(bridge)})`,
  "m = importlib.util.module_from_spec(importlib.util.spec_from_loader('zcb', loader)); loader.exec_module(m)",
  "c = sqlite3.connect(':memory:'); c.row_factory = sqlite3.Row",
  "c.execute('create table message (id text, session_id text, time_created int, data text)')",
  code,
].join("\n")], { encoding: "utf8" }).trim();

// 2026-10-30: five GLM sessions failed on the Start Plan's 429 «user concurrency limit exceeded» and BB showed only UNKNOWN_ERROR.
test("a failed turn names the provider's error instead of UNKNOWN_ERROR", () => {
  const out = py([
    "err = dict(role='assistant', error=dict(name='AiSdkModelAdapterError', data=dict(message='user concurrency limit exceeded', code='model_rate_limited')))",
    "c.execute('insert into message values (?,?,?,?)', ('m1', 's1', 1, json.dumps(dict(role='assistant'))))",
    "c.execute('insert into message values (?,?,?,?)', ('m2', 's1', 2, json.dumps(err)))",
    "print(m.turn_error(c, 's1', 'UNKNOWN_ERROR'))",
  ].join("\n"));
  assert.equal(out, "model_rate_limited: user concurrency limit exceeded");
});

test("a failed turn without a recorded model error keeps the turn's code", () => {
  const out = py([
    "c.execute('insert into message values (?,?,?,?)', ('m1', 's1', 1, json.dumps(dict(role='assistant'))))",
    "print(m.turn_error(c, 's1', 'UNKNOWN_ERROR'))",
  ].join("\n"));
  assert.equal(out, "UNKNOWN_ERROR");
});
