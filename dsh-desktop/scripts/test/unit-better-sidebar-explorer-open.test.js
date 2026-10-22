'use strict';

// unit-better-sidebar-explorer-open.test.js — 「资源管理器」栏头与「在本地打开」回归锁。
//
// 用户报障：客户端右上角的文件资源管理器点了没反应。隔离内核实机量到两件事：
//   ① 栏头那一行写着「资源管理器」，但它是个纯 <span>——只有行尾那颗小箭头
//      （aria-label 收起文件树）带 onClick。按 VS Code 肌肉记忆点标题，就是字面
//      意义的「无反应」。修法：整行合成一个 <button>（图标+标题+箭头），带
//      aria-expanded；不嵌套第二个交互元素（那是非法标记，且键盘走不到）。
//   ② 内核的「文件资源管理器」入口（open-in-app 的 split button）注册在
//      sidebar.right.tab.files.actions，而这个槽的唯一宿主是**内置** files body
//      （@deepseek-ai/dsh-client-ui-sidebar-files/lib/client.js:699）。本插件以
//      extension 优先级接管了同一个 files kind，宿主不再渲染 → 那颗按钮在产品里
//      整颗消失（实测页面内 [data-open-target] 恒 0，而 GET /open-in-app/apps
//      照回 ["explorer","vscode","gitbash"]、POST /open-in-app/open 照回 200）。
//      修法：TreePanel 工具条自己挂一个 OpenLocallyButton，应用清单仍取宿主目录
//      catalog，宿主说不能开（清单为空）就整块不渲染——不给死行。
//
// 证据形态：不读源码字符串当行为断言。取**发行产物** lib/client.js 里
// `function ExplorerRail(props)` / `function ExplorerRailCollapsed(props)` /
// `function OpenLocallyButton(props)` 三个函数体（tsdown 保留 `//#region <源路径>`
// 定界，函数名不被压缩掉），在 vm 沙箱里用仓库真实 React 的钩子面手驱渲染，
// 再对返回的元素树做断言。与 unit-builtin-manager-client / unit-prompt-custom-client
// 同族：证据强度是「真实插件源码 + 复刻渲染夹具（非浏览器语义，仅本组件用到的钩子面）」，
// 不冒充浏览器实测；真开页面的那一步仍是隔离内核实机。
//
// 反证五条在文件末尾：把 open(cwd, application) 退成 open(cwd)、摘掉「清单为空即不
// 渲染」的守卫、摘掉 aria-expanded、把 onCollapse 换成空函数、摘掉工具条的挂载条件
// —— 判据必须按预期变形，否则前面的用例是在为不存在的守卫作证。
//
// 运行：node --test scripts/test/unit-better-sidebar-explorer-open.test.js

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const React = require('react');
const jsxRuntime = require('react/jsx-runtime');

const DSH = path.resolve(__dirname, '..', '..');
const PKG_DIR = path.join(DSH, 'assets', 'plugins', 'dsh-better-sidebar');
const CLIENT_FILE = path.join(PKG_DIR, 'lib', 'client.js');
const LOCALES_SRC = path.join(PKG_DIR, 'src', 'client', 'locales.ts');
const TREE_PANEL_SRC = path.join(PKG_DIR, 'src', 'client', 'TreePanel.tsx');

const artifact = fs.readFileSync(CLIENT_FILE, 'utf8').replace(/\r\n/g, '\n');

// ---------------------------------------------------------------------------
// 从产物里抠函数体（brace 匹配；产物是 tab 缩进的 CJS 工厂内联段）
// ---------------------------------------------------------------------------

/** 抓 `function <name>(props) {…}` 的完整源码。找不到即判红（产物形状变了要先改这里）。 */
function extractFn(text, name) {
  const head = new RegExp(`function ${name}\\(props\\) \\{`).exec(text);
  assert.ok(head !== null, `产物里找不到 function ${name}(props)（构建形状变了，别改测试要改判据）`);
  let depth = 0;
  let i = text.indexOf('{', head.index);
  for (; i < text.length; i++) {
    const c = text[i];
    if (c === '{') depth += 1;
    else if (c === '}') {
      depth -= 1;
      if (depth === 0) return text.slice(head.index, i + 1);
    }
  }
  throw new Error(`${name}: 括号没闭合，抠取失败`);
}

// ---------------------------------------------------------------------------
// 迷你渲染器：只实现这三个组件用到的钩子面（useState/useRef/useEffect）
// ---------------------------------------------------------------------------

const el = (type, props) => ({ type, ...(props || {}) });

/** jsx/jsxs 桩：把 children 归一成数组，元素即纯对象，便于 walk。 */
function makeJsx() {
  const jsx = (type, props) => {
    const { children, ...rest } = props || {};
    const list = children === undefined ? [] : (Array.isArray(children) ? children.filter(c => c !== false && c != null) : [children]);
    return el(type, { ...rest, children: list });
  };
  return { jsx, jsxs: jsx, Fragment: '#fragment' };
}

/**
 * 手驱渲染一个函数组件到稳定。
 * @param fnSource - 组件源码（`function X(props){…}`）
 * @param props - 组件入参
 * @param extra - 该组件需要的额外自由名（stub 表）
 * @returns 元素树 + 每次 effect 的清理入口
 */
async function render(fnSource, props, extra = {}) {
  // 一条槽位数组按调用顺序编号（与 React 的 fiber hook 链同理）：useState/useRef/
  // useEffect 共用游标，分开编号会让 useRef 落到 undefined 槽上。
  const slots = [];
  let cursor = 0;
  let dirty = false;
  const rerender = () => { dirty = true; };
  const react = {
    useState: (init) => {
      const i = cursor++;
      if (slots[i] === undefined) slots[i] = { kind: 'state', value: typeof init === 'function' ? init() : init };
      const box = slots[i];
      return [box.value, (next) => {
        box.value = typeof next === 'function' ? next(box.value) : next;
        rerender();
      }];
    },
    useRef: (init) => {
      const i = cursor++;
      if (slots[i] === undefined) slots[i] = { kind: 'ref', current: init };
      return slots[i];
    },
    // deps 浅比较；变化即 cleanup 后重跑（与 React 的语义对本组件够用）。
    useEffect: (body, deps) => {
      const i = cursor++;
      if (slots[i] === undefined) slots[i] = { kind: 'effect', deps: undefined, cleanup: undefined };
      const box = slots[i];
      const same = box.deps !== undefined && Array.isArray(box.deps) && Array.isArray(deps)
        && box.deps.length === deps.length && box.deps.every((d, k) => d === deps[k]);
      if (same) return;
      if (typeof box.cleanup === 'function') box.cleanup();
      box.deps = deps;
      box.cleanup = undefined;
      Promise.resolve(body()).then((cleanup) => {
        if (typeof cleanup === 'function') box.cleanup = cleanup;
      });
    },
    useMemo: (factory) => factory(),
    useCallback: (fn) => fn,
  };
  const jsx = makeJsx();
  const sandbox = {
    react,
    react_jsx_runtime: jsx,
    ...extra,
    console,
    setTimeout,
    clearTimeout,
    Promise,
    Array,
    Object,
    JSON,
    Math,
    Number,
    String,
    Boolean,
    Date,
    Error,
    RegExp,
    Symbol,
    isNaN,
    encodeURIComponent,
    document: undefined,
    window: undefined,
  };
  vm.createContext(sandbox);
  const Component = vm.runInContext(`(${fnSource})`, sandbox);
  let tree = null;
  for (let pass = 0; pass < 12; pass++) {
    cursor = 0;
    dirty = false;
    tree = Component(props);
    // 让 effect 里的 promise 回调落地，再决定是否还有一轮。
    await new Promise(resolve => setImmediate(resolve));
    await new Promise(resolve => setImmediate(resolve));
    if (!dirty) break;
  }
  return { tree, sandbox, slots };
}

/** 深度优先收集满足条件的元素。 */
function collect(node, pred, out = []) {
  if (node === null || node === undefined || typeof node !== 'object') return out;
  if (Array.isArray(node)) {
    for (const item of node) collect(item, pred, out);
    return out;
  }
  if (pred(node)) out.push(node);
  if (node.children !== undefined) collect(node.children, pred, out);
  if (node.anchor !== undefined) collect(node.anchor, pred, out);
  return out;
}

const isButton = (node) => node.type === 'button';

// ---------------------------------------------------------------------------
// 共用的桩：t 走键名（不写死文案），css 走名字，图标/原语走组件身份
// ---------------------------------------------------------------------------

const t = (key) => `T:${key}`;
const css = new Proxy({}, { get: (_target, name) => String(name) });
const icon = (name) => ({ name: `icon:${name}` });
const primitives = {
  IconFolderOpenRegular: icon('folder'),
  IconChevronLeftOutlineRegular: icon('chevron-left'),
  IconChevronRightOutlineRegular: icon('chevron-right'),
  IconRightUpOutlineRegular: icon('right-up'),
  IconChevronDownOutlineRegular: icon('chevron-down'),
  Menu: { name: 'Menu' },
};

/** 一个可点的按钮元素：调用其 onClick。 */
function click(node) {
  assert.equal(typeof node.onClick, 'function', '该元素应带 onClick');
  node.onClick({ preventDefault() {}, currentTarget: { setPointerCapture() {} }, clientX: 0, clientY: 0 });
}

// ---------------------------------------------------------------------------
// ① 栏头整行是开关
// ---------------------------------------------------------------------------

const railDeps = {
  _deepseek_ai_dsh_client_ui_primitives: primitives,
  t,
  sidebar_module_css_default: css,
  createFrameBatcher: () => ({ schedule() {}, flushNow() {}, dispose() {} }),
  clampExplorerWidth: (n) => n,
  TreePanel: { name: 'TreePanel' },
};

/** 渲染 ExplorerRail，返回元素树。 */
async function mountRail(overrides = {}) {
  const props = {
    sessionId: 's1', cwd: '/abs/work', expanded: [], revealed: [], visible: true,
    onToggleDir() {}, onOpenFile() {}, onOpenFileNewTab() {}, onOpenFileSide() {},
    openInApp: {}, openWithTargets: [], openWithPinned: [], openWithSsh: false,
    openWithShowPluginTargets: false, onOpenWith() {}, onToggleOpenWithPin() {},
    onReferenceFile() {}, onPathRenamed() {}, onPathDeleted() {}, service: undefined,
    width: 240, onResize() {}, onCollapse() {}, ...overrides,
  };
  const { tree } = await render(extractFn(artifact, 'ExplorerRail'), props, railDeps);
  return { tree, props };
}

test('① 栏头：整行是一个 button，带 aria-expanded 与「收起文件树」名', async () => {
  const { tree } = await mountRail();
  const buttons = collect(tree, isButton);
  assert.equal(buttons.length, 1, `栏头只应有一颗交互按钮，实为 ${buttons.length}`);
  const header = buttons[0];
  assert.equal(header['aria-expanded'], true, 'aria-expanded 必须在位（AT 靠它读折叠态）');
  assert.equal(header['aria-label'], 'T:explorerCollapse', '无障碍名取 explorerCollapse');
  assert.equal(header.title, 'T:explorerCollapse', 'hover 提示与无障碍名同源');
  assert.equal(header.className, 'explorerRailHeader', '样式类不变（整行仍是那条 30px 头）');
  // 标题、图标、箭头都在这颗按钮内部，而不是散落在按钮外。
  const texts = collect(header, n => n.type === 'span');
  assert.ok(texts.some(n => n.className === 'explorerRailTitle'), '标题 span 在按钮内');
  assert.ok(collect(header, n => String(n.type?.name ?? '').startsWith('icon:')).length >= 2, '图标与箭头都在按钮内');
});

test('① 栏头：点标题任意处即触发折叠回调（旧形状只有箭头那颗小按钮带 onClick）', async () => {
  let collapsed = 0;
  const { tree } = await mountRail({ onCollapse: () => { collapsed += 1; } });
  click(collect(tree, isButton)[0]);
  assert.equal(collapsed, 1, '点击栏头必须调用 onCollapse');
});

test('① 栏头：不嵌套第二个交互元素（嵌套 button 是非法标记，键盘也走不到）', async () => {
  const { tree } = await mountRail();
  const header = collect(tree, isButton)[0];
  assert.equal(collect(header.children, isButton).length, 0, '按钮内部不得再出现 button');
});

test('① 折叠态：整块也是一个「展开文件树」按钮，点它回到展开', async () => {
  let expanded = 0;
  const { tree } = await render(
    extractFn(artifact, 'ExplorerRailCollapsed'),
    { onExpand: () => { expanded += 1; } },
    { _deepseek_ai_dsh_client_ui_primitives: primitives, t, sidebar_module_css_default: css },
  );
  const buttons = collect(tree, isButton);
  assert.equal(buttons.length, 1);
  assert.equal(buttons[0]['aria-label'], 'T:explorerExpand');
  click(buttons[0]);
  assert.equal(expanded, 1, '折叠条上的按钮必须调用 onExpand');
});

// ---------------------------------------------------------------------------
// ② 在本地打开
// ---------------------------------------------------------------------------

/** 一个宿主 open-in-app 替身：按真契约回 {id,name,icon,isDefault}，并记录 open 的入参。 */
function makeHandle(apps, outcome = () => Promise.resolve(true)) {
  const opened = [];
  return {
    opened,
    handle: {
      available: () => true,
      probe: () => Promise.resolve(true),
      directoryApps: () => Promise.resolve(apps),
      fileApps: () => Promise.resolve([]),
      open: (cwd, application) => { opened.push({ cwd, application }); return outcome(cwd, application); },
      reveal: () => Promise.resolve(true),
    },
  };
}

const entry = (id, name) => ({ id, name, icon: `icon:${id}`, isDefault: id === name });

async function mountOpenLocally(apps, overrides = {}) {
  const { handle, opened } = makeHandle(apps, overrides.outcome);
  const failures = [];
  const props = { cwd: '/abs/work', handle, onFailure: (message) => { failures.push(message); } };
  const { tree } = await render(extractFn(artifact, 'OpenLocallyButton'), props, {
    _deepseek_ai_dsh_client_ui_primitives: primitives, t, sidebar_module_css_default: css, IconButton: { name: 'IconButton' },
  });
  return { tree, opened, failures };
}

test('② 宿主清单为空（或探测未回）→ 整块不渲染，不给死行', async () => {
  const empty = await mountOpenLocally([]);
  assert.equal(empty.tree, null, '目录应用清单为空时必须不渲染');
});

test('② 主按钮：以清单首个应用打开工作区目录（目录靠 catalog id 启动）', async () => {
  const { tree, opened } = await mountOpenLocally([entry('explorer', '文件资源管理器'), entry('vscode', 'VS Code')]);
  const primary = collect(tree, n => n.type.name === 'IconButton')[0];
  assert.equal(primary.label, 'T:openLocally', '主按钮名取 openLocally');
  click(primary);
  assert.deepEqual(opened, [{ cwd: '/abs/work', application: 'explorer' }]);
});

test('② 箭头菜单：列全宿主 catalog，选中即按该应用打开并收起', async () => {
  const { tree, opened } = await mountOpenLocally([entry('explorer', '文件资源管理器'), entry('vscode', 'VS Code')]);
  const menu = collect(tree, n => n.type === primitives.Menu)[0];
  assert.ok(menu !== undefined, '外层必须是内核 Menu 原语（不自绘弹层）');
  assert.deepEqual(menu.items.map(i => i.id), ['explorer', 'vscode'], '菜单项 = 宿主 catalog 原样');
  assert.equal(menu.align, 'end');
  const chevron = collect(tree, n => n.type.name === 'IconButton')[1];
  assert.equal(chevron.label, 'T:openLocallyMore');
  click(chevron);
  menu.onSelect('vscode');
  assert.deepEqual(opened, [{ cwd: '/abs/work', application: 'vscode' }]);
});

test('② 只有一个可用应用时不出箭头（没有可选，就不给多余控件）', async () => {
  const { tree } = await mountOpenLocally([entry('explorer', '文件资源管理器')]);
  assert.equal(collect(tree, n => n.type.name === 'IconButton').length, 1);
});

test('② 宿主说打不开（false 或抛错）→ 走 onFailure 报 openLocallyFailed', async () => {
  const refused = await mountOpenLocally([entry('explorer', '文件资源管理器')], { outcome: () => Promise.resolve(false) });
  click(collect(refused.tree, n => n.type.name === 'IconButton')[0]);
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(refused.failures, ['T:openLocallyFailed'], '失败必须报出来，不能静默');

  const threw = await mountOpenLocally([entry('explorer', '文件资源管理器')], { outcome: () => Promise.reject(new Error('boom')) });
  click(collect(threw.tree, n => n.type.name === 'IconButton')[0]);
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(threw.failures, ['T:openLocallyFailed'], '抛错同样落到同一条提示');
});

test('② 挂载条件：工具条只在 cwd 与 openInApp 都在位时挂这颗按钮', () => {
  const src = fs.readFileSync(TREE_PANEL_SRC, 'utf8').replace(/\r\n/g, '\n');
  assert.match(
    src,
    /cwd !== undefined && openInApp !== undefined && \(\s*<OpenLocallyButton/,
    'TreePanel 的挂载点必须带两个前置条件（缺一个就是死按钮）',
  );
  assert.match(src, /openHint !== ''/, '失败提示要有落点（否则 onFailure 无人接）');
});

test('② 文案在册：zh 与 en 双字典都补齐三把键', () => {
  const src = fs.readFileSync(LOCALES_SRC, 'utf8').replace(/\r\n/g, '\n');
  const zhBlock = src.slice(src.indexOf('export const zh = {'), src.indexOf('export const en:'));
  const enBlock = src.slice(src.indexOf('export const en:'));
  for (const key of ['openLocally', 'openLocallyMore', 'openLocallyFailed']) {
    assert.ok(zhBlock.includes(`${key}: '`), `zh 缺 ${key}`);
    assert.ok(enBlock.includes(`${key}: '`), `en 缺 ${key}（en 是 Record<keyof typeof zh>，漏键 tsc 直接红）`);
  }
});

test('产物形状：src 的两处改动都进了发行字节（lib 不是手改副本）', () => {
  assert.ok(artifact.includes('//#region src/client/ExplorerRail.tsx'), 'ExplorerRail 区段标记在位');
  assert.ok(artifact.includes('//#region src/client/TreePanel.tsx'), 'TreePanel 区段标记在位');
  assert.ok(artifact.includes('"aria-expanded": true'), '折叠开关进了产物');
  assert.ok(artifact.includes('function OpenLocallyButton'), '在本地打开进了产物');
  assert.ok(artifact.includes('openLocally: "在本地打开"'), '中文文案进了产物');
});

// ---------------------------------------------------------------------------
// 反证：判据必须随实现变形，否则上面的用例在为不存在的守卫作证
// ---------------------------------------------------------------------------

/** 跑一条变异：把 from 换成 to 后重渲染，断言指定判据按预期失败。 */
async function mutate(name, fnSource, from, to, run) {
  assert.ok(fnSource.includes(from), `变异 #${name} 的锚点没命中：${from.slice(0, 40)}`);
  const broken = fnSource.replace(from, to);
  assert.notEqual(broken, fnSource, `变异 #${name} 未改动任何字节`);
  await run(broken);
}

test('反证 1：open(cwd) 丢掉 catalog id → 主按钮不再按应用打开（目录启动靠的就是它）', async () => {
  const original = extractFn(artifact, 'OpenLocallyButton');
  await mutate(1, original, 'run(primary.id)', 'run(undefined)', async (broken) => {
    const { handle, opened } = makeHandle([entry('explorer', '文件资源管理器')]);
    const { tree } = await render(broken, { cwd: '/abs/work', handle, onFailure() {} }, {
      _deepseek_ai_dsh_client_ui_primitives: primitives, t, sidebar_module_css_default: css, IconButton: { name: 'IconButton' },
    });
    click(collect(tree, n => n.type.name === 'IconButton')[0]);
    assert.deepEqual(opened, [{ cwd: '/abs/work', application: undefined }], '变异必须现形：application 丢了');
  });
});

test('反证 2：摘掉「清单为空即不渲染」→ 死行回来了', async () => {
  const original = extractFn(artifact, 'OpenLocallyButton');
  await mutate(2, original, 'if (primary === void 0) return null;', '', async (broken) => {
    const { handle } = makeHandle([]);
    const { tree } = await render(broken, { cwd: '/abs/work', handle, onFailure() {} }, {
      _deepseek_ai_dsh_client_ui_primitives: primitives, t, sidebar_module_css_default: css, IconButton: { name: 'IconButton' },
    });
    assert.notEqual(tree, null, '变异后空清单仍渲染了元素（原判据因此有效）');
  });
});

test('反证 3：摘掉 aria-expanded → 折叠态对 AT 不可见', async () => {
  const original = extractFn(artifact, 'ExplorerRail');
  await mutate(3, original, '"aria-expanded": true,', '', async (broken) => {
    const { tree } = await render(broken, {
      sessionId: 's1', cwd: '/abs/work', expanded: [], revealed: [], visible: true,
      onToggleDir() {}, onOpenFile() {}, onOpenFileNewTab() {}, onOpenFileSide() {},
      openInApp: {}, openWithTargets: [], openWithPinned: [], openWithSsh: false,
      openWithShowPluginTargets: false, onOpenWith() {}, onToggleOpenWithPin() {},
      onReferenceFile() {}, onPathRenamed() {}, onPathDeleted() {}, service: undefined,
      width: 240, onResize() {}, onCollapse() {},
    }, railDeps);
    assert.notEqual(collect(tree, isButton)[0]['aria-expanded'], true, '变异后 aria-expanded 确实没了');
  });
});

test('反证 4：把 onCollapse 换成空函数 → 整行点击不复盘到状态', async () => {
  const original = extractFn(artifact, 'ExplorerRail');
  await mutate(4, original, 'onClick: onCollapse,', 'onClick: () => {},', async (broken) => {
    let collapsed = 0;
    const { tree } = await render(broken, {
      sessionId: 's1', cwd: '/abs/work', expanded: [], revealed: [], visible: true,
      onToggleDir() {}, onOpenFile() {}, onOpenFileNewTab() {}, onOpenFileSide() {},
      openInApp: {}, openWithTargets: [], openWithPinned: [], openWithSsh: false,
      openWithShowPluginTargets: false, onOpenWith() {}, onToggleOpenWithPin() {},
      onReferenceFile() {}, onPathRenamed() {}, onPathDeleted() {}, service: undefined,
      width: 240, onResize() {}, onCollapse: () => { collapsed += 1; },
    }, railDeps);
    click(collect(tree, isButton)[0]);
    assert.equal(collapsed, 0, '变异后点击确实不再触达 onCollapse');
  });
});

test('反证 5：jsx 里的 false 分支不产元素（挂载条件被摘掉时元素数会变）', async () => {
  // 渲染器把 children 里的 false/null 过滤掉，所以「items.length > 1 && jsx(...)」
  // 为假时确实少一个元素——反证 ②「只有一个应用不出箭头」那条不是空断言。
  const original = extractFn(artifact, 'OpenLocallyButton');
  await mutate(5, original, 'items.length > 1 &&', 'true &&', async (broken) => {
    const { handle } = makeHandle([entry('explorer', '文件资源管理器')]);
    const { tree } = await render(broken, { cwd: '/abs/work', handle, onFailure() {} }, {
      _deepseek_ai_dsh_client_ui_primitives: primitives, t, sidebar_module_css_default: css, IconButton: { name: 'IconButton' },
    });
    assert.equal(collect(tree, n => n.type.name === 'IconButton').length, 2, '变异后单应用也出箭头');
  });
});
