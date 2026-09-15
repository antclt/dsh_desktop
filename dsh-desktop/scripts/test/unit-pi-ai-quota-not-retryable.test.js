'use strict';

// ---------------------------------------------------------------------------
// pi-ai 配额耗尽不得重试补丁单测
// （scripts/patch-pi-ai-quota-not-retryable.js）。
//
// 在野故障（OpenAI 兼容渠道）：整轮请求先白等若干轮退避才报错 ——
//   429 {"message":"Allocated quota exceeded...","type":"insufficient_quota",
//        "code":"insufficient_quota"}
// 根因：provider-retry.js 的 isRetryableProviderError 把 429 一律判为可重试
// （镜像 OpenAI/Anthropic SDK 的退避策略，对**限流**是对的），但配额/余额耗尽
// 在 OpenAI 兼容 API 里同为 429，却是**终态**——不充值永远不会成功。上层分类
// 本已正确（@deepseek-ai/dsh-llm 的 isQuotaExceededError 覆盖 insufficient_quota /
// quota exceeded，dsh-llm-pi-ai 的 QUOTA 判定排在 429→RATE_LIMIT 之前），故本
// 补丁不动分类、只改可重试性：识别为配额耗尽即立即返回不可重试。
//
// 本文件三类断言：
//   1) 文本面：真实 vendored 靶字节反推 pristine → 锚点命中 → changed（产物含
//      marker、node --check 过、二次 already）；锚点被破坏 / 命中数 != 1 → 整份
//      不改（拒绝半投）。反推 pristine 的自证：正向应用后必须逐字节回到磁盘上的
//      补丁态字节。
//   2) 功能面：从**打过补丁的靶字节**抽出 __dshIsQuotaExhaustedError 与
//      isRetryableProviderError 求值，8 条用例（3 配额 → false；纯限流 / 空正文 /
//      500 / 408 → true；x-should-retry:false 优先 → false）。
//   3) 反向控制（必须）：纯限流 429、空正文 429、500、408 仍可重试，且 helper 对
//      它们逐一返回 false —— 证明本补丁不是「把 429 全禁了」，也没把判定放宽成
//      「任何 429 都禁」。
// ---------------------------------------------------------------------------

const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const {
  transformPiAiQuotaNotRetryable,
  patchPiAiQuotaNotRetryable,
  MARKER,
  TARGET_REL,
} = require('../patch-pi-ai-quota-not-retryable');
const { PI_AI_PROVIDER_RETRY_PKG_REL } = require('../lib/patch-target-resolver');
const markers = require('../lib/patch-adapters').markers;

const TARGET_FILE = path.join(__dirname, '..', '..', 'node_modules', TARGET_REL);
const POISON_LABEL = 'DSH-POISON-provider-retry.js';

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-quota-not-retryable-'));
after(() => fs.rmSync(tmpDir, { recursive: true, force: true }));

const currentBytes = () => fs.readFileSync(TARGET_FILE, 'utf8');

/** 从补丁态字节反推 pristine：剥掉注入的 helper 块（marker 注释起、至
 * isRetryableProviderError 定义行之前）+ 逆替换函数体内的配额判定。
 * 源本就 pristine（无 marker）时原样返回，使本文件在已收口 / 未收口的 dev 树上
 * 都能跑 changed 分支。 */
function toPristine(text) {
  if (!text.includes(MARKER)) return text;
  const helperStart = text.indexOf('// ' + MARKER);
  const fnStart = text.indexOf('function isRetryableProviderError');
  assert.ok(helperStart >= 0 && fnStart > helperStart, '反推 pristine 失败：找不到 helper 块边界');
  let out = text.slice(0, helperStart) + text.slice(fnStart);
  // 函数体内的注入体 = marker 注释两行 + if 语句两行。
  const stripped = out.replace(
    /\r?\n[ \t]*\/\/ [^\r\n]*\r?\n[ \t]*\/\/ [^\r\n]*\r?\n[ \t]*if \(__dshIsQuotaExhaustedError\(error\)\)\r?\n[ \t]*return false;/,
    '',
  );
  assert.notEqual(stripped, out, '反推 pristine 失败：函数体内的配额判定未剥离');
  return stripped;
}

/** 正向产物（自证：必须逐字节等于磁盘上的补丁态字节）。 */
function patchedSrc() {
  const pristine = toPristine(currentBytes());
  const r = transformPiAiQuotaNotRetryable(pristine, TARGET_FILE);
  assert.equal(r.status, 'changed', `正向应用应 changed，得 ${r.status}（${r.detail || ''}）`);
  assert.equal(r.src, currentBytes(), '正向产物与磁盘补丁态字节不一致（反推 pristine 不可信）');
  return r.src;
}

/**
 * 从打过补丁的靶字节抽出注入的 helper 与 isRetryableProviderError 求值。
 * 两者都未 export，故按文本边界切片写入临时 .cjs 后 require。
 */
function extractEvaluators() {
  const src = patchedSrc();
  const helperStart = src.indexOf('// ' + MARKER);
  const fnStart = src.indexOf('function isRetryableProviderError');
  const fnEnd = src.indexOf('function validateServerRetryDelayMs');
  assert.ok(helperStart >= 0, '靶字节里找不到注入 helper 的 marker 注释（补丁未落地？）');
  assert.ok(fnStart > helperStart, '靶字节里找不到 isRetryableProviderError');
  assert.ok(fnEnd > fnStart, '找不到 isRetryableProviderError 之后的边界函数');
  const code = src.slice(helperStart, fnStart)
    + src.slice(fnStart, fnEnd)
    + '\nmodule.exports = { __dshIsQuotaExhaustedError, isRetryableProviderError };\n';
  const file = path.join(tmpDir, 'extract-evaluators.cjs');
  fs.writeFileSync(file, code, 'utf8');
  const mod = require(file);
  assert.equal(typeof mod.isRetryableProviderError, 'function');
  assert.equal(typeof mod.__dshIsQuotaExhaustedError, 'function');
  return mod;
}

/** 造 provider 错误：status + 响应体（展开为 error 字段）+ 可选 x-should-retry 头。 */
function mkError(status, body, shouldRetry) {
  const error = Object.assign(new Error((body && body.message) || ''), body || {});
  error.status = status;
  error.headers = { get: (k) => (k === 'x-should-retry' ? shouldRetry : undefined) };
  return error;
}

// 用户线上真实 payload。
const REAL_QUOTA_PAYLOAD = {
  message: 'Allocated quota exceeded, please purchase more quota',
  type: 'insufficient_quota',
  code: 'insufficient_quota',
  body: JSON.stringify({
    message: 'Allocated quota exceeded, please purchase more quota',
    type: 'insufficient_quota',
    code: 'insufficient_quota',
  }),
};

// ---------------------------------------------------------------------------
// 1) 文本面
// ---------------------------------------------------------------------------

test('marker 单一数据源：脚本与 adapters.markers 同一实例，且 registry spec 引用同值', () => {
  assert.equal(markers.PI_AI_QUOTA_NOT_RETRYABLE_MARKER, MARKER);
  const spec = require('../lib/patch-registry').PATCH_SPECS.find((s) => s.id === 'pi-ai-quota-not-retryable');
  assert.ok(spec, 'registry 未登记 pi-ai-quota-not-retryable');
  assert.equal(spec.marker, MARKER, 'spec.marker 与脚本 MARKER 必须同源');
  assert.equal(spec.transform, transformPiAiQuotaNotRetryable, 'spec.transform 必须与 adapters 同一函数引用');
  assert.equal(spec.pkgRel, PI_AI_PROVIDER_RETRY_PKG_REL);
});

test('靶文件在位、当前字节为补丁最终态（transform already）', () => {
  assert.ok(fs.existsSync(TARGET_FILE), `靶文件缺席：${TARGET_FILE}`);
  const src = currentBytes();
  const r = transformPiAiQuotaNotRetryable(src, TARGET_FILE);
  assert.equal(r.status, 'already', 'dev 树应为补丁最终态（否则跑 node scripts/patch-deps.js 收口）');
  assert.equal(r.src, undefined);
  assert.ok(src.includes(MARKER), '靶文件应含幂等 marker');
  assert.ok(src.includes('function __dshIsQuotaExhaustedError(error) {'), '应含注入 helper');
});

test('真实 vendored 字节反推 pristine → changed：产物含 marker、node --check 过、二次 already', () => {
  const pristine = toPristine(currentBytes());
  assert.ok(!pristine.includes(MARKER), '反推 pristine 失败：仍含 marker');
  assert.ok(!pristine.includes('__dshIsQuotaExhaustedError'), '反推 pristine 失败：仍含注入 helper');
  const r = transformPiAiQuotaNotRetryable(pristine, TARGET_FILE);
  assert.equal(r.status, 'changed');
  assert.equal(typeof r.src, 'string');
  assert.notEqual(r.src, pristine);
  assert.ok(r.src.includes(MARKER), 'changed 产物须含 marker（幂等 / 回滚定位点）');
  // 配额判定必须落在 x-should-retry 头之后、status 判定之前（顺序即语义）。
  const body = r.src.slice(r.src.indexOf('function isRetryableProviderError'));
  const iHeader = body.indexOf('if (shouldRetry === "false")');
  const iQuota = body.indexOf('if (__dshIsQuotaExhaustedError(error))');
  const iStatus = body.indexOf('if (error.status === undefined)');
  assert.ok(iHeader >= 0 && iQuota > iHeader && iStatus > iQuota,
    '判定顺序必须为 x-should-retry 头 → 配额判定 → 状态码判定');
  // 靶是 ESM（package.json type: module），故语法检查写 .mjs。
  const probe = path.join(tmpDir, 'patched-syntax-check.mjs');
  fs.writeFileSync(probe, r.src, 'utf8');
  execFileSync(process.execPath, ['--check', probe], { stdio: 'pipe' });
  const again = transformPiAiQuotaNotRetryable(r.src, TARGET_FILE);
  assert.equal(again.status, 'already', '二次应用必须 already（幂等）');
  assert.equal(again.src, undefined);
});

test('锚点被破坏 / 命中数 != 1 → anchor-missing 且整份不改（拒绝半投）', () => {
  const pristine = toPristine(currentBytes());
  // 真实锚点区段（8 行）：用于构造「命中 2 次」夹具。
  const anchorMatch = pristine.match(
    /function isRetryableProviderError\(error\) \{[\s\S]*?if \(error\.status === undefined\)\r?\n[ \t]*return true;/,
  );
  assert.ok(anchorMatch, '夹具失效：找不到真实锚点区段');
  const cases = [
    ['函数定义行被改名', pristine.replace(
      'function isRetryableProviderError(error) {', 'function dshBrokenRetryable(error) {')],
    ['头部 shouldRetry 行被改名', pristine.replace(
      '    const shouldRetry = error.headers?.get("x-should-retry");',
      '    const dshWhatever = error.headers?.get("x-should-retry");')],
    ['status undefined 判定行被删', pristine.replace(
      /[ \t]*if \(error\.status === undefined\)\r?\n[ \t]*return true;\r?\n/, '')],
    ['锚点重复（命中 2 次）', pristine.replace(anchorMatch[0], () => anchorMatch[0] + '\n' + anchorMatch[0])],
  ];
  for (const [label, broken] of cases) {
    assert.notEqual(broken, pristine, `夹具失效：未能破坏「${label}」`);
    const r = transformPiAiQuotaNotRetryable(broken, POISON_LABEL);
    assert.equal(r.status, 'anchor-missing', `破坏「${label}」后必须整份不改，得 ${r.status}`);
    assert.equal(r.src, undefined, `anchor-missing 不得携带产物：${label}`);
    assert.ok(r.detail && r.detail.includes('isRetryableProviderError'), `${label}: detail 应点名锚点函数`);
    assert.ok(/命中 \d+ 次/.test(r.detail), `${label}: detail 应报命中次数，得 "${r.detail}"`);
    assert.ok(r.detail.includes(POISON_LABEL), `${label}: detail 应含传入文件名`);
  }
  // 「命中 2 次」夹具确实不是命中 1 次（防夹具退化）。
  const dup = transformPiAiQuotaNotRetryable(cases[3][1], POISON_LABEL);
  assert.ok(/命中 2 次/.test(dup.detail), `重复夹具应报 2 次，得 "${dup.detail}"`);
});

test('root 应用器形态：临时树首跑写 1 文件、重跑零写入，缺席靶诚实跳过', () => {
  const root = path.join(tmpDir, 'nm');
  fs.mkdirSync(path.dirname(path.join(root, TARGET_REL)), { recursive: true });
  fs.writeFileSync(path.join(root, TARGET_REL), toPristine(currentBytes()), 'utf8');
  const first = patchPiAiQuotaNotRetryable(root);
  assert.equal(first.changed, true, '首跑应落盘');
  assert.ok(fs.readFileSync(path.join(root, TARGET_REL), 'utf8').includes(MARKER));
  const second = patchPiAiQuotaNotRetryable(root);
  assert.equal(second.changed, false);
  assert.equal(second.already, true, '重跑应幂等 already');
  const absent = patchPiAiQuotaNotRetryable(path.join(tmpDir, 'nm-absent'));
  assert.equal(absent.changed, false);
  assert.equal(absent.skipped, true, '靶文件缺席应诚实跳过');
});

// ---------------------------------------------------------------------------
// 2) 功能面 + 3) 反向控制
// ---------------------------------------------------------------------------

test('功能：8 条判定用例（3 配额 → 不可重试；纯限流/空正文/500/408 → 可重试；x-should-retry:false 优先）', () => {
  const mod = extractEvaluators();
  const cases = [
    // 配额耗尽 = 终态 → 不可重试。
    { label: '429 + insufficient_quota（用户真实 payload）', err: mkError(429, REAL_QUOTA_PAYLOAD), want: false },
    { label: '429 + quota exceeded 文案', err: mkError(429, { message: 'Quota exceeded' }), want: false },
    { label: '429 + insufficient balance', err: mkError(429, { message: 'insufficient balance' }), want: false },
    // 反向控制：这些**必须**仍可重试（证明不是把 429 全禁了）。
    { label: '纯限流 429（rate limit / too many requests）', err: mkError(429, { message: 'Rate limit exceeded, too many requests' }), want: true },
    { label: '空正文 429', err: mkError(429, {}), want: true },
    { label: '500', err: mkError(500, {}), want: true },
    { label: '408', err: mkError(408, {}), want: true },
    // 显式头优先：运维可用它强制覆盖。
    { label: '429 + x-should-retry:false（显式头优先）', err: mkError(429, {}, 'false'), want: false },
  ];
  assert.equal(cases.length, 8, '用例数应恰为 8');
  for (const { label, err, want } of cases) {
    assert.equal(mod.isRetryableProviderError(err), want,
      `${label} 期望 isRetryableProviderError=${want}，得 ${mod.isRetryableProviderError(err)}`);
  }
  // 反向控制的直证：helper 对四种「仍可重试」的错误逐一返回 false，
  // 说明禁令只覆盖配额特征、没有放宽成「任何 429 都算配额」。
  for (const { label, err } of cases.filter((c) => c.want === true)) {
    assert.equal(mod.__dshIsQuotaExhaustedError(err), false,
      `反向控制失败：${label} 被 helper 误判为配额耗尽（等于把 429 全禁）`);
  }
  // 正向直证：三条配额用例 helper 必须为 true（断言不为空转）。
  for (const { label, err } of cases.filter((c) => c.want === false && c.err.headers.get('x-should-retry') === undefined)) {
    assert.equal(mod.__dshIsQuotaExhaustedError(err), true, `helper 应识别配额耗尽：${label}`);
  }
});

test('功能：x-should-retry:true 同时命中配额特征时仍以显式头为准（可重试）', () => {
  const mod = extractEvaluators();
  const forced = mkError(429, REAL_QUOTA_PAYLOAD, 'true');
  assert.equal(mod.__dshIsQuotaExhaustedError(forced), true, 'payload 本身确实命中配额特征');
  assert.equal(mod.isRetryableProviderError(forced), true,
    'x-should-retry:true 是运维强制覆盖，必须先于配额判定生效');
});

test('功能：错误形态覆盖面（type / code / response.data 三处来源各自可命中）', () => {
  const mod = extractEvaluators();
  assert.equal(mod.__dshIsQuotaExhaustedError(mkError(429, { type: 'insufficient_quota' })), true, 'type 字段');
  assert.equal(mod.__dshIsQuotaExhaustedError(mkError(429, { code: 'insufficient_quota' })), true, 'code 字段');
  assert.equal(mod.__dshIsQuotaExhaustedError(
    mkError(429, { response: { data: { error: { message: 'You exceeded your current quota' } } } })),
  false, 'response.data 是对象时不在字符串字段集内（上游形态由 body/message 承载）');
  assert.equal(mod.__dshIsQuotaExhaustedError(
    mkError(429, { response: { data: 'You exceeded your current quota' } })),
  true, 'response.data 为字符串时应命中');
  assert.equal(mod.__dshIsQuotaExhaustedError(mkError(429, {})), false, '无任何字符串字段 → 不判配额');
});
