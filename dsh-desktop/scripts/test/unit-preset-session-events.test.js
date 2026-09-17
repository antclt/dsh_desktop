'use strict';
// 预设钩子的会话事件读取兼容性回归锁（node --test）。
//
// 背景（0.6.5 实爆，用户实报）：内核 0.1.6 把 `Session` 的事件日志收成私有
// （`private eventsSnapshot`，公开读法变成 `snapshotEvents()` / `ownEvents()`），
// 而随包预设的钩子仍按旧形状直接读 `session.events`。于是任选一个非标准预设发消息，
// 请求装配阶段就抛
//
//     Cannot read properties of undefined (reading 'find')
//
// 整轮运行直接失败（聊天里显示「本轮运行失败」并断开）。标准模式不挂这些钩子，
// 所以只有它正常 —— 这正是用户观察到的现象。
//
// 判据：
//   ① 预设钩子里不得再出现对 `session.events` / `agent.session.events` 的**直接读取**
//      （必须走 sessionEvents() 兼容读音器）；
//   ② 用到 sessionEvents() 的文件必须自己定义它（预设行是自包含的，没有共享 import）；
//   ③ 真跑：把 router-core 的 sessionMode() 分别喂「旧形状 / 新形状 / 什么都没有」，
//      三种都不得抛错，且分类结果一致。
//
// 用法：node --test scripts/test/unit-preset-session-events.test.js

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

const PRESETS = path.join(__dirname, '..', '..', 'assets', 'agent-presets');

/** 递归收集预设目录下的 .mjs（预设钩子）。 */
function hookFiles(dir = PRESETS, out = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) hookFiles(full, out);
    else if (entry.name.endsWith('.mjs')) out.push(full);
  }
  return out;
}

/** 去掉块注释与行注释，只留代码 —— 文件里刻意写了反面教材注释，别被自己绊倒。 */
function codeOnly(src) {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .split('\n')
    .map((line) => line.replace(/\/\/.*$/, ''))
    .join('\n');
}

test('预设钩子不得直接读 session.events（0.1.6 起该字段为私有，直读会让整轮运行失败）', () => {
  const files = hookFiles();
  assert.ok(files.length >= 10, `预设钩子数量异常：${files.length}`);

  const offenders = [];
  let viaHelper = 0;
  for (const file of files) {
    const rel = path.relative(PRESETS, file);
    const code = codeOnly(fs.readFileSync(file, 'utf8'));
    // 兼容读音器自身的实现允许出现 `.events`（它就是在做形状判定）。
    const withoutHelper = code.replace(/function sessionEvents\([\s\S]*?\n\}/, '');
    const direct = withoutHelper.match(/\b(?:agent\.)?session\.events\b/g) || [];
    if (direct.length > 0) offenders.push(`${rel}：仍有 ${direct.length} 处直接读取 session.events`);
    if (/sessionEvents\(/.test(withoutHelper)) {
      viaHelper += 1;
      if (!/function sessionEvents\(/.test(code)) offenders.push(`${rel}：用了 sessionEvents() 却没定义它（预设行自包含）`);
    }
  }

  assert.deepEqual(offenders, [], offenders.join('\n'));
  assert.ok(viaHelper >= 13, `走兼容读音器的文件数偏少：${viaHelper}（历史实点 13 处）`);
});

test('真跑：sessionMode 吃「旧形状 / 新形状 / 什么都没有」都不许抛错', async () => {
  const core = await import(pathToFileURL(path.join(PRESETS, 'router-standard', 'router-core.mjs')).href);
  const userMsg = {
    type: 'user/message',
    data: { source: { kind: 'user' }, content: [{ type: 'text', text: '帮我修复这个 bug' }] },
  };
  const buildMsg = {
    type: 'user/message',
    data: { source: { kind: 'user' }, content: [{ type: 'text', text: '帮我写一个网页游戏' }] },
  };

  // 旧形状（≤0.1.5）：公开的 events 数组。
  assert.equal(core.sessionMode({ events: [userMsg] }), 0, '旧形状：修复类任务应判 spec(0)');
  // 新形状（0.1.6）：私有日志 + snapshotEvents() 公开读法。
  assert.equal(core.sessionMode({ snapshotEvents: () => [userMsg] }), 0, '新形状：必须走 snapshotEvents() 且结果一致');
  assert.equal(core.sessionMode({ snapshotEvents: () => [buildMsg] }), 1, '新形状：构建类任务应判 react(1)');
  // 什么都没有：历史上这里是 `undefined.find` → 整轮失败；现在必须退化成 weak 而不是抛。
  assert.equal(core.sessionMode({}), 'weak', '缺事件源必须退化成 weak，不得抛');

  // v4-flash 家族的 router-core 是逐字节克隆出来的第二份，同样要过。
  const v4 = await import(pathToFileURL(path.join(PRESETS, 'v4-flash-godmode-opencode-go', 'router-core.mjs')).href);
  assert.equal(v4.sessionMode({}), 'weak', 'v4 家族：缺事件源不得抛');
  assert.equal(v4.sessionMode({ snapshotEvents: () => [userMsg] }), 0, 'v4 家族：新形状结果一致');
});
