/** 预览卡片状态机 —— 纯 reducer，无 DSH 依赖 */

import type { OptimizeErrorKind } from './optimizer.js';

export type PreviewStatus = 'idle' | 'optimizing' | 'preview' | 'error' | 'guide';

export interface PreviewState {
  status: PreviewStatus;
  result: string;
  errorKind: OptimizeErrorKind | null;
  /** 原始错误细节（宿主通道失败等原因，卡片显示出来便于诊断） */
  errorDetail: string | null;
  generation: number;
  /** 流式优化中的增量文本（optimizing 态实时更新；非流式全程为空串） */
  draft: string;
  /** 流式优化中的推理过程文本（模型先产 reasoning 再产答案；随 SSE 实时滚动） */
  reasoning: string;
  /** 发起优化的会话 id（null = 未绑定/全局）：预览窗口只属于该会话，切走不跟随 */
  sessionId: string | null;
  /** 当前步骤（'model' | 'start' | 'poll' | 'repair' | null）：卡片显示进度，定位卡点 */
  step: 'model' | 'start' | 'poll' | 'repair' | null;
  /** 校验内核的残留计数（修复后仍未逐字保留的条目数；null = 无残留/未触发） */
  note: { missing: number } | null;
  /** 本轮优化是否叠加了项目优化目标（2.3.0；卡片头部标签，begin 时归零） */
  goalApplied: boolean;
  /** 本轮优化是否带上了上一轮对话（2.4.0；卡片头部标签，begin 时归零） */
  contextApplied: boolean;
  /** 模型自陈的理解（2.4.0 意图行；null = 这次没按契约输出，不显示） */
  intent: string | null;
}

/** 只读共享常量：reducer 永不写回它或返回可变的新对象；消费者（Task 4 store 胶水）必须以 { ...INITIAL_PREVIEW } 为每会话种子 */
export const INITIAL_PREVIEW: PreviewState = {
  status: 'idle',
  result: '',
  errorKind: null,
  errorDetail: null,
  generation: 0,
  draft: '',
  reasoning: '',
  sessionId: null,
  step: null,
  note: null,
  goalApplied: false,
  contextApplied: false,
  intent: null,
};

export type PreviewAction =
  | { type: 'begin'; sessionId?: string | null }
  | { type: 'show'; result: string; intent?: string | null }
  | { type: 'fail'; kind: OptimizeErrorKind; detail?: string }
  | { type: 'guide' }
  | { type: 'close' }
  | { type: 'draft'; text: string }
  | { type: 'reasoning'; text: string }
  | { type: 'step'; step: 'model' | 'start' | 'poll' | 'repair' | null }
  | { type: 'note'; missing: number | null }
  | { type: 'goal'; applied: boolean }
  | { type: 'context'; applied: boolean };

export function reducePreview(state: PreviewState, action: PreviewAction): PreviewState {
  switch (action.type) {
    case 'begin':
      if (state.status === 'optimizing') return state;
      return {
        ...state,
        status: 'optimizing',
        errorKind: null,
        errorDetail: null,
        draft: '',
        note: null,
        sessionId: action.sessionId ?? null,
        step: 'model',
        generation: state.generation + 1,
        goalApplied: false,
        contextApplied: false,
        intent: null,
      };
    case 'show':
      return state.status === 'optimizing'
        ? {
            ...state,
            status: 'preview',
            result: action.result,
            draft: '',
            intent: action.intent === undefined ? state.intent : action.intent,
          }
        : state;
    case 'fail':
      return state.status === 'optimizing'
        ? { ...state, status: 'error', errorKind: action.kind, errorDetail: action.detail ?? null }
        : state;
    case 'guide':
      return state.status === 'optimizing' ? state : { ...state, status: 'guide' };
    case 'close':
      return INITIAL_PREVIEW;
    case 'draft':
      return state.status === 'optimizing' ? { ...state, draft: action.text } : state;
    case 'reasoning':
      return state.status === 'optimizing' ? { ...state, reasoning: action.text } : state;
    case 'step':
      return state.status === 'optimizing' ? { ...state, step: action.step } : state;
    case 'note':
      return state.status === 'optimizing' || state.status === 'preview'
        ? { ...state, note: action.missing === null ? null : { missing: action.missing } }
        : state;
    case 'goal':
      return state.status === 'optimizing' ? { ...state, goalApplied: action.applied } : state;
    case 'context':
      return state.status === 'optimizing' ? { ...state, contextApplied: action.applied } : state;
    default:
      return state;
  }
}

/** 计划规定的公开 API（Task 4 起存在；canTrigger 的 !busy 半边承担并发把关职责，其余保留以备后续消费者） */
export function canOptimizeFrom(status: PreviewStatus): boolean {
  return status !== 'optimizing';
}
