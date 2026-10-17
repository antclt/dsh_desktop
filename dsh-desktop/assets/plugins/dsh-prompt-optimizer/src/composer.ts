/**
 * composer 读写面（2.4.0 起独立成模块）：预览卡「替换草稿」与按钮「撤销写回」共用同一组
 * DOM 通道，判据只能有一份——读回来的文本和写进去的文本必须走同一套控件定位，
 * 否则「输入框里还是不是刚写入的那份结果」这类比对会永远不成立。
 */

/** textarea 用 .value；contenteditable（DSH composer，Lexical div）用 innerText。 */
export function textOfInput(el: Element): string {
  if (el instanceof HTMLTextAreaElement) return el.value;
  if (el instanceof HTMLElement && el.isContentEditable) return el.innerText || '';
  return '';
}

/** 是否 DSH 会话输入控件：textarea，或 composer 的 contenteditable 宿主。 */
export function isSessionInput(el: Element | null): boolean {
  if (el === null) return false;
  if (el instanceof HTMLTextAreaElement) return true;
  const editable = el instanceof HTMLElement && el.isContentEditable;
  const composer = el instanceof Element && el.closest('[data-composer-input]') !== null;
  return editable || composer;
}

/** 找 composer 输入框：优先焦点，否则回退到页面中的 composer 宿主 / 第一个可用输入控件 */
export function findComposer(): Element | null {
  const active = document.activeElement;
  if (active && isSessionInput(active)) return active;
  const composer = document.querySelector('[data-composer-input]');
  if (composer && isSessionInput(composer)) return composer;
  const all = document.querySelectorAll<HTMLTextAreaElement>('textarea');
  for (const ta of all) {
    if (!ta.disabled) return ta;
  }
  return null;
}

export function readComposerText(): string {
  const el = findComposer();
  return el ? textOfInput(el) : '';
}

/** 是否 Lexical 富文本编辑器（DSH composer 宿主带 data-lexical-editor）。 */
export function isLexicalEditor(el: Element): boolean {
  return (
    el.getAttribute('data-lexical-editor') === 'true' ||
    el.closest('[data-lexical-editor]') !== null
  );
}

/**
 * 经 Lexical 自己的粘贴通道做整段替换：先合成 Ctrl+A（触发 SELECT_ALL 全选），再合成
 * paste 事件（DataTransfer 带 text/plain），由 Lexical 的粘贴处理器完成写入。
 * 返回 true = 编辑器已消费（paste 被 preventDefault）。全程同步，不依赖焦点位置。
 *
 * 为什么不用 execCommand('insertText')：Chromium 对多行文本会拆成逐行 insertText +
 * data=null 的换行事件，Lexical 吞掉换行，8+ 行时整段静默失败（DOM 纹丝不动、无异常、
 * 无报错）——「展开为结构化」的多行结果点「替换草稿」没反应即此（单行短文本碰巧走通，
 * 所以普通润色看不出问题）。粘贴通道逐字保真（含 \n）。
 */
export function pasteReplace(el: HTMLElement, text: string): boolean {
  try {
    el.dispatchEvent(
      new KeyboardEvent('keydown', {
        key: 'a',
        code: 'KeyA',
        ctrlKey: true,
        bubbles: true,
        cancelable: true,
        composed: true,
      }),
    );
    const dt = new DataTransfer();
    dt.setData('text/plain', text);
    let ev: ClipboardEvent;
    try {
      ev = new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true });
    } catch {
      ev = new ClipboardEvent('paste', { bubbles: true, cancelable: true });
    }
    if (ev.clipboardData !== dt) {
      // 部分实现忽略构造参数：把 DataTransfer 挂到事件上再派发
      Object.defineProperty(ev, 'clipboardData', { value: dt });
    }
    return el.dispatchEvent(ev) === false;
  } catch {
    return false; // 合成通道不可用（非现代浏览器等）→ 调用方回退 insertText
  }
}

/** 观察用的稳定落点：composer 宿主优先，否则第一个 textarea（旧宿主）。
 *  与 findComposer 的区别是**不跟着焦点跑**——订阅要挂在同一个节点上才不漏事件。 */
export function findComposerHost(): Element | null {
  if (typeof document === 'undefined') return null;
  const composer = document.querySelector('[data-composer-input]');
  if (composer) return composer;
  const lexical = document.querySelector('[data-lexical-editor]');
  if (lexical) return lexical;
  return document.querySelector('textarea');
}

/**
 * 订阅 composer 文本变化。真机实测（2026-10-17，隔离内核 + rc.2 的 Lexical composer）：
 * 编辑器消费 paste 之后自己重排 DOM，**既不派发 input、也不派发任何别的事件**——
 * 只监听 input 的实现会在「替换草稿」后停在陈旧态（撤销记录已经写好、按钮却不翻新），
 * 用户随后手改输入框也收不回撤销，点一下就把他自己的改动覆盖了。
 * 所以判据下沉到 DOM 层：MutationObserver 为准，input 只作 textarea 宿主的补充；
 * 微任务合并，避免流式渲染期间一帧内反复重读。
 */
export function observeComposerText(refresh: () => void): () => void {
  if (typeof document === 'undefined') return () => {};
  let queued = false;
  const schedule = () => {
    if (queued) return;
    queued = true;
    Promise.resolve().then(() => {
      queued = false;
      refresh();
    });
  };
  let target: Element | null = null;
  let observer: MutationObserver | null = null;
  const attach = () => {
    const el = findComposerHost();
    if (el === target) return;
    if (observer) observer.disconnect();
    target = el;
    observer = typeof MutationObserver === 'undefined' ? null : new MutationObserver(schedule);
    if (target !== null && observer !== null) {
      observer.observe(target, { childList: true, subtree: true, characterData: true });
    }
  };
  attach();
  // composer 可能晚于按钮挂载，或切会话时整块重建：focusin 是最便宜的再定位时机
  document.addEventListener('focusin', attach, true);
  document.addEventListener('input', schedule, true);
  return () => {
    document.removeEventListener('focusin', attach, true);
    document.removeEventListener('input', schedule, true);
    if (observer) observer.disconnect();
    target = null;
    observer = null;
  };
}

/**
 * 写回 composer。textarea 用原生 value setter + input 事件（让 React 受控组件感知）；
 * contenteditable（Lexical）优先走粘贴通道（多行保真，见 pasteReplace），不可用时回退
 * select-all + execCommand('insertText')——lexical 监听原生 input，两者都会把 DOM
 * 同步回编辑器 state。
 */
export function writeComposerText(text: string): void {
  const el = findComposer();
  if (!el) return;
  if (el instanceof HTMLTextAreaElement) {
    const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')?.set;
    if (setter) {
      setter.call(el, text);
    } else {
      el.value = text;
    }
    el.dispatchEvent(new Event('input', { bubbles: true }));
    el.focus();
    return;
  }
  // contenteditable composer
  if (el instanceof HTMLElement && el.isContentEditable) {
    el.focus();
    if (isLexicalEditor(el) && pasteReplace(el, text)) {
      return;
    }
    if (document.execCommand) {
      const sel = window.getSelection();
      const range = document.createRange();
      range.selectNodeContents(el);
      sel?.removeAllRanges();
      sel?.addRange(range);
      // 原生 input 事件（insertText 需要第二个参数 nonce 以满足某些浏览器安全检查）
      document.execCommand('insertText', false, text);
      el.dispatchEvent(new Event('input', { bubbles: true }));
    } else {
      el.innerText = text;
      el.dispatchEvent(new Event('input', { bubbles: true }));
    }
  }
}
