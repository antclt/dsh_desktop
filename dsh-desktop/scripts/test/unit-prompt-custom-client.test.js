'use strict';

// unit-prompt-custom-client.test.js — dsh-prompt-custom 页内半边（lib/client.js）回归套件。
//
// 由来与 host 套件相同：交接包里的 repro-client.mjs 用 jsdom 真挂载，但验证台脚本没随包交付、
// 本机也没有 F: 那台机器；本机**没有 jsdom / happy-dom / react-test-renderer**（也不许凭空
// 增设依赖）。所以这里的挂载是「mini 钩子驱动」：用仓库里真实的 React 18 + react/jsx-runtime，
// 通过 React 内部 dispatcher 槽位手驱 useState/useRef/useCallback/useEffect，直接把真实
// client 源码里的 Card 组件跑起来（fetch 走 mock）。内核设计系统原语
// （@deepseek-ai/dsh-client-ui-primitives）用**同名同数量的桩**替身：元素按 props 驱动
// （onChange / onClick / onToggle 直调），不展开、不渲染 —— 名字与真包导出的核对见
// 「原语名字交叉核对」用例。证据强度记为「真实插件源码 + 复刻渲染夹具（非浏览器语义，
// 仅本组件用到的钩子面）」——不冒充浏览器实测。
//
// 覆盖（0.5.0「卡片即提示词」）：模块加载契约 / 首渲染不抛 / statusLine 三态（含挂载级
// 「跨版本不谎报」）/ 版本错配顶部告警 / 开关即时生效（只写已保存正文）与失败回滚 /
// 变量告警 / 卡片芯片渲染与当前高亮 / 干净点芯片＝一次 POST 不碰卡片集 / dirty 三选
// （取消不动 / 丢弃并切 / 保存到当前卡并切 / 无当前卡时另存为卡片并切）/ 保存写回当前卡
// （按钮写明目标）/ 无当前卡时纯保存 / 还原改动 / 新建卡片成为当前生效 / 改名 / 删除
// （删当前卡后正文留在原地）/ stale 宿主卡片区门控 / 原语名字交叉核对 / 协议配对。
// 未覆盖（需要真 DOM）：真事件冒泡、真滚动布局、真 fetch 网络栈 —— 属 repro-client.mjs 的
// 能力面，本机无法复现，如实留档。
//
// 反证：见文件末尾 —— ①去掉 statusLine 的「armed/injected 均未知则不作声」守卫；
// ②去掉点芯片前的「未保存改动先处置」守卫；判据都必须变红。

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const React = require('react');
const jsxRuntime = require('react/jsx-runtime');

const DSH = path.resolve(__dirname, '..', '..');
const CLIENT_FILE = path.join(DSH, 'assets', 'plugins', 'dsh-prompt-custom', 'lib', 'client.js');
const PKG_FILE = path.join(DSH, 'assets', 'plugins', 'dsh-prompt-custom', 'package.json');
const HOST_FILE = path.join(DSH, 'assets', 'plugins', 'dsh-prompt-custom', 'lib', 'index.js');

const CONFIG_URL = '/api/dsh-prompt-custom/config';
const PREVIEW_URL = '/api/dsh-prompt-custom/preview';
const PRIMITIVES_MODULE = '@deepseek-ai/dsh-client-ui-primitives';

// client 从真包引入的原语清单（「原语名字交叉核对」按这份断言；改 client 引入要同步这里）。
const PRIMITIVES_USED = [
  'Button', 'Switch', 'SegmentedControl', 'Input', 'Pill', 'Tag', 'DisclosureRow',
  'IconPlusOutlineRegular', 'IconChevronDownOutlineRegular'
];

/** 内核原语桩：同名、身份互异（测试按 el.type === P.X 定位元素）。 */
function makePrimitivesStub() {
  const P = {};
  for (const name of PRIMITIVES_USED) {
    const fn = function () { return null; };
    Object.defineProperty(fn, 'name', { value: name });
    P[name] = fn;
  }
  return P;
}

/** client 的 require 契约：只许 react / react/jsx-runtime / 内核原语包，多一个都算违约。 */
const fakeRequireFor = (P) => (name) => {
  if (name === 'react') return React;
  if (name === 'react/jsx-runtime') return jsxRuntime;
  if (name === PRIMITIVES_MODULE) return P;
  throw new Error('client 不得 require 模块：' + name);
};

// ---------------------------------------------------------------------------
// 加载真实 client 源码（vm，window.__ModuleLoader__ 捕获）
// ---------------------------------------------------------------------------

/**
 * 在 vm 里执行 client.js，拿到模块工厂。
 * @param opts.exposeInternals 追加一行 `exports.__test = { statusLine, L, suggestName };`（仅内存副本，
 *   不动仓库文件）——这些是闭包内部名，不透出就只能复述实现，那还不如不透出。
 */
function evalClient(opts = {}) {
  let src = fs.readFileSync(CLIENT_FILE, 'utf8');
  if (opts.exposeInternals) {
    assert.ok(src.includes('exports.inject = inject;'), '内部导出锚点必须存在（client.js 形状变了要同步本套件）');
    src = src.replace('exports.inject = inject;', 'exports.inject = inject;\n    exports.__test = { statusLine, L, suggestName };');
  }
  const sandbox = {
    window: { __ModuleLoader__: { load(mod) { sandbox.__loaded = mod; } } },
    console,
    // vm 沙箱没有 fetch：转发到宿主 global（mock 由 mockFetch 在宿主换掉）
    fetch: (...args) => global.fetch(...args)
  };
  vm.runInNewContext(src, sandbox, { filename: 'dsh-prompt-custom-client.js' });
  const loaded = sandbox.__loaded;
  assert.ok(loaded && typeof loaded.factory === 'function', 'client.js 必须经 __ModuleLoader__.load 注册 factory');
  const P = makePrimitivesStub();
  return { loaded, exports: loaded.factory(fakeRequireFor(P)), P };
}

// ---------------------------------------------------------------------------
// mini 钩子驱动：够本组件用（useState / useRef / useCallback / useEffect）
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
    useRef(init) {
      const i = cursor++;
      if (!(i in cells)) cells[i] = { value: { current: init } };
      return cells[i].value;
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
    },
    useLayoutEffect(fn, deps) { return hooks.useEffect(fn, deps); }
  };

  const render = () => {
    cursor = 0;
    const prev = slot.current;
    slot.current = hooks;
    try { tree = Component(props); } finally { slot.current = prev; }
    return tree;
  };

  const flushEffects = () => {
    for (const fn of pendingEffects.splice(0)) fn();
  };

  /** 渲染 → 跑新 effect → 等异步流沉降 → 若有 setState 再渲染，直到稳定（有界）。 */
  const settle = async (rounds = 12) => {
    for (let i = 0; i < rounds; i++) {
      scheduled = false;
      render();
      flushEffects();
      await new Promise((r) => setTimeout(r, 1));
      if (!scheduled && pendingEffects.length === 0) break;
    }
    return tree;
  };

  return { settle, deep: () => tree };
}

// ---- React 元素树小工具 ----
function textAll(node) {
  if (node === null || node === undefined || typeof node === 'boolean') return '';
  if (typeof node === 'string' || typeof node === 'number') return String(node);
  if (Array.isArray(node)) return node.map(textAll).join('');
  if (typeof node === 'object' && node.props) return textAll(node.props.children);
  return '';
}
function collect(node, out = []) {
  if (node === null || node === undefined || typeof node === 'boolean') return out;
  if (Array.isArray(node)) { node.forEach((n) => collect(n, out)); return out; }
  if (typeof node !== 'object' || !node.props) return out;
  out.push(node);
  collect(node.props.children, out);
  return out;
}
/** 按可见文本找元素（元素自身子树文本 === 期望值）。 */
const byText = (tree, text) => collect(tree).find((el) => textAll(el) === text) || null;
const byTextIncludes = (tree, text) => collect(tree).find((el) => textAll(el).includes(text)) || null;
/** 类型 + 文本双锚定（原语桩按 el.type === P.X 定位；文本可省略）。 */
const elOf = (tree, type, text) => collect(tree)
  .find((el) => el.type === type && (text === undefined || textAll(el) === text)) || null;
/** 芯片：Pill 且文本 === 卡片名（或虚芯片「当前正文」）。 */
const chipOf = (tree, P, name) => elOf(tree, P.Pill, name);
/** 从模块里取出 Card 组件（apply → slots.register 的 render 回调 → jsx(Card) → type）。 */
function cardOf(exports) {
  let render = null;
  exports.apply({ slots: { inject(n, cb) { cb(); }, register(spec, r) { render = r; } } });
  assert.ok(typeof render === 'function', 'client 必须注册 settings.section 渲染回调');
  return render({}).type;
}

// ---------------------------------------------------------------------------
// fetch mock
// ---------------------------------------------------------------------------

function mockFetch(t, handler) {
  const prev = global.fetch;
  const calls = [];
  global.fetch = async (url, opts = {}) => {
    calls.push({ url: String(url), method: opts.method || 'GET', body: opts.body ? JSON.parse(opts.body) : null });
    return handler(String(url), opts, calls.length - 1);
  };
  t.after(() => { global.fetch = prev; });
  return calls;
}
const jsonResponse = (body, ok = true, status = 200) => ({ ok, status, json: async () => body });

const CONFIG_OK = {
  ok: true,
  config: { enabled: true, mode: 'append', text: 'SAVED-TEXT', cards: [] },
  proto: 3,
  armed: true,
  injected: 2,
  lastError: null,
  unknownConfigKeys: [],
  unknownVariables: [],
  malformedVariables: [],
  path: 'X'
};

/** 默认路由：config GET/POST 与 preview 都按可配置 payload 应答。 */
function defaultHandler(t, over = {}) {
  // 卡片集按「服务端真状态」跟踪：POST 带 cards → 落库；不带 → 保持上一次的。
  // 若像先前那样每次回退到初始 fixture，删卡后的一次无 cards POST 会把删掉的卡复活。
  const state = { cards: ((over.config || CONFIG_OK).config || {}).cards || [] };
  return mockFetch(t, (url, opts) => {
    if (url === CONFIG_URL) {
      if ((opts.method || 'GET') === 'POST') {
        if (over.postBody) return jsonResponse(over.postBody);
        const sent = JSON.parse(opts.body);
        if (Array.isArray(sent.cards)) state.cards = sent.cards;
        return jsonResponse({
          ...CONFIG_OK,
          config: {
            enabled: !!sent.enabled,
            mode: sent.mode === 'replace' ? 'replace' : 'append',
            text: String(sent.text || ''),
            cards: state.cards
          }
        });
      }
      return jsonResponse(over.config || CONFIG_OK);
    }
    if (url === PREVIEW_URL) return jsonResponse(over.preview || { ok: true, text: 'PREVIEW-TEXT', proto: 3 });
    return jsonResponse({ ok: false, message: 'unexpected url ' + url }, false, 404);
  });
}

const editorOf = (tree) => collect(tree).find((el) => el.type === 'textarea' && el.props.readOnly !== true) || null;
const previewBoxOf = (tree) => collect(tree).find((el) => el.type === 'textarea' && el.props.readOnly === true) || null;
const postCalls = (calls) => calls.filter((c) => c.url === CONFIG_URL && c.method === 'POST');

const CARDS = [
  { id: 'c-one', name: '卡片甲', text: 'SAVED-TEXT' },
  { id: 'c-two', name: '卡片乙', text: 'PERSONA-B' }
];
const cfgWithCards = (over = {}) => ({ ...CONFIG_OK, config: { ...CONFIG_OK.config, cards: CARDS }, ...over });

// ---------------------------------------------------------------------------
// 1. 模块加载契约
// ---------------------------------------------------------------------------

test('模块加载契约：注册 id 与包名一致、apply/inject 形状、settings.section 槽位注册参数', (t) => {
  const pkg = JSON.parse(fs.readFileSync(PKG_FILE, 'utf8'));
  const { loaded, exports } = evalClient();

  assert.equal(loaded.id, pkg.name, 'loader id 必须等于包名（内核按 id 装载）');
  assert.equal(typeof exports.apply, 'function');
  assert.deepEqual([...exports.inject], ['slots'], 'inject 必须声明 slots');

  const bets = [];
  const fakeCtx = {
    slots: {
      inject(name, cb) { bets.push(['inject', name]); cb(); },
      register(spec, render) { bets.push(['register', spec, render]); return () => {}; }
    }
  };
  exports.apply(fakeCtx);
  assert.deepEqual(bets[0], ['inject', 'settings.section'], '必须经 settings.section 槽注入');
  const [kind, spec, render] = bets[1];
  assert.equal(kind, 'register');
  assert.equal(spec.name, 'settings.section');
  assert.equal(spec.id, 'dsh-prompt-custom');
  assert.equal(spec.order, 60);
  assert.equal(spec.label(), '自定义提示词');
  const el = render({});
  assert.ok(el && typeof el.type === 'function', 'render 回调必须产出 Card 元素');
});

test('首渲染不抛：真实 React 下 Card 初始渲染为「加载中…」', async (t) => {
  const { exports } = evalClient({ exposeInternals: true });
  const specRender = (() => {
    let out = null;
    exports.apply({ slots: { inject(n, cb) { cb(); }, register(spec, render) { out = render; } } });
    return out;
  })();
  const el = specRender({});
  const html = require('react-dom/server').renderToStaticMarkup(el);
  assert.ok(html.includes(exports.__test.L.loading), '首渲染应显示加载中，且不得抛');
});

// ---------------------------------------------------------------------------
// 2. statusLine 三态（0.3.0 起的「状态要么真实、要么沉默」）
// ---------------------------------------------------------------------------

test('statusLine：lastError > 未知字段沉默 > 停用 > armed > 已注入', async (t) => {
  const { exports } = evalClient({ exposeInternals: true });
  const { statusLine, L } = exports.__test;
  // statusLine 的返回值是 vm 域的普通对象：先搬进宿主域再断言（否则 deepStrictEqual 比原型必红）
  const norm = (s) => (s === null ? null : { text: String(s.text), tone: String(s.tone) });

  assert.equal(statusLine(undefined), null, '无 payload 时不得编状态');
  assert.equal(statusLine({}), null, 'armed/injected 均未知（旧宿主）必须沉默——宁可不显示也不谎报「已停用」');

  assert.deepEqual(norm(statusLine({ lastError: 'boom' })), { text: L.stError('boom'), tone: 'error' }, 'lastError 优先级最高');
  assert.deepEqual(norm(statusLine({ armed: false, injected: 0 })), { text: L.stOff, tone: 'muted' });
  assert.deepEqual(norm(statusLine({ armed: true, injected: 0 })), { text: L.stArmed, tone: 'muted' });
  assert.deepEqual(norm(statusLine({ armed: true, injected: 3 })), { text: L.stInjected(3), tone: 'ok' });
  assert.equal(statusLine({ armed: true, injected: 3, lastError: 'x' }).tone, 'error', 'lastError 压过一切');
});

test('suggestName：取第一行、去标题符号、截 24 字符、空文本按序号兜底', (t) => {
  const { exports } = evalClient({ exposeInternals: true });
  const { suggestName } = exports.__test;
  assert.equal(suggestName('# 标题行\n正文', 0), '标题行', '应跳过标题符号、取第一行有效内容');
  assert.equal(suggestName('\n\n  第二行有效 ', 3), '第二行有效', '空行跳过、首尾空白裁掉');
  assert.equal(suggestName('X'.repeat(40), 0), 'X'.repeat(24), '超长截 24 字符');
  assert.equal(suggestName('', 4), '提示词卡 5', '无内容按序号兜底（count+1）');
});

// ---------------------------------------------------------------------------
// 3. 挂载后的交互（mini 钩子驱动）
// ---------------------------------------------------------------------------

test('版本错配（正/反例）：告警在头部、proto=3 沉默；旧宿主缺字段时不谎报状态', async (t) => {
  const { exports, P } = evalClient({ exposeInternals: true });
  const { L } = exports.__test;
  const card = cardOf(exports);

  // 反例：proto=3 不出现告警，状态 Tag 用真实字段
  defaultHandler(t, {});
  const good = createMounter(card, {});
  let tree = await good.settle();
  assert.equal(byTextIncludes(tree, L.staleHost), null, 'proto=3 不得误报版本错配');
  assert.ok(elOf(tree, P.Tag, L.stInjected(2)), '状态应以 Tag 如实呈现');

  // 正例：像真旧宿主那样根本没有 armed/injected 字段 + proto=2 → 顶部告警、且不得谎报「已停用」
  const legacy = {
    ok: true,
    config: { enabled: true, mode: 'append', text: 'SAVED-TEXT', cards: [] },
    proto: 2,
    path: 'X'
  };
  defaultHandler(t, { config: legacy });
  const bad = createMounter(card, {});
  tree = await bad.settle();
  const doc = textAll(tree);
  const atWarn = doc.indexOf(L.staleHost);
  const atSub = doc.indexOf(L.sub);
  const atHint = doc.indexOf(L.enabledHint);
  assert.ok(atWarn >= 0, 'proto≠3 必须给出醒目提示');
  assert.ok(atSub >= 0 && atHint >= 0, '位置参照物必须在场');
  assert.ok(atSub < atWarn && atWarn < atHint, '告警必须排在副标题之后、正文控件之前（页面头部）');
  assert.equal(
    collect(tree).filter((el) => el.type === P.Tag && textAll(el).includes(L.stOff)).length, 0,
    '旧宿主缺 armed/injected 时不得谎报「已停用」（跨版本不骗人）'
  );
});

test('预览：默认收起不拉取；展开懒加载 official（旧宿主退化为 text）；切段取 effective', async (t) => {
  const { exports, P } = evalClient({ exposeInternals: true });
  const { L } = exports.__test;
  const card = cardOf(exports);

  const calls = defaultHandler(t, { preview: { ok: true, text: 'LEGACY-TEXT', proto: 2 } });
  const m = createMounter(card, {});
  let tree = await m.settle();

  // 默认收起：children 为空，且未发生 preview 拉取
  const row0 = elOf(tree, P.DisclosureRow);
  assert.ok(row0, '预览区必须是可折叠行（DisclosureRow）');
  assert.equal(row0.props.expandOnRowClick, true, '整行可点才展开（原语默认 false 只剩行首小箭头，难发现）');
  assert.equal(row0.props.children, null, '默认应收起');
  assert.equal(calls.filter((c) => c.url === PREVIEW_URL).length, 0, '收起时不拉取预览');

  // 展开 → 懒加载一次；旧宿主没有 official/effective 字段 → 退化为 data.text
  await row0.props.onToggle();
  tree = await m.settle();
  assert.equal(calls.filter((c) => c.url === PREVIEW_URL).length, 1, '展开时拉取一次');
  const box = previewBoxOf(tree);
  assert.ok(box, '预览框应出现');
  assert.equal(box.props.value, 'LEGACY-TEXT', '旧接口缺 official/effective 时退化为 data.text');
  assert.notEqual(box.props.value, '(空)', '不得显示空框');

  // 切「实际生效」：走新 mock，official/effective 分开取
  defaultHandler(t, { preview: { ok: true, official: 'OFFICIAL-FULL', effective: 'EFFECTIVE-FULL', text: 'COMPAT', proto: 3 } });
  const seg = collect(m.deep()).find((el) => el.type === P.SegmentedControl && el.props.id === 'dsh-prompt-custom-preview');
  assert.ok(seg, '展开后应有 official/effective 分段控件');
  await seg.props.onChange('effective');
  tree = await m.settle();
  assert.equal(previewBoxOf(tree).props.value, 'EFFECTIVE-FULL', '切到「实际生效」应显示 effective');
  assert.equal(byTextIncludes(tree, L.staleHost), null, 'proto=3 的预览回应应解除错配告警');

  // 切回「官方全文」
  const seg2 = collect(tree).find((el) => el.type === P.SegmentedControl && el.props.id === 'dsh-prompt-custom-preview');
  await seg2.props.onChange('official');
  tree = await m.settle();
  assert.equal(previewBoxOf(tree).props.value, 'OFFICIAL-FULL', '官方全文用 official 字段');
});

test('开关即时生效：POST 只用已保存正文、不碰卡片集；未保存编辑保持不动、Tag 在场', async (t) => {
  const { exports, P } = evalClient({ exposeInternals: true });
  const { L } = exports.__test;
  const card = cardOf(exports);

  const calls = defaultHandler(t, {});
  const m = createMounter(card, {});
  let tree = await m.settle();

  // 编辑正文（不保存）
  editorOf(tree).props.onChange({ target: { value: 'UNSAVED-EDIT' } });
  tree = await m.settle();
  assert.ok(elOf(tree, P.Tag, L.dirtyTag), '未保存时应出现「未保存」Tag');

  // 关开关 → 立即 POST，且正文必须是「已保存」的那份、不带 cards 键
  const sw = elOf(tree, P.Switch);
  assert.equal(sw.props.checked, true);
  await sw.props.onChange(false);
  tree = await m.settle();

  const posts = postCalls(calls);
  assert.equal(posts.length, 1, '开关变化应立即 POST 一次（无需点保存）');
  assert.equal(posts[0].body.enabled, false);
  assert.equal(posts[0].body.text, 'SAVED-TEXT', '开关操作不得把未保存编辑偷偷写进去');
  assert.equal(posts[0].body.cards, undefined, '开关操作不碰卡片集（不带 cards 键）');
  assert.equal(elOf(tree, P.Switch).props.checked, false, '成功回应后开关落到新状态');
  assert.ok(elOf(tree, P.Tag, L.dirtyTag), '开关操作后未保存编辑仍在、Tag 仍在');
  assert.equal(editorOf(tree).props.value, 'UNSAVED-EDIT');
});

test('POST 失败：开关拨回服务端真实状态并显示错误（界面绝不显示未生效的开关）', async (t) => {
  const { exports, P } = evalClient({ exposeInternals: true });
  const { L } = exports.__test;
  const card = cardOf(exports);

  defaultHandler(t, { postBody: { ok: false, message: 'CONFIG-HTTP-500' } });
  const m = createMounter(card, {});
  let tree = await m.settle();

  await elOf(tree, P.Switch).props.onChange(false);
  tree = await m.settle();

  assert.equal(elOf(tree, P.Switch).props.checked, true, 'POST 失败必须把开关拨回真实状态');
  assert.ok(byTextIncludes(tree, 'CONFIG-HTTP-500'), '失败原因应显示在界面上');
});

test('变量告警与陌生配置键进入 UI（{{name}} 加花括号显示）', async (t) => {
  const { exports } = evalClient({ exposeInternals: true });
  const { L } = exports.__test;
  const card = cardOf(exports);

  defaultHandler(t, {
    config: {
      ...CONFIG_OK,
      unknownVariables: ['nope_unknown'],
      malformedVariables: ['Bad.Name'],
      unknownConfigKeys: ['futureField']
    }
  });
  const m = createMounter(card, {});
  const tree = await m.settle();

  assert.ok(byTextIncludes(tree, '{{nope_unknown}}'), '未知变量应显示为 {{name}}');
  assert.ok(byTextIncludes(tree, '{{Bad.Name}}'), '畸形变量应显示为 {{name}}');
  assert.ok(byTextIncludes(tree, 'futureField'), '陌生配置键应显示');
});

// ---------------------------------------------------------------------------
// 4. 提示词卡（0.5.0「卡片即提示词」）
// ---------------------------------------------------------------------------

test('卡片芯片渲染：名字在场、当前卡高亮、正文行给出归属；空态不渲染芯片', async (t) => {
  const { exports, P } = evalClient({ exposeInternals: true });
  const { L } = exports.__test;
  const card = cardOf(exports);

  defaultHandler(t, { config: cfgWithCards() });
  const m = createMounter(card, {});
  const tree = await m.settle();

  const chipA = chipOf(tree, P, '卡片甲');
  const chipB = chipOf(tree, P, '卡片乙');
  assert.ok(chipA && chipB, '两张卡都应是芯片（Pill）');
  assert.equal(chipA.props.active, true, '正文 === 卡片甲文本 → 甲高亮');
  assert.equal(chipB.props.active, false, '乙不高亮');
  assert.equal(chipOf(tree, P, L.cardsVirtual), null, '有当前卡时不出现「当前正文」虚芯片');
  assert.ok(byTextIncludes(tree, L.cardsCurrent('卡片甲', 'SAVED-TEXT'.length)), '正文行应标出当前卡与字数');
  assert.equal(byTextIncludes(tree, L.cardsEmpty), null, '有卡片时不显示空态');
  assert.ok(byText(tree, L.cardsRename), '当前卡应有「改名」行内入口');
  assert.ok(byText(tree, L.cardsRemove), '当前卡应有「删除」行内入口');
});

test('干净点芯片：一次 POST 切换生效、不碰卡片集；高亮与提示随迁移', async (t) => {
  const { exports, P } = evalClient({ exposeInternals: true });
  const { L } = exports.__test;
  const card = cardOf(exports);

  const calls = defaultHandler(t, { config: cfgWithCards() });
  const m = createMounter(card, {});
  let tree = await m.settle();

  await chipOf(tree, P, '卡片乙').props.onClick();
  tree = await m.settle();

  const posts = postCalls(calls);
  assert.equal(posts.length, 1, '干净编辑框下点芯片应直接 POST（无需确认）');
  assert.equal(posts[0].body.text, 'PERSONA-B', 'POST 的正文必须是该卡文本');
  assert.equal(posts[0].body.cards, undefined, '切换不重写卡片集（不带 cards 键）');
  assert.equal(editorOf(tree).props.value, 'PERSONA-B', '编辑框应同步为卡片文本');
  assert.equal(elOf(tree, P.Tag, L.dirtyTag), null, '切换生效后不应再有未保存 Tag');
  assert.equal(chipOf(tree, P, '卡片乙').props.active, true, '高亮应迁移到卡片乙');
  assert.equal(chipOf(tree, P, '卡片甲').props.active, false);
  assert.ok(byTextIncludes(tree, L.cardsNoteUsed('卡片乙')));
});

test('dirty 点芯片：先弹三选不直接切；取消一切不动；「丢弃改动并切换」落地', async (t) => {
  const { exports, P } = evalClient({ exposeInternals: true });
  const { L } = exports.__test;
  const card = cardOf(exports);

  const calls = defaultHandler(t, { config: cfgWithCards() });
  const m = createMounter(card, {});
  let tree = await m.settle();

  editorOf(tree).props.onChange({ target: { value: 'UNSAVED-X' } });
  tree = await m.settle();

  // 点乙 → 不触盘，先停下给三个出口
  await chipOf(tree, P, '卡片乙').props.onClick();
  tree = await m.settle();
  assert.equal(postCalls(calls).length, 0, '未处置前不得 POST');
  assert.ok(byTextIncludes(tree, L.cardsUseDirty), '应出现「先处置」面板');
  assert.ok(byText(tree, L.cardsSwitchSave('卡片甲')), '「保存到当前卡并切换」出口在场');
  assert.ok(byText(tree, L.cardsSwitchFork), '「另存为卡片并切换」出口在场');
  assert.ok(byText(tree, L.cardsSwitchDiscard), '「丢弃改动并切换」出口在场');

  // 取消 → 一切不动
  await byText(tree, L.cardsCancel).props.onClick();
  tree = await m.settle();
  assert.equal(postCalls(calls).length, 0, '取消后不得 POST');
  assert.equal(editorOf(tree).props.value, 'UNSAVED-X', '取消后编辑框必须原样保留');
  assert.equal(byTextIncludes(tree, L.cardsUseDirty), null, '取消后面板收起');
  assert.equal(chipOf(tree, P, '卡片乙').props.active, false, '取消后高亮不动');

  // 再点 → 丢弃改动并切换
  await chipOf(tree, P, '卡片乙').props.onClick();
  tree = await m.settle();
  await byText(tree, L.cardsSwitchDiscard).props.onClick();
  tree = await m.settle();
  const posts = postCalls(calls);
  assert.equal(posts.length, 1, '确认后才 POST');
  assert.equal(posts[0].body.text, 'PERSONA-B');
  assert.equal(posts[0].body.cards, undefined, '丢弃＝直接切，不动卡片集');
  assert.equal(editorOf(tree).props.value, 'PERSONA-B');
  assert.equal(chipOf(tree, P, '卡片乙').props.active, true);
});

test('dirty 点芯片·保存并切换：一次 POST 写回当前卡并完成切换', async (t) => {
  const { exports, P } = evalClient({ exposeInternals: true });
  const { L } = exports.__test;
  const card = cardOf(exports);

  const calls = defaultHandler(t, { config: cfgWithCards() });
  const m = createMounter(card, {});
  let tree = await m.settle();

  editorOf(tree).props.onChange({ target: { value: 'UNSAVED-Y' } });
  tree = await m.settle();
  await chipOf(tree, P, '卡片乙').props.onClick();
  tree = await m.settle();
  await byText(tree, L.cardsSwitchSave('卡片甲')).props.onClick();
  tree = await m.settle();

  const posts = postCalls(calls);
  assert.equal(posts.length, 1, '一次 POST 同时写回与切换');
  assert.equal(posts[0].body.text, 'PERSONA-B', '正文切到目标卡');
  assert.equal(posts[0].body.cards.length, 2, '卡片集不增删');
  assert.equal(posts[0].body.cards[0].id, 'c-one');
  assert.equal(posts[0].body.cards[0].text, 'UNSAVED-Y', '当前卡被编辑框内容写回');
  assert.equal(posts[0].body.cards[0].name, '卡片甲', '名字不动');
  assert.equal(posts[0].body.cards[1].text, 'PERSONA-B', '目标卡不动');
  assert.equal(editorOf(tree).props.value, 'PERSONA-B');
  assert.equal(chipOf(tree, P, '卡片乙').props.active, true, '切换后乙是当前卡');
  assert.ok(byTextIncludes(tree, L.cardsNoteSavedSwitched('卡片甲', '卡片乙')));
  assert.equal(elOf(tree, P.Tag, L.dirtyTag), null, '写回后无未保存');
});

test('无当前卡时 dirty 点芯片：「保存到某卡」无目标不给，另存为卡片并切换兜底', async (t) => {
  const { exports, P } = evalClient({ exposeInternals: true });
  const { L } = exports.__test;
  const card = cardOf(exports);

  const config = { ...CONFIG_OK, config: { ...CONFIG_OK.config, text: 'CUSTOM-TEXT', cards: CARDS } };
  const calls = defaultHandler(t, { config });
  const m = createMounter(card, {});
  let tree = await m.settle();

  // 正文不属于任何卡：虚芯片在场、无卡高亮
  assert.ok(chipOf(tree, P, L.cardsVirtual), '正文不属于任何卡时应给「当前正文」虚芯片');
  assert.equal(chipOf(tree, P, '卡片甲').props.active, false);
  assert.equal(chipOf(tree, P, '卡片乙').props.active, false);
  assert.ok(byTextIncludes(tree, L.cardsCurrentCustom('CUSTOM-TEXT'.length)), '正文行应说明未存入卡片');
  assert.equal(byText(tree, L.cardsRename), null, '没有当前卡则没有改名/删除入口');

  editorOf(tree).props.onChange({ target: { value: 'UNSAVED-Z' } });
  tree = await m.settle();
  await chipOf(tree, P, '卡片甲').props.onClick();
  tree = await m.settle();
  assert.equal(postCalls(calls).length, 0);
  assert.equal(byText(tree, L.cardsSwitchSave('卡片甲')), null, '没有当前卡就没有「保存到…」出口');
  assert.ok(byText(tree, L.cardsSwitchFork), '主出口应是「另存为卡片并切换」');

  await byText(tree, L.cardsSwitchFork).props.onClick();
  tree = await m.settle();
  const posts = postCalls(calls);
  assert.equal(posts.length, 1);
  assert.equal(posts[0].body.text, 'SAVED-TEXT', '切换目标＝卡片甲的文本');
  assert.equal(posts[0].body.cards.length, 3, '另存的新卡加入卡片集');
  const fork = posts[0].body.cards[2];
  assert.equal(fork.name, 'UNSAVED-Z', '新卡名取第一行建议');
  assert.equal(fork.text, 'UNSAVED-Z', '新卡内容是编辑框当前内容');
  assert.ok(/^c[a-z0-9]+$/.test(fork.id), 'id 形状应与 host 的 CARD_ID 校验配对');
  assert.equal(editorOf(tree).props.value, 'SAVED-TEXT');
  assert.equal(chipOf(tree, P, '卡片甲').props.active, true);
  assert.ok(byTextIncludes(tree, L.cardsNoteForkedSwitched('UNSAVED-Z', '卡片甲')));
});

test('保存写回当前卡：按钮写明目标、一次 POST 同步正文与卡片', async (t) => {
  const { exports, P } = evalClient({ exposeInternals: true });
  const { L } = exports.__test;
  const card = cardOf(exports);

  const calls = defaultHandler(t, { config: cfgWithCards() });
  const m = createMounter(card, {});
  let tree = await m.settle();

  assert.ok(byText(tree, L.saveTo('卡片甲')), '按钮应写明写回目标');
  editorOf(tree).props.onChange({ target: { value: 'NEW-BODY' } });
  tree = await m.settle();
  await byText(tree, L.saveTo('卡片甲')).props.onClick();
  tree = await m.settle();

  const posts = postCalls(calls);
  assert.equal(posts.length, 1);
  assert.equal(posts[0].body.text, 'NEW-BODY');
  assert.equal(posts[0].body.cards[0].text, 'NEW-BODY', '当前卡随正文同步');
  assert.equal(posts[0].body.cards[0].name, '卡片甲', '名字不动');
  assert.equal(posts[0].body.cards[1].text, 'PERSONA-B', '其他卡不动');
  assert.equal(elOf(tree, P.Tag, L.dirtyTag), null, '保存后无未保存');
  assert.ok(byTextIncludes(tree, L.savedToCard('卡片甲')));
  assert.equal(chipOf(tree, P, '卡片甲').props.active, true, '写回后甲仍是当前卡');
});

test('无当前卡时保存：按钮写「保存并生效」、不带 cards 键', async (t) => {
  const { exports, P } = evalClient({ exposeInternals: true });
  const { L } = exports.__test;
  const card = cardOf(exports);

  const config = { ...CONFIG_OK, config: { ...CONFIG_OK.config, text: 'CUSTOM-TEXT', cards: CARDS } };
  const calls = defaultHandler(t, { config });
  const m = createMounter(card, {});
  let tree = await m.settle();

  assert.ok(byText(tree, L.savePlain), '无当前卡时按钮不带目标名');
  editorOf(tree).props.onChange({ target: { value: 'NEW-2' } });
  tree = await m.settle();
  await byText(tree, L.savePlain).props.onClick();
  tree = await m.settle();

  const posts = postCalls(calls);
  assert.equal(posts.length, 1);
  assert.equal(posts[0].body.text, 'NEW-2');
  assert.equal(posts[0].body.cards, undefined, '没有当前卡就不碰卡片集');
  assert.ok(byTextIncludes(tree, L.saved));
});

test('还原改动：编辑框拉回已保存正文，不触盘', async (t) => {
  const { exports, P } = evalClient({ exposeInternals: true });
  const { L } = exports.__test;
  const card = cardOf(exports);

  const calls = defaultHandler(t, { config: cfgWithCards() });
  const m = createMounter(card, {});
  let tree = await m.settle();

  editorOf(tree).props.onChange({ target: { value: 'SCRATCH' } });
  tree = await m.settle();
  await byText(tree, L.revert).props.onClick();
  tree = await m.settle();
  assert.equal(postCalls(calls).length, 0, '还原不写盘');
  assert.equal(editorOf(tree).props.value, 'SAVED-TEXT');
  assert.equal(elOf(tree, P.Tag, L.dirtyTag), null);
  assert.equal(byText(tree, L.revert), null, '干净后不再显示还原按钮');
});

test('新建卡片：捕获编辑框内容（含未保存改动）并成为当前生效', async (t) => {
  const { exports, P } = evalClient({ exposeInternals: true });
  const { L } = exports.__test;
  const card = cardOf(exports);

  const calls = defaultHandler(t, {});
  const m = createMounter(card, {});
  let tree = await m.settle();

  // 空态在场（CONFIG_OK 无卡）
  assert.ok(byTextIncludes(tree, L.cardsEmpty));
  assert.equal(collect(tree).filter((el) => el.type === P.Pill).length, 0, '无卡时不渲染芯片');

  editorOf(tree).props.onChange({ target: { value: 'DRAFT-BODY' } });
  tree = await m.settle();

  // 打开新建面板 → 名字预填为第一行建议（编辑态内容）
  await byText(tree, L.cardsAdd).props.onClick();
  tree = await m.settle();
  const nameInput = elOf(tree, P.Input);
  assert.ok(nameInput, '新建面板应有名称输入框');
  assert.equal(nameInput.props.value, 'DRAFT-BODY', '名字应预填第一行建议');

  nameInput.props.onChange({ target: { value: '我的卡' } });
  tree = await m.settle();
  await byText(tree, L.cardsSave).props.onClick();
  tree = await m.settle();

  const posts = postCalls(calls);
  assert.equal(posts.length, 1, '存卡片应 POST 一次');
  assert.equal(posts[0].body.text, 'DRAFT-BODY', '新卡成为当前生效（正文随迁）');
  assert.equal(posts[0].body.cards.length, 1);
  assert.equal(posts[0].body.cards[0].name, '我的卡');
  assert.equal(posts[0].body.cards[0].text, 'DRAFT-BODY', '卡片存的必须是编辑框当前内容（含未保存改动）');
  assert.ok(/^c[a-z0-9]+$/.test(posts[0].body.cards[0].id), 'id 形状应与 host 的 CARD_ID 校验配对');

  assert.equal(byText(tree, L.cardsSave), null, '成功后新建面板应收起');
  assert.equal(chipOf(tree, P, '我的卡').props.active, true, '新卡即当前卡');
  assert.equal(elOf(tree, P.Tag, L.dirtyTag), null, '生效后无未保存');
  assert.ok(byTextIncludes(tree, L.cardsNoteAdded('我的卡')));
});

test('改名：只动名字，正文与卡片文本原样；名字裁空白后写入', async (t) => {
  const { exports, P } = evalClient({ exposeInternals: true });
  const { L } = exports.__test;
  const card = cardOf(exports);

  const calls = defaultHandler(t, { config: cfgWithCards() });
  const m = createMounter(card, {});
  let tree = await m.settle();

  await byText(tree, L.cardsRename).props.onClick();
  tree = await m.settle();
  const input = elOf(tree, P.Input);
  assert.ok(input, '改名面板应有输入框');
  assert.equal(input.props.value, '卡片甲', '输入框预填现名');

  input.props.onChange({ target: { value: ' 新甲 ' } });
  tree = await m.settle();
  await byText(tree, L.cardsRenameSave).props.onClick();
  tree = await m.settle();

  const posts = postCalls(calls);
  assert.equal(posts.length, 1);
  assert.equal(posts[0].body.text, 'SAVED-TEXT', '改名不动正文');
  assert.equal(posts[0].body.cards[0].name, '新甲', '名字已裁空白并写入');
  assert.equal(posts[0].body.cards[0].text, 'SAVED-TEXT', '卡文本不动');
  assert.equal(posts[0].body.cards[1].name, '卡片乙', '其他卡不动');
  assert.ok(chipOf(tree, P, '新甲'), '芯片显示新名字');
  assert.equal(chipOf(tree, P, '新甲').props.active, true, '改名不影响当前高亮');
  assert.ok(byTextIncludes(tree, L.cardsNoteRenamed('新甲')));
});

test('删除：行内确认后移除；删当前卡后正文留在原地（转为「当前正文」）', async (t) => {
  const { exports, P } = evalClient({ exposeInternals: true });
  const { L } = exports.__test;
  const card = cardOf(exports);

  const calls = defaultHandler(t, { config: cfgWithCards() });
  const m = createMounter(card, {});
  let tree = await m.settle();

  // 删当前卡（甲）：确认后移除，正文留在原地
  await byText(tree, L.cardsRemove).props.onClick();
  tree = await m.settle();
  assert.equal(postCalls(calls).length, 0, '删除要先确认');
  assert.ok(byTextIncludes(tree, L.cardsRemoveAsk('卡片甲')));
  await byText(tree, L.cardsRemoveConfirm).props.onClick();
  tree = await m.settle();

  let posts = postCalls(calls);
  assert.equal(posts.length, 1);
  assert.deepEqual(posts[0].body.cards.map((c) => c.id), ['c-two'], '只应删掉卡片甲');
  assert.equal(posts[0].body.text, 'SAVED-TEXT', '正文不随删除消失（留在原地）');
  assert.equal(chipOf(tree, P, '卡片甲'), null, '甲芯片消失');
  assert.ok(chipOf(tree, P, L.cardsVirtual), '正文不再属于任何卡 → 虚芯片「当前正文」');
  assert.ok(byTextIncludes(tree, L.cardsCurrentCustom('SAVED-TEXT'.length)));
  assert.ok(byTextIncludes(tree, L.cardsNoteRemoved('卡片甲')));
  assert.equal(byText(tree, L.cardsRename), null, '没有当前卡则没有改名/删除入口');

  // 删最后一张：先点乙切换（干净）→ 删除 → 空态
  await chipOf(tree, P, '卡片乙').props.onClick();
  tree = await m.settle();
  await byText(tree, L.cardsRemove).props.onClick();
  tree = await m.settle();
  await byText(tree, L.cardsRemoveConfirm).props.onClick();
  tree = await m.settle();
  posts = postCalls(calls);
  assert.equal(posts.length, 3, '切换 1 次 + 删除 2 次');
  assert.deepEqual(posts[2].body.cards, []);
  assert.ok(byTextIncludes(tree, L.cardsEmpty), '删空后应显示空态提示');
  assert.equal(collect(tree).filter((el) => el.type === P.Pill).length, 0, '空态无芯片');
});

test('stale 宿主（proto≠3）：卡片区门控在处理器里（直调也不触盘）；正文保存不受连坐', async (t) => {
  const { exports, P } = evalClient({ exposeInternals: true });
  const { L } = exports.__test;
  const card = cardOf(exports);

  const calls = defaultHandler(t, { config: cfgWithCards({ proto: 2 }) });
  const m = createMounter(card, {});
  let tree = await m.settle();

  assert.ok(byTextIncludes(tree, L.staleHost), '顶部应有版本错配告警');
  assert.ok(byTextIncludes(tree, L.cardsStale), '卡片区应说明「重启后可用」的原因');

  // 外观上全部禁用
  assert.equal(byText(tree, L.cardsAdd).props.disabled, true, '新建按钮应禁用');
  const chips = collect(tree).filter((el) => el.type === P.Pill);
  assert.equal(chips.length, 2, '两张卡都应渲染出来（禁用而非消失）');
  for (const chip of chips) assert.equal(chip.props.disabled, true, '芯片应禁用');
  assert.equal(byText(tree, L.cardsRename).props.disabled, true, '改名应禁用');
  assert.equal(byText(tree, L.cardsRemove).props.disabled, true, '删除应禁用');

  // 正文保存照旧可用，但不得带卡片目标名
  const saveBtn = byText(tree, L.savePlain);
  assert.ok(saveBtn, 'stale 时保存按钮不带卡片目标名');
  assert.ok(!saveBtn.props.disabled, '正文保存不应被卡片门控连坐');

  // 直接驱动处理函数也不得触盘/展开面板（门控不只在外观上）
  await chipOf(tree, P, '卡片乙').props.onClick();
  await byText(tree, L.cardsAdd).props.onClick();
  await byText(tree, L.cardsRename).props.onClick();
  await byText(tree, L.cardsRemove).props.onClick();
  tree = await m.settle();
  assert.equal(postCalls(calls).length, 0, 'stale 下一切卡片写操作不得 POST');
  assert.equal(byText(tree, L.cardsSave), null, 'stale 下新建面板不得展开');
  assert.equal(byText(tree, L.cardsRemoveConfirm), null, 'stale 下删除面板不得展开');
});

// ---------------------------------------------------------------------------
// 5. 原语名字交叉核对（client 引入清单 ↔ 内核真包导出）
// ---------------------------------------------------------------------------

test('原语名字交叉核对：client 引入的每个名字都存在于内核真包（产物 + 类型声明）', () => {
  const clientSrc = fs.readFileSync(CLIENT_FILE, 'utf8');
  // [^}]* 不允许跨过 jsx-runtime 解构的收尾括号：否则非贪婪从更早的 require 起步、把两段吞成一段。
  const m = /const \{([^}]*)\} = require\("@deepseek-ai\/dsh-client-ui-primitives"\);/.exec(clientSrc);
  assert.ok(m, '必须能解析原语解构段（引入形状变了要同步本套件）');
  const names = m[1].split(',').map((s) => s.trim()).filter(Boolean);
  assert.deepEqual(names, PRIMITIVES_USED, '引入清单变化要显式同步本断言');

  const primDir = path.join(DSH, 'node_modules', '@deepseek-ai', 'dsh-client-ui-primitives', 'lib');
  const bundle = fs.readFileSync(path.join(primDir, 'index.js'), 'utf8');
  const compTypes = fs.readFileSync(path.join(primDir, 'types', 'index.d.ts'), 'utf8');
  const iconTypes = fs.readFileSync(path.join(primDir, 'types', 'icons', 'index.d.ts'), 'utf8');
  const ICONS = ['IconPlusOutlineRegular', 'IconChevronDownOutlineRegular'];
  for (const name of names) {
    assert.ok(bundle.includes(name), '真包产物 index.js 必须含导出 ' + name);
    const decls = ICONS.includes(name) ? iconTypes : compTypes;
    assert.ok(decls.includes(name), '真包类型声明必须含 ' + name);
  }
});

// ---------------------------------------------------------------------------
// 6. 协议常量配对（client.EXPECT_PROTO ↔ host.API_PROTO）
// ---------------------------------------------------------------------------

test('协议常量配对：client EXPECT_PROTO === host API_PROTO（宿主不重启只刷新页面时的判据）', () => {
  const clientSrc = fs.readFileSync(CLIENT_FILE, 'utf8');
  const hostSrc = fs.readFileSync(HOST_FILE, 'utf8');
  const expect = /const EXPECT_PROTO = (\d+);/.exec(clientSrc);
  const api = /const API_PROTO = (\d+);/.exec(hostSrc);
  assert.ok(expect && api, '两侧协议常量必须可解析（改名要同步本套件）');
  assert.equal(expect[1], api[1], 'client 的错配判据必须与 host 实际协议号一致');
});

// ---------------------------------------------------------------------------
// 7. 反证：判据都必须能红
// ---------------------------------------------------------------------------

test('反证：删掉 statusLine 的未知字段守卫 → 「跨版本不谎报」判据变红', () => {
  let src = fs.readFileSync(CLIENT_FILE, 'utf8');
  const anchor = 'if (st.armed === undefined && st.injected === undefined) return null;';
  assert.ok(src.includes(anchor), '反证锚点必须存在');
  src = src.replace(anchor, '');
  src = src.replace('exports.inject = inject;', 'exports.inject = inject;\n    exports.__test = { statusLine };');
  const sandbox = { window: { __ModuleLoader__: { load(mod) { sandbox.__loaded = mod; } } }, console };
  vm.runInNewContext(src, sandbox, { filename: 'dsh-prompt-custom-client.mutant.js' });
  const mutant = sandbox.__loaded.factory(fakeRequireFor(makePrimitivesStub()));
  const result = mutant.__test.statusLine({});
  assert.notEqual(result, null, '变异体应把「未知」谎报成停用（证明原判据确实在拦这种事）');
  assert.equal(result.tone, 'muted', '变异体走的正是误报路径');
});

test('反证：拿掉「点芯片前先处置未保存改动」守卫 → dirty 时直接 POST（判据能红）', async (t) => {
  let src = fs.readFileSync(CLIENT_FILE, 'utf8');
  const anchor = 'if (dirtyText) { setCardNotice(""); setPending({ kind: "use", id: card.id }); return; }';
  assert.ok(src.includes(anchor), '反证锚点必须存在（client.js 形状变了要同步本套件）');
  src = src.replace(anchor, '');
  src = src.replace('exports.inject = inject;', 'exports.inject = inject;\n    exports.__test = { L };');
  const P = makePrimitivesStub();
  const sandbox = {
    window: { __ModuleLoader__: { load(mod) { sandbox.__loaded = mod; } } },
    console,
    fetch: (...args) => global.fetch(...args)
  };
  vm.runInNewContext(src, sandbox, { filename: 'dsh-prompt-custom-client.mutant-guard.js' });
  const mutant = sandbox.__loaded.factory(fakeRequireFor(P));
  const { L } = mutant.__test;
  const card = cardOf(mutant);
  const calls = defaultHandler(t, { config: cfgWithCards() });
  const m = createMounter(card, {});
  let tree = await m.settle();

  editorOf(tree).props.onChange({ target: { value: 'UNSAVED-X' } });
  tree = await m.settle();
  await chipOf(tree, P, '卡片乙').props.onClick();
  tree = await m.settle();

  assert.equal(postCalls(calls).length, 1, '变异体在 dirty 时直接 POST（证明原守卫确实在拦这件事）');
  assert.equal(postCalls(calls)[0].body.text, 'PERSONA-B', '变异体直接切到目标卡');
  assert.equal(byTextIncludes(tree, L.cardsUseDirty), null, '变异体不会有「先处置」面板');
});
