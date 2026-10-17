/**
 * 上一轮对话（2.4.0 上下文润色）：把「这个会话刚才在聊什么」取回来当润色证据。
 *
 * 读取与截断预算全在宿主半边（lib/index.js 的 history 端点：活会话 deriveMessages →
 * 冷会话只读句柄回落，条数 / 单条字数 / 总字数三重收口）；这一层只是通道面 + 形状净化。
 * 任何失败一律 fail-open：取不到上下文 = 回到 2.3.0 的行为，润色绝不因此停摆。
 */

import type { HostRpc } from './session-optimizer.js';
import { withTimeout } from './session-optimizer.js';

/** 上下文读取的等待上限：它在润色之前，卡住了比不读更糟 */
export const CONTEXT_TIMEOUT_MS = 2_000;

export interface ConversationTurn {
  role: 'user' | 'assistant';
  text: string;
}

export interface ConversationContext {
  turns: ConversationTurn[];
  /** 来源标记（'live' 活会话派生历史 / 'persistence' 冷会话日志），仅用于诊断与文案 */
  source: string;
  /** 宿主侧预算是否截断过（卡片据此说明「上下文已截断」） */
  truncated: boolean;
}

/** 净化宿主回包：形状不对就当没读到（fail-open），绝不把未知形状带进提示词。 */
export function contextOf(value: unknown): ConversationContext | null {
  if (!value || typeof value !== 'object') return null;
  const raw = (value as { turns?: unknown }).turns;
  if (!Array.isArray(raw) || raw.length === 0) return null;
  const turns: ConversationTurn[] = [];
  for (const item of raw) {
    if (!item || typeof item !== 'object') continue;
    const entry = item as { role?: unknown; text?: unknown };
    if (typeof entry.text !== 'string' || !entry.text.trim()) continue;
    if (entry.role !== 'user' && entry.role !== 'assistant') continue;
    turns.push({ role: entry.role, text: entry.text.trim() });
  }
  if (turns.length === 0) return null;
  const snapshot = value as { source?: unknown; truncated?: unknown };
  return {
    turns,
    source: typeof snapshot.source === 'string' ? snapshot.source : 'unknown',
    truncated: snapshot.truncated === true,
  };
}

/** 取当前会话的上一轮对话。无会话 / 通道失败 / 会话没有历史 → null（fail-open）。 */
export async function fetchConversationContext(
  rpc: HostRpc,
  sessionId: string | null,
  timeoutMs = CONTEXT_TIMEOUT_MS,
): Promise<ConversationContext | null> {
  if (!sessionId) return null;
  try {
    const res = await withTimeout(rpc.call('history', { sessionId }), timeoutMs, 'history');
    if (!res.ok) return null;
    return contextOf(res.value);
  } catch {
    return null;
  }
}
