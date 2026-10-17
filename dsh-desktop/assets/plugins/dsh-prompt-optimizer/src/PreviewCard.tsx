/** 输入区浮层预览卡片：guide / optimizing / preview / error 四种内容态
 *  状态来自模块级预览总线（preview-bus），不依赖会话 store/hook props */

import React, { useEffect, useRef, useState } from 'react';
import type { Lang, PromptConfig } from './optimizer.js';
import { runOptimize, closePreview } from './optimizer-store.js';
import { getPreviewBusState, subscribePreviewBus } from './preview-bus.js';
import { readComposerText, writeComposerText } from './composer.js';
import type { ConversationContext } from './conversation-context.js';
import { setUndoRecord } from './undo-bus.js';

export interface PreviewCardProps {
  t: (key: string) => string;
  getConfig: () => PromptConfig;
  getLang: () => Lang;
  openSettings: () => void;
  getSessionModel?: () => Promise<{ provider: string; model: string } | null>;
  getHost?: () => { rpc: { call: (e: string, p?: Record<string, unknown>) => Promise<{ ok: boolean; value?: unknown; error?: { code?: string } }> } } | null;
  getSessionId?: () => string | null;
  /** 项目优化目标（2.3.0）：卡片发起的重试/细化/结构化同样带上当前项目目标 */
  getProjectGoal?: () => Promise<string | null>;
  /** 上一轮对话（2.4.0）：卡片发起的任务同样带上下文 */
  getConversationContext?: () => Promise<ConversationContext | null>;
}

const CSS_ID = 'dsh-prompt-optimizer/card.css';
function injectCss() {
  if (typeof document === 'undefined' || document.querySelector(`style[data-plugin-css="${CSS_ID}"]`)) return;
  const style = document.createElement('style');
  style.dataset.pluginCss = CSS_ID;
  style.textContent = `
.dsh-po-card {
  position: absolute;
  left: 12px;
  right: 12px;
  bottom: calc(100% + 8px);
  z-index: 40;
  background: var(--dsw-alias-bg-overlay, #fff);
  border: 1px solid var(--dsw-alias-border-l2, rgba(128,128,128,0.3));
  border-radius: 10px;
  box-shadow: 0 8px 24px rgba(0, 0, 0, 0.16);
  padding: 12px 14px;
  max-height: 320px;
  display: flex;
  flex-direction: column;
  gap: 8px;
}
.dsh-po-card-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  color: var(--dsw-alias-label-primary, #222);
  font-size: 13px;
  font-weight: 600;
}
.dsh-po-card-body {
  overflow: auto;
  white-space: pre-wrap;
  word-break: break-word;
  color: var(--dsw-alias-label-secondary, #444);
  font-size: 13px;
  line-height: 1.6;
  max-height: 200px;
}
.dsh-po-card-err {
  color: var(--dsw-alias-state-error-primary, #d03050);
  font-size: 13px;
}
.dsh-po-card-step {
  color: var(--dsw-alias-text-secondary, #8c93a1);
  font-size: 12px;
  margin-left: 4px;
}
.dsh-po-card-err-detail {
  margin-top: 4px;
  color: var(--dsw-alias-text-secondary, #8c93a1);
  font-size: 12px;
  word-break: break-all;
}
.dsh-po-card-note {
  color: var(--dsw-alias-text-secondary, #8c93a1);
  font-size: 12px;
}
.dsh-po-card-goalTag {
  margin-left: 6px;
  font-weight: 400;
  font-size: 12px;
  color: var(--dsw-alias-label-secondary, #444);
  background: var(--dsw-alias-interactive-bg-hover, rgba(128,128,128,0.14));
  border-radius: 999px;
  padding: 1px 8px;
}
.dsh-po-card-contextTag {
  margin-left: 6px;
  font-weight: 400;
  font-size: 12px;
  color: var(--dsw-alias-label-secondary, #444);
  background: var(--dsw-alias-interactive-bg-hover, rgba(128,128,128,0.14));
  border-radius: 999px;
  padding: 1px 8px;
}
.dsh-po-card-intent {
  font-size: 12px;
  color: var(--dsw-alias-text-secondary, #8c93a1);
  border-left: 2px solid var(--dsw-alias-border-l2, rgba(128,128,128,0.3));
  padding-left: 8px;
}
.dsh-po-card-intent-label {
  margin-right: 4px;
  color: var(--dsw-alias-label-secondary, #444);
}
.dsh-po-card-row {
  display: flex;
  gap: 8px;
  flex-wrap: wrap;
}
.dsh-po-card-btn {
  border: 0;
  border-radius: 6px;
  padding: 4px 10px;
  font-size: 12px;
  cursor: pointer;
  color: var(--dsw-alias-label-primary, #222);
  background: var(--dsw-alias-interactive-bg-hover, rgba(128,128,128,0.14));
}
.dsh-po-card-btn.primary {
  /* 写死主色：--dsw-alias-brand-primary 在深夜模式解析为浅色 → 白底白字不可读（用户实测） */
  color: #fff;
  background: #1677ff;
}
.dsh-po-card-btn:disabled {
  opacity: 0.45;
  cursor: default;
}
.dsh-po-card-iter {
  display: flex;
  gap: 8px;
}
.dsh-po-card-input {
  flex: 1;
  min-width: 0;
  border: 1px solid var(--dsw-alias-border-l2, rgba(128,128,128,0.3));
  border-radius: 6px;
  padding: 4px 8px;
  font-size: 12px;
  color: var(--dsw-alias-label-primary, #222);
  background: transparent;
  outline: none;
}
.dsh-po-card-input::placeholder {
  color: var(--dsw-alias-text-secondary, #8c93a1);
}
`;
  document.head.appendChild(style);
}

// composer 读写面（textOfInput / findComposer / readComposerText / writeComposerText /
// isLexicalEditor / pasteReplace）2.4.0 起移到 src/composer.ts —— 预览卡与按钮共用同一组通道。

function errorKey(kind: string | null): string {
  switch (kind) {
    // kind → locale key；'config' 在 UI 上不可达（runOptimize 先走 guide），AbortError→timeout 由 runOptimize 先行拦截，保留双保险
    case 'unauthorized': case 'forbidden': case 'timeout': case 'network': case 'cors': case 'http': case 'bad-response': case 'empty': case 'config':
      return `error.${kind}`;
    default:
      return 'error.network';
  }
}

export function PreviewCard(props: PreviewCardProps) {
  const {
    t,
    getConfig,
    getLang,
    openSettings,
    getSessionModel,
    getHost,
    getSessionId,
    getProjectGoal,
    getConversationContext,
  } = props;

  // 订阅模块级预览总线（替代会话 store props）
  const [state, setState] = useState(() => getPreviewBusState());
  useEffect(
    () => subscribePreviewBus(() => setState(getPreviewBusState())),
    [],
  );

  useEffect(() => injectCss(), []);

  // 卸载时清理：清除挂起的 copied 复位定时器，并标记未挂载，
  // 防止迟到的 setCopied(true)（copy 的 await 期间卸载）在卸载后触发。
  const mountedRef = useRef(true);
  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      if (copyTimerRef.current !== null) {
        clearTimeout(copyTimerRef.current);
        copyTimerRef.current = null;
      }
    };
  }, []);

  // errorDetail 必须解构出来：错误分支渲染 `errorDetail ? ... : null`，未绑定标识符
  // = 错误卡渲染即 ReferenceError（被错误边界吞掉 → 卡片凭空消失，实测于升级前的 dist）
  const { status, result, errorKind, errorDetail, goalApplied, contextApplied, intent } = state;
  const [copied, setCopied] = useState(false);
  /** 迭代细化的追加要求（仅 preview 态使用；提交后清空） */
  const [iterInput, setIterInput] = useState('');
  const copyTimerRef = useRef<number | null>(null);

  // 预览窗口绑定发起会话：切换到别的会话时不跟随显示（切回发起会话恢复）
  if (status !== 'idle' && state.sessionId !== null) {
    const sid = getSessionId?.();
    if (sid !== null && state.sessionId !== sid) return null;
  }
  if (status === 'idle') return null;

  /** 卡片发起的三种任务共用同一 ctx；iterate / structure 以当前结果为 base（草稿不再参与） */
  const runWith = (extra: { iterate?: { base: string; instruction: string }; structure?: { base: string } } = {}) => {
    void runOptimize({
      getConfig,
      getLang,
      getDraft: () => readComposerText(),
      getSessionModel,
      host: getHost?.() ?? undefined,
      getSessionId,
      getProjectGoal,
      getConversationContext,
      ...extra,
    });
  };

  const retry = () => runWith();

  /** 细化：把输入框的追加要求融入当前结果（提交后清空输入框；optimizing 期间卡片翻面） */
  const refine = () => {
    const instruction = iterInput.trim();
    if (!instruction) return;
    setIterInput('');
    runWith({ iterate: { base: result, instruction } });
  };

  /** 结构化展开：把当前结果扩写为角色/步骤/输出要求的完整提示词 */
  const expandStructure = () => runWith({ structure: { base: result } });

  const replace = () => {
    // 覆盖式写回之前先留底本（Qoder 增强的 undo 同款口径）：润色砸了一键回原话。
    // 取的是「此刻输入框里的文本」——卡片打开期间用户手改过草稿，撤销就该回到改后的那版。
    const original = readComposerText();
    writeComposerText(result);
    // 原样重复替换（底本与结果一致）没什么可撤的，清掉旧记录避免「撤销」把用户带回同一份文本
    setUndoRecord(original === result ? null : { sessionId: getSessionId?.() ?? null, original, replaced: result });
    closePreview();
  };

  const copy = async () => {
    if (!navigator.clipboard) return; // 非安全上下文（http 等）：不翻转 copied，保持可重试
    try {
      await navigator.clipboard.writeText(result);
      if (!mountedRef.current) return; // await 期间组件已卸载：不再 setState
      setCopied(true);
      if (copyTimerRef.current !== null) clearTimeout(copyTimerRef.current);
      copyTimerRef.current = window.setTimeout(() => {
        setCopied(false);
        copyTimerRef.current = null;
      }, 1200);
    } catch {
      // 剪贴板写入失败：静默（不翻转 copied）
    }
  };

  return (
    <div className="dsh-po-card" role="status">
      <div className="dsh-po-card-head">
        <span>
          {t('card.title')}
          {goalApplied && (
            <span className="dsh-po-card-goalTag" title={t('card.goalTagHint')}>
              {t('card.goalTag')}
            </span>
          )}
          {contextApplied && (
            <span className="dsh-po-card-contextTag" title={t('card.contextTagHint')}>
              {t('card.contextTag')}
            </span>
          )}
        </span>
        <button type="button" className="dsh-po-card-btn" onClick={() => closePreview()}>
          ✕
        </button>
      </div>

      {status === 'guide' && (
        <>
          <div className="dsh-po-card-body">{t('guide.title')}</div>
          <div className="dsh-po-card-body">{t('guide.desc')}</div>
          <div className="dsh-po-card-row">
            <button type="button" className="dsh-po-card-btn primary" onClick={() => { closePreview(); openSettings(); }}>
              {t('guide.action')}
            </button>
            <button type="button" className="dsh-po-card-btn" onClick={() => closePreview()}>
              {t('guide.dismiss')}
            </button>
          </div>
        </>
      )}

      {status === 'optimizing' && (
        <>
          {state.step === 'repair' ? (
            <div className="dsh-po-card-step">{t('card.step.repair')}</div>
          ) : null}
          <div className="dsh-po-card-body">
            {state.reasoning && !state.draft ? (
              <span
                style={{
                  whiteSpace: 'pre-wrap',
                  color: 'var(--dsw-alias-text-secondary, #8c93a1)',
                  fontSize: '12px',
                }}
              >
                {state.reasoning}
              </span>
            ) : null}
            {state.draft ? <span style={{ whiteSpace: 'pre-wrap' }}>{state.draft}</span> : null}
            {!state.draft && !state.reasoning ? t('card.optimizing') : null}
          </div>
        </>
      )}

      {status === 'preview' && (
        <>
          {intent ? (
            <div className="dsh-po-card-intent" title={t('card.intentHint')}>
              <span className="dsh-po-card-intent-label">{t('card.intentLabel')}</span>
              {intent}
            </div>
          ) : null}
          <div className="dsh-po-card-body">{result}</div>
          {state.note ? (
            <div className="dsh-po-card-note">
              {t('card.note.missing').replace('{n}', String(state.note.missing))}
            </div>
          ) : null}
          <div className="dsh-po-card-iter">
            <input
              className="dsh-po-card-input"
              type="text"
              value={iterInput}
              placeholder={t('card.iterate.placeholder')}
              aria-label={t('card.iterate.aria')}
              onChange={(e) => setIterInput(e.target.value)}
              onKeyDown={(e) => {
                // 中文输入法组词中的 Enter 不提交（isComposing）
                if (e.key === 'Enter' && !e.nativeEvent.isComposing) {
                  e.preventDefault();
                  refine();
                }
              }}
            />
            <button type="button" className="dsh-po-card-btn" disabled={!iterInput.trim()} onClick={refine}>
              {t('card.iterate.submit')}
            </button>
          </div>
          <div className="dsh-po-card-row">
            <button type="button" className="dsh-po-card-btn primary" onClick={replace}>
              {t('card.replace')}
            </button>
            <button type="button" className="dsh-po-card-btn" onClick={() => void copy()}>
              {copied ? t('card.copyDone') : t('card.copy')}
            </button>
            <button type="button" className="dsh-po-card-btn" onClick={retry}>
              {t('card.retry')}
            </button>
            <button type="button" className="dsh-po-card-btn" onClick={expandStructure}>
              {t('card.structure')}
            </button>
            <button type="button" className="dsh-po-card-btn" onClick={() => closePreview()}>
              {t('card.dismiss')}
            </button>
          </div>
        </>
      )}

      {status === 'error' && (
        <>
          <div className="dsh-po-card-err">{t(errorKey(errorKind))}</div>
          {errorDetail ? <div className="dsh-po-card-err-detail">{errorDetail}</div> : null}
          <div className="dsh-po-card-row">
            <button type="button" className="dsh-po-card-btn primary" onClick={retry}>
              {t('card.retry')}
            </button>
            <button type="button" className="dsh-po-card-btn" onClick={() => closePreview()}>
              {t('card.dismiss')}
            </button>
          </div>
        </>
      )}
    </div>
  );
}