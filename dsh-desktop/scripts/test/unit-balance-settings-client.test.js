'use strict';

// ---------------------------------------------------------------------------
// unit-balance-settings-client.test.js —— dsh-balance 客户端「设置 → 通用」两行
// 与条目设置读写的机器锁（2026-10-16 余额开关线）。
//
// 为什么要这条锁：内核**不会**按插件导出的 Config 自动生成设置页（autoGenerate
// 只在 dsh-settings 与 wire schema 里出现，客户端包 0 消费方）。宿主半声明 Config
// 只保证条目进 describe() 名单；页面上的开关必须由客户端自己注册进
// settings.general.item 槽。只声明不注册 = 开关无处可拨，比退役掉的壳层 ⋯ 菜单
// 还退化。这条线在 2026-10-16 的隔离内核实机上实测过一遍，本文件把实测到的
// 契约固定下来：
//   1. apply() 注册三处：dock 条目 + 两条设置行（槽名/id/order/字段名）；
//   2. 行组件的渲染形态：role=switch、aria-checked 跟随条目值、读不到即置灰；
//   3. 点击写回的 wire 契约：mutate(ns='balance', [{op:'set',path:[field],value}], revision)
//      ——ns 是 profile 条目 id，不是包名；revision 用 describe() 读到的那个；
//   4. 写成功后按返回值续用（不自增 revision、不重取一轮 describe）；
//   5. 降级：describe 抛错 / 条目缺席 → status failed|missing → 两行都置灰不炸；
//   6. 上一项关闭时第二项（OpenCode Go）置灰——它只在 dock 里显示。
//
// 挂载方式与 unit-builtin-manager-client 同族：本机无 jsdom，用 vm 物化真实
// client.js，react / jsx-runtime 是**桩**（useSyncExternalStore 直接返回快照，
// jsx 记录成 {type, props} 便于遍历）。证据强度：真实插件源码 + 复刻钩子面，
// 不冒充浏览器实测。dock 自身依设置隐藏的那两行判据由 unit-balance-config-entry
// 的源码锁把住（隔离环境无凭据，dock 无论开关都渲染为空，页面侧无法区分）。
//
// 运行：node --test scripts/test/unit-balance-settings-client.test.js
// ---------------------------------------------------------------------------

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const CLIENT = path.join(__dirname, '..', '..', 'assets', 'plugins', 'dsh-balance', 'lib', 'client.js');

/** 深层惰性 stub：任意链式访问都取得到东西（宿主缺席时的 require 兜底）。 */
function deepStub() {
  const f = () => stub;
  const stub = new Proxy(f, {
    get: (_t, k) => (k === Symbol.toPrimitive ? () => '' : stub),
    apply: () => stub,
    construct: () => stub,
  });
  return stub;
}

/** react 桩：本组件只用到 useSyncExternalStore / useState / useEffect。 */
function makeRequire() {
  const react = {
    useSyncExternalStore: (_subscribe, getSnapshot) => getSnapshot(),
    useState: (init) => [typeof init === 'function' ? init() : init, () => {}],
    useEffect: () => {},
    useRef: (v) => ({ current: v }),
    useMemo: (fn) => fn(),
    useCallback: (fn) => fn,
    useId: () => 'stub-id',
  };
  const jsxRuntime = {
    Fragment: 'Fragment',
    jsx: (type, props, key) => ({ type, props, key }),
    jsxs: (type, props, key) => ({ type, props, key }),
  };
  return (name) => (name === 'react' ? react : name === 'react/jsx-runtime' ? jsxRuntime : deepStub());
}

function loadClient() {
  let def;
  const window = { __ModuleLoader__: { load: (d) => { def = d; } } };
  vm.runInNewContext(fs.readFileSync(CLIENT, 'utf8'), { window, console });
  assert.ok(def && def.factory, 'client.js 必须经 __ModuleLoader__.load 注册');
  return def.factory(makeRequire());
}

/**
 * 造一个够用的 ctx：slots 记录注册、remote.settings 按内核 describe/mutate 形状应答。
 * @param {object} [opts] - rows: describe() 返回的命名空间行；throwOnDescribe: 读失败形态
 */
function makeCtx(opts = {}) {
  const state = {
    rows: opts.rows === undefined
      ? [{ ns: 'balance', value: { showBalanceDock: true, showOpenCodeGoUsage: true, balancePrices: {} }, revision: 7 }]
      : opts.rows,
    writable: opts.writable === undefined ? true : opts.writable,
    throwOnDescribe: !!opts.throwOnDescribe,
    mutateCalls: [],
    value: { showBalanceDock: true, showOpenCodeGoUsage: true, balancePrices: {} },
    revision: 7,
  };
  const registered = [];
  const remote = {
    settings: {
      async describe() {
        if (state.throwOnDescribe) throw new Error('settings describe unavailable');
        return { ok: true, value: { writable: state.writable, hasDocument: true, namespaces: state.rows } };
      },
      async mutate(ns, ops, expectedRevision) {
        state.mutateCalls.push({ ns, ops, expectedRevision });
        const [op] = ops;
        state.value = { ...state.value, [op.path[0]]: op.value };
        state.revision += 1;
        return { ok: true, value: { ns, value: state.value, revision: state.revision } };
      },
    },
  };
  const ctx = {
    effect: (fn) => fn(),
    remote,
    slots: {
      register: (options, Component) => { registered.push({ options, Component }); return { options, Component }; },
      inject: (_key, factory) => { factory(); },
    },
  };
  return { ctx, registered, state };
}

/** 等一轮微任务 + 一次宏任务，让 bindSettingsScope 的 describe() 落地。 */
async function settle() {
  await new Promise((resolve) => setImmediate(resolve));
  await Promise.resolve();
}

/** 深度找到渲染树里的 switch 按钮。 */
function findSwitch(node) {
  if (!node || typeof node !== 'object') return null;
  if (node.props && node.props.role === 'switch') return node;
  const kids = node.props && node.props.children;
  const list = Array.isArray(kids) ? kids : kids ? [kids] : [];
  for (const kid of list) {
    const hit = findSwitch(kid);
    if (hit) return hit;
  }
  return null;
}

function rowById(registered, id) {
  return registered.find((entry) => entry.options.id === id);
}

// ---- 1. 注册形态 -----------------------------------------------------------

test('apply 注册 dock 条目与两条设置行（内核不自动生成页面）', async () => {
  const exports_ = loadClient();
  assert.equal(exports_.inject.join(','), 'slots,remote,remote.settings', '客户端必须声明 remote.settings 依赖');
  const { ctx, registered } = makeCtx();
  exports_.apply(ctx);
  await settle();

  const dock = rowById(registered, 'balance');
  assert.ok(dock, 'dock 条目缺失');
  assert.equal(dock.options.name, 'conversation.composer.dock');
  assert.equal(typeof dock.options.inject, 'function', 'dock 必须把设置 hook 经 inject 递给组件');
  assert.ok(dock.options.inject().useSettings, 'dock 拿不到 useSettings 就退化成只认载荷');

  for (const [id, field] of [['balance-dock', 'showBalanceDock'], ['balance-opencode-go', 'showOpenCodeGoUsage']]) {
    const row = rowById(registered, id);
    assert.ok(row, `设置行 ${id} 缺失——开关在界面上不存在`);
    assert.equal(row.options.name, 'settings.general.item', `设置行 ${id} 槽名漂移`);
    const props = row.options.inject();
    assert.equal(props.field, field, `设置行 ${id} 绑错字段`);
    assert.equal(typeof props.useScope, 'function');
    assert.equal(typeof props.scope.set, 'function');
  }
  assert.ok(rowById(registered, 'balance-opencode-go').options.inject().dependsOn === 'showBalanceDock',
    'Go 额度行必须跟着 dock 开关置灰');
});

// ---- 2. 渲染形态 -----------------------------------------------------------

test('设置行渲染出 role=switch，aria-checked 跟随条目值', async () => {
  const exports_ = loadClient();
  const { ctx, registered } = makeCtx();
  exports_.apply(ctx);
  await settle();

  const row = rowById(registered, 'balance-dock');
  const node = findSwitch(row.Component(row.options.inject()));
  assert.ok(node, '行组件没渲染出 switch');
  assert.equal(node.props['aria-checked'], true, 'describe 读到 true 时开关应显示为开');
  assert.equal(node.props.disabled, false);
  assert.equal(node.props['aria-label'], '显示余额与本轮费用');
});

test('上一项关闭时 OpenCode Go 行置灰（它只在 dock 里显示）', async () => {
  const exports_ = loadClient();
  const { ctx, registered } = makeCtx({
    rows: [{ ns: 'balance', value: { showBalanceDock: false, showOpenCodeGoUsage: true, balancePrices: {} }, revision: 3 }],
  });
  exports_.apply(ctx);
  await settle();

  const go = rowById(registered, 'balance-opencode-go');
  const node = findSwitch(go.Component(go.options.inject()));
  assert.equal(node.props.disabled, true, 'dock 关着时 Go 行必须置灰，而不是点了没反应');
  assert.equal(node.props['aria-checked'], true, '置灰不改写已存的值');
});

// ---- 3. 写回的 wire 契约 -----------------------------------------------------

test('点击写回：mutate("balance", [{op:"set",path:[field],value}], revision)', async () => {
  const exports_ = loadClient();
  const { ctx, registered, state } = makeCtx();
  exports_.apply(ctx);
  await settle();

  const row = rowById(registered, 'balance-dock');
  const props = row.options.inject();
  const node = findSwitch(row.Component(props));
  node.props.onClick();
  await settle();
  await settle();

  assert.equal(state.mutateCalls.length, 1, '一次点击只发一次写');
  const call = state.mutateCalls[0];
  assert.equal(call.ns, 'balance', 'ns 必须是 profile 条目 id，不是包名 dsh-balance');
  // ops 是 vm 域里建的数组，与宿主域原型不同 → 按值比（deepEqual 会因跨域判不等）。
  assert.equal(JSON.stringify(call.ops), JSON.stringify([{ op: 'set', path: ['showBalanceDock'], value: false }]));
  assert.equal(call.expectedRevision, 7, '必须带上 describe() 读到的 revision（乐观锁）');

  // 写完按返回值续用：不重取 describe、不自增到别处去。
  assert.equal(props.scope.getSnapshot().value.showBalanceDock, false);
  assert.equal(props.scope.getSnapshot().revision, 8);
  const again = findSwitch(row.Component(props));
  assert.equal(again.props['aria-checked'], false, '点击后界面必须立刻反映新值');
});

// ---- 4/5. 降级面 -----------------------------------------------------------

test('describe 抛错 → 两行置灰且不炸', async () => {
  const exports_ = loadClient();
  const { ctx, registered } = makeCtx({ throwOnDescribe: true });
  assert.doesNotThrow(() => exports_.apply(ctx));
  await settle();
  for (const id of ['balance-dock', 'balance-opencode-go']) {
    const row = rowById(registered, id);
    const node = findSwitch(row.Component(row.options.inject()));
    assert.equal(node.props.disabled, true, `${id} 在设置读不到时必须置灰`);
    assert.equal(node.props['aria-checked'], false, '读不到时不得假装是开的');
  }
});

test('条目不在 describe() 名单（missing）→ 置灰，绝不隐藏整页', async () => {
  const exports_ = loadClient();
  const { ctx, registered } = makeCtx({ rows: [] });
  exports_.apply(ctx);
  await settle();
  const row = rowById(registered, 'balance-dock');
  const node = findSwitch(row.Component(row.options.inject()));
  assert.equal(node.props.disabled, true, '没进名单说明条目没 volatile 字段，写也写不回，必须置灰');
  assert.ok(row.Component(row.options.inject()), '行本身仍要渲染（用户看得见「为什么是灰的」）');
});

test('writable=false（provider 只读）→ 置灰', async () => {
  const exports_ = loadClient();
  const { ctx, registered } = makeCtx({ writable: false });
  exports_.apply(ctx);
  await settle();
  const row = rowById(registered, 'balance-dock');
  const node = findSwitch(row.Component(row.options.inject()));
  assert.equal(node.props.disabled, true);
});
