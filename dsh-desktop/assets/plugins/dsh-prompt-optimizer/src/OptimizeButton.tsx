/** 输入栏右侧「优化」按钮 —— 不依赖会话 store/hook props，状态走模块级预览总线 */

import React, { useCallback, useEffect, useState } from 'react';
import type { Lang, PromptConfig } from './optimizer.js';
import { triggerBlock } from './optimizer.js';
import { runOptimize } from './optimizer-store.js';
import { getPreviewBusState, subscribePreviewBus } from './preview-bus.js';
import { onOptimizeRequest } from './events.js';
import { observeComposerText, writeComposerText } from './composer.js';
import type { ConversationContext } from './conversation-context.js';
import { setUndoRecord, subscribeUndoBus, undoTargetFor } from './undo-bus.js';

export interface OptimizeButtonProps {
  t: (key: string) => string;
  getConfig: () => PromptConfig;
  getLang: () => Lang;
  getSessionModel?: () => Promise<{ provider: string; model: string } | null>;
  getHost?: () => { rpc: { call: (e: string, p?: Record<string, unknown>) => Promise<{ ok: boolean; value?: unknown; error?: { code?: string } }> } } | null;
  getSessionId?: () => string | null;
  /** 项目优化目标（2.3.0）：取当前会话所属项目设定的目标（无/失败 = null） */
  getProjectGoal?: () => Promise<string | null>;
  /** 上一轮对话（2.4.0）：取当前会话最近几轮原话（无/失败 = null） */
  getConversationContext?: () => Promise<ConversationContext | null>;
}

const CSS_ID = 'dsh-prompt-optimizer/button.css';
function injectCss() {
  if (typeof document === 'undefined' || document.querySelector(`style[data-plugin-css="${CSS_ID}"]`)) return;
  const style = document.createElement('style');
  style.dataset.pluginCss = CSS_ID;
  style.textContent = `
.dsh-po-btn {
  border: 0;
  background: transparent;
  cursor: pointer;
  padding: 2px 6px;
  font-size: 14px;
  line-height: 1;
  opacity: 0.85;
  border-radius: 6px;
}
.dsh-po-btn:hover:not(:disabled) {
  opacity: 1;
  background: var(--dsw-alias-interactive-bg-hover, rgba(128,128,128,0.12));
}
.dsh-po-btn:disabled {
  opacity: 0.35;
  cursor: default;
}
`;
  document.head.appendChild(style);
}

/**
 * 读取当前草稿：优先取焦点输入控件（textarea 或 DSH composer 的
 * contenteditable div，后者是 dsh-web >= 0.1.0-rc.6 的实际输入面——
 * Lexical 编辑器渲染为 <div contenteditable data-composer-input>，页面上
 * 根本没有 textarea，老实现只认 textarea 导致草稿永远为空、点击静默返回，
 * 表现为「按钮点了无反应」）；否则回退到页面中「值非空」的输入控件
 * （用户在输入的即当前草稿）。不依赖会话标准 kit 的 input hook——实测
 * input.right 渲染时该标准 props 未提供，组件会因调用 undefined hook
 * 崩溃被错误边界吞掉（PO-RIGHT-OK 探针可见而 ✨ 不可见）。
 */

/** 从单个输入控件读文本：textarea 用 .value，contenteditable 用 innerText。 */
function textOfInput(el: Element): string {
  if (el instanceof HTMLTextAreaElement) return el.value;
  if (el instanceof HTMLElement && el.isContentEditable) return el.innerText || '';
  return '';
}

/** 是否 DSH 会话输入控件：textarea，或 composer 的 contenteditable 宿主。 */
function isSessionInput(el: Element | null): boolean {
  if (el === null) return false;
  if (el instanceof HTMLTextAreaElement) return true;
  const editable = el instanceof HTMLElement && el.isContentEditable;
  const composer = el instanceof Element && el.closest('[data-composer-input]') !== null;
  return editable || composer;
}

function readDraft(): string {
  // 1. 焦点控件（用户在输入的那个）：textarea 或 contenteditable composer。
  //    mousedown 时焦点尚未切走，activeElement 仍是输入框，直接命中。
  const active = document.activeElement;
  if (isSessionInput(active)) {
    const text = textOfInput(active);
    if (text.trim()) return text;
  }
  // 2. 页面中的 composer 宿主（点击按钮时焦点已移到按钮，activeElement 不再是
  //    输入框；composer 是全局唯一的 resident div，直接按 data 属性找）。
  const composer = document.querySelector<HTMLElement>('[data-composer-input]');
  if (composer !== null && isSessionInput(composer)) {
    const text = textOfInput(composer);
    if (text.trim()) return text;
  }
  // 3. 回退：任意「值非空」的 textarea（兼容旧版宿主/其他文本输入面）。
  const all = document.querySelectorAll<HTMLTextAreaElement>('textarea');
  for (const ta of all) {
    if (ta.value.trim()) return ta.value;
  }
  return '';
}

export function OptimizeButton(props: OptimizeButtonProps) {
  const {
    t,
    getConfig,
    getLang,
    getSessionModel,
    getHost,
    getSessionId,
    getProjectGoal,
    getConversationContext,
  } = props;

  /** 按钮一帧要看清的三件事：在不在优化、此刻草稿、有没有可撤的底本。
   *  composer（Lexical 宿主）没有可订阅的 store，文本变化也不派发 DOM 事件，
   *  只能靠 MutationObserver 重读（见 observeComposerText）——撤销是否可用完全
   *  取决于「输入框里还是不是刚写入的那份」，读晚一帧就是错判。 */
  const read = useCallback(() => {
    const st = getPreviewBusState();
    const sid = getSessionId?.() ?? null;
    // 预览窗口绑定发起会话——切到别的会话时按钮不再 busy（各会话可独立发起优化）
    const busy = st.status === 'optimizing' && (st.sessionId === null || st.sessionId === sid);
    const text = typeof document === 'undefined' ? '' : readDraft();
    return { busy, text, sid, undo: undoTargetFor(text, sid) };
  }, [getSessionId]);

  const [snapshot, setSnapshot] = useState(read);

  useEffect(() => {
    const refresh = () =>
      setSnapshot((prev) => {
        const next = read();
        return prev.busy === next.busy && prev.text === next.text && prev.undo === next.undo
          ? prev
          : next;
      });
    refresh();
    const offPreview = subscribePreviewBus(refresh);
    const offUndo = subscribeUndoBus(refresh);
    // composer 的文本变化不派发任何 DOM 事件（真机实测），订阅必须下沉到 MutationObserver
    const offDom = observeComposerText(refresh);
    return () => {
      offPreview();
      offUndo();
      offDom();
    };
  }, [read]);

  // mousedown 预读草稿：点击按钮瞬间焦点会切到按钮（activeElement 不再是 textarea），
  // 但 mousedown 早于焦点切换——此刻读到的 activeElement 仍是输入框。
  const draftRef = React.useRef('');
  const syncDraft = React.useCallback(() => {
    draftRef.current = readDraft();
  }, []);

  useEffect(() => injectCss(), []);

  const handleClick = useCallback(() => {
    const draft = draftRef.current || readDraft();
    const sid = getSessionId?.() ?? null;
    const undo = undoTargetFor(draft, sid);
    if (undo !== null) {
      // ↩ 态：一键回到润色前的原草稿（Qoder 增强的 undo 口径）。
      // 撤完即清底本：同一份结果不该被反复换进换出，更不该覆盖用户之后的输入。
      writeComposerText(undo);
      setUndoRecord(null);
      return;
    }
    if (triggerBlock(draft, snapshot.busy) !== null) return; // 禁用原因已由 title 说明，这里是竞态兜底
    void runOptimize({
      getConfig,
      getLang,
      getDraft: () => draft,
      getSessionModel,
      host: getHost?.(),
      getSessionId,
      getProjectGoal,
      getConversationContext,
    });
  }, [snapshot.busy, getConfig, getLang, getSessionId, getProjectGoal, getConversationContext]);

  // Alt+O 快捷键（index.ts 全局监听）→ 等效点击按钮
  useEffect(() => onOptimizeRequest(handleClick), [handleClick]);

  const canUndo = snapshot.undo !== null;
  const block = triggerBlock(snapshot.text, snapshot.busy);
  let label = t('button.aria');
  if (canUndo) label = t('button.undo');
  else if (block === 'busy') label = t('button.busy');
  else if (block === 'short') label = t('button.short');
  else if (block === 'long') label = t('button.long');

  return (
    <button
      type="button"
      className="dsh-po-btn"
      aria-label={label}
      title={label}
      aria-busy={snapshot.busy}
      data-block={canUndo ? null : block}
      disabled={snapshot.busy}
      data-busy={snapshot.busy}
      data-undo={canUndo}
      onMouseDown={syncDraft}
      onFocus={syncDraft}
      onClick={handleClick}
    >
      {snapshot.busy ? '⏳' : canUndo ? '↩' : '✨'}
    </button>
  );
}