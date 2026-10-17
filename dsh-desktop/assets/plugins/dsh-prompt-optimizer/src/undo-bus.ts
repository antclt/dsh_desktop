/**
 * 一键撤销（2.4.0，照 Qoder PromptEnhanceButton 的 undo 形态搬）：
 * 「替换草稿」是覆盖式的——润色砸了，原话就没了，只能重写。这里记住写入前/后的两段文本，
 * 按钮在「输入框里仍然是刚写入的那份结果」时翻成 ↩，点一下复原。
 *
 * 三条自动放弃（都为了「绝不吞用户的编辑」）：会话换了、输入框内容被改过、已经撤回到一半
 * 再点一次。撤销是一次性的：复原成功即清空记录，避免把用户后来的输入按回旧结果。
 */

export interface UndoRecord {
  /** 发起本次润色的会话；与屏幕会话不一致就不提供撤销 */
  sessionId: string | null;
  /** 替换前的原草稿 */
  original: string;
  /** 替换写进去的那份结果 */
  replaced: string;
}

let record: UndoRecord | null = null;
const listeners = new Set<() => void>();

export function setUndoRecord(next: UndoRecord | null): void {
  record = next;
  for (const listener of listeners) listener();
}

/** 订阅变化；返回退订函数 */
export function subscribeUndoBus(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/**
 * 比对「输入框里是不是还是刚写入的那份」必须先归一。
 * Lexical 写进去的文本读回来不保证逐字相同：nbsp 代替空格、末尾多一个换行都可能——
 * 拿原始字符串 === 比对的结果是撤销按钮永远不出现，而界面看不出任何异常
 * （这类「静默做成死的」在本仓库已经栽过三次，见 AGENTS.md 的信封 / 幽灵字段两条）。
 */
function normalizeText(text: string): string {
  return typeof text === 'string' ? text.replace(/\u00a0/g, ' ').replace(/\r\n/g, '\n').trim() : '';
}

/**
 * 当前状态下能不能撤、撤回去是什么。
 * @param composerText 输入框此刻的文本
 * @param sessionId 屏幕上的会话
 * @returns 原草稿（可撤），或 null（不可撤）
 */
export function undoTargetFor(composerText: string, sessionId: string | null): string | null {
  if (record === null) return null;
  if (record.sessionId !== sessionId) return null;
  if (normalizeText(composerText) !== normalizeText(record.replaced)) return null;
  return record.original;
}
