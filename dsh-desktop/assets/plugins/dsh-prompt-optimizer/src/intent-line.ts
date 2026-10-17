/**
 * 意图行（2.4.0）：让模型在正文之前用一行说出「它理解到的用户意图」，卡片单独显示、
 * 写回输入框前剥掉——把「猜」变成当场能核对的东西（Qoder 的一键增强之所以敢一键，
 * 是因为增强结果里看得见的部分可以被一键撤回）。
 *
 * 输出契约是软的：模型不保证照格式来。所以解析口径是「宁可不显示，也绝不误剥正文」——
 * 只有第一行非空文本以标记开头、且剥完还剩正文时才拆；任一条件不满足就整体当正文。
 */

/** 意图行长度上限：卡片只放一句话，超长说明模型在写段落，不当意图处理 */
export const INTENT_MAX_CHARS = 160;

export interface IntentSplit {
  /** 拆出来的意图；null = 这次没有可显示的意图 */
  intent: string | null;
  /** 真正要写回输入框 / 交给校验内核的正文 */
  body: string;
}

/**
 * 第一行形如 `意图：xxx` / `Intent: xxx`（容忍 markdown 加粗与全半角冒号）时拆出意图。
 * 只认第一行：正文中段出现的「意图：」是用户自己要的内容，剥了就是吃掉用户的话。
 */
export function splitIntent(raw: string): IntentSplit {
  const text = typeof raw === 'string' ? raw : '';
  const whole = text.trim();
  const stripped = whole.replace(/^\s+/, '');
  const newline = stripped.indexOf('\n');
  const firstLine = (newline === -1 ? stripped : stripped.slice(0, newline)).trim();
  const marker = /^[*_]{0,2}\s*(?:意图|intent)\s*[*_]{0,2}\s*[:：]\s*(.+)$/i.exec(firstLine);
  if (!marker) return { intent: null, body: whole };
  const intent = marker[1].trim().slice(0, INTENT_MAX_CHARS);
  const body = newline === -1 ? '' : stripped.slice(newline + 1).trim();
  if (!intent || !body) return { intent: null, body: whole };
  return { intent, body };
}
