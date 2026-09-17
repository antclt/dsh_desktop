/**
 * Whoami anchor turn — seed ONE self-introduction round ahead of the user's
 * very first real message.
 *
 * The anchor is PREPENDED to the `next-turn` inbox queue ahead of the real
 * message, and dsh claims exactly ONE `next-turn` message per turn, so the
 * first real model request is the fixed "who are you" prompt on an EMPTY tool
 * surface (see zero-tool-bootstrap.mjs), while the user's actual message stays
 * queued and is claimed by the NEXT turn — by then the bootstrap has promoted
 * and the full Standard catalog (including the search MCP) is unlocked.
 *
 * Anchoring on the first user message — instead of at session creation — keeps
 * the blank-session preset switcher usable before the user types anything.
 *
 * Durability is free: the prepend goes through `agent/inbox/spliced` event
 * persistence, so a crash between the anchor and the real message resumes the
 * queue in order, and the inbox replay does not fire `inserted` notifications,
 * so the anchor is never re-injected.
 */

/** Cordis plugin name used by loader diagnostics. */

/**
 * 内核 0.1.6 起 Session 把事件日志收成私有（`private eventsSnapshot`），公开读法
 * 变成 `snapshotEvents()` / `ownEvents()`；旧版是直接读 `session.events`。
 * 两种形状都兼容——只认旧形状时，0.1.6 上这里会抛
 * `Cannot read properties of undefined (reading 'find')`，整轮运行直接失败
 * （用户实报：除标准模式外所有预设发消息即断）。
 * 注：`snapshotEvents()` 在 0.1.6 里标注为 deprecated（新代码应走异步事件流），
 * 预设钩子是同步装配路径，这里按官方「既有逻辑可暂不迁移」的豁免使用。
 */
function sessionEvents(session) {
  if (Array.isArray(session?.events)) return session.events
  if (typeof session?.snapshotEvents === 'function') return session.snapshotEvents()
  if (typeof session?.ownEvents === 'function') return session.ownEvents()
  return []
}
export const name = 'whoami-turn'

/** Default anchor text shown to the model in the synthetic first user turn. */
export const ANCHOR_TEXT = '你是谁'

/** Only top-level fresh sessions (no prior user message) get the anchor turn. */
function isFreshTopLevel(agent) {
  if ((agent.session.header.delegationDepth ?? 0) > 0) return false
  return !sessionEvents(agent.session).some((event) => event.type === 'user/message')
}

/** Register the first-message whoami anchor injection. */
export function apply(ctx, config) {
  const text = typeof config.text === 'string' && config.text.length > 0
    ? config.text
    : ANCHOR_TEXT

  ctx.on('agent/inbox/inserted', ({ agent, message }) => {
    if (!isFreshTopLevel(agent)) return
    // Never re-anchor on plugin-sourced messages (including our own anchor).
    if (message.source?.kind === 'plugin') return
    agent.inbox.prepend('next-turn', {
      id: crypto.randomUUID(),
      role: 'user',
      content: [{ type: 'text', text }],
      source: {
        kind: 'plugin',
        plugin: 'whoami-turn',
        form: 'notice',
        summary: 'whoami anchor turn',
      },
    })
  })
}
