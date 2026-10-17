'use strict';

// unit-goal-completion-client.test.js — dsh-goal-completion 页内半边（lib/client.js）回归套件。
//
// 需求（2026-10-16 用户裁定「轻的」）：在内核右栏里做一个标签页，显示**屏幕上这个会话**的目标
// 状态机，并补上官方 GoalBar 唯一没暴露的动词 `remote.goals.complete`。官方界面拿不到 complete
// 是实测出来的：`dsh-client-ui-goal` 的字典只有 phase.active / active.disarmed / paused / blocked
// 四键、动作只有 save / cancel / pause / resume / edit / clear，目标只能等 agent 自己收尾。
//
// 本套件咬住的形态（每条都有出处，不是凭印象）：
//   · 会话 = 右栏标签槽 `inject(sessionId)` 给的那个（不读 sessions 的当前会话字段——rc.2 里
//     会话列表快照没有「当前会话」，better-sidebar 与 prompt-optimizer 2.3.0 各栽过一次）；
//   · 权威值 = `remote.goals.get(sessionId)`，`projections.faceOf("goal")` 与
//     `goal/activation-changed` 事件只当「变了」的信号；
//   · 写 = CAS `{ id, revision }` 用读到的那一份，冲突交内核判，被拒原文上屏后重读，
//     绝不用陈旧 revision 重试第二次；
//   · 界面 = 内核设计系统原语（Tag 八档语义色 / Button 四档 variant）+ `ctx.locale` 字典
//     命名空间（槽位声明 `locale: NS` 后由 renderer 注入 `t`），插件不覆盖原语配色。
//
// 挂载方式与 unit-builtin-manager-client / unit-prompt-custom-client 同族：本机没有 jsdom /
// react-test-renderer，用仓库里真实的 React + react/jsx-runtime，通过 React 内部 dispatcher
// 槽位手驱 useState/useRef/useMemo/useEffect/useSyncExternalStore。证据强度记为
// 「真实插件源码 + 复刻渲染夹具（非浏览器语义，仅本组件用到的钩子面）」——不冒充浏览器实测。
//
// 反证四条在文件末尾：摘掉 ok===false 分支、摘掉终态门控、摘掉第一击确认、摘掉事件的
// sessionId 过滤——判据必须按预期变形，否则前面的用例是在为不存在的守卫作证。
// 运行：node --test scripts/test/unit-goal-completion-client.test.js

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const React = require('react');
const jsxRuntime = require('react/jsx-runtime');

const DSH = path.resolve(__dirname, '..', '..');
const PKG_DIR = path.join(DSH, 'assets', 'plugins', 'dsh-goal-completion');
const CLIENT_FILE = path.join(PKG_DIR, 'lib', 'client.js');
const HOST_FILE = path.join(PKG_DIR, 'lib', 'index.js');
const PATCH_FILE = path.join(PKG_DIR, 'cordis.patch.yml');

// ---------------------------------------------------------------------------
// 内核原语桩：桩体不渲染（夹具只读 props），组件身份用于在树里定位。
// Button 的桩保留真实实现的约定：native button 属性直通，onClick 即点击。
// ---------------------------------------------------------------------------
const StubButton = function Button() { return null; };
const StubTag = function Tag() { return null; };
const primitivesStub = { Button: StubButton, Tag: StubTag };

const fakeRequire = (name) => {
  if (name === 'react') return React;
  if (name === 'react/jsx-runtime') return jsxRuntime;
  if (name === '@deepseek-ai/dsh-client-ui-primitives') return primitivesStub;
  throw new Error('client 不得 require 模块：' + name);
};

// ---------------------------------------------------------------------------
// 字典侧的最小同构：内核 translate 的三条规则——本命名空间 → common → 原样返回 key，
// 再做 `{name}` 插值（dsh-client-locale/lib/client.js 的 translate 实现逐字对齐）。
// 用「查不到就把 key 印到屏幕上」这条真实坏法，让下面的文案断言有牙齿。
// ---------------------------------------------------------------------------
function makeT(dict) {
  return (key, params) => {
    const template = Object.prototype.hasOwnProperty.call(dict, key) ? dict[key] : key;
    if (!params) return template;
    return template.replace(/\{(\w+)\}/g, (match, name) => (name in params ? String(params[name]) : match));
  };
}

// ---------------------------------------------------------------------------
// 在 vm 里跑真实 client 源码：__ModuleLoader__ 捕获模块，apply(ctx) 截获注册
// ---------------------------------------------------------------------------

/**
 * @param opts.tabs sidebarRightTabs 服务的形状（默认在位；传 null 模拟缺服务的旧内核）
 * @param opts.mutate 对**内存副本**做最后一改（反证用，绝不写回仓库文件）
 * @returns {{exports, registered:{typeOptions,slotOptions,Component}, localeCalls, storeDeps}}
 */
function loadPanel(opts = {}) {
  let src = fs.readFileSync(CLIENT_FILE, 'utf8');
  if (opts.mutate) src = opts.mutate(src);

  const sandbox = {
    window: { __ModuleLoader__: { load(mod) { sandbox.__loaded = mod; } } },
    console,
    setTimeout,
    clearTimeout,
    document: opts.document
  };
  vm.runInNewContext(src, sandbox, { filename: 'dsh-goal-completion-client.js' });

  const loaded = sandbox.__loaded;
  assert.ok(loaded && typeof loaded.factory === 'function', 'client.js 必须经 __ModuleLoader__.load 注册 factory');
  const exports = loaded.factory(fakeRequire);

  const registered = { typeOptions: null, slotOptions: null, Component: null, typeDisposals: 0, slotDisposals: 0 };
  const localeCalls = [];
  const tabsService = opts.tabs === null ? undefined : {
    register(options) { registered.typeOptions = options; return () => { registered.typeDisposals++; }; }
  };
  const ctx = {
    effect: (fn) => fn(),
    inject: (names, cb) => cb({ get: (n) => (names.includes(n) ? tabsService : undefined) }),
    slots: {
      // 真实写法是 inject(name, build, label) —— 跑一次 build() 让 register 交出两份入参。
      inject(_name, build) { const off = build(); registered.slotDisposals += typeof off === 'function' ? 1 : 0; return off; },
      register(options, Component) { registered.slotOptions = options; registered.Component = Component; }
    },
    locale: {
      register(ns, dicts) {
        localeCalls.push({ ns, dictKeys: Object.keys(dicts) });
        return () => { localeCalls.push({ ns, disposed: true }); };
      },
      bind: () => makeT(exports.__internals.zh)
    },
    sessions: opts.sessions || { binding: () => ({ session: {} }) },
    remote: { goals: opts.goals || { get: async () => undefined } },
    on: () => () => {}
  };
  exports.apply(ctx);
  return { exports, registered, localeCalls, ctx };
}

// ---------------------------------------------------------------------------
// mini 钩子驱动：够本组件用（useState / useRef / useMemo / useEffect / useSyncExternalStore）
// ---------------------------------------------------------------------------

function createMounter(Component, props) {
  const internals = React.__SECRET_INTERNALS_DO_NOT_USE_OR_YOU_WILL_BE_FIRED;
  assert.ok(internals && internals.ReactCurrentDispatcher, 'React 内部 dispatcher 槽位缺失（升级 React 需同步本夹具）');
  const slot = internals.ReactCurrentDispatcher;

  const cells = [];
  const pendingEffects = [];
  let scheduled = false;
  let cursor = 0;
  let tree = null;

  const sameDeps = (a, b) => a && b && a.length === b.length && a.every((v, i) => Object.is(v, b[i]));

  const hooks = {
    useState(init) {
      const i = cursor++;
      if (!(i in cells)) cells[i] = { value: typeof init === 'function' ? init() : init };
      const cell = cells[i];
      const set = (next) => {
        const v = typeof next === 'function' ? next(cell.value) : next;
        if (Object.is(v, cell.value)) return;
        cell.value = v;
        scheduled = true;
      };
      return [cell.value, set];
    },
    useRef(initial) {
      const i = cursor++;
      if (!(i in cells)) cells[i] = { current: initial };
      return cells[i];
    },
    useMemo(factory, deps) {
      const i = cursor++;
      const prev = cells[i];
      if (!prev || !sameDeps(prev.deps, deps)) cells[i] = { value: factory(), deps };
      return cells[i].value;
    },
    useCallback: (fn, deps) => hooks.useMemo(() => fn, deps),
    useEffect(fn, deps) {
      const i = cursor++;
      const prev = cells[i];
      if (!prev || !sameDeps(prev.deps, deps)) pendingEffects.push(fn);
      cells[i] = { deps };
    },
    useSyncExternalStore(subscribe, getSnapshot) {
      const i = cursor++;
      if (!(i in cells)) {
        const dispose = subscribe(() => { scheduled = true; });
        cells[i] = { dispose, getSnapshot };
      }
      return getSnapshot();
    }
  };

  const render = () => {
    cursor = 0;
    const prev = slot.current;
    slot.current = hooks;
    try { tree = Component(props); } finally { slot.current = prev; }
    return tree;
  };
  const flushEffects = () => { for (const fn of pendingEffects.splice(0)) fn(); };

  /** 渲染 → 跑 effect → 等异步沉降 → 有 setState 就再渲染（有界轮次）。 */
  const settle = async (rounds = 16) => {
    for (let i = 0; i < rounds; i++) {
      scheduled = false;
      render();
      flushEffects();
      await new Promise((r) => setImmediate(r));
      if (!scheduled && pendingEffects.length === 0) break;
    }
    return tree;
  };
  return { settle, rerender: settle };
}

// ---- React 元素树小工具 ----
function textAll(node) {
  if (node === null || node === undefined || typeof node === 'boolean') return '';
  if (typeof node === 'string' || typeof node === 'number') return String(node);
  if (Array.isArray(node)) return node.map(textAll).join('');
  if (typeof node === 'object' && node.props) return textAll(node.props.children);
  return '';
}
function walk(node, fn) {
  if (!node || typeof node !== 'object') return;
  if (Array.isArray(node)) { node.forEach((n) => walk(n, fn)); return; }
  fn(node);
  if (node.props && node.props.children !== undefined) walk(node.props.children, fn);
}
function tags(node) { const out = []; walk(node, (n) => { if (n.type === StubTag) out.push(n); }); return out; }
function buttons(node) { const out = []; walk(node, (n) => { if (n.type === StubButton) out.push(n); }); return out; }

// ---- 夹具数据（字段集 = rc.2 远端 goals 的 view，逐名核过）----
const viewOf = (over) => ({
  id: 'goal-1', revision: 7, objective: '把余额设置线收尾', phase: 'active', activation: 'armed',
  roundsStarted: 3, maxGoalRounds: 10, createdAt: 1760000000000, updatedAt: 1760003600000,
  blockedReason: null, ...over
});

/**
 * 一个可读可写的假远端。**形状按真内核探针来**（2026-10-16 隔离安装布局，页面 console
 * 打出的原文）：`get` 回的是信封 `{ok:true, value:view}`，不是裸 view——把载荷当裸 view
 * 解析时 `view.id` 恒 undefined，界面就成了「还没有目标」，而 GoalBar 同一时刻显示着目标。
 * `script.bare = true` 退回裸载荷（兜底形状，插件两种都要收）。
 */
function makeGoals(initial, script = {}) {
  const calls = [];
  let view = initial;
  const wrap = (v) => (script.bare ? v : { ok: true, value: v });
  return {
    calls,
    get current() { return view; },
    set: (next) => { view = next; },
    get: async () => { calls.push('get'); return wrap(view === undefined ? undefined : view); },
    complete: async (sessionId, ref) => {
      calls.push(['complete', sessionId, JSON.parse(JSON.stringify(ref))]);
      if (script.throwWith) throw script.throwWith;
      if (script.reject) return { ok: false, error: script.reject };
      const next = viewOf({ ...view, phase: 'complete', revision: view.revision + 1 });
      view = next;
      return wrap(next);
    }
  };
}

/** 只有 binding、没有投影面的会话服务（用于只验事件信号面的用例）。 */
function bareSessions() {
  return {
    binding: () => ({
      session: { projections: { faceOf: () => ({ subscribe: () => () => {} }) } }
    })
  };
}

/**
 * 带「真订阅/真摘除」语义的投影面夹具：dispose 必须把监听从活集合里摘掉——
 * 否则「stop 之后不再重读」那条断言是在为夹具的假语义作证，而不是为插件作证。
 * snapshot 默认空投影（无目标）；真内核那份的形状见 PROJECTION_OF。
 */
function sessionsWithFace(sessionId = 's1', snapshot = {}) {
  const live = new Set();
  let current = snapshot;
  return {
    live,
    notify: () => { for (const fn of [...live]) fn(); },
    setSnapshot: (next) => { current = next; },
    sessions: {
      binding: (id) => (id !== sessionId ? undefined : {
        session: {
          projections: {
            faceOf: () => ({
              subscribe(fn) { live.add(fn); return () => { live.delete(fn); }; },
              getSnapshot: () => current
            })
          }
        }
      })
    }
  };
}

/**
 * 真内核投影快照的字段集（探针原文）：goal 那份**没有 activation**，
 * roundsStarted / createdAt / updatedAt 是 goal 的兄弟字段。
 */
const PROJECTION_OF = (over = {}) => ({
  goal: { id: 'goal-4874aa1e', revision: 1, objective: '验证收尾链路', phase: 'active', maxGoalRounds: 256 },
  roundsStarted: 1,
  createdAt: 1792161157093,
  updatedAt: 1792161157093,
  ...over
});

// ---------------------------------------------------------------------------
// 1. 模块契约与挂载面
// ---------------------------------------------------------------------------

test('模块契约：注册进右栏标签槽，原语 + 字典命名空间，不硬编码颜色，host 半边不动内核面', () => {
  const clientSrc = fs.readFileSync(CLIENT_FILE, 'utf8');
  assert.match(clientSrc, /require\("@deepseek-ai\/dsh-client-ui-primitives"\)/,
    '视觉必须走内核设计系统原语（与 dsh-prompt-custom / dsh-builtin-manager 同语言）');
  assert.equal((clientSrc.match(/#[0-9a-fA-F]{6}\b/g) || []).length, 0,
    '不得出现硬编码十六进制颜色（颜色只能取 --dsw-* 变量或原语的 tone）');
  assert.match(clientSrc, /ctx\.locale\.register\(NS/, '字典必须经 ctx.locale.register 挂进内核命名空间');
  assert.match(clientSrc, /ctx\.locale\.bind\(NS\)/, 'apply 里的 t 必须来自 ctx.locale.bind（标题是 thunk，切语言要重取）');

  const host = fs.readFileSync(HOST_FILE, 'utf8');
  assert.doesNotMatch(host, /writeFileSync|writeFileAtomic|appendFile/,
    'host 半边不得写文件（状态只有内核那份是事实源，写它 = 第二个写者）');

  const { registered, localeCalls, exports } = loadPanel({});
  assert.equal(registered.slotOptions.name, 'sidebar.right.pane.tab', '标签主体必须挂进内核右栏的标签槽');
  assert.equal(registered.slotOptions.key, 'goal-completion', '槽 key 必须等于标签类型 id');
  assert.equal(registered.slotOptions.locale, exports.__internals.NS,
    '槽位必须声明 locale——renderer 靠它把 t 注进组件 props（不声明就没有字典）');
  assert.equal(localeCalls.length, 1, 'apply 必须注册一次字典命名空间');
  assert.deepEqual([...localeCalls[0].dictKeys], ['zh', 'en'], '中英两张字典都要交');

  // 会话取自槽的 inject(sessionId)——不是 sessions 的当前会话字段。
  const injected = registered.slotOptions.inject('sess-42');
  assert.equal(injected.sessionId, 'sess-42', 'inject 必须把内核给的 sessionId 透给组件');
  assert.ok(injected.runtime && injected.runtime.goals, 'runtime 必须带上远端 goals');
});

test('标签类型：priority=extension 让位内核自带标签，guide 胶囊是这个标签唯一的入口', () => {
  const { registered } = loadPanel({});
  const type = registered.typeOptions;
  assert.ok(type, 'apply 必须向 sidebarRightTabs 注册标签类型');
  assert.equal(type.id, 'goal-completion');
  assert.equal(type.kind, type.id, 'kind 与 id 同值：openTab(kind) 才能命中这个类型');
  assert.equal(type.priority, 'extension',
    '扩展件必须让位内核自带的文件/预览/终端三标签（builtin 优先级更高）');
  assert.equal(type.patterns, undefined, '页面型标签不写 patterns（那是资源型标签的路由）');
  assert.equal(typeof type.title, 'function', 'title 必须是 thunk（切语言重取）');
  assert.equal(type.title(), '目标收尾');
  assert.equal(type.guide.length, 1);
  assert.equal(type.guide[0].id, type.id, 'guide 条目 id 与标签 id 同源，胶囊点击才能开这个标签');
  assert.equal(typeof type.guide[0].title, 'function');
  assert.equal(type.guide[0].title(), '目标收尾');
  assert.match(type.guide[0].description(), /标记为完成/, '引导页文案要说出这个标签能干什么');
});

test('字典面：zh 是键集事实源，en 逐键对齐；文案里每个 {占位} 都在插值面上', () => {
  const { exports } = loadPanel({});
  const { zh, en } = exports.__internals;
  const zhKeys = Object.keys(zh).sort();
  assert.deepEqual(Object.keys(en).sort(), zhKeys, '英文字典必须与中文逐键对齐（漏键会被原样印成 key）');
  for (const [k, v] of Object.entries(zh)) {
    const want = [...String(v).matchAll(/\{(\w+)\}/g)].map((m) => m[1]).sort();
    const have = [...String(en[k]).matchAll(/\{(\w+)\}/g)].map((m) => m[1]).sort();
    assert.deepEqual(have, want, `${k} 的插值占位必须中英同集：zh=${JSON.stringify(want)} en=${JSON.stringify(have)}`);
  }
  // 内核字典的 phase 四档在本插件里都有对应（官方连 complete 档都没有，这正是本插件的存在理由）。
  for (const key of ['phase.active', 'phase.active.disarmed', 'phase.paused', 'phase.blocked', 'phase.complete']) {
    assert.ok(key in zh, '状态机每一档都要有文案：缺 ' + key);
  }
});

test('缺服务的内核（0.1.6 前无原生右栏）：不注册标签也不抛，整包照旧加载', () => {
  const { registered } = loadPanel({ tabs: null });
  assert.equal(registered.slotOptions, null, '没有 sidebarRightTabs 服务时不得注册标签主体');
  assert.equal(registered.typeOptions, null);
});

test('无 document 环境不炸（ensureCss 纯浏览器守卫），且 CSS 只注入一次', async () => {
  loadPanel({});  // sandbox 里没有 document —— 抛错即测试红
  const appended = [];
  const fakeDoc = {
    querySelector: () => (appended.length ? { existing: true } : null),
    createElement: () => ({ dataset: {}, textContent: '' }),
    head: { appendChild: (node) => appended.push(node) }
  };
  loadPanel({ document: fakeDoc });
  assert.equal(appended.length, 1, '样式表必须注入一次');
  loadPanel({ document: fakeDoc });
  assert.equal(appended.length, 1, '第二次 apply 不得重复注入（按 data-plugin-css 去重）');
});

// ---------------------------------------------------------------------------
// 2. 状态仓（纯函数面，不经 React）
// ---------------------------------------------------------------------------

test('状态仓：五态迁移齐全，投影/事件只是信号，读才是权威', async () => {
  const { exports } = loadPanel({});
  const { createGoalStore } = exports.__internals;

  const faceA = sessionsWithFace();
  const goals = makeGoals(viewOf({}));
  const events = [];
  const store = createGoalStore({
    sessionId: 's1', sessions: faceA.sessions, goals,
    onEvent: (name, fn) => { events.push(name); return () => {}; },
    onReset: () => () => {}
  });
  store.start();
  assert.equal(JSON.stringify(events), JSON.stringify(['goal/activation-changed']), '必须订内核的目标事件面');
  assert.equal(faceA.live.size, 1, '必须订投影面');
  await new Promise((r) => setImmediate(r));
  assert.equal(store.getSnapshot().status, 'ready');
  assert.equal(store.getSnapshot().view.objective, '把余额设置线收尾');

  // 投影信号 → 重新读（信号本身不当数据源）。
  const before = goals.calls.filter((c) => c === 'get').length;
  faceA.notify();
  await new Promise((r) => setImmediate(r));
  assert.ok(goals.calls.filter((c) => c === 'get').length > before, '投影变更必须触发重读');

  // 无目标 → none；会话不可用 → unavailable；读失败 → error（原文留给界面）。
  const empty = createGoalStore({ sessionId: 's1', sessions: faceA.sessions, goals: makeGoals(undefined) });
  empty.start();
  await new Promise((r) => setImmediate(r));
  assert.equal(empty.getSnapshot().status, 'none', 'get 回 undefined 就是「还没有目标」');

  const dead = createGoalStore({ sessionId: 'gone', sessions: faceA.sessions, goals: makeGoals(viewOf({})) });
  dead.start();
  await new Promise((r) => setImmediate(r));
  assert.equal(dead.getSnapshot().status, 'unavailable', 'binding 缺席必须说「会话不可用」而不是空态');

  const boom = createGoalStore({
    sessionId: 's1', sessions: faceA.sessions,
    goals: { get: async () => { throw new Error('remote offline'); } }
  });
  boom.start();
  await new Promise((r) => setImmediate(r));
  // 投影在场（哪怕那份说没有目标）时，live 读失败**不报错**：官方 GoalBar 同刻也显示不出目标，
  // 界面跟着说「还没有目标」比抛一条用户看不懂的读失败更诚实（稳定性原则②「意外以日志收场」）。
  assert.equal(boom.getSnapshot().status, 'none', '投影在场时 live 失败不炸界面');
  const blind = createGoalStore({
    sessionId: 's1', sessions: bareSessions(),
    goals: { get: async () => { throw new Error('remote offline'); } }
  });
  blind.start();
  await new Promise((r) => setImmediate(r));
  assert.equal(blind.getSnapshot().status, 'error', '两条线都没答案时才报读失败');
  assert.match(blind.getSnapshot().error, /remote offline/, '读失败要把原文留给界面');
  store.stop();
});

test('状态仓：start/stop 对称——重复 start 不二次订阅，stop 之后信号不再驱动读', async () => {
  const { exports } = loadPanel({});
  const { createGoalStore } = exports.__internals;
  const goals = makeGoals(viewOf({}));

  const face = sessionsWithFace();
  const store = createGoalStore({ sessionId: 's1', sessions: face.sessions, goals });
  const off = store.start();
  assert.equal(typeof off, 'function', 'start 必须回 disposer（effect 的清理靠它）');
  assert.equal(face.live.size, 1);
  store.start();
  assert.equal(face.live.size, 1, '重复 start 不得二次订阅（StrictMode 双跑也不该重订）');

  store.stop();
  assert.equal(face.live.size, 0, 'stop 必须摘掉自己的监听');
  store.start();
  store.stop();
  await new Promise((r) => setImmediate(r));
  const afterStop = goals.calls.filter((c) => c === 'get').length;
  face.notify();
  await new Promise((r) => setImmediate(r));
  assert.equal(goals.calls.filter((c) => c === 'get').length, afterStop, 'stop 之后信号不得再驱动读');

  // 反证夹具的语义：一个已 stop 的 store 与一个活着的 store 各自独立（摘干净才敢这么说）。
  const faceB = sessionsWithFace();
  const keep = createGoalStore({ sessionId: 's1', sessions: faceB.sessions, goals });
  const transient = createGoalStore({ sessionId: 's1', sessions: faceB.sessions, goals });
  keep.start();
  transient.start();
  assert.equal(faceB.live.size, 2);
  transient.stop();
  const base = goals.calls.filter((c) => c === 'get').length;
  faceB.notify();
  await new Promise((r) => setImmediate(r));
  assert.equal(goals.calls.filter((c) => c === 'get').length, base + 1, '活着的 store 仍要随信号重读，只摘掉停掉的那个');
  keep.stop();
});

test('状态仓：内容相同的信号不去抖成重渲染，真变了才通知', async () => {
  const { exports } = loadPanel({});
  const { createGoalStore } = exports.__internals;
  const view = viewOf({});
  const store = createGoalStore({
    sessionId: 's1',
    sessions: { binding: () => ({ session: {} }) },
    goals: { get: async () => viewOf({ ...view }) }  // 每次新对象、同内容
  });
  let notified = 0;
  store.subscribe(() => { notified++; });
  store.start();
  await new Promise((r) => setImmediate(r));
  await store.refresh();
  await store.refresh();
  assert.equal(notified, 1, '同内容的新对象不得通知（引用比较对远端读无意义，必须按内容去抖）');
  await store.refresh();
  assert.equal(notified, 1);
  store.adopt(viewOf({ ...view, phase: 'paused' }));
  assert.equal(notified, 2, '真变了必须通知');
});

test('phaseKey：active+disarmed 是内核字典里单独的一档，未知 phase 不炸界面', () => {
  const { exports } = loadPanel({});
  const { phaseKey, PHASE_TONE } = exports.__internals;
  assert.equal(phaseKey(viewOf({ phase: 'active', activation: 'armed' })), 'phase.active');
  assert.equal(phaseKey(viewOf({ phase: 'active', activation: 'disarmed' })), 'phase.active.disarmed');
  assert.equal(phaseKey(viewOf({ phase: 'blocked' })), 'phase.blocked');
  assert.equal(phaseKey(viewOf({ phase: 'complete' })), 'phase.complete');
  assert.equal(phaseKey(viewOf({ phase: 'nonsense' })), 'phase.unknown', '没见过的 phase 要落到兜底文案而不是 undefined');
  assert.equal(phaseKey(undefined), 'phase.unknown');
  for (const phase of ['active', 'paused', 'blocked', 'complete']) {
    assert.ok(['info', 'neutral', 'warning', 'success', 'outline', 'solid', 'quiet', 'danger'].includes(PHASE_TONE[phase]),
      phase + ' 的 tone 必须是 Tag 原品声明的八档之一');
  }
});

test('clockOf / messageOf：缺字段留空不写 NaN，非 Error 的拒绝也能措辞', () => {
  const { exports } = loadPanel({});
  const { clockOf, messageOf } = exports.__internals;
  assert.equal(typeof clockOf(1760003600000), 'string');
  assert.match(clockOf(1760003600000), /\d/, 'epoch 毫秒要变成本地时刻');
  assert.equal(clockOf(undefined), '');
  assert.equal(clockOf('不是数字'), '');
  assert.equal(clockOf(NaN), '');
  assert.equal(messageOf(undefined), '未知错误');
  assert.equal(messageOf('boom'), 'boom');
  assert.equal(messageOf({ message: 'revision 冲突' }), 'revision 冲突');
  assert.equal(messageOf({ code: 'stale' }), '[object Object]', '没有 message 的纯对象退化成 String(error)（不许静默空串）');
});

// ---------------------------------------------------------------------------
// 3. 界面行为（真实组件 + 复刻钩子夹具）
// ---------------------------------------------------------------------------

function mount(opts = {}) {
  const { registered, exports } = loadPanel(opts);
  const { zh } = exports.__internals;
  const props = {
    sessionId: opts.sessionId || 's1',
    runtime: {
      sessions: opts.sessions || { binding: () => ({ session: {} }) },
      goals: opts.goals,
      onEvent: opts.onEvent,
      onReset: opts.onReset
    },
    // renderer 在槽位声明 locale 时注入的 t —— 这里用真字典同构造出来。
    t: makeT(zh)
  };
  return { mounter: createMounter(registered.Component, props), props };
}

test('渲染：状态机全字段上屏——phase 走 Tag 的语义档，轮次/修订/激活都可见', async () => {
  const goals = makeGoals(viewOf({}));
  const { mounter } = mount({ goals });
  const tree = await mounter.settle();

  const text = textAll(tree);
  assert.match(text, /当前会话的目标/, '标题在位');
  assert.match(text, /把余额设置线收尾/, 'objective 必须逐字上屏');
  assert.match(text, /进行中/, 'phase 文案取自字典：' + text.slice(0, 120));
  assert.match(text, /轮次 3 \/ 10/, '轮次必须带插值后的数字：' + text);
  assert.match(text, /修订 7/, 'CAS 的修订号要可见（用户判断冲突时看得见）');
  assert.match(text, /自动续跑/);
  assert.match(text, /更新于 /);

  assert.equal(tags(tree).length, 1, '状态胶囊只能有一个（phase）');
  assert.equal(tags(tree)[0].props.tone, 'info', 'active → Tag 的 info 档（分类而非健康度）');

  const btns = buttons(tree);
  assert.equal(btns.length, 1, '未确认态只有一个按钮（确认按钮第二击才出现）');
  assert.equal(btns[0].props.children, '标记完成');
  assert.equal(btns[0].props.variant, 'primary');
});

test('受阻态：blocked 用 warning 档并把 code + message 一起给出', async () => {
  const goals = makeGoals(viewOf({ phase: 'blocked', activation: 'disarmed', blockedReason: { code: 'no-progress', message: '三轮没有新改动' } }));
  const { mounter } = mount({ goals });
  const tree = await mounter.settle();
  assert.equal(tags(tree)[0].props.tone, 'warning', '受阻是「需要留意但还不算失败」：' + JSON.stringify(tags(tree)[0].props));
  const text = textAll(tree);
  assert.match(text, /三轮没有新改动/);
  assert.match(text, /no-progress/, '受阻 code 也要上屏（报障时第一句就是它）');
  assert.match(textAll(tree), /不再续跑/, 'blocked 之下 activation 那一档仍要单独说清（phase 与 activation 是两条正交的线）');
});

test('空态与不可用态：给出去路（目标由 /goal 设立），渲染期不触发任何写', async () => {
  const goals = makeGoals(undefined);
  const { mounter } = mount({ goals });
  const tree = await mounter.settle();
  const text = textAll(tree);
  assert.match(text, /这个会话还没有目标/);
  assert.match(text, /\/goal/, '空态必须说清去哪儿设立目标：' + text);
  assert.equal(buttons(tree).length, 0, '没有目标时不得出现「标记完成」');
  assert.deepEqual(goals.calls.filter((c) => Array.isArray(c)), [], '渲染不得触发 complete');
});

test('两次点击确认：第一击只武装，第二击才写；窗口外的取消把按钮收回普通态', async () => {
  const goals = makeGoals(viewOf({}));
  const { mounter } = mount({ goals });
  let tree = await mounter.settle();

  await buttons(tree)[0].props.onClick();
  tree = await mounter.settle();
  assert.deepEqual(goals.calls.filter((c) => Array.isArray(c)), [], '第一击绝不能写（complete 是终态）');
  const armed = buttons(tree);
  assert.equal(armed.length, 2, '武装态必须有「确认」与「取消」两颗');
  assert.equal(armed[0].props.children, '确认完成（终态，不可撤销）');
  assert.equal(armed[0].props.variant, 'outline', '武装态不得再是 primary（防连点直落终态）');
  assert.match(textAll(tree), /终态|不可撤销|另设/,'武装态必须把「不可撤销」说在界面上');

  await armed[1].props.onClick();
  tree = await mounter.settle();
  assert.equal(buttons(tree).length, 1, '取消后回到普通态');
  assert.equal(buttons(tree)[0].props.children, '标记完成');
  assert.deepEqual(goals.calls.filter((c) => Array.isArray(c)), [], '取消不得写');

  await buttons(tree)[0].props.onClick();
  tree = await mounter.settle();
  await buttons(tree)[0].props.onClick();
  tree = await mounter.settle();
  const writes = goals.calls.filter((c) => Array.isArray(c));
  assert.equal(writes.length, 1, '第二击才提交一次');
  assert.deepEqual(writes[0], ['complete', 's1', { id: 'goal-1', revision: 7 }],
    'CAS：id + revision 必须逐字取自读到的那一份（sessionId 在第一参）');
});

test('成功信封：采纳内核回的 view 直接进终态，按钮消失并说明不能再改', async () => {
  const goals = makeGoals(viewOf({}));
  const { mounter } = mount({ goals });
  let tree = await mounter.settle();
  await buttons(tree)[0].props.onClick();
  tree = await mounter.settle();
  await buttons(tree)[0].props.onClick();
  tree = await mounter.settle();

  const text = textAll(tree);
  assert.match(text, /已标记完成/);
  assert.equal(tags(tree)[0].props.tone, 'success', 'complete → success 档');
  assert.match(text, /进行中|已完成/);
  assert.equal(buttons(tree).length, 0, '终态不得再留任何按钮（phase 机里没有回去的路）');
  assert.match(text, /终态，不能再改|不能再改/, '要说明这是终态：' + text.slice(-160));
  assert.equal(goals.current.phase, 'complete');
});

test('被拒（ok:false）：原文上屏 + 重读最新状态，绝不谎报完成', async () => {
  const goals = makeGoals(viewOf({ revision: 7 }), { reject: { message: 'revision 冲突，目标已被改动' } });
  const { mounter } = mount({ goals });
  let tree = await mounter.settle();
  const getsBefore = goals.calls.filter((c) => c === 'get').length;
  await buttons(tree)[0].props.onClick();
  tree = await mounter.settle();
  await buttons(tree)[0].props.onClick();
  tree = await mounter.settle();

  const text = textAll(tree);
  assert.match(text, /操作没有被接受/, '拒绝要有归属文案：' + text);
  assert.match(text, /revision 冲突，目标已被改动/, '内核原文必须逐字上屏');
  assert.match(text, /已重新读取最新状态/);
  assert.ok(!/已标记完成/.test(text), '被拒时不得出现成功文案');
  assert.ok(goals.calls.filter((c) => c === 'get').length > getsBefore, '被拒后必须重读（不给陈旧 revision 第二次机会）');
  assert.equal(buttons(tree)[0].props.children, '标记完成', '被拒后按钮收回普通态，可再确认一次');
});

test('抛错与在途：complete 抛出时报原文；在途期间按钮 disabled 不重复提交', async () => {
  let hold = null;
  const goals = {
    calls: [],
    get: async () => viewOf({}),
    complete: () => new Promise((resolve) => { hold = resolve; })
  };
  goals.complete = () => new Promise((resolve) => { hold = (v) => resolve(v); });
  const { mounter } = mount({ goals });
  let tree = await mounter.settle();
  await buttons(tree)[0].props.onClick();
  tree = await mounter.settle();
  await buttons(tree)[0].props.onClick();
  tree = await mounter.settle(2);
  assert.equal(buttons(tree)[0].props.disabled, true, '在途必须禁用，防连点重复提交');
  assert.equal(buttons(tree)[0].props.children, '提交中…');
  hold({ ok: true, value: viewOf({ phase: 'complete', revision: 8 }) });
  tree = await mounter.settle();
  assert.equal(buttons(tree).length, 0, '落定后进入终态');

  const thrower = { get: async () => viewOf({}), complete: async () => { throw new Error('连接已断开'); } };
  const second = mount({ goals: thrower });
  let t2 = await second.mounter.settle();
  await buttons(t2)[0].props.onClick();
  t2 = await second.mounter.settle();
  await buttons(t2)[0].props.onClick();
  t2 = await second.mounter.settle();
  assert.match(textAll(t2), /操作没有被接受[\s\S]*连接已断开|连接已断开/, '抛错路径也要把原文上屏：' + textAll(t2).slice(-160));
});

test('信号驱动：投影与事件变更后界面重读并刷新状态（不靠轮询）', async () => {
  let faceListener = null;
  let eventListener = null;
  let view = viewOf({ phase: 'active' });
  const goals = { get: async () => view, complete: async () => ({ ok: true, value: view }) };
  const { mounter } = mount({
    goals,
    sessions: {
      binding: () => ({
        session: {
          projections: {
            faceOf: () => ({
              subscribe: (fn) => { faceListener = fn; return () => { faceListener = null; }; },
              getSnapshot: () => ({})
            })
          }
        }
      })
    },
    onEvent: (name, fn) => { eventListener = fn; return () => {}; }
  });
  let tree = await mounter.settle();
  assert.match(textAll(tree), /进行中/);

  view = viewOf({ phase: 'paused', revision: 9 });
  faceListener();
  tree = await mounter.settle();
  assert.match(textAll(tree), /已暂停/, '投影信号 → 重读 → 界面随动');
  assert.equal(tags(tree)[0].props.tone, 'neutral', 'paused → neutral 档');

  view = viewOf({ phase: 'blocked', revision: 10 });
  eventListener({ sessionId: 's1' });
  tree = await mounter.settle();
  assert.match(textAll(tree), /受阻/);

  // 别的会话的事件不得驱动本会话（一条会话一个标签）。
  let gets = 0;
  const counted = { get: async () => { gets++; return view; }, complete: async () => ({ ok: true, value: view }) };
  const probe = mount({ goals: counted, sessions: bareSessions(), onEvent: (_n, fn) => { eventListener = fn; return () => {}; } });
  await probe.mounter.settle();
  const base = gets;
  eventListener({ sessionId: 'other-session' });
  await probe.mounter.settle();
  assert.equal(gets, base, '事件带别的 sessionId 时不得重读本会话');
});

test('线形归一：真内核的「无目标」在线上不是 undefined——null / 缺 id 的对象都必须落空态', async () => {
  // 出处：`dsh-goal` 的 `get` 声明「无当前目标回 undefined」，但该方法是 @Remote 装饰的，
  // JSON 线把 undefined 变成 null / 缺字段。2026-10-16 隔离内核实机就是在这里翻车的：
  // 只判 `view === undefined` 时，新会话画出一张「状态未知」的卡 + 一颗必被拒的「标记完成」。
  const { exports } = loadPanel({});
  const { isGoalView, stateOf } = exports.__internals;
  for (const junk of [null, undefined, {}, { id: '' }, 'string', 0, []]) {
    assert.equal(isGoalView(junk), false, JSON.stringify(junk) + ' 不是目标载荷');
  }
  assert.equal(isGoalView(viewOf({})), true, '阳性对照：真载荷必须认下');
  assert.equal(stateOf(null).status, 'none');
  assert.equal(stateOf({}).view, undefined, '残缺载荷不得留在快照里给按钮当靶子');
  assert.equal(stateOf(viewOf({})).status, 'ready');

  const goals = { get: async () => null, complete: async () => { throw new Error('空态下不该有写'); } };
  const { mounter } = mount({ goals });
  const tree = await mounter.settle();
  assert.match(textAll(tree), /这个会话还没有目标/, '线上 null 必须走空态：' + textAll(tree).slice(0, 120));
  assert.doesNotMatch(textAll(tree), /状态未知/, '不得出现「状态未知」这种既吓人又可点的中间态');
  assert.equal(buttons(tree).length, 0);
});

test('真内核载荷形状：信封要解包、投影补字段、activation 只认同 id 同 revision', async () => {
  const { exports } = loadPanel({});
  const { unwrap, envelopeError, viewOfProjection } = exports.__internals;
  const goal = viewOf({ id: 'g-1', revision: 3, activation: undefined });

  assert.deepEqual(unwrap({ ok: true, value: goal }), goal, '信封必须解到 value');
  assert.equal(unwrap({ ok: false, error: 'x' }), undefined, '被拒的信封没有载荷');
  assert.deepEqual(unwrap(goal), goal, '裸载荷（旧形状）原样收');
  assert.match(envelopeError({ ok: false, error: { message: 'goal is not live' } }), /goal is not live/);

  const merged = viewOfProjection({ goal: { ...goal }, roundsStarted: 9, updatedAt: 111 }, { id: 'g-1', revision: 3, activation: 'disarmed', roundsStarted: 10 });
  assert.equal(merged.activation, 'disarmed', 'activation 只存在于 live 载荷里，必须补进来');
  assert.equal(merged.roundsStarted, 10, 'live 那份更新（同 id 同 revision 时以它为准）');
  assert.equal(merged.updatedAt, 111, '投影的兄弟字段（updatedAt/createdAt/roundsStarted）要合进 view');
  const other = viewOfProjection({ goal: { ...goal }, roundsStarted: 9 }, { id: 'g-OTHER', revision: 4, activation: 'disarmed' });
  assert.equal(other.activation, undefined, 'id/revision 不同 = 另一个目标，不得把别人的 activation 混进来');
  assert.equal(viewOfProjection({}, undefined), undefined, '两条线都空 → 无目标');
  assert.equal(viewOfProjection(undefined, goal).id, 'g-1', '投影缺席才退回 live 那一条线');

  // 端到端：投影有目标、live 只有 activation —— 界面必须显示目标并给出收尾按钮（真机翻车现场）。
  const face = sessionsWithFace('s1', PROJECTION_OF());
  const live = { id: 'goal-4874aa1e', revision: 1, objective: '验证收尾链路', phase: 'active', activation: 'disarmed', roundsStarted: 1, maxGoalRounds: 256, createdAt: 1792161157093, updatedAt: 1792161157093 };
  const goals = { get: async () => ({ ok: true, value: live }), complete: async () => ({ ok: true, value: { ...live, phase: 'complete', revision: 2 } }) };
  const { mounter } = mount({ goals, sessions: face.sessions });
  const tree = await mounter.settle();
  const text = textAll(tree);
  assert.doesNotMatch(text, /这个会话还没有目标/, 'live 读到目标时不得显示空态');
  assert.match(text, /验证收尾链路/);
  assert.match(text, /未运行/, 'active + disarmed 走内核字典里那一档（GoalBar 同一措辞）');
  assert.match(text, /轮次 1 \/ 256/);
  assert.match(text, /修订 1/);
  assert.equal(buttons(tree).length, 1, '这种「目标在、agent 不跑」的时刻正是手动收尾要用的');
});

test('activation 未知时不硬说：只认 armed / disarmed 两个值', async () => {
  const face = sessionsWithFace('s1', PROJECTION_OF());
  const goals = { get: async () => ({ ok: true, value: undefined }), complete: async () => ({ ok: true, value: null }) };
  const { mounter } = mount({ goals, sessions: face.sessions });
  const tree = await mounter.settle();
  const text = textAll(tree);
  assert.match(text, /验证收尾链路/, 'live 读不到（回 ok:true 而 value 缺）时，投影那份仍要显示出来');
  assert.doesNotMatch(text, /自动续跑|不再续跑/, '没有 activation 就不许编一条');
});

// ---------------------------------------------------------------------------
// 4. 包面与挂载（台账同 id 的那条线）
// ---------------------------------------------------------------------------

test('包面一致：bundle 层 loader id = 在册清单 id = 包名，client 入口可达', () => {
  const pkg = JSON.parse(fs.readFileSync(path.join(PKG_DIR, 'package.json'), 'utf8'));
  assert.equal(pkg.dsh.client.entry, 'client');
  assert.ok(String(pkg.exports['./client']).endsWith('lib/client.js'), './client 必须指到真实文件');
  const { exports } = loadPanel({});
  assert.deepEqual([...exports.inject].sort(), ['locale', 'remote', 'remote.goals', 'sessions', 'slots'].sort(),
    '服务面必须显式声明（sidebarRightTabs 走 ctx.inject 的可选接法，不在这里——写进来会让缺它的内核整包不加载）');

  const patchCode = fs.readFileSync(PATCH_FILE, 'utf8').split('\n').filter((l) => !/^\s*#/.test(l)).join('\n');
  const m = /- insert:\s*\n\s*- id: (\S+)\s*\n\s*name: '([^']+)'/.exec(patchCode);
  assert.ok(m, 'cordis.patch.yml 必须声明自挂载条目');
  assert.equal(m[1], 'goal-completion', 'loader id 是本套件与台账共同的键');
  assert.equal(m[2], pkg.name, 'name 必须是包名（issue #104 的坑：不一致会双挂载、启动即崩）');
  assert.doesNotMatch(patchCode, /disabled:\s*!!js/, '必选行上的 !!js 抛错会中断启动，禁止');

  const { COMPANION_PLUGINS } = require(path.join(DSH, 'scripts', 'lib', 'companion-plugins.js'));
  const hit = COMPANION_PLUGINS.filter((p) => p.id === m[1]);
  assert.equal(hit.length, 1, '在册清单里该 id 必须唯一命中');
  assert.equal(hit[0].name, pkg.name, '清单包名与 bundle 声明必须同源');
});

// ---------------------------------------------------------------------------
// 反证四条：守卫被摘掉时行为必须按预期变形，否则上面的判据是空的
// ---------------------------------------------------------------------------

test('反证 1：摘掉 ok===false 分支后，被拒会被报成「已标记完成」（成功/被拒两条用例因此在咬真判据）', async () => {
  const goals = makeGoals(viewOf({}), { reject: { message: 'revision 冲突' } });
  const { registered, exports } = loadPanel({
    // 定位到 commit 里那一处（refresh 里有同形的判据，短字符串会先命中它）。
    mutate: (src) => src.replace(
      'if (result && result.ok === false) {\n\t\t\t\t\tsetAction({ error: envelopeError(result), done: false });',
      'if (false) {\n\t\t\t\t\tsetAction({ error: envelopeError(result), done: false });')
  });
  const mounter = createMounter(registered.Component, {
    sessionId: 's1',
    runtime: { sessions: { binding: () => ({ session: {} }) }, goals },
    t: makeT(exports.__internals.zh)
  });
  let tree = await mounter.settle();
  await buttons(tree)[0].props.onClick();
  tree = await mounter.settle();
  await buttons(tree)[0].props.onClick();
  tree = await mounter.settle();
  assert.match(textAll(tree), /已标记完成/, '守卫摘掉后页面会谎报完成');
  assert.doesNotMatch(textAll(tree), /操作没有被接受/, '被拒原文也不会上屏');
});

test('反证 2：摘掉终态门控后，已完成的目标仍渲染按钮（终态那条用例因此在咬真判据）', async () => {
  const goals = makeGoals(viewOf({ phase: 'complete' }));
  const { registered, exports } = loadPanel({
    mutate: (src) => src.replace('if (view !== undefined && !terminal) {', 'if (view !== undefined) {')
  });
  const props = {
    sessionId: 's1',
    runtime: { sessions: { binding: () => ({ session: {} }) }, goals },
    t: makeT(exports.__internals.zh)
  };
  const tree = await createMounter(registered.Component, props).settle();
  assert.equal(buttons(tree).length, 1, '守卫摘掉后终态还能点「标记完成」——会被内核拒并刷新一圈');
});

test('反证 3：摘掉第一击确认门控后，一次点击就落终态（两次点击那条用例因此在咬真判据）', async () => {
  const goals = makeGoals(viewOf({}));
  const { registered, exports } = loadPanel({
    mutate: (src) => src.replace('if (confirming) { void commit(); return; }', 'void commit(); return;')
  });
  const props = {
    sessionId: 's1',
    runtime: { sessions: { binding: () => ({ session: {} }) }, goals },
    t: makeT(exports.__internals.zh)
  };
  const tree = await createMounter(registered.Component, props).settle();
  await buttons(tree)[0].props.onClick();
  assert.equal(goals.calls.filter((c) => Array.isArray(c)).length, 1,
    '守卫摘掉后第一击即写库——正是确认那条用例要防的');
});

test('反证 4：摘掉事件的 sessionId 过滤后，别的会话也会驱动本会话重读', async () => {
  const { exports } = loadPanel({ mutate: (src) => src.replace(
    'if (event && event.sessionId === deps.sessionId) void refresh();', 'void refresh();') });
  const { createGoalStore } = exports.__internals;
  let listener = null;
  let gets = 0;
  const store = createGoalStore({
    sessionId: 's1',
    sessions: bareSessions(),
    goals: { get: async () => { gets++; return viewOf({}); } },
    onEvent: (_n, fn) => { listener = fn; return () => {}; }
  });
  store.start();
  await new Promise((r) => setImmediate(r));
  const base = gets;
  listener({ sessionId: 'other-session' });
  await new Promise((r) => setImmediate(r));
  assert.equal(gets, base + 1, '过滤摘掉后跨会话的事件也会触发重读（信号面串台）');

  // 对照组：未变异的同一条路径必须不重读（与上面那条「信号驱动」用例同判据）。
  const clean = loadPanel({});
  let cleanListener = null;
  let cleanGets = 0;
  const cleanStore = clean.exports.__internals.createGoalStore({
    sessionId: 's1',
    sessions: bareSessions(),
    goals: { get: async () => { cleanGets++; return viewOf({}); } },
    onEvent: (_n, fn) => { cleanListener = fn; return () => {}; }
  });
  cleanStore.start();
  await new Promise((r) => setImmediate(r));
  const cleanBase = cleanGets;
  cleanListener({ sessionId: 'other-session' });
  await new Promise((r) => setImmediate(r));
  assert.equal(cleanGets, cleanBase, '在位的过滤不得被跨会话事件串动');
});

test('反证 5：把「只认带 id 的载荷」放宽成「是对象就算」，线上空载荷会画出一张可点的卡', async () => {
  const goals = { get: async () => ({}), complete: async () => ({ ok: true, value: null }) };
  const { mounter } = mount({
    goals,
    mutate: (src) => src.replace(
      'return !!view && typeof view === "object" && typeof view.id === "string" && view.id !== "";',
      'return !!view && typeof view === "object";')
  });
  const tree = await mounter.settle();
  assert.match(textAll(tree), /状态未知/,
    '守卫放宽后，真内核那份空载荷会被当成「有但看不懂的目标」（2026-10-16 实机翻车现场）');
  assert.equal(buttons(tree).length, 1, '并且给出必被拒的「标记完成」——正是空态那条断言要防的');
});
