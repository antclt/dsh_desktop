'use strict';

// 会话持久化「损坏会话日志容错」单元测试（node --test）。
// 覆盖上游 #112 新增的两个 transform（纯函数，无文件 I/O）：
//   1) transformPersistenceCorruptGuard —— 三态（匹配 / 已应用 / 失配）
//   2) transformPersistenceAll       —— 尾部撕裂恢复 + 损坏会话跳过的组合语义
// 背景：2026-08 事故——卷影恢复带回零填充头部的会话日志，导致 listArtifacts
// 读首行时整个 plugin tree 初始化崩溃。这两个 transform 把「读首行」包进
// try-catch，损坏时告警跳过该会话（continue），不再击穿启动扫描。
//
// 隔离：纯字符串变换，不读写文件，不触碰真实 ~/.dsh 或 node_modules。

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  PERSISTENCE_CORRUPT_MARKER,
  PERSISTENCE_TORN_MARKER,
  PERSISTENCE_TORN_MARKER_V2,
  PERSISTENCE_TORN_HEAD,
  PERSISTENCE_TORN_HEAD_V2,
  PERSISTENCE_COMPLETE_CHECK_V1,
  PERSISTENCE_COMPLETE_CHECK_NEW,
  transformPersistenceCorruptGuard,
  transformPersistenceAll,
} = require('../lib/runtime-patches');

// 以下锚点镜像 runtime-patches.js 的内部常量，与源文件逐字节一致，用于构造
// 「未打补丁」的 fixtures（torn-tail 的注入体与两代首行已改为按引用取用，
// 不再在测试里另抄字面串——抄的那份会变成第二处漂移源）。
// rc.1 重锚：上游把 header 读取下沉进 readGenerationHeader(selected)，
// corrupt-guard 的锚点从 alpha.5 的「listArtifacts 内联 const first = ...」读行
// 改为「listArtifacts 包住 readGenerationHeader 调用的 catch(error)」——
// 保留 SessionFormatUnsupportedError 先行 continue，其余告警 + continue。
const CORRUPT_OLD = '\t\t\t\t} catch (error) {\n\t\t\t\t\tif (error instanceof SessionFormatUnsupportedError) continue;\n\t\t\t\t\tthrow error;\n\t\t\t\t}';
const FRAME_LOOP_OLD = 'let remainingFrames = frames.length - 1;\n\t\t\tfor (const plaintext of decodedFrames) {';
const WRITE_OLD = '\t\t\t\tscanner.write(plaintext);\n\t\t\t\tremainingFrames -= 1;';
const COMPLETE_CHECK = '\t\t\tif (complete.committedBytes !== complete.inputBytes) throw new Error("corrupt Zstandard session log: complete frame contains a torn JSONL record");';

// 同时含「尾部撕裂」三个锚点 + 「损坏会话」锚点的完整原始源码。
const FULL_SRC = [FRAME_LOOP_OLD, WRITE_OLD, COMPLETE_CHECK, CORRUPT_OLD].join('\n');

test('transformPersistenceCorruptGuard：匹配 → 改写 catch 跳过损坏会话', () => {
  const changed = transformPersistenceCorruptGuard(CORRUPT_OLD, 't.js');
  assert.equal(changed.status, 'changed');
  // 注入的核心语义：损坏读失败在该 catch 内被降级为「告警 + continue」，
  // 格式版本不兼容的先行 continue 分支保留，原先的无条件下钻 throw error 消失。
  assert.ok(changed.src.includes(PERSISTENCE_CORRUPT_MARKER), '应写入 corrupt-guard marker');
  assert.ok(changed.src.includes('} catch (error) {'), '应改写既有 catch 而非另起块');
  assert.ok(changed.src.includes('if (error instanceof SessionFormatUnsupportedError) continue;'),
    '格式版本不兼容先行 continue 应原样保留');
  assert.ok(changed.src.includes('skipping corrupt session log'), '告警文案应含 skipping corrupt session log');
  assert.ok(changed.src.includes('${selected.sourcePath}'), '告警应点出损坏会话文件（rc.1 取径 selected.sourcePath）');
  assert.ok(changed.src.includes('continue;'), '损坏时应 continue 跳过该会话');
  // 原「throw error」整句不再存在于该 catch（已被告警 + continue 取代）。
  assert.ok(!changed.src.includes(CORRUPT_OLD), '旧的 throw error 收尾 catch 应被改写');
  assert.ok(!/} catch \(error\) \{\n\t+if \(error instanceof SessionFormatUnsupportedError\) continue;\n\t+throw error;/.test(changed.src),
    'catch 内不得残留无条件 throw error（击穿启动扫描的正是它）');
});

test('transformPersistenceCorruptGuard：已应用 → already', () => {
  assert.equal(transformPersistenceCorruptGuard('// ' + PERSISTENCE_CORRUPT_MARKER, 't.js').status, 'already');
});

test('transformPersistenceCorruptGuard：失配 → anchor-missing 且绝不改写', () => {
  const src = 'export const x = 1;';
  const miss = transformPersistenceCorruptGuard(src, 't.js');
  assert.equal(miss.status, 'anchor-missing');
  assert.ok(miss.detail.includes('损坏会话容错锚点'), 'detail 应说明是损坏会话容错锚点失配');
  assert.ok(miss.detail.includes('版本可能已变更'), 'detail 应提示版本可能已变更');
});

test('transformPersistenceAll：两个补丁都命中 → 同时应用（changed）', () => {
  const changed = transformPersistenceAll(FULL_SRC, 't.js');
  assert.equal(changed.status, 'changed');
  assert.ok(changed.src.includes(PERSISTENCE_TORN_MARKER), '应含尾部撕裂 marker');
  assert.ok(changed.src.includes(PERSISTENCE_CORRUPT_MARKER), '应含损坏会话 marker');
  // 尾部撕裂：三个锚点均被改写。
  assert.ok(!changed.src.includes(FRAME_LOOP_OLD), 'FRAME_LOOP 旧锚点应被改写');
  assert.ok(!changed.src.includes(WRITE_OLD), 'WRITE 旧锚点应被改写');
  assert.ok(changed.src.includes('tornCompleteFrameStart'), '应注入 tornCompleteFrameStart 逻辑');
});

test('transformPersistenceAll：仅损坏会话补丁命中（尾部撕裂已应用）→ changed', () => {
  const src = ['// ' + PERSISTENCE_TORN_MARKER, CORRUPT_OLD].join('\n');
  const changed = transformPersistenceAll(src, 't.js');
  assert.equal(changed.status, 'changed');
  assert.ok(changed.src.includes(PERSISTENCE_CORRUPT_MARKER), '损坏会话 marker 应写入');
  assert.ok(!changed.src.includes(CORRUPT_OLD), '旧 const first 应被改写');
});

test('transformPersistenceAll：仅尾部撕裂补丁命中（损坏会话已应用）→ changed', () => {
  const src = [FRAME_LOOP_OLD, WRITE_OLD, COMPLETE_CHECK, '// ' + PERSISTENCE_CORRUPT_MARKER].join('\n');
  const changed = transformPersistenceAll(src, 't.js');
  assert.equal(changed.status, 'changed');
  assert.ok(changed.src.includes(PERSISTENCE_TORN_MARKER), '尾部撕裂 marker 应写入');
  assert.ok(!changed.src.includes(FRAME_LOOP_OLD), 'FRAME_LOOP 旧锚点应被改写');
});

test('transformPersistenceAll：两个补丁都已应用 → already', () => {
  const src = [PERSISTENCE_TORN_HEAD_V2.trim(), '// ' + PERSISTENCE_CORRUPT_MARKER].join('\n');
  assert.equal(transformPersistenceAll(src, 't.js').status, 'already');
});

test('transformPersistenceAll：v1 在野副本就地升级，产物与 pristine 全新应用逐字节相同', () => {
  const fresh = transformPersistenceAll(FULL_SRC, 't.js');
  assert.equal(fresh.status, 'changed');
  // 由全新应用反推 v1 在野形态：v1 与 v2 只差【首行 marker】+【torn-tail 返回块】
  // 两处（FRAME_LOOP/WRITE 两处注入两代共用），逆回去就是真实的历史字节。
  const inWildV1 = fresh.src
    .split(PERSISTENCE_TORN_HEAD_V2).join(PERSISTENCE_TORN_HEAD)
    .split(PERSISTENCE_COMPLETE_CHECK_NEW).join(PERSISTENCE_COMPLETE_CHECK_V1);
  assert.ok(inWildV1.includes(PERSISTENCE_TORN_MARKER) && !inWildV1.includes(PERSISTENCE_TORN_MARKER_V2),
    '构造出的必须是 v1 世代副本（含 v1 marker、不含 v2 marker）');
  const upgraded = transformPersistenceAll(inWildV1, 't.js');
  assert.equal(upgraded.status, 'changed');
  assert.equal(upgraded.note, 'v1-repair');
  assert.equal(upgraded.src, fresh.src,
    '升级产物必须与「pristine 全新应用」逐字节相同（新增差异处时必须同步升级通道）');
});

test('transformPersistenceAll：升级产物落在 rc.1 扁平 torn-tail 契约上', () => {
  const out = transformPersistenceAll(FULL_SRC, 't.js').src;
  assert.ok(out.includes('tornTruncateTo: tornCompleteFrameStart,'), '应写 rc.1 扁平字段 tornTruncateTo');
  assert.ok(out.includes('recoveredTail: prefix.events.slice(tornCompleteEventCount)'), '应写 recoveredTail 回灌');
  assert.ok(out.includes('inheritedEventCount: prefix.inheritedEventCount,'),
    '应带 rc.1 必填的 inheritedEventCount（缺失时 seeded 会话在 toHeaderLine 硬抛）');
  assert.ok(!/tornMarker:\s*\{/.test(out), '活代码里不得残留 v1 嵌套 tornMarker 返回体');
});

test('transformPersistenceAll：幂等——首次 changed，二次 already', () => {
  const once = transformPersistenceAll(FULL_SRC, 't.js');
  assert.equal(once.status, 'changed');
  const twice = transformPersistenceAll(once.src, 't.js');
  assert.equal(twice.status, 'already');
});

test('transformPersistenceAll：全部失配 → anchor-missing（损坏会话 detail 优先）', () => {
  const miss = transformPersistenceAll('export const x = 1;', 't.js');
  assert.equal(miss.status, 'anchor-missing');
  assert.ok(miss.detail.includes('损坏会话容错锚点'), '应返回损坏会话容错锚点失配的 detail');
});

test('transformPersistenceAll：尾部撕裂命中 + 损坏会话失配 → 仅撕裂应用（互不阻塞）', () => {
  // 只有尾部撕裂三个锚点，无损坏会话锚点：撕裂照常应用，损坏会话失配不阻断。
  const src = [FRAME_LOOP_OLD, WRITE_OLD, COMPLETE_CHECK].join('\n');
  const changed = transformPersistenceAll(src, 't.js');
  assert.equal(changed.status, 'changed');
  assert.ok(changed.src.includes(PERSISTENCE_TORN_MARKER), '尾部撕裂 marker 应写入');
  assert.ok(!changed.src.includes(PERSISTENCE_CORRUPT_MARKER), '损坏会话失配，不应写入其 marker');
});

test('transformPersistenceAll：尾部撕裂失配 + 损坏会话命中 → 仅损坏会话应用（互不阻塞）', () => {
  // 只有损坏会话锚点，无尾部撕裂锚点：损坏会话容错照常应用。
  const changed = transformPersistenceAll(CORRUPT_OLD, 't.js');
  assert.equal(changed.status, 'changed');
  assert.ok(changed.src.includes(PERSISTENCE_CORRUPT_MARKER), '损坏会话 marker 应写入');
  assert.ok(!changed.src.includes(PERSISTENCE_TORN_MARKER), '尾部撕裂失配，不应写入其 marker');
});
