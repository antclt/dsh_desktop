'use strict';

// plugin-sync（createPluginSync）单元测试（node --test）。
// 覆盖：healProfilePatch / healHomePatch 的「解析失败 → 备份 + 重置最小文件 +
// onHealReset(kind, backup) 回调」，自愈幂等（签名命中 memo 不重复自愈），
// 以及 logProfileBundleHealth 的只读健康检查（不抛异常）。
//
// 隔离：getHome / getUserDataDir 均注入 mkdtemp 临时目录，绝不触碰真实 ~/.dsh；
// loadYaml 用真实 js-yaml entry-list 方言解析器（createEntryListYamlParser），
// 保证「损坏文件触发解析失败」是真实验证而非 mock 橡皮图章。

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { createPluginSync } = require('../integration/plugin-sync');
const { createEntryListYamlParser } = require('../lib/profile-reconcile');

/** 构造隔离的 createPluginSync ctx（heal / health 均只依赖 getHome/getUserDataDir/log/loadYaml）。 */
function makePluginSyncCtx(t) {
  const h = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-plugin-sync-home-'));
  const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-plugin-sync-ud-'));
  const appDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-plugin-sync-app-'));
  t.after(() => {
    fs.rmSync(h, { recursive: true, force: true });
    fs.rmSync(userDataDir, { recursive: true, force: true });
    fs.rmSync(appDir, { recursive: true, force: true });
  });
  const parse = createEntryListYamlParser(); // 真实 js-yaml（可用时为函数，否则 null）
  const logs = [];
  const resets = [];
  const ctx = {
    getHome: () => h,
    appDir,
    getUserDataDir: () => userDataDir,
    log: (m) => logs.push(m),
    loadYaml: () => (parse ? { load: (c) => parse(c) } : null),
    loadSettings: () => ({}),
    saveSettings: () => {},
    getInstallAnchorDir: () => path.join(os.tmpdir(), 'dsh-no-anchor'),
    onHealReset: (kind, backup) => resets.push({ kind, backup }),
  };
  return { ctx, h, userDataDir, logs, resets };
}

test('healProfilePatch：cordis.patch.yml 解析失败 → 备份 + 重置最小文件 + onHealReset(profile, backup)', (t) => {
  const { ctx, h, resets } = makePluginSyncCtx(t);
  const file = path.join(h, 'profiles', 'web', 'cordis.patch.yml');
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, '- id: [\n'); // 损坏：js-yaml 解析抛错（未闭合 flow sequence）

  const { healProfilePatch } = createPluginSync(ctx);
  healProfilePatch();

  // 备份文件存在（.broken- 随机后缀），且内容为原损坏文本。
  const backups = fs.readdirSync(path.dirname(file)).filter((n) => n.startsWith('cordis.patch.yml.broken-'));
  assert.equal(backups.length, 1, '应生成一个 .broken- 备份文件');
  const backup = path.join(path.dirname(file), backups[0]);
  assert.equal(fs.readFileSync(backup, 'utf8'), '- id: [\n', '备份内容应为原损坏内容');

  // 写回最小文件（含 []）。
  const content = fs.readFileSync(file, 'utf8');
  assert.ok(content.includes('[]'), '重置文件应含顶层空数组 []');
  assert.ok(content.includes('recovered by DSH Desktop'), '重置文件应含 recovered 头部');

  // onHealReset 回调。
  assert.equal(resets.length, 1, 'onHealReset 应被调用一次');
  assert.equal(resets[0].kind, 'profile');
  assert.equal(resets[0].backup, backup);
});

test('healHomePatch：家级 cordis.patch.yml 解析失败 → 备份 + 重置 + onHealReset(home, backup)', (t) => {
  const { ctx, h, resets } = makePluginSyncCtx(t);
  const file = path.join(h, 'cordis.patch.yml');
  fs.writeFileSync(file, '- id: [\n');

  const { healHomePatch } = createPluginSync(ctx);
  healHomePatch();

  const backups = fs.readdirSync(h).filter((n) => n.startsWith('cordis.patch.yml.broken-'));
  assert.equal(backups.length, 1, '应生成一个 .broken- 备份文件');
  const backup = path.join(h, backups[0]);
  assert.equal(fs.readFileSync(backup, 'utf8'), '- id: [\n', '备份内容应为原损坏内容');

  const content = fs.readFileSync(file, 'utf8');
  assert.ok(content.includes('[]'), '重置文件应含顶层空数组 []');

  assert.equal(resets.length, 1, 'onHealReset 应被调用一次');
  assert.equal(resets[0].kind, 'home');
  assert.equal(resets[0].backup, backup);
});

test('healProfilePatch：自愈后签名（含 hash）未变 → 第二次调用不重复自愈', (t) => {
  const { ctx, h, resets } = makePluginSyncCtx(t);
  const file = path.join(h, 'profiles', 'web', 'cordis.patch.yml');
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, '- id: [\n');

  const { healProfilePatch } = createPluginSync(ctx);
  healProfilePatch(); // 第一次：触发自愈，记录签名
  assert.equal(resets.length, 1, '首次应触发一次自愈');

  healProfilePatch(); // 第二次：签名命中 memo，跳过
  assert.equal(resets.length, 1, '第二次调用不得重复自愈（onHealReset 不触发）');
});

test('logProfileBundleHealth：健康 profile（空 bundles）不抛异常且不输出告警', (t) => {
  const { ctx, h, logs } = makePluginSyncCtx(t);
  const profileDir = path.join(h, 'profiles', 'web');
  fs.mkdirSync(profileDir, { recursive: true });
  fs.writeFileSync(path.join(profileDir, 'package.json'), JSON.stringify({ name: 'web', dsh: { profile: { bundles: [] } } }));

  const { logProfileBundleHealth } = createPluginSync(ctx);
  assert.doesNotThrow(() => logProfileBundleHealth(), '健康检查不得抛异常');
  assert.equal(logs.filter((m) => m.includes('缺失') || m.includes('不可用')).length, 0, '空 bundles 不应输出缺失/不可用告警');
});

test('logProfileBundleHealth：manifest 不可读 → 记录日志并早退（不抛）', (t) => {
  const { ctx, logs } = makePluginSyncCtx(t);
  // 不创建 profiles/web/package.json → manifest 不可读。

  const { logProfileBundleHealth } = createPluginSync(ctx);
  assert.doesNotThrow(() => logProfileBundleHealth(), 'manifest 缺失时不得抛异常');
  assert.ok(logs.some((m) => m.includes('manifest 不可读')), '应记录 manifest 不可读日志');
});

// ---------------------------------------------------------------------------
// 退役插件的 patch 行清理必须挂在【启动链】上，而不是只挂在独立 CLI 同步器上。
//
// 背景（实机）：老 profile 的 cordis.patch.yml 里残留 `- id: float-window` 行，
// 桌面启动链（sidecar boot → step('sync') → 本模块 sync()）不清理它，于是
// 每个 boot 周期刷一次 10 帧 `Cannot find package '@deepseek-ai/dsh-float-window'`
// 栈（用户日志 4 个 boot 周期各一次）。清理函数本身早就存在（companion-profile
// 导出，CLI 同步器在调），漏的是「启动链这个调用方」——而该文件注释明确写了
// 「patch 行由调用方清理」。覆盖安装新客户端即应自愈，不需要用户手改 profile。
// ---------------------------------------------------------------------------

/** 写一份带退役残留行的 profile patch（fixture 形态对齐 entry-list 顶层块）。 */
function writeRetiredProfile(h, extraRows = []) {
  const profileDir = path.join(h, 'profiles', 'web');
  fs.mkdirSync(profileDir, { recursive: true });
  const file = path.join(profileDir, 'cordis.patch.yml');
  fs.writeFileSync(file, [
    '# 老 profile 残留（退役插件）',
    '- insert:',
    '    - id: float-window',
    "      name: '@deepseek-ai/dsh-float-window'",
    '- insert:',
    '    - id: dsh-mini',
    "      name: '@deepseek-ai/dsh-mini'",
    ...extraRows,
    '',
  ].join('\n'));
  return { profileDir, file };
}

test('sync()：启动链清掉 profile 里残留的退役插件行（float-window / dsh-mini）', (t) => {
  const { ctx, h, logs } = makePluginSyncCtx(t);
  const { file } = writeRetiredProfile(h, [
    '- insert:',
    '    - id: side-session',
    "      name: '@dsh-external/dsh-side-session'",
  ]);

  createPluginSync(ctx).sync();

  const after = fs.readFileSync(file, 'utf8');
  assert.ok(!/^\s*-?\s*id:\s*float-window\b/m.test(after), 'float-window 行必须被启动链清掉（否则每 boot 报缺包）');
  assert.ok(!/^\s*-?\s*id:\s*dsh-mini\b/m.test(after), 'dsh-mini 行必须被清掉（同类缺口，一并补齐）');
  // 名字也要消失（覆盖 name-only 形态的残留行，不只 id 行）
  assert.ok(!after.includes('dsh-float-window'), 'float-window 的 name 引用不得残留');
  assert.ok(!after.includes('@deepseek-ai/dsh-mini'), 'dsh-mini 的 name 引用不得残留');
  assert.ok(logs.some((m) => m.includes('dsh-float-window')), '应留下 float-window 清理日志');
  assert.ok(logs.some((m) => m.includes('dsh-mini')), '应留下 dsh-mini 清理日志');
});

test('退役行清理器只删退役块：在役插件行必须原样留下（防过度删除）', () => {
  const { removeRetiredDshFloatWindowPatchRows, removeRetiredDshMiniPatchRows } =
    require('../lib/companion-profile');
  const fixture = [
    '# 老 profile 残留（退役插件）',
    '- insert:',
    '    - id: float-window',
    "      name: '@deepseek-ai/dsh-float-window'",
    '- insert:',
    '    - id: dsh-mini',
    "      name: '@deepseek-ai/dsh-mini'",
    '- insert:',
    '    - id: side-session',
    "      name: '@dsh-external/dsh-side-session'",
    '',
  ].join('\n');

  const fw = removeRetiredDshFloatWindowPatchRows(fixture);
  const mini = removeRetiredDshMiniPatchRows(fw.patch);
  assert.equal(fw.changed, true);
  assert.equal(mini.changed, true);
  assert.ok(!/id:\s*float-window\b/.test(mini.patch), 'float-window 块应被移除');
  assert.ok(!/@deepseek-ai\/dsh-mini/.test(mini.patch), 'dsh-mini 块应被移除');
  assert.ok(/id:\s*side-session\b/.test(mini.patch), '在役插件行不得被误删');
  assert.ok(/name:\s*'@dsh-external\/dsh-side-session'/.test(mini.patch), '在役行的 name 不得被误删');
});

test('sync()：退役行清理幂等（第二遍不再改写，也不报错）', (t) => {
  const { ctx, h } = makePluginSyncCtx(t);
  const { file } = writeRetiredProfile(h);

  const sync = createPluginSync(ctx).sync;
  sync();
  const once = fs.readFileSync(file, 'utf8');
  assert.doesNotThrow(() => sync(), '二遍不得抛异常');
  assert.equal(fs.readFileSync(file, 'utf8'), once, '二遍不得再改写文件');
});

test('启动链覆盖面：companion-profile 导出的每个 removeRetired*PatchRows 都必须在 sync() 里被调用', () => {
  const profileSrc = fs.readFileSync(path.join(__dirname, '..', 'lib', 'companion-profile.js'), 'utf8');
  const syncSrc = fs.readFileSync(path.join(__dirname, '..', 'integration', 'plugin-sync.js'), 'utf8');
  const names = [...profileSrc.matchAll(/^function (removeRetired\w*PatchRows)\s*\(/gm)].map((m) => m[1]);
  assert.ok(names.length >= 4, '至少应有 market / third-party-thinking / float-window / mini 四个退役行清理器，实得: ' + names.join(', '));
  const missing = names.filter((n) => !syncSrc.includes(n + '('));
  assert.deepEqual(
    missing,
    [],
    '以下退役行清理器未挂到启动链（老 profile 残留会每 boot 报缺包，只有 CLI 同步时才会被清）: ' + missing.join(', '),
  );
});
