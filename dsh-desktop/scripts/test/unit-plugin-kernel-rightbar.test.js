'use strict';
// 内核右栏整合回归锁（node --test）。
//
// 背景：内核 0.1.6-alpha.1 的右栏（@deepseek-ai/dsh-client-ui-sidebar-right）自带
// dockkit 分栏/拖宽/全屏，并给出公开的两段式扩展点——它自己的「文件 / 文档预览 /
// 终端」就注册在同一套 API 上：
//   ① ctx.sidebarRightTabs.register({ id, kind, title, guide })          —— 标签「类型」
//   ② ctx.slots.register({ name:'sidebar.right.pane.tab', key:<①的 id> }) —— 标签「主体」
// 本插件把整块工作台接成右栏里的一个标签（见 src/client/kernel-rightbar.tsx），
// 右侧面板 portal 进内核给的 pane；内核缺这两个服务时整体退回整合前的自绘浮层。
//
// 判据（漏改任一侧即红）：
//   a. 两段注册的形状与 key===id（内核靠 id 找主体，写成 kind 会渲染成「无法查看」）；
//   b. 兜底必须还在：服务缺席 → 不注册、不发布 pane → Sidebar 就地渲染（legacy）；
//   c. 不得把该包写进 package.json 的 dsh.client.inject —— inject 是硬前置，写进去
//      会让插件在缺少该服务的内核上整体不加载（integrated 与 legacy 都要活）；
//   d. 集成模式下「列宽/开关/拖宽」必须让给内核：不写 --dsh-sidebar-width、
//      不设 data-dsh-sidebar-collapsed、右侧开关钮让位给内核头部那颗；
//   e. 「露出侧边栏」的每条路径都要走 ensureKernelRightbarOpen（否则点文件后
//      内核右栏不展开，内容落在看不见的地方）。
//
// 用法：node --test scripts/test/unit-plugin-kernel-rightbar.test.js

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const PLUGIN = path.join(__dirname, '..', '..', 'assets', 'plugins', 'dsh-better-sidebar');
const BUNDLES = ['lib/client.js', 'lib/client-registry.js'];

const read = (rel) => fs.readFileSync(path.join(PLUGIN, rel), 'utf8');
const count = (haystack, needle) => haystack.split(needle).length - 1;

test('两段注册在位：类型（sidebarRightTabs.register）与主体（sidebar.right.pane.tab，key = 类型的 id）', () => {
  const offenders = [];

  const src = read('src/client/kernel-rightbar.tsx');
  if (!/KERNEL_RIGHTBAR_ID\s*=\s*'dsh-better-sidebar'/.test(src)) offenders.push('kernel-rightbar.tsx：ID 常量漂移');
  if (!/KERNEL_RIGHTBAR_KIND\s*=\s*'better-sidebar'/.test(src)) offenders.push('kernel-rightbar.tsx：KIND 常量漂移');
  // 类型注册的形状在 src 与产物里一致（常量名被保留，不内联成字面量）——同一条判据通吃。
  if (!/registerType\(\{[\s\S]{0,400}?id:\s*KERNEL_RIGHTBAR_ID[\s\S]{0,400}?kind:\s*KERNEL_RIGHTBAR_KIND/s.test(src)) {
    offenders.push('kernel-rightbar.tsx：类型注册缺 id/kind（内核按 id 找主体）');
  }
  if (!/guide:\s*\[/.test(src)) offenders.push('kernel-rightbar.tsx：缺 guide 卡片（展开落在引导页时没有入口）');
  if (!/slots\.inject\('sidebar\.right\.pane\.tab'[\s\S]{0,300}?key:\s*KERNEL_RIGHTBAR_ID/.test(src)) {
    offenders.push('kernel-rightbar.tsx：主体未注册到 sidebar.right.pane.tab 的 id 键下');
  }
  // 可选接法的桥：服务必须在结构上被判定过（否则「服务缺席」也会去注册）。
  if (!/sidebarRightTabs[\s\S]{0,200}?\.register/.test(src)) offenders.push('kernel-rightbar.tsx：未读取 sidebarRightTabs.register');

  for (const rel of BUNDLES) {
    const s = read(rel);
    if (!/KERNEL_RIGHTBAR_ID = "dsh-better-sidebar"/.test(s)) offenders.push(`${rel}：产物里没有 ID 常量（整合代码没打进去？）`);
    if (!/KERNEL_RIGHTBAR_KIND = "better-sidebar"/.test(s)) offenders.push(`${rel}：产物里没有 KIND 常量`);
    if (!/registerType\(\{[\s\S]{0,400}?id:\s*KERNEL_RIGHTBAR_ID[\s\S]{0,400}?kind:\s*KERNEL_RIGHTBAR_KIND/s.test(s)) {
      offenders.push(`${rel}：产物里缺类型注册（或 id/kind 不是内核约定值）`);
    }
    if (!/name:\s*"sidebar\.right\.pane\.tab"[\s\S]{0,200}?key:\s*KERNEL_RIGHTBAR_ID/.test(s)) {
      offenders.push(`${rel}：产物里主体注册的 key 未对上类型的 id`);
    }
  }

  assert.deepEqual(offenders, [], offenders.join('\n'));
});

test('兜底必须还在：服务缺席 → 不注册、不发布 pane，Sidebar 就地渲染（legacy）', () => {
  const offenders = [];
  const src = read('src/client/kernel-rightbar.tsx');
  const sidebar = read('src/client/Sidebar.tsx');

  // 结构性判定：两个服务都必须是函数才算在位，否则返回 null（不注册、不集成）。
  if (!/typeof tabs\?\.register !== 'function'\)\s*return null/.test(src)) offenders.push('缺 sidebarRightTabs 的能力判定');
  if (!/typeof right\?\.openTab !== 'function'/.test(src)) offenders.push('缺 sidebarRight.openTab 的能力判定');
  // pane 元素是 React 树的开关：没发布 = integrated 为假 = 就地渲染。
  if (!/useSyncExternalStore\(subscribeKernelPane,\s*\(\)\s*=>\s*paneEl/.test(src)) {
    offenders.push('缺 pane 元素的订阅（这是 integrated/legacy 的唯一开关）');
  }
  // 「集成生效」必须独立于「pane 元素在位」：内核列收起时 dock 卸载标签主体、
  // pane 元素消失，此时面板要**不渲染**（hideWhenNoTarget），否则会掉回就地渲染、
  // 以视口左上角铺满整个应用（实测截图：整屏错位）。
  if (!/useKernelRightbarActive\(\)/.test(sidebar)) offenders.push('Sidebar 未读「集成生效」标志（只用 pane 元素判定会在收起态错位）');
  if (!/props\.to === null\)\s*return props\.hideWhenNoTarget === true \? null : <>\{props\.children\}<\/>/.test(sidebar)) {
    offenders.push('MaybePortal 缺 hideWhenNoTarget 分支 —— 内核列收起时面板会掉回就地渲染');
  }
  if (!/<MaybePortal to=\{kernelPane\} hideWhenNoTarget=\{integrated\}>/.test(sidebar)) {
    offenders.push('面板未把 hideWhenNoTarget 接到 integrated');
  }
  if (!/props\.to === null\)\s*return props\.hideWhenNoTarget === true \? null : <>\{props\.children\}<\/>/.test(sidebar)) {
    offenders.push('MaybePortal 的「没有目标就就地渲染」分支丢了 —— legacy（内核无右栏服务）会渲染成空');
  }

  for (const rel of BUNDLES) {
    const s = read(rel);
    if (!/createPortal/.test(s)) offenders.push(`${rel}：产物里没有 portal（整合形态没打进去）`);
    if (!/function MaybePortal\(/.test(s)) offenders.push(`${rel}：产物里缺 MaybePortal`);
  }

  assert.deepEqual(offenders, [], offenders.join('\n'));
});

test('manifest 不得把内核右栏包写进 dsh.client.inject（inject 是硬前置，会连带禁用整个插件）', () => {
  const pkg = JSON.parse(read('package.json'));
  const inject = pkg.dsh?.client?.inject ?? [];
  assert.ok(Array.isArray(inject), 'dsh.client.inject 形状变了');
  const offenders = inject.filter((id) => /sidebar-right/.test(id));
  assert.deepEqual(
    offenders,
    [],
    '内核右栏是可选接法（ctx.inject）：写进 dsh.client.inject 会让插件在没有该服务的内核上整体不加载',
  );
  // 可选接法本身要在位，否则「有服务也不集成」。
  assert.match(read('src/client/index.tsx'), /ctx\.inject\(\['sidebarRightTabs', 'sidebarRight'\]/, '缺可选注入（可选接法）');
});

test('集成模式下把列宽/开关/拖宽让给内核，只保留底部面板那条push', () => {
  const offenders = [];
  const sidebar = read('src/client/Sidebar.tsx');

  // 1) 宽度变量在集成模式下必须为 0（内核那一列负责宽度）。
  if (!/const width = !integrated && !narrow && snapshot\.state\?\.panelOpen === true/.test(sidebar)) {
    offenders.push('列宽 push 未按 integrated 关闭（会与内核那一列叠加成双份让位）');
  }
  // 2) 高度变量（底部面板）不受 integrated 影响 —— 底部面板仍在会话列下方。
  if (!/const height = !narrow && snapshot\.state\?\.bottomOpen === true/.test(sidebar)) {
    offenders.push('底部面板的 push 被误改（终端位置会变）');
  }
  // 3) 折叠属性只在 legacy 设。
  if (!/const collapsed = !integrated && \(state === undefined \|\| !state\.panelOpen\)/.test(sidebar)) {
    offenders.push('data-dsh-sidebar-collapsed 未按 integrated 关闭');
  }
  // 4) 右侧开关钮让位给内核头部那颗；底部那颗保留。
  if (!/\{!integrated && \(\s*\n\s*<Tooltip label=\{state\.panelOpen \? t\('collapse'\) : t\('expand'\)\}/.test(sidebar)) {
    offenders.push('集成模式下仍渲染自己的右侧开合钮（与内核头部那颗重复）');
  }
  if (!/aria-label=\{state\.bottomOpen \? t\('collapseBottomPanel'\) : t\('expandBottomPanel'\)\}/.test(sidebar)) {
    offenders.push('底部面板的开关钮丢了（终端入口）');
  }
  // 5) 自绘拖宽把手在集成模式隐藏。
  if (!/\{!narrow && !integrated && \(/.test(sidebar)) offenders.push('集成模式下仍渲染自绘拖宽把手');

  assert.deepEqual(offenders, [], offenders.join('\n'));
});

test('「露出侧边栏」的每条路径都走 ensureKernelRightbarOpen（否则内核右栏不展开）', () => {
  const service = read('src/client/service.ts');
  const sidebar = read('src/client/Sidebar.tsx');
  const calls = count(service, 'ensureKernelRightbarOpen()') + count(sidebar, 'ensureKernelRightbarOpen()');
  // service 的文件打开 + Sidebar 的三条自动露出（subagent / jobs / 跳转）
  assert.ok(
    count(service, 'ensureKernelRightbarOpen()') >= 1,
    'service 的文件打开路径未接内核展开（点文件不会展开内核右栏）',
  );
  assert.ok(
    count(sidebar, 'if (!ensureKernelRightbarOpen()) store.reduce') >= 3,
    '自动露出（subagent / 后台作业 / 跳转）未全部接内核展开，实得 ' + calls,
  );
  // 展开失败必须回落到 legacy 的 togglePanel —— 而不是什么都不做。
  assert.equal(
    count(sidebar, 'if (!ensureKernelRightbarOpen()) store.reduce(s => s.panelOpen ? s : togglePanel(s))'),
    3,
    '回落分支数量不对',
  );
});

test('偏好项两端都在位（客户端读 prefs、宿主 schema 能回写）', () => {
  const prefs = read('src/prefs-shared.ts');
  const config = read('src/config.ts');
  const offenders = [];
  if (!/kernelRightbar: 'auto' \| 'legacy'/.test(prefs)) offenders.push('prefs-shared 缺 kernelRightbar 类型');
  if (!/kernelRightbarAutoOpen: boolean/.test(prefs)) offenders.push('prefs-shared 缺 kernelRightbarAutoOpen 类型');
  if (!/kernelRightbar: 'auto',/.test(prefs)) offenders.push('缺默认值 kernelRightbar');
  if (!/kernelRightbarAutoOpen: true,/.test(prefs)) offenders.push('缺默认值 kernelRightbarAutoOpen');
  if (!/kernelRightbar: z\.union\(\[z\.const\('auto'\), z\.const\('legacy'\)\]\)/.test(config)) {
    offenders.push('config.ts 的 PrefsSchema 缺 kernelRightbar（设置回写会被当未知字段丢掉）');
  }
  if (!/kernelRightbarAutoOpen: z\.boolean\(\)/.test(config)) offenders.push('config.ts 的 PrefsSchema 缺 kernelRightbarAutoOpen');
  assert.deepEqual(offenders, [], offenders.join('\n'));
});
