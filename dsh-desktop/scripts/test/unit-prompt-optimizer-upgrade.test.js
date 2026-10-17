'use strict';

// ---------------------------------------------------------------------------
// unit-prompt-optimizer-upgrade.test.js
//
// dsh-prompt-optimizer 升级线的机器锁（2.1.0 + 2.2.0 + 2.2.1 + 2.3.0 + 2.4.0，2026-10-17）。
//
// 升级内容（细节见插件内 CHANGELOG 2.4.0/2.3.0/2.2.1/2.2.0/2.1.0 段）：
//   2.4.0 · 上一轮对话上下文 + 可核对意图行 + 一键撤销 + 草稿字数门 + 陈旧响应代际
//           守卫（宿主 `history` 端点读 `deriveMessages()`／冷回落 sessionPersistence，
//           src 侧新增 conversation-context.ts / intent-line.ts / undo-bus.ts，并把
//           写回草稿的通道从 PreviewCard 收敛成 composer.ts）；行为面回归锁另见
//           unit-prompt-optimizer-context-intent.test.js；
//   2.3.0 · 项目优化目标（src/project-goal.ts + lib 半边 projectGoal.get/set + 设置行区块）：
//           用户为本项目写下的优化目标按项目持久（~/.dsh/prompt-optimizer-projects.json，
//           键 = 会话头 cwd），叠加进创作型任务的系统提示词（repair 排除）；行为面回归锁
//           另见 unit-prompt-optimizer-project-goal.test.js；
//   2.2.1 · Lexical 写回修复（PreviewCard）：多行结果「替换草稿」无反应——旧通道
//           select-all + execCommand('insertText') 被 Chromium 拆行后 Lexical 吞掉
//           8+ 行、整段静默失败；改走编辑器自己的粘贴通道。行为面回归锁另见
//           unit-prompt-optimizer-lexical-write.test.js；
//   2.2.0 · 校验内核（src/validators.ts）：原文的围栏代码块/{{变量}}/URL/文件
//           路径必须在结果里逐字保留——代码断言替掉「请自检」；有缺失触发一次
//           有界修复（repair 任务、{optimizedPrompt, missing} 信封、卡片残留计数）；
//   2.2.0 · 引导卡顺序修复：配置缺失时 guide 先于 begin 派发（旧序被 reducer 在
//           optimizing 态忽略，卡片卡在「正在优化…」）；
//   2.1.0 · 系统提示词重写，机制对齐 linshenkx/prompt-optimizer 的公开实践——任务/
//           执行分离、JSON 证据框定 + 反注入、显式工作流、具体修复项、反例校准、
//           逐字保留自检；预览卡新增「迭代细化」（iterate）与「展开为结构化」
//           （structure）；修复错误卡渲染即崩（`errorDetail` 未解构 → ReferenceError
//           被错误边界吞掉）；
//   随包携带 src/（20 文件）+ scripts/build.mjs，dist 可本地重建。
//
// 本文件锁五件事（每件各配一条反证，防判据空转）：
//   ① 交付形态：src/ 与构建脚本在位，且 dist 里 load id 仍是包名（2.0.4 那次
//      「loaded without registering」事故的直接防线）；
//   ② src ↔ dist 同源：产物内联 sourcemap 的 sourcesContent 与磁盘 src 逐字节
//      一致——改了 src 不回填产物（或反向）即红，杜绝「源码说一套、产物跑一套」；
//   ③ 升级标记可寻址：任务/执行分离句、四任务证据键（含 repair 信封）、迭代/
//      结构化/修复 UI 文案在产物（非转义形态，esbuild 默认把非 ASCII 写成 \uXXXX）里在位；
//   ④ 版本自洽：package.json 版本 == CHANGELOG.md 顶部版本段；
//   ⑤ 引导顺序：store 里 guide 派发先于 begin（配置缺失不得被 optimize 吞掉）。
//
// 运行：node --test scripts/test/unit-prompt-optimizer-upgrade.test.js
//（纯文本/字节对账，不依赖 DOM / 内核 / 网络。）
// ---------------------------------------------------------------------------

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const DSH = path.resolve(__dirname, '..', '..');
const PKG_DIR = path.join(DSH, 'assets', 'plugins', 'dsh-prompt-optimizer');
const DIST = path.join(PKG_DIR, 'dist', 'client.js');

const SRC_FILES = [
  'OptimizeButton.tsx',
  'PreviewCard.tsx',
  'SettingsRow.tsx',
  'composer.ts',
  'conversation-context.ts',
  'events.ts',
  'index.ts',
  'intent-line.ts',
  'locales.ts',
  'optimizer-store.ts',
  'optimizer.ts',
  'preview-bus.ts',
  'preview-state.ts',
  'project-goal.ts',
  'session-optimizer.ts',
  'settings-epoch.ts',
  'settings-form-state.ts',
  'settings-store.ts',
  'undo-bus.ts',
  'validators.ts',
];

const distText = () => fs.readFileSync(DIST, 'utf8');

/** 解出产物内联 sourcemap（构建壳把 esbuild 输出嵌在工厂函数里，注释行不在文件末尾）。 */
function decodeSourcemap(bundle) {
  const m = bundle.match(/\/\/# sourceMappingURL=data:application\/json;base64,([A-Za-z0-9+/=]+)/);
  assert.ok(m, '产物缺少内联 sourcemap——build.mjs 的 sourcemap:"inline" 契约被破坏');
  return JSON.parse(Buffer.from(m[1], 'base64').toString('utf8'));
}

/** 对账函数（被测对象；反证用例对它做变异注入）。返回不匹配清单。 */
function collectSourceMismatches(bundle) {
  const map = decodeSourcemap(bundle);
  const rows = [];
  for (let i = 0; i < map.sources.length; i += 1) {
    const src = map.sources[i];
    const content = map.sourcesContent ? map.sourcesContent[i] : null;
    const abs = path.resolve(PKG_DIR, 'dist', src);
    if (!fs.existsSync(abs)) {
      rows.push(`${src}: 磁盘缺失`);
      continue;
    }
    const disk = fs.readFileSync(abs, 'utf8');
    if (content !== disk) rows.push(`${src}: sourcesContent 与磁盘不一致`);
  }
  return rows;
}

/** esbuild 默认把非 ASCII 转义成 \\uXXXX（大写十六进制）；两种形态都要能寻址。 */
const escaped = (s) =>
  s.replace(/[^\x20-\x7e]/g, (c) => '\\u' + c.charCodeAt(0).toString(16).toUpperCase().padStart(4, '0'));
const hasMarker = (bundle, s) => bundle.includes(s) || bundle.includes(escaped(s));

test('交付形态：src/ 20 个源文件与 scripts/build.mjs 在位，dist 里 load id 仍是包名', () => {
  for (const f of SRC_FILES) {
    assert.ok(fs.existsSync(path.join(PKG_DIR, 'src', f)), `src/${f} 不在位——交付形态破了`);
  }
  assert.ok(fs.existsSync(path.join(PKG_DIR, 'scripts', 'build.mjs')), 'scripts/build.mjs 不在位');
  const bundle = distText();
  assert.ok(
    bundle.includes('window.__ModuleLoader__.load({'),
    '产物未走官方 ModuleLoader 注册壳',
  );
  // 2.0.4 事故的直接防线：注册键必须等于包名（内核 boot graph 行以包名为键）
  assert.ok(
    bundle.includes('id: "dsh-prompt-optimizer"'),
    '产物注册 id 不等于包名——内核侧会报 loaded without registering',
  );
});

test('src ↔ dist 同源：内联 sourcemap 的 sourcesContent 与磁盘逐字节一致', () => {
  const bundle = distText();
  const map = decodeSourcemap(bundle);
  // 样本量哨兵：19 个源文件应全部进入打包（20 个文件里 settings-epoch.ts 只供类型引用，可被剥离）
  assert.ok(map.sources.length >= 19, `sourcemap 只含 ${map.sources.length} 个源，疑似构建面破损`);
  const srcKeys = map.sources.map((s) => path.basename(s));
  for (const key of [
    'optimizer.ts',
    'optimizer-store.ts',
    'PreviewCard.tsx',
    'locales.ts',
    'index.ts',
    'validators.ts',
    'composer.ts',
    'conversation-context.ts',
    'intent-line.ts',
    'undo-bus.ts',
  ]) {
    assert.ok(srcKeys.includes(key), `sourcemap 缺少关键源 ${key}`);
  }
  // 形状判据：sources 必须全是相对 outfile 的 ../src/*（换成绝对路径/沙箱路径即红）
  const weird = map.sources.filter((s) => !/^\.\.\/src\/[\w.-]+\.(ts|tsx)$/.test(s));
  assert.deepEqual(weird, [], `sourcemap sources 出现非 ../src/* 形态条目：${weird.join(', ')}`);
  assert.deepEqual(collectSourceMismatches(bundle), [], 'src 与 dist 不同源——改源后必须重跑 scripts/build.mjs 回填');
});

test('反证：同源判据不是空转——单字节变异与删文件都必须报红', () => {
  const bundle = distText();
  const map = decodeSourcemap(bundle);
  // 变异 1：把一个源的 sourcesContent 改一个字节 → 必须报不一致
  const mutated = JSON.parse(JSON.stringify(map));
  const idx = mutated.sources.findIndex((s) => path.basename(s) === 'optimizer.ts');
  assert.ok(idx >= 0, '样本源不在 sourcemap 里');
  mutated.sourcesContent[idx] = mutated.sourcesContent[idx].replace('你的任务', '你的任XX');
  const fakeBundle = (b) => b.replace(
    /\/\/# sourceMappingURL=data:application\/json;base64,[A-Za-z0-9+/=]+/,
    '//# sourceMappingURL=data:application/json;base64,' + Buffer.from(JSON.stringify(mutated)).toString('base64'),
  );
  const rows = collectSourceMismatches(fakeBundle(bundle));
  assert.ok(
    rows.some((r) => r.includes('optimizer.ts')),
    '单字节变异没有被同源判据抓到——判据空转',
  );
  // 变异 2：把 sources 指到一个磁盘上不存在的文件 → 必须报缺失
  const ghost = JSON.parse(JSON.stringify(map));
  ghost.sources[0] = '../src/ghost-file.ts';
  const ghostBundle = (b) => b.replace(
    /\/\/# sourceMappingURL=data:application\/json;base64,[A-Za-z0-9+/=]+/,
    '//# sourceMappingURL=data:application/json;base64,' + Buffer.from(JSON.stringify(ghost)).toString('base64'),
  );
  assert.ok(
    collectSourceMismatches(ghostBundle(bundle)).some((r) => r.includes('磁盘缺失')),
    '幽灵源文件没被同源判据抓到——判据空转',
  );
});

test('升级标记：任务/执行分离、四任务证据键（含 repair 信封）、迭代/结构化/修复 UI 文案在产物里在位', () => {
  const bundle = distText();
  const markers = [
    // 任务/执行分离（八套提示词的共同机制）
    '不要执行',
    'not to answer or execute',
    // 任务专属标记（polish / iterate / structure / repair）
    '迭代细化',
    '结构化展开',
    '# 任务',
    '最小修复', // repair 系统提示词（zh）：最小修复 + 逐字恢复
    '逐字恢复',
    'Verbatim restore', // repair 系统提示词（en）
    // 证据键（JSON 框定）
    'originalPrompt',
    'lastOptimizedPrompt',
    'iterateInput',
    'optimizedPrompt', // repair 信封：待修复全文
    // 校验内核入口（函数名不做 minify，可寻址）
    'validatePreservation',
    // 迭代/结构化/修复 UI
    'dsh-po-card-iter',
    'card.structure',
    'dsh-po-card-note', // 残留计数样式类
    'card.step.repair', // 「正在修复未保留内容…」文案键
    'card.note.missing', // 「N 处内容未能逐字保留」文案键
    // 项目优化目标（2.3.0）：目标段标题（zh/en）、通道端点、卡片标记、设置行文案键
    '项目优化目标',
    'Project optimization goal',
    'projectGoal.get',
    'projectGoal.set',
    'goalApplied',
    '已应用项目目标',
    'card.goalTag',
    'settings.projectGoalTitle',
    // 上下文 + 意图 + 撤销（2.4.0）：证据键、上下文规则、卡片/按钮文案键与样式类、
    // 三条纯函数入口名（不做 minify，可寻址）
    'recentConversation',
    'conversationSection',
    '消解指代与省略',
    'card.contextTag',
    '已读上一轮对话',
    'card.intentLabel',
    'dsh-po-card-intent',
    'splitIntent',
    'contextApplied',
    'button.undo',
    'triggerBlock',
    'undoTargetFor',
    'DRAFT_MIN_CHARS',
    // 真机实测补的两条：composer 观察落点（Lexical 改文本不派发任何事件）与「门只解释、
    // 不加锁」的观测位——缺一条就是把主操作交给一个会陈旧的快照
    'observeComposerText',
    'findComposerHost',
    'data-block',
    // max_tokens 升级（结构化展开余量）
    'max_tokens: 4096',
  ];
  for (const marker of markers) {
    assert.ok(hasMarker(bundle, marker), `产物缺少升级标记：${JSON.stringify(marker)}`);
  }
});

test('errorDetail 修复：解构绑定在使用点两边都在位（src 与 dist 同时锁）', () => {
  const src = fs.readFileSync(path.join(PKG_DIR, 'src', 'PreviewCard.tsx'), 'utf8');
  assert.match(
    src,
    /const \{[^}]*\berrorDetail\b[^}]*\} = state;/,
    'src 里 errorDetail 未被解构——错误分支渲染即 ReferenceError（被错误边界吞掉 = 卡片凭空消失）',
  );
  assert.ok(src.includes("className=\"dsh-po-card-err-detail\""), 'src 里错误详情行不在位');
  const bundle = distText();
  assert.match(bundle, /\{[^{}]*\berrorDetail\b[^{}]*\}\s*=/, '产物里 errorDetail 没有解构绑定');
  assert.ok(bundle.includes('dsh-po-card-err-detail'), '产物里错误详情行不在位');
});

test('版本自洽：package.json 版本 == CHANGELOG.md 顶部版本段', () => {
  const pkg = JSON.parse(fs.readFileSync(path.join(PKG_DIR, 'package.json'), 'utf8'));
  const changelog = fs.readFileSync(path.join(PKG_DIR, 'CHANGELOG.md'), 'utf8');
  const m = changelog.match(/^## (\d+\.\d+\.\d+)\s*$/m);
  assert.ok(m, 'CHANGELOG 顶部没有版本段');
  assert.equal(pkg.version, m[1], 'package.json 版本与 CHANGELOG 顶部版本段不一致');
  assert.equal(pkg.version, '2.4.0', '升级线版本应为 2.4.0（再 bump 时同步改本行与交付面文档）');
});

/** 引导顺序判据（被测对象；反证用例对它做顺序交换注入）。 */
function guideBeforeBegin(text) {
  const guideIdx = text.indexOf("type: 'guide'");
  const beginIdx = text.indexOf("type: 'begin'");
  return guideIdx >= 0 && beginIdx >= 0 && guideIdx < beginIdx;
}

test('引导顺序锁：src 里 guide 派发先于 begin（配置缺失不被 optimizing 吞掉）', () => {
  const src = fs.readFileSync(path.join(PKG_DIR, 'src', 'optimizer-store.ts'), 'utf8');
  assert.ok(
    guideBeforeBegin(src),
    'guide 在 begin 之后派发——reducer 只在非 optimizing 态接受 guide，'
      + 'fetch 通道配置缺失时卡片会卡在「正在优化…」永不显示引导卡',
  );
});

test('反证：引导顺序判据不是恒真——交换顺序必须报红', () => {
  const swapped = "dispatchPreview({ type: 'begin' }); dispatchPreview({ type: 'guide' });";
  assert.equal(guideBeforeBegin(swapped), false, '交换后判据仍为真——判据空转');
  assert.equal(guideBeforeBegin('只有一条派发'), false, '缺失派发点未报红——判据空转');
});

test('反证：升级标记判据不是恒真——不存在的中文串必须报 MISS', () => {
  const bundle = distText();
  assert.equal(hasMarker(bundle, '绝不存在于本插件的中文串XX'), false, '标记寻址恒真——判据空转');
  assert.equal(bundle.includes('.tmp-po-build'), false, '产物泄漏了构建沙箱路径');
});
