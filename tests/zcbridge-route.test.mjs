import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const bridge = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "bin", "zcbridge");
function runPython(code) {
  const py = [
    "import importlib.machinery, importlib.util, json",
    "loader = importlib.machinery.SourceFileLoader('zcb', " + JSON.stringify(bridge) + ")",
    "m = importlib.util.module_from_spec(importlib.util.spec_from_loader('zcb', loader)); loader.exec_module(m)",
    code,
  ].join("\n");
  return JSON.parse(execFileSync("python3", ["-c", py], { encoding: "utf8" }));
}

const picker = `
selected = 'Z.ai'
opened = False
calls = []
m.need_app = m.to_workspace = m.close_stray_popups = lambda: None
m.dump = lambda *a: ''
m.slots_live = lambda: []
m.composer_model = lambda: ('GLM-5.3-Flash', 'Low')
m.wait_for = lambda *a, **kw: True
m.read_promo_ready = lambda: True
m.time.sleep = lambda _: None
def press(role, label, **kw):
 global selected, opened
 calls.append([role, label])
 if role == 'AXPopUpButton': opened = True
 if role == 'AXMenuItem' and label == '=Start Plan Free': selected = 'Start Plan'
 if role == 'AXMenuItem' and label == '=Z.ai Individual': selected = 'Z.ai'
m.press = press
m.menu_items = lambda: [[f'Provider: {selected}', ''], ['Z.ai Individual', '1' if selected == 'Z.ai' else '0'], ['Start Plan Free', '1' if selected == 'Start Plan' else '0']]
m.popup_open = lambda: opened
def esc(*a):
 global opened
 opened = False
m.esc = esc
`;

test("route: Start Plan is selected in the composer's Provider menu, not its settings detail row", () => {
  const r = runPython(picker + `
m.set_route('promo')
print(json.dumps(dict(selected=selected, route=m.current_route(), calls=calls, opened=opened)))
`);
  assert.equal(r.selected, "Start Plan");
  assert.equal(r.route, "promo");
  assert.ok(r.calls.some(([role, label]) => role === "AXMenuItem" && label === "=Start Plan Free"));
  assert.ok(!r.calls.some(([role]) => role === "AXButton"));
  assert.equal(r.opened, false);
});

test("route: a composer already on Start Plan is kept without changing the paid default", () => {
  const r = runPython(picker + `
selected = 'Start Plan'
print(json.dumps(dict(changed=m.set_route('promo'), route=m.current_route(), calls=calls)))
`);
  assert.equal(r.changed, false);
  assert.equal(r.route, "promo");
  assert.ok(!r.calls.some(([role]) => role === "AXMenuItem"));
});

test("route: an unreadable Start Plan status is not reported as zero free tokens", () => {
  const r = runPython(picker + `
m.read_promo_ready = lambda: None
try: m.choose_route('free', 'flash')
except m.BridgeError as e: print(json.dumps(dict(code=e.code, selected=selected)))
`);
  assert.equal(r.code, "promo_status_unknown");
  assert.equal(r.selected, "Z.ai");
});

test("route: Not ready still refuses the free model without selecting the paid plan", () => {
  const r = runPython(picker + `
m.read_promo_ready = lambda: False
try: m.choose_route('free', 'flash')
except m.BridgeError as e: print(json.dumps(dict(code=e.code, selected=selected)))
`);
  assert.equal(r.code, "promo_unavailable");
  assert.equal(r.selected, "Z.ai");
});

test("route: readiness follows the Start Plan row at any depth, never the next provider", () => {
  const r = runPython(`
indent = ' ' * 180
ready = indent + 'AXButton d="Start Plan"\\n' + indent + '  AXStaticText v="Start Plan"\\n' + indent + '  AXImage d="Ready"'
unknown = 'AXButton d="Start Plan"\\n  AXStaticText v="Start Plan"\\nAXButton d="Other"\\n  AXImage d="Ready"'
print(json.dumps([m.promo_ready(ready), m.promo_ready(unknown), m.start_plan_state(ready)['start_plan_ready']]))
`);
  assert.deepEqual(r, [true, null, true]);
});

test("route: the submitted draft keeps Start Plan after creating a new task and choosing its workspace", () => {
  const r = runPython(`
import contextlib, argparse
selected = 'plan'
m.ui_lock = contextlib.nullcontext
m.need_app = m.guard = m.to_workspace = m.close_stray_popups = lambda: None
m.read_prompt = lambda _: 'test'
m.check_mode_policy = lambda _: None
m.slot_acquire = lambda *a: 'own'
m.slot_update = m.slot_release = lambda *a, **kw: None
m.sessions = lambda: []
m.wait_for = lambda *a: True
m.time.sleep = lambda _: None
def reset(*a, **kw):
 global selected
 selected = 'plan'
m.zc = lambda *a, **kw: reset() if 'New task' in ' '.join(a) else None
def workspace(*a):
 reset()
 return None
m.choose_workspace = workspace
def choose(*a):
 global selected
 selected = 'promo'
 return selected, None
m.choose_route = choose
m.set_model = m.set_mode = lambda *a: None
def submit(*a):
 assert selected == 'promo', 'New task or workspace reset the free connection before Send'
m.submit = submit
m.wait_new_session = lambda *a: 'session_test'
m.log = lambda *a: None
a = argparse.Namespace(mode='ask', folder=None, no_create_project=False, queue_timeout=0, route='free', model='flash', effort='low', wait=False)
print(json.dumps(m.do_send(a)))
`);
  assert.equal(r.route, "promo");
  assert.equal(r.task_id, "session_test");
});
