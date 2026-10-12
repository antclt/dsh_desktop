'use strict';

// unit-companion-disable-override.test.js — 内置插件「停用覆盖」的拉锯回归锁。
//
// 背景（2026-10-11 内置插件管理页需求）：随包内置件在插件中心页管不了，一半原因是看不见，
// 另一半是**关不住**——用户在管理面写下的停用（profile cordis.patch.yml 的
// `- id: <loader id>\n  disabled: true`）会不会被我们下一次启动的登记步骤抹掉。
//
// 嫌疑是真实的：registerCompanionPatchEntries 里有一段 bundle 迁移清理
// （dropBlocksByIds(text, bundleIds)），按 id 删 profile patch 层里的同名块，用来消灭
// 「bundle + patch 双登记」（issue #104 的启动崩溃）。停用块与旧的纯登记块**长得几乎一样**，
// 只差一行 `disabled: true`。这条锁钉住的就是那一线之差：
//   · 纯登记块（id + name）→ 必须被删（不删就双登记崩溃）；
//   · 停用块（id + name + disabled: true）→ 必须原样保留（删了就是「页面关掉、开机又开」）。
// 两个方向都断言，缺一条就是假绿。
//
// 另外把 sidecar 的 togglePluginInPatch（唯一写者）与这段清理串起来测：它产出的形状必须
// 正好落在「保留」一侧。这两台机器过去各写各的，从没被同一条用例串过。

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  registerCompanionPatchEntries,
  togglePluginInPatch,
  setPluginRemoved,
  parsePatchRows
} = require('../plugin-core/lib/patch-surgery');
const { COMPANION_PLUGINS } = require('../lib/companion-plugins');

// 生产调用现场（scripts/integration/plugin-sync.js）传的 bundleNames 是「以 bundle 形态分发的
// 包名集合」。内置线全部有 cordis.patch.yml（由 unit-hub-registry 的 loader id 锁咬住），
// 所以这里按全量给——迁移清理对每一条都会尝试，正是最坏情况。
const ALL_NAMES = new Set(COMPANION_PLUGINS.map((p) => p.name));
const ALL_IDS = COMPANION_PLUGINS.map((p) => p.id);

function register(patch, opts = {}) {
  return registerCompanionPatchEntries(patch, {
    plugins: COMPANION_PLUGINS,
    bundleNames: opts.bundleNames || ALL_NAMES,
    missingNames: opts.missingNames || new Set(),
    removedIds: opts.removedIds || new Set(),
    onDrop: () => {},
    onEntry: () => {}
  });
}

/** 按解析结果取某 id 的顶层条目（不靠正则复述实现）。 */
function topRow(text, id) {
  return parsePatchRows(text).top.find((r) => r.id === id) || null;
}
/** 某 id 在 patch 里是否还留有任何条目（顶层或 insert 内层）。 */
function anyRow(text, id) {
  const { top, inserts } = parsePatchRows(text);
  return top.some((r) => r.id === id) || inserts.some((r) => r.id === id);
}

test('停用块必须活过 boot 登记：逐条覆盖全部在册内置件（阳性对照同条内）', () => {
  const seed = COMPANION_PLUGINS
    .map((p) => `- id: ${p.id}\n  name: '${p.name}'\n  disabled: true\n`)
    .join('\n');
  const out = register(seed);

  const lost = ALL_IDS.filter((id) => {
    const row = topRow(out.patch, id);
    return !(row && row.disabled === true);
  });
  assert.deepEqual(lost, [], '被 boot 登记抹掉的停用行（拉锯本体）: ' + lost.join(', '));
  // 阳性对照：登记步骤确实跑到了这些 id 上——否则「全保留」是因为它压根没碰这批行。
  assert.equal(out.dropped.length, 0, '停用块不该进迁移清理的删除名单');
  assert.equal(out.changed, false, '全量停用的 profile 不该被改写；改写了说明还有别的分支在动这些行');
});

test('纯登记块必须被迁移清理删掉（反证上一条不是「空跑也绿」）', () => {
  const seed = COMPANION_PLUGINS
    .map((p) => `- id: ${p.id}\n  name: '${p.name}'\n`)
    .join('\n');
  const out = register(seed);
  const stillThere = ALL_IDS.filter((id) => anyRow(out.patch, id));
  assert.deepEqual(stillThere, [],
    'bundle 型插件的纯登记块必须全部移出 profile patch 层，留着就是双登记（issue #104）');
  assert.ok(out.dropped.length >= COMPANION_PLUGINS.length,
    '清理路径必须真的命中（dropped=' + out.dropped.length + ' / 在册=' + COMPANION_PLUGINS.length + '）');
});

test('唯一写者串测：关 → boot 登记 → 仍是关；再开 → 登记后不再有停用行', () => {
  const p = COMPANION_PLUGINS.find((x) => x.id === 'dsh-builtin-manager');
  assert.ok(p, '在册清单里必须有 dsh-builtin-manager');

  const empty = '# dsh web profile patch（由 DSH Desktop 维护）\n\n[]\n';
  const off = togglePluginInPatch(empty, p.id, false, p.name);
  assert.notEqual(off, empty, '关掉必须真的写入一行');
  assert.ok(topRow(off, p.id) && topRow(off, p.id).disabled === true, '写入形状必须是 id + name + disabled: true');

  const afterBoot = register(off);
  const kept = topRow(afterBoot.patch, p.id);
  assert.ok(kept && kept.disabled === true, 'boot 登记不得抹掉刚写下的停用（这就是拉锯本体）');
  assert.equal(afterBoot.changed, false, '停用行在位时登记步骤应当完全不动文件');

  const on = togglePluginInPatch(afterBoot.patch, p.id, true, p.name);
  assert.equal(anyRow(on, p.id), false, '再开必须把停用行整条清掉');
  const afterBoot2 = register(on);
  assert.equal(anyRow(afterBoot2.patch, p.id), false, '再开之后的 profile 不得留着停用行（否则下次启动又被误判为停用）');
});

test('卸载行是停用行的超集：disabled+removed 同行写入，且必须活过 boot 登记', () => {
  const p = COMPANION_PLUGINS[0];
  const removedText = setPluginRemoved('[]\n', p.id, true, p.name);
  const row = topRow(removedText, p.id);
  assert.ok(row && row.removed === true, '卸载写入必须落一行 removed: true');
  // 实测形状：卸载行**同时**带 disabled: true（setPluginRemoved 注释写明「与禁用同款」——
  // 只写 removed 的话条目仍会参与组合）。两条决策在文件里同处一行，分界发生在清单侧：
  // plugin-list 把 removed 的行归进 group='removed'，内置插件页按 group==='companion' 过滤，
  // 所以卸载件不会出现在内置列表里（该判据由 unit-builtin-manager-client 的 normalize 用例咬）。
  assert.equal(row.disabled, true, '卸载行必须同时停用，否则条目仍参与组合');

  const out = register(removedText, { removedIds: new Set([p.id]) });
  const after = topRow(out.patch, p.id);
  assert.ok(after && after.removed === true && after.disabled === true,
    '卸载决策必须原样在位（boot 靠它跳过复制与撤 bundle）');
  assert.equal(out.changed, false, '已卸载件不得被登记步骤重新写成启用');
});
