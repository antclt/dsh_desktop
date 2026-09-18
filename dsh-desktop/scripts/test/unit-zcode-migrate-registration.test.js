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
});

// ---------------------------------------------------------------------------
// 客户端半（设置页）：给「选中 + 一键迁移」提供界面。三条不变量：
//   ① 清单声明了 client.main，且那个文件真的存在（否则内核加载不到页面）；
//   ② 包内 bundle id 必须等于 manifest id —— 注册表频道靠 id === 插件 id 判定到货，
//      写成包名以外的东西会「装了但页面不出现」；
//   ③ 页面必须注册到内核的设置槽（settings.section），且宿主侧真挂了它调用的那个
//      HTTP 前缀路由（两边路径漂移 = 页面永远报错）。
// ---------------------------------------------------------------------------
test('客户端半：设置页在清单/包声明/产物/宿主路由四处对齐', () => {
  const manifest = readJson('dsh.plugin.json');
  const pkg = readJson('package.json');
  const offenders = [];

  // ① 声明与产物
  if (manifest.client?.main !== './lib/client.js') offenders.push('dsh.plugin.json 未声明 client.main=./lib/client.js');
  if (pkg.exports?.['./client'] === undefined) offenders.push('package.json 缺 ./client 导出');
  const clientFile = path.join(ASSETS, 'lib', 'client.js');
  if (!fs.existsSync(clientFile)) offenders.push('lib/client.js 不在位（客户端产物）');
  else {
    const src = fs.readFileSync(clientFile, 'utf8');
    // ② bundle id === manifest id
    const id = (src.match(/__ModuleLoader__\.load\(\{\s*id:\s*'([^']+)'/) || [])[1];
    if (id !== manifest.id) offenders.push(`bundle id(${id}）必须等于 manifest id(${manifest.id})`);
    // ③ 设置槽 + 调用的接口前缀
    if (!src.includes("'settings.section'")) offenders.push('页面未注册 settings.section');
    const apiPrefix = (src.match(/const API = '([^']+)'/) || [])[1];
    if (apiPrefix === undefined) offenders.push('页面未声明 API 前缀');
    else {
      const host = read('src/rpc.js');
      const hostPrefix = (host.match(/API_PREFIX = '([^']+)'/) || [])[1];
      if (hostPrefix !== apiPrefix) offenders.push(`页面前缀(${apiPrefix}) 与宿主 API_PREFIX(${hostPrefix}) 不一致`);
      for (const action of ['inspect', 'migrate', 'verify', 'workspaces']) {
        if (!host.includes(`${API_PREFIX_ACTION(action)}`)) offenders.push(`宿主缺 ${action} 分支`);
      }
    }
    // 注入面：设置槽的拥有者必须在 dsh.client.inject 里
    const inject = pkg.dsh?.client?.inject ?? [];
    if (!inject.some((id) => /dsh-client-ui-settings/.test(id))) offenders.push('dsh.client.inject 未包含 @deepseek-ai/dsh-client-ui-settings');
  }

  assert.deepEqual(offenders, [], offenders.join('\n'));
});

/** 与 src/rpc.js 里的模板串同形（`${API_PREFIX}/inspect` 展开后的样子）。 */
function API_PREFIX_ACTION(action) {
  return '`${API_PREFIX}/' + action + '`';
}
