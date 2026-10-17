'use strict';

// 内置插件「宿主半边 inject 服务名可解析性」机器锁（node --test）。
//
// 事故来源（2026-10-17 真机）：内核 0.2.1-rc.1 删除 `webRuntime` 服务（全树该服务名
// 0 命中，信任清单迁到 dsh-client-connection 的 `connection`），而 dsh-better-sidebar
// 与 dsh-basics-panel 的宿主半边仍声明 inject ['webRuntime'] → fiber 永久 pending →
// loader-isolation 静默隔离 → 两个插件注册的 /sidebar/*、/basics/* 一条都不挂 →
// 资源管理器的 POST /sidebar/api/fs.trees 落进 SPA 兜底（只认 GET/HEAD）拿到空体 405。
// 当时的开机面毫无异常：boot 五步全 OK、29 条插件无一 failed to load、内核正常 listen。
//
// 这条判据把「服务名解析不到」从**只有真开界面才看得见**提前到静态面，
// 判据源全部取自 node_modules 实文件与插件交付产物，不硬编码服务名清单。
// 纯函数在 scripts/lib/plugin-inject-services.js，本文件只做编排与断言。

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const {
  collectProvidedServices,
  extractHostInjectNames,
  auditInjectServices,
} = require('../lib/plugin-inject-services.js');
const { COMPANION_PLUGINS } = require('../lib/companion-plugins.js');
const pin = require('../compat/kernel-pin.json');

const desktopRoot = path.resolve(__dirname, '..', '..');
const pluginsRoot = path.join(desktopRoot, 'assets', 'plugins');

const provided = collectProvidedServices([path.join(desktopRoot, 'node_modules', '@deepseek-ai')]);
const removedIds = (pin.services && pin.services.removed ? pin.services.removed : []).map((row) => row.id);

function pluginDirs() {
  return fs.readdirSync(pluginsRoot, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => path.join(pluginsRoot, entry.name));
}

// ---- 舰队审计 --------------------------------------------------------------

test('舰队：29 条内置件的宿主 inject 全部解析得到（服务名必须在 pin 内核提供集内）', () => {
  const { rows, violations } = auditInjectServices({
    pluginDirs: pluginDirs(),
    provided,
    removedIds,
  });

  assert.equal(rows.length, COMPANION_PLUGINS.length,
    `审计面 ${rows.length} 件 ≠ 在册 ${COMPANION_PLUGINS.length} 件（assets/plugins 与清单脱钩）`);
  assert.equal(violations.length, 0,
    `存在解析不到的服务依赖：\n${violations.map((v) => `  · ${v.plugin} [${v.kind}] ${v.detail}`).join('\n')}`);

  // 抽取不得空转：多数插件确实声明了服务依赖（空转的典型形态是正则失配、全舰队 0 条）。
  const declaring = rows.filter((row) => row.names.length > 0);
  assert.ok(declaring.length >= 15,
    `仅 ${declaring.length} 件声明了非空 inject，判据疑似空转（此前实测 17 件）`);
  assert.ok(rows.every((row) => row.entry !== null), '每条插件都必须解析得到实际挂载入口');
});

// ---- 判据源自检 ------------------------------------------------------------

test('判据源：内核提供集非空且含关键服务，事故名 webRuntime 必须不在位', () => {
  assert.ok(provided.size >= 120, `提供集只有 ${provided.size} 个名字，判据源疑似扫空`);
  for (const name of ['connection', 'webServer', 'sessions', 'tools', 'settings']) {
    assert.ok(provided.has(name), `内核提供集缺 ${name} —— 扫描形状失效（换代后判据需随迁）`);
  }
  assert.equal(provided.has('webRuntime'), false,
    'webRuntime 又回到内核了 —— 本锁的事故前提失效，请连同插件侧 inject 一起复核口径');
});

// ---- 反证 ------------------------------------------------------------------

test('反证：喂进已下线的服务名必须判红，现役服务名必须放行', () => {
  const text = `export const inject = ['webServer', 'sessions', 'webRuntime', 'tools']`;
  const names = extractHostInjectNames(text);
  assert.deepEqual(names, ['webServer', 'sessions', 'webRuntime', 'tools'], 'inject 抽取形状不符');

  const { violations } = auditInjectServices({
    pluginDirs: [],
    provided,
    removedIds,
  });
  assert.deepEqual(violations, [], '空舰队不应有违规（判据不该凭空造违规）');

  // 直接按名字判：注入面与 auditInjectServices 同一条口径。
  const offending = names.filter((name) => !provided.has(name));
  assert.deepEqual(offending, ['webRuntime'], '下线名未被判出，判据过宽');
  assert.deepEqual(['connection', 'webServer', 'sessions', 'tools'].filter((n) => !provided.has(n)), [],
    '现役服务名被判缺，判据过严');
});

test('反证：入口解析不到必须判违规，不许静默跳过', () => {
  const missing = path.join(pluginsRoot, '..', '.no-such-plugin-dir');
  const { violations } = auditInjectServices({ pluginDirs: [missing], provided, removedIds });
  assert.equal(violations.length, 1, '缺失入口被静默吞掉 → 全绿无意义');
  assert.equal(violations[0].kind, 'entry-missing');
});

// ---- 事故件字节锁（取交付产物，不取 src） ---------------------------------

test('事故件：better-sidebar 与 basics-panel 的交付产物改读 connection，且不再声明 webRuntime', () => {
  for (const [dir, fenceNeedle] of [
    ['dsh-better-sidebar', 'ctx.connection?.trustedHosts'],
    ['dsh-basics-panel', 'ctx.connection.trustedHosts'],
  ]) {
    const file = path.join(pluginsRoot, dir, 'lib', 'index.js');
    const text = fs.readFileSync(file, 'utf8');
    const names = extractHostInjectNames(text);
    assert.ok(names.includes('connection'), `${dir} 的宿主 inject 未声明 connection：${names.join(',')}`);
    assert.ok(!names.includes('webRuntime'), `${dir} 的宿主 inject 仍声明已下线的 webRuntime`);
    assert.ok(text.includes(fenceNeedle),
      `${dir} 的栅栏未改读 connection 的信任清单（期望出现 ${fenceNeedle}）`);
    assert.equal(text.includes('webRuntime'), false, `${dir} 产物里仍残留 webRuntime 字样`);
  }
});
