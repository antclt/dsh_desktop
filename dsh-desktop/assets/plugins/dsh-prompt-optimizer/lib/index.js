// dsh-prompt-optimizer —— 节点侧（server half）。
// 配置持久化采用与 dsh-sticky-note（先例、已在运行）相同的模式：server half 直接读写
// `~/.dsh/prompt-optimizer-config.json`，并通过 loopback RPC 通道 `/dsh-prompt-optimizer`
// 向 client 提供 get/set。
// 为什么不用 settingsScope/settings 注册：client 侧 settingsScope（loopback host 面）需要
// namespace 事先注册进桌面应用 host 的 settings 注册表（官方插件由 host 内置注册，第三方走
// 市场安装流程注册）；手工装配进 profile 的插件没有该注册，describe 返回 unavailable，
// settingsScope.set 静默失效（实测 status:"unavailable", mode:"host"）。
// 客户端功能全部在 dist/client.js（exports["./client"]）。

// 「会话默认模型」流式通道（零配置）采用 dsh-elf 已验证的宿主服务面：
//   agentDefaultModel.currentSelection() → 当前会话/agent 默认模型（免配置取模型）
//   llm.stream({ provider, model, messages, system }) → 服务端真流式（text-delta/finish）
// 不碰 session.create/fork/prompt：渲染进程无法让后台会话执行生成（fork 子会话不在前台
// 不触发模型），自编 sessionId 会被静默拒绝（实测「永远正在优化」的根因）。

import { readFile, writeFile, mkdir, appendFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { homedir } from 'node:os';

// HTTP JSON API（dsh-elf 方式）：渲染进程用相对路径 fetch 直达宿主 webServer，
// 完全绕开 connection.rpc.call —— desktop 的 rpc.call 在同一流程第二次调用会挂死
// （实测 sessionModel 成功、optimize.start 永不达 server）。配置读写保留 RPC（单次调用无碍）。
const HTTP_PREFIX = '/dsh-prompt-optimizer/api';
const MAX_BODY_BYTES = 1 << 20;

const CHANNEL = '/dsh-prompt-optimizer';
/**
 * dsh home：内核侧一律按 DSH_HOME 解析（`dsh-home-paths`），桌面壳重定向时也是它。
 * 本插件历史上直接 `homedir()/.dsh`，于是「会话在 A 处、插件配置在 B 处」——
 * 2026-10-17 隔离内核实机实测到的是同一件事的另一面：DSH_HOME 指向临时目录的内核，
 * 读的却是本机真实 `~/.dsh/prompt-optimizer-config.json`（设置与调试日志同理）。
 * 没有 DSH_HOME 时仍是 `~/.dsh`，真实用户侧行为一字不变。
 */
const DSH_HOME = (process.env.DSH_HOME || '').trim() || join(homedir(), '.dsh');
const CONFIG_PATH = join(DSH_HOME, 'prompt-optimizer-config.json');
// 项目优化目标（2.3.0）：按项目目录路径键控、本机集中存储——项目目录零写入。
// 用户在「设置 → Prompt 优化 → 项目优化目标」里为某个项目写下的指令，持久在这份文件里；
// 键 = 会话头 cwd（内核 workspace 成员判定要求头 cwd 即工作区规范路径）。
const PROJECTS_PATH = join(DSH_HOME, 'prompt-optimizer-projects.json');
const MAX_GOAL_CHARS = 4000;
// 上一轮对话（2.4.0 上下文润色）的读取预算，宿主侧一次性收口，客户端不再二次裁剪。
// 判据来自真机样本：一条 46 轮的会话日志有 8179 条事件，而「它 / 这个 / 再优化一下」这类
// 指代只用得上最近几轮；整条倒进润色请求既撞 MAX_BODY_BYTES 也没必要。
const HISTORY_MAX_TURNS = 6;
const HISTORY_MAX_TURN_CHARS = 1200;
const HISTORY_MAX_TOTAL_CHARS = 4000;
// 冷会话回落只能整读日志再截尾部——jsonl 后端的 stat 实测只回 header/revision/sizeBytes
// （没有 eventCount，无法定位尾部偏移）。所以先按物理体积设闸：超闸就不读，宁可不带上下文，
// 也不把内核 node 拖进 OOM（sessions/** 全量扫描炸过一次，见 AGENTS.md 已知坑）。
const HISTORY_MAX_LOG_BYTES = 4 << 20;
// 调试日志（诊断宿主流式通道）：每次调用追加一行，定位「正在优化…无产出」
const DEBUG_LOG = join(DSH_HOME, 'prompt-optimizer-debug.log');
async function dbg(...args) {
  try {
    await appendFile(DEBUG_LOG, `[${new Date().toISOString()}] ${args.map(String).join(' ')}
`);
  } catch {
    // 日志失败不影响主流程
  }
}

// 在途流式任务（Web Client 半经 RPC 轮询取增量；abort 标记让后台流尽快停下）
const tasks = new Map();
let taskSeq = 0;

async function readConfig() {
  try {
    return JSON.parse(await readFile(CONFIG_PATH, 'utf8'));
  } catch {
    return {};
  }
}

async function writeConfig(config) {
  await mkdir(dirname(CONFIG_PATH), { recursive: true });
  await writeFile(CONFIG_PATH, JSON.stringify(config, null, 2), 'utf8');
}

async function readProjects() {
  try {
    const parsed = JSON.parse(await readFile(PROJECTS_PATH, 'utf8'));
    if (parsed && typeof parsed === 'object' && parsed.projects && typeof parsed.projects === 'object') {
      return { version: 1, projects: parsed.projects };
    }
  } catch {
    // 首次使用 / 文件损坏：当空表处理（损坏内容不覆盖用户别的数据——整文件本插件独占）
  }
  return { version: 1, projects: {} };
}

async function writeProjects(data) {
  await mkdir(dirname(PROJECTS_PATH), { recursive: true });
  await writeFile(PROJECTS_PATH, JSON.stringify(data, null, 2), 'utf8');
}

/**
 * 解析会话对应的项目目录（cwd）：活会话头 cwd → sessionPersistence 索引 → null。
 * 取自 better-sidebar 已验证的解析链（其注释记录了「首请求先于会话附着」的实测：
 * 活会话查不到时必须回落持久化索引，否则会拿宿主进程 cwd 冒充项目目录）。
 */
async function resolveProjectCwd(ctx, sessionId) {
  if (typeof sessionId !== 'string' || !sessionId) return null;
  const sessions = ctx.get('sessions');
  const live = sessions && typeof sessions.get === 'function' ? sessions.get(sessionId) : undefined;
  const liveCwd = live && live.header ? live.header.cwd : undefined;
  if (typeof liveCwd === 'string' && liveCwd.trim()) return liveCwd.trim();
  const persistence = ctx.get('sessionPersistence');
  if (persistence && typeof persistence.open === 'function') {
    let handle;
    try {
      handle = await persistence.open(sessionId, 'read');
      const cwd = handle && handle.header ? handle.header.cwd : undefined;
      if (typeof cwd === 'string' && cwd.trim()) return cwd.trim();
    } catch {
      // 会话不在持久化索引（纯内存/已清理）：视为无项目上下文
    } finally {
      if (handle && typeof handle.close === 'function') {
        try { await handle.close(); } catch { /* 尽力释放 */ }
      }
    }
  }
  return null;
}

/** 项目展示名：workspaceRegistry 的标题优先（缺失/失败时不返回该字段，客户端回落到路径末段）。 */
async function projectTitleOf(ctx, cwd) {
  const registry = ctx.get('workspaceRegistry');
  if (!registry || typeof registry.resolveByPath !== 'function') return undefined;
  try {
    const ws = await registry.resolveByPath(cwd);
    return ws && typeof ws.title === 'string' && ws.title ? ws.title : undefined;
  } catch {
    return undefined;
  }
}

/** projectGoal.get/set 的公共实现（HTTP 与 RPC 两个通道共用一份语义）。 */
async function handleProjectGoal(ctx, endpoint, payload) {
  const cwd = await resolveProjectCwd(ctx, payload.sessionId);
  if (!cwd) return err('no-project', 'session has no resolvable project directory');
  const data = await readProjects();
  if (endpoint === 'projectGoal.get') {
    const entry = data.projects[cwd];
    const title = await projectTitleOf(ctx, cwd);
    const value = {
      cwd,
      instruction: entry && typeof entry.instruction === 'string' ? entry.instruction : '',
    };
    if (entry && typeof entry.updatedAt === 'string') value.updatedAt = entry.updatedAt;
    if (title !== undefined) value.title = title;
    return ok(value);
  }
  // set：空指令 = 清除该项目条目（删键，不写空壳）
  if (typeof payload.instruction !== 'string') return err('bad-instruction', 'instruction must be a string');
  const instruction = payload.instruction.trim();
  if (instruction.length > MAX_GOAL_CHARS) {
    return err('goal-too-long', `instruction exceeds ${MAX_GOAL_CHARS} characters`);
  }
  if (!instruction) {
    if (cwd in data.projects) {
      delete data.projects[cwd];
      await writeProjects(data);
    }
    await dbg('projectGoal.set', cwd, 'cleared');
    return ok({ cwd, instruction: '' });
  }
  const updatedAt = new Date().toISOString();
  data.projects[cwd] = { instruction, updatedAt };
  await writeProjects(data);
  await dbg('projectGoal.set', cwd, 'len=' + instruction.length);
  return ok({ cwd, instruction, updatedAt });
}

function ok(value) {
  return { ok: true, value };
}

function err(code, details) {
  return { ok: false, error: { code, details } };
}

/** 内容块 → 纯正文：只取 text 块。reasoning 是思维链、tool-call/image 是结构化调用，
 *  对「用户上一条到底在说什么」没有信息量，照抄进润色请求反而带噪。 */
function textOfContent(content) {
  if (typeof content === 'string') return content.trim();
  if (!Array.isArray(content)) return '';
  return content
    .filter((block) => block && block.type === 'text' && typeof block.text === 'string')
    .map((block) => block.text)
    .join('\n')
    .trim();
}

/** 派生历史（`Session.deriveMessages()` 的 Message[]）→ 润色可用轮次。
 *  user 侧按 `source.kind === 'user'` 设闸：内核允许任何生产者以 user 角色注入合成消息
 *  （文件变更通知、子目录 AGENTS.md、goal 续跑轮……真机日志里实测到 kind:'plugin' 的
 *  user/message）。那些是「模型看到的」而不是「用户说的」，当成上一条人类意图会把润色带偏。 */
function turnsFromMessages(messages) {
  const turns = [];
  for (const message of Array.isArray(messages) ? messages : []) {
    if (!message || typeof message !== 'object') continue;
    const kind = message.source && message.source.kind;
    const text = textOfContent(message.content);
    if (!text) continue;
    if (message.role === 'user' && kind === 'user') turns.push({ role: 'user', text });
    else if (message.role === 'assistant' && kind === 'model') turns.push({ role: 'assistant', text });
  }
  return turns;
}

/** 持久化事件（冷会话回落）→ 轮次。事件形状与派生消息不同：user/message 的正文在
 *  `data.content`、来源在 `data.source.kind`；assistant/message 的正文在 `data.message.content`、
 *  来源在 `data.message.source.kind`。同一道 source 闸照搬——同仓库的 dsh-side-session
 *  那份 extractText 既没有 source 闸、又把 reasoning 块一起 join，它的场景是展示、
 *  我们的场景是喂模型，不能照抄。 */
function turnsFromEvents(events) {
  const turns = [];
  for (const event of Array.isArray(events) ? events : []) {
    if (!event || typeof event !== 'object' || !event.data || typeof event.data !== 'object') continue;
    const data = event.data;
    if (event.type === 'user/message') {
      if (!data.source || data.source.kind !== 'user') continue;
      const text = textOfContent(data.content);
      if (text) turns.push({ role: 'user', text });
    } else if (event.type === 'assistant/message') {
      const message = typeof data.message === 'object' && data.message ? data.message : null;
      if (!message || !message.source || message.source.kind !== 'model') continue;
      const text = textOfContent(message.content);
      if (text) turns.push({ role: 'assistant', text });
    }
  }
  return turns;
}

/** 收口到预算：单条截断 → 只留尾部 HISTORY_MAX_TURNS 轮 → 总量落不进预算就从最旧一轮继续丢。
 *  任一环节丢过就置 truncated，客户端据此在卡片上说明「上下文已截断」。 */
function boundTurns(turns, source) {
  let shrunk = false;
  const clipped = turns.map((turn) => {
    if (turn.text.length <= HISTORY_MAX_TURN_CHARS) return turn;
    shrunk = true;
    return { role: turn.role, text: `${turn.text.slice(0, HISTORY_MAX_TURN_CHARS)}…` };
  });
  let kept = clipped.slice(-HISTORY_MAX_TURNS);
  if (kept.length < clipped.length) shrunk = true;
  let total = kept.reduce((sum, turn) => sum + turn.text.length, 0);
  while (kept.length > 1 && total > HISTORY_MAX_TOTAL_CHARS) {
    total -= kept[0].text.length;
    kept = kept.slice(1);
    shrunk = true;
  }
  return { turns: kept, source, truncated: shrunk };
}

/** history 的公共实现（HTTP 与 RPC 两通道共用一份语义）：活会话 → 冷会话持久化 → 无上下文。
 *  三条路径一律不抛，取不到就是空轮次——润色绝不因读不到上下文而停摆
 *  （与 projectGoal 的 fail-open 同一口径）。 */
async function handleHistory(ctx, payload) {
  const sessionId = payload && typeof payload.sessionId === 'string' ? payload.sessionId.trim() : '';
  if (!sessionId) return ok(boundTurns([], 'none'));
  // 1) 活会话：deriveMessages 是内核自己那份「模型看到的历史」——compaction 的 replace
  //    已经生效，比逐条翻事件日志更贴近用户上下文；且它不在 @deprecated 名单上
  //    （snapshotEvents/ownEvents/eventAt 都在，别用那三个）。
  try {
    const sessions = ctx.get('sessions');
    const live = sessions && typeof sessions.get === 'function' ? sessions.get(sessionId) : undefined;
    if (live && typeof live.deriveMessages === 'function') {
      return ok(boundTurns(turnsFromMessages(live.deriveMessages()), 'live'));
    }
  } catch (error) {
    await dbg('history live threw', sessionId, String((error && error.message) || error));
  }
  // 2) 冷会话回落：「首请求先于会话附着」是实测过的（resolveProjectCwd 的注释记着同一件事）。
  //    read 句柄不抢所有权，与正在写的句柄并存，所以前台会话正忙时也能读。
  try {
    const persistence = ctx.get('sessionPersistence');
    if (persistence && typeof persistence.open === 'function') {
      if (typeof persistence.stat === 'function') {
        const snapshot = await persistence.stat(sessionId);
        if (snapshot && typeof snapshot.sizeBytes === 'number' && snapshot.sizeBytes > HISTORY_MAX_LOG_BYTES) {
          await dbg('history skipped: log too large', sessionId, 'bytes=' + snapshot.sizeBytes);
          return ok(boundTurns([], 'none'));
        }
      }
      let handle;
      try {
        handle = await persistence.open(sessionId, 'read');
        const result = handle && typeof handle.read === 'function' ? await handle.read() : undefined;
        return ok(boundTurns(turnsFromEvents(result && result.events), 'persistence'));
      } finally {
        if (handle && typeof handle.close === 'function') {
          try { await handle.close(); } catch { /* 尽力释放 */ }
        }
      }
    }
  } catch (error) {
    await dbg('history persistence threw', sessionId, String((error && error.message) || error));
  }
  return ok(boundTurns([], 'none'));
}

/** RPC handler：{ok,value}/{ok:false,error}。endpoint: get | set | history | sessionModel | optimize.start | optimize.poll | optimize.abort */
export function makeHandler(ctx) {
  return async (endpoint, payload = {}) => {
    try {
      switch (endpoint) {
        case 'get': {
          return ok(await readConfig());
        }
        case 'set': {
          const current = await readConfig();
          const next = { ...current, ...(payload.patch ?? {}) };
          await writeConfig(next);
          return ok(next);
        }
        case 'history': {
          return handleHistory(ctx, payload);
        }
        case 'projectGoal.get':
        case 'projectGoal.set': {
          return handleProjectGoal(ctx, endpoint, payload);
        }
        case 'sessionModel': {
          // 当前会话/agent 默认模型（零配置取模型；宿主无该服务或无可选模型时明确报错）
          await dbg('sessionModel called');
          const agentDefaultModel = ctx.get('agentDefaultModel');
          if (!agentDefaultModel) { await dbg('sessionModel -> no-agent-model'); return err('no-agent-model', 'agentDefaultModel service unavailable'); }
          const sel = agentDefaultModel.currentSelection();
          if (!sel || !sel.model) { await dbg('sessionModel -> no-model'); return err('no-model', 'no current model selected'); }
          const value = { provider: sel.provider, model: sel.model };
          if (sel.reasoningEffort !== undefined) value.reasoningEffort = sel.reasoningEffort;
          await dbg('sessionModel ok', JSON.stringify(value));
          return ok(value);
        }
        case 'optimize.start': {
          const llm = ctx.get('llm');
          if (!llm) { await dbg('start -> no-llm'); return err('no-llm', 'llm service unavailable'); }
          const text = payload.text;
          const provider = payload.provider;
          const model = payload.model;
          if (typeof text !== 'string' || !text.trim()) return err('no-text', 'empty text');
          if (typeof provider !== 'string' || !provider || typeof model !== 'string' || !model) {
            return err('no-model', 'provider/model required');
          }
          const taskId = `po-${Date.now()}-${taskSeq++}`;
          const entry = { text: '', done: false, error: null, abort: false };
          tasks.set(taskId, entry);
          const options = {
            provider,
            model,
            messages: [{ role: 'user', content: [{ type: 'text', text }] }],
            system: typeof payload.system === 'string' && payload.system ? payload.system : undefined,
          };
          if (typeof payload.reasoningEffort === 'string' && payload.reasoningEffort) {
            options.reasoningEffort = payload.reasoningEffort;
          }
          await dbg('start', taskId, 'provider=' + provider, 'model=' + model, 'textLen=' + text.length);
          (async () => {
            try {
              let deltaCount = 0;
              let reasoningCount = 0;
              for await (const chunk of llm.stream(options)) {
                if (entry.abort) { await dbg('stream', taskId, 'aborted by client'); break; }
                if (chunk.type === 'text-delta') {
                  entry.text += chunk.text;
                  deltaCount += 1;
                } else if (chunk.type === 'reasoning-delta' || (chunk.type === 'delta' && chunk.blockType === 'reasoning')) {
                  reasoningCount += 1;
                } else if (chunk.type === 'finish') {
                  await dbg('stream', taskId, 'finish', JSON.stringify(chunk.reason || {}));
                  if (chunk.reason && (chunk.reason.kind === 'error' || chunk.reason.kind === 'aborted')) {
                    entry.error = (chunk.reason.failure && chunk.reason.failure.message) || chunk.reason.kind;
                  }
                  entry.done = true;
                }
              }
              await dbg('stream', taskId, 'ended deltaCount=' + deltaCount, 'reasoningCount=' + reasoningCount, 'textLen=' + entry.text.length);
              if (!entry.done) entry.done = true;
            } catch (error) {
              await dbg('stream', taskId, 'THREW:', String((error && error.message) || error));
              entry.error = String((error && error.message) || error);
              entry.done = true;
            }
          })();
          return ok({ taskId });
        }
        case 'optimize.poll': {
          const entry = typeof payload.taskId === 'string' ? tasks.get(payload.taskId) : undefined;
          if (!entry) { await dbg('poll unknown task', String(payload.taskId)); return err('no-task', 'unknown task'); }
          if (entry.pollCount === undefined) entry.pollCount = 0;
          entry.pollCount += 1;
          if (entry.pollCount % 10 === 1) {
            await dbg('poll', String(payload.taskId), '#' + entry.pollCount, 'done=' + entry.done, 'textLen=' + entry.text.length, 'err=' + (entry.error || '-'));
          }
          return ok({ done: entry.done, text: entry.text, error: entry.error });
        }
        case 'optimize.run': {
          // 单次 RPC 全流程（desktop 渲染进程的 rpc.call 在同流程第二次调用会挂死——
          // 实测 sessionModel 成功、optimize.start 永不达 server）。模型由 agentDefaultModel
          // 提供或 payload 显式传；服务端跑完整个 llm.stream 后一次性返回全文。
          const llm = ctx.get('llm');
          if (!llm) return err('no-llm', 'llm service unavailable');
          const text = payload.text;
          if (typeof text !== 'string' || !text.trim()) return err('no-text', 'empty text');
          let provider = payload.provider;
          let model = payload.model;
          if (typeof provider !== 'string' || !provider || typeof model !== 'string' || !model) {
            const agentDefaultModel = ctx.get('agentDefaultModel');
            const sel = agentDefaultModel && agentDefaultModel.currentSelection
              ? agentDefaultModel.currentSelection()
              : undefined;
            if (sel && sel.model) {
              provider = provider || sel.provider;
              model = model || sel.model;
            }
          }
          if (typeof provider !== 'string' || !provider || typeof model !== 'string' || !model) {
            return err('no-model', 'provider/model required');
          }
          const options = {
            provider,
            model,
            messages: [{ role: 'user', content: [{ type: 'text', text }] }],
            system: typeof payload.system === 'string' && payload.system ? payload.system : undefined,
          };
          if (typeof payload.reasoningEffort === 'string' && payload.reasoningEffort) {
            options.reasoningEffort = payload.reasoningEffort;
          }
          await dbg('optimize.run provider=' + provider, 'model=' + model, 'textLen=' + text.length);
          let out = '';
          let error = null;
          try {
            for await (const chunk of llm.stream(options)) {
              if (chunk.type === 'text-delta') {
                out += chunk.text;
              } else if (chunk.type === 'finish') {
                if (chunk.reason && (chunk.reason.kind === 'error' || chunk.reason.kind === 'aborted')) {
                  error = (chunk.reason.failure && chunk.reason.failure.message) || chunk.reason.kind;
                }
              }
            }
          } catch (streamError) {
            error = String((streamError && streamError.message) || streamError);
          }
          await dbg('optimize.run done textLen=' + out.length, 'error=' + (error || '-'));
          if (error) return err('stream-error', error);
          return ok({ text: out });
        }
        case 'optimize.abort': {
          const entry = typeof payload.taskId === 'string' ? tasks.get(payload.taskId) : undefined;
          if (entry) { entry.abort = true; await dbg('abort', String(payload.taskId), 'textLen=' + entry.text.length); }
          return ok(true);
        }
        default:
          return err('unknown', endpoint);
      }
    } catch (error) {
      return err('error', error instanceof Error ? error.message : String(error));
    }
  };
}

async function readJsonBody(req) {
  const chunks = [];
  let total = 0;
  for await (const chunk of req) {
    const buffer = Buffer.from(chunk);
    total += buffer.length;
    if (total > MAX_BODY_BYTES) throw new Error('body too large');
    chunks.push(buffer);
  }
  const text = Buffer.concat(chunks).toString('utf8');
  if (!text.trim()) return {};
  try {
    return JSON.parse(text);
  } catch {
    throw new Error('bad json');
  }
}

function writeJson(res, status, value) {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(value));
}

/** HTTP JSON API 路由（dsh-elf 形态）：POST /dsh-prompt-optimizer/api/<method> */
function createApiRoute(getCtx) {
  return async (req, res) => {
    let args = {};
    try {
      args = await readJsonBody(req);
    } catch (error) {
      writeJson(res, 400, { ok: false, error: String((error && error.message) || error) });
      return;
    }
    if (req.method !== 'POST') {
      writeJson(res, 405, { ok: false, error: 'post only' });
      return;
    }
    const pathname = new URL(req.url || '/', 'http://dsh.internal').pathname;
    const method = pathname.startsWith(HTTP_PREFIX + '/')
      ? decodeURIComponent(pathname.slice(HTTP_PREFIX.length + 1))
      : '';
    if (!method || method.includes('/')) {
      writeJson(res, 404, { ok: false, error: 'unknown' });
      return;
    }
    const ctx = getCtx();
    const llm = ctx.get('llm');
    const agentDefaultModel = ctx.get('agentDefaultModel');
    try {
      switch (method) {
        case 'optimize.stream': {
          // 真流式：SSE 直出。请求保持打开，llm.stream 的每个 text-delta 即时 write，
          // finish 后 [DONE]。客户端 fetch + reader 逐 chunk 呈现（逐 token 滚动）。
          if (!llm) {
            writeJson(res, 200, { ok: false, error: { code: 'no-llm', details: 'llm unavailable' } });
            return;
          }
          const text = args.text;
          const provider = args.provider;
          const model = args.model;
          if (typeof text !== 'string' || !text.trim()) {
            writeJson(res, 200, { ok: false, error: { code: 'no-text', details: 'empty text' } });
            return;
          }
          if (typeof provider !== 'string' || !provider || typeof model !== 'string' || !model) {
            writeJson(res, 200, { ok: false, error: { code: 'no-model', details: 'provider/model required' } });
            return;
          }
          const options = {
            provider,
            model,
            messages: [{ role: 'user', content: [{ type: 'text', text }] }],
            system: typeof args.system === 'string' && args.system ? args.system : undefined,
          };
          if (typeof args.reasoningEffort === 'string' && args.reasoningEffort) {
            options.reasoningEffort = args.reasoningEffort;
          }
          res.writeHead(200, {
            'content-type': 'text/event-stream; charset=utf-8',
            'cache-control': 'no-cache',
            connection: 'keep-alive',
          });
          res.write('event: start\ndata: {}\n\n');
          let textLen = 0;
          let deltaCount = 0;
          try {
            for await (const chunk of llm.stream(options)) {
              if (chunk.type === 'text-delta') {
                textLen += chunk.text.length;
                deltaCount += 1;
                const safe = String(chunk.text).replace(/\n/g, '\\n').replace(/\r/g, '\\r');
                res.write(`event: delta\ndata: ${safe}\n\n`);
              } else if (chunk.type === 'reasoning-delta' || (chunk.type === 'delta' && chunk.blockType === 'reasoning')) {
                // 推理过程先出：原样推送，等待期间卡片可见内容滚动
                const safe = String(chunk.text || '').replace(/\n/g, '\\n').replace(/\r/g, '\\r');
                res.write(`event: reasoning\ndata: ${safe}\n\n`);
              } else if (chunk.type === 'finish') {
                if (chunk.reason && (chunk.reason.kind === 'error' || chunk.reason.kind === 'aborted')) {
                  const msg = (chunk.reason.failure && chunk.reason.failure.message) || chunk.reason.kind;
                  res.write(`event: error\ndata: ${String(msg).replace(/\n/g, ' ').replace(/\r/g, ' ')}\n\n`);
                }
                break;
              }
            }
            await dbg('sse', provider, model, 'ended deltaCount=' + deltaCount, 'textLen=' + textLen);
            res.write('event: done\ndata: {}\n\n');
          } catch (error) {
            await dbg('sse', provider, model, 'THREW:', String((error && error.message) || error));
            res.write(`event: error\ndata: ${String((error && error.message) || error).replace(/\n/g, ' ').replace(/\r/g, ' ')}\n\n`);
            res.write('event: done\ndata: {}\n\n');
          } finally {
            res.end();
          }
          return;
        }
        case 'sessionModel': {
          if (!agentDefaultModel) {
            writeJson(res, 200, { ok: false, error: { code: 'no-agent-model', details: 'agentDefaultModel unavailable' } });
            return;
          }
          const sel = agentDefaultModel.currentSelection();
          if (!sel || !sel.model) {
            writeJson(res, 200, { ok: false, error: { code: 'no-model', details: 'no model selected' } });
            return;
          }
          const value = { provider: sel.provider, model: sel.model };
          if (sel.reasoningEffort !== undefined) value.reasoningEffort = sel.reasoningEffort;
          writeJson(res, 200, { ok: true, value });
          return;
        }
        case 'optimize.start': {
          if (!llm) {
            writeJson(res, 200, { ok: false, error: { code: 'no-llm', details: 'llm unavailable' } });
            return;
          }
          const text = args.text;
          const provider = args.provider;
          const model = args.model;
          if (typeof text !== 'string' || !text.trim()) {
            writeJson(res, 200, { ok: false, error: { code: 'no-text', details: 'empty text' } });
            return;
          }
          if (typeof provider !== 'string' || !provider || typeof model !== 'string' || !model) {
            writeJson(res, 200, { ok: false, error: { code: 'no-model', details: 'provider/model required' } });
            return;
          }
          const taskId = `po-${Date.now()}-${taskSeq++}`;
          const entry = { text: '', done: false, error: null, abort: false };
          tasks.set(taskId, entry);
          const options = {
            provider,
            model,
            messages: [{ role: 'user', content: [{ type: 'text', text }] }],
            system: typeof args.system === 'string' && args.system ? args.system : undefined,
          };
          if (typeof args.reasoningEffort === 'string' && args.reasoningEffort) {
            options.reasoningEffort = args.reasoningEffort;
          }
          await dbg('http start', taskId, provider, model, 'textLen=' + text.length);
          (async () => {
            try {
              for await (const chunk of llm.stream(options)) {
                if (entry.abort) break;
                if (chunk.type === 'text-delta') {
                  entry.text += chunk.text;
                } else if (chunk.type === 'finish') {
                  if (chunk.reason && (chunk.reason.kind === 'error' || chunk.reason.kind === 'aborted')) {
                    entry.error = (chunk.reason.failure && chunk.reason.failure.message) || chunk.reason.kind;
                  }
                  entry.done = true;
                }
              }
              await dbg('http stream', taskId, 'ended textLen=' + entry.text.length, 'err=' + (entry.error || '-'));
              if (!entry.done) entry.done = true;
            } catch (streamError) {
              await dbg('http stream', taskId, 'THREW:', String((streamError && streamError.message) || streamError));
              entry.error = String((streamError && streamError.message) || streamError);
              entry.done = true;
            }
          })();
          writeJson(res, 200, { ok: true, value: { taskId } });
          return;
        }
        case 'optimize.poll': {
          const entry = typeof args.taskId === 'string' ? tasks.get(args.taskId) : undefined;
          if (!entry) {
            writeJson(res, 200, { ok: false, error: { code: 'no-task', details: 'unknown task' } });
            return;
          }
          if (entry.pollCount === undefined) entry.pollCount = 0;
          entry.pollCount += 1;
          if (entry.pollCount % 10 === 1) {
            await dbg('http poll', String(args.taskId), '#' + entry.pollCount, 'done=' + entry.done, 'textLen=' + entry.text.length);
          }
          writeJson(res, 200, { ok: true, value: { done: entry.done, text: entry.text, error: entry.error } });
          return;
        }
        case 'optimize.abort': {
          const entry = typeof args.taskId === 'string' ? tasks.get(args.taskId) : undefined;
          if (entry) entry.abort = true;
          writeJson(res, 200, { ok: true, value: true });
          return;
        }
        case 'get': {
          const current = await readConfig();
          writeJson(res, 200, { ok: true, value: current });
          return;
        }
        case 'set': {
          const current = await readConfig();
          const next = { ...current, ...(args.patch ?? {}) };
          await writeConfig(next);
          writeJson(res, 200, { ok: true, value: next });
          return;
        }
        case 'history': {
          writeJson(res, 200, await handleHistory(ctx, args));
          return;
        }
        case 'projectGoal.get':
        case 'projectGoal.set': {
          writeJson(res, 200, await handleProjectGoal(ctx, method, args));
          return;
        }
        default:
          writeJson(res, 404, { ok: false, error: { code: 'unknown', details: method } });
      }
    } catch (error) {
      writeJson(res, 500, { ok: false, error: String((error && error.message) || error) });
    }
  };
}

export const name = 'dsh-prompt-optimizer';

export function apply(ctx) {
  // 不再注入 connection：桌面宿主运行时没有该服务，inject 会让 fiber 永久 PENDING、
  // profile-selection 阶段挂死（实测启动卡死）。所有通道统一走 webServer HTTP API。
  ctx.inject(['webServer'], (webCtx) => {
    webCtx.effect(
      () => webCtx.webServer.register({
        kind: 'prefix',
        path: HTTP_PREFIX,
        handler: createApiRoute(() => ctx),
      }),
      'dsh-prompt-optimizer: http api',
    );
  });
}