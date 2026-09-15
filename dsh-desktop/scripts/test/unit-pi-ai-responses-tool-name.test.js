'use strict';

// ---------------------------------------------------------------------------
// pi-ai Responses 路径工具名净化补丁单测
// （scripts/patch-pi-ai-responses-tool-name-sanitize.js）。
//
// 在野故障：配 OpenAI 兼容模型（Responses 路径）时整轮 400 ——
//   {"code":"invalid_value","message":"Invalid 'tools[1].name': string does not
//    match pattern. Expected a string that matches the pattern '^[a-zA-Z0-9_-]+$'.",
//    "param":"tools[1].name"}
// 根因：completions 侧姊妹补丁只清洗 openai-completions.js，而
// openai-responses / azure-openai-responses / openai-codex-responses 共用的
// openai-responses-shared.js 零清洗，dsh-cardian 的 cardian.* 带点号工具名直上 wire。
//
// 本文件三类断言：
//   1) 文本面：真实 vendored 靶字节 → 6 锚点全命中 → changed（产物含 marker、
//      node --check 过、二次 already）；逐锚点破坏 → anchor-missing 且 detail
//      点名是哪一处（任一缺失整份不改，拒绝半投）。
//   2) 功能面：装载打过补丁的模块（把 changed 产物的相对 import 改写为绝对 file:
//      后从临时目录 import，避免往 node_modules 里落临时文件），用 cardian.backlinks
//      这类带点号名跑 convertResponsesTools 断言出站为 cardian_backlinks；再让模型
//      以 wire 名回调，经 processResponsesStream 的 function_call / custom_tool_call
//      槽位构造断言还原为注册原名；历史回放（convertResponsesMessages）同样出 wire 名。
//   3) 反向控制：合法名（bash / read_file / WebSearch）出站不得被改写，且清洗
//      函数对它不得登记映射——映射规则单独在隔离上下文里求值核 map.size，
//      杜绝「无条件登记」这种功能断言照样能过的空转形态。
// ---------------------------------------------------------------------------

const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const { execFileSync } = require('node:child_process');
const { pathToFileURL } = require('node:url');

const {
  transformResponsesToolNameSanitize,
  patchPiAiResponsesToolNameSanitize,
  MARKER,
  TARGET_REL,
  HELPER_ANCHOR,
  SITES,
} = require('../patch-pi-ai-responses-tool-name-sanitize');

const TARGET_FILE = path.join(__dirname, '..', '..', 'node_modules', TARGET_REL);
const API_DIR = path.dirname(TARGET_FILE);
const POISON_LABEL = 'DSH-POISON-openai-responses-shared.js';

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-resp-sanitize-'));
after(() => fs.rmSync(tmpDir, { recursive: true, force: true }));

const currentBytes = () => fs.readFileSync(TARGET_FILE, 'utf8');

/** 从补丁态字节反推 pristine（剥 helper 块 + 逆替换 6 落点）。源本就 pristine 时
 * 原样返回，使本文件在已收口/未收口的 dev 树上都能跑 changed 分支。 */
function toPristine(text) {
  const start = text.indexOf('// ' + MARKER);
  const end = text.indexOf(HELPER_ANCHOR);
  let out = start >= 0 && end > start ? text.slice(0, start) + text.slice(end) : text;
  for (const site of SITES) out = out.split(site.to).join(site.from);
  return out;
}

/** 取补丁态产物（对当前磁盘字节反推 pristine 后正向应用）。 */
function patchedSrc() {
  const r = transformResponsesToolNameSanitize(toPristine(currentBytes()), TARGET_FILE);
  assert.equal(r.status, 'changed', `正向应用应 changed，得 ${r.status}（${r.detail || ''}）`);
  return r.src;
}

/** 把打过补丁的模块装载起来：相对 import 改写为绝对 file: URL 后写临时 .mjs。 */
async function loadPatched(tag) {
  const rewritten = patchedSrc().replace(
    /(\bfrom\s+")(\.\.?\/[^"]+)(")/g,
    (m, head, spec, tail) => head + pathToFileURL(path.resolve(API_DIR, spec)).href + tail,
  );
  assert.ok(!/\bfrom\s+"\./.test(rewritten), '仍有未改写的相对 import');
  const file = path.join(tmpDir, `patched-${tag}.mjs`);
  fs.writeFileSync(file, rewritten, 'utf8');
  return { mod: await import(pathToFileURL(file).href), file };
}

const mkTool = (name) => ({
  name,
  description: `工具 ${name}`,
  parameters: { type: 'object', properties: { query: { type: 'string' } } },
});

const asStream = (events) => (async function* gen() { for (const e of events) yield e; })();

// ---------------------------------------------------------------------------
// 1) 文本面：锚点命中 / marker / 语法 / 幂等
// ---------------------------------------------------------------------------

test('靶文件在位、当前字节为补丁最终态（transform already）', () => {
  assert.ok(fs.existsSync(TARGET_FILE), `靶文件缺席：${TARGET_FILE}`);
  const src = currentBytes();
  const r = transformResponsesToolNameSanitize(src, TARGET_FILE);
  assert.equal(r.status, 'already', 'dev 树应为补丁最终态（否则跑 node scripts/patch-deps.js 收口）');
  assert.equal(r.src, undefined);
  assert.ok(src.includes(MARKER), '靶文件应含幂等 marker');
  assert.ok(src.includes('const __dshToolWireMap = new Map();'), '应含映射表 helper（与 completions 补丁同名）');
});

test('pristine 字节 → changed：6 落点全命中、产物含 marker、node --check 通过、二次 already', () => {
  const pristine = toPristine(currentBytes());
  assert.ok(!pristine.includes('__dshWireName'), '反推 pristine 失败（仍含注入体）');
  assert.equal(transformResponsesToolNameSanitize(pristine, TARGET_FILE).status, 'changed');
  const r = transformResponsesToolNameSanitize(pristine, TARGET_FILE);
  assert.equal(typeof r.src, 'string');
  assert.notEqual(r.src, pristine);
  assert.ok(r.src.includes(MARKER), 'changed 产物须含 marker（幂等/回滚定位点）');
  for (const site of SITES) {
    assert.ok(r.src.includes(site.to), `落点缺失：${site.key}`);
    assert.ok(!r.src.includes(site.from), `落点未被替换（原文残留）：${site.key}`);
  }
  const probe = path.join(tmpDir, 'syntax-check.mjs');
  fs.writeFileSync(probe, r.src, 'utf8');
  execFileSync(process.execPath, ['--check', probe], { stdio: 'pipe' });
  const again = transformResponsesToolNameSanitize(r.src, TARGET_FILE);
  assert.equal(again.status, 'already', '二次应用必须 already（幂等）');
  assert.equal(again.src, undefined);
});

test('逐锚点破坏 → anchor-missing 且 detail 点名具体落点（拒绝半投）', () => {
  const pristine = toPristine(currentBytes());
  const cases = SITES.map((site) => ({
    label: site.key,
    broken: pristine.replace(site.from, () => site.from.replace('name:', 'dshBrokenName:')),
  }));
  cases.push({
    label: 'helper 注入锚点 convertResponsesTools 定义行',
    broken: pristine.replace(HELPER_ANCHOR, 'export function convertRenamedResponsesTools(tools, options) {'),
  });
  for (const { label, broken } of cases) {
    assert.notEqual(broken, pristine, `夹具失效：未能破坏 ${label}`);
    const r = transformResponsesToolNameSanitize(broken, POISON_LABEL);
    assert.equal(r.status, 'anchor-missing', `破坏 ${label} 后必须整份不改，得 ${r.status}`);
    assert.equal(r.src, undefined, `anchor-missing 不得携带产物：${label}`);
    assert.ok(r.detail && r.detail.includes('ANCHOR MISMATCH'), `${label}: detail 应报 ANCHOR MISMATCH`);
    assert.ok(r.detail.includes(label), `${label}: detail 未点名该锚点，得 "${r.detail}"`);
    assert.ok(r.detail.includes(POISON_LABEL), 'detail 应含传入文件名');
  }
});

test('锚点命中数 != 1（重复行）同样拒绝半投', () => {
  const pristine = toPristine(currentBytes());
  const dup = pristine.replace(SITES[1].from, () => SITES[1].from + '\n' + SITES[1].from);
  const r = transformResponsesToolNameSanitize(dup, POISON_LABEL);
  assert.equal(r.status, 'anchor-missing', '锚点命中 2 次时不得改写（半投风险）');
  assert.ok(/命中 2 次/.test(r.detail || ''), `detail 应报命中数，得 "${r.detail}"`);
});

test('root 应用器形态：临时树首跑写 1 文件、重跑零写入，缺席靶诚实返回 0', () => {
  const root = path.join(tmpDir, 'nm');
  fs.mkdirSync(path.dirname(path.join(root, TARGET_REL)), { recursive: true });
  fs.writeFileSync(path.join(root, TARGET_REL), toPristine(currentBytes()), 'utf8');
  const stats = { anchorMissing: 0, failed: 0 };
  const logs = [];
  assert.equal(patchPiAiResponsesToolNameSanitize(root, (m) => logs.push(m), stats), 1, '首跑应落盘 1 个文件');
  assert.equal(stats.anchorMissing, 0);
  assert.equal(stats.failed, 0);
  assert.ok(logs.join('\n').includes('已注入'), `首跑日志应报注入，得 ${logs.join(' | ')}`);
  assert.ok(fs.readFileSync(path.join(root, TARGET_REL), 'utf8').includes(MARKER));
  const logs2 = [];
  assert.equal(patchPiAiResponsesToolNameSanitize(root, (m) => logs2.push(m), stats), 0, '重跑应零写入');
  assert.ok(logs2.join('\n').includes('已应用，跳过'));
  assert.equal(stats.anchorMissing, 0, '幂等重跑不得计失配');
  assert.equal(stats.failed, 0);
  assert.equal(patchPiAiResponsesToolNameSanitize(path.join(tmpDir, 'nm-absent'), () => {}, stats), 0,
    '靶文件缺席应诚实返回 0');
});

// ---------------------------------------------------------------------------
// 2) 功能面
// ---------------------------------------------------------------------------

test('功能·出站：cardian.backlinks 经 convertResponsesTools 出 wire 名 cardian_backlinks', async (t) => {
  const { mod, file } = await loadPatched('out');
  t.after(() => fs.rmSync(file, { force: true }));
  const out = mod.convertResponsesTools([mkTool('cardian.backlinks'), mkTool('cardian.doctor')], {});
  assert.deepEqual(out.map((tool) => tool.name), ['cardian_backlinks', 'cardian_doctor']);
  for (const tool of out) assert.match(tool.name, /^[a-zA-Z0-9_-]+$/, 'wire 名仍不满足网关 pattern');
  assert.equal(out[0].type, 'function');
});

test('功能·入站：wire 名经 function_call / custom_tool_call 槽位构造还原为注册原名', async (t) => {
  const { mod, file } = await loadPatched('in');
  t.after(() => fs.rmSync(file, { force: true }));
  // 真实链路里 tools 必随请求先出站 → 先登记映射。
  mod.convertResponsesTools([mkTool('cardian.backlinks'), mkTool('cardian.recall')], {});
  const sink = { push() {} };
  const model = { provider: 'openai', api: 'openai-responses', id: 'gpt-5' };

  const fnOutput = { content: [] };
  try {
    await mod.processResponsesStream(asStream([
      { type: 'response.output_item.added', output_index: 0, item: { type: 'function_call', call_id: 'call_1', id: 'fc_1', name: 'cardian_backlinks', arguments: '{"query":"x"}' } },
      { type: 'response.output_item.done', output_index: 0, item: { type: 'function_call', call_id: 'call_1', id: 'fc_1', name: 'cardian_backlinks', arguments: '{"query":"x"}' } },
    ]), fnOutput, sink, model, {});
  } catch { /* 无 terminal 事件的预期抛错：此处只验槽位构造的名字还原 */ }
  assert.equal(fnOutput.content.length, 1, 'function_call 槽位未构造');
  assert.equal(fnOutput.content[0].name, 'cardian.backlinks', 'wire 名未还原为注册原名（内核按原名分发）');
  assert.deepEqual(fnOutput.content[0].arguments, { query: 'x' });

  const customOutput = { content: [] };
  try {
    await mod.processResponsesStream(asStream([
      { type: 'response.output_item.added', output_index: 0, item: { type: 'custom_tool_call', call_id: 'call_2', id: 'ctc_2', name: 'cardian_recall', input: 'hello' } },
    ]), customOutput, sink, model, {});
  } catch { /* 同上 */ }
  assert.equal(customOutput.content.length, 1, 'custom_tool_call 槽位未构造');
  assert.equal(customOutput.content[0].name, 'cardian.recall', 'custom 槽位 wire 名未还原');
});

test('功能·历史回放：assistant toolCall 原名在回放里出 wire 名', async (t) => {
  const { mod, file } = await loadPatched('replay');
  t.after(() => fs.rmSync(file, { force: true }));
  const model = { provider: 'openai', api: 'openai-responses', id: 'gpt-5', input: ['text'] };
  const context = {
    messages: [{
      role: 'assistant',
      provider: 'openai',
      api: 'openai-responses',
      model: 'gpt-5',
      content: [{ type: 'toolCall', id: 'call_3|fc_3', name: 'cardian.export', arguments: { a: 1 } }],
    }],
  };
  const messages = mod.convertResponsesMessages(model, context, new Set(['openai']), {});
  const replayed = messages.find((item) => item.type === 'function_call');
  assert.ok(replayed, '回放未产出 function_call');
  assert.equal(replayed.name, 'cardian_export');
  assert.match(replayed.name, /^[a-zA-Z0-9_-]+$/);
});

// ---------------------------------------------------------------------------
// 3) 反向控制
// ---------------------------------------------------------------------------

test('反向控制：合法名出站不改写，且清洗函数对它不登记映射', async (t) => {
  const { mod, file } = await loadPatched('legal');
  t.after(() => fs.rmSync(file, { force: true }));
  const out = mod.convertResponsesTools([mkTool('bash'), mkTool('read_file'), mkTool('WebSearch')], {});
  assert.deepEqual(out.map((tool) => tool.name), ['bash', 'read_file', 'WebSearch'], '合法名被改写 = 反向控制失败');
  mod.convertResponsesTools([mkTool('cardian.feedback')], {});
  const output = { content: [] };
  try {
    await mod.processResponsesStream(asStream([
      { type: 'response.output_item.added', output_index: 0, item: { type: 'function_call', call_id: 'c9', id: 'fc_9', name: 'bash', arguments: '{}' } },
    ]), output, { push() {} }, { provider: 'openai', api: 'openai-responses', id: 'm' }, {});
  } catch { /* 预期 terminal 抛错 */ }
  assert.equal(output.content[0].name, 'bash', '合法名被误还原/改写');

  // 映射规则的直证：隔离求值注入体，map 只在名字真的变化时增长。
  const patched = patchedSrc();
  const helper = patched.slice(patched.indexOf('// ' + MARKER), patched.indexOf(HELPER_ANCHOR));
  assert.ok(helper.includes('__dshToolWireMap'), '未取到注入的 helper 块');
  const ctx = vm.createContext({ Map });
  vm.runInContext(
    helper + '\nglobalThis.__probe = { map: __dshToolWireMap, wire: __dshWireName, restore: __dshRestoreToolName };',
    ctx,
  );
  const probe = vm.runInContext('globalThis.__probe', ctx);
  assert.equal(probe.wire('bash'), 'bash');
  assert.equal(probe.wire('read-file_2'), 'read-file_2');
  assert.equal(probe.map.size, 0, '合法名不得登记映射（只在名字真的变化时登记）');
  assert.equal(probe.wire('cardian.feedback'), 'cardian_feedback');
  assert.equal(probe.map.size, 1, '非法名应且只应登记一条映射');
  assert.deepEqual(probe.restore('cardian_feedback'), 'cardian.feedback');
  assert.equal(probe.restore('bash'), 'bash', '未登记的名字原样透传');
});

test('补丁只改名不动 schema：parameters/description/strict 表达式保持原样', () => {
  const patched = patchedSrc();
  assert.ok(patched.includes('parameters: getJsonSchemaToolParameters(tool, strict === true),'),
    'function 分支 parameters 表达式被误改（本补丁不该动 schema）');
  assert.ok(patched.includes('description: tool.description,'));
  assert.ok(patched.includes('functionTool.strict = strict;'));
  assert.ok(!patched.includes('__dshSanitizeToolSchema'), '本补丁不得引入 schema 净化（属 completions 补丁职责）');
});
