'use strict';

// unit-builtin-manager-client.test.js — dsh-builtin-manager 页内半边（lib/client.js）回归套件。
//
// 需求：随包内置的插件要能在界面里被管理。内核那份插件页做不到——它的包级开关把名字从
// dsh.profile.bundles 摘掉后，listBundles 的行名单 = bundles ∪ dependencies ∪ 安装锚点，
// 内置件三处都不在，一关就从页面上消失、开不回来；条目级开关的解锁条件 row.entryId !== void 0
// 又只认「当前活着的条目」。所以本页走桌面壳已接线的 dsh:plugin-list / dsh:plugin-set-enabled，
// 文件写入只有 sidecar 一个写者。
//
// 挂载方式与 unit-prompt-custom-client 同族：本机没有 jsdom / react-test-renderer，用仓库里
// 真实的 React 18 + react/jsx-runtime，通过 React 内部 dispatcher 槽位手驱
// useState/useCallback/useEffect，把真实 client 源码里的组件跑起来。证据强度记为
// 「真实插件源码 + 复刻渲染夹具（非浏览器语义，仅本组件用到的钩子面）」——不冒充浏览器实测。
//
// 反证在文件末尾两条：摘掉 group 过滤、摘掉 ok===false 分支，判据必须按预期变形
//（否则前面的用例是在为不存在的守卫作证）。

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const React = require('react');
const jsxRuntime = require('react/jsx-runtime');

const DSH = path.resolve(__dirname, '..', '..');
const PKG_DIR = path.join(DSH, 'assets', 'plugins', 'dsh-builtin-manager');
const CLIENT_FILE = path.join(PKG_DIR, 'lib', 'client.js');
const HOST_FILE = path.join(PKG_DIR, 'lib', 'index.js');
const PATCH_FILE = path.join(PKG_DIR, 'cordis.patch.yml');

const fakeRequire = (name) => {
  if (name === 'react') return React;
  if (name === 'react/jsx-runtime') return jsxRuntime;
  throw new Error('client 不得 require 模块：' + name);
};

// ---------------------------------------------------------------------------
// 在 vm 里跑真实 client 源码：window.__ModuleLoader__ 捕获模块，apply(ctx) 截获注册
// ---------------------------------------------------------------------------

/**
 * @param win 注入 vm 的 window 内容（例如 { dshDesktop: { pluginManager: bridge } }）
 * @param opts.mutate 对**内存副本**做最后一改（反证用，绝不写回仓库文件）
 * @param opts.exposeInternals 追加一行透出闭包内部名（只用于直测纯函数）
 * @returns {{ exports: object, registration: {name,id,order,label}, Component: function }}
 */
function loadPanel(win, opts = {}) {
  let src = fs.readFileSync(CLIENT_FILE, 'utf8');
  if (opts.exposeInternals) {
    assert.ok(src.includes('exports.inject = inject;'), '内部导出锚点必须存在（client.js 形状变了要同步本套件）');
    src = src.replace('exports.inject = inject;', 'exports.inject = inject;\n    exports.__test = { normalize };');
  }
  if (opts.mutate) src = opts.mutate(src);

  const sandbox = {
    window: Object.assign({ __ModuleLoader__: { load(mod) { sandbox.__loaded = mod; } } }, win),
    console,
    navigator: { language: 'zh-CN' }
  };
  vm.runInNewContext(src, sandbox, { filename: 'dsh-builtin-manager-client.js' });

  const loaded = sandbox.__loaded;
  assert.ok(loaded && typeof loaded.factory === 'function', 'client.js 必须经 __ModuleLoader__.load 注册 factory');
  assert.equal(loaded.id, 'dsh-builtin-manager', '模块 id 必须等于包名（内核按它取 client bundle）');
  const exports = loaded.factory(fakeRequire);

  let registration = null;
  let Component = null;
  const ctx = {
    slots: {
      // 真实写法是 inject(name, () => ctx.slots.register(options, Component))，
      // 所以这里跑一次 build() 让 register 把两份入参交给我们。
      inject(_name, build) { build(); },
      register(options, C) { registration = options; Component = C; }
    }
  };
  exports.apply(ctx);
  assert.ok(registration, 'apply 必须向槽位注册一次');
  assert.ok(Component, '注册必须带上组件');
  return { exports, registration, Component };
}

// ---------------------------------------------------------------------------
// mini 钩子驱动：够本组件用（useState / useCallback / useEffect）
// ---------------------------------------------------------------------------

function createMounter(Component, props) {
  const internals = React.__SECRET_INTERNALS_DO_NOT_USE_OR_YOU_WILL_BE_FIRED;
  assert.ok(internals && internals.ReactCurrentDispatcher, 'React 18 内部 dispatcher 槽位缺失（升级 React 需同步本夹具）');
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
    useCallback(fn, deps) {
      const i = cursor++;
      const prev = cells[i];
      if (!prev || !sameDeps(prev.deps, deps)) cells[i] = { value: fn, deps };
      return cells[i].value;
    },
    useEffect(fn, deps) {
      const i = cursor++;
      const prev = cells[i];
      if (!prev || !sameDeps(prev.deps, deps)) pendingEffects.push(fn);
      cells[i] = { deps };
    }
  };

  const render = () => {
    cursor = 0;
    const prev = slot.current;
    slot.current = hooks;
    try {
      // 注册进槽里的是 (props) => jsx(PanelSection, props) —— 展开这一层才拿到真正的树，
      // 组件因此必须保持单层（夹具只钻一层）。
      const out = Component(props);
      tree = out && typeof out.type === "function" ? out.type(props) : out;
    } finally { slot.current = prev; }
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
  /** 渲染一次并沉降，返回最新树（点击后复用同一个 cell 数组，所以走 settle 而不是新建）。 */
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
/** 页面上所有 checkbox（每个内置插件一行一个开关）。 */
function switches(node) {
  const out = [];
  walk(node, (n) => { if (n.type === 'input' && n.props && n.props.type === 'checkbox') out.push(n); });
  return out;
}

const row = (over) => ({
  id: 'better-sidebar', name: 'dsh-better-sidebar', description: '侧栏工作台',
  enabled: true, toggleable: true, group: 'companion', removed: false, hasConfig: false, ...over
});

// ---------------------------------------------------------------------------

test('模块契约：host 半边不写文件，client 半边把页注册进 settings.plugins.tab', () => {
  const host = fs.readFileSync(HOST_FILE, 'utf8');
  // 单一写者是本功能的前提：host 侧若出现写文件，就会出现「页面显示开着、文件里写着关」的分叉。
  assert.doesNotMatch(host, /writeFileSync|writeFileAtomic|appendFile/, 'host 半边不得写文件（启停只有 sidecar 一个写者）');
  assert.match(host, /export const name = 'dsh-builtin-manager'/);

  const { exports, registration } = loadPanel({}, { exposeInternals: true });
  assert.equal(typeof exports.apply, 'function', 'apply 必须是函数');
  assert.ok(Array.isArray(exports.inject) && exports.inject.includes('slots'), 'inject 必须声明 slots');
  assert.equal(registration.name, 'settings.plugins.tab',
    '必须挂进「设置 → 插件」的 tab 槽（内核自己那份只读清单在同槽，位置才对得上用户的直觉）');
  assert.equal(registration.id, 'builtin');
  assert.equal(typeof registration.label, 'function', 'label 必须是函数（locale 变化时要能重取）');
});

test('normalize：两种桥返回形状都收，非内置组与坏行剔除（带阳性对照）', () => {
  const { exports } = loadPanel({}, { exposeInternals: true });
  const { normalize } = exports.__test;

  const rows = [
    row({ id: 'a' }),
    row({ id: 'core-thing', group: 'core' }),
    row({ id: 'other-thing', group: 'other' }),
    row({ id: 'gone', group: 'removed', removed: true }),
    null,
    { name: '缺 id' },
    'string'
  ];
  assert.deepEqual(normalize(rows).map((r) => r.id), ['a'], '只留在册内置件，坏行与非内置组必须剔除');
  // 阳性对照：上面确实剔掉了 3 条组不符 + 3 条坏形，而不是「空集也叫绿」。
  assert.equal(normalize(rows.slice(0, 4)).length, 1);
  assert.equal(normalize([]).length, 0);
  assert.deepEqual(normalize({ plugins: [row({ id: 'b' })] }).map((r) => r.id), ['b'], '{plugins:[...]} 形状也必须收');
  assert.equal(normalize({ plugins: 'nope' }).length, 0, '形状不对时不得抛，交空集');
});

test('渲染：逐条列出内置件与启停态，不可改的行置灰并说明原因', async () => {
  const bridge = {
    list: async () => ([
      row({ id: 'better-sidebar' }),
      row({ id: 'compaction-acp', name: '@deepseek-ai/dsh-compaction-acp', enabled: false }),
      row({ id: 'locked-one', name: 'dsh-locked', toggleable: false })
    ]),
    setEnabled: async () => ({ ok: true })
  };
  const { Component } = loadPanel({ dshDesktop: { pluginManager: bridge } });
  const tree = await createMounter(Component, {}).settle();

  const sw = switches(tree);
  assert.equal(sw.length, 3, '三条内置件应渲染三个开关');
  assert.equal(sw[0].props.checked, true, '第一条应为启用');
  assert.equal(sw[1].props.checked, false, '第二条应为停用');
  assert.equal(sw[2].props.disabled, true, '不可改的行的开关必须 disabled');
  const text = textAll(tree);
  assert.ok(text.includes('共 3 条内置插件'), '计数与实际渲染条数必须同源: ' + text.slice(0, 80));
  assert.ok(text.includes('下次启动'), '必须写明生效时机: ' + text.slice(0, 160));
});

test('开关：成功要回写行状态并提示生效时机；失败必须原文上屏且不谎报', async () => {
  const calls = [];
  let failWith = null;
  const bridge = {
    list: async () => ([row({ id: 'better-sidebar' }), row({ id: 'easyrewrite', name: 'dsh-easyrewrite' })]),
    setEnabled: async (id, enabled) => {
      calls.push([id, enabled]);
      if (failWith) return { ok: false, error: failWith };
      return { ok: true };
    }
  };
  const { Component } = loadPanel({ dshDesktop: { pluginManager: bridge } });
  const mounter = createMounter(Component, {});
  let tree = await mounter.settle();

  await switches(tree)[1].props.onChange({ target: { checked: false } });
  tree = await mounter.settle();
  assert.deepEqual(calls, [['easyrewrite', false]], '必须按 (行 id, enabled) 调桥：id 是 cordis 按行寻址的键，不能传成包名');
  const afterOk = textAll(tree);
  assert.ok(afterOk.includes('已保存「dsh-easyrewrite」为停用'), '成功提示要按行名与实际状态措辞: ' + afterOk.slice(0, 200));
  assert.equal(switches(tree)[1].props.checked, false, '行状态必须跟着实际结果走');

  // 失败路径：sidecar 回 ok:false（例如带自定义配置被拒）时绝不能显示「已保存」
  failWith = '该插件带自定义配置，禁止卸载: dsh-better-sidebar';
  await switches(tree)[0].props.onChange({ target: { checked: false } });
  tree = await mounter.settle();
  const afterFail = textAll(tree);
  assert.ok(afterFail.includes('带自定义配置'), '失败原文必须上屏: ' + afterFail.slice(0, 220));
  assert.ok(!afterFail.includes('已保存'), '失败时不得留着任何「已保存」字样（上一次成功的提示也必须被清掉，否则用户读到的是过期结论）;')
  assert.equal(switches(tree)[0].props.checked, true, '保存失败后行状态不得偷偷翻转');
});

test('自锁：本页自己那条不可停用，且生效时机按实测措辞', async () => {
  const calls = [];
  const bridge = {
    list: async () => ([
      row({ id: 'dsh-builtin-manager', name: 'dsh-builtin-manager' }),
      row({ id: 'better-sidebar' })
    ]),
    setEnabled: async (id, enabled) => { calls.push([id, enabled]); return { ok: true }; }
  };
  const { Component } = loadPanel({ dshDesktop: { pluginManager: bridge } });
  const tree = await createMounter(Component, {}).settle();

  const sw = switches(tree);
  assert.equal(sw.length, 2, '两条内置件应渲染两个开关');
  assert.equal(sw[0].props.disabled, true, '管理页自己那条必须 disabled——关掉它就没有界面能开回来');
  const text = textAll(tree);
  assert.ok(text.includes('这是本管理页自己'), '必须说明为什么不能关: ' + text.slice(0, 200));
  // 实测（2026-10-12 隔离安装布局 + 真内核页面）：disabled 写进去之后**重载页面**就读不到这条了，
  // 只有插件的内核半边才是下次启动。措辞不能一律写成「下次启动生效」。
  assert.ok(text.includes('刷新页面即更新') && text.includes('下次启动生效'),
    '生效时机要分两层写: ' + text.slice(-260));
  assert.equal(calls.length, 0, '渲染本身不得触发写');
});

test('无桥兜底：纯浏览器/WSL 直连内核时可读不可写', async () => {
  const { Component } = loadPanel({});   // window 里没有 dshDesktop
  const tree = await createMounter(Component, {}).settle();
  const text = textAll(tree);
  assert.ok(text.includes('没接到桌面客户端的插件通道'), '必须说清为什么不能改: ' + text.slice(0, 140));
  assert.equal(switches(tree).length, 0, '无桥时不得渲染可写开关');
});

test('包面一致：bundle 层 loader id 与在册清单同 id，client 入口在 exports 里可达', () => {
  const pkg = JSON.parse(fs.readFileSync(path.join(PKG_DIR, 'package.json'), 'utf8'));
  assert.equal(pkg.dsh.bundle.patch, 'cordis.patch.yml');
  assert.equal(pkg.dsh.client.entry, 'client');
  assert.ok(pkg.exports['./client'].endsWith('lib/client.js'), './client 必须指到真实文件');

  const patch = fs.readFileSync(PATCH_FILE, 'utf8');
  // 注释里写着「禁止 disabled: !!js」，判据只能看非注释行。
  const patchCode = patch.split('\n').filter((l) => !/^\s*#/.test(l)).join('\n');
  const m = /- insert:\s*\n\s*- id: (\S+)\s*\n\s*name: '([^']+)'/.exec(patchCode);
  assert.ok(m, 'cordis.patch.yml 必须声明自挂载条目');
  assert.equal(m[1], 'dsh-builtin-manager', 'loader id 是本套件与台账共同的键');
  assert.equal(m[2], pkg.name, 'name 必须是包名（issue #104 的坑：不一致会双挂载）');
  assert.doesNotMatch(patchCode, /disabled:\s*!!js/, '必选行上的 !!js 抛错会中断启动，禁止');

  const { COMPANION_PLUGINS } = require(path.join(DSH, 'scripts', 'lib', 'companion-plugins.js'));
  const hit = COMPANION_PLUGINS.filter((p) => p.id === m[1]);
  assert.equal(hit.length, 1, '在册清单里该 id 必须唯一命中');
  assert.equal(hit[0].name, pkg.name, '清单包名与 bundle 声明必须同源');

  // 自锁判据用的是行 id，而行 id 由 sidecar 按清单给——三方必须同值，否则自锁静默失效。
  const clientSrc = fs.readFileSync(path.join(PKG_DIR, 'lib', 'client.js'), 'utf8');
  const selfM = /const SELF = "([^"]+)"/.exec(clientSrc);
  assert.ok(selfM, 'client 必须定义 SELF 常量');
  assert.equal(selfM[1], m[1], 'SELF 必须等于 bundle 层 loader id');
  assert.equal(selfM[1], hit[0].id, 'SELF 必须等于在册清单的行 id');
});

// ---------------------------------------------------------------------------
// 反证三条：守卫被摘掉时行为必须按预期变形，否则上面的判据是空的
// ---------------------------------------------------------------------------

test('反证 1：摘掉 group 过滤后，core 行会混进列表（证明那条用例真在咬这条判据）', () => {
  const { exports } = loadPanel({}, {
    exposeInternals: true,
    mutate: (src) => src.replace('.filter((r) => r.group === "companion")', '')
  });
  const { normalize } = exports.__test;
  assert.equal(normalize([row({ id: 'a' }), row({ id: 'core-thing', group: 'core' })]).length, 2,
    '过滤已被摘掉，core 行应当漏进来');
});

test('反证 2：摘掉 ok===false 分支后，失败会被报成「已保存」（本套件因此不能少那条断言）', async () => {
  const calls = [];
  const bridge = {
    list: async () => ([row({ id: 'easyrewrite', name: 'dsh-easyrewrite' })]),
    setEnabled: async (id, enabled) => { calls.push([id, enabled]); return { ok: false, error: '被拒绝' }; }
  };
  const { Component } = loadPanel({ dshDesktop: { pluginManager: bridge } }, {
    mutate: (src) => src.replace('if (r && r.ok === false) {', 'if (false) {')
  });
  const mounter = createMounter(Component, {});
  let tree = await mounter.settle();
  await switches(tree)[0].props.onChange({ target: { checked: false } });
  tree = await mounter.settle();
  assert.equal(calls.length, 1, '桥必须真的被调用过（否则本条反证是空转）');
  assert.ok(textAll(tree).includes('已保存'), '守卫摘掉后页面会谎报已保存——这正是上面那条断言要防的');
});

test('反证 3：摘掉自锁分支后，本页自己那条变成可停用（自锁那条用例因此在咬真判据）', async () => {
  const calls = [];
  const bridge = {
    list: async () => ([row({ id: 'dsh-builtin-manager', name: 'dsh-builtin-manager' })]),
    setEnabled: async (id, enabled) => { calls.push([id, enabled]); return { ok: true }; }
  };
  const { Component } = loadPanel({ dshDesktop: { pluginManager: bridge } }, {
    mutate: (src) => src.replace('const locked = self || row.toggleable', 'const locked = row.toggleable')
  });
  const mounter = createMounter(Component, {});
  let tree = await mounter.settle();
  assert.equal(switches(tree)[0].props.disabled, false, '守卫摘掉后自己那条就该是可点的');
  await switches(tree)[0].props.onChange({ target: { checked: false } });
  tree = await mounter.settle();
  assert.deepEqual(calls, [['dsh-builtin-manager', false]], '摘掉守卫后「关掉管理页」会被真的写下去');
});
