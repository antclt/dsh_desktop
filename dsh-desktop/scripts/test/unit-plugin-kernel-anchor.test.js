'use strict';
// 内核槽位锚点新鲜度回归锁（node --test）。
//
// 背景（0.6.5 实爆）：dsh-better-sidebar 用 `#root [data-slot="conversation"]` 定位
// 「会话列」，再据此给底部面板算 left/right（面板横跨会话列）并在量到之前保持
// `visibility:hidden`。内核 0.1.6-alpha.1 把该槽位改名为 **main.conversation**
// （实测 `[data-slot]` 值域里已无裸 conversation，且 `[data-pane]` / `[data-dsh-frame]`
// 整体不存在）→ 锚点 0 命中 → centerMeasured 恒 false → 底部面板停在
// `left:0; right:innerWidth`（宽 ~0.4px）+ hidden → 用户侧表现为
// **「点文件后不出预览」**（标签其实开了，只是落在一个不可见面板里）。
//
// 判据：会话列锚点必须**同时**认两代槽位名（旧 conversation / 新 main.conversation），
// 且 CSS 让位规则要打在「深一层」的元素上（槽位宿主在 0.1.6 退化成 0 尺寸包装层，
// 直接 `:has(> [data-slot=...])` 会让位落在空元素上、面板遮住输入框）。
// src 与随包分发的 lib 双向校验（源与产物同源，漏改任一侧即红）。
//
// 用法：node --test scripts/test/unit-plugin-kernel-anchor.test.js

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const PLUGIN = path.join(__dirname, '..', '..', 'assets', 'plugins', 'dsh-better-sidebar');

const TARGETS = [
  ['src/client/Sidebar.tsx', '源（Sidebar 量测）'],
  ['lib/client.js', '产物 client.js'],
  ['lib/client-registry.js', '产物 client-registry.js'],
];

test('会话列锚点必须同时认两代槽位名（0.1.6 把 conversation 改名为 main.conversation）', () => {
  const offenders = [];
  for (const [rel, label] of TARGETS) {
    const f = path.join(PLUGIN, rel);
    if (!fs.existsSync(f)) { offenders.push(label + ': 文件缺失 ' + rel); continue; }
    const s = fs.readFileSync(f, 'utf8');
    if (!s.includes('conversation')) continue; // 与该文件无关
    const hasOld = s.includes('[data-slot=\\"conversation\\"]') || s.includes('[data-slot="conversation"]');
    const hasNew = s.includes('main.conversation');
    if (!hasOld || !hasNew) {
      offenders.push(`${label}：旧锚点=${hasOld} 新锚点(main.conversation)=${hasNew}`);
    }
  }
  assert.deepEqual(offenders, [], '以下位置的会话列锚点未覆盖当前内核槽位名：\n' + offenders.join('\n'));
});

test('CSS 让位必须打在深一层的会话列上（:has(> * > …)），且保留 #root 前缀', () => {
  // 只扫「确实内嵌/持有让位 CSS」的文件：layout.css 源，以及内嵌它的两个 lib
  // （Sidebar.tsx 只设置 --dsh-sidebar-height 变量，不含 CSS 规则，故不在内）。
  const CSS_TARGETS = [
    ['src/client/layout.css', '源 layout.css'],
    ['lib/client.js', '产物 client.js'],
    ['lib/client-registry.js', '产物 client-registry.js'],
  ];
  const offenders = [];
  for (const [rel, label] of CSS_TARGETS) {
    const f = path.join(PLUGIN, rel);
    if (!fs.existsSync(f)) { offenders.push(label + ': 文件缺失 ' + rel); continue; }
    const s = fs.readFileSync(f, 'utf8');
    if (!s.includes('dsh-sidebar-height') || !s.includes('margin-bottom')) continue;
    const shallow = (s.split(':has(> [data-slot=\\"main.conversation\\"])').length - 1) +
      (s.split(':has(> [data-slot="main.conversation"])').length - 1);
    const deep = s.split(':has(> * > [data-slot=').length - 1;
    // 前缀判据：每条深层选择器都必须带 `#root `（源 CSS 里前面是换行、内嵌压缩版里是逗号，
    // 故只数「#root :has(> * > …」的条数是否等于深层条数，两种形态通吃）。
    const prefixed = s.split('#root :has(> * > [data-slot=').length - 1;
    if (shallow > 0) offenders.push(`${label}：仍存在浅层让位选择器（:has(> [data-slot=…])）→ 会落在 0 尺寸槽位宿主上`);
    if (deep === 0) offenders.push(`${label}：缺少深层让位选择器`);
    if (deep > 0 && prefixed === 0) offenders.push(`${label}：深层选择器丢了 #root 前缀（会匹配任意祖先 → 双重让位）`);
  }
  assert.deepEqual(offenders, [], offenders.join('\n'));
});
