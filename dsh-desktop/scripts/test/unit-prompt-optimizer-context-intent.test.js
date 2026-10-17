/**
 * dsh-prompt-optimizer 2.4.0 上下文润色线回归锁
 *
 * 锁四条判据：
 *  A. 宿主半 history（lib/index.js）——活会话 deriveMessages / 冷会话只读句柄回落、
 *     source.kind 闸（合成注入不得当人话）、三重预算截断、体积设闸、全路径 fail-open；
 *  B. 客户端上下文与意图行（dist/client.js 在 vm 里真跑）——recentConversation 真进请求体、
 *     上下文用法规则真进 system、repair 两样都不带；意图行只进卡片、绝不进 result；
 *  C. 一键撤销与门禁（挂载真组件）——替换前留底本、输入框仍是结果才显 ↩、
 *     归一比对（防「静默做成死的」）、字数门、代际守卫丢陈旧回包；
 *  D. 反证——每条新守卫配一个变异体，判据不许空转。
 *
 * 沙箱里 composer 的 instanceof 判定依赖沙箱自己 realm 的 HTMLTextAreaElement / HTMLElement，
 * 所以夹具必须把这些构造器一起塞进 sandbox，否则会 ReferenceError（不是断言失败）。
 */

'use strict';

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

// ---------------------------------------------------------------------------
// 隔离 home：宿主半边在模块加载期就算出 ~/.dsh 路径，环境变量必须先于 import
// ---------------------------------------------------------------------------

const TEST_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'po-ctx-home-'));
process.env.USERPROFILE = TEST_HOME; // Windows：uv_os_homedir 认 USERPROFILE
process.env.HOME = TEST_HOME; // POSIX（CI/ubuntu）
// 宿主半边自 2.4.0 起按内核口径解析 home（DSH_HOME 优先，真机实测到「会话在临时 home、
// 插件配置却写在真实 ~/.dsh」之后）——测试必须把它一起钉进临时目录，否则环境里残留的
// DSH_HOME 会把落点带出沙箱。
process.env.DSH_HOME = path.join(TEST_HOME, '.dsh');
assert.equal(
  os.homedir(),
  TEST_HOME,
  'os.homedir() 未跟随 USERPROFILE/HOME 重定向——拒绝继续（不得触碰真实 home）',
);

let hostLibPromise = null;
function loadHostLib() {
  if (!hostLibPromise) hostLibPromise = import(pathToFileURL(LIB).href);
  return hostLibPromise;
}

// ---------------------------------------------------------------------------
// A. 宿主半 history
// ---------------------------------------------------------------------------

/** 派生历史里的真形状（Message：role + source.kind + content 块） */
function human(text) {
  return { role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text }] };
}
function synthetic(text, kind = 'plugin') {
  return { role: 'user', source: { kind }, content: [{ type: 'text', text }] };
}
function model(text, extraBlocks = []) {
  return {
    role: 'assistant',
    source: { kind: 'model', provider: 'deepseek', model: 'x', replayState: 'final' },
    content: [{ type: 'text', text }, ...extraBlocks],
  };
}

function makeHistoryCtx(overrides = {}) {
  const counters = { open: 0, close: 0, stat: 0 };
  const services = {
    sessions: { get: () => undefined },
    sessionPersistence: undefined,
    webServer: { register() {} },
    ...overrides,
  };
  const captured = { route: null };
  services.webServer = { register(config) { captured.route = config.handler; } };
  if (services.sessionPersistence) {
    const base = services.sessionPersistence;
    services.sessionPersistence = {
      stat: base.stat
        ? async (id) => { counters.stat += 1; return base.stat(id); }
        : undefined,
      open: async (id) => {
        counters.open += 1;
        const handle = await base.open(id);
        return {
          ...handle,
          close: async () => { counters.close += 1; if (handle.close) await handle.close(); },
        };
      },
    };
  }
  const ctx = {
    effect: (fn) => fn(),
    inject: (names, cb) => cb({ effect: (fn) => fn(), webServer: services.webServer }),
    get: (name) => services[name],
  };
  return { ctx, captured, counters };
}

/** 走 apply 捕获的真 HTTP 路由（与客户端 callHost 同一条路）。 */
async function historyCall(overrides = {}) {
  const mod = await loadHostLib();
  const { ctx, captured, counters } = makeHistoryCtx(overrides);
  mod.apply(ctx);
  assert.ok(typeof captured.route === 'function', 'webServer 未注册 HTTP 路由');
  const httpCall = (method, args) => {
    const body = JSON.stringify(args ?? {});
    const req = {
      method: 'POST',
      url: `/dsh-prompt-optimizer/api/${method}`,
      async *[Symbol.asyncIterator]() { yield Buffer.from(body, 'utf8'); },
    };
    return new Promise((resolve, reject) => {
      const res = { writeHead() {}, end(p) { try { resolve(JSON.parse(p)); } catch (e) { reject(e); } } };
      Promise.resolve(captured.route(req, res)).catch(reject);
    });
  };
  return { httpCall, counters, handler: mod.makeHandler(ctx) };
}

test('A1 活会话：只取人类提问与模型正文，块类型与来源双向过滤', async () => {
  const { httpCall } = await historyCall({
    sessions: {
      get: () => ({
        deriveMessages: () => [
          human('帮我把 src/index.ts 里的回调改成 async/await'),
          synthetic('Current runtime context. This snapshot supersedes earlier runtime-context snapshots.'),
          synthetic('The approval policy changed from "ask" to "never".'),
          model('已改完，共 3 处。', [{ type: 'reasoning', text: '内心独白不该进上下文' }, { type: 'tool-call', text: '调用' }]),
          human('再优化一下它'),
        ],
      }),
    },
  });
  const res = await httpCall('history', { sessionId: 'sess-live' });
  assert.equal(res.ok, true);
  assert.equal(res.value.source, 'live');
  assert.deepEqual(
    res.value.turns.map((t) => [t.role, t.text]),
    [['user', '帮我把 src/index.ts 里的回调改成 async/await'],
     ['assistant', '已改完，共 3 处。'],
     ['user', '再优化一下它']],
    '合成注入 / reasoning / tool-call 必须被排除，只留人话与正文',
  );
});

test('A2 冷会话回落：事件形状（data.content / data.message.content）同样过 source 闸', async () => {
  const { httpCall, counters } = await historyCall({
    sessions: { get: () => undefined },
    sessionPersistence: {
      stat: async () => ({ header: { id: 's' }, revision: 'r', sizeBytes: 4096 }),
      open: async () => ({
        header: { id: 's' },
        read: async () => ({
          eventState: 'shared',
          events: [
            { type: 'user/message', seq: 3, data: { content: [{ type: 'text', text: '读一下日志' }], source: { kind: 'user' } } },
            { type: 'user/message', seq: 4, data: { content: [{ type: 'text', text: '注入体' }], source: { kind: 'plugin' } } },
            { type: 'assistant/message', seq: 5, data: { message: { content: [{ type: 'text', text: '读完 12 行' }], source: { kind: 'model' } } } },
            { type: 'tool/result', seq: 6, data: { content: [{ type: 'text', text: '工具输出' }] } },
          ],
        }),
        close: async () => {},
      }),
    },
  });
  const res = await httpCall('history', { sessionId: 'sess-cold' });
  assert.equal(res.value.source, 'persistence');
  assert.deepEqual(res.value.turns.map((t) => t.text), ['读一下日志', '读完 12 行'], '注入体与工具结果不该进上下文');
  assert.equal(counters.open, 1, '冷会话应开一次只读句柄');
  assert.equal(counters.close, 1, '句柄必须关闭（read 模式也要释放）');
});

test('A3 预算截断：条数取尾 6、单条 1200 字截、truncated 如实标记', async () => {
  const many = [];
  for (let i = 0; i < 9; i++) many.push(human('第' + i + '轮'));
  many.push(model('长'.repeat(2000)));
  const { httpCall } = await historyCall({
    sessions: { get: () => ({ deriveMessages: () => many }) },
  });
  const res = await httpCall('history', { sessionId: 's' });
  assert.equal(res.value.turns.length, 6, '只该留尾部 6 轮');
  assert.equal(res.value.turns[0].text, '第4轮', '尾部 6 轮应从第 4 轮开始');
  const last = res.value.turns[5];
  assert.equal(last.text.length, 1201, '单条应截到 1200 字 + 省略号，实得 ' + last.text.length);
  assert.equal(last.text.endsWith('…'), true);
  assert.equal(res.value.truncated, true);
});

test('A4 总量设闸：单条都没超限、总数超 4000 时从最旧一轮继续丢', async () => {
  const turns = ['a', 'b', 'c', 'd', 'e', 'f'].map((k) => human(k.repeat(1)));
  const block = 'x'.repeat(900);
  const many = [human(block), human('' + block), model(block), human(block), model(block), human('最后的草稿')];
  const { httpCall } = await historyCall({ sessions: { get: () => ({ deriveMessages: () => many }) } });
  const res = await httpCall('history', { sessionId: 's' });
  const total = res.value.turns.reduce((sum, t) => sum + t.text.length, 0);
  assert.ok(total <= 4000, '总量必须落进 4000 字预算，实得 ' + total);
  assert.equal(res.value.turns[res.value.turns.length - 1].text, '最后的草稿', '最新一轮必须保住');
  assert.equal(res.value.truncated, true);
  assert.equal(turns.length, 6);
});

test('A5 超大日志不读：stat 报 sizeBytes 超闸即止（防 sessions 扫描 OOM 复发）', async () => {
  const { httpCall, counters } = await historyCall({
    sessions: { get: () => undefined },
    sessionPersistence: {
      stat: async () => ({ header: { id: 's' }, revision: 'r', sizeBytes: 9 * 1024 * 1024 }),
      open: async () => { throw new Error('超闸后不该再开句柄'); },
    },
  });
  const res = await httpCall('history', { sessionId: 's' });
  assert.equal(res.ok, true, '取不到上下文不该报错');
  assert.deepEqual(res.value.turns, []);
  assert.equal(counters.open, 0, '体积超限后不得打开句柄');
});

test('A6 fail-open 三连：deriveMessages 抛 → 回落持久化；两路都抛 → 空且不报错', async () => {
  const thrown = await historyCall({
    sessions: { get: () => ({ deriveMessages: () => { throw new Error('内核内部炸'); } }) },
    sessionPersistence: {
      stat: async () => undefined,
      open: async () => { throw new Error('会话不在索引里'); },
    },
  });
  const res = await thrown.httpCall('history', { sessionId: 's' });
  assert.equal(res.ok, true);
  assert.deepEqual(res.value.turns, []);

  const rescued = await historyCall({
    sessions: { get: () => ({ deriveMessages: () => { throw new Error('内核内部炸'); } }) },
    sessionPersistence: {
      stat: async () => ({ header: {}, revision: 'r', sizeBytes: 10 }),
      open: async () => ({
        read: async () => ({ events: [{ type: 'user/message', data: { content: [{ type: 'text', text: '救回来' }], source: { kind: 'user' } } }] }),
        close: async () => {},
      }),
    },
  });
  const second = await rescued.httpCall('history', { sessionId: 's' });
  assert.deepEqual(second.value.turns.map((t) => t.text), ['救回来'], '活会话读失败必须回落持久化');
  assert.equal(second.value.source, 'persistence');
});

test('A7 无 sessionId / 服务全缺席 → 空轮次，绝不抛（润色照常跑）', async () => {
  const bare = await historyCall();
  const noId = await bare.httpCall('history', {});
  assert.equal(noId.ok, true);
  assert.deepEqual(noId.value.turns, []);
  const noService = await bare.httpCall('history', { sessionId: 'sess-unknown' });
  assert.equal(noService.ok, true);
  assert.deepEqual(noService.value.turns, []);
});

test('A8 活会话命中即不再开句柄（一次请求一次读）', async () => {
  const { httpCall, counters } = await historyCall({
    sessions: { get: () => ({ deriveMessages: () => [human('在的')] }) },
    sessionPersistence: { stat: async () => undefined, open: async () => ({ read: async () => ({ events: [] }), close: async () => {} }) },
  });
  const res = await httpCall('history', { sessionId: 's' });
  assert.equal(res.value.source, 'live');
  assert.equal(counters.open, 0, '活会话有历史却再去开持久化句柄 = 白读一遍磁盘');
});

test('A9 RPC 通道（makeHandler）与 HTTP 同语义', async () => {
  const { handler } = await historyCall({
    sessions: { get: () => ({ deriveMessages: () => [human('同一条路'), synthetic('注入')] }) },
  });
  const res = await handler('history', { sessionId: 's' });
  assert.equal(res.ok, true);
  assert.deepEqual(res.value.turns.map((t) => t.text), ['同一条路']);
});

test('A10 两半形状对齐：宿主回包喂进客户端净化器仍能读出轮次（信封不许变）', async () => {
  const { httpCall } = await historyCall({
    sessions: { get: () => ({ deriveMessages: () => [human('真形状'), model('答完')] }) },
  });
  const envelope = await httpCall('history', { sessionId: 's' });
  const { mod } = loadDist();
  const cleaned = mod.__test.contextOf(envelope.value);
  assert.ok(cleaned, '宿主回包形状与客户端净化器不一致——上下文会被静默丢光');
  // vm 里的 Array 与测试 realm 的不是同一个原型：判原型相等前先落到本 realm
  assert.deepEqual([...cleaned.turns.map((t) => t.role)], ['user', 'assistant']);
  assert.equal(cleaned.source, 'live');
});

test('A11 SSE 换行按宿主形状转义后，客户端读回的是真换行（意图行分隔靠它）', async () => {
  // 宿主写侧为「一帧一行」把 \n 转义成两字符；读侧不对称还原的话，多行结果会带着字面 \n 落进草稿
  const h = makeHarness({ result: '意图：给一份表格\n\n第一行\n第二行' });
  await h.run();
  assert.equal(h.state().intent, '给一份表格');
  assert.equal(h.state().result, '第一行\n第二行', '字面 \\n 没还原——结构化展开的多行结果会整段坏掉');
});

// ---------------------------------------------------------------------------
// B/C 客户端：dist 装载（vm）+ 内存 __test 锚点
// ---------------------------------------------------------------------------

const TEST_ANCHOR =
  '    module.exports.__test = { buildSystemPrompt, buildUserMessage, conversationSection, intentSection, extractResult, splitIntent, triggerBlock, contextOf, fetchConversationContext, runOptimize, getPreviewBusState, dispatchPreview, subscribePreviewBus, closePreview, setUndoRecord, subscribeUndoBus, undoTargetFor, PreviewCard, OptimizeButton };\n';

function loadDist(opts = {}) {
  let src = fs.readFileSync(DIST, 'utf8');
  const anchor = '    return module.exports;';
  assert.ok(src.includes(anchor), 'dist 锚点 `return module.exports;` 丢失——build.mjs 工厂壳形态变了');
  if (opts.mutate) src = opts.mutate(src);
  src = src.replace(anchor, TEST_ANCHOR + anchor);
  const sandbox = {
    window: { __ModuleLoader__: { load(m) { sandbox.__loaded = m; } }, getSelection: () => null },
    console: { log() {}, error() {}, warn() {} },
    fetch: opts.fetch || (() => new Promise(() => {})),
    AbortController,
    setTimeout,
    clearTimeout,
    setImmediate,
    TextDecoder,
    Event: opts.Event,
    HTMLElement: opts.HTMLElement,
    HTMLTextAreaElement: opts.HTMLTextAreaElement,
    MutationObserver: opts.MutationObserver,
    document: opts.document,
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
  assert.ok(mod.__test && typeof mod.__test.runOptimize === 'function', '内存暴露锚点未命中——函数名被 minify 或已改名');
  return { mod, sandbox };
}

/** SSE 单帧回包：换行必须按宿主写侧的形状转义成两字符 \n（lib/index.js 的 optimize.stream
 *  就是为了让「一帧一行」这么干的），客户端读侧对称还原——夹具若不转义就等于绕过真形状。 */
function sseResponse(text) {
  const safe = String(text).replace(/\n/g, '\\n').replace(/\r/g, '\\r');
  const payload = `event: start\ndata: {}\n\nevent: delta\ndata: ${safe}\n\nevent: done\ndata: {}\n\n`;
  const body = new ReadableStream({
    start(controller) { controller.enqueue(new TextEncoder().encode(payload)); controller.close(); },
  });
  return new Response(body, { status: 200, headers: { 'content-type': 'text/event-stream' } });
}

const CONFIG = { baseUrl: 'https://api.deepseek.com', apiKey: '', model: 'x', useSessionModel: true };

/** 端到端夹具：fetch 记录每次请求，rpc 提供 sessionModel/history 之外的通道 */
function makeHarness({
  draft = '再优化一下它',
  result = '意图：把重构结果的说明改得更清楚\n\n把 async/await 重构后的说明改得更清楚。',
  context = { turns: [{ role: 'user', text: '帮我把 src/index.ts 里的回调改成 async/await' }], source: 'live', truncated: false },
  contextThrows = false,
  goal = null,
  results = null,
} = {}) {
  const requests = [];
  let call = 0;
  const fetchStub = async (url, init) => {
    requests.push({ url: String(url), body: init && init.body ? JSON.parse(String(init.body)) : null });
    const list = results || [result];
    const text = list[Math.min(call, list.length - 1)];
    call += 1;
    return sseResponse(text);
  };
  const { mod } = loadDist({ fetch: fetchStub });
  const rpc = {
    call: async (endpoint) => {
      if (endpoint === 'sessionModel') return { ok: true, value: { provider: 'deepseek', model: 'deepseek-v4-flash' } };
      return { ok: true, value: {} };
    },
  };
  const run = (over = {}) =>
    mod.__test.runOptimize({
      getConfig: () => CONFIG,
      getLang: () => 'zh',
      getDraft: () => draft,
      host: { rpc },
      getSessionId: () => 'sess-1',
      getProjectGoal: async () => goal,
      getConversationContext: contextThrows
        ? async () => { throw new Error('history 通道挂了'); }
        : async () => context,
      ...over,
    });
  return { mod, requests, run, state: () => mod.__test.getPreviewBusState() };
}

test('B1 上下文真进请求：recentConversation 在证据里、用法规则在 system 里', async () => {
  const h = makeHarness();
  await h.run();
  const body = h.requests[0].body;
  assert.ok(body.text.includes('recentConversation'), '证据里没有 recentConversation 字段');
  assert.ok(
    body.text.includes('帮我把 src/index.ts 里的回调改成 async/await'),
    '上一轮原文没进请求体——上下文等于没读到',
  );
  assert.ok(body.system.includes('recentConversation'), 'system 里没有上下文用法规则');
  assert.ok(body.system.includes('消解指代与省略'), 'system 缺「指代消解」这条主线判据');
  assert.equal(h.state().contextApplied, true);
});

test('B2 无上下文 = 与 2.3.0 逐字一致：证据不带字段、system 不讲历史', async () => {
  const h = makeHarness({ context: null });
  await h.run();
  const body = h.requests[0].body;
  assert.equal(body.text.includes('recentConversation'), false);
  assert.equal(body.system.includes('上一轮对话的用法'), false, '没有历史还讲怎么用历史 = 纯噪声');
  assert.equal(h.state().contextApplied, false);
});

test('B3 上下文通道故障 fail-open：润色照常发出一次请求', async () => {
  const h = makeHarness({ contextThrows: true });
  await h.run();
  assert.equal(h.requests.length, 1, '上下文失败不该阻断润色');
  assert.equal(h.state().status, 'preview');
  assert.equal(h.state().contextApplied, false);
});

test('B4 repair 阶段两样都不带：上下文段与意图契约都不许出现在修复 system 里', async () => {
  // 草稿含 {{变量}}，第一轮结果故意丢掉它 → 触发校验内核的有界修复（第二请求）
  const h = makeHarness({
    draft: '把 {{user_name}} 填进模板，再优化一下它',
    results: ['意图：补全模板说明\n\n把变量填进模板。', '修复后的完整提示词：把 {{user_name}} 填进模板。'],
  });
  await h.run();
  assert.equal(h.requests.length, 2, '夹具没能触发 repair');
  const repair = h.requests[1].body;
  assert.ok(repair.system.includes('修复'), '第二请求不是 repair 提示词');
  assert.equal(repair.system.includes('意图行'), false, 'repair 里出现了意图契约');
  assert.equal(repair.system.includes('输出格式补充'), false, 'repair 里出现了意图行格式要求');
  assert.equal(repair.system.includes('上一轮对话的用法'), false, 'repair 里出现了上下文规则');
  assert.equal(repair.text.includes('recentConversation'), false, 'repair 证据里混进了上下文');
});

test('B5 意图行只进卡片：result 与写回文本都不含意图行', async () => {
  const h = makeHarness();
  await h.run();
  const state = h.state();
  assert.equal(state.intent, '把重构结果的说明改得更清楚', '意图没被剥出来单独显示');
  assert.equal(state.result, '把 async/await 重构后的说明改得更清楚。');
  assert.equal(state.result.includes('意图'), false, '意图行漏进了 result——会被写进用户输入框');
});

test('B6 模型不按契约输出（无意图行）：整段当正文，intent 为 null', async () => {
  const h = makeHarness({ result: '这是一段没有意图行的普通结果。' });
  await h.run();
  assert.equal(h.state().intent, null);
  assert.equal(h.state().result, '这是一段没有意图行的普通结果。');
});

test('B7 正文中段的「意图：」绝不误剥；只有意图行没有正文时整段保正文', () => {
  const { mod } = loadDist();
  const { splitIntent } = mod.__test;
  const middle = splitIntent('请写一段提示词。\n意图：让用户一眼看懂要做什么。');
  assert.equal(middle.intent, null, '非首行的「意图：」不该被剥');
  assert.equal(middle.body, '请写一段提示词。\n意图：让用户一眼看懂要做什么。');
  const onlyIntent = splitIntent('意图：只有一行没有正文');
  assert.equal(onlyIntent.intent, null, '剥完没正文就不能剥');
  assert.equal(onlyIntent.body, '意图：只有一行没有正文');
  const bold = splitIntent('**意图**：把报告改成表格\n\n把月度报告输出成表格。');
  assert.equal(bold.intent, '把报告改成表格');
  const english = splitIntent('Intent: make it shorter\n\nMake the summary shorter.');
  assert.equal(english.intent, 'make it shorter');
  assert.equal(english.body, 'Make the summary shorter.');
});

test('B8 整体被围栏包裹 + 意图行：先解包再拆，结果里不留围栏也不留意图', async () => {
  const h = makeHarness({ result: '```text\n意图：给出迁移步骤\n\n列出迁移到 ESM 的步骤。\n```' });
  await h.run();
  assert.equal(h.state().intent, '给出迁移步骤');
  assert.equal(h.state().result, '列出迁移到 ESM 的步骤。');
});

test('B9 system 组装顺序：正文 → 目标 → 上下文 → 意图契约；四段都不丢', () => {
  const { mod } = loadDist();
  const out = mod.__test.buildSystemPrompt('zh', 'polish', '本项目输出保持中文', true);
  const at = (s) => out.indexOf(s);
  assert.ok(at('你是一名提示词润色专家') >= 0);
  assert.ok(at('本项目优化目标') > at('你是一名提示词润色专家'));
  assert.ok(at('上一轮对话的用法') > at('本项目优化目标'));
  assert.ok(at('输出格式补充') > at('上一轮对话的用法'), '意图契约必须排在最后（格式是本轮最后一条硬要求）');
  assert.equal(mod.__test.buildSystemPrompt('en', 'polish', '', false).includes('Output format'), true);
});

test('B10 字数门判据：空/超短/超长/busy 四类各有原因，正常草稿放行', () => {
  const { mod } = loadDist();
  const { triggerBlock } = mod.__test;
  assert.equal(triggerBlock('', false), 'short');
  assert.equal(triggerBlock('改', false), 'short');
  assert.equal(triggerBlock(' 它 ', false), 'short');
  assert.equal(triggerBlock('帮我改这个函数', false), null);
  assert.equal(triggerBlock('x'.repeat(8001), false), 'long');
  assert.equal(triggerBlock('帮我改这个函数', true), 'busy');
});

// ---------------------------------------------------------------------------
// C. 挂载真组件：卡片替换留底本 → 按钮 ↩ → 撤销复原
// ---------------------------------------------------------------------------

function createMounter(Component, props) {
  const internals = React.__SECRET_INTERNALS_DO_NOT_USE_OR_YOU_WILL_BE_FIRED;
  assert.ok(internals && internals.ReactCurrentDispatcher, 'React 内部 dispatcher 槽位缺失');
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
      return [cell.value, (next) => {
        const v = typeof next === 'function' ? next(cell.value) : next;
        if (Object.is(v, cell.value)) return;
        cell.value = v;
        scheduled = true;
      }];
    },
    useRef(init) {
      const i = cursor++;
      if (!(i in cells)) cells[i] = { value: { current: init } };
      return cells[i].value;
    },
    useMemo(fn) { const i = cursor++; if (!(i in cells)) cells[i] = { value: fn() }; return cells[i].value; },
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
  return { settle, deep: () => tree, render };
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
const treeText = (tree) => textAll(tree);
const buttonByText = (tree, text) =>
  collect(tree).find((el) => el.type === 'button' && textAll(el).includes(text)) || null;

/** composer 夹具：textarea 走的是「非 Lexical」分支，这里只验撤销接线，写回通道另有套件锁。
 *  真机形状（2026-10-17 隔离内核 + Lexical 实测）：**改文本不派发任何 DOM 事件**，
 *  编辑器自己重排 DOM——所以夹具用 MutationObserver 记账、写 value 即冲刷，
 *  绝不用 input 事件驱动刷新（那是夹具替一条宿主根本不存在的契约作证）。 */
function makeComposer(initial = '') {
  class Event {
    constructor(type, init) { this.type = type; this.bubbles = !!(init && init.bubbles); }
  }
  const observers = [];
  class MutationObserverStub {
    constructor(cb) { this.cb = cb; }
    observe(target) { observers.push(this); this.target = target; }
    disconnect() {
      const i = observers.indexOf(this);
      if (i >= 0) observers.splice(i, 1);
    }
  }
  const flushMutations = () => { for (const o of observers.slice()) o.cb([]); };
  class HTMLElementStub {
    constructor() { this.dataset = {}; this.innerText = ''; }
    get isContentEditable() { return false; }
    addEventListener() {}
    removeEventListener() {}
    dispatchEvent() { return true; }
    focus() {}
    closest() { return null; }
    getAttribute() { return null; }
    querySelectorAll() { return []; }
  }
  class HTMLTextAreaElementStub extends HTMLElementStub {
    constructor() { super(); this._value = ''; this.disabled = false; }
    get value() { return this._value; }
    set value(next) { this._value = next; flushMutations(); }
  }
  const ta = new HTMLTextAreaElementStub();
  ta.value = initial;
  const listeners = {};
  const document = {
    activeElement: null,
    querySelector: (sel) => (sel === '[data-composer-input]' ? ta : null),
    querySelectorAll: () => [],
    createElement: () => ({ dataset: {}, textContent: '' }),
    addEventListener: (type, fn) => { (listeners[type] ||= []).push(fn); },
    removeEventListener: () => {},
    head: { appendChild() {} },
  };
  return {
    ta,
    document,
    Event,
    HTMLElement: HTMLElementStub,
    HTMLTextAreaElement: HTMLTextAreaElementStub,
    MutationObserver: MutationObserverStub,
    /** 真机里宿主改一次文本 = 一次 DOM 变更，没有任何事件可听；夹具照此形状冲刷 */
    mutate: (text) => { ta.value = text; },
    observerCount: () => observers.length,
    /** 少数旧宿主（textarea + React 受控）确实会派发 input，这条通道作为补充保留 */
    fire: (type) => { for (const fn of listeners[type] || []) fn({ type }); },
    listenerCount: (type) => (listeners[type] || []).length,
  };
}

const UI_DICT = {
  'button.aria': '优化 prompt',
  'button.undo': '撤销这次替换，回到原草稿',
  'button.busy': '正在优化…',
  'button.short': '草稿太短',
  'button.long': '草稿太长',
  'card.title': '优化结果',
  'card.replace': '替换草稿',
  'card.copy': '复制',
  'card.retry': '重新优化',
  'card.structure': '展开为结构化',
  'card.dismiss': '放弃',
  'card.iterate.submit': '细化',
  'card.optimizing': '正在优化…',
  'card.goalTag': '已应用项目目标',
  'card.goalTagHint': '目标提示',
  'card.contextTag': '已读上一轮对话',
  'card.contextTagHint': '上下文提示',
  'card.intentLabel': '理解到的意图',
  'card.intentHint': '意图提示',
  'card.note.missing': '{n} 处未保留',
  'card.step.repair': '正在修复…',
  'card.iterate.placeholder': '追加要求…',
  'card.iterate.aria': '细化要求',
  'guide.title': '请先配置 API',
  'guide.desc': '去设置',
  'guide.action': '去设置',
  'guide.dismiss': '知道了',
};

const cardProps = (over = {}) => ({
  t: (key) => UI_DICT[key] ?? key,
  getConfig: () => CONFIG,
  getLang: () => 'zh',
  openSettings: () => {},
  getSessionModel: async () => null,
  getHost: () => ({ rpc: { call: async () => ({ ok: true, value: {} }) } }),
  getSessionId: () => 'sess-1',
  getProjectGoal: async () => null,
  getConversationContext: async () => null,
  ...over,
});

const buttonProps = () => ({
  t: (key) => UI_DICT[key] ?? key,
  getConfig: () => CONFIG,
  getLang: () => 'zh',
  getSessionModel: async () => null,
  getHost: () => ({ rpc: { call: async () => ({ ok: true, value: {} }) } }),
  getSessionId: () => 'sess-1',
  getProjectGoal: async () => null,
  getConversationContext: async () => null,
});

/** 同一份模块实例（撤销记录是模块级单例）里挂卡片与按钮 */
function uiFixture(draft = '再优化一下它', loadOpts = {}) {
  const composer = makeComposer(draft);
  const { mod } = loadDist({
    document: composer.document,
    Event: composer.Event,
    HTMLElement: composer.HTMLElement,
    HTMLTextAreaElement: composer.HTMLTextAreaElement,
    MutationObserver: composer.MutationObserver,
    ...loadOpts,
  });
  const mountCard = () => createMounter(mod.__test.PreviewCard, cardProps());
  const mountButton = () => createMounter(mod.__test.OptimizeButton, buttonProps());
  return { mod, composer, mountCard, mountButton };
}

/** 把卡片推到 preview 态（结果 + 意图） */
function primePreview(mod, result, intent, extra = []) {
  mod.__test.dispatchPreview({ type: 'begin', sessionId: 'sess-1' });
  for (const action of extra) mod.__test.dispatchPreview(action);
  mod.__test.dispatchPreview({ type: 'show', result, intent });
}

test('C1 卡片替换前留底本：写回的是结果、记的是原草稿', async () => {
  const f = uiFixture('再优化一下它');
  const RESULT = '把 async/await 重构后的说明改得更清楚。';
  primePreview(f.mod, RESULT, '把说明改清楚');
  const card = f.mountCard();
  await card.settle();
  assert.ok(treeText(card.deep()).includes('理解到的意图'), '意图行没进卡片');
  assert.equal(
    treeText(card.deep()).includes('已读上一轮对话'),
    false,
    '没叠加上下文却亮标签 = 假反馈',
  );
  const replace = buttonByText(card.deep(), '替换草稿');
  assert.ok(replace, '「替换草稿」按钮不在树里');
  replace.props.onClick();
  assert.equal(f.composer.ta.value, RESULT, '写回的不是结果');
  // 判据走公共面：底本在位 = 「输入框仍是结果」时能撤、且撤回去是原草稿
  assert.equal(f.mod.__test.undoTargetFor(RESULT, 'sess-1'), '再优化一下它', '替换后没留撤销底本——润色砸了就无法复原');
});

test('C2 一键撤销：按钮翻成 ↩，点击复原原草稿并清记录', async () => {
  const f = uiFixture('再优化一下它');
  const RESULT = '把 async/await 重构后的说明改得更清楚。';
  primePreview(f.mod, RESULT, null);
  const card = f.mountCard();
  await card.settle();
  buttonByText(card.deep(), '替换草稿').props.onClick();

  const button = f.mountButton();
  await button.settle();
  const el = collect(button.deep()).find((n) => n.type === 'button');
  assert.ok(el, '按钮未渲染');
  assert.equal(textAll(el), '↩', '撤销态没翻成 ↩');
  assert.equal(el.props['data-undo'], true);
  assert.equal(el.props.disabled, false, '可撤销时不该被禁用');
  assert.ok(el.props.title.includes('撤销'), '撤销态的 title 要说明能干什么');
  el.props.onClick();
  assert.equal(f.composer.ta.value, '再优化一下它', '撤销没回到原草稿');
  // 把输入框摆回结果那份文本再判一次：证明是记录被清了，而不是碰巧对不上
  f.composer.ta.value = RESULT;
  assert.equal(f.mod.__test.undoTargetFor(RESULT, 'sess-1'), null, '撤销后记录必须清空（不许反复覆盖用户输入）');
});

test('C3 用户手改过输入框 → 不再提供撤销', async () => {
  const f = uiFixture('再优化一下它');
  const RESULT = '把说明改清楚。';
  primePreview(f.mod, RESULT, null);
  const card = f.mountCard();
  await card.settle();
  buttonByText(card.deep(), '替换草稿').props.onClick();
  f.composer.ta.value = RESULT + '（我自己又补了一句）';

  const button = f.mountButton();
  await button.settle();
  const el = collect(button.deep()).find((n) => n.type === 'button');
  assert.equal(textAll(el), '✨', '内容已变还给 ↩ = 一点就把用户的编辑吞掉');
  assert.equal(el.props['data-undo'], false);
});

test('C4 归一比对：读回来的 nbsp / 末尾换行不该让撤销永远不出现', async () => {
  const f = uiFixture('原话');
  const RESULT = '第一 行\n第二行';
  primePreview(f.mod, RESULT, null);
  const card = f.mountCard();
  await card.settle();
  buttonByText(card.deep(), '替换草稿').props.onClick();
  // 模拟 composer 的读回差异：nbsp 替空格 + 末尾多一个换行
  f.composer.ta.value = RESULT.replace(' ', '\u00a0') + '\n';
  assert.equal(
    f.mod.__test.undoTargetFor(f.composer.ta.value, 'sess-1'),
    '原话',
    '归一判据失效——撤销会被做成静默死的',
  );

  const button = f.mountButton();
  await button.settle();
  const el = collect(button.deep()).find((n) => n.type === 'button');
  assert.equal(textAll(el), '↩');
});

test('C5 换了会话就不给撤销（底本属于发起会话）', () => {
  const { mod } = loadDist();
  mod.__test.setUndoRecord({ sessionId: 'sess-A', original: '原话', replaced: '结果' });
  assert.equal(mod.__test.undoTargetFor('结果', 'sess-B'), null, '跨会话撤销会覆盖另一个会话的输入');
  assert.equal(mod.__test.undoTargetFor('结果', 'sess-A'), '原话');
});

test('C6 字数门落到按钮上：短草稿不发起，title 说明原因，但绝不 disabled', async () => {
  const f = uiFixture('改');
  const button = f.mountButton();
  await button.settle();
  const el = collect(button.deep()).find((n) => n.type === 'button');
  assert.equal(el.props['data-block'], 'short', '门判据要能观测到');
  assert.ok(el.props.title.includes('太短'), '禁用必须给出原因，不能只是点了没反应');
  // 真机立场：门只解释、不加锁——composer 的文本变化不派发事件，任何「按陈旧快照禁用」
  // 都可能把主操作永久锁死（观察器一旦漏一拍，用户就再也点不动 ✨）
  assert.equal(el.props.disabled, false, '不许因字数门 disabled');
  const before = f.composer.ta.value;
  el.props.onClick();
  assert.equal(f.composer.ta.value, before, '不足 3 字点击必须静默不发起');
});

test('C6b 真机形状：粘贴改写不派发任何事件，按钮仍要靠自己翻新成 ↩', async () => {
  const f = uiFixture('再优化一下它');
  const RESULT = '把说明改清楚，保留 `npm test`。';
  primePreview(f.mod, RESULT, null);
  const card = f.mountCard();
  await card.settle();
  buttonByText(card.deep(), '替换草稿').props.onClick();

  const button = f.mountButton();
  await button.settle();
  assert.equal(f.composer.observerCount(), 1, '按钮没挂观察器——Lexical 改写后按钮永远停在陈旧态');
  // 用户手改一句：真机里这一步没有任何事件可听，只有 DOM 变更
  f.composer.mutate(RESULT + '（我自己又补了一句）');
  await button.settle();
  const el = collect(button.deep()).find((n) => n.type === 'button');
  assert.equal(textAll(el), '✨', '内容已变还给 ↩ = 一点就把用户的编辑吞掉');
  assert.equal(el.props['data-undo'], false);
});

test('C7 代际守卫：被取代的请求，迟到的结果不许复活卡片', async () => {
  const deferred = [];
  const fetchStub = async (url, init) => {
    const entry = {};
    entry.promise = new Promise((r) => { entry.resolve = r; });
    deferred.push(entry);
    return entry.promise;
  };
  const { mod } = loadDist({ fetch: fetchStub });
  const run = (sessionId) =>
    mod.__test.runOptimize({
      getConfig: () => CONFIG,
      getLang: () => 'zh',
      getDraft: () => '再优化一下它',
      host: { rpc: { call: async () => ({ ok: true, value: { provider: 'deepseek', model: 'x' } }) } },
      getSessionId: () => sessionId,
      getProjectGoal: async () => null,
      getConversationContext: async () => null,
    });
  // 断言中途失败也要把在途请求收尾，否则 runOptimize 的 60s 计时器会把整个进程挂住
  try {
    const staleRun = run('sess-A');
    await new Promise((r) => setImmediate(r));
    assert.equal(mod.__test.getPreviewBusState().sessionId, 'sess-A');
    const freshRun = run('sess-B');
    await new Promise((r) => setImmediate(r));
    assert.equal(deferred.length, 2, '两次发起各自应有一次在途请求');

    deferred[0].resolve(sseResponse('意图：陈旧\n\n陈旧结果'));
    await staleRun;
    const after = mod.__test.getPreviewBusState();
    assert.equal(after.sessionId, 'sess-B', '陈旧回包改写了会话绑定');
    assert.equal(after.status, 'optimizing', '陈旧回包动了卡片状态——代际门失效');
    assert.equal(after.errorKind, null, '陈旧回包把新一轮的卡片写成了错误态');
    assert.equal(after.result.includes('陈旧结果'), false, '陈旧回包复活了卡片内容——代际门失效');

    deferred[1].resolve(sseResponse('意图：本轮\n\n本轮结果'));
    await freshRun;
    assert.equal(mod.__test.getPreviewBusState().result, '本轮结果');
  } finally {
    for (const entry of deferred) entry.resolve(sseResponse('收尾'));
  }
});

test('C8 卡片把上下文、目标、意图三件事都说给人看', async () => {
  const f = uiFixture('原话');
  primePreview(f.mod, '结果正文', '要一份表格', [
    { type: 'context', applied: true },
    { type: 'goal', applied: true },
  ]);
  const card = f.mountCard();
  await card.settle();
  const text = treeText(card.deep());
  assert.ok(text.includes('已读上一轮对话'), '上下文标签缺失');
  assert.ok(text.includes('已应用项目目标'), '目标标签缺失');
  assert.ok(text.includes('理解到的意图') && text.includes('要一份表格'), '意图行缺失');
  assert.ok(text.includes('结果正文'));
});

// ---------------------------------------------------------------------------
// D. 反证：每条新守卫都要能被变异体打破
// ---------------------------------------------------------------------------

test('D1 反证：意图行「剥完必须有正文」这条判据不空转', () => {
  const original = loadDist();
  const before = original.mod.__test.splitIntent('意图：只有一行没有正文');
  assert.equal(before.intent, null, '前置：原文不该剥');
  assert.equal(before.body, '意图：只有一行没有正文');

  const mutated = loadDist({
    mutate: (src) => {
      const re = /if \(!intent \|\| !body\) return \{ intent: null, body: whole \};/;
      assert.match(src, re, '意图行守卫锚点丢失——实现形态变了，同步本套件');
      return src.replace(re, 'if (!intent) return { intent: null, body: whole };');
    },
  });
  const after = mutated.mod.__test.splitIntent('意图：只有一行没有正文');
  assert.notEqual(after.intent, null, '变异体也没剥——原守卫那条「必须有正文」根本没在起作用');
  assert.equal(after.body, '', '变异体应把正文剥空（这正是不能让意图行漏进输入框的坏法）');
});

test('D2 反证：代际守卫删掉后，陈旧回包必须复活卡片（否则 C7 是空断言）', async () => {
  const deferred = [];
  const fetchStub = async () => {
    const entry = {};
    entry.promise = new Promise((r) => { entry.resolve = r; });
    deferred.push(entry);
    return entry.promise;
  };
  const { mod } = loadDist({
    fetch: fetchStub,
    mutate: (src) => {
      const re = /const stale = \(\) => generation !== runGeneration;/;
      assert.match(src, re, '代际守卫锚点丢失——实现形态变了，同步本套件');
      return src.replace(re, 'const stale = () => false;');
    },
  });
  const run = (sessionId) =>
    mod.__test.runOptimize({
      getConfig: () => CONFIG,
      getLang: () => 'zh',
      getDraft: () => '再优化一下它',
      host: { rpc: { call: async () => ({ ok: true, value: { provider: 'deepseek', model: 'x' } }) } },
      getSessionId: () => sessionId,
      getProjectGoal: async () => null,
      getConversationContext: async () => null,
    });
  try {
    const staleRun = run('sess-A');
    await new Promise((r) => setImmediate(r));
    const freshRun = run('sess-B');
    await new Promise((r) => setImmediate(r));
    deferred[0].resolve(sseResponse('意图：陈旧\n\n陈旧结果'));
    await staleRun;
    const after = mod.__test.getPreviewBusState();
    assert.ok(
      after.status === 'error' || after.result.includes('陈旧结果'),
      '变异体里陈旧回包对卡片毫无影响——C7 的判据其实是空转',
    );
    deferred[1].resolve(sseResponse('意图：本轮\n\n本轮结果'));
    await freshRun;
  } finally {
    for (const entry of deferred) entry.resolve(sseResponse('收尾'));
  }
});

test('D3 反证：宿主 source.kind 闸拿掉后，合成注入必须混进上下文', async () => {
  const src = fs.readFileSync(LIB, 'utf8');
  const re = /if \(message\.role === 'user' && kind === 'user'\) turns\.push/;
  assert.match(src, re, '宿主 source 闸锚点丢失——实现形态变了，同步本套件');
  const file = path.join(TEST_HOME, 'mutated-host.mjs');
  fs.writeFileSync(file, src.replace(re, "if (message.role === 'user') turns.push"), 'utf8');
  const mod = await import(pathToFileURL(file).href);
  let route = null;
  const ctx = {
    effect: (fn) => fn(),
    inject: (names, cb) => cb({ effect: (fn) => fn(), webServer: { register(c) { route = c.handler; } } }),
    get: (name) =>
      name === 'sessions'
        ? {
            get: () => ({
              deriveMessages: () => [
                { role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text: '人话' }] },
                { role: 'user', source: { kind: 'plugin' }, content: [{ type: 'text', text: '审批策略变了' }] },
              ],
            }),
          }
        : undefined,
  };
  mod.apply(ctx);
  const res = await new Promise((resolve) => {
    const req = {
      method: 'POST',
      url: '/dsh-prompt-optimizer/api/history',
      async *[Symbol.asyncIterator]() { yield Buffer.from(JSON.stringify({ sessionId: 's' }), 'utf8'); },
    };
    route(req, { writeHead() {}, end(p) { resolve(JSON.parse(p)); } });
  });
  assert.deepEqual(
    res.value.turns.map((t) => t.text),
    ['人话', '审批策略变了'],
    '变异体没让注入体混进来——A1/A2 的 source 闸判据是空转',
  );
  fs.rmSync(file, { force: true });
});

test('D4 反证：撤销比对退回逐字相等时，nbsp 场景必须失效', () => {
  const { mod } = loadDist({
    mutate: (src) => {
      const re = /if \(normalizeText\(composerText\) !== normalizeText\(record\.replaced\)\) return null;/;
      assert.match(src, re, '归一比对锚点丢失——实现形态变了，同步本套件');
      return src.replace(re, 'if (composerText !== record.replaced) return null;');
    },
  });
  mod.__test.setUndoRecord({ sessionId: 's', original: '原话', replaced: '第一行 第二行' });
  assert.equal(
    mod.__test.undoTargetFor('第一行\u00a0第二行', 's'),
    null,
    '变异体仍能撤——C4 的归一判据是空转',
  );
});

test('D5 反证：上下文附加门写反后，「没有历史也讲历史」必须复现', () => {
  const { mod } = loadDist({
    mutate: (src) => {
      const re = /if \(hasConversation === true\)/;
      assert.match(src, re, '上下文附加门锚点丢失——实现形态变了，同步本套件');
      return src.replace(re, 'if (hasConversation === false)');
    },
  });
  assert.ok(
    mod.__test.buildSystemPrompt('zh', 'polish', '', false).includes('上一轮对话的用法'),
    '变异体没在「无历史」时讲历史——B2 的门是空转',
  );
});

test('D6 反证：摘掉 composer 观察落点后，「用户手改输入框」必须收不回撤销（否则 C6b 是空断言）', async () => {
  const anchor = 'function findComposerHost() {\n  if (typeof document === "undefined") return null;';
  const f = uiFixture('原话', {
    mutate: (src) => {
      assert.ok(src.includes(anchor), 'composer 观察落点锚点丢失——实现形态变了，同步本套件');
      return src.replace(anchor, 'function findComposerHost() {\n  return null;');
    },
  });
  const RESULT = '把说明改清楚。';
  f.composer.mutate(RESULT);
  f.mod.__test.setUndoRecord({ sessionId: 'sess-1', original: '原话', replaced: RESULT });
  const button = f.mountButton();
  await button.settle();
  assert.equal(f.composer.observerCount(), 0, '变异体里观察器仍挂上了——落点锚点没被摘掉');
  // 用户手改：真机形状 = 只有 DOM 变更、没有任何事件
  f.composer.mutate(RESULT + '（我自己又补了一句）');
  await button.settle();
  const el = collect(button.deep()).find((n) => n.type === 'button');
  assert.equal(
    textAll(el),
    '↩',
    '变异体居然翻新了按钮——说明判据其实来自别处，C6b 在替一条不存在的接线作证',
  );
});

test('D7 反证：宿主半边的 home 必须跟 DSH_HOME 走（真机实测到它曾读过真实 ~/.dsh 的配置）', async () => {
  const WIN_HOME = path.join(TEST_HOME, 'dsh-home-win');
  const plain = path.join(TEST_HOME, '.dsh', 'prompt-optimizer-projects.json');
  const pinned = path.join(WIN_HOME, 'prompt-optimizer-projects.json');
  const saved = process.env.DSH_HOME;
  process.env.DSH_HOME = WIN_HOME;
  try {
    const file = path.join(TEST_HOME, 'host-dshhome.mjs');
    fs.writeFileSync(file, fs.readFileSync(LIB, 'utf8'), 'utf8');
    const mod = await import(pathToFileURL(file).href);
    let route = null;
    const ctx = {
      effect: (fn) => fn(),
      inject: (names, cb) => cb({ effect: (fn) => fn(), webServer: { register(c) { route = c.handler; } } }),
      get: (name) =>
        name === 'sessions'
          ? { get: () => ({ header: { cwd: 'D:\work\pinned' } }) }
          : undefined,
    };
    mod.apply(ctx);
    const res = await new Promise((resolve) => {
      const req = {
        method: 'POST',
        url: '/dsh-prompt-optimizer/api/projectGoal.set',
        async *[Symbol.asyncIterator]() {
          yield Buffer.from(JSON.stringify({ sessionId: 's-win', instruction: '钉在 DSH_HOME' }), 'utf8');
        },
      };
      route(req, { writeHead() {}, end(p) { resolve(JSON.parse(p)); } });
    });
    assert.equal(res.ok, true, JSON.stringify(res));
    assert.ok(fs.existsSync(pinned), `DSH_HOME 没被认领——目标落在了 ${plain}`);
    assert.equal(fs.readFileSync(pinned, 'utf8').includes('钉在 DSH_HOME'), true, '落点内容不符');
    assert.equal(fs.existsSync(plain), false, 'homedir 侧也写了一份——两处分裂就是真机事故的原样');
  } finally {
    process.env.DSH_HOME = saved;
  }
});
