'use strict';

// ---------------------------------------------------------------------------
// unit-balance-config-entry.test.js —— dsh-balance 设置条目化（2026-10-16）的机器锁。
//
// 背景：壳层 ⋯ 菜单「显示余额/本轮费用」（toggle-balance）自设置子系统迁到
// 内核 SettingsForms 起就是死开关——它写壳侧 settings.json，而插件只读内核
// settings.describe() 的 profile 条目行；且插件从未导出 Config，条目永远进不了
// describe() 名单（describe 只收录「导出了 Config 且含 ≥1 个 volatile 字段」
// 的 fiber 活条目）。处理：菜单项退役 + 插件补声明 Config + 客户端自注册设置行。
//
// 2026-10-16 隔离内核实机把两条推断证伪，本文件的口径据此重写：
//   ① 「声明 Config 后内核自动生成设置页」是**错的**：autoGenerate 只存在于
//      dsh-settings 与 wire schema，客户端包 0 消费方；设置导航每一项都要自己
//      往槽里注册。只声明不注册的结果是开关无处可拨（比退役掉的 ⋯ 菜单还退化）。
//   ② projectForm(volatileForm(schema), plainConfig(config)) **只投影 volatile
//      声明过的字段**：手写 config 块里未声明的键（balancePrices）从 row.value
//      直接消失，实测种子 99/9.9/88 不进取价载荷——README 承诺的价目覆盖是死的。
//      修法是把 balancePrices 也声明为 volatile 字典。
//
// 本文件锁六件事（正反两个方向）：
//   1. 正向：Config 导出形态满足内核 describe() 的三道门槛（导出 Config、
//      带 .toJSON、字段 volatile），默认值与「未配置视为开启」语义一致；
//   2. 正向：Config 字段集 == readSettings 读法 == scheduler 消费点逐名对齐；
//   3. 正向：readSettings 只认投影后的 row.value（未声明键与退役别名一律忽略）；
//   4. 正向：客户端半确实往设置槽里注册了两行（①的修法落点）；
//   5. 负向：壳侧四处（bridge-shim 菜单项/开关分支、menu.rs act 与键映射、
//      lifecycle.rs app_init 返回键、菜单文案）不得回潮；
//   6. 负向：Config 不得用 .optional()（本 fork 无此方法，导入期即抛、整条目
//      被 loader-isolation 摘掉），也不关自动表单/不复活 settings.get 幽灵读法。
//
// 纯静态扫描 + 插件入口动态 import + readSettings 内存桩（不触网、不写盘、
// 不碰真实 ~/.dsh 与 %APPDATA%\DSH Desktop）。
// 运行：node --test scripts/test/unit-balance-config-entry.test.js
// ---------------------------------------------------------------------------

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

const ROOT = path.join(__dirname, '..', '..'); // dsh-desktop/
const TAURI = path.join(ROOT, '..', 'dsh-tauri');
const PLUGIN = path.join(ROOT, 'assets', 'plugins', 'dsh-balance');
const ENTRY = path.join(PLUGIN, 'lib', 'index.js');
const CLIENT = path.join(PLUGIN, 'lib', 'client.js');
const SCHEDULER = path.join(PLUGIN, 'lib', 'balance-scheduler.js');
const SHIM = path.join(TAURI, 'src-tauri', 'crates', 'bridge', 'dist', 'bridge-shim.js');
const MENU_RS = path.join(TAURI, 'src-tauri', 'src', 'app', 'src', 'commands', 'menu.rs');
const LIFECYCLE_RS = path.join(TAURI, 'src-tauri', 'src', 'app', 'src', 'commands', 'lifecycle.rs');

function read(file) {
  return fs.readFileSync(file, 'utf8').replace(/\r\n/g, '\n');
}

/**
 * 取「代码面」：剥掉块注释、整行注释与行尾注释，专供负向断言使用。
 * 本仓库的教训注释会把被禁字面量原文写进散文（`settings.get(ns)`、
 * `section.prices`、`.optional()` 都出现过），直接扫全文会让负向断言恒红。
 * 行尾注释的正则要求 // 前不是冒号，保住 'https://' 这类串里的双斜杠。
 */
function codeOf(file) {
  return read(file)
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .split('\n')
    .filter((line) => !/^\s*(\/\/|\*|\/\*)/.test(line))
    .map((line) => line.replace(/(^|[^:])\/\/[^\n]*/g, '$1'))
    .join('\n');
}

let modPromise = null;
function pluginMod() {
  if (!modPromise) modPromise = import(pathToFileURL(ENTRY).href);
  return modPromise;
}

/** schemastery 的 volatile 字段解析后是 cosmokit Volatile 引用（.get() 取值）。 */
function unwrap(v) {
  return v && typeof v.get === 'function' ? v.get() : v;
}

// ---- 1. 导出形态（内核 describe() 的三道门槛）-------------------------------

test('Config 导出且带 toJSON；三字段全 volatile，两个布尔默认 true', async () => {
  const mod = await pluginMod();
  assert.equal(mod.name, 'dsh-balance');
  assert.deepEqual(mod.inject, ['webServer'], 'inject 不得加 settings 硬依赖（官方包缺席会整插件装配失败）');
  assert.ok(mod.Config, '必须导出 Config（未导出的条目永不进 describe() 名单）');

  // 门槛①：内核 SettingsForms.schema(entry) 判 entry.fiber.runtime.Config.toJSON。
  assert.equal(typeof mod.Config.toJSON, 'function', 'Config 必须可 toJSON（describe 收录判据）');
  const json = mod.Config.toJSON();
  const root = json.refs[json.uid];
  assert.equal(root.type, 'object');
  const dict = root.dict || {};
  const keys = Object.keys(dict).sort();
  assert.deepEqual(keys, ['balancePrices', 'showBalanceDock', 'showOpenCodeGoUsage'], 'Config 字段集漂移');

  // 门槛②：≥1 个 volatile 字段（无 volatile 字段表单不出现、页内也写不回去）。
  // 门槛③：DSH fork 解析时把 volatile 字段包成 Volatile 引用，loader 的
  // live-commit 才提交得动；public schemastery 会静默丢弃每次改写。
  // balancePrices 也必须在名单里：projectForm 只投影 volatileForm 选中的字段，
  // 未声明/非 volatile 的手写 config 键会从 row.value 消失（实测教训，见头部②）。
  for (const key of keys) {
    const ref = json.refs[dict[key]];
    assert.ok(ref, `字段 ${key} 的 schema 引用缺失`);
    assert.equal(ref.meta && ref.meta.volatile, true, `字段 ${key} 必须 volatile（否则不进表单、页内读不到也写不回）`);
  }
  for (const key of ['showBalanceDock', 'showOpenCodeGoUsage']) {
    const ref = json.refs[dict[key]];
    assert.equal(ref.type, 'boolean', `字段 ${key} 应为布尔`);
    assert.equal(ref.meta && ref.meta.default, true, `字段 ${key} 默认应为 true（未配置=开启语义）`);
  }
  const prices = json.refs[dict.balancePrices];
  assert.equal(prices.type, 'dict', 'balancePrices 应为字典（模型名 → 价目）');
  assert.deepEqual(prices.meta && prices.meta.default, {}, 'balancePrices 默认空字典（未配置=不覆盖）');

  // 解析行为：默认值填充 + 显式覆盖（Volatile 引用解包后取裸值）。
  const d = mod.Config({});
  assert.equal(unwrap(d.showBalanceDock), true);
  assert.equal(unwrap(d.showOpenCodeGoUsage), true);
  const c = mod.Config({ showBalanceDock: false });
  assert.equal(unwrap(c.showBalanceDock), false);
  assert.equal(unwrap(c.showOpenCodeGoUsage), true);
});

test('balancePrices 半份覆盖解析得过，且不用 .optional()（本 fork 无此方法）', async () => {
  const mod = await pluginMod();
  // 手写 config 块常只给一两个档（其余回落内置有效价），必须解析得过。
  const ok = mod.Config["~standard"].validate({ balancePrices: { 'deepseek-chat': { cacheMiss: 99 } } });
  assert.equal(ok.issues, undefined, '半份价目覆盖被拒：' + JSON.stringify(ok.issues));
  // 反证之一：错类型仍要挡住（价目是钱，不能默默吞下字符串）。
  const bad = mod.Config["~standard"].validate({ balancePrices: { 'deepseek-chat': { cacheMiss: '99' } } });
  assert.ok(bad.issues && bad.issues.length > 0, '字符串单价应被 schema 拒绝');
  // 本 fork 的 z.number() 没有 .optional()——写过一次，模块导入期 TypeError，
  // 整个 balance 条目被 loader-isolation 摘掉、dock 全灭（2026-10-16 隔离实测）。
  assert.ok(!codeOf(ENTRY).includes('.optional('), '本 fork 无 .optional()，用了就是导入期崩溃');
});

test('schemastery 取自 DSH fork，且不引入 settings.get 幽灵读法', () => {
  const src = read(ENTRY);
  assert.ok(src.includes('import z from "@deepseek-ai/schemastery"'), '必须 import @deepseek-ai/schemastery（DSH fork）');
  assert.ok(!src.includes('from "schemastery"'), '不得用 public schemastery（volatile live-commit 会静默失效）');
  // 内核 SettingsForms 没有 get()：历史上那行 typeof 守卫恒假，整段静默跳过。
  assert.ok(!/settings\.get\s*\(/.test(codeOf(ENTRY)), '不得再用 settings.get()（内核无此 API，读法恒空）');
});

// ---- 2. 字段名与消费端逐名对齐 ----------------------------------------------

test('Config 字段名 == readSettings 读法 == scheduler 消费点', async () => {
  const mod = await pluginMod();
  const keys = Object.keys(mod.Config.toJSON().refs[mod.Config.toJSON().uid].dict);
  const host = read(ENTRY);
  const sched = read(SCHEDULER);
  for (const key of keys) {
    assert.ok(host.includes(`section.${key}`), `宿主 readSettings 未读 Config 字段 ${key}`);
    // 两个布尔走 disabled 短路；价目覆盖走 applyPriceOverrides 并入价目表。
    const consumed = sched.includes(`settings.${key} === false`) || sched.includes(`settings.${key}`);
    assert.ok(consumed, `scheduler 未消费 ${key}（写入将无效果）`);
  }
  // 价目覆盖的消费点具名锁死（改名会让覆盖静默失效，正是 issue #168 那类回归）。
  assert.ok(sched.includes('applyPriceOverrides(table, now, settings.balancePrices)'), 'scheduler 的价目覆盖消费点漂移');
});

// ---- 3. readSettings 只认投影后的 row.value ---------------------------------

/** 造一个只暴露 describe() 的 settings 服务桩，行形态对齐内核 namespaceView。 */
function ctxWithRows(rows) {
  return {
    get: (name) => (name === 'settings' ? { describe: () => rows } : undefined),
    logger: () => ({ info() {}, warn() {}, error() {} }),
  };
}

test('readSettings：三个声明字段都读得到', async () => {
  const { __internals } = await pluginMod();
  const out = __internals.readSettings(ctxWithRows([
    { ns: 'balance', value: { showBalanceDock: false, showOpenCodeGoUsage: true, balancePrices: { 'deepseek-chat': { cacheMiss: 99 } } } },
  ]));
  assert.equal(out.showBalanceDock, false);
  assert.equal(out.showOpenCodeGoUsage, true);
  assert.deepEqual(out.balancePrices, { 'deepseek-chat': { cacheMiss: 99 } });
});

test('readSettings：未声明键与退役别名一律忽略（projectForm 不会带出来）', async () => {
  const { __internals } = await pluginMod();
  const out = __internals.readSettings(ctxWithRows([
    { ns: 'balance', value: { someUnknownKey: 1, prices: { 'deepseek-chat': { cacheMiss: 1 } } } },
  ]));
  assert.deepEqual(out, {}, '非声明字段不得进 out（读它等于读一条永远为空的死路径）');
  // 反证：退役的 `section.prices` 别名不能回潮——它从未在 Config 里声明过。
  assert.ok(!codeOf(ENTRY).includes('section.prices'), 'prices 别名是死读，已删不得复现');
});

test('readSettings：条目不在 describe() 名单时按默认走，不隐藏 dock', async () => {
  const { __internals } = await pluginMod();
  assert.deepEqual(__internals.readSettings(ctxWithRows([])), {}, '读不到设置必须回空（scheduler 据此走默认开启）');
  assert.deepEqual(__internals.readSettings({ get: () => undefined }), {}, 'settings 服务缺席同样回空且不抛');
});

// ---- 4. 客户端半确实注册了设置行（开关的用户面落点）--------------------------

test('客户端注册两行到 settings.general.item，ns 用条目 id balance', () => {
  const src = read(CLIENT);
  assert.ok(src.includes('const ENTRY_ID = "balance"'), '设置读写必须按 profile 条目 id（不是包名 dsh-balance）');
  assert.ok((src.match(/settings\.general\.item/g) || []).length >= 4, '两条行各需注入与注册两处槽名');
  assert.ok(src.includes('"balance-dock"') && src.includes('"balance-opencode-go"'), '两条设置行缺失');
  // client.js 是 window.__ModuleLoader__ 形态（无 ESM 导出面），物化与两行的
  // 交互行为由 ta4-balance-client-legacy-inject 套件在 vm 里真跑。
  assert.ok(src.includes('exports.inject = ["slots", "remote", "remote.settings"]'), '客户端 inject 必须声明 remote.settings');
});

test('dock 显隐直读条目设置，不等载荷的 disabled 位', () => {
  const src = read(CLIENT);
  assert.ok(src.includes('useSettings'), 'dock 必须拿到设置 hook（否则关掉后最长挂约 3 分钟）');
  assert.ok(src.includes('settingsSnap.value.showBalanceDock === false'), 'dock 的隐藏判据漂移');
  // 反证：载荷 disabled 判据仍保留（宿主侧短路取数的语义不变）。
  assert.ok(src.includes('data.disabled === true'), '载荷侧 disabled 判据不得被删掉');
});

// ---- 3. 壳侧退役面（负向）----------------------------------------------------

test('桥垫片 ⋯ 菜单不含 toggle-balance / 「显示余额」文案', () => {
  const shim = read(SHIM);
  assert.ok(!shim.includes('toggle-balance'), 'bridge-shim 不得残留 toggle-balance');
  assert.ok(!shim.includes('显示余额'), 'bridge-shim 不得残留「显示余额/本轮费用」菜单文案');
  assert.ok(!shim.includes('showBalanceDock'), 'bridge-shim 不得残留 showBalanceDock 状态键');
  // 反证（正向）：同族开关仍在（toggle-notify 2026-10-22 随壳层通知下线，不在此列）。
  for (const act of ['toggle-close-to-tray', 'toggle-auto-update']) {
    assert.ok(shim.includes(`'${act}'`), `同族开关 ${act} 不应被误删`);
  }
  assert.ok(!shim.includes('toggle-notify'), '壳层回合完成通知开关已下线（改由 dsh-notify 插件）');
});

test('menu.rs / lifecycle.rs 不含 toggle-balance 与 showBalanceDock', () => {
  const menu = read(MENU_RS);
  // 按「登记形态」判（menu.rs 自身的退役说明与 None 断言是散文，不算登记）。
  assert.ok(!/"toggle-balance"\s*(?:\||=>)/.test(menu), 'menu.rs 不得再登记 toggle-balance act');
  assert.ok(!menu.includes('showBalanceDock'), 'menu.rs 不得再有 showBalanceDock 键');
  // 反证（正向）：toggle_key 对退役 act 显式返回 None（在测试里作证）。
  assert.ok(menu.includes('toggle_key("toggle-balance"), None'), 'menu.rs 测试须断言退役 act 无映射');
  const lifecycle = read(LIFECYCLE_RS);
  assert.ok(!/"showBalanceDock"\s*:/.test(lifecycle), 'app_init 不得再返回 showBalanceDock');
  // 反证（正向）：同族开关的返回键仍在（notifyOnTurnEnd 2026-10-22 随通知链下线）。
  for (const key of ['closeToTray', 'autoInstallUpdates']) {
    assert.ok(lifecycle.includes(`"${key}"`), `app_init 返回键 ${key} 不应被误删`);
  }
  assert.ok(!lifecycle.includes('"notifyOnTurnEnd"'), 'app_init 不得再返回 notifyOnTurnEnd');
});

// ---- 5. 反证：本文件的负向判据真的会咬 ---------------------------------------

test('反证：三条负向判据在变异体上必须变红（不是恒真）', () => {
  // 变异体只在这份字符串上造，绝不写盘。
  const entry = codeOf(ENTRY);
  const client = codeOf(CLIENT);

  // ① 死读别名回潮 → 判据必须抓到。
  const withAlias = entry.replace('const prices = section.balancePrices;',
    'const prices = section.balancePrices || section.prices;');
  assert.notEqual(withAlias, entry, '宿主读法锚点漂移，变异体没造出来（本条反证会假绿，先修测试）');
  assert.ok(withAlias.includes('section.prices'), '① 别名回潮必须被负向判据抓到');

  // ② .optional() 回潮（导入期 TypeError）→ 判据必须抓到。
  const withOptional = entry.replace('cacheMiss: z.number(),', 'cacheMiss: z.number().optional(),');
  assert.notEqual(withOptional, entry, '价目字段锚点漂移，变异体没造出来');
  assert.ok(withOptional.includes('.optional('), '② .optional() 必须被负向判据抓到');

  // ③ dock 不再直读设置（只认载荷）→ 判据必须抓到。
  const withoutGate = client.replace('settingsSnap.value.showBalanceDock === false', 'settingsSnap.value.nope === false');
  assert.notEqual(withoutGate, client, 'dock 显隐判据锚点漂移，变异体没造出来');
  assert.ok(!withoutGate.includes('settingsSnap.value.showBalanceDock === false'), '③ dock 显隐判据必须被负向判据抓到');

  // ④ 设置行注册被摘 → 正向判据依赖的槽名字面量必须消失（证明它不是恒真）。
  const withoutRows = client.replace(/"settings\.general\.item"/g, '"settings.general.retired"');
  assert.equal((withoutRows.match(/"settings\.general\.item"/g) || []).length, 0,
    '④ 摘掉注册后原槽名字面量应当消失（正向判据不是恒真）');
});
