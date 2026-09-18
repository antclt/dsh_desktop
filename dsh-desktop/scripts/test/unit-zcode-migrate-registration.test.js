'use strict';
// dsh-zcode-migrate 内置登记守卫（node --test）。
//
// 这个插件是 2026-09 按要求内置进本仓库的（宿主侧 bundle 插件）：把 zcode CLI 的历史
// 会话（SQLite）转成 dsh 原生会话日志，迁完可在会话列表里恢复。内置 = 两件事同时成立：
//   ① 资产在 `assets/plugins/dsh-zcode-migrate/`（运行时落点，启动期同步镜像进 profile）；
//   ② 在 `scripts/lib/companion-plugins.js` 的 COMPANION_PLUGINS 里登记。
// 少任何一条都不会被装配：只放资产不登记 → 启动期同步不认识它（实测：插件目录进了
// 安装目录 payload 也不会落位 profile）；只登记不放资产 → hub 元数据校验直接判不合格。
//
// 判据（对齐 issue #104 的坑）：登记条目的 `id` 必须与插件自己 `cordis.patch.yml` 里的
// loader id 完全一致 —— 不一致会让 bundle 迁移的 dropBlocksByIds 漏掉残留 insert 行，
// 造成重复挂载与启动崩溃。
//
// 用法：node --test scripts/test/unit-zcode-migrate-registration.test.js

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const REPO = path.resolve(__dirname, '..', '..');
const ASSETS = path.join(REPO, 'assets', 'plugins', 'dsh-zcode-migrate');
const { COMPANION_PLUGINS } = require('../lib/companion-plugins');

const read = (rel) => fs.readFileSync(path.join(ASSETS, rel), 'utf8');
const readJson = (rel) => JSON.parse(read(rel));

test('COMPANION_PLUGINS 登记 zcode-migrate（append，不扰动既有条目）', () => {
  const hits = COMPANION_PLUGINS.filter((p) => p.id === 'zcode-migrate');
  assert.equal(hits.length, 1, '必须恰好登记一次（重复登记 = 双挂载）');
  assert.equal(hits[0].name, 'dsh-zcode-migrate', 'name 必须是 profile node_modules 下的包名');
  // append 语义：既有条目必须原样在位（这条锁住「顺手重排清单」这类改动）。
  for (const id of ['better-sidebar', 'harness-pet', 'dsh-session-manager']) {
    assert.ok(COMPANION_PLUGINS.some((p) => p.id === id), `既有条目 ${id} 不得被挤掉`);
  }
  assert.ok(
    !COMPANION_PLUGINS.some((p) => p.id === 'zcode-migrate' && p.shipsNodeModules === true),
    '该插件自包含（无 node_modules），不得标 shipsNodeModules',
  );
});

test('资产目录与元数据齐备（hub 元数据校验面）', () => {
  assert.ok(fs.existsSync(ASSETS), `资产目录不在位：${ASSETS}`);
  for (const f of ['package.json', 'dsh.plugin.json', 'cordis.patch.yml', 'src/index.js', 'core/index.js']) {
    assert.ok(fs.existsSync(path.join(ASSETS, f)), `缺文件：${f}`);
  }
  const pkg = readJson('package.json');
  const manifest = readJson('dsh.plugin.json');
  assert.equal(pkg.name, 'dsh-zcode-migrate', '包名必须与登记 name 一致');
  assert.match(pkg.version, /^\d+\.\d+\.\d+/, '版本号必须是可比较的 x.y.z（hub 登记读它）');
  assert.ok((pkg.description || '').length > 0, '描述不能空（hub 元数据校验要求）');
  assert.equal(manifest.id, pkg.name, 'manifest id 必须等于包名（本插件的约定）');
  assert.equal(manifest.version, pkg.version, 'manifest 与 package 版本必须同步');
});

test('loader id 一致性（issue #104 的坑：不一致会双挂载）', () => {
  const registryId = COMPANION_PLUGINS.find((p) => p.id === 'zcode-migrate').id;
  const patch = read('cordis.patch.yml');
  const loaderId = (patch.match(/^\s*-\s*id:\s*(\S+)\s*$/m) || [])[1];
  assert.ok(loaderId !== undefined, 'cordis.patch.yml 里找不到 insert 行的 loader id');
  assert.equal(loaderId, registryId, '登记 id 必须与 cordis.patch.yml 的 loader id 一致');
  // 包名同样要对上（bundle 迁移按 name 判定「这个 bundle 是否已挂」）。
  const loaderName = (patch.match(/^\s*name:\s*(\S+)\s*$/m) || [])[1];
  assert.equal(loaderName, 'dsh-zcode-migrate', 'insert 行的 name 必须是包名');
});

test('manifest 声明的工具必须在源码里真的注册（防「声明了没实现」）', () => {
  const manifest = readJson('dsh.plugin.json');
  const declared = manifest.contributes?.tools ?? [];
  assert.deepEqual(declared, ['zcode.inspect', 'zcode.migrate', 'zcode.verify'], '工具清单是既有契约，改这里要同步改实现与文档');
  const tools = read('src/tools.js');
  const offenders = declared.filter((name) => !tools.includes(`'${name}'`));
  assert.deepEqual(offenders, [], `以下工具在 manifest 里声明但 src/tools.js 没注册：${offenders.join(', ')}`);
  // 宿主侧插件：不得声明 client 半（本插件没有前端产物，声明了会加载失败）。
  assert.equal(manifest.client, undefined, '宿主侧插件不得声明 client 半');
});
