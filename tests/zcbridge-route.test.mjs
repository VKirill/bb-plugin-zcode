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
m.invalidate_promo_cache = lambda: None
m.cached_promo_ready = lambda: None
m.time.sleep = lambda _: None
def press(role, label, **kw):
 global selected, opened
 calls.append([role, label])
 if role == 'AXPopUpButton': opened = not opened
 if role == 'AXMenuItem' and label == '=Start Plan Free': selected = 'Start Plan'
 if role == 'AXMenuItem' and label == '=Z.ai Individual': selected = 'Z.ai'
m.press = press
m.menu_items = lambda: [[f'Provider: {selected}', ''], ['Z.ai Individual', '1' if selected == 'Z.ai' else '0'], ['Start Plan Free', '1' if selected == 'Start Plan' else '0']]
m.popup_open = lambda: opened
m.composer_snapshot = lambda: dict(model='GLM-5.3-Flash', effort='low', mode='Full access', plan=False, menu_open=opened, provider=selected if opened else None, menu_items=[dict(name=n, enabled=True) for n, _ in m.menu_items()] if opened else [])
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

test("route: a warm Ready result switches provider and configures the model in a single menu opening", () => {
  const r = runPython(picker + `
m.cached_promo_ready = lambda: True
def forbidden(): raise AssertionError('warm Ready must not navigate to settings')
m.read_promo_ready = forbidden
route, note = m.choose_route('free', 'GLM-5.3-Flash', effort='low')
print(json.dumps(dict(route=route, calls=calls, opened=opened)))
`);
  assert.equal(r.route, "promo");
  assert.equal(r.calls.filter(([role]) => role === "AXPopUpButton").length, 2); // open + close
  assert.equal(r.opened, false);
});

test("route: an already correct free provider uses one menu reading and no settings visit", () => {
  const r = runPython(picker + `
selected = 'Start Plan'
def forbidden(): raise AssertionError('already selected route must not navigate to settings')
m.read_promo_ready = forbidden
route, note = m.choose_route('free', 'flash', effort='low')
print(json.dumps(dict(route=route, calls=calls)))
`);
  assert.equal(r.route, "promo");
  assert.equal(r.calls.filter(([role]) => role === "AXPopUpButton").length, 2);
  assert.ok(!r.calls.some(([role]) => role === "AXMenuItem"));
});

test("route and effort changes share one menu; the resulting chip is checked after closing", () => {
  const r = runPython(picker + `
m.cached_promo_ready = lambda: True
effort = ['max']
snapshot = m.composer_snapshot
def state():
 s = snapshot(); s['effort'] = effort[0]; s['effort_index'] = m.EFFORT[effort[0]] if opened else None
 return s
m.composer_snapshot = state
def action(*a,**kw):
 assert a[:3] == ('action','AXSlider','Effort')
 calls.append(['action',a[3]])
 effort[0] = 'high' if effort[0]=='max' else 'low'
m.zc = action
route, note = m.choose_route('free', 'flash', effort='low')
print(json.dumps(dict(route=route, effort=effort[0], calls=calls)))
`);
  assert.equal(r.route, "promo");
  assert.equal(r.effort, "low");
  assert.equal(r.calls.filter(([role]) => role === "AXPopUpButton").length, 2);
  assert.equal(r.calls.filter(([role]) => role === "action").length, 2);
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
m.wait_snapshot = lambda *a, **kw: {}
m.time.sleep = lambda _: None
def reset(*a, **kw):
 global selected
 selected = 'plan'
m.zc = lambda *a, **kw: reset() if 'New task' in ' '.join(a) else None
def workspace(*a):
 reset()
 return None
m.choose_workspace = workspace
def choose(*a, **kw):
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
