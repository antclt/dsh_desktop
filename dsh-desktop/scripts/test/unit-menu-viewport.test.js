'use strict';

// issue #36 + #182 补丁脚本单元测试（node --test）。
// 覆盖：一次应用、二次幂等、anchor 缺失跳过且字节级不损坏、非目标包跳过、
//       #182 横向兜底夹紧 + ResizeObserver 重定位、#36/#182 两段各自独立幂等、
//       注入体作用域自证（浏览器里跑不崩）、vendored 真实内核字节的锚点新鲜度。
// 夹具口径：buildFakeTree 的片段按 compat-pin 版本（当前 0.1.5-rc.1）
//   dsh-client-ui-primitives/lib/index.js 里 Menu 的 useLayoutEffect 真实字节
//   逐行抄录（place() 体 3 tab、effect 体 2 tab、cleanup 4 行）——缩进就是锚的一部分，
//   夹具与内核字节脱钩会让「锚已漂移」在单测里静默隐身（本文件曾中招）。
// 用法：node --test scripts/test/unit-menu-viewport.test.js

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const { spawnSync, execFileSync } = require('node:child_process');
const { patchMenuViewport, MARKER, MARKER_182 } = require('../patch-menu-viewport');
const { kernel } = require('../compat/kernel-pin.json');

/** rc.1 Menu 的 useLayoutEffect 现场（withXClamp=false 即「旧形态：无 X 夹紧行」）。 */
function menuShape(withXClamp = true) {
  const lines = [
    'function Menu({ open, anchor, items, onClose, align = "start", side = "bottom", portal = false, getAnchorRect }) {',
    '\tconst rootRef = useRef(null);',
    '\tconst listRef = useRef(null);',
    '\tconst [fixedPos, setFixedPos] = useState(null);',
    '\tuseLayoutEffect(() => {',
    '\t\tif (!open || !portal) {',
    '\t\t\tsetFixedPos(null);',
    '\t\t\treturn;',
    '\t\t}',
    '\t\tconst place = () => {',
    '\t\t\tconst MARGIN = 12;',
    '\t\t\tconst vw = window.innerWidth;',
    '\t\t\tconst vh = window.innerHeight;',
    '\t\t\tconst listEl = listRef.current;',
    '\t\t\tconst lw = listEl?.offsetWidth ?? 0;',
    '\t\t\tconst lh = listEl?.offsetHeight ?? 0;',
    '\t\t\tlet x;',
    '\t\t\tlet y;',
  ];
  if (withXClamp) lines.push('\t\t\tif (lw > 0) x = Math.min(Math.max(x, MARGIN), vw - lw - MARGIN);');
  lines.push(
    '\t\t\tif (lh > 0) y = Math.min(Math.max(y, MARGIN), vh - lh - MARGIN);',
    '\t\t\tsetFixedPos({',
    '\t\t\t\tleft: x,',
    '\t\t\t\ttop: y',
    '\t\t\t});',
    '\t\t};',
    '\t\tplace();',
    '\t\twindow.addEventListener("scroll", place, true);',
    '\t\twindow.addEventListener("resize", place);',
    '\t\treturn () => {',
    '\t\t\twindow.removeEventListener("scroll", place, true);',
    '\t\t\twindow.removeEventListener("resize", place);',
    '\t\t};',
    '\t}, [open, portal, align, side, getAnchorRect]);',
    '\treturn jsx("div", {',
    '\t\tref: listRef,',
    '\t\tstyle: portal ? fixedPos ?? MEASURE_STYLE : void 0,',
    '\t});',
    '}',
    'export { Menu };',
  );
  return lines.join('\n');
}

function buildFakeTree(t, withXClamp = true) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-menu-vp-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const file = path.join(root, '@deepseek-ai', 'dsh-client-ui-primitives', 'lib', 'index.js');
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, menuShape(withXClamp));
  return { root, file };
}

/**
 * 注入体作用域自证：把 #182 注入的 ResizeObserver 两行摘出来，在与 useLayoutEffect
 * 体同形的作用域（有 place / listRef / window，**没有** place 内的局部量）里跑一遍。
 * 注入体若引用了只存在于 place() 内部的标识符（历史上就是 listEl），浏览器里
 * ResizeObserver 存在 → && 短路到该标识符 → ReferenceError 击穿定位 effect；
 * 这条判据把该形态钉成红灯，而不是等 UI 上「菜单不定位」再回溯。
 */
function assertRoBlockLivesInEffectScope(src, label) {
  const start = src.indexOf('// issue #182：');
  assert.ok(start !== -1, label + '：应找到 #182 注入的 ResizeObserver 段');
  const end = src.indexOf('return () => {', start);
  assert.ok(end > start, label + '：注入段后应跟随 cleanup');
  const block = src.slice(start, end);
  const observed = [];
  let placeCalls = 0;
  const callbacks = [];
  const listEl = { offsetWidth: 120, offsetHeight: 40 };
  const sandbox = {
    ResizeObserver: class {
      constructor(cb) { callbacks.push(cb); }
      observe(el) { observed.push(el); }
      disconnect() { observed.length = 0; }
    },
    window: { addEventListener() {}, removeEventListener() {} },
    place: () => { placeCalls += 1; },
    listRef: { current: listEl },
  };
  vm.createContext(sandbox);
  vm.runInContext('(function () {\n' + block + '\n})();', sandbox, {
    filename: 'ro-inject-block.js', timeout: 2000,
  });
  assert.deepEqual(observed, [listEl], label + '：ResizeObserver 应观察到列表元素（否则重定位形同虚设）');
  assert.equal(callbacks.length, 1, label + '：应注册且只注册一个 ResizeObserver');
  const before = placeCalls;
  callbacks[0]();
  assert.ok(placeCalls > before, label + '：尺寸变化回调应重新调用 place()（#182 的重定位语义）');
}

test('补丁脚本：一次应用、二次幂等、anchor 缺失跳过且不损坏', (t) => {
  const tree = buildFakeTree(t);
  // 第一次：应修改
  let n = patchMenuViewport(tree.root);
  assert.strictEqual(n, 1, '应补丁 1 个文件');
  const patched = fs.readFileSync(tree.file, 'utf8');
  assert.ok(patched.includes(MARKER), '应写入幂等标记');
  assert.ok(patched.includes('maxHeight: "min(calc(100vh - 24px), 560px)"'), '应写入视口封顶 maxHeight');
  assert.ok(patched.includes('overflowY: "auto"'), '应写入纵向滚动');
  assert.ok(patched.includes('Math.max(MARGIN, vh - Math.min(lh, vh - 2 * MARGIN) - MARGIN)'), 'y 夹紧应按封顶高度计算');
  assert.ok(patched.includes(MARKER_182), '应写入 #182 标记');
  assert.ok(patched.includes('else x = Math.min(Math.max(x, MARGIN), Math.max(MARGIN, vw - 2 * MARGIN));'), 'lw=0 时应按视口宽兜底夹紧');
  assert.ok(patched.includes('new ResizeObserver(() => place())'), '尺寸变化应重新 place');
  assert.ok(patched.includes('ro?.disconnect();'), 'cleanup 应断开 ResizeObserver（否则每次开合泄漏一个）');
  // 注入体作用域自证（place() 之外的 listEl 一求值即 ReferenceError）
  assertRoBlockLivesInEffectScope(patched, '夹具');
  // 第二次：零写入且内容不变
  n = patchMenuViewport(tree.root);
  assert.strictEqual(n, 0, '第二次应零写入');
  assert.strictEqual(fs.readFileSync(tree.file, 'utf8'), patched, '内容不应变化');
  // anchor 缺失：跳过且字节级不损坏
  fs.writeFileSync(tree.file, 'export const changed = true;\n完全不同的内容\n');
  const before = fs.readFileSync(tree.file);
  n = patchMenuViewport(tree.root);
  assert.strictEqual(n, 0, 'anchor 不匹配应跳过');
  assert.deepStrictEqual(fs.readFileSync(tree.file), before, '文件字节级不变');
});

test('作用域判据自身有捕获力：把注入体改回引用 place() 局部量即红', () => {
  // 负向控制——不先证这条判据会红，上面的「绿」只可能是它什么都没查。
  const broken = [
    '\t\t// issue #182：列表首帧 lw=0、字体/内容撑宽后需要重新 place。',
    '\t\tconst ro = typeof ResizeObserver !== "undefined" && listEl ? new ResizeObserver(() => place()) : null;',
    '\t\tif (ro && listEl) ro.observe(listEl);',
    '\t\treturn () => {',
    '\t\t\tro?.disconnect();',
    '\t\t};',
  ].join('\n');
  assert.throws(
    () => assertRoBlockLivesInEffectScope(broken, '负向控制'),
    /ReferenceError/,
    '注入体引用 listEl（place 的局部量）必须被作用域判据报红',
  );
});

test('补丁脚本：无 X 夹紧行的旧形态目标 → #36/#182 各自独立幂等（#182 跳过不损坏）', (t) => {
  // 旧形态靶：X 夹紧行压根不在场（#182 三锚缺一），但 #36 两锚齐备。
  // 期望：#36 段照常应用（这正是「两段独立」的含义），#182 段整段跳过、
  // 不落任何 #182 残留；此后文件已是收敛态，再跑必须零写入、字节不动。
  const tree = buildFakeTree(t, false);
  const n1 = patchMenuViewport(tree.root);
  assert.strictEqual(n1, 1, '#36 锚在场 → 该段应应用');
  const after36 = fs.readFileSync(tree.file, 'utf8');
  assert.ok(after36.includes(MARKER), '#36 标记应在位');
  assert.ok(!after36.includes('issue #182'), '无 X 锚 → #182 段跳过（不得写入 #182 残留）');
  assert.ok(!after36.includes('ResizeObserver'), '无 X 锚 → #182 段不得半投（RO 注入也不得有）');
  assert.ok(after36.includes('if (lh > 0) y = Math.min'), '#36 改写不得波及 y 夹紧语义');
  const n2 = patchMenuViewport(tree.root);
  assert.strictEqual(n2, 0, '无 X 锚 → #182 段跳过（不修改）');
  assert.strictEqual(fs.readFileSync(tree.file, 'utf8'), after36, '第二遍字节不应变化');
  const n3 = patchMenuViewport(tree.root);
  assert.strictEqual(n3, 0, '再跑仍跳过（幂等）');
});

test('补丁脚本：目标包缺失时返回 0 且不抛异常', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-menu-vp-empty-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  assert.strictEqual(patchMenuViewport(root), 0);
});

// ---------------------------------------------------------------------------
// 真实字节新鲜度：夹具抄得再像也是二手货。这一条直接打 vendored tarball 里
// compat-pin 版本（当前 0.1.5-rc.1）的 dsh-client-ui-primitives/lib/index.js，
// 内核换代导致 #36/#182 任一锚漂移时当场红。
// ---------------------------------------------------------------------------
const REPO_ROOT = path.resolve(__dirname, '..', '..', '..');
const PRIMITIVES_TARBALL = path.join(
  REPO_ROOT, 'dsh-desktop', 'vendor', 'dsh-kernel',
  `deepseek-ai-dsh-client-ui-primitives-${kernel.packageVersion}.tgz`,
);

test(`补丁脚本：vendored ${kernel.packageVersion} 真实字节 → #36 + #182 双段命中、幂等、产物可解析`, (t) => {
  assert.ok(fs.existsSync(PRIMITIVES_TARBALL), '缺 vendored primitives tarball: ' + PRIMITIVES_TARBALL);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-menu-real-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  // win32 显式用系统自带 bsdtar（Git Bash 的 GNU tar 会把 "C:\" 当远程主机）。
  const tarBin = process.platform === 'win32'
    ? path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'tar.exe')
    : 'tar';
  const res = spawnSync(tarBin, ['-xzf', PRIMITIVES_TARBALL, '-C', dir], { encoding: 'utf8' });
  assert.strictEqual(res.status, 0, 'tar 解包失败: ' + (res.stderr || ''));
  const pristineFile = path.join(dir, 'package', 'lib', 'index.js');
  const pristine = fs.readFileSync(pristineFile, 'utf8');

  const nmRoot = path.join(dir, 'nm');
  const target = path.join(nmRoot, '@deepseek-ai', 'dsh-client-ui-primitives', 'lib', 'index.js');
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, pristine);

  const stats = {};
  assert.strictEqual(patchMenuViewport(nmRoot, () => {}, stats), 1, '真实字节上应命中并改写 1 个文件');
  assert.strictEqual(stats.anchorMissing || 0, 0, '#36 锚不得失配');
  assert.strictEqual(stats.anchorMissing182 || 0, 0, '#182 锚不得失配');
  const patched = fs.readFileSync(target, 'utf8');
  assert.ok(patched.includes(MARKER), '#36 标记应在位');
  assert.ok(patched.includes(MARKER_182), '#182 标记应在位');
  assert.ok(patched.includes('maxHeight: "min(calc(100vh - 24px), 560px)"'), '视口封顶 maxHeight 应注入');
  assert.ok(patched.includes('else x = Math.min(Math.max(x, MARGIN), Math.max(MARGIN, vw - 2 * MARGIN));'), '横向兜底夹紧应注入');
  assertRoBlockLivesInEffectScope(patched, '真实字节');
  // 幂等
  assert.strictEqual(patchMenuViewport(nmRoot, () => {}, {}), 0, '第二遍应零写入');
  assert.strictEqual(fs.readFileSync(target, 'utf8'), patched, '第二遍内容不应变化');
  // 产物语法合法（真文件是 ESM）
  const checkFile = path.join(dir, 'check.mjs');
  fs.writeFileSync(checkFile, patched);
  assert.doesNotThrow(() => execFileSync(process.execPath, ['--check', checkFile], { stdio: 'pipe' }),
    '打补丁后的真实产物必须 node --check 通过');
});
