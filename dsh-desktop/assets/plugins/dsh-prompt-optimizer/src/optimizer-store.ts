/** 优化编排 runOptimize + 模块级在途控制 —— 状态经模块级事件总线（preview-bus）发布，
 *  不依赖会话 store/hook props（桌面渲染层对 input.right/overlay 槽位不提供这些标准 props，
 *  组件依赖它们会崩并被错误边界吞掉——PO-RIGHT-OK 探针可见而 ✨/预览卡不可见的实测定论）。
 *
 *  2.2.0 起：主任务完成后过一遍「校验内核」（validators）——原文里的围栏代码块/{{变量}}/URL/
 *  文件路径必须在结果里逐字保留；有缺失就带着具体清单做一次「有界修复」（同一通道、独立计时
 *  窗口），修复后仍缺则在卡片上记数。修复失败（非中止）降级为主结果 + 计数，不丢主结果。
 *
 *  2.4.0 起：主任务之前并行取「项目目标」+「上一轮对话」，两者都 fail-open；
 *  全文按「意图行 → 正文」拆开，正文才进 result / 校验 / 写回，意图只在卡片显示。
 *  每次发起带一个代际号，被更新的请求取代后本 run 的派发整体闭嘴（陈旧回包不得复活卡片）。 */

import {
  buildSystemPrompt,
  buildUserMessage,
  checkConfig,
  optimizeStream,
  extractResult,
  triggerBlock,
  REQUEST_TIMEOUT_MS,
  toErrorKind,
  type Lang,
  type OptimizeErrorKind,
  type OptimizePayload,
  type OptimizeTask,
  type PromptConfig,
} from './optimizer.js';
import { streamHostOptimize, type HostRpc } from './session-optimizer.js';
import { dispatchPreview } from './preview-bus.js';
import { validatePreservation, type Entity } from './validators.js';
import type { ConversationContext } from './conversation-context.js';
import { splitIntent } from './intent-line.js';

/**
 * 当前 in-flight 请求的控制器（模块级）：
 * - 关闭卡片时中止它，防止迟到的 show()/fail() 复活已关闭卡片；
 * - runOptimize 以「存在在途控制器」为并发把关（同一时刻只允许一个请求在途）。
 * 注：模块级意味着多会话同时优化会互相让路——输入栏单会话聚焦的交互下可接受此简化。
 */
let activeController: AbortController | null = null;
/** 在途请求的发起会话（并发把关按会话：同会话防抖；异会话让路） */
let activeSessionId: string | null = null;
/** 发起序号（2.4.0 陈旧结果门，照 Qoder PromptEnhanceButton 的 generation 口径）：
 *  上一次请求的迟到回包不得复活已被取代的卡片——中止信号只覆盖可取消的流，
 *  目标/上下文这两次 HTTP 往返与修复阶段的收尾都不在其中，必须按序号判新旧。 */
let runGeneration = 0;

/** 修复信封上限：最多 8 条、每条 200 字符（修复请求保持小体积；长文本截断不影响定位） */
const REPAIR_MAX_ITEMS = 8;
const REPAIR_MAX_TEXT = 200;

/** 关闭预览卡（并中止在途请求） */
export function closePreview(): void {
  if (activeController !== null) {
    activeController.abort();
    activeController = null;
  }
  activeSessionId = null;
  dispatchPreview({ type: 'close' });
}

/** 优化编排的入参（按钮 / 预览卡共用）。三种任务的输入约定：
 *  - polish（默认）：输入 = getDraft()（输入框当前草稿）；
 *  - iterate：输入 = iterate.base（上一轮结果），指令 = iterate.instruction；
 *  - structure：输入 = structure.base（当前结果）。 */
export interface RunOptimizeOptions {
  getConfig: () => PromptConfig;
  getLang: () => Lang;
  getDraft: () => string;
  /** 宿主模型（UI 标签）；宿主通道内部自行解析 */
  getSessionModel?: () => Promise<{ provider: string; model: string } | null>;
  /** 宿主通道（useSessionModel 开启时用）：自有 RPC → server half 的 llm.stream，零配置 */
  host?: {
    rpc: HostRpc;
  };
  /** 发起优化的会话 id（绑定预览窗口，切会话不跟随） */
  getSessionId?: () => string | null;
  /** 项目优化目标（2.3.0）：取当前会话所属项目在设置里设定的目标指令；
   *  非空则附加进主任务系统提示词（repair 阶段自动排除）。失败 = 无目标。 */
  getProjectGoal?: () => Promise<string | null>;
  /** 上一轮对话（2.4.0）：宿主半 history 端点取回的会话最近几轮原话；
   *  非空则进 JSON 证据（recentConversation）并在系统提示词里附加用法规则。
   *  repair 阶段一律不带。失败 / 无历史 = 空，行为回到 2.3.0。 */
  getConversationContext?: () => Promise<ConversationContext | null>;
  /** 迭代细化：在 base（上一轮结果）上融入 instruction（新增要求） */
  iterate?: { base: string; instruction: string };
  /** 结构化展开：把 base（当前结果）展开为结构化提示词 */
  structure?: { base: string };
}

function isAbortError(e: unknown): boolean {
  return (
    (typeof DOMException !== 'undefined' && e instanceof DOMException && e.name === 'AbortError') ||
    (typeof (e as { name?: unknown } | null)?.name === 'string' && (e as { name: string }).name === 'AbortError')
  );
}

interface StageOptions {
  config: PromptConfig;
  host?: { rpc: HostRpc };
  lang: Lang;
  task: OptimizeTask;
  payload: OptimizePayload;
  signal: AbortSignal;
  getSessionModel?: () => Promise<{ provider: string; model: string } | null>;
  /** 流式正文展示（宿主 = 累积正文；fetch = 正文未出现时回落到推理文本，与旧行为一致） */
  display: (text: string) => void;
  /** 宿主通道步骤回调（修复阶段不传：不让 'model'/'start'/'poll' 覆盖卡片上的「修复中」） */
  step?: (step: 'model' | 'start' | 'poll') => void;
  /** 项目优化目标（2.3.0）：附加进系统提示词；repair 由 buildSystemPrompt 自行排除 */
  projectGoal?: string;
  /** 上一轮对话（2.4.0）：本轮证据里带了 recentConversation，系统提示词同步附用法规则 */
  hasConversation?: boolean;
}

/** 单个阶段的执行（主任务与修复共用一个通道选择）：宿主通道（零配置）或 fetch 直连二选一。
 *  只负责「跑一次调用拿全文」，show/fail/note 一律由编排层决定。 */
async function runStage(opts: StageOptions): Promise<string> {
  const system = buildSystemPrompt(opts.lang, opts.task, opts.projectGoal, opts.hasConversation);
  const userMessage = buildUserMessage(opts.lang, opts.task, opts.payload);
  if (opts.host) {
    return streamHostOptimize({
      rpc: opts.host.rpc,
      text: userMessage,
      system,
      signal: opts.signal,
      rpcTimeoutMs: 5000,
      onDelta: opts.display,
      onReasoning: opts.display,
      onStep: (step) => opts.step?.(step),
    });
  }
  // fetch 直连：模型解析（useSessionModel → 宿主会话模型名回退；否则自定义 model）
  let model = opts.config.model;
  if (opts.config.useSessionModel) {
    const sessionModel = await opts.getSessionModel?.();
    if (sessionModel && sessionModel.model) model = sessionModel.model;
  }
  let reasoning = '';
  let content = '';
  return optimizeStream({
    config: { ...opts.config, model },
    system,
    userMessage,
    signal: opts.signal,
    onEvent: (delta) => {
      if (delta.kind === 'content') content += delta.text;
      else reasoning += delta.text;
      opts.display(content || reasoning);
    },
  });
}

/** 修复信封条目：条目数与单条长度截断到上限，供 JSON 证据使用 */
function repairEnvelope(missing: Entity[]): Array<{ kind: string; text: string }> {
  return missing
    .slice(0, REPAIR_MAX_ITEMS)
    .map((e) => ({ kind: e.kind, text: e.text.slice(0, REPAIR_MAX_TEXT) }));
}

/** 优化编排：宿主通道（零配置）/ fetch 直连 → 校验内核 →（有缺失）一次有界修复 → 卡片 note */
export async function runOptimize(ctx: RunOptimizeOptions): Promise<void> {
  const config = ctx.getConfig();
  // 任务分派：structure / iterate 以 base（上一轮结果）为输入；polish（默认）取输入框草稿
  const task: OptimizeTask = ctx.structure ? 'structure' : ctx.iterate ? 'iterate' : 'polish';
  const source = (ctx.structure?.base ?? ctx.iterate?.base ?? ctx.getDraft()).trim();
  // 字数门与按钮同一判据（triggerBlock）：竞态下按钮禁用还没生效也走不到这里
  if (triggerBlock(source, false) !== null) {
    return;
  }
  const iterateInstruction = ctx.iterate?.instruction.trim() ?? '';
  if (task === 'iterate' && !iterateInstruction) {
    return; // 空细化要求无意义（UI 已禁用提交，这里是竞态最后防线）
  }
  const lang = ctx.getLang();

  // 通道判定：useSessionModel 且宿主在位 → 宿主通道（零配置）；否则 fetch 直连需先过配置检查。
  // guide 必须在 begin 之前派发：reducer 的 guide 只在非 optimizing 态生效（防迟到覆盖）。
  const host = config.useSessionModel ? ctx.host : undefined;
  if (!host && !checkConfig(config).ok) {
    dispatchPreview({ type: 'guide' });
    return;
  }

  // 并发把关：同会话在途 → 丢弃本次触发（按钮 busy 已禁用点击，这里是竞态最后防线）；
  // 切换会话后发起 → 中止旧请求让路（各会话可独立优化，宿主临时会话由 cancel 收尾）
  const sessionId = ctx.getSessionId?.() ?? null;
  if (activeController !== null) {
    if (sessionId === activeSessionId) {
      return;
    }
    activeController.abort();
    activeController = null;
    activeSessionId = null;
    // 让路之后必须先把卡片归零：reducer 的 begin 在 optimizing 态是直接 return，
    // 不归零就会把新一轮的结果挂到旧会话的绑定上（实测：切会话后再点 ✨，
    // 预览窗仍认旧会话，新结果按 sid 判定不显示）。
    dispatchPreview({ type: 'close' });
  }
  dispatchPreview({ type: 'begin', sessionId });
  // 本次请求的代际：此后每一次派发都要过 stale()，被更新的请求取代就整体闭嘴
  const generation = ++runGeneration;
  const stale = () => generation !== runGeneration;
  const emit = (action: Parameters<typeof dispatchPreview>[0]): void => {
    if (!stale()) dispatchPreview(action);
  };

  const controller = new AbortController();
  activeController = controller; // 注册给 closePreview()，供卡片关闭时取消在途请求
  activeSessionId = sessionId;
  let timedOut = false;
  let timer: ReturnType<typeof setTimeout> = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, REQUEST_TIMEOUT_MS);
  /** 每个阶段各有一个有界窗口（修复阶段重新计时；总时长 ≤ 2 × REQUEST_TIMEOUT_MS） */
  const rearmTimer = () => {
    clearTimeout(timer);
    timedOut = false;
    timer = setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, REQUEST_TIMEOUT_MS);
  };

  // 项目目标（2.3.0）与上一轮对话（2.4.0）并行取回：两者都 fail-open，串行等于把两次
  // 往返的等待叠成一次用户能感觉到的卡顿。取回后主任务阶段共用一份。
  const [goalText, context] = await Promise.all([
    typeof ctx.getProjectGoal === 'function'
      ? ctx.getProjectGoal().catch(() => null)
      : Promise.resolve<string | null>(null),
    typeof ctx.getConversationContext === 'function'
      ? ctx.getConversationContext().catch(() => null)
      : Promise.resolve<ConversationContext | null>(null),
  ]);
  if (stale()) return;
  const projectGoal = typeof goalText === 'string' ? goalText.trim() : '';
  const conversation = context && Array.isArray(context.turns) ? context.turns : [];
  if (projectGoal) emit({ type: 'goal', applied: true });
  if (conversation.length > 0) emit({ type: 'context', applied: true });

  // 证据组装：polish / structure 待处理文本 = draft；iterate = 上一轮结果 + 细化要求。
  // conversation 只在真取到时进 payload——空数组也带上会让系统提示词讲一段「怎么用历史」的空话。
  const payload: OptimizePayload = {
    ...(task === 'iterate'
      ? { lastOptimizedPrompt: source, iterateInput: iterateInstruction }
      : { draft: source }),
    ...(conversation.length > 0 ? { conversation } : {}),
  };

  const stage = (extra: {
    task: OptimizeTask;
    payload: OptimizePayload;
    display: (text: string) => void;
    step?: (step: 'model' | 'start' | 'poll') => void;
    hasConversation: boolean;
  }) =>
    runStage({
      config,
      host,
      lang,
      task: extra.task,
      payload: extra.payload,
      signal: controller.signal,
      getSessionModel: ctx.getSessionModel,
      display: extra.display,
      step: extra.step,
      projectGoal,
      hasConversation: extra.hasConversation,
    });

  try {
    // 阶段 1：主任务（polish / iterate / structure）。全文先做整体清洗（围栏解包 + 引导语剥离），
    // 再剥意图行：意图只在卡片上显示，绝不进 result、绝不写回输入框、绝不参与保真校验。
    const main = splitIntent(extractResult(await stage({
      task,
      payload,
      hasConversation: conversation.length > 0,
      display: (text) => emit({ type: 'draft', text }),
      step: (step) => emit({ type: 'step', step }),
    })));
    if (stale()) return;

    // 阶段 2（校验内核）：原文实体必须在结果里逐字保留；有缺失才做一次有界修复
    const report = validatePreservation(source, main.body);
    if (report.missing.length > 0 && !controller.signal.aborted) {
      emit({ type: 'step', step: 'repair' });
      emit({ type: 'draft', text: '' });
      emit({ type: 'reasoning', text: '' });
      rearmTimer();
      try {
        // 修复阶段：不带目标、不带上下文、不认意图行（系统提示词里没有那条契约，
        // 模型若仍自陈意图，剥掉它只为防混进正文，显示上沿用主任务那一句）
        const repaired = splitIntent(extractResult(await stage({
          task: 'repair',
          payload: { optimizedPrompt: main.body, missing: repairEnvelope(report.missing) },
          hasConversation: false,
          display: (text) => emit({ type: 'draft', text }),
          // 不传 step：修复阶段不让 'model'/'start'/'poll' 覆盖卡片上的「修复中」
        })));
        if (!repaired.body.trim()) throw new Error('empty repair');
        const recheck = validatePreservation(source, repaired.body);
        emit({ type: 'show', result: repaired.body, intent: main.intent });
        if (recheck.missing.length > 0) {
          emit({ type: 'note', missing: recheck.missing.length });
        }
        return;
      } catch (e) {
        if (isAbortError(e)) {
          if (timedOut) emit({ type: 'fail', kind: 'timeout' as OptimizeErrorKind });
          return;
        }
        // 修复失败（非中止）：降级显示主结果 + 残留计数——主结果仍可用，不因修复失败而丢
        emit({ type: 'show', result: main.body, intent: main.intent });
        emit({ type: 'note', missing: report.missing.length });
        return;
      }
    }
    emit({ type: 'show', result: main.body, intent: main.intent });
  } catch (e) {
    // 阶段 1 失败：先判定中止（用户/组件取消与超时都表现为 AbortError；仅超时写入错误态）
    if (isAbortError(e)) {
      if (timedOut) emit({ type: 'fail', kind: 'timeout' as OptimizeErrorKind });
      return;
    }
    const kind = toErrorKind(e).kind;
    const detail = String((e as { message?: unknown })?.message ?? e);
    emit({ type: 'fail', kind, detail });
  } finally {
    if (activeController === controller) {
      activeController = null;
      activeSessionId = null;
    }
    clearTimeout(timer);
  }
}
