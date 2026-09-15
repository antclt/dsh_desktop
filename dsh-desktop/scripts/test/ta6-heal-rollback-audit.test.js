'use strict';

// ---------------------------------------------------------------------------
// TA6 元测试 5：heal / 回滚面审计（静态分类，报告清单，不实现反向变换）。
//
// 对 37 个 file transform 逐个回答「如何撤销」：
//   - npm-ci 可恢复：目标都在 node_modules/@deepseek-ai 包内，重装即回
//     pristine（全部 file 补丁皆然——这也是 rc.2→rc.8 升级后补丁自然退役
//     的机制）；
//   - 机械可逆（inverse-replace）：实现源码中同时存在 OLD/FROM 与 NEW/TO
//     常量对，反向 replace 即可精确回滚（无需重装）；
//   - marker 定位回滚（marker-excise）：无 FROM/TO 对，但注入体以 marker
//     注释开头 / 含 marker，可按 marker 定位挖除注入块；
//   - 多点注入：一次 transform 改多处（回滚需逐点处理）。
//
// 审计约束（守卫价值）：
//   1. 分类必须覆盖全部 37 个 file transform（无「无法回滚」盲区）；
//   2. 每个带 marker 的 transform，marker 必须能定位回滚点（marker 出现在
//      其 changed 产物中——用 pristine 实跑验证）；
//   3. root 应用器（14 个）只碰 node_modules 内文件 → npm ci 可整体恢复。
//      （v0.5.4：+pi-ai-credits / pi-ai-reasoning-defaults / bundle-arrival-retry×2
//       / agent-loop-scheduler-guard×2 共 4 枚 root 应用器。）
// ---------------------------------------------------------------------------

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { PATCH_SPECS } = require('../lib/patch-registry');

const LIB_DIR = path.join(__dirname, '..', 'lib');
const IMPL_SOURCES = [
  path.join(LIB_DIR, 'runtime-patches.js'),
  path.join(LIB_DIR, 'patch-adapters.js'),
  path.join(LIB_DIR, 'loader-isolation.js'),
  path.join(__dirname, '..', 'patch-session-manage.js'),
  path.join(__dirname, '..', '..', 'profile-bundle-heal.js'),
].map((f) => { try { return fs.readFileSync(f, 'utf8'); } catch { return ''; } });

// pristine 靶点定位统一走 pristine-kernel-roots（候选闭包树 → 内核构建产物 →
// 桌面壳独有依赖）。过去这里自己抄了一份 .tmp-rc2-stage 路径且用裸 readdirSync：
// 该一次性装配树被清理后，本文件不是「诚实报错」而是直接 ENOENT 崩掉，
// 把整份回滚审计报告一起吞了。
const { findPristineTarget, describePristineRoots, specTargetVendored, specVendoredSkipReason } = require('../lib/pristine-kernel-roots');

function firstTargetFile(spec) {
  return findPristineTarget(spec);
}

/** 分类：实现源码是否为该 spec 提供了 FROM/OLD → NEW/TO 常量对（按 marker
 * 关联的注释常量名启发式识别）。 */
const INVERSE_PAIR_HINTS = {
  // id: [OLD/FROM 常量片段, NEW/TO 常量片段]（在实现源码文本中出现即可判
  // 机械可逆——常量对本身就是反向 replace 的全部输入）。
  'runtime-flash-fix': ['FLASH_OLD', 'FLASH_NEW'],
  'profile-patch-guard': ['PROFILE_PATCH_GUARD_CALL_SITE', 'PROFILE_PATCH_GUARD_CALL_REPLACEMENT'],
  'settings-section-guard': ['SETTINGS_SECTION_FROM', 'SETTINGS_SECTION_GUARDED'],
  'plugin-inventory-tab-merge': ['PLUGIN_INVENTORY_TAB_OLD', 'PLUGIN_INVENTORY_TAB_NEW'],
  'persistent-shell-abort-race': ['PERSISTENT_ABORT_RACE_ANCHOR', 'persistentAbortRaceInjection'],
  'terminal-interrupt-escalation': ['INTERRUPT_ESCALATION_ANCHOR', 'INTERRUPT_ESCALATION_INJECTION'],
  'agent-preset-fallback': ['AGENT_PRESET_FALLBACK_ANCHOR', 'AGENT_PRESET_FALLBACK_INJECTION'],
  'prompt-context-literal': ['PROMPT_CONTEXT_LITERAL_ANCHOR', 'PROMPT_CONTEXT_LITERAL_INJECTION'],
  'fallback-heal-isolation': ['FALLBACK_HEAL_LOOP_OLD', 'FALLBACK_HEAL_LOOP_NEW'],
  'credentials-initial-retry': ['CREDENTIALS_LOAD_INITIAL_OLD', 'CREDENTIALS_LOAD_INITIAL_NEW'],
  'credentials-absent-guidance': ['CREDENTIALS_ABSENT_OLD', 'CREDENTIALS_ABSENT_NEW'],
  'device-auth-guidance': ['DEVICE_AUTH_THROW_ANCHOR_V2', 'deviceAuthGuidanceBlock'],
  'slot-legacy-key': ['SLOT_KEY_COMPAT_OLD', 'SLOT_KEY_COMPAT_NEW'],
  'slot-unkeyed-compat': ['SLOT_UNKEYED_COMPAT_OLD', 'SLOT_UNKEYED_COMPAT_NEW'],
  'shell-description-compat': ['SHELL_DESC_VALIDATE_OLD', 'SHELL_DESC_VALIDATE_NEW', 'SHELL_DESC_SCHEMA_OLD', 'SHELL_DESC_SCHEMA_OPTIONAL', 'RUNCODE_VALIDATE_OLD', 'RUNCODE_VALIDATE_NEW', 'RUNCODE_SCHEMA_OLD', 'RUNCODE_SCHEMA_OPTIONAL'],
  'attachment-mime-trust': ['ATTACH_MIME_OLD', 'ATTACH_MIME_NEW'],
  'content-has-image-guard': ['CONTENT_HAS_IMAGE_OLD', 'CONTENT_HAS_IMAGE_NEW', 'TOOLS_IMAGE_RESULT_OLD', 'TOOLS_IMAGE_RESULT_NEW'],
  'session-load-graceful': ['SESSION_LOAD_GRACEFUL_DECODER_OLD', 'SESSION_LOAD_GRACEFUL_DECODER_NEW'],
  'workspace-chip-label-hold': ['WORKSPACE_CHIP_LABEL_ANCHOR', 'WORKSPACE_CHIP_LABEL_NEW'],
};

const MULTI_SITE = new Set([
  'credentials-initial-retry', // 3 处替换（首读/stat/helpers 追加）
  'slot-error-isolation',      // 三分支（原始 throw / v1 修复×2）
  'adapter-prepare-call-guard', // 双调用点替换 + 方法注入（prepareCall/adapterStream）
  'session-header-scan-guard', // 四点注入（模块级缓存 / helper 方法 / 读行 / 读上限）
  'session-load-graceful',     // 四点注入（hoist / scanner 赋值 / 计数 / catch 降级）
  'skill-dirs-compat',        // 三点注入（import 扩 delimiter / 构造器 env 并入 / roots 追加）
  'content-has-image-guard',  // 多靶：dsh-llm contentHasImage + dsh-tools result.content.some
  'shell-description-compat',  // 多点：shell(pwsh/bash) + run_code(dsh-tools) 各 schema 删 required:true + validate 兜底
  'chat-scroll-autoload-older', // 双注入：ChatView 内 useRef+useEffect(IO) + flow column 哨兵 div
  'pi-ai-responses-tool-name-sanitize', // 六点注入：出站 grammar/function 分支 + 回放两处 + 入站两处槽位
  'pi-ai-tool-name-wire', // 三点注入：toolsOf 出站洗名 + 回程两处 case "tool-call" 还原
]);

const fileSpecs = PATCH_SPECS.filter((s) => s.kind === 'file');
const rootSpecs = PATCH_SPECS.filter((s) => s.kind === 'root');

// 靶包不在 vendor/dsh-kernel 离线内核闭包内的 marker transform：其 pristine 源在离线解包
// 树里天然不存在（cordis-plugin-loader 是 @deepseek-ai scope 的 registry 发布包；@openai/codex
// 与 @earendil-works/pi-ai 是宿主可选依赖）。审计 2 对它们诚实跳过（无源可依），并集中在此
// 断言集合恰为这 6 条，防止误扩成「整组静默停摆」。
// 第 5 条来源：pi-ai-responses-tool-name-sanitize（靶 openai-responses-shared.js，
// 与同包 completions 净化补丁一样落在离线内核闭包之外）。
// 第 6 条来源：pi-ai-quota-not-retryable（靶 @earendil-works/pi-ai/dist/utils/
// provider-retry.js，同包第三条非闭包靶）。
// 0.1.6 迁移（2026-09-15）：loader-tree-isolation 移出——其靶 cordis-plugin-loader
// 已被上游收编进 vendor/dsh-kernel（@deepseek-ai/cordis-plugin-loader@1.0.3），
// 转入离线闭包，故非闭包集合 6→5。
const EXPECTED_NON_VENDORED = [
  'codex-local-bin-fallback',
  'pi-ai-4xx-dump',
  'pi-ai-quota-not-retryable',
  'pi-ai-responses-tool-name-sanitize',
  'pi-ai-tool-schema-sanitize',
];

// 44 = 43（上一基线）+ 1 项新增（released-v0-history-recovery：靶 dsh-session-format-v0-to-v1
// 的 released-v0 准入清单扩容，带 RELEASED_V0_HISTORY_MARKER → 回滚策略 marker-excise，
// 且属 npm-ci 可恢复的 node_modules 内文件，不引入回滚盲区）。
// 45 = 44 + 1 项新增（pi-ai-responses-tool-name-sanitize：靶 @earendil-works/pi-ai 的
// openai-responses-shared.js，带 marker → 同为 marker-excise 回滚 + npm-ci 可恢复，
// 多点注入（6 落点）故列入 MULTI_SITE）。
// 46 = 45 + 1 项新增（pi-ai-tool-name-wire：靶 @deepseek-ai/dsh-llm-pi-ai/lib/index.js
// 的工具名 wire 中央收口，带 marker → marker-excise 回滚 + npm-ci 可恢复，三处注入
// （toolsOf 出站 + 回程两处 tool-call）故列入 MULTI_SITE）。
// 47 = 46 + 1 项新增（pi-ai-quota-not-retryable：靶 @earendil-works/pi-ai/dist/utils/
// provider-retry.js 的 isRetryableProviderError，注入 helper + 配额判定，
// 带 marker → marker-excise 回滚 + npm-ci 可恢复）。
test('审计 1：分类覆盖全部 47 个 file transform（无回滚盲区）', () => {
  assert.equal(fileSpecs.length, 47);
  const report = [];
  for (const spec of fileSpecs) {
    const pair = INVERSE_PAIR_HINTS[spec.id];
    const inverse = pair && pair.every((name) => IMPL_SOURCES.some((t) => t.includes(name)));
    const strategy = inverse ? 'inverse-replace'
      : spec.marker ? 'marker-excise' : 'manual';
    report.push(`${spec.id}: ${strategy}${MULTI_SITE.has(spec.id) ? ' (multi-site)' : ''}`);
  }
  // 全部为 npm-ci 可恢复（node_modules 内）+ 三档回滚策略之一。
  for (const spec of fileSpecs) {
    assert.ok(
      INVERSE_PAIR_HINTS[spec.id] || spec.marker,
      `${spec.id} 既无 FROM/TO 常量对也无 marker：无法定位回滚点（盲区）`,
    );
  }
  console.log('[TA6 回滚审计清单]');
  for (const line of report) console.log('  ' + line);
});

test('审计 2：带 marker 的 transform，其 changed 产物含 marker（回滚定位点）', () => {
  const honestSkip = [];
  for (const spec of fileSpecs) {
    if (!spec.marker) continue;
    // 靶包不在离线内核闭包（registry/宿主可选依赖）：无 pristine 源 → 诚实跳过并点名，
    // 既不为 loader-tree-isolation 硬红，也不让 codex/pi-ai 靠 dsh-desktop/node_modules
    // 已补丁副本走 already 分支吞掉 marker 校验（假绿）。
    if (!specTargetVendored(spec)) { honestSkip.push(`${spec.id} — ${specVendoredSkipReason(spec)}`); continue; }
    const file = firstTargetFile(spec);
    assert.ok(file, `${spec.id} 缺 pristine 目标（可用根：${describePristineRoots()}）`);
    const src = fs.readFileSync(file, 'utf8');
    const r = spec.transform(src, file);
    if (r.status === 'changed') {
      assert.ok(
        r.src.includes(spec.marker),
        `${spec.id} changed 产物必须含 marker（回滚定位点缺失）`,
      );
    }
    // already / anchor-missing（退役态）无产物，无回滚需求。
  }
  console.log('[TA6 审计 2 诚实跳过：靶包不在离线内核闭包、无 pristine 源]');
  for (const line of honestSkip) console.log('  SKIP ' + line);
});

test('审计 5：诚实跳过集合恰为已知 6 条非闭包 marker transform（防静默停摆）', () => {
  const actual = fileSpecs.filter((s) => s.marker && !specTargetVendored(s)).map((s) => s.id).sort();
  assert.deepEqual(actual, [...EXPECTED_NON_VENDORED].sort(),
    `非闭包（诚实 SKIP）集合漂移：实际=[${actual}]，基线=[${EXPECTED_NON_VENDORED}]。`
    + '扩大=有真·内核靶掉出闭包（查 patch-target-resolver / vendor / kernel-pin）；收缩=有 registry 包被塞进闭包');
});

test('审计 3：root 应用器只碰 node_modules（npm ci 整体可恢复）', () => {
  // 17 = 16（旧基线）+ model-image-input（模型卡「支持图片输入」勾选，同靶
  // dsh-client-ui-settings-models 的另一区段，仍只写 nm-roots 三棵树）。
  assert.equal(rootSpecs.length, 17);
  for (const spec of rootSpecs) {
    assert.equal(spec.layout, 'nm-roots', `${spec.id} 应为 nm-roots 布局`);
    assert.equal(spec.wslLayout, 'nm-roots', `${spec.id} WSL 布局也应为 nm-roots`);
  }
});

test('审计 4（发现记录）：无 marker 的 file transform 依赖产物形态做幂等判定', () => {
  // 无 marker 的补丁（marker: null）幂等判定靠「产物特征文本」而非 marker，
  // 回滚时无法用 marker 扫描定位——须依赖 FROM/TO 反向替换或重装。
  const noMarker = fileSpecs.filter((s) => !s.marker).map((s) => s.id);
  const expectedNoMarker = [
    'runtime-flash-fix', 'shell-description-compat', 'attachment-mime-trust',
  ];
  assert.deepEqual(noMarker, expectedNoMarker, '无 marker 补丁清单漂移（新无 marker 补丁需补审计）');
});
