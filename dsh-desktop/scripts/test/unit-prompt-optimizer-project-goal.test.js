'use strict';

// ---------------------------------------------------------------------------
// unit-prompt-optimizer-project-goal.test.js
//
// dsh-prompt-optimizer 2.3.0「项目优化目标」线的行为回归锁（2026-10-16）。
//
// 功能（细节见插件 CHANGELOG 2.3.0 段）：用户在「设置 → Prompt 优化 → 项目优化目标」
// 里为某个项目写下的优化指令，按项目持久（宿主半边 ~/.dsh/prompt-optimizer-projects.json，
// 键 = 会话头 cwd，项目目录零写入），叠加进创作型任务（polish/iterate/structure）的
// 系统提示词——目标优先于内置的风格/语言偏好，但「只改写不执行 / 实体逐字保留 /
// 不编造新目标」三条保真与安全规则不可覆盖；repair（机械逐字恢复）不接受目标。
//
// 覆盖五段（全部跑真实产物/真实宿主模块，不重述实现）：
//   A. dist 纯行为：buildSystemPrompt 的目标叠加（zh/en、三任务）、trim、多行保真、
//      repair 排除——外加减掉排除分支的变异反证（判据不许空转）；
//   B. 端到端：runOptimize（宿主通道）真正发出的 SSE 请求体——system 含目标、
//      卡片 goalApplied 标记、无目标/取目标失败（fail-open）时行为与 2.2.1 一致、
//      缺变量触发 repair 阶段时该阶段 system 不含目标（排除在编排层也成立）；
//   C. 宿主半边（lib/index.js，动态 import 真实 ESM）：隔离 home（USERPROFILE/HOME
//      重定向 + os.homedir() 前置守卫，绝不触碰真实 ~/.dsh）下走 apply 捕获的
//      HTTP 路由——get/set 往返与落盘、冷会话持久化回落、清除语义、按项目隔离、
//      净化（trim/上限/类型）与错误码；makeHandler（RPC 通道）同语义抽检；
//   D. 设置行 UI（真实 React + 手驱钩子 mini 挂载）：无项目提示、上下文播种、
//      保存/清除与行内反馈、保存失败不吞错不丢草稿；反证：读取失败必须落到
//      无项目提示而不是空白/崩溃；
//   E. 会话解析链（2026-10-16 rc.2 实测校正）：getProjectContext 真实接线（spec.inject）
//      下，sessionId 必须按 sidebarRight.mounted → sessions.currentProvideInfo → null
//      解析——优先级 / 回落 / 双缺席短路三条用例（rc.2 里 currentProvideInfo 是幽灵字段，
//      只读它会静默把整个功能做成死的）。
//
// 未覆盖（真浏览器语义）：真 DOM 事件、真内核会话恢复——由隔离内核 + 真 Chromium
// 实测覆盖（记录在各轮 CHANGELOG）；本套件是防回归锁，不冒充浏览器实测。
//
// 运行：node --test scripts/test/unit-prompt-optimizer-project-goal.test.js
// ---------------------------------------------------------------------------

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const { pathToFileURL } = require('node:url');

const React = require('react');
const jsxRuntime = require('react/jsx-runtime');

const DSH = path.resolve(__dirname, '..', '..');
const PKG_DIR = path.join(DSH, 'assets', 'plugins', 'dsh-prompt-optimizer');
const DIST = path.join(PKG_DIR, 'dist', 'client.js');
const LIB = path.join(PKG_DIR, 'lib', 'index.js');
const SRC_GOAL = path.join(PKG_DIR, 'src', 'project-goal.ts');

// ---------------------------------------------------------------------------
// 隔离 home：宿主半边在模块加载期就计算 ~/.dsh 路径，环境变量必须先于 import 设置
// ---------------------------------------------------------------------------

const TEST_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'po-goal-home-'));
process.env.USERPROFILE = TEST_HOME; // Windows：uv_os_homedir 认 USERPROFILE（本机实证）
process.env.HOME = TEST_HOME; // POSIX（CI/ubuntu）
// 宿主半边自 2.4.0 起按内核口径解析 home（DSH_HOME 优先）——测试把它一起钉进临时目录，
// 否则环境里残留的 DSH_HOME 会把落点带出沙箱。
process.env.DSH_HOME = path.join(TEST_HOME, '.dsh');
// 前置守卫：如果 homedir() 不跟随环境变量，立即炸在「未 import 宿主模块、未写任何文件」之前，
// 绝不让测试把项目目标文件写进真实 ~/.dsh。
assert.equal(
  os.homedir(),
  TEST_HOME,
  'os.homedir() 未跟随 USERPROFILE/HOME 重定向——拒绝继续（不得触碰真实 home）',
);

const DSH_DIR = path.join(TEST_HOME, '.dsh');
const PROJECTS_FILE = path.join(DSH_DIR, 'prompt-optimizer-projects.json');

let hostLibPromise = null;
function loadHostLib() {
  if (!hostLibPromise) hostLibPromise = import(pathToFileURL(LIB).href);
  return hostLibPromise;
}

// ---------------------------------------------------------------------------
// dist 装载（vm）：注入内存 __test 锚点，暴露模块级实现（不动仓库文件）
// ---------------------------------------------------------------------------

/**
 * @param opts.fetch 沙箱 fetch（默认永不 settle：只有 UI/纯函数面用它时足够）
 */
function loadDist(opts = {}) {
  let src = fs.readFileSync(DIST, 'utf8');
  const anchor = '    return module.exports;';
  assert.ok(src.includes(anchor), 'dist 锚点 `return module.exports;` 丢失——build.mjs 工厂壳形态变了，同步本套件');
  src = src.replace(
    anchor,
    '    module.exports.__test = { buildSystemPrompt, projectGoalSection, projectLabel, MAX_GOAL_CHARS, runOptimize, getPreviewBusState, closePreview };\n' + anchor,
  );
  const sandbox = {
    window: { __ModuleLoader__: { load(m) { sandbox.__loaded = m; } } },
    console: { log() {}, error() {}, warn() {} },
    fetch: opts.fetch || (() => new Promise(() => {})),
    AbortController,
    setTimeout,
    clearTimeout,
    TextDecoder,
    document: opts.document || undefined,
  };
  vm.runInNewContext(src, sandbox, { filename: 'dsh-prompt-optimizer-client.js' });
  const loaded = sandbox.__loaded;
  assert.ok(loaded && typeof loaded.factory === 'function', '产物未经 __ModuleLoader__.load 注册 factory');
  const mod = loaded.factory((name) => {
    if (name === 'react') return React;
    if (name === 'react/jsx-runtime') return jsxRuntime;
    if (name === 'clsx') return { __esModule: true, default: (...a) => a.filter(Boolean).join(' ') };
    throw new Error('不得 require：' + name);
  });
  assert.ok(
    mod.__test && typeof mod.__test.buildSystemPrompt === 'function'
      && typeof mod.__test.projectGoalSection === 'function'
      && typeof mod.__test.runOptimize === 'function',
    '内存暴露锚点未命中——函数名被 minify 或已改名',
  );
  return { mod, sandbox };
}

/** 变异装载：把 repair 排除守卫从 dist 文本里删掉（内存副本），验证反证判据真能报红。
 *  2.4.0 起守卫改为「repair 直接返回正文」（不再只看 goal），变异把判据换成 polish，
 *  等于让 repair 落进附加段管线——目标串必须出现在 repair 提示词里，否则判据空转。 */
function loadMutantWithoutRepairExclusion() {
  const src = fs.readFileSync(DIST, 'utf8');
  // esbuild 会把单引号归一成双引号，锚点用正则吸收两种引号形态
  const guardRe = /if \(task === ['"]repair['"]\) return base;/;
  assert.match(src, guardRe, '排除守卫锚点丢失——实现形态变了，同步本套件');
  const mutated = src.replace(guardRe, "if (task === 'polish') return base;");
  assert.notEqual(mutated, src, '变异未生效');
  const sandbox = {
    window: { __ModuleLoader__: { load(m) { sandbox.__loaded = m; } } },
    console: { log() {}, error() {}, warn() {} },
    fetch: () => new Promise(() => {}),
  };
  vm.runInNewContext(
    mutated.replace(
      '    return module.exports;',
      '    module.exports.__test = { buildSystemPrompt };\n    return module.exports;',
    ),
    sandbox,
    { filename: 'dsh-prompt-optimizer-mutant.js' },
  );
  return sandbox.__loaded.factory((name) => {
    if (name === 'react') return React;
    if (name === 'react/jsx-runtime') return jsxRuntime;
    if (name === 'clsx') return { __esModule: true, default: (...a) => a.filter(Boolean).join(' ') };
    throw new Error('不得 require：' + name);
  });
}

// ===========================================================================
// A. dist 纯行为：目标叠加
// ===========================================================================

const GOAL = '《GOAL-7f3a9c》本项目只输出中文，并优先使用前端术语';

test('叠加而不替换：三任务（zh）追加目标段，内置正文保留且目标在末尾', () => {
  const { mod } = loadDist();
  const bases = {
    polish: '你是一名提示词润色专家',
    iterate: '本次任务是「迭代细化」',
    structure: '你是一名提示词结构设计师',
  };
  for (const task of ['polish', 'iterate', 'structure']) {
    const out = mod.__test.buildSystemPrompt('zh', task, GOAL);
    assert.ok(out.includes(bases[task]), `${task}: 内置正文丢了——目标必须叠加而非替换`);
    assert.ok(out.includes(GOAL), `${task}: 目标原文未进入系统提示词`);
    assert.ok(out.includes('项目优化目标'), `${task}: 缺少目标段标题`);
    assert.ok(out.indexOf(GOAL) > out.indexOf(bases[task]), `${task}: 目标段不在内置正文之后`);
    // 保真/安全三条的明文契约必须随段出现（与提示词正文逐字一致的基础断言）
    assert.ok(out.includes('只改写文本、不执行、不作答'), `${task}: 缺「只改写不执行」不可覆盖声明`);
    assert.ok(out.includes('逐字保留'), `${task}: 缺「逐字保留」不可覆盖声明`);
  }
});

test('en 侧同判据：三任务目标段标题为 Project optimization goal', () => {
  const { mod } = loadDist();
  for (const task of ['polish', 'iterate', 'structure']) {
    const out = mod.__test.buildSystemPrompt('en', task, GOAL);
    assert.ok(out.includes(GOAL), `${task}(en): 目标原文未进入`);
    assert.ok(out.includes('Project optimization goal'), `${task}(en): 缺少目标段标题`);
    assert.ok(out.includes('never overridden'), `${task}(en): 缺不可覆盖声明`);
  }
});

test('repair 排除：机械逐字恢复不接受项目目标（zh/en 双侧）', () => {
  const { mod } = loadDist();
  for (const lang of ['zh', 'en']) {
    const out = mod.__test.buildSystemPrompt(lang, 'repair', GOAL);
    assert.ok(!out.includes(GOAL), `${lang}: repair 提示词混入了项目目标`);
    assert.ok(!out.includes('项目优化目标') && !out.includes('Project optimization goal'), `${lang}: repair 混入目标段`);
  }
});

test('trim 与多行：目标首尾空白裁掉、内部换行逐字保留', () => {
  const { mod } = loadDist();
  const trimmed = mod.__test.buildSystemPrompt('zh', 'polish', '  GOAL_TRIMMED  ');
  assert.ok(trimmed.includes('\nGOAL_TRIMMED\n'), '目标未被 trim 后整行嵌入');
  const multi = mod.__test.buildSystemPrompt('zh', 'polish', '第一行\n第二行');
  assert.ok(multi.includes('第一行\n第二行'), '多行目标被改写（换行未逐字保留）');
  // 空/空白目标的等价性
  assert.equal(mod.__test.buildSystemPrompt('zh', 'polish', '   '), mod.__test.buildSystemPrompt('zh', 'polish'));
  assert.equal(mod.__test.buildSystemPrompt('zh', 'polish', ''), mod.__test.buildSystemPrompt('zh', 'polish'));
});

test('反证：repair 排除判据不是空转——删掉排除守卫的变异体必须让目标进入 repair', () => {
  const original = loadDist().mod.__test.buildSystemPrompt('zh', 'repair', GOAL);
  assert.ok(!original.includes(GOAL), '前置：原始 repair 不含目标');
  const mutant = loadMutantWithoutRepairExclusion();
  const mutatedOut = mutant.__test.buildSystemPrompt('zh', 'repair', GOAL);
  assert.ok(mutatedOut.includes(GOAL), '变异体（无排除守卫）仍未让目标进入 repair——判据空转');
});

// ===========================================================================
// B. 端到端：runOptimize 真正发出的 SSE 请求体
// ===========================================================================

function sseResponse(text) {
  const payload = `event: start\ndata: {}\n\nevent: delta\ndata: ${text}\n\nevent: done\ndata: {}\n\n`;
  const body = new ReadableStream({
    start(controller) {
      controller.enqueue(new TextEncoder().encode(payload));
      controller.close();
    },
  });
  return new Response(body, { status: 200, headers: { 'content-type': 'text/event-stream' } });
}

function makeE2eHarness({ goal, goalThrows = false, draft = '把 {{user_name}} 填进模板', result = '把变量填进模板。' }) {
  const requests = [];
  const sandboxFetch = async (url, init) => {
    requests.push({ url: String(url), body: init && init.body ? JSON.parse(String(init.body)) : null });
    return sseResponse(result);
  };
  const { mod } = loadDist({ fetch: sandboxFetch });
  const rpc = {
    call: async (endpoint) => {
      if (endpoint === 'sessionModel') {
        return { ok: true, value: { provider: 'deepseek', model: 'deepseek-v4-flash' } };
      }
      return { ok: true, value: {} };
    },
  };
  const run = () =>
    mod.__test.runOptimize({
      getConfig: () => ({ baseUrl: 'https://api.deepseek.com', apiKey: '', model: 'x', useSessionModel: true }),
      getLang: () => 'zh',
      getDraft: () => draft,
      host: { rpc },
      getSessionId: () => 'sess-1',
      getProjectGoal: async () => {
        if (goalThrows) throw new Error('host down');
        return goal;
      },
    });
  return { mod, requests, run };
}

test('端到端：目标的 system 真进入优化请求；缺变量触发 repair 阶段且该阶段 system 不含目标', async () => {
  const h = makeE2eHarness({ goal: GOAL });
  await h.run();
  assert.equal(h.requests.length, 2, `应有主任务 + 修复两阶段请求（实际 ${h.requests.length}）`);
  const main = h.requests[0].body;
  assert.equal(h.requests[0].url, '/dsh-prompt-optimizer/api/optimize.stream');
  assert.ok(main.system.includes(GOAL), '主任务 system 缺项目目标');
  assert.ok(main.system.includes('项目优化目标'), '主任务 system 缺目标段');
  assert.ok(main.text.includes('{{user_name}}'), '主任务证据缺草稿原文（夹具自证环）');
  const repair = h.requests[1].body;
  assert.ok(repair.system.includes('修复'), '第二阶段不是 repair 提示词');
  assert.ok(!repair.system.includes(GOAL), 'repair 阶段 system 混入了项目目标');
  // 卡片标记：runOptimize 完成（show）后 goalApplied 仍为 true
  assert.equal(h.mod.__test.getPreviewBusState().goalApplied, true, '卡片「已应用项目目标」标记未点亮');
});

test('端到端：无目标（null）与取目标失败（抛错 fail-open）都与 2.2.1 行为一致', async () => {
  // 无实体草稿（不触发 repair）：单阶段请求，system 不含目标段
  for (const variant of [{ goal: null }, { goal: null, goalThrows: true }]) {
    const h = makeE2eHarness({ draft: '普通草稿', result: '普通结果', ...variant });
    await h.run();
    assert.equal(h.requests.length, 1, '无目标不应触发 repair（夹具草稿无缺变量款）');
    assert.ok(!h.requests[0].body.system.includes('项目优化目标'), 'fail-open 下 system 混入了目标段');
    assert.equal(h.mod.__test.getPreviewBusState().goalApplied, false, '无目标下 goalApplied 不应点亮');
  }
  // 缺变量 + 取目标失败：优化照常走完两阶段且两阶段 system 都不含目标段
  const h = makeE2eHarness({ goal: null, goalThrows: true });
  await h.run();
  assert.equal(h.requests.length, 2);
  assert.ok(!h.requests[0].body.system.includes('项目优化目标'), 'fail-open 下 system 混入了目标段');
  assert.equal(h.mod.__test.getPreviewBusState().goalApplied, false, 'fail-open 下 goalApplied 不应点亮');
});

test('端到端：连跑两轮——第二轮无目标时 goalApplied 被 begin 归零（无脏标记）', async () => {
  const h = makeE2eHarness({ goal: GOAL });
  await h.run();
  assert.equal(h.mod.__test.getPreviewBusState().goalApplied, true);
  // 第二轮：换一个没有缺变量的草稿 + 无目标（改 harness 的 getProjectGoal 无法直接改——重载一个无目标 harness）
  const h2 = makeE2eHarness({ goal: null, draft: '普通草稿', result: '普通结果' });
  await h2.run();
  assert.equal(h2.mod.__test.getPreviewBusState().goalApplied, false, '新一轮 begin 未归零 goalApplied');
});

// ===========================================================================
// C. 宿主半边：HTTP 路由（apply 捕获）+ 隔离 home 落盘
// ===========================================================================

function makeHostCtx(overrides = {}) {
  const services = {
    sessions: {
      get: (id) => (id === 'sess-live' ? { header: { cwd: 'D:\\work\\alpha' } } : undefined),
    },
    sessionPersistence: {
      open: async (id) => {
        if (id === 'sess-cold') return { header: { cwd: '/proj/beta' }, close: async () => {} };
        throw new Error('unknown session');
      },
    },
    workspaceRegistry: {
      resolveByPath: async (p) => (String(p).includes('alpha') ? { title: 'Alpha 项目' } : undefined),
    },
    webServer: { register() {} },
    ...overrides,
  };
  const captured = { route: null };
  services.webServer = {
    register(config) { captured.route = config.handler; },
  };
  const ctx = {
    effect: (fn) => { fn(); },
    inject: (names, cb) => cb({ effect: (fn) => fn(), webServer: services.webServer }),
    get: (name) => services[name],
  };
  return { ctx, captured };
}

/** 走 apply 捕获的真 HTTP 路由（与客户端 callHost 同一条路）。 */
async function makeHttpCaller(overrides = {}) {
  const { makeHandler } = await loadHostLib();
  const { ctx, captured } = makeHostCtx(overrides);
  const mod = await loadHostLib();
  mod.apply(ctx);
  assert.ok(typeof captured.route === 'function', 'webServer 未注册 HTTP 路由（prefix /dsh-prompt-optimizer/api）');
  const httpCall = (method, args) => {
    const body = JSON.stringify(args ?? {});
    const req = {
      method: 'POST',
      url: `/dsh-prompt-optimizer/api/${method}`,
      async *[Symbol.asyncIterator]() { yield Buffer.from(body, 'utf8'); },
    };
    return new Promise((resolve, reject) => {
      const res = {
        writeHead() {},
        end(payload) {
          try { resolve(JSON.parse(payload)); } catch (e) { reject(e); }
        },
      };
      Promise.resolve(captured.route(req, res)).catch(reject);
    });
  };
  return { httpCall, makeHandler, ctx };
}

function readProjectsFile() {
  return JSON.parse(fs.readFileSync(PROJECTS_FILE, 'utf8'));
}

test('宿主 get：活会话解析 cwd + 工作区标题；无目标为空串；get 不写盘', async () => {
  fs.rmSync(DSH_DIR, { recursive: true, force: true });
  const { httpCall } = await makeHttpCaller();
  const g = await httpCall('projectGoal.get', { sessionId: 'sess-live' });
  assert.equal(g.ok, true);
  assert.equal(g.value.cwd, 'D:\\work\\alpha');
  assert.equal(g.value.instruction, '');
  assert.equal(g.value.title, 'Alpha 项目');
  assert.equal(fs.existsSync(PROJECTS_FILE), false, 'get 不应写盘');
});

test('宿主 set/get 往返：trim 后落盘到隔离 home，回读一致', async () => {
  fs.rmSync(DSH_DIR, { recursive: true, force: true });
  const { httpCall } = await makeHttpCaller();
  const s = await httpCall('projectGoal.set', { sessionId: 'sess-live', instruction: '  只输出中文  ' });
  assert.equal(s.ok, true);
  assert.equal(s.value.instruction, '只输出中文');
  assert.ok(typeof s.value.updatedAt === 'string' && s.value.updatedAt.length > 0, 'set 应回报 updatedAt');
  assert.ok(fs.existsSync(PROJECTS_FILE), '项目目标文件未落在隔离 home（重定向失败即会走到这里并且真实 home 有污染风险）');
  assert.equal(readProjectsFile().projects['D:\\work\\alpha'].instruction, '只输出中文');
  const g = await httpCall('projectGoal.get', { sessionId: 'sess-live' });
  assert.equal(g.value.instruction, '只输出中文');
});

test('宿主：冷会话回落 sessionPersistence 解析（首请求先于会话附着的实测形态）', async () => {
  fs.rmSync(DSH_DIR, { recursive: true, force: true });
  const { httpCall } = await makeHttpCaller();
  const s = await httpCall('projectGoal.set', { sessionId: 'sess-cold', instruction: 'beta 的规则' });
  assert.equal(s.ok, true);
  assert.equal(s.value.cwd, '/proj/beta');
  assert.equal(readProjectsFile().projects['/proj/beta'].instruction, 'beta 的规则');
  // registry 对 /proj/beta 返回 undefined → 无 title 字段（客户端回落路径末段）
  const g = await httpCall('projectGoal.get', { sessionId: 'sess-cold' });
  assert.equal(g.ok, true);
  assert.equal(Object.prototype.hasOwnProperty.call(g.value, 'title'), false, '无标题时不应带 title 字段');
});

test('宿主清除语义：空/空白指令删条目（不留空壳）', async () => {
  fs.rmSync(DSH_DIR, { recursive: true, force: true });
  const { httpCall } = await makeHttpCaller();
  await httpCall('projectGoal.set', { sessionId: 'sess-live', instruction: '先设一个' });
  assert.ok('D:\\work\\alpha' in readProjectsFile().projects);
  const c = await httpCall('projectGoal.set', { sessionId: 'sess-live', instruction: '   ' });
  assert.equal(c.ok, true);
  assert.equal(c.value.instruction, '');
  assert.equal('D:\\work\\alpha' in readProjectsFile().projects, false, '清除后条目应被删除而不是留空壳');
});

test('宿主按项目隔离（反证：清一个不动另一个）', async () => {
  fs.rmSync(DSH_DIR, { recursive: true, force: true });
  const { httpCall } = await makeHttpCaller();
  await httpCall('projectGoal.set', { sessionId: 'sess-live', instruction: 'alpha 规则' });
  await httpCall('projectGoal.set', { sessionId: 'sess-cold', instruction: 'beta 规则' });
  await httpCall('projectGoal.set', { sessionId: 'sess-live', instruction: '' });
  const projects = readProjectsFile().projects;
  assert.equal('D:\\work\\alpha' in projects, false, 'alpha 应被清除');
  assert.equal(projects['/proj/beta'].instruction, 'beta 规则', 'beta 被误伤——隔离判据失效');
});

test('宿主净化：无项目、超长、非字符串三类请求的拒绝码与不落盘', async () => {
  fs.rmSync(DSH_DIR, { recursive: true, force: true });
  const { httpCall } = await makeHttpCaller();
  const noSession = await httpCall('projectGoal.set', { sessionId: '', instruction: 'x' });
  assert.equal(noSession.ok, false);
  assert.equal(noSession.error.code, 'no-project');
  const unknown = await httpCall('projectGoal.get', { sessionId: 'sess-unknown' });
  assert.equal(unknown.ok, false);
  assert.equal(unknown.error.code, 'no-project');
  assert.equal(fs.existsSync(PROJECTS_FILE), false, '被拒绝的请求不应写出文件');
  const tooLong = await httpCall('projectGoal.set', { sessionId: 'sess-live', instruction: 'x'.repeat(4001) });
  assert.equal(tooLong.ok, false);
  assert.equal(tooLong.error.code, 'goal-too-long');
  const badType = await httpCall('projectGoal.set', { sessionId: 'sess-live', instruction: 42 });
  assert.equal(badType.ok, false);
  assert.equal(badType.error.code, 'bad-instruction');
  assert.equal(fs.existsSync(PROJECTS_FILE), false, '超长/错类型请求不应落盘');
});

test('宿主：workspaceRegistry 缺席时 get 仍可用（无 title，fail-open）', async () => {
  fs.rmSync(DSH_DIR, { recursive: true, force: true });
  const { httpCall } = await makeHttpCaller({ workspaceRegistry: undefined });
  const g = await httpCall('projectGoal.get', { sessionId: 'sess-live' });
  assert.equal(g.ok, true);
  assert.equal(g.value.cwd, 'D:\\work\\alpha');
  assert.equal(Object.prototype.hasOwnProperty.call(g.value, 'title'), false);
});

test('宿主：RPC 通道（makeHandler）与 HTTP 通道同语义抽检', async () => {
  fs.rmSync(DSH_DIR, { recursive: true, force: true });
  const { makeHandler } = await loadHostLib();
  const { ctx } = makeHostCtx();
  const handler = makeHandler(ctx);
  const s = await handler('projectGoal.set', { sessionId: 'sess-live', instruction: 'RPC 通道' });
  assert.equal(s.ok, true);
  const g = await handler('projectGoal.get', { sessionId: 'sess-live' });
  assert.equal(g.ok, true);
  assert.equal(g.value.instruction, 'RPC 通道');
});

// ===========================================================================
// D. 设置行 UI：真实 React + 手驱钩子 mini 挂载
// ===========================================================================

function createMounter(Component, props) {
  const internals = React.__SECRET_INTERNALS_DO_NOT_USE_OR_YOU_WILL_BE_FIRED;
  assert.ok(internals && internals.ReactCurrentDispatcher, 'React 18 内部 dispatcher 槽位缺失（升级 React 需同步本夹具）');
  const slot = internals.ReactCurrentDispatcher;

  const cells = [];
  const pendingEffects = [];
  let scheduled = false;
  let cursor = 0;
  let tree = null;

  const sameDeps = (a, b) => a && b && a.length === b.length && a.every((v, i) => Object.is(v, b[i]));

  const hooks = {
    useState(init) {
      const i = cursor++;
      if (!(i in cells)) cells[i] = { value: typeof init === 'function' ? init() : init };
      const cell = cells[i];
      const set = (next) => {
        const v = typeof next === 'function' ? next(cell.value) : next;
        if (Object.is(v, cell.value)) return;
        cell.value = v;
        scheduled = true;
      };
      return [cell.value, set];
    },
    useRef(init) {
      const i = cursor++;
      if (!(i in cells)) cells[i] = { value: { current: init } };
      return cells[i].value;
    },
    useCallback(fn, deps) {
      const i = cursor++;
      const prev = cells[i];
      if (!prev || !sameDeps(prev.deps, deps)) cells[i] = { value: fn, deps };
      return cells[i].value;
    },
    useEffect(fn, deps) {
      const i = cursor++;
      const prev = cells[i];
      if (!prev || !sameDeps(prev.deps, deps)) pendingEffects.push(fn);
      cells[i] = { deps };
    },
    useLayoutEffect(fn, deps) { return hooks.useEffect(fn, deps); },
  };

  const render = () => {
    cursor = 0;
    const prev = slot.current;
    slot.current = hooks;
    try { tree = Component(props); } finally { slot.current = prev; }
    return tree;
  };

  const settle = async (rounds = 12) => {
    for (let i = 0; i < rounds; i++) {
      scheduled = false;
      render();
      for (const fn of pendingEffects.splice(0)) fn();
      await new Promise((r) => setTimeout(r, 1));
      if (!scheduled && pendingEffects.length === 0) break;
    }
    return tree;
  };

  return { settle, deep: () => tree };
}

function textAll(node) {
  if (node === null || node === undefined || typeof node === 'boolean') return '';
  if (typeof node === 'string' || typeof node === 'number') return String(node);
  if (Array.isArray(node)) return node.map(textAll).join('');
  if (typeof node === 'object' && node.props) return textAll(node.props.children);
  return '';
}
function collect(node, out = []) {
  if (node === null || node === undefined || typeof node === 'boolean') return out;
  if (Array.isArray(node)) { node.forEach((n) => collect(n, out)); return out; }
  if (typeof node !== 'object' || !node.props) return out;
  out.push(node);
  collect(node.props.children, out);
  return out;
}
const byTextIncludes = (tree, text) => collect(tree).find((el) => textAll(el).includes(text)) || null;
/** 树全文（文本存在性断言一律用它——byTextIncludes 的首命中可能是外层容器而非目标节点） */
const treeText = (tree) => textAll(tree);
/** 按钮专用查找：类型 + 自身文本双锚定（避免命中外层容器）。 */
const buttonByText = (tree, text) => collect(tree)
  .find((el) => el.type === 'button' && textAll(el).includes(text)) || null;

const ZH_DICT = {
  'settings.title': 'Prompt 优化',
  'settings.sessionModelEnabled': '已选择会话默认模型',
  'settings.projectGoalTitle': '项目优化目标（当前项目）',
  'settings.projectGoalNoProject': '未识别到当前项目——请先在某个工作区打开一个会话，再回来设置',
  'settings.projectGoalSave': '保存目标',
  'settings.projectGoalClear': '清除',
  'settings.projectGoalSaved': '已保存——本项目今后的优化都会带上这条目标',
  'settings.projectGoalCleared': '已清除——本项目恢复默认优化行为',
  'settings.projectGoalSaveFailed': '保存失败：',
  'settings.desc': '配置润色接口',
};

/** 通过 apply 捕获设置行组件与注册规格（spec.inject() 给出与真内核同构的接线 props）。 */
function captureSettingsRow(mod) {
  let comp = null;
  let spec = null;
  const slots = {
    inject(name, cb) { cb(); },
    register(s, c) {
      if (s && s.id === 'prompt-optimizer-settings') { comp = c; spec = s; }
    },
  };
  const fakeCtx = {
    effect: (fn) => { try { fn(); } catch { /* locale 注册失败不影响本夹具 */ } },
    locale: { register() {}, getLocale: () => ({ active: 'zh' }) },
    on() {},
    sessions: { currentProvideInfo: { getSnapshot: () => ({ sessionId: 'sess-live' }) } },
    inject: (names, cb) => cb({ slots, sessions: fakeCtx.sessions }),
    get: () => undefined,
  };
  mod.apply(fakeCtx);
  assert.ok(typeof comp === 'function', '设置行组件未被注册（settings.general.item / id=prompt-optimizer-settings）');
  assert.ok(spec && typeof spec.inject === 'function', '注册规格缺 inject 工厂');
  return { comp, spec };
}

function makeDocStub() {
  return {
    _listeners: {},
    addEventListener(type, fn) { (this._listeners[type] ||= []).push(fn); },
    querySelector() { return null; },
    querySelectorAll() { return []; },
    createElement() { return { dataset: {}, textContent: '' }; },
    head: { appendChild() {} },
    activeElement: null,
  };
}

function uiProps(extra = {}) {
  const saved = [];
  return {
    saved,
    props: {
      t: (key) => ZH_DICT[key] ?? key,
      useStore: (sel) => sel({
        values: { baseUrl: 'https://api.deepseek.com', apiKey: '', model: 'deepseek-v4-flash', useSessionModel: true },
        saved: false,
        error: null,
      }),
      actions: { seed() {}, commit() {}, edit() {}, validate: () => null, fail() {} },
      getConfig: () => ({ baseUrl: 'https://api.deepseek.com', apiKey: '', model: 'deepseek-v4-flash', useSessionModel: true }),
      saveConfig: async () => {},
      resetConfig: async () => {},
      getEpoch: () => 0,
      getHostStatus: () => new Promise(() => {}),
      // 缺省保存实现：目标区块的渲染条件是「读上下文 + 保存实现」双提供
      saveProjectGoal: async (instruction) => ({
        ok: true,
        goal: { cwd: 'D:\\work\\alpha', title: 'Alpha 项目', instruction },
      }),
      ...extra,
    },
  };
}

async function mountSettingsRow(props) {
  const { mod } = loadDist({ document: makeDocStub() });
  const { comp } = captureSettingsRow(mod);
  const mounter = createMounter(comp, props);
  await mounter.settle();
  const title = collect(mounter.deep()).find(
    (el) => typeof el.props?.onClick === 'function' && textAll(el).includes('Prompt 优化'),
  );
  assert.ok(title, '设置行标题（可点展开）不在树里');
  title.props.onClick();
  await mounter.settle();
  return mounter;
}

test('设置行：无项目上下文 → 明确提示且不渲染输入面', async () => {
  const { props } = uiProps({ getProjectContext: async () => null });
  const mounter = await mountSettingsRow(props);
  assert.ok(treeText(mounter.deep()).includes('未识别到当前项目'), '无项目提示缺失');
  assert.equal(collect(mounter.deep()).find((el) => el.type === 'textarea'), undefined, '无项目时不应渲染目标输入框');
});

test('设置行：上下文播种 → 编辑 → 保存往返与行内反馈；清除同理', async () => {
  const { saved, props } = uiProps({
    getProjectContext: async () => ({ cwd: 'D:\\work\\alpha', title: 'Alpha 项目', instruction: '旧目标' }),
    saveProjectGoal: async (instruction) => {
      saved.push(instruction);
      return { ok: true, goal: { cwd: 'D:\\work\\alpha', title: 'Alpha 项目', instruction } };
    },
  });
  const mounter = await mountSettingsRow(props);
  assert.ok(treeText(mounter.deep()).includes('Alpha 项目'), '项目名未展示');
  const ta = collect(mounter.deep()).find((el) => el.type === 'textarea');
  assert.ok(ta, '目标输入框未渲染');
  assert.equal(ta.props.value, '旧目标', '已设目标未播种进输入框');

  ta.props.onChange({ target: { value: '新目标' } });
  await mounter.settle();
  const saveBtn = buttonByText(mounter.deep(), '保存目标');
  assert.ok(saveBtn, '保存按钮不在树里');
  saveBtn.props.onClick();
  await mounter.settle();
  assert.deepEqual(saved, ['新目标'], '保存的目标文本不对');
  assert.ok(treeText(mounter.deep()).includes('已保存——本项目今后的优化都会带上这条目标'), '保存反馈缺失');

  const clearBtn = buttonByText(mounter.deep(), '清除');
  assert.ok(clearBtn, '清除按钮不在树里');
  clearBtn.props.onClick();
  await mounter.settle();
  assert.deepEqual(saved, ['新目标', ''], '清除未以空串提交');
  assert.ok(treeText(mounter.deep()).includes('已清除——本项目恢复默认优化行为'), '清除反馈缺失');
  const ta2 = collect(mounter.deep()).find((el) => el.type === 'textarea');
  assert.equal(ta2.props.value, '', '清除后输入框未清空');
});

test('反证：保存失败必须展示原文且不吞错、不丢草稿（判据不空转）', async () => {
  const { props } = uiProps({
    getProjectContext: async () => ({ cwd: 'D:\\work\\alpha', title: 'Alpha 项目', instruction: '旧目标' }),
    saveProjectGoal: async () => ({ ok: false, error: 'host down' }),
  });
  const mounter = await mountSettingsRow(props);
  const ta = collect(mounter.deep()).find((el) => el.type === 'textarea');
  ta.props.onChange({ target: { value: '新目标' } });
  await mounter.settle();
  buttonByText(mounter.deep(), '保存目标').props.onClick();
  await mounter.settle();
  assert.ok(treeText(mounter.deep()).includes('保存失败：host down'), '失败原因未落行进内反馈（静默失败）');
  const ta2 = collect(mounter.deep()).find((el) => el.type === 'textarea');
  assert.equal(ta2.props.value, '新目标', '保存失败不应丢用户草稿');
});

test('反证：读取上下文失败不崩溃——落到无项目提示（fail-quiet）', async () => {
  const { props } = uiProps({ getProjectContext: async () => { throw new Error('rpc boom'); } });
  const mounter = await mountSettingsRow(props);
  assert.ok(treeText(mounter.deep()).includes('未识别到当前项目'), '读取失败未落到无项目提示');
  assert.equal(collect(mounter.deep()).find((el) => el.type === 'textarea'), undefined);
});

// ===========================================================================
// E. 会话解析链（2026-10-16 rc.2 内核实测校正：currentProvideInfo 是幽灵字段，
//    唯一 sanctioned 来源 = ctx.get('sidebarRight').mounted）
// ===========================================================================

/**
 * 走 apply 的真实 inject 接线取 getProjectContext，用捕获的 HTTP 请求体断言
 * 「用哪个 sessionId 去解析项目」——解析链必须按 mounted → currentProvideInfo → null。
 */
async function resolveChainSession({ sidebarRight, provideInfo }) {
  const requests = [];
  const sandboxFetch = async (url, init) => {
    requests.push({ url: String(url), body: init && init.body ? JSON.parse(String(init.body)) : null });
    return new Response(JSON.stringify({ ok: true, value: { cwd: 'D:\\work\\alpha', instruction: '' } }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  };
  const { mod } = loadDist({ fetch: sandboxFetch, document: makeDocStub() });
  const services = {
    sidebarRight,
    sessions: provideInfo === undefined ? undefined : { currentProvideInfo: { getSnapshot: () => provideInfo } },
  };
  let comp = null;
  let spec = null;
  const slots = {
    inject(name, cb) { cb(); },
    register(s, c) { if (s && s.id === 'prompt-optimizer-settings') { comp = c; spec = s; } },
  };
  const fakeCtx = {
    effect: (fn) => { try { fn(); } catch { /* 忽略 */ } },
    locale: { register() {}, getLocale: () => ({ active: 'zh' }) },
    on() {},
    sessions: services.sessions || {},
    inject: (names, cb) => cb({ slots, sessions: fakeCtx.sessions }),
    get: (name) => services[name],
  };
  mod.apply(fakeCtx);
  assert.ok(spec && typeof spec.inject === 'function', '注册规格缺 inject 工厂');
  const value = await spec.inject().getProjectContext();
  return { requests, value };
}

test('会话解析链：sidebarRight.mounted 优先（rc.2 的 sanctioned 来源）', async () => {
  const { requests, value } = await resolveChainSession({
    sidebarRight: { mounted: { getSnapshot: () => 'sess-mounted' } },
    provideInfo: { sessionId: 'sess-legacy' },
  });
  const call = requests.find((r) => r.url.includes('projectGoal.get'));
  assert.ok(call, 'projectGoal.get 未被发起');
  assert.equal(call.body.sessionId, 'sess-mounted', 'mounted 在场时却用了回落源——解析链顺序错');
  assert.equal(value.cwd, 'D:\\work\\alpha');
});

test('会话解析链回落：mounted 缺席时用 currentProvideInfo（旧宿主兼容）', async () => {
  const absent = await resolveChainSession({
    sidebarRight: undefined,
    provideInfo: { sessionId: 'sess-legacy' },
  });
  assert.equal(
    absent.requests.find((r) => r.url.includes('projectGoal.get')).body.sessionId,
    'sess-legacy',
    'mounted 缺席时未回落到 currentProvideInfo',
  );
  // mounted 在场但快照为 undefined（无屏幕会话）同样回落
  const emptyMounted = await resolveChainSession({
    sidebarRight: { mounted: { getSnapshot: () => undefined } },
    provideInfo: { sessionId: 'sess-legacy' },
  });
  assert.equal(
    emptyMounted.requests.find((r) => r.url.includes('projectGoal.get')).body.sessionId,
    'sess-legacy',
    'mounted 为 undefined（无屏幕会话）时未回落',
  );
});

test('会话解析链：两源都拿不到 → 不发起请求、返回 null（fail-open，不猜测）', async () => {
  const { requests, value } = await resolveChainSession({ sidebarRight: undefined, provideInfo: undefined });
  assert.equal(value, null, '无会话时应返回 null');
  assert.equal(
    requests.some((r) => r.url.includes('projectGoal.get')),
    false,
    '无会话时不应发起 projectGoal.get（必须短路）',
  );
  // 反证：判据不空转——有会话的同构调用必须发起请求
  const positive = await resolveChainSession({
    sidebarRight: { mounted: { getSnapshot: () => 'sess-1' } },
    provideInfo: undefined,
  });
  assert.ok(positive.requests.some((r) => r.url.includes('projectGoal.get')), '阳性对照未发起请求——判据空转');
});

// ===========================================================================
// F. 两半一致性
// ===========================================================================

test('两半常量一致：MAX_GOAL_CHARS（宿主净化上限 == client UI maxLength）', () => {
  const hostText = fs.readFileSync(LIB, 'utf8');
  const srcText = fs.readFileSync(SRC_GOAL, 'utf8');
  const hostMatch = hostText.match(/const MAX_GOAL_CHARS = (\d+);/);
  const srcMatch = srcText.match(/export const MAX_GOAL_CHARS = (\d+);/);
  assert.ok(hostMatch, '宿主 MAX_GOAL_CHARS 不在位');
  assert.ok(srcMatch, 'src MAX_GOAL_CHARS 不在位');
  assert.equal(hostMatch[1], srcMatch[1], '两半常量漂移——UI 允许的长度与宿主净化上限将互斥');
  // 反证：判据不是恒真
  assert.equal(/const MAX_GOAL_CHARS = (\d+);/.test('没有这个常量的文本'), false, '判据空转');
});