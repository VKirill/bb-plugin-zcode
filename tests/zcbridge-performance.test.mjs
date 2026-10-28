import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const bridge = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "bin", "zcbridge");
function python(code) {
  return JSON.parse(execFileSync("python3", ["-c", [
    "import importlib.machinery, importlib.util, json, sqlite3, tempfile, os, argparse",
    `loader = importlib.machinery.SourceFileLoader('zcb', ${JSON.stringify(bridge)})`,
    "m = importlib.util.module_from_spec(importlib.util.spec_from_loader('zcb', loader)); loader.exec_module(m)", code,
  ].join("\n")], { encoding: "utf8" }));
}

const fixture = `
tmp = tempfile.TemporaryDirectory()
m.DBP = os.path.join(tmp.name, 'db.sqlite')
w = sqlite3.connect(m.DBP)
w.executescript('create table message(id text primary key,session_id text,time_created int,data text); create table part(id text primary key,message_id text,session_id text,time_created int,time_updated int,sequence int,data text);')
w.execute('insert into message values(?,?,?,?)', ('a','s',1000,json.dumps(dict(role='assistant'))))
for i in range(50): w.execute('insert into part values(?,?,?,?,?,?,?)', (str(i),'a','s',1000,1000,i,json.dumps(dict(type='text',text='old'+str(i)))))
w.execute('insert into part values(?,?,?,?,?,?,?)', ('last','a','s',100000,100000,50,json.dumps(dict(type='text',text='A'))))
w.commit()
`;

test("watch incrementally reads updated existing parts and suppresses overlap, including equal timestamps", () => {
  const r = python(fixture + `
seen = {}; cursor = dict(since=0)
first = m.watch_events('s', seen, cursor)
second = m.watch_events('s', seen, cursor)
w.execute('update part set data=?,time_updated=? where id=?', (json.dumps(dict(type='text',text='AB')),110000,'last'))
w.execute('update part set data=?,time_updated=? where id=?', (json.dumps(dict(type='text',text='changed-old')),110000,'0'))
w.commit()
changed = m.watch_events('s', seen, cursor)
again = m.watch_events('s', seen, cursor)
print(json.dumps(dict(first=len(first), second=len(second), changed=[e['text'] for e in changed], again=len(again), cursor=cursor)))
`);
  assert.equal(r.first, 51);
  assert.equal(r.second, 0);
  assert.deepEqual(r.changed, ["changed-old", "AB"]);
  assert.equal(r.again, 0);
  assert.equal(r.cursor.since, 109000);
});

test("parts filters history in SQL; a quiet poll parses the recent window only, on one read-only connection", () => {
  const r = python(fixture + `
seen = {}; cursor = dict(since=0); m.watch_events('s', seen, cursor)
loads = m.json.loads; count = [0]
def counted(s):
 count[0] += 1
 return loads(s)
m.json.loads = counted
m.watch_events('s', seen, cursor)
same = m.conn(m.DBP) is m.conn(m.DBP)
try:
 m.conn(m.DBP).execute('delete from part')
 readonly = False
except sqlite3.OperationalError: readonly = True
print(json.dumps(dict(parsed=count[0], same=same, readonly=readonly)))
`);
  assert.equal(r.parsed, 1);
  assert.equal(r.same, true);
  assert.equal(r.readonly, true);
});

test("stale-only model refresh rechecks the cache under the shared refresh lock before touching UI", () => {
  const r = python(`
with tempfile.TemporaryDirectory() as d:
 m.STATE = d; m.MODELS_FILE = os.path.join(d,'models.json')
 with open(m.MODELS_FILE,'w') as f: json.dump(dict(at=m.time.time(), models=[dict(name='Flash',enabled=True)]),f)
 def forbidden(*a,**kw): raise AssertionError('fresh model cache must not touch UI')
 m.ui_lock = forbidden
 print(json.dumps(m.do_models(argparse.Namespace(cached=False,if_stale=True))))
`);
  assert.equal(r.ok, true);
  assert.equal(r.models[0].name, "Flash");
});

test("a late paste confirmed on a fresh editor is accepted without clearing or duplicating the text", () => {
  const r = python(`
calls = []
def zc(*a,**kw):
 calls.append(a[0])
 if a[0]=='bgpaste': return 'ERR text-not-visible'
 if a[0]=='textlen': return 'OK len=5 chars=5 tail=hello'
 raise AssertionError('must not clear a confirmed delayed paste')
m.zc=zc; m.log=lambda *a: None
print(json.dumps(dict(ok=m.paste('hello'), calls=calls)))
`);
  assert.equal(r.ok, true);
  assert.deepEqual(r.calls, ["bgpaste", "textlen"]);
});

test("a failed paste with a wrong tail still clears before retrying", () => {
  const r = python(`
calls = []; attempts = [0]
def zc(*a,**kw):
 calls.append(a[0])
 if a[0]=='bgpaste':
  attempts[0]+=1
  return 'ERR text-not-visible' if attempts[0]==1 else 'OK pasted'
 if a[0]=='textlen': return 'OK len=5 chars=5 tail=wrong'
 if a[0]=='bgclear': return 'OK cleared'
 raise AssertionError(a)
m.zc=zc; m.log=lambda *a: None
print(json.dumps(dict(ok=m.paste('hello'), calls=calls)))
`);
  assert.equal(r.ok, true);
  assert.deepEqual(r.calls, ["bgpaste", "textlen", "bgclear", "bgpaste"]);
});

test("mode state waits preserve Plan as a separate toggle and remove it on the next Full task", () => {
  const r = python(`
state = dict(mode='Full access', plan=False, menu_open=False, menu_items=[])
def snapshot(): return dict(state)
m.composer_snapshot = snapshot
def press(role,label,**kw):
 if role=='AXPopUpButton':
  state['menu_open']=True
  state['menu_items']=[dict(name=x) for x in ['Ask before changes','Full access','Plan mode']]
 elif role=='AXMenuItem':
  if label=='=Plan mode': state['plan']=True
  else: state['mode']=label[1:]
  state['menu_open']=False
 elif label=='='+m.PLAN_CHIP: state['plan']=False
m.press=press
m.set_mode('plan'); planned=dict(state)
m.set_mode('full')
print(json.dumps(dict(planned=planned, final=state)))
`);
  assert.equal(r.planned.mode, "Ask before changes");
  assert.equal(r.planned.plan, true);
  assert.equal(r.final.mode, "Full access");
  assert.equal(r.final.plan, false);
});

test("project navigation waits for the new-task project chip, not the previous task's editor", () => {
  const r = python(`
states = iter([dict(workspace=True,model='Flash',new_task=False,project_selected=False), dict(workspace=True,model='Flash',new_task=True,project_selected=True)])
m.dump=lambda *a: 'AXButton t="work2"\\n  AXButton d="New task"'
m.zc=lambda *a,**kw: 'OK'
m.composer_snapshot=lambda: next(states)
m.exists=lambda *a: False
m.time.sleep=lambda _: None
print(json.dumps(m.open_project_new_task(dict(name='work2'))))
`);
  assert.equal(r, true);
});

test("session discovery waits for this prompt when one unrelated task appears first", () => {
  const r = python(`
scans=iter([{'foreign'},{'foreign','own'}])
m.sessions=lambda: next(scans)
m.first_user_text=lambda sid: '[bb:123456] mine' if sid=='own' else 'someone else'
class DB:
 def execute(self, sql, args):
  self.sid=args[0]; return self
 def fetchone(self): return [1 if self.sid=='foreign' else 2]
m.conn=lambda _: DB()
m.time.sleep=lambda _: None
print(json.dumps(m.wait_new_session(set(),prompt='[bb:123456] mine')))
`);
  assert.equal(r, "own");
});

test("Send handles the Start Plan suggestion without switching the requested paid route", () => {
  const r = python(`
calls=[]
m.guard=lambda: None
m.composer_text=lambda: 'AXTextArea v="\\\\n"'
m.paste=lambda _: True
m.zc=lambda *a,**kw: ''
m.press=lambda role,label,**kw: calls.append(label)
m.composer_snapshot=lambda: dict(promo_offer=True,composer_empty=False) if len(calls)==1 else dict(promo_offer=False,composer_empty=True)
m.submit('test')
print(json.dumps(calls))
`);
  assert.deepEqual(r, ["=Send", "=Not now"]);
});

test("an already selected workspace is confirmed by its item, without toggling its trigger", () => {
  const r = python(`
m.find_project=lambda _: dict(name='work2')
state=dict(new_task=True,workspace=True,model='Flash',menu_open=False,menu_items=[])
m.composer_snapshot=lambda: dict(state)
calls=[]
def press(role,label,**kw):
 calls.append([role,label])
 state['menu_open']=role=='AXPopUpButton'
 state['menu_items']=[dict(name='work2',checked=True)] if state['menu_open'] else []
m.press=press
m.esc=lambda *a: (_ for _ in ()).throw(AssertionError('do not toggle workspace trigger'))
print(json.dumps(dict(project=m.choose_workspace('/project'),calls=calls)))
`);
  assert.deepEqual(r.calls, [["AXPopUpButton", "=Choose workspace"], ["AXMenuItem", "=work2"]]);
});

test("UI navigation activates ZCode once and restores the previous app even on an error", () => {
  const r = python(`
with tempfile.TemporaryDirectory() as d:
 m.STATE=d
 front=['com.example.Editor']; calls=[]
 m.frontmost=lambda: front[0]
 m.reveal=lambda: {}
 def zc(*a,**kw):
  calls.append(a[0]); front[0]=m.BUNDLE; return 'OK'
 m.zc=zc
 def run(*a,**kw):
  activating=a[0][0]=='open'
  calls.append('activate' if activating else 'restore'); front[0]=m.BUNDLE if activating else 'com.example.Editor'
 m.subprocess.run=run
 try:
  with m.ui_lock():
   assert front[0]==m.BUNDLE
   raise ValueError('test failure')
 except ValueError: pass
 print(json.dumps(dict(calls=calls,front=front[0])))
`);
  assert.deepEqual(r.calls, ["activate", "restore"]);
  assert.equal(r.front, "com.example.Editor");
});

test("removing the Plan chip is allowed by the real button policy", () => {
  const r = python(`
state=dict(mode='Full access',plan=True,menu_open=False)
m.composer_snapshot=lambda: dict(state)
m.time.sleep=lambda _: None
def zc(*a,**kw):
 assert a==('press','AXButton','='+m.PLAN_CHIP)
 state['plan']=False; return 'OK'
m.zc=zc
print(json.dumps(dict(changed=m.set_mode('full'),plan=state['plan'])))
`);
  assert.equal(r.plan, false);
  assert.equal(r.changed, true);
});

test("duplicate automatic titles use the unique prompt tag inside the conversation, not Copy session ID", () => {
  const r = python(`
class DB:
 def execute(self,*a): return self
 def fetchone(self): return [2]
m.conn=lambda _: DB()
m.task_tag=lambda _: '[bb:123456]'
m.last_prompt=lambda _: 'second prompt'
clips=[]
def clip(): clips.append('copy'); return 's'
m.clip_session_id=clip
m.dump=lambda: 'AXGroup id=sidebar\\n  AXStaticText v="other"\\nAXGroup id=conversation\\n  AXStaticText v="[bb:123456] first prompt"\\n  AXStaticText v="second prompt"\\nAXGroup id=terminal'
correct=m.verify_open('s',dict(title='Same generated title'))
m.dump=lambda: 'AXGroup id=sidebar\\n  AXStaticText v="[bb:123456] first prompt"\\nAXGroup id=conversation\\n  AXStaticText v="second prompt"'
fallback=m.verify_open('s',dict(title='Same generated title'))
print(json.dumps(dict(correct=correct,fallback=fallback,clips=clips)))
`);
  assert.equal(r.correct, true);
  assert.equal(r.fallback, true);
  assert.deepEqual(r.clips, ["copy"]);
});
