'use strict';

// dsh-prompt-optimizer 3.0.0（vendored 上游 Y1X1n/dsh-prompt-optimizer 0.6.1）机器锁。
//
// 2026-10-19 起本仓不再维护自研提示词优化线：包名与 loader id 仍为
// dsh-prompt-optimizer / prompt-optimizer（让老 profile 原地覆盖），版本抬到 3.0.0
// 以压过旧 2.4.0（companion-profile 的 keep-newer 判据）。这条套件把四处
// 「换实现后最容易漏」的事实钉住：
//   1. 清单/包名/版本/入口在盘上一致，旧 dist 入口与 gitignore 例外彻底消失；
//   2. bundle 补丁的 id/name 与 COMPANION_PLUGINS 一致（双挂载/漏挂的入口面）；
//   3. 宿主导出与 inject 服务名（llm 在 pin 内核提供集内，由判据 G 另行全量扫）；
//   4. 客户端 bundle 的注册 id、两个输入槽 + 插件设置标签页与两条路由；上游纯函数可跑；
//   5. 「设置里固定优化模型」的入口与优先级：客户端设置卡有模型/回退模型两行，
//      宿主 resolveRoute 让固定值覆盖会话选择，留空才跟随会话。

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { Readable } = require('node:stream');
const { pathToFileURL } = require('node:url');

const { COMPANION_PLUGINS, companionDirName } = require('../lib/companion-plugins.js');
const { identityVerdict, parseRepoSlug } = require('../lib/plugin-channels.js');

const desktopRoot = path.resolve(__dirname, '..', '..');
const pluginsRoot = path.join(desktopRoot, 'assets', 'plugins');
const pluginRoot = path.join(pluginsRoot, 'dsh-prompt-optimizer');
const read = (rel) => fs.readFileSync(path.join(pluginRoot, rel), 'utf8');
const pkg = JSON.parse(read('package.json'));
const hostEntry = pathToFileURL(path.join(pluginRoot, 'lib', 'index.js')).href;
const clientMod = pathToFileURL(path.join(pluginRoot, 'lib', 'client.js')).href;
const promptMod = pathToFileURL(path.join(pluginRoot, 'lib', 'prompt.js')).href;
const controllerMod = pathToFileURL(path.join(pluginRoot, 'lib', 'controller.js')).href;

test('在册身份：包名/版本/入口与清单一致，旧 2.x 残留不再可见', () => {
  const entry = COMPANION_PLUGINS.find((p) => p.name === 'dsh-prompt-optimizer');
  assert.ok(entry, 'COMPANION_PLUGINS 丢了 dsh-prompt-optimizer');
  assert.equal(entry.id, 'prompt-optimizer');
  assert.equal(companionDirName(entry), 'dsh-prompt-optimizer');

  assert.equal(pkg.name, 'dsh-prompt-optimizer', '包名必须沿用，否则老 profile 会双挂载');
  assert.equal(pkg.version, '3.0.0');
  assert.equal(pkg.private, true, '私有标记缺失会让退役回收误删/漏删');
  assert.equal(pkg.main, 'lib/index.js');
  assert.equal(pkg.exports['.'], './lib/index.js');
  assert.equal(pkg.exports['./client'], './lib/client.js');

  // 反证：keep-newer 比较的是数字版本；若把版本写回 2.x，老 profile 不会被覆盖。
  const [major] = pkg.version.split('.').map(Number);
  assert.ok(major > 2, '版本必须高于旧自研线 2.4.0，否则同步步会保留旧实现');

  assert.equal(fs.existsSync(path.join(pluginRoot, 'dist', 'client.js')), false,
    '旧 dist/client.js 仍在盘上——入口已改 lib/client.js，残留产物会误导排查');
  const gitignore = fs.readFileSync(path.join(desktopRoot, '.gitignore'), 'utf8');
  assert.equal(gitignore.includes('dsh-prompt-optimizer/dist'), false,
    '.gitignore 仍保留旧插件 dist 例外，入口可见性判据的样本会失真');
});

test('bundle 补丁：insert 的 id/name 与清单逐字一致', () => {
  const yml = read('cordis.patch.yml');
  assert.match(yml, /^- insert:/m, '必须是 insert（覆盖式条目只对已存在条目生效）');
  assert.match(yml, /^\s*-\s*id: prompt-optimizer$/m);
  assert.match(yml, /^\s+name: 'dsh-prompt-optimizer'$/m);
});

test('宿主半边：导出 Config/apply/inject/name，inject 只有 llm', async () => {
  const mod = await import(hostEntry);
  assert.deepEqual(Object.keys(mod).sort(), ['Config', 'apply', 'inject', 'name']);
  assert.equal(mod.name, 'dsh-prompt-optimizer');
  assert.equal(typeof mod.apply, 'function');
  assert.equal(typeof mod.Config, 'function');
  assert.deepEqual(mod.inject, ['llm']);

  const index = read('lib/index.js');
  assert.ok(index.includes('/dsh-prompt-optimizer/optimize'), '优化路由未注册');
  assert.ok(index.includes('/dsh-prompt-optimizer/test-model'), '模型探活路由未注册');
  assert.ok(index.includes('assertTrustedOrigin'), '路由缺少来源校验');
  assert.equal(index.includes('webRuntime'), false, '产物仍引用已下线的 webRuntime 服务');
});

test('客户端半边：注册 id、槽位、两条路由与 inject 声明', () => {
  const client = read('lib/client.js');
  assert.match(client, /window\.__ModuleLoader__\.load\(\{/);
  assert.match(client, /id:\s*"dsh-prompt-optimizer"/);
  for (const slot of [
    'conversation.input.right',
    'conversation.input.dock',
    'settings.plugins.tab',
  ]) {
    assert.ok(client.includes(slot), '客户端缺少槽位：' + slot);
  }
  // 0.1.x 兼容面已摘：内核 0.2.1 没有该服务/槽位，残留引用会被 G10 与
  // unit-settings-scope-retire 判红（静态 inject 会 pending，注册未声明槽会抛）。
  assert.equal(client.includes('settings.plugin.item'), false, '旧 settings.plugin.item 兼容路径未摘净');
  assert.equal(client.includes('settingsScope'), false, '旧 settingsScope 兼容路径未摘净');
  assert.ok(client.includes('/dsh-prompt-optimizer/optimize'));
  assert.ok(client.includes('/dsh-prompt-optimizer/test-model'));
  assert.match(client, /var inject = \["slots", "connection", "remote"\]/);

  // 「设置里固定优化模型」的界面入口：两个下拉 + 目录 RPC + 连通性测试。
  // 任一标记消失都意味着上游换代把这条能力从设置卡里丢掉了。
  for (const marker of ['settings.model', 'settings.fallbackModel', 'session/modelCatalog']) {
    assert.ok(client.includes(marker), '设置卡缺少固定模型入口：' + marker);
  }
  assert.ok(client.includes('fetch("/dsh-prompt-optimizer/test-model"'),
    '设置卡缺少模型连通性测试入口');

  const declared = pkg.dsh && pkg.dsh.client && pkg.dsh.client.inject;
  assert.deepEqual(declared, [
    '@deepseek-ai/dsh-client-connection',
    '@deepseek-ai/dsh-client-ui-conversation',
    '@deepseek-ai/dsh-client-ui-settings',
    '@deepseek-ai/dsh-client-ui-settings-plugins',
  ]);
  for (const name of declared) {
    assert.ok(fs.existsSync(path.join(desktopRoot, 'node_modules', name, 'package.json')),
      'dsh.client.inject 声明的包不在 pin 树里：' + name);
  }
});

test('固定优化模型：设置值压过会话选择，留空跟随会话（真 Context 驱动宿主路由）', async (t) => {
  const { Context } = await import('@deepseek-ai/cordis');

  const makeHost = async (config) => {
    const routes = {};
    const calls = [];
    const ctx = new Context();
    ctx.provide('httpServer', {
      register(route) {
        routes[route.path] = route;
        return () => {};
      },
    });
    ctx.provide('llm', {
      async *stream(options) {
        calls.push(options);
        yield { type: 'text-delta', index: 0, text: 'pong' };
        yield { type: 'finish', reason: { kind: 'stop' } };
      },
      listProviders: () => [{ id: 'first-provider' }],
      listModels: async () => [{ provider: 'first-provider', id: 'first-model' }],
    });
    const fiber = await ctx.plugin(await import(hostEntry), config);
    t.after(() => fiber.dispose());

    const route = routes['/dsh-prompt-optimizer/test-model'];
    assert.ok(route, '探活路由未注册');
    return {
      calls,
      async probe(body) {
        const res = {
          status: 0,
          body: '',
          writableEnded: false,
          destroyed: false,
          on() {},
          writeHead(status) {
            res.status = status;
            return res;
          },
          write(chunk) {
            res.body += chunk;
            return true;
          },
          end(payload) {
            if (payload) res.body += payload;
            res.writableEnded = true;
          },
        };
        const req = Readable.from([JSON.stringify(body)]);
        req.method = 'POST';
        req.headers = {};
        await route.handler(req, res);
        return { status: res.status, body: JSON.parse(res.body) };
      },
    };
  };

  // 固定值优先：会话明明选了 session-p/session-m，宿主仍走设置里的路由。
  const pinned = await makeHost({ model: 'pinned-p/pinned-m' });
  const fixed = await pinned.probe({ provider: 'session-p', model: 'session-m' });
  assert.equal(fixed.status, 200);
  assert.equal(fixed.body.ok, true);
  assert.equal(fixed.body.provider, 'pinned-p', '固定 provider 必须压过会话选择');
  assert.equal(fixed.body.model, 'pinned-m', '固定 model 必须压过会话选择');
  assert.equal(pinned.calls[0].provider, 'pinned-p', '真正下发给 llm 的应是固定路由');
  assert.equal(pinned.calls[0].model, 'pinned-m');

  // 留空跟随会话：同一请求体必须原样采用会话的 provider/model，而不是回退首个路由。
  const follow = await makeHost({});
  const followed = await follow.probe({ provider: 'session-p', model: 'session-m' });
  assert.equal(followed.body.ok, true);
  assert.equal(followed.body.provider, 'session-p', '未固定时应跟随发起请求的会话');
  assert.equal(followed.body.model, 'session-m');
});

test('来源身份：repository 指向 Y1X1n，对 npm 裸名 dsh-prompt-optimizer 判 foreign', () => {
  assert.equal(parseRepoSlug(pkg.repository), 'y1x1n/dsh-prompt-optimizer');
  assert.equal(
    identityVerdict({
      localRepository: pkg.repository,
      // npm 裸名 dsh-prompt-optimizer 的 latest 仍属 winditer 的另一实现
      remoteRepository: 'git+https://github.com/winditer/dsh-prompt-optimizer.git',
    }),
    'foreign',
    '身份若被改成 same，更新链会按 npm 裸名拉进另一实现的包'
  );
});

test('行为冒烟：完整/快速/退化三种输出与斜杠命令前缀', async () => {
  const prompt = await import(promptMod);
  const full = prompt.parseOptimizerOutput('<<<OPTIMIZED>>>\n改稿\n<<<ANALYSIS>>>\n诊断', 'full');
  assert.deepEqual(full, { analysis: '诊断', optimized: '改稿', wellFormed: true });

  const fast = prompt.parseOptimizerOutput('直接输出', 'fast');
  assert.deepEqual(fast, { analysis: '', optimized: '直接输出', wellFormed: true });

  const degraded = prompt.parseOptimizerOutput('没有标记', 'full');
  assert.equal(degraded.wellFormed, false, '完整模式无标记仍应判格式不合规');
  assert.equal(degraded.optimized, '没有标记', '退化展示必须保留正文');

  const controller = await import(controllerMod);
  assert.deepEqual(controller.splitCommandPrefix('/goal 帮我优化'), { prefix: '/goal', body: '帮我优化' });
  assert.deepEqual(controller.splitCommandPrefix('/goal'), { body: '/goal', commandOnly: true });
  assert.deepEqual(controller.splitCommandPrefix('普通草稿'), { body: '普通草稿' });
  assert.equal(controller.joinLast({ prefix: '/goal', text: '正文' }), '/goal 正文');
});

test('客户端 bundle 不是 ESM：直接 import 必须在加载前就失败（模块加载器契约）', async () => {
  // 反证：客户端产物只应由 window.__ModuleLoader__.load 执行；若哪天被误改成
  // ESM/普通脚本，loader 会拿到不带 load() 的文件而静默不注册槽位。
  await assert.rejects(import(clientMod), /__ModuleLoader__|is not defined|Unexpected token/);
});
