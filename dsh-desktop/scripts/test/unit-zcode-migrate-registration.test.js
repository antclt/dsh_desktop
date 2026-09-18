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

// ---------------------------------------------------------------------------
// 「目录已不存在」的语义（用户实报：每次登记工作区都刷一排 ENOENT 红字）。
// 注册表要求目录真实存在，而 zcode 的历史会话经常指向早已删掉的项目目录，于是
// 「登记工作区」对那批目录永远失败。约定：**不存在 ≠ 失败**，宿主报 `skipped: true`
// 且不调注册表，页面按灰字列出并藏掉登记按钮。这条用真 HTTP 面（真 server + fetch）
// 跑行为，而不是正则扫源码 —— 语义错了必须能红。
// ---------------------------------------------------------------------------
test('workspaces：目录已不存在 → skipped 且不碰注册表（真 HTTP 面）', async () => {
  const http = require('node:http');
  const { pathToFileURL } = require('node:url');
  const os = require('node:os');
  const { createApiHandler, API_PREFIX } = await import(pathToFileURL(path.join(ASSETS, 'src', 'rpc.js')).href);

  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-zcode-ws-'));
  const realDir = path.join(root, 'still-here');
  const goneDir = path.join(root, 'deleted-long-ago');
  fs.mkdirSync(realDir);
  const calls = [];
  const registry = {
    async create(dir, title) {
      calls.push({ dir, title });
      return { id: 'ws-' + title, title };
    },
  };
  const handler = createApiHandler({ dbPath: 'x', dshRoot: 'y' }, { workspaceRegistry: registry });
  const server = http.createServer((req, res) => { handler(req, res).catch(() => res.end()); });
  try {
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    const res = await fetch(`http://127.0.0.1:${server.address().port}${API_PREFIX}/workspaces`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ directories: [realDir, goneDir] }),
    });
    const body = await res.json();
    assert.equal(res.status, 200);
    assert.equal(body.ok, true, '请求成功即 ok:true（顶层 ok:false 会被页面当硬错误，吞掉逐条结果）');
    assert.equal(body.results[0].ok, true, '存在的目录照常登记');
    assert.equal(body.results[1].ok, false);
    assert.equal(body.results[1].skipped, true, '不存在的目录必须标 skipped');
    assert.equal(body.results[1].error, undefined, 'skipped 不带 error（页面才能与真失败分开渲染）');
    assert.deepEqual(calls.map((c) => c.dir), [realDir], '不存在的目录不得调用 registry.create');
  } finally {
    await new Promise((resolve) => server.close(resolve));
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('inspect 报出目录/会话的存在性（页面据此标注与门控）', () => {
  const core = read('core/migrate.js');
  assert.match(core, /exists:\s*existsOf\(directory\)/, 'inspect().directories[] 必须带 exists');
  assert.match(core, /directoryExists:\s*existsOf\(/, 'inspect().sessions[] 必须带 directoryExists');
  const client = read('lib/client.js');
  assert.match(client, /directoryExists !== false/, '页面必须按存在性门控「登记工作区」按钮');
  assert.match(client, /skipped === true/, '页面必须单独渲染 skipped（灰字）而不是并进失败');
});

/** 与 src/rpc.js 里的模板串同形（`${API_PREFIX}/inspect` 展开后的样子）。 */
function API_PREFIX_ACTION(action) {
  return '`${API_PREFIX}/' + action + '`';
}
