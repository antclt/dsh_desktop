'use strict';

// profile-bundle-heal 单元测试：纯函数（bundlePatchRel / bundleEntryOf /
// verifyBundleDir / packageDirUpward / writeFileAtomic）与两个源码变换
// （app-boot / profile-boot）的幂等性、锚点匹配与语法有效性。变换针对
// vendored dsh built 文件（只读）；产出写入临时 .mjs 用 node --check 验证。
//
// 注意：集成测试（真实 Electron 启动）会把这些防护实际应用到 node_modules，
// 因此本测试对「文件已注入」与「文件未注入」两种状态都给出有意义断言：
// 未注入 → 变换必须命中锚点并产出合法语法；已注入 → 变换必须识别标记并
// 原样返回（幂等）。

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const {
  PROFILE_BUNDLE_GUARD_MARKER,
  PROFILE_BOOT_GUARD_MARKER,
  bundlePatchRel,
  bundleEntryOf,
  verifyBundleDir,
  packageDirUpward,
  scanProfileBundles,
  recoverManifestBundles,
  writeFileAtomic,
  applyAppBootBundleGuard,
  applyProfileBootBundleGuard,
  applyProfileBootHealGuard,
  PROFILE_BOOT_HEAL_MARKER,
} = require('../../profile-bundle-heal');

const repoRoot = path.resolve(__dirname, '..', '..');
const appBootFile = path.join(repoRoot, 'node_modules', '@deepseek-ai', 'dsh-app-boot', 'lib', 'index.js');
// 0.1.2-alpha.1：内核 profile-boot 产物文件名变化（BTzzdrGY 真实装配面 +
// x7_BzdeW 纯 re-export 存根），且真实面可能已被 boot 链打过补丁——glob 出
// 含装配面（loadOptionalPatches/loadUserPatchLayerSafe）的真实 bundle。
function findProfileBootFile() {
  const lib = path.join(repoRoot, 'node_modules', '@deepseek-ai', 'dsh', 'lib');
  const files = fs.readdirSync(lib).filter((f) => /^profile-boot-.*\.js$/.test(f));
  for (const f of files) {
    const src = fs.readFileSync(path.join(lib, f), 'utf8');
    if (src.includes('loadOptionalPatches') || src.includes('loadUserPatchLayerSafe')) return path.join(lib, f);
  }
  return files.length ? path.join(lib, files[0]) : null;
}
const profileBootFile = findProfileBootFile();

function syntaxCheck(name, src) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pbg-unit-'));
  const file = path.join(dir, name + '.mjs');
  fs.writeFileSync(file, src, 'utf8');
  try {
    execFileSync(process.execPath, ['--check', file], { stdio: 'pipe' });
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

function tmpFixture(files) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pbg-fix-'));
  for (const [rel, content] of Object.entries(files)) {
    const file = path.join(dir, ...rel.split('/'));
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, content, 'utf8');
  }
  return dir;
}

test('bundlePatchRel: 只接受非空字符串 patch 声明', () => {
  assert.equal(bundlePatchRel({ dsh: { bundle: { patch: './cordis.patch.yml' } } }), './cordis.patch.yml');
  assert.equal(bundlePatchRel({ dsh: { bundle: { client: './lib/client.js' } } }), '');
  assert.equal(bundlePatchRel({ dsh: { bundle: {} } }), '');
  assert.equal(bundlePatchRel({}), '');
  assert.equal(bundlePatchRel(null), '');
  assert.equal(bundlePatchRel({ dsh: { bundle: { patch: 123 } } }), '');
  assert.equal(bundlePatchRel({ dsh: { bundle: { patch: '' } } }), '');
  assert.equal(bundlePatchRel({ dsh: { bundle: { patch: '   ' } } }), '');
});

test('bundleEntryOf: exports["."] 优先，其次 main', () => {
  assert.equal(bundleEntryOf({ exports: { '.': './dist/index.js' } }), './dist/index.js');
  assert.equal(bundleEntryOf({ exports: { '.': { import: './dist/index.js' } } }), './dist/index.js');
  assert.equal(bundleEntryOf({ exports: { '.': { default: './dist/index.js' } } }), './dist/index.js');
  assert.equal(bundleEntryOf({ exports: { '.': { types: './dist/index.d.ts' } }, main: './dist/index.js' }), '', 'exports["."] 无 import/default 时 Node 无法 import 该包，入口判定为空');
  assert.equal(bundleEntryOf({ exports: ['./dist/index.js'] }), '');
  assert.equal(bundleEntryOf({ main: './lib/index.js' }), './lib/index.js');
  assert.equal(bundleEntryOf({}), '');
  assert.equal(bundleEntryOf(null), '');
});

test('verifyBundleDir: 健康目录通过，缺失/损坏逐项拒绝', () => {
  const ok = tmpFixture({
    'package.json': JSON.stringify({ name: 'x', main: 'dist/index.js', dsh: { bundle: { patch: './cordis.patch.yml' } } }),
    'cordis.patch.yml': '[]\n',
    'dist/index.js': 'export {};\n',
  });
  assert.deepEqual(verifyBundleDir(ok), { ok: true, reason: '' });

  const noPatchFile = tmpFixture({
    'package.json': JSON.stringify({ name: 'x', dsh: { bundle: { patch: './cordis.patch.yml' } } }),
  });
  const r1 = verifyBundleDir(noPatchFile);
  assert.equal(r1.ok, false);
  assert.match(r1.reason, /补丁层缺失/);

  const noEntry = tmpFixture({
    'package.json': JSON.stringify({ name: 'x', main: 'dist/index.js', dsh: { bundle: { patch: './cordis.patch.yml' } } }),
    'cordis.patch.yml': '[]\n',
  });
  const r2 = verifyBundleDir(noEntry);
  assert.equal(r2.ok, false);
  assert.match(r2.reason, /入口文件缺失/);

  const noDecl = tmpFixture({
    'package.json': JSON.stringify({ name: 'x', main: 'dist/index.js' }),
  });
  const r3 = verifyBundleDir(noDecl);
  assert.equal(r3.ok, false);
  assert.match(r3.reason, /未声明 dsh\.bundle\.patch/);

  // client bundle 入口（exports["./client"] 声明）：dshmarket 类插件装配时
  // client-modules 按该路径读客户端 bundle，缺失即 MissingClientBundleError。
  const withClient = tmpFixture({
    'package.json': JSON.stringify({ name: 'x', main: 'dist/index.js', dsh: { bundle: { patch: './cordis.patch.yml' } }, exports: { './client': './client/client.js' } }),
    'cordis.patch.yml': '[]\n',
    'dist/index.js': 'export {};\n',
    'client/client.js': 'export {};\n',
  });
  assert.deepEqual(verifyBundleDir(withClient), { ok: true, reason: '' });

  const noClientFile = tmpFixture({
    'package.json': JSON.stringify({ name: 'x', main: 'dist/index.js', dsh: { bundle: { patch: './cordis.patch.yml' } }, exports: { './client': './client/client.js' } }),
    'cordis.patch.yml': '[]\n',
    'dist/index.js': 'export {};\n',
  });
  const r5 = verifyBundleDir(noClientFile);
  assert.equal(r5.ok, false);
  assert.match(r5.reason, /client 入口缺失/);

  const badJson = tmpFixture({ 'package.json': '{"name": "x", BAD' });
  const r4 = verifyBundleDir(badJson);
  assert.equal(r4.ok, false);
  assert.match(r4.reason, /不可读或不是合法 JSON/);
});

test('packageDirUpward: 沿 node_modules 父目录链解析，未找到返回空串', () => {
  const base = tmpFixture({
    'node_modules/@scope/pkg/package.json': '{}',
  });
  assert.equal(packageDirUpward(path.join(base, 'a', 'b', 'c'), '@scope/pkg'), path.join(base, 'node_modules', '@scope', 'pkg'));
  assert.equal(packageDirUpward(path.join(base, 'a'), 'missing-pkg'), '');
});

test('writeFileAtomic: 落盘内容正确且不留 .tmp', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pbg-wa-'));
  const file = path.join(dir, 'package.json');
  writeFileAtomic(file, '{"a":1}\n');
  assert.equal(fs.readFileSync(file, 'utf8'), '{"a":1}\n');
  assert.equal(fs.existsSync(file + '.tmp'), false);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('scanProfileBundles: 只返回可装配的第三方 bundle，排除核心/配套/普通依赖/损坏包', () => {
  const base = tmpFixture({
    'node_modules/@dsh-external/tavily/package.json': JSON.stringify({ name: '@dsh-external/tavily', version: '1.2.3', main: 'lib/index.js', dsh: { bundle: { patch: './cordis.patch.yml' } } }),
    'node_modules/@dsh-external/tavily/cordis.patch.yml': '[]\n',
    'node_modules/@dsh-external/tavily/lib/index.js': 'export {};\n',
    'node_modules/@deepseek-ai/dsh-base/package.json': JSON.stringify({ name: '@deepseek-ai/dsh-base', version: '1.0.0', main: 'lib/index.js', dsh: { bundle: { patch: './cordis.patch.yml' } } }),
    'node_modules/@deepseek-ai/dsh-base/cordis.patch.yml': '[]\n',
    'node_modules/@deepseek-ai/dsh-base/lib/index.js': 'export {};\n',
    'node_modules/plain-lib/package.json': JSON.stringify({ name: 'plain-lib', version: '1.0.0' }),
    // 声明了 dsh.bundle 但补丁层/入口缺失：不得恢复登记
    'node_modules/broken-bundle/package.json': JSON.stringify({ name: 'broken-bundle', version: '1.0.0', dsh: { bundle: { patch: './cordis.patch.yml' } } }),
    'node_modules/bad-json/package.json': '{BAD',
  });
  const found = scanProfileBundles(path.join(base, 'node_modules'), new Set(['@deepseek-ai/dsh-base']));
  assert.deepEqual(found, [{ name: '@dsh-external/tavily', version: '1.2.3' }]);
  assert.deepEqual(scanProfileBundles(path.join(base, 'missing'), new Set()), []);
});

test('recoverManifestBundles: 追加缺失登记并补回 dependencies，保留既有顺序与内容', () => {
  const manifest = { name: 'dsh-profile-web', private: true, dsh: { profile: { bundles: ['@deepseek-ai/dsh-base', '@dsh-external/tavily'] } } };
  const recovered = recoverManifestBundles(manifest, [
    { name: '@dsh-external/tavily', version: '1.2.3' },
    { name: 'other-bundle', version: '2.0.0' },
  ]);
  assert.deepEqual(recovered, ['other-bundle']);
  assert.deepEqual(manifest.dsh.profile.bundles, ['@deepseek-ai/dsh-base', '@dsh-external/tavily', 'other-bundle']);
  assert.deepEqual(manifest.dependencies, { 'other-bundle': '2.0.0' });

  const m2 = { dsh: { profile: { bundles: [] } }, dependencies: { x: '' } };
  assert.deepEqual(recoverManifestBundles(m2, [{ name: 'x', version: '3.0.0' }]), ['x']);
  assert.deepEqual(m2.dependencies, { x: '3.0.0' });
  assert.deepEqual(m2.dsh.profile.bundles, ['x']);

  const m3 = { dsh: { profile: { bundles: ['a'] } }, dependencies: { a: '^1.0.0' } };
  assert.deepEqual(recoverManifestBundles(m3, [{ name: 'a', version: '9.9.9' }]), []);
  assert.deepEqual(m3.dependencies, { a: '^1.0.0' }, '既有依赖版本不得覆盖');
});

// 变换锚点合成源（必须与 profile-bundle-heal.js 内的锚点字节一致）。
// 0.1.5-rc.1：逐个 bundle 严格装配的 `bundles.map(...)` 块从 loadProfile 移进
// loadProfileDirectory(binName, dir, installAnchor, options)——该函数签名不再
// 有 name 形参（上游以 basename(dir) 派生 profile 名），合成源按新宿主包裹。
const SYNTHETIC_APP_LAYERS = [
  '\tconst layers = bundles.map((packageName) => {',
  '\t\tconst packageDir = resolveBundleDir(binName, packageName, installAnchor, dir);',
  '\t\tconst declared = JSON.parse(readFileSync(join(packageDir, "package.json"), "utf8")).dsh?.bundle?.patch;',
  '\t\tif (declared === void 0) throw new Error(`${binName}: profile bundle ${JSON.stringify(packageName)} declares no dsh.bundle in its package.json`);',
  '\t\tconst patchPath = join(packageDir, declared);',
  '\t\treturn {',
  '\t\t\tpackageName,',
  '\t\t\tpackageDir,',
  '\t\t\tpatchPath,',
  '\t\t\tpatches: loadOverlayPatches(binName, patchPath)',
  '\t\t};',
  '\t});',
].join('\n');
const SYNTHETIC_APP_INSERT = 'function composeEntries(layers, warn = () => {}) {';

test('applyAppBootBundleGuard: 合成源命中锚点并替换', () => {
  // rc.1 宿主：调用点在 loadProfileDirectory(binName, dir, installAnchor, options) 内，
  // 作用域没有 name 形参——注入的调用点必须传 basename(dir)，引用裸 name 会抛
  // ReferenceError（每次启动崩溃，全仓最高优先级的真实回归）。
  const src = [
    'export const x = 1;',
    'function loadProfileDirectory(binName, dir, installAnchor, options = {}) {',
    '\tconst manifest = readProfileManifest(binName, dir);',
    '\tconst bundles = manifest.dsh?.profile?.bundles ?? [];',
    SYNTHETIC_APP_LAYERS,
    '\treturn { name: basename(dir), dir, layers };',
    '}',
    SYNTHETIC_APP_INSERT,
    '\treturn null;',
    '}',
  ].join('\n');
  const out = applyAppBootBundleGuard(src);
  assert.equal(out.changed, true);
  assert.ok(out.src.includes(PROFILE_BUNDLE_GUARD_MARKER), '应写入幂等标记');
  assert.ok(out.src.includes('function loadProfileLayers(binName, name, dir, installAnchor)'), '应注入自愈装配');
  assert.ok(out.src.includes('\tconst layers = loadProfileLayers(binName, basename(dir), dir, installAnchor);'), '调用点应替换（rc.1 宿主无 name 形参，以 basename(dir) 派生）');
  assert.ok(!out.src.includes('const layers = loadProfileLayers(binName, name,'), '调用点不得引用裸 name（loadProfileDirectory 作用域内未定义）');
  assert.ok(!out.src.includes(SYNTHETIC_APP_LAYERS), '严格装配代码块应整体移除');
  const again = applyAppBootBundleGuard(out.src);
  assert.equal(again.changed, false, '二次应用应为幂等空操作');
  assert.equal(again.src, out.src);
});

test('applyAppBootBundleGuard: 锚点缺失时原样返回', () => {
  const src = 'export const x = 1;\nfunction composeEntries(layers, warn = () => {}) {\n  return null;\n}';
  assert.deepEqual(applyAppBootBundleGuard(src), { changed: false, src });
  assert.deepEqual(applyAppBootBundleGuard(''), { changed: false, src: '' });
  assert.deepEqual(applyAppBootBundleGuard(null), { changed: false, src: null });
});

test('applyAppBootBundleGuard: 真实 vendored 文件（两种状态均成立）', () => {
  const src = fs.readFileSync(appBootFile, 'utf8');
  const out = applyAppBootBundleGuard(src);
  if (src.includes(PROFILE_BUNDLE_GUARD_MARKER)) {
    // 已被集成测试应用过：必须识别标记并不再改写。
    assert.equal(out.changed, false);
    assert.equal(out.src, src);
  } else {
    // 未被应用：必须命中锚点、产出合法 ESM 且二次应用幂等。
    assert.equal(out.changed, true, 'vendored app-boot 锚点应命中（dsh 版本变更时需同步更新锚点）');
    assert.ok(out.src.includes('function loadProfileLayers'));
    syntaxCheck('app-boot', out.src);
    assert.equal(applyAppBootBundleGuard(out.src).changed, false);
  }
});

test('applyProfileBootBundleGuard: 合成源命中全部调用点并替换', () => {
  // 0.1.5-rc.1 合成源（与 profile-boot-Dk-7KqJc.js 逐字一致）：node:fs import 已
  // 含 existsSync/mkdirSync/rmSync，export 别名重排并新增 initializeProfileFromDefault；
  // 家级/profile 三处 loadOptionalPatches 调用点与 alpha.5 同字节。
  const src = [
    'import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";',
    'const NAME = "dsh";',
    '\tconst homePatches = loadOptionalPatches(NAME, homePatchPath()) ?? [];',
    '\t\t...loadOptionalPatches(NAME, composed.profile.patchPath) ?? [],',
    '\t\t...loadOptionalPatches(NAME, homePatchPath()) ?? [],',
    'export { prepareProfile as a, initializeProfileFromDefault as i, PROFILE_ROOT_FILENAME as n, resolveTelemetryPatch as o, homePatchPath as r, runProfile as s, INSTALL_ANCHOR as t };',
  ].join('\n');
  const out = applyProfileBootBundleGuard(src);
  assert.equal(out.changed, true);
  assert.ok(out.src.includes(PROFILE_BOOT_GUARD_MARKER), '应写入幂等标记');
  assert.ok(out.src.includes('function loadUserPatchLayerSafe(binName, file)'), '应注入自愈加载');
  assert.ok(out.src.includes('import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";'), 'import 应扩充 readFileSync');
  assert.ok(out.src.includes('\tconst homePatches = loadUserPatchLayerSafe(NAME, homePatchPath());'), 'composeProfile 调用点应替换');
  assert.ok(out.src.includes('\t\t...loadUserPatchLayerSafe(NAME, composed.profile.patchPath),'), 'HMR profile 层调用点应替换');
  assert.ok(out.src.includes('\t\t...loadUserPatchLayerSafe(NAME, homePatchPath()),'), 'HMR 家级层调用点应替换');
  assert.ok(out.src.includes('export { prepareProfile as a, initializeProfileFromDefault as i, PROFILE_ROOT_FILENAME as n, resolveTelemetryPatch as o, homePatchPath as r, runProfile as s, INSTALL_ANCHOR as t };'), '原导出应保留');
  assert.ok(!out.src.includes('loadOptionalPatches(NAME, homePatchPath()) ?? []'), '严格加载应移除');
  assert.equal(applyProfileBootBundleGuard(out.src).changed, false, '二次应用应为幂等空操作');
});

test('applyProfileBootBundleGuard: 任一锚点缺失时原样返回', () => {
  const src = 'export const x = 1;';
  assert.deepEqual(applyProfileBootBundleGuard(src), { changed: false, src });
  assert.deepEqual(applyProfileBootBundleGuard(null), { changed: false, src: null });
});

test('applyProfileBootBundleGuard: 真实 vendored 文件（两种状态均成立）', () => {
  const src = fs.readFileSync(profileBootFile, 'utf8');
  const out = applyProfileBootBundleGuard(src);
  if (src.includes(PROFILE_BOOT_GUARD_MARKER)) {
    assert.equal(out.changed, false);
    assert.equal(out.src, src);
  } else {
    assert.equal(out.changed, true, 'vendored profile-boot 锚点应命中（dsh 版本变更时需同步更新锚点）');
    assert.ok(out.src.includes('function loadUserPatchLayerSafe'));
    syntaxCheck('profile-boot', out.src);
    assert.equal(applyProfileBootBundleGuard(out.src).changed, false);
  }
});


test('applyProfileBootHealGuard: 合成源命中 heal 调用并替换', () => {
  // 0.1.5-rc.1 形态：composeProfile 内 await healProfilesModuleFallback({ installAnchor, profile })
  // 四行调用（profile-boot-Dk-7KqJc.js:234 逐字一致），不再是 alpha.5 的单行直调。
  const src = 'async function composeProfile(name) {\n'
    + '\tawait healProfilesModuleFallback({\n'
    + '\t\tinstallAnchor: INSTALL_ANCHOR,\n'
    + '\t\tprofile\n'
    + '\t});\n'
    + '\treturn name;\n}';
  const out = applyProfileBootHealGuard(src);
  assert.equal(out.changed, true, 'heal 调用锚点应命中');
  assert.ok(out.src.includes("try {"), '调用应包进 try/catch');
  assert.ok(out.src.includes('\tawait healProfilesModuleFallback({'), 'try 块内应保留原 await 四行调用');
  assert.ok(out.src.includes(PROFILE_BOOT_HEAL_MARKER), '幂等标记应写入');
  assert.equal(applyProfileBootHealGuard(out.src).changed, false, '二次应用应为幂等空操作');
});

test('applyProfileBootHealGuard: 无 heal 调用时静默原样返回（入口 bundle）', () => {
  const src = 'export { runProfile as o } from "./x.js";';
  assert.deepEqual(applyProfileBootHealGuard(src), { changed: false, src });
  assert.deepEqual(applyProfileBootHealGuard(null), { changed: false, src: null });
});

test('applyProfileBootHealGuard: 真实 vendored 文件（两种状态均成立）', () => {
  const src = fs.readFileSync(profileBootFile, 'utf8');
  const out = applyProfileBootHealGuard(src);
  if (src.includes(PROFILE_BOOT_HEAL_MARKER)) {
    assert.equal(out.changed, false);
    assert.equal(out.src, src);
  } else if (!src.includes('\tawait healProfilesModuleFallback({')) {
    assert.equal(out.changed, false, '入口 bundle 无 heal 调用应静默（rc.1 四行 await 形态）');
  } else {
    assert.equal(out.changed, true, 'vendored profile-boot heal 锚点应命中（dsh 版本变更时需同步更新锚点）');
    assert.ok(out.src.includes(PROFILE_BOOT_HEAL_MARKER));
    syntaxCheck('profile-boot-heal', out.src);
    assert.equal(applyProfileBootHealGuard(out.src).changed, false);
  }
});
