// ===========================================================================
// dsh-workspace-anchor 的内核 0.2.1-rc.1 兼容回归锁（issue：0.2.1 撤除 {{cwd}} 变量）
//
// 事实（逐条实测，非推断）：
//   · rc.2 的 `dsh-agent-loop` 有三行变量注册，第三行是
//     `ctx.systemPrompt.variable("cwd", (context) => context.agent?.session.header.cwd)`
//     （取自 git HEAD 的 vendor tgz `deepseek-ai-dsh-agent-loop-0.2.0-rc.2.tgz`，行号 1566）；
//   · 0.2.1-rc.1 同一处只剩 provider / model 两行 —— `cwd` 没了；
//   · `dsh-system-prompt` 的装配器对「合法但未注册的变量」是**抛**（不是忽略），
//     且这条 throw 在 rc.2 与 0.2.1 逐字相同（本套件的用例 2 就是拿真渲染函数作证）；
//   · 于是内置插件 dsh-workspace-anchor 那条带 `{{cwd}}` 的节，在 0.2.1 上让
//     **每一条消息**装配期失败，界面表现是「处理失败 / UNKNOWN」，
//     隔离内核真机实测抓到（.tmp-k021-e2e，DSH_HOME 临时目录）。
//
// 运行：node --test scripts/test/unit-workspace-anchor-cwd.test.js
// ---------------------------------------------------------------------------

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

const { renderPrompt } = require('@deepseek-ai/dsh-system-prompt');

const PLUGIN = path.resolve(__dirname, '..', '..', 'assets', 'plugins', 'dsh-workspace-anchor', 'lib', 'index.js');
const KERNEL_VARIABLES = { provider: 'deepseek', model: 'dsh-chat' }; // 0.2.1-rc.1 实测注册面

async function loadPlugin() {
  return import(pathToFileURL(PLUGIN).href);
}

/** 假 ctx：只实现插件用到的两个面，并把调用逐条记下来。 */
function fakeCtx() {
  const calls = { variables: [], sections: [], handlers: [] };
  return {
    calls,
    systemPrompt: {
      variable(name, provider) { calls.variables.push({ name, provider }); },
      section(entry) { calls.sections.push(entry); },
    },
    on(event, handler) { calls.handlers.push({ event, handler }); },
  };
}

test('插件在 0.2.1 真渲染函数下装配得动：锚点无变量引用、interpolate 关闭', async () => {
  const mod = await loadPlugin();
  const ctx = fakeCtx();
  mod.apply(ctx);
  const created = ctx.calls.handlers.find((h) => h.event === 'agent/created');
  assert.ok(created, 'agent/created 监听必须在场（锚点按 agent 作用域注册）');
  created.handler({ agent: { ctx, session: { header: { cwd: 'D:\\workspace\\dsh' } } } });

  assert.equal(ctx.calls.sections.length, 1, '应恰好注册一条节');
  const section = ctx.calls.sections[0];
  assert.equal(section.name, 'dsh:workspace-anchor');
  assert.equal(section.order, 1);
  assert.equal(section.interpolate, false, '锚点必须标 interpolate:false —— 不再依赖内核变量表');
  assert.ok(!section.text.includes('{{'), '锚点文本里不得再有 `{{…}}` 模板引用（0.2.1 无 cwd 变量，装配期必抛）');
  assert.ok(section.text.includes('D:\\workspace\\dsh'), '锚点应把 header.cwd 的实路径填进去');

  // 真渲染函数走一遍：不抛、且原文出现在结果里。
  const out = renderPrompt({ sections: [section], variables: KERNEL_VARIABLES });
  assert.ok(out.includes('D:\\workspace\\dsh'), '渲染结果丢了工作区路径，锚点等于没起作用');
});

test('反证一：旧形状（带 {{cwd}}、未关插值）在 0.2.1 的渲染函数下必须抛', () => {
  const legacy = {
    name: 'dsh:workspace-anchor',
    order: 1,
    text: 'Workspace: {{cwd}}.\n- Keep file edits under {{cwd}}.',
  };
  assert.throws(
    () => renderPrompt({ sections: [legacy], variables: KERNEL_VARIABLES }),
    /unknown prompt variable "{{cwd}}"/,
    '旧形状未被判红 —— 用例 1 是在替一条不存在的契约作证',
  );
});

test('插件把 cwd 变量按 rc.2 原形状补注册回来（别人写的 {{cwd}} 仍可解析）', async () => {
  const mod = await loadPlugin();
  const ctx = fakeCtx();
  mod.apply(ctx);
  const reg = ctx.calls.variables.find((v) => v.name === 'cwd');
  assert.ok(reg, '插件必须自己注册 cwd 提示词变量（rc.2 由内核提供，0.2.1 已撤）');
  assert.equal(reg.provider({ agent: { session: { header: { cwd: 'D:\\tmp\\ws' } } } }), 'D:\\tmp\\ws');
  const out = renderPrompt({
    sections: [{ name: 'user-authored', order: 50, text: 'Working dir: {{cwd}}' }],
    variables: { ...KERNEL_VARIABLES, cwd: reg.provider({ agent: { session: { header: { cwd: 'D:\\tmp\\ws' } } } }) },
  });
  assert.equal(out, 'Working dir: D:\\tmp\\ws');
});

test('无 cwd 的会话不注册锚点（宁缺不炸），且模块导出面零回归', async () => {
  const mod = await loadPlugin();
  const ctx = fakeCtx();
  mod.apply(ctx);
  const created = ctx.calls.handlers.find((h) => h.event === 'agent/created');
  created.handler({ agent: { ctx, session: { header: {} } } });
  assert.equal(ctx.calls.sections.length, 0, 'header.cwd 缺失时不得注册锚点（装配期没有值可填）');
  assert.equal(mod.name, '@deepseek-ai/dsh-workspace-anchor');
  assert.deepEqual(mod.inject, ['systemPrompt']);
});
