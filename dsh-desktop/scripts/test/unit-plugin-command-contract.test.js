'use strict';
// 插件 commandUi 贡献契约守卫（node --test）。
//
// 背景（0.6.5 实机爆出）：内核 dsh-client-ui-commands 的 candidates() 把贡献项的
// label/description 当【取数函数】调用，且只容忍 undefined：
//
//   ...contribution.description === void 0 ? {} : { description: contribution.description() },
//   ...contribution.label       === void 0 ? {} : { label:       contribution.label() },
//
// 本轮 dsh-side-session 把 description 写成了字面量字符串 → candidates() 抛
// `TypeError: contribution.description is not a function` → 整个命令源的候选构建失败
// （控制台 `[ui-input-trigger] source "command" candidates failed`），斜杠命令面板
// 静默不出。插件自身的 try/catch 兜不住：它只包住 register 那一刻，崩点在之后的
// candidates() 调用处——属「注册成功、用的时候才炸」，日志里只有一行 warn，用户侧
// 表现为「按了没反应」。
//
// 判据：凡 `commandUi.register({...})` 对象字面量里出现 label / description，
// 其值必须是函数（function / 箭头），不得是字符串、模板字面量或其他字面量。
// 扫描范围 = assets/plugins 下声明了客户端半边的插件（以 package.json
// exports['./client'] 为权威，与 unit-plugin-dom-contract 同口径）。
//
// 用法：node --test scripts/test/unit-plugin-command-contract.test.js

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const PLUGINS = path.join(__dirname, '..', '..', 'assets', 'plugins');

/** 客户端入口以 package.json 的 exports['./client'] 为权威（同 dom-contract 守卫）。 */
function clientEntry(pluginDir) {
  const pj = path.join(pluginDir, 'package.json');
  if (!fs.existsSync(pj)) return null;
  let pkg;
  try { pkg = JSON.parse(fs.readFileSync(pj, 'utf8')); } catch { return null; }
  const raw = pkg && pkg.exports ? pkg.exports['./client'] : undefined;
  const rel = typeof raw === 'string' ? raw
    : (raw && typeof raw === 'object' ? (raw.browser || raw.default || raw.import || raw.require) : null);
  if (typeof rel !== 'string' || !rel.startsWith('./')) return null;
  const abs = path.join(pluginDir, rel.slice(2));
  return fs.existsSync(abs) ? abs : null;
}

/** 取 `marker` 之后第一个 `{` 起、括号配平的那段对象字面量文本。 */
function objectLiteralAfter(src, marker) {
  const at = src.indexOf(marker);
  if (at < 0) return null;
  const open = src.indexOf('{', at);
  if (open < 0) return null;
  let depth = 0;
  for (let i = open; i < src.length; i++) {
    const ch = src[i];
    if (ch === '{') depth++;
    else if (ch === '}') {
      depth--;
      if (depth === 0) return src.slice(open, i + 1);
    }
  }
  return null;
}

/** 去掉值文本前导的注释/空白（键与值之间允许写注释）。 */
function stripLeadingComments(v) {
  let s = v.trim();
  for (;;) {
    if (s.startsWith('//')) { s = s.slice(s.indexOf('\n') + 1).trim(); continue; }
    if (s.startsWith('/*')) { const e = s.indexOf('*/'); s = e < 0 ? '' : s.slice(e + 2).trim(); continue; }
    return s;
  }
}

/**
 * 收集对象字面量里【顶层键】的取值文本：字符级走查（跳过字符串与注释、跟踪括号深度），
 * 只在深度 1 处识别 `key:` 与随后的值，值到同层 `,` 或收尾 `}` 为止。
 */
function topLevelEntries(objText) {
  const out = [];
  const n = objText.length;
  let i = 1;
  let depth = 1;
  let key = null;
  let valStart = -1;
  const push = (end) => {
    if (key !== null && valStart >= 0) out.push({ key, value: stripLeadingComments(objText.slice(valStart, end)) });
    key = null;
    valStart = -1;
  };
  while (i < n) {
    const ch = objText[i];
    if (ch === '"' || ch === "'" || ch === '`') {
      const q = ch;
      i++;
      while (i < n) {
        if (objText[i] === '\\') { i += 2; continue; }
        if (objText[i] === q) { i++; break; }
        i++;
      }
      continue;
    }
    if (ch === '/' && objText[i + 1] === '/') { while (i < n && objText[i] !== '\n') i++; continue; }
    if (ch === '/' && objText[i + 1] === '*') {
      i += 2;
      while (i < n && !(objText[i] === '*' && objText[i + 1] === '/')) i++;
      i += 2;
      continue;
    }
    if (ch === '{' || ch === '[' || ch === '(') { depth++; i++; continue; }
    if (ch === '}' || ch === ']' || ch === ')') {
      depth--;
      if (depth === 0) { push(i); break; }
      i++;
      continue;
    }
    if (depth === 1) {
      if (ch === ',') { push(i); i++; continue; }
      if (key === null) {
        const m = /^[A-Za-z_$][\w$]*\s*:/.exec(objText.slice(i));
        if (m) { key = m[0].replace(/\s*:$/, '').trim(); i += m[0].length; valStart = i; continue; }
      }
    }
    i++;
  }
  push(n);
  return out;
}

const FUNCTION_SHAPE = /^(async\s+function\b|function\b|\([^)]*\)\s*=>|[A-Za-z_$][\w$]*\s*=>)/;

function scan() {
  const found = [];
  for (const name of fs.readdirSync(PLUGINS).sort()) {
    const dir = path.join(PLUGINS, name);
    if (!fs.statSync(dir).isDirectory()) continue;
    const file = clientEntry(dir);
    if (!file) continue;
    const src = fs.readFileSync(file, 'utf8');
    if (!src.includes('commandUi')) continue;
    // 只认调用形态 `commandUi.register(`——插件里的能力探测
    // `typeof ctx.commandUi.register !== "function"` 不是注册点（否则同一对象会被解析两遍）
    let idx = -1;
    while ((idx = src.indexOf('commandUi.register(', idx + 1)) !== -1) {
      const obj = objectLiteralAfter(src.slice(idx), 'commandUi.register(');
      if (!obj) continue;
      const line = src.slice(0, idx).split('\n').length;
      for (const { key, value } of topLevelEntries(obj)) {
        if (key !== 'label' && key !== 'description') continue;
        found.push({ plugin: name, key, value, line, isFn: FUNCTION_SHAPE.test(value) });
      }
    }
  }
  return found;
}

test('commandUi 贡献的 label/description 必须是函数（内核按函数调用，只容忍 undefined）', () => {
  const rows = scan();
  assert.ok(rows.length > 0, '没有扫到任何 commandUi 贡献——判据失效（插件被改名/移走？），应修判据而不是删测试');
  const bad = rows.filter((r) => !r.isFn);
  assert.deepEqual(
    bad,
    [],
    '以下 commandUi 贡献的 label/description 不是函数——会让 candidates() 抛 TypeError、斜杠命令面板整体不出：\n' +
      bad.map((r) => `  ${r.plugin} (client.js:${r.line}) ${r.key} = ${r.value.slice(0, 80)}`).join('\n'),
  );
});

test('回归锁：dsh-side-session 的命令贡献 label/description 均为函数形态', () => {
  const rows = scan().filter((r) => r.plugin === 'dsh-side-session');
  const keys = rows.map((r) => r.key).sort();
  assert.deepEqual(keys, ['description', 'label'], 'dsh-side-session 应同时被扫到 label 与 description 两个字段');
  for (const r of rows) {
    assert.ok(
      r.isFn,
      `dsh-side-session 的 ${r.key} 必须写成函数（0.6.5 实机曾写成字符串 "临时会话"，导致 /命令 候选构建 TypeError）`,
    );
  }
});
