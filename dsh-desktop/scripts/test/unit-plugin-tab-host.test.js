'use strict';
// 文件打开落点回归锁（node --test）。
//
// 背景（0.6.5 实爆）：dsh-better-sidebar 的 openTab 默认落在「全局 activePane」，
// 而底部面板的 pane 只要存在（它的自动终端 tab 会把它激活）就长期是 activePane
// → 资源管理器里点文件后，编辑器 tab 全部落进**底部面板**，右侧 workbench 永远是
// 空的。用户实报：「点击侧边栏文件后不会在右边预览」「我希望的是在右边侧边栏能够
// 预览」——预览其实开了，只是开在了会话列下方那条底部面板里。
//
// 判据：文件打开（openSidebarFile 的 editor 种子）必须显式点名落点树 'splits'
// （右侧 workbench），且 service 侧必须真的把 seed.host 应用到落点（rehostTab：
// 已在目标树 → 仅激活；在另一棵树 → 搬过去并清空/剪掉原 leaf）。
// src 与随包分发的两个 lib 双向校验（源与产物同源，漏改任一侧即红）。
//
// 用法：node --test scripts/test/unit-plugin-tab-host.test.js

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const PLUGIN = path.join(__dirname, '..', '..', 'assets', 'plugins', 'dsh-better-sidebar');

/** 源码 + 两个随包产物（同一 src/client/index.tsx 编两遍：官方频道 / 注册表频道）。 */
const SRC = 'src/client/service.ts';
const STATE_SRC = 'src/client/state.ts';
const INTERCEPT_SRC = 'src/client/intercept.tsx';
const BUNDLES = ['lib/client.js', 'lib/client-registry.js'];

function read(rel) {
  return fs.readFileSync(path.join(PLUGIN, rel), 'utf8');
}

test('文件打开必须点名右侧 workbench（host: splits），不得回到「跟随 activePane」', () => {
  const offenders = [];
  // openTab({ type: 'editor', … host: 'splits' })：种子里的 id 值是模板串
  // （`editor:${absolute}`），字面量里带花括号，故窗口式匹配而不是 [^}]*。
  const seedRe = (q) => new RegExp(
    `openTab\\(\\{[\\s\\S]{0,400}?type:\\s*${q}editor${q}[\\s\\S]{0,400}?host:\\s*${q}splits${q}`,
  );

  // 1) 文件打开漏斗：openSidebarFile 的 editor 种子必须带 host。
  const interceptSrc = read(INTERCEPT_SRC);
  if (!seedRe("'").test(interceptSrc)) {
    offenders.push(`${INTERCEPT_SRC}：openSidebarFile 的 editor 种子缺 host: 'splits'`);
  }
  for (const rel of BUNDLES) {
    if (!seedRe('"').test(read(rel))) {
      offenders.push(`${rel}：openSidebarFile 的 editor 种子缺 host: "splits"（产物未同步）`);
    }
  }

  // 2) seed 契约：OpenTabSeed 必须声明 host，且 openTab 必须真的用它。
  const svc = read(SRC);
  if (!/host\?:\s*SidebarTreeKey/.test(svc)) offenders.push(`${SRC}：OpenTabSeed 未声明 host?: SidebarTreeKey`);
  if (!/seed\.host\s*!==\s*undefined[\s\S]{0,80}rehostTab\(landed,\s*tab\.id,\s*seed\.host\)/.test(svc)) {
    offenders.push(`${SRC}：openTab 未把 seed.host 应用到落点（缺 rehostTab 调用）`);
  }
  for (const rel of BUNDLES) {
    const s = read(rel);
    if (!/seed\.host !== void 0\)\s*landed = rehostTab\(landed, tab\.id, seed\.host\)/.test(s)) {
      offenders.push(`${rel}：产物里 openTab 未应用 seed.host（缺 rehostTab 调用）`);
    }
  }

  // 3) 落点搬运语义：rehostTab 必须在（纯函数，state 侧）。
  const stateSrc = read(STATE_SRC);
  if (!/export function rehostTab\(state: SidebarState, tabId: string, host: SidebarTreeKey\)/.test(stateSrc)) {
    offenders.push(`${STATE_SRC}：缺 rehostTab 纯函数`);
  }
  for (const rel of BUNDLES) {
    if (!/function rehostTab\(state, tabId, host\)/.test(read(rel))) {
      offenders.push(`${rel}：产物里缺 rehostTab 实现`);
    }
  }

  assert.deepEqual(offenders, [], '文件打开落点未固定到右侧 workbench：\n' + offenders.join('\n'));
});

test('rehostTab 必须是「同树仅激活、跨树才搬移」，且搬移后清空的原 leaf 要被剪掉', () => {
  const src = read(STATE_SRC);
  const fnStart = src.indexOf('export function rehostTab(');
  assert.notEqual(fnStart, -1, 'state.ts 里找不到 rehostTab');
  // 取到函数体结束（下一个顶层 export function 之前）
  const nextTop = src.indexOf('\nexport function ', fnStart + 10);
  const body = src.slice(fnStart, nextTop === -1 ? src.length : nextTop);

  const offenders = [];
  if (!/treeOf\(state, from\) === host\)\s*return activateTab\(state, from, tabId\)/.test(body)) {
    offenders.push('缺「已在目标树 → 仅激活」的短路（否则每次打开都会把 tab 重新搬一遍）');
  }
  if (!/return moveTab\(state, from, tabId, target\.id\)/.test(body)) {
    offenders.push('缺跨树搬移（moveTab 负责清空/剪掉原 leaf 并设置 activePane）');
  }
  if (!/firstLeaf\(state\[host\]\)/.test(body)) {
    offenders.push('目标树的 activePane 不在该树时的兜底缺失（应退回该树 firstLeaf）');
  }
  assert.deepEqual(offenders, [], offenders.join('\n'));
});

test('两个频道产物同源：编辑 seed 的 host 值必须一致（改一侧忘另一侧即红）', () => {
  const offenders = [];
  const markers = [];
  for (const rel of BUNDLES) {
    const s = read(rel);
    const hits = s.match(/host: "splits"/g) || [];
    markers.push(hits.length);
    if (hits.length < 1) offenders.push(`${rel}：host: "splits" 缺失`);
  }
  assert.deepEqual(offenders, [], offenders.join('\n'));
  assert.equal(markers[0], markers[1], '两个频道的 host 出现次数不一致（产物不同源）');
});
