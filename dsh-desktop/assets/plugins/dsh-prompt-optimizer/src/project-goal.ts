/**
 * 项目优化目标（2.3.0）：按项目持久、跨会话存在的自定义优化指令。
 *
 * 存储与解析都在宿主半边（lib/index.js 的 projectGoal.get/set 端点：
 * ~/.dsh/prompt-optimizer-projects.json，键 = 会话头 cwd，项目目录零写入）；
 * 这一层只是通道面 + 形状净化 —— 任何失败都 fail-open（取不到目标 = 无目标，
 * 优化行为与 2.2.1 完全一致，绝不因它阻断优化）。
 */

import type { HostRpc } from './session-optimizer.js';
import { withTimeout } from './session-optimizer.js';

/** 与宿主半边 MAX_GOAL_CHARS 同值（回归锁咬两半一致；UI 用它做 maxLength）。 */
export const MAX_GOAL_CHARS = 4000;

const GOAL_TIMEOUT_MS = 3_000;

export interface ProjectGoal {
  /** 项目目录（会话头 cwd）——目标按它键控 */
  cwd: string;
  /** 工作区标题（宿主从 workspaceRegistry 取；缺失时 UI 回落路径末段） */
  title?: string;
  /** 用户写下的优化目标；空串 = 未设置 */
  instruction: string;
  updatedAt?: string;
}

function goalOf(value: unknown): ProjectGoal | null {
  if (!value || typeof value !== 'object') return null;
  const v = value as { cwd?: unknown; title?: unknown; instruction?: unknown; updatedAt?: unknown };
  if (typeof v.cwd !== 'string' || !v.cwd) return null;
  const goal: ProjectGoal = {
    cwd: v.cwd,
    instruction: typeof v.instruction === 'string' ? v.instruction : '',
  };
  if (typeof v.title === 'string' && v.title) goal.title = v.title;
  if (typeof v.updatedAt === 'string' && v.updatedAt) goal.updatedAt = v.updatedAt;
  return goal;
}

/** 取当前会话所属项目的目标。无会话 / 无项目 / 通道失败 → null（fail-open）。 */
export async function fetchProjectGoal(
  rpc: HostRpc,
  sessionId: string | null,
  timeoutMs = GOAL_TIMEOUT_MS,
): Promise<ProjectGoal | null> {
  if (!sessionId) return null;
  try {
    const res = await withTimeout(rpc.call('projectGoal.get', { sessionId }), timeoutMs, 'projectGoal.get');
    if (!res.ok) return null;
    return goalOf(res.value);
  } catch {
    return null;
  }
}

export type SaveProjectGoalResult =
  | { ok: true; goal: ProjectGoal }
  | { ok: false; error: string };

/**
 * 写当前会话所属项目的目标（空串 = 清除）。失败带原因返回给设置行展示，
 * 与配置保存同风格（不静默失败）。
 */
export async function saveProjectGoal(
  rpc: HostRpc,
  sessionId: string | null,
  instruction: string,
  timeoutMs = GOAL_TIMEOUT_MS,
): Promise<SaveProjectGoalResult> {
  if (!sessionId) return { ok: false, error: 'no-session' };
  if (instruction.trim().length > MAX_GOAL_CHARS) {
    return { ok: false, error: 'goal-too-long' };
  }
  try {
    const res = await withTimeout(
      rpc.call('projectGoal.set', { sessionId, instruction }),
      timeoutMs,
      'projectGoal.set',
    );
    if (!res.ok) {
      const detail = res.error ? res.error.details || res.error.code : undefined;
      return { ok: false, error: String(detail || 'rpc failed') };
    }
    const goal = goalOf(res.value);
    if (!goal) return { ok: false, error: 'bad-response' };
    return { ok: true, goal };
  } catch (e) {
    return { ok: false, error: String((e as { message?: unknown })?.message ?? e) };
  }
}

/** 项目展示名：工作区标题优先，缺失时取路径末段（Windows/Unix 分隔符都认）。 */
export function projectLabel(goal: Pick<ProjectGoal, 'cwd' | 'title'>): string {
  if (goal.title) return goal.title;
  const parts = goal.cwd.split(/[\\/]+/).filter(Boolean);
  return parts.length > 0 ? parts[parts.length - 1] : goal.cwd;
}