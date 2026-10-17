'use strict';

// ---------------------------------------------------------------------------
// unit-prompt-optimizer-lexical-write.test.js
//
// 「展开为结构化 → 替换草稿没反应」的回归锁（2026-10-15，修复随 2.2.1 出厂）。
//
// 由来（真机复现 + 隔离内核实测）：DSH composer 是 Lexical 富文本
// （<div contenteditable data-composer-input data-lexical-editor>）。插件旧写回走
// select-all + execCommand('insertText')——Chromium 对多行文本拆成逐行 insertText +
// data=null 的换行事件，Lexical 吞掉换行，8+ 行时整段静默失败（DOM 纹丝不动、
// 无异常、无日志）；单行短文本碰巧走通，所以普通润色看不出问题、结构化（多行
// markdown）必现「点了没反应」。修复：Lexical 走编辑器自己的粘贴通道——合成
// Ctrl+A（SELECT_ALL）再合成 paste（DataTransfer 带 text/plain），逐字保真（含 \n），
// 不消费（未 preventDefault）时回退旧通道。
//
// 覆盖（执行的是 dist/client.js 的真实产物代码——vm 捕获 factory、内存替换暴露
// writeComposerText/isLexicalEditor/pasteReplace，不动仓库文件）：
//   ① 交付形态：产物工厂可执行、暴露锚点命中（函数名未被 minify）；
//   ② Lexical 桩消费：事件序 Ctrl+A → paste(全文)、逐字保真、零 execCommand；
//   ③ 反证：Lexical 未消费（不 preventDefault）必须回退 insertText；
//   ④ 路径保真：非 Lexical contenteditable 与 textarea 走各自原通道；
//   ⑤ 文本锁：src 与 dist 同时咬「Lexical 分支先于 fallback」的顺序 + 变异反证。
// 不覆盖：真浏览器事件语义（真机已在隔离内核 + 真 Chromium 上实测复跑）——
// 本套件是行为契约的防回归锁，不冒充浏览器实测。
//
// 运行：node --test scripts/test/unit-prompt-optimizer-lexical-write.test.js
// ---------------------------------------------------------------------------

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const React = require('react');
const jsxRuntime = require('react/jsx-runtime');
let clsxMod;
try {
  clsxMod = require('clsx');
} catch {
  clsxMod = { __esModule: true, default: (...a) => a.filter(Boolean).join(' ') };
}

const DSH = path.resolve(__dirname, '..', '..');
const PKG_DIR = path.join(DSH, 'assets', 'plugins', 'dsh-prompt-optimizer');
const DIST = path.join(PKG_DIR, 'dist', 'client.js');

// ---------------------------------------------------------------------------
// 模拟 DOM 桩（class 引用同一对象挂进沙箱——vm 内 instanceof 才能成立）
// ---------------------------------------------------------------------------

class HTMLElementStub {
  constructor() {
    this._attrs = {};
    this._listeners = {};
  }
  get isContentEditable() { return this._contentEditable === true; }
  setAttribute(n, v) { this._attrs[n] = String(v); }
  getAttribute(n) { const v = this._attrs[n]; return v === undefined ? null : v; }
  closest() { return null; }
  focus() { this.focusCalls = (this.focusCalls || 0) + 1; }
  addEventListener(t, fn) { (this._listeners[t] ||= []).push(fn); }
  dispatchEvent(ev) {
    let prevented = false;
    ev.preventDefault = () => { prevented = true; };
    for (const fn of (this._listeners[ev.type] || [])) fn(ev);
    return !prevented; // 真实 DOM 语义：任一监听器 preventDefault 则返回 false
  }
}
class HTMLTextAreaElementStub extends HTMLElementStub {
  constructor() { super(); this._value = ''; }
  get value() { return this._value; }
  set value(v) { this._value = String(v); }
}
class EventStub {
  constructor(type, init) { this.type = type; Object.assign(this, init || {}); }
  preventDefault() {}
}
class KeyboardEventStub extends EventStub {}
class DataTransferStub {
  constructor() { this._data = {}; }
  setData(t, v) { this._data[t] = String(v); }
  getData(t) { return this._data[t] || ''; }
}
class ClipboardEventStub extends EventStub {
  // 模拟真实 Chromium：构造器忽略 init.clipboardData（安全限制），实例属性可被 defineProperty 覆盖
  constructor(type, init) { super(type, init || {}); this.clipboardData = null; }
}

/** 一次完整装载：vm 执行产物 → 暴露内部实现 → 宿主执行 factory → 桩就绪。 */
function makeHarness() {
  let src = fs.readFileSync(DIST, 'utf8');
  const anchor = '    return module.exports;';
  assert.ok(
    src.includes(anchor),
    'dist 锚点 `return module.exports;` 丢失——build.mjs 的工厂壳形态变了，要同步本套件',
  );
  src = src.replace(
    anchor,
    '    module.exports.__test = { writeComposerText, isLexicalEditor, pasteReplace };\n' + anchor,
  );
  const sandbox = {
    window: { __ModuleLoader__: { load(m) { sandbox.__loaded = m; } } },
    console: { log() {}, error() {}, warn() {} },
  };
  vm.runInNewContext(src, sandbox, { filename: 'dsh-prompt-optimizer-client.js' });
  const loaded = sandbox.__loaded;
  assert.ok(
    loaded && typeof loaded.factory === 'function',
    '产物未经 window.__ModuleLoader__.load 注册 factory',
  );
  assert.equal(loaded.id, 'dsh-prompt-optimizer', '产物注册 id 不等于包名');

  const execCalls = [];
  const docStub = {
    activeElement: null,
    _q: {},
    _qa: {},
    querySelector(sel) { return this._q[sel] ?? null; },
    querySelectorAll(sel) { return this._qa[sel] ?? []; },
    createRange() { return { selectNodeContents() {} }; },
    execCommand(cmd, ui, val) { execCalls.push({ cmd, val }); return true; },
  };
  Object.assign(sandbox, {
    document: docStub,
    // vm 内函数解析的是沙箱全局（不是宿主 global）——桩必须挂沙箱
    HTMLElement: HTMLElementStub,
    Element: HTMLElementStub,
    HTMLTextAreaElement: HTMLTextAreaElementStub,
    Event: EventStub,
    KeyboardEvent: KeyboardEventStub,
    ClipboardEvent: ClipboardEventStub,
    DataTransfer: DataTransferStub,
  });
  sandbox.window.getSelection = () => null;

  const fakeRequire = (name) => {
    if (name === 'react') return React;
    if (name === 'react/jsx-runtime') return jsxRuntime;
    if (name === 'clsx') return clsxMod;
    throw new Error('不得 require：' + name);
  };
  const mod = loaded.factory(fakeRequire);
  assert.ok(
    mod.__test && typeof mod.__test.writeComposerText === 'function'
      && typeof mod.__test.isLexicalEditor === 'function'
      && typeof mod.__test.pasteReplace === 'function',
    '内存暴露锚点未命中——writeComposerText/isLexicalEditor/pasteReplace 名被 minify 或已改名',
  );
  return { mod, sandbox, docStub, execCalls };
}

/** Lexical composer 桩：keydown 里 Ctrl+A 记 SELECT_ALL；paste 里读 DataTransfer（可开关消费行为）。 */
function makeLexicalComposer(opts = {}) {
  const el = new HTMLElementStub();
  el._contentEditable = true;
  el.setAttribute('data-composer-input', 'true');
  if (opts.lexical !== false) el.setAttribute('data-lexical-editor', 'true');
  const trace = { seq: [], selectedAll: false, pasted: null };
  el.addEventListener('keydown', (ev) => {
    trace.seq.push('keydown:' + ev.key + (ev.ctrlKey ? '+ctrl' : ''));
    if (ev.key === 'a' && ev.ctrlKey) {
      trace.selectedAll = true;
      ev.preventDefault();
    }
  });
  el.addEventListener('paste', (ev) => {
    trace.seq.push('paste');
    trace.pasted = ev.clipboardData ? ev.clipboardData.getData('text/plain') : null;
    if (opts.consume !== false && trace.pasted !== null) {
      ev.preventDefault(); // 模拟 Lexical 消费（受控更新由编辑器自己完成）
      el.innerText = trace.pasted;
    }
  });
  return { el, trace };
}

/** 多行样本：≥8 行（旧通道实测的静默失败区），混合行首标记与空行。 */
const MULTI = [
  '# 任务：编写一个数据排序函数',
  '',
  '## 要求',
  '1. 输入为数组',
  '2. 返回新数组',
  '3. 保持稳定性',
  '4. 空数组返回空数组',
  '5. 只做升序',
  '',
  '## 输出要求',
  '- 只输出代码',
  '- 附结构说明',
  '- 用中文注释',
  '- 性能 O(n log n)',
  '',
  '## 示例',
  '输入 [3,1,2] → [1,2,3]',
  '完。',
].join('\n');

// ---------------------------------------------------------------------------
// 行为面（跑产物真代码）
// ---------------------------------------------------------------------------

test('交付形态：产物工厂可执行、内部暴露锚点命中（函数名保留）', () => {
  const { mod } = makeHarness();
  assert.equal(typeof mod.apply, 'function', '入口 apply 不在 exports');
  assert.ok(Array.isArray(mod.inject), '入口 inject 不在 exports');
  const { isLexicalEditor } = mod.__test;
  // 判据：data-lexical-editor 属性在自身上/在祖先上，都要命中
  const own = new HTMLElementStub();
  own.setAttribute('data-lexical-editor', 'true');
  assert.equal(isLexicalEditor(own), true, '自身带 data-lexical-editor 应判为 Lexical');
  const child = new HTMLElementStub();
  child.closest = () => own; // 模拟内部元素向上命中宿主
  assert.equal(isLexicalEditor(child), true, '祖先带 data-lexical-editor 应判为 Lexical');
  const plain = new HTMLElementStub();
  assert.equal(isLexicalEditor(plain), false, '无标记元素不应判为 Lexical');
});

test('Lexical composer：合成 Ctrl+A → paste(全文)——逐字保真、零 execCommand', () => {
  const { mod, docStub, execCalls } = makeHarness();
  execCalls.length = 0;
  const { el, trace } = makeLexicalComposer();
  docStub._q = { '[data-composer-input]': el };

  mod.__test.writeComposerText(MULTI);

  assert.equal(trace.selectedAll, true, '未派发 Ctrl+A（SELECT_ALL）——粘贴会追尾而不是替换');
  assert.equal(trace.pasted, MULTI, 'paste 事件未携带原文（或换行被破坏）——多行保真失败');
  assert.equal(el.innerText, MULTI, 'Lexical 桩消费后的最终文本不等于原文（夹具自证环）');
  assert.equal(execCalls.length, 0, 'Lexical 通道下不得调用 execCommand（旧通道即多行静默失败者）');
  assert.deepEqual(trace.seq, ['keydown:a+ctrl', 'paste'], '事件序应为 Ctrl+A → paste');
  assert.equal(el.focusCalls, 1, '应聚焦输入控件');
});

test('反证：Lexical 未消费（不 preventDefault）必须回退 insertText——判据不是空转', () => {
  const { mod, docStub, execCalls } = makeHarness();
  execCalls.length = 0;
  const { el, trace } = makeLexicalComposer({ consume: false });
  docStub._q = { '[data-composer-input]': el };

  mod.__test.writeComposerText(MULTI);

  assert.equal(trace.pasted, MULTI, 'paste 仍应携带全文（派发本身不受消费与否影响）');
  assert.equal(execCalls.length, 1, '未消费必须落回 execCommand 回退（否则真实写入丢失）');
  assert.equal(execCalls[0].cmd, 'insertText', '回退命令应为 insertText');
  assert.equal(execCalls[0].val, MULTI, '回退应携带原文');
});

test('路径保真：非 Lexical contenteditable 与 textarea 走各自原通道', () => {
  // 非 Lexical contenteditable：不派发 paste，直接 insertText
  {
    const { mod, docStub, execCalls } = makeHarness();
    execCalls.length = 0;
    const { el, trace } = makeLexicalComposer({ lexical: false });
    docStub._q = { '[data-composer-input]': el };
    mod.__test.writeComposerText('轻文本');
    assert.equal(trace.pasted, null, '非 Lexical 不应走 paste 通道');
    assert.equal(execCalls.length, 1, '非 Lexical 应直接走 insertText');
  }
  // textarea：原生 value setter + input 事件 + 聚焦（与 2.2.0 行为一致）
  {
    const { mod, docStub } = makeHarness();
    const ta = new HTMLTextAreaElementStub();
    const events = [];
    ta.addEventListener('input', () => events.push('input'));
    docStub._q = {};
    docStub._qa = { textarea: [ta] };
    mod.__test.writeComposerText('替换文本');
    assert.equal(ta.value, '替换文本', 'textarea value 未写入');
    assert.deepEqual(events, ['input'], 'textarea 应派发 input 事件');
    assert.equal(ta.focusCalls, 1, 'textarea 应聚焦');
  }
});

// ---------------------------------------------------------------------------
// 文本面（src 与 dist 同锁：分支顺序 + 事件构造标记）
// ---------------------------------------------------------------------------

/** 顺序判据（被测对象；反证用例对它做顺序交换注入）。 */
function lexicalBranchBeforeFallback(text) {
  const branch = text.indexOf('isLexicalEditor(el) && pasteReplace(el, text)');
  const fallback = text.indexOf('if (document.execCommand) {');
  return branch >= 0 && fallback >= 0 && branch < fallback;
}

test('文本锁：src 与 dist 同时咬「Lexical 分支先于 insertText 回退」与事件构造标记', () => {
  // 2.4.0 起 composer 读写面独立成模块（预览卡「替换」与按钮「撤销」共用同一组通道）
  const srcText = fs.readFileSync(path.join(PKG_DIR, 'src', 'composer.ts'), 'utf8');
  const distText = fs.readFileSync(DIST, 'utf8');
  const markers = [
    'isLexicalEditor',
    'pasteReplace',
    'new DataTransfer()',
    'text/plain',
    'ctrlKey',
    'clipboardData', // Object.defineProperty(ev, 'clipboardData', …) 兜底
  ];
  for (const [name, text] of [['src', srcText], ['dist', distText]]) {
    assert.ok(
      lexicalBranchBeforeFallback(text),
      `${name}：Lexical 分支不在场或不先于 insertText 回退（多行静默失败会复辟）`,
    );
    for (const marker of markers) {
      assert.ok(text.includes(marker), `${name} 缺少修复标记：${JSON.stringify(marker)}`);
    }
  }
});

test('反证：顺序判据不是恒真——交换顺序 / 缺分支必须报红', () => {
  const swapped = "if (document.execCommand) { }\nif (isLexicalEditor(el) && pasteReplace(el, text)) return;";
  assert.equal(lexicalBranchBeforeFallback(swapped), false, '交换后判据仍为真——判据空转');
  assert.equal(lexicalBranchBeforeFallback('只有一条派发'), false, '缺失分支未报红——判据空转');
});
