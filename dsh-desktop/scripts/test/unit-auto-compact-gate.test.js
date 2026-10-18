'use strict';

// unit-auto-compact-gate.test.js —— 「自动压缩弹窗把我写了一半的草稿清掉了」的回归锁。
//
// 用户报障（2026-10-18）：正在会话里打一大段引导词，右下角突然弹出「已自动压缩（/compact）」，
// 半篇内容一并没了。取证结论：提示不是凶手，`inputActions.setDraft("/compact")` 才是——
// 内核这条 API 的契约是**整篇替换**（dsh-client-ui-conversation/lib/client.js:15023
// "Replace the whole draft (persisted-draft seed and programmatic writes)"），且 publish()
// 会立刻把它写进该会话的持久化草稿（:15708-15716 + :17965 bindDraftPersistence），
// 成功提交后 commit-draft 还会砍掉 undo 栈（contract/input.d.ts:380-388）。
// 旧实现只有 enabled / 阈值 / 冷却三道判据，草稿非空、轮次在跑一律照发。
//
// 本套件咬两层：
//   ① 纯函数 composerGate 的判据表（照内核 InputBar 的同源口径 :18803-18806）；
//   ② dock occupant 与设置页按钮的**渲染级**证据：草稿非空时 setDraft 一次都不许被调用。
// 快照必须走 useInput / useSession（:19738-19753 的 `hooks.input = shell.state`），
// 不能走 inputActions——那个对象只有 8 个方法（:14932-14958），没有 state / getDraft /
// draft / busy 任何一项，按那些字段读会恒 undefined、把守卫做成静默死的。
// 所以「形状读不到」判 unknown、unknown 不提交，并 console.warn 一次。
//
// 挂载方式与 unit-goal-completion-client / unit-builtin-manager-client 同族：本机没有 jsdom /
// react-test-renderer，用仓库里真实的 React + React 内部 dispatcher 槽位手驱
// useState/useEffect/useRef/useMemo/useCallback。证据强度记为
// 「真实插件源码 + 复刻渲染夹具（非浏览器语义，仅本组件用到的钩子面）」——不冒充浏览器实测。
//
// 反证四条在文件末尾：摘掉闸门那句、把 composerGate 改成恒 ready、把「跳过不记冷却」改成记冷却、
// 把 change-review 的 blocked 分支摘掉——前面的用例必须按预期变红，否则是在为不存在的守卫作证。
// 运行：node --test scripts/test/unit-auto-compact-gate.test.js

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const React = require('react');

const DSH = path.resolve(__dirname, '..', '..');
const HALF = {
  compact: {
    file: path.join(DSH, 'assets', 'plugins', 'dsh-auto-compact', 'lib', 'client.js'),
    storeKey: 'dsh-auto-compact-config-v1',
    button: '立即压缩当前对话',
    dict: { now: '立即压缩当前对话' },
  },
  review: {
    file: path.join(DSH, 'assets', 'plugins', 'dsh-change-review', 'lib', 'client.js'),
    storeKey: 'dsh-change-review-config-v1',
    button: '立即审核当前会话变更',
    dict: { now: '立即审核当前会话变更' },
  },
};

// ---------------------------------------------------------------------------
// 浏览器侧最小夹具：__ModuleLoader__ 捕获模块；document / localStorage / rAF 够本组件用
// ---------------------------------------------------------------------------

function loadClient(which, opts = {}) {
  const meta = HALF[which];
  // 行尾归一：这两份 lib 在工作树里一份 LF、一份 CRLF（`git ls-files --eol` 实测 i/lf w/crlf
  // ——本机 core.autocrlf=true 的老账，仓库级修法见根目录 .gitattributes）。多行锚点在这种
  // 落差下会**静默空转**：replace 什么都没换、变异体等于原件，反证用例就变成在为不存在的
  // 守卫作证。所以夹具进门先把 \r\n 拍平，本机与 CI 从同一字节起步。
  let src = fs.readFileSync(meta.file, 'utf8').replace(/\r\n/g, '\n');
  if (opts.mutate) src = opts.mutate(src);

  const appended = [];
  const warns = [];
  const store = new Map(Object.entries(opts.config || {})
    .map(([k, v]) => [meta.storeKey, JSON.stringify({ [k]: v })]));
  const node = () => ({ style: { cssText: '' }, dataset: {}, textContent: '', remove() {} });
  const sandbox = {
    window: {
      __ModuleLoader__: { load(mod) { sandbox.__loaded = mod; } },
      localStorage: {
        getItem: (k) => (store.has(k) ? store.get(k) : null),
        setItem: (k, v) => store.set(k, String(v)),
      },
    },
    document: {
      createElement: () => node(),
      querySelector: () => null,
      head: { appendChild() {} },
      body: { appendChild(n) { appended.push(n); } },
    },
    console: { warn: (...a) => warns.push(a.join(' ')), log() {}, error() {} },
    setTimeout,
    clearTimeout,
    requestAnimationFrame: (fn) => setTimeout(fn, 0),
    require: (name) => {
      if (name === 'react') return React;
      throw new Error('client 不得 require 模块：' + name);
    },
  };
  vm.runInNewContext(src, sandbox, { filename: `dsh-${which}-client.js` });
  const loaded = sandbox.__loaded;
  assert.ok(loaded && typeof loaded.factory === 'function', 'client.js 必须经 __ModuleLoader__.load 注册 factory');
  const exports = loaded.factory(sandbox.require);

  const slots = { dock: null, section: null };
  exports.apply({
    effect: (fn) => { const off = fn(); return typeof off === 'function' ? off : () => {}; },
    locale: { register: () => () => {}, bind: () => (key) => key },
    slots: {
      inject(_name, build) { build(); return () => {}; },
      register(options, Component) {
        if (options.name === 'conversation.composer.dock') slots.dock = Component;
        if (options.name === 'settings.section') slots.section = Component;
        return () => {};
      },
    },
  });
  assert.ok(slots.dock, `${which}: dock occupant 必须注册（否则本套件在测一个不存在的挂载点）`);
  assert.ok(slots.section, `${which}: 设置页分区必须注册`);
  return { exports, slots, appended, warns };
}

/** 设置页的 t：查不到就把 key 原样印上屏（内核坏形），再用小词典把按钮名换成可定位的中文。 */
const tFor = (which) => (key) => (HALF[which].dict[key] || key);

/** 遍历元素树，按按钮文字找 props.onClick。 */
function findButton(tree, label) {
  let hit = null;
  (function walk(node) {
    if (!node || typeof node !== 'object' || hit) return;
    if (Array.isArray(node)) { node.forEach(walk); return; }
    if (node.props) {
      const text = JSON.stringify(node.props.children ?? '');
      if (typeof node.props.onClick === 'function' && text.includes(label)) hit = node.props;
      walk(node.props.children);
    }
  })(tree);
  return hit;
}

// ---------------------------------------------------------------------------
// mini 钩子驱动：useState / useEffect / useRef / useMemo / useCallback
// ---------------------------------------------------------------------------

function mount(Component, makeProps) {
  const internals = React.__SECRET_INTERNALS_DO_NOT_USE_OR_YOU_WILL_BE_FIRED;
  assert.ok(internals && internals.ReactCurrentDispatcher, 'React 内部 dispatcher 槽位缺失（升级 React 需同步本夹具）');
  const slot = internals.ReactCurrentDispatcher;
  const cells = [];
  let cursor = 0;
  let scheduled = false;
  let tree = null;
  const sameDeps = (a, b) => a && b && a.length === b.length && a.every((v, i) => Object.is(v, b[i]));

  const hooks = {
    useState(init) {
      const i = cursor++;
      if (!(i in cells)) cells[i] = { value: typeof init === 'function' ? init() : init };
      const cell = cells[i];
      return [cell.value, (next) => {
        const v = typeof next === 'function' ? next(cell.value) : next;
        if (Object.is(v, cell.value)) return;
        cell.value = v;
        scheduled = true;
      }];
    },
    useRef(initial) {
      const i = cursor++;
      if (!(i in cells)) cells[i] = { current: initial };
      return cells[i];
    },
    useMemo(fn, deps) {
      const i = cursor++;
      if (!(i in cells) || !sameDeps(cells[i].deps, deps)) cells[i] = { value: fn(), deps };
      return cells[i].value;
    },
    useCallback: (fn) => fn,
    useEffect(fn, deps) {
      const i = cursor++;
      const cell = cells[i];
      if (!cell || !sameDeps(cell.deps, deps)) {
        if (cell && typeof cell.off === 'function') cell.off();
        cells[i] = { deps, off: null, run: fn };
      }
    },
  };

  function render() {
    scheduled = false;
    cursor = 0;
    const prev = slot.current;
    slot.current = hooks;
    try {
      // 注册进 settings.section 的是 `function (props) { return h(Section, props); }` 这层壳，
      // 所以要在 dispatcher 之下把函数型元素往下走一层，否则拿到的树里只有壳、没有按钮。
      let out = Component(makeProps());
      let depth = 0;
      while (out && typeof out.type === 'function' && depth++ < 4) out = out.type(out.props);
      tree = out;
    } finally { slot.current = prev; }
    for (const cell of cells) {
      if (cell && cell.run) { const run = cell.run; cell.run = null; cell.off = run() || null; }
    }
    let guard = 0;
    while (scheduled && guard++ < 20) render();
  }
  render();
  return {
    tree: () => tree,
    render,
    settle: async () => { await new Promise((r) => setTimeout(r, 90)); if (scheduled) render(); },
    click: (label) => {
      const btn = findButton(tree, label);
      assert.ok(btn, `设置页里找不到按钮：${label}`);
      btn.onClick();
      // onClick 里的 setMsg 只置了 scheduled 位，必须立刻重渲染才能在树里看到反馈文案
      // （真实 React 会在下一个 commit 做这件事；本夹具等价、且不依赖 90ms 定时器）。
      if (scheduled) render();
    },
  };
}

// ---------------------------------------------------------------------------
// 快照夹具（形状照内核 InputState / SessionSnapshot 读到的字段）
// ---------------------------------------------------------------------------

const PRESSURE_85 = { projectedTokens: 8500, contextWindow: 10000 };
const FILE_CHANGES = { changes: [{ path: 'a.js', op: 'write', before: '', after: 'x', seq: 3 }] };
const idleInput = (over = {}) => ({ draft: '', attachmentIds: [], phase: 'plain', ...over });
const idleSession = (over = {}) => ({ running: false, pendingSubmissions: [], ...over });

/**
 * 挂 dock occupant，快照与调用计数都由调用方掌控。
 * @returns {{calls:{setDraft:string[],submit:number}, m, appended, warns}}
 */
function mountDock(which, spec = {}) {
  const loaded = loadClient(which, spec.loadOpts || {});
  const calls = { setDraft: [], submit: 0 };
  const props = {
    sessionId: spec.sessionId || 's1',
    inputActions: {
      setDraft: (text) => { calls.setDraft.push(text); },
      submit: () => { calls.submit += 1; },
    },
    useProjection: (key) => (key === 'contextPressure'
      ? (spec.pressure === undefined ? PRESSURE_85 : spec.pressure)
      : key === 'fileChanges' ? (spec.changes === undefined ? FILE_CHANGES : spec.changes) : undefined),
    useInput: spec.noInput ? undefined : ((sel) => sel(typeof spec.input === 'function' ? spec.input() : (spec.input ?? idleInput()))),
    useSession: spec.noSession ? undefined : ((sel) => sel(spec.session ?? idleSession())),
  };
  const m = mount(loaded.slots.dock, () => props);
  return { calls, m, appended: loaded.appended, warns: loaded.warns, loaded };
}

// ---------------------------------------------------------------------------
// ① 闸门判据表
// ---------------------------------------------------------------------------

test('composerGate 判据表：只有「空草稿 + plain + 不忙」放行（两件内置件各自成立）', () => {
  for (const which of ['compact', 'review']) {
    const gate = loadClient(which).exports.__internals.composerGate;
    assert.equal(gate(idleInput(), idleSession()), 'ready', `${which}: 空草稿 + plain + 不忙 必须放行`);
    assert.equal(gate(idleInput({ draft: '把说明改清楚' }), idleSession()), 'has-content', `${which}: 草稿非空`);
    assert.equal(gate(idleInput({ draft: '   \n  ' }), idleSession()), 'ready',
      `${which}: 纯空白按内核 trim 口径算空（:18806 empty = draft.trim() === ""）——判据与内核同源，不自立口径`);
    assert.equal(gate(idleInput({ attachmentIds: ['att-1'] }), idleSession()), 'has-content', `${which}: 附件也是内容`);
    for (const phase of ['adjudicating', 'claimed', 'submitting']) {
      assert.equal(gate(idleInput({ phase }), idleSession()), 'busy', `${which}: phase=${phase} 不算空闲`);
    }
    assert.equal(gate(idleInput(), idleSession({ running: true })), 'busy', `${which}: 轮次在跑`);
    assert.equal(gate(idleInput(), idleSession({ pendingSubmissions: ['echo-1'] })), 'busy', `${which}: 本地回声还没落 turn/start`);
    assert.equal(gate(null, idleSession()), 'unknown', `${which}: 读不到输入快照`);
    assert.equal(gate({ draft: 'x' }, idleSession()), 'unknown', `${which}: 形状不认识（attachmentIds 缺失）`);
    assert.equal(gate({ draft: '', attachmentIds: [] }, idleSession()), 'unknown', `${which}: phase 缺失不许当成 plain`);
    assert.equal(gate(idleInput(), null), 'unknown', `${which}: 读不到会话快照`);
  }
});

test('两件内置件的 composerGate 逐字同源（防只修一件）', () => {
  const a = loadClient('compact').exports.__internals.composerGate.toString();
  const b = loadClient('review').exports.__internals.composerGate.toString();
  assert.equal(a.replace(/\s+/g, ''), b.replace(/\s+/g, ''), '两份闸门实现必须一致');
});

// ---------------------------------------------------------------------------
// ② occupant 渲染级
// ---------------------------------------------------------------------------

test('空草稿 + 空闲 + 过阈值：填入 /compact 并提交，右下角提示照常出现', async () => {
  const h = mountDock('compact');
  await h.m.settle();
  assert.deepEqual(h.calls.setDraft, ['/compact'], '该触发时必须真触发');
  assert.equal(h.calls.submit, 1, '提交必须跟上（否则只是把 /compact 留在输入框里）');
  assert.equal(h.appended.length, 1, '一条提示');
  assert.match(h.appended[0].textContent, /已自动压缩/);
});

test('用户写了半篇草稿：绝不 setDraft、绝不提交、不弹提示（报障的那一条）', async () => {
  const h = mountDock('compact', { input: idleInput({ draft: '请把这版引导词扩写：第一段讲清楚为什么需要' }) });
  await h.m.settle();
  assert.deepEqual(h.calls.setDraft, [], 'setDraft 是整篇替换——一次调用就把用户的草稿覆盖掉');
  assert.equal(h.calls.submit, 0);
  assert.equal(h.appended.length, 0, '被挡时不该弹出「已自动压缩」这种误导性提示');
});

test('附件挂着 / 输入处于 claimed：同样不提交', async () => {
  const withFile = mountDock('compact', { input: idleInput({ attachmentIds: ['att-1'] }) });
  await withFile.m.settle();
  assert.deepEqual(withFile.calls.setDraft, []);
  const claimed = mountDock('compact', { input: idleInput({ phase: 'claimed' }) });
  await claimed.m.settle();
  assert.deepEqual(claimed.calls.setDraft, []);
});

test('这一轮还在跑：不提交（/compact 本来也会被内核拒，别先丢草稿）', async () => {
  const h = mountDock('compact', { session: idleSession({ running: true }) });
  await h.m.settle();
  assert.deepEqual(h.calls.setDraft, []);
  assert.equal(h.calls.submit, 0);
});

test('读不到 useInput / useSession：保守停手，并把原因 warn 出来（一次为限）', async () => {
  const noInput = mountDock('compact', { noInput: true });
  await noInput.m.settle();
  assert.deepEqual(noInput.calls.setDraft, [], '未知状态不提交');
  assert.equal(noInput.warns.length, 1, '必须可观测，不能静默变成「功能没了」');
  assert.match(noInput.warns[0], /读不到输入框/);
  const noSession = mountDock('compact', { noSession: true });
  await noSession.m.settle();
  assert.deepEqual(noSession.calls.setDraft, []);
});

test('占用率不过阈值时本来就不该动（闸门不是唯一那道判据，别把它当恒真）', async () => {
  const h = mountDock('compact', { pressure: { projectedTokens: 3000, contextWindow: 10000 } });
  await h.m.settle();
  assert.deepEqual(h.calls.setDraft, []);
});

test('被挡不记冷却：草稿清空后同一次挂载里就补做压缩', async () => {
  let snapshot = idleInput({ draft: '还在写' });
  const h = mountDock('compact', { sessionId: 's2', input: () => snapshot });
  await h.m.settle();
  assert.deepEqual(h.calls.setDraft, [], '第一段：草稿非空，不许动');
  snapshot = idleInput();
  h.m.render();
  await h.m.settle();
  assert.deepEqual(h.calls.setDraft, ['/compact'], '第二段：草稿一空就补做——跳过时不能把 3 分钟冷却记掉');
});

// ---------------------------------------------------------------------------
// ③ 设置页按钮：同走一道门，被挡要说清楚
// ---------------------------------------------------------------------------

test('手动「立即压缩」在草稿非空时不覆盖用户内容，并把原因显示出来', async () => {
  const h = mountDock('compact', { sessionId: 's3', input: idleInput({ draft: '我写的东西' }) });
  const section = mount(h.loaded.slots.section, () => ({ t: tFor('compact') }));
  section.click(HALF.compact.button);
  assert.deepEqual(h.calls.setDraft, [], '被挡时一次 setDraft 都不许发生');
  assert.match(JSON.stringify(section.tree()), /nowBlocked/, '必须给出「输入框里还有内容」这类原因，不能只说没有会话');
});

test('手动「立即压缩」在空闲时照常发送（同一条门不误伤正常路径）', async () => {
  const h = mountDock('compact', { sessionId: 's3b', pressure: null });
  const section = mount(h.loaded.slots.section, () => ({ t: tFor('compact') }));
  section.click(HALF.compact.button);
  assert.deepEqual(h.calls.setDraft, ['/compact']);
  assert.match(JSON.stringify(section.tree()), /nowDone/);
});

test('change-review：草稿非空时不发送审核请求，待审变更保留（连点两次仍在）', async () => {
  const h = mountDock('review', { sessionId: 'r1', input: idleInput({ draft: '正在写给下一轮的指令' }) });
  await h.m.settle();
  assert.deepEqual(h.calls.setDraft, [], '审核提示是一大段生成文本，绝不能顶掉用户的草稿');
  const section = mount(h.loaded.slots.section, () => ({ t: tFor('review') }));
  section.click(HALF.review.button);
  assert.deepEqual(h.calls.setDraft, []);
  assert.match(JSON.stringify(section.tree()), /nowBlocked/);
  section.click(HALF.review.button);
  assert.deepEqual(h.calls.setDraft, [], '被挡不能把 pendingChanges 吞掉——否则这轮变更永远没人审了');
});

test('change-review：空闲 + 有待审变更 → 手动入口正常发送', async () => {
  const h = mountDock('review', { sessionId: 'r2' });
  await h.m.settle();
  assert.deepEqual(h.calls.setDraft, [], '默认 mode=manual，自动链不该自己发');
  const section = mount(h.loaded.slots.section, () => ({ t: tFor('review') }));
  section.click(HALF.review.button);
  assert.equal(h.calls.setDraft.length, 1);
  assert.match(h.calls.setDraft[0], /请审核你在本会话中做出的文件变更/);
});

// ---------------------------------------------------------------------------
// 反证四条
// ---------------------------------------------------------------------------

test('反证 1：摘掉 occupant 里那句闸门判断，草稿非空时就会覆盖用户内容', async () => {
  const h = mountDock('compact', {
    input: idleInput({ draft: '还在写' }),
    loadOpts: { mutate: (src) => src.replace('if (gate !== "ready") {', 'if (false) {') },
  });
  await h.m.settle();
  assert.ok(h.calls.setDraft.length > 0,
    '闸门摘掉后仍不动输入框——上面那条「草稿非空不提交」就是空断言');
});

test('反证 2：composerGate 恒判 ready 时，附件与在跑轮次两类都会被误提交', async () => {
  const mutate = (src) => src.replace(
    /function composerGate\(input, session\) \{[\s\S]*?\n    \}/,
    'function composerGate(input, session) { return "ready"; }');
  const withFile = mountDock('compact', { input: idleInput({ attachmentIds: ['att-1'] }), loadOpts: { mutate } });
  await withFile.m.settle();
  assert.deepEqual(withFile.calls.setDraft, ['/compact'], '变异体必须把带附件的草稿也顶掉');
  const running = mountDock('compact', { session: idleSession({ running: true }), loadOpts: { mutate } });
  await running.m.settle();
  assert.deepEqual(running.calls.setDraft, ['/compact']);
});

test('反证 3：把「跳过也记冷却」写回去，草稿清空后就再也等不到压缩', async () => {
  let snapshot = idleInput({ draft: '还在写' });
  const h = mountDock('compact', {
    sessionId: 's4',
    input: () => snapshot,
    loadOpts: {
      mutate: (src) => src.replace(
        'if (gate !== "ready") {\n          if (gate === "unknown") warnUnknown();\n          return;',
        'if (gate !== "ready") {\n          if (gate === "unknown") warnUnknown();\n          cap.lastFireAt = Date.now();\n          return;'),
    },
  });
  await h.m.settle();
  snapshot = idleInput();
  h.m.render();
  await h.m.settle();
  assert.deepEqual(h.calls.setDraft, [],
    '变异体里「被挡」也把 3 分钟冷却记掉了，草稿清空后这一次再也等不到压缩——'
    + '上面那条「补做」用例（清空后立刻 /compact）因此在咬真判据');
});

test('反证 4：change-review 摘掉 blocked 分支，被挡时待审内容会被清空', async () => {
  const h = mountDock('review', {
    sessionId: 'r3',
    input: idleInput({ draft: '正在写' }),
    loadOpts: {
      mutate: (src) => src.replace(
        'if (gate !== "ready") {\n        if (gate === "unknown") warnUnknown();\n        return "blocked";\n      }',
        ''),
    },
  });
  await h.m.settle();
  const section = mount(h.loaded.slots.section, () => ({ t: tFor('review') }));
  section.click(HALF.review.button);
  assert.equal(h.calls.setDraft.length, 1, '变异体必须真的把审核提示写进草稿（否则 blocked 那条判据是空的）');
  assert.match(h.calls.setDraft[0], /请审核你在本会话中做出的文件变更/);
});
