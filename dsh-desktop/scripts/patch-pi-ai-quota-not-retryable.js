'use strict';

/* pi-ai 配额耗尽不得重试（幂等补丁）。
 *
 * 问题：provider-retry.js 的 isRetryableProviderError 把 429 一律判定可重试
 * （镜像 OpenAI/Anthropic SDK 的退避策略，对**限流**是对的）。但配额耗尽在
 * OpenAI 兼容 API 里同样是 429 —— 响应体为
 *   {"message":"Allocated quota exceeded...","type":"insufficient_quota",
 *    "code":"insufficient_quota"}
 * 这是**终态**：不充值永远不会成功。于是每次请求都先白等若干轮退避
 * （单轮上限 60s），最后才把错误交给上层。
 *
 * 上层其实已经识别得对：@deepseek-ai/dsh-llm 的 isQuotaExceededError 覆盖
 * `insufficient_quota` / `quota exceeded`，dsh-llm-pi-ai 的分类顺序也把 QUOTA
 * 排在 429→RATE_LIMIT 之前（实测用户真实 payload → QUOTA ✓）。所以本补丁
 * **不改分类、只改可重试性**：识别为配额耗尽即立即返回不可重试，让用户马上
 * 看到「配额/余额」提示，而不是先等一轮轮退避。
 *
 * 判定顺序：显式 x-should-retry 头优先（运维可覆盖），其后才看配额特征。
 * 关键词表与 dsh-llm 的 isQuotaExceededError 保持同集，便于对照维护。
 *
 * 用法：node scripts/patch-pi-ai-quota-not-retryable.js [<node_modules 根>]
 */

const fs = require('node:fs');
const path = require('node:path');
const { writeFileAtomic } = require('./lib/patch-io');

const TARGET_REL = path.join('@earendil-works', 'pi-ai', 'dist', 'utils', 'provider-retry.js');
const MARKER = 'dsh-desktop patch (pi-ai quota not retryable)';

const HELPER = [
  '// ' + MARKER + ': 配额耗尽（429 + insufficient_quota 等）是终态，不得重试。',
  '// 关键词集与 @deepseek-ai/dsh-llm 的 isQuotaExceededError 对齐：限流文案',
  '// （rate limit / too many requests）不在此列，仍走正常退避重试。',
  'function __dshIsQuotaExhaustedError(error) {',
  '\tconst parts = [error && error.code, error && error.type, error && error.message,',
  '\t\terror && error.body, error && error.response && error.response.data];',
  '\tconst text = parts.filter((v) => typeof v === "string").join(" ");',
  '\tif (text === "") return false;',
  '\treturn /\\binsufficient[\\s_-]+(?:quota|balance|credits?)\\b/i.test(text)',
  '\t\t|| /\\b(?:quota|usage[\\s_-]+limit)[\\s_-]+(?:exceeded|exhausted|reached)\\b/i.test(text)',
  '\t\t|| /\\bexceed(?:ed|s)?[\\s_-]+(?:(?:your|the)[\\s_-]+)?(?:current[\\s_-]+)?quota\\b/i.test(text)',
  '\t\t|| /\\b(?:balance|credits?)[\\s_-]+(?:exhausted|depleted)\\b/i.test(text)',
  '\t\t|| /\\bout[\\s_-]+of[\\s_-]+(?:credits?|budget)\\b/i.test(text);',
  '}',
  '',
].join('\n');

const ANCHOR = [
  'function isRetryableProviderError(error) {',
  '    const shouldRetry = error.headers?.get("x-should-retry");',
  '    if (shouldRetry === "true")',
  '        return true;',
  '    if (shouldRetry === "false")',
  '        return false;',
  '    if (error.status === undefined)',
  '        return true;',
].join('\n');

const REPLACEMENT = [
  'function isRetryableProviderError(error) {',
  '    const shouldRetry = error.headers?.get("x-should-retry");',
  '    if (shouldRetry === "true")',
  '        return true;',
  '    if (shouldRetry === "false")',
  '        return false;',
  '    // ' + MARKER + ': 配额耗尽即终态，先于任何按状态码的判定返回不可重试',
  '    // （显式 x-should-retry 头仍优先，运维可用它强制覆盖）。',
  '    if (__dshIsQuotaExhaustedError(error))',
  '        return false;',
  '    if (error.status === undefined)',
  '        return true;',
].join('\n');

function patchPiAiQuotaNotRetryable(nmRoot = path.join(__dirname, 'node_modules')) {
  const target = path.join(nmRoot, TARGET_REL);
  if (!fs.existsSync(target)) {
    return { changed: false, skipped: true, file: target, reason: '靶文件不存在（pi-ai 未装配）' };
  }
  const src = fs.readFileSync(target, 'utf8');
  if (src.includes(MARKER)) return { changed: false, file: target, already: true };
  const hits = src.split(ANCHOR).length - 1;
  if (hits !== 1) {
    return { changed: false, file: target, anchorMismatch: true,
      reason: 'ANCHOR MISMATCH: isRetryableProviderError 锚点命中 ' + hits + ' 次（需 1），整份不改' };
  }
  let out = src.replace(ANCHOR, REPLACEMENT);
  out = out.replace('function isRetryableProviderError(error) {', HELPER + 'function isRetryableProviderError(error) {');
  writeFileAtomic(target, out);
  return { changed: true, file: target };
}

/** 注册表用三态变换。 */
function transformPiAiQuotaNotRetryable(src, file) {
  if (typeof src !== 'string') return { status: 'anchor-missing', detail: '非字符串源，跳过 ' + file };
  if (src.includes(MARKER)) return { status: 'already' };
  const hits = src.split(ANCHOR).length - 1;
  if (hits !== 1) {
    return {
      status: 'anchor-missing',
      detail: '未找到 isRetryableProviderError 锚点（命中 ' + hits + ' 次，需 1；版本可能已变更），跳过 ' + file,
    };
  }
  let out = src.replace(ANCHOR, REPLACEMENT);
  out = out.replace('function isRetryableProviderError(error) {', HELPER + 'function isRetryableProviderError(error) {');
  return { status: 'changed', src: out };
}

module.exports = { patchPiAiQuotaNotRetryable, transformPiAiQuotaNotRetryable, MARKER, TARGET_REL };

if (require.main === module) {
  const nmRoot = process.argv[2] ? path.resolve(process.argv[2], 'node_modules') : path.join(__dirname, 'node_modules');
  const r = patchPiAiQuotaNotRetryable(nmRoot);
  if (r.changed) console.log('[' + MARKER + '] 已应用：' + r.file);
  else if (r.already) console.log('[' + MARKER + '] 已应用，跳过：' + r.file);
  else if (r.skipped) console.log('[' + MARKER + '] 跳过：' + r.reason);
  else {
    console.error('[' + MARKER + '] ' + r.reason);
    process.exitCode = 1;
  }
}
