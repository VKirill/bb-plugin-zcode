import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import ts from "typescript";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

test("concurrent host status requests share diagnostics; explicit quota refreshes stay fresh", (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "zcode-host-status-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  fs.writeFileSync(path.join(dir, "package.json"), '{"type":"module"}');
  fs.symlinkSync(path.join(root, "node_modules"), path.join(dir, "node_modules"), "dir");
  for (const name of ["host", "contract"]) {
    const source = fs.readFileSync(path.join(root, name + ".ts"), "utf8");
    fs.writeFileSync(path.join(dir, name + ".js"), ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext } }).outputText);
  }
  const home = path.join(dir, "home");
  fs.mkdirSync(path.join(home, "Applications/ZCode.app"), { recursive: true });
  fs.mkdirSync(path.join(dir, "bin"));
  fs.writeFileSync(path.join(dir, "bin/zcbridge"), `#!/usr/bin/env node
import fs from 'node:fs';
const cmd=process.argv[2]; fs.appendFileSync(process.env.ZCODE_TEST_LOG,cmd+'\\n');
console.log(JSON.stringify(cmd==='version'?{ok:true,version:'test',zcax_found:true}:cmd==='doctor'?{ok:true,checks:{app_running:true,session_expired:false}}:{ok:true,quota:{Flash:{remaining:'100%'}}}));
`, { mode: 0o755 });
  const script = `
import { experimental_createHostEntryHarness } from '@get-bb/plugin-sdk/testing/host';
import entry from './host.js';
const h=experimental_createHostEntryHarness(entry);
const [a,b]=await Promise.all([h.experimental_call('status',{}),h.experimental_call('status',{})]);
a.problems.push('client mutation');
const c=await h.experimental_call('status',{});
const q1=await h.experimental_call('readQuota',{});
const q2=await h.experimental_call('readQuota',{});
await h.experimental_dispose();
console.log(JSON.stringify({isolated:!b.problems.includes('client mutation')&&!c.problems.includes('client mutation'),quota:q1.quota.Flash.remaining===q2.quota.Flash.remaining}));
`;
  fs.writeFileSync(path.join(dir, "run.mjs"), script);
  const log = path.join(dir, "calls.log");
  const output = execFileSync(process.execPath, [path.join(dir, "run.mjs")], { encoding: "utf8", env: { ...process.env, HOME: home, PATH: path.join(dir, "bin") + path.delimiter + process.env.PATH, ZCODE_TEST_LOG: log } });
  assert.deepEqual(JSON.parse(output), { isolated: true, quota: true });
  assert.deepEqual(fs.readFileSync(log, "utf8").trim().split("\n"), ["version", "doctor", "usage", "usage"]);
});
