/** dsh-prompt-optimizer 插件入口 — apply(ctx) */

import type { ClientContext } from '@deepseek-ai/dsh-client-runtime/client';
import type { Lang, PromptConfig } from './optimizer.js';
import { DEFAULTS, mergeConfig } from './optimizer.js';
import { NS, zh, en, langOf } from './locales.js';
import type { OptimizerActions } from './optimizer-store.js';
import { emitOptimizeRequest, emitOpenSettingsRequest } from './events.js';
import { OptimizeButton } from './OptimizeButton.tsx';
import { PreviewCard } from './PreviewCard.tsx';
import { SettingsRow } from './SettingsRow.tsx';
import { createSettingsFormStore } from './settings-store.js';
import type { HostRpc } from './session-optimizer.js';
import { withTimeout, callHost } from './session-optimizer.js';
import { fetchProjectGoal, saveProjectGoal } from './project-goal.js';
import { fetchConversationContext } from './conversation-context.js';

/**
 * 声明插件依赖的客户端服务（cordis service keys）：apply 内经 `ctx.<service>` 访问的服务必须在此声明。
 * 值须为服务名而非包 id——与同形态先例一致（dsh-message-rail: ["slots","sessions"]；
 * dsh-better-sidebar 亦声明 locale）；错误声明会让 fiber 永久 PENDING，启动审计直接判失败。
 */
export const inject = ['slots', 'sessions', 'locale'];

export function apply(ctx: ClientContext) {
  // 1. 文案
  ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'prompt-optimizer: locale registration');

  // 2. 配置镜像：HTTP API（server half 读写 ~/.dsh/prompt-optimizer-config.json，
  // 通道 '/dsh-prompt-optimizer/api/get|set'）。原先走 connection.rpc 环回通道，但桌面
  // 宿主运行时没有 connection 服务（fiber 永久 PENDING → 启动挂死），统一走 webServer HTTP。
  let configMirror: PromptConfig = mergeConfig(undefined);
  let configEpoch = 0;
  const rpcConfig = async (endpoint: string, payload?: Record<string, unknown>): Promise<unknown> => {
    const result = await callHost(endpoint, payload ?? {});
    if (!result.ok) {
      throw new Error(
        `config rpc ${endpoint} failed: ${(result.error && (result.error.details || result.error.code)) || 'rpc failed'}`,
      );
    }
    return result.value;
  };
  const loadConfig = async (): Promise<void> => {
    try {
      const value = await rpcConfig('get');
      configMirror = mergeConfig(value as Partial<PromptConfig> | undefined);
    } catch {
      // 初次连接未就绪时保持默认；下次保存后镜像即更新
    }
  };
  void loadConfig();

  // 2.5 当前会话解析（2026-10-16 在 rc.2 内核实测校正）：
  //   ① rc.2 唯一 sanctioned 来源 = ctx.get('sidebarRight').mounted：
  //      「屏幕上的会话」的 ObservableSnapshot（selected Session while the Conversation
  //      fills the main column）。此前依赖的 sessions.currentProvideInfo 在 rc.2 全包
  //      0 命中（幽灵字段，读恒 undefined——better-sidebar 留有同款教训注释：
  //      会话列表快照在任何 DSH 版本都没有当前会话字段）；
  //   ② 兼容旧宿主保留 currentProvideInfo 读法作回落。
  // 拿不到 = null（项目解析/预览绑定依次 fail-open，绝不猜测）。
  const getActiveSession = (): string | null => {
    try {
      const sidebarRight = ctx.get('sidebarRight') as
        | { mounted?: { getSnapshot?: () => unknown } }
        | undefined;
      const sid = sidebarRight?.mounted?.getSnapshot?.();
      if (typeof sid === 'string' && sid.length > 0) return sid;
    } catch {
      // 服务缺席（非桌面组合）：按缺失处理，走回落
    }
    const info = (
      ctx.sessions as {
        currentProvideInfo?: { getSnapshot?: () => { sessionId?: string } };
      } | undefined
    )?.currentProvideInfo?.getSnapshot?.();
    const sessionId = info?.sessionId;
    return typeof sessionId === 'string' && sessionId.length > 0 ? sessionId : null;
  };
  // 2.6 宿主通道（会话默认模型 + server 半 llm.stream，零配置）：
  // 通道即自有 RPC（/dsh-prompt-optimizer）；server half 用 agentDefaultModel 取当前
  // 会话模型、llm.stream 真流式（取自 dsh-elf 已验证的宿主服务面）。不用 session.create/
  // fork：后台会话不在前台不触发模型执行，自编 id 被静默拒绝 → 「永远正在优化」（实测）。
  const hostRpc: HostRpc = {
    call: (endpoint, payload) => callHost(endpoint, payload ?? {}),
  };
  const getHost = (): { rpc: HostRpc } => ({ rpc: hostRpc });
  const getSessionModel = async (): Promise<{ provider: string; model: string } | null> => {
    try {
      const res = await withTimeout(callHost('sessionModel', {}), 5000, 'sessionModel');
      if (res.ok && res.value && typeof res.value === 'object') {
        const v = res.value as { provider?: string; model?: string };
        if (typeof v.provider === 'string' && typeof v.model === 'string') {
          return { provider: v.provider, model: v.model };
        }
      }
      return null;
    } catch {
      return null;
    }
  };

  // 2.5b 预览窗口会话绑定：卡片只在发起会话显示（切走不跟随）
  const getSessionId = (): string | null => getActiveSession();

  // 2.7 项目优化目标（2.3.0）：按钮/卡片取「指令文本」，设置行取「完整上下文」+ 保存。
  // 存储与解析全在宿主半边（~/.dsh/prompt-optimizer-projects.json，键 = 会话头 cwd）。
  const getProjectGoalText = async (): Promise<string | null> => {
    const goal = await fetchProjectGoal(hostRpc, getActiveSession());
    return goal && goal.instruction.trim() ? goal.instruction : null;
  };

  // 2.8 上一轮对话（2.4.0）：宿主半 history 端点读这个会话最近几轮原话。
  // 会话 id 同样只认 sidebarRight.mounted（幽灵字段读法见 2.5 注释）；无会话 = 不请求。
  const getConversationContext = async () =>
    fetchConversationContext(hostRpc, getActiveSession());

  // 3. 语言镜像
  let lang: Lang = langOf(ctx.locale.getLocale().active);
  ctx.on('locale/change', (snap: { active: string }) => {
    lang = langOf(snap.active);
  });

  // 4. 会话槽位：按钮 + 预览卡片
  ctx.inject(['slots', 'sessions'], (scope) => {
    scope.slots.inject('conversation.input.right', () =>
      scope.slots.register(
        {
          name: 'conversation.input.right',
          id: 'prompt-optimizer-button',
          order: 0,
          locale: NS,
          inject: () => ({
            getConfig: () => configMirror,
            getLang: () => lang,
            getSessionModel,
            getHost,
            getSessionId,
            getProjectGoal: getProjectGoalText,
            getConversationContext,
          }),
        },
        OptimizeButton,
      ),
    );
    scope.slots.inject('conversation.input.overlay', () =>
      scope.slots.register(
        {
          name: 'conversation.input.overlay',
          id: 'prompt-optimizer-card',
          order: 10,
          locale: NS,
          inject: () => ({
            getConfig: () => configMirror,
            getLang: () => lang,
            openSettings: () => emitOpenSettingsRequest(),
            getSessionModel,
            getHost,
            getSessionId,
            getProjectGoal: getProjectGoalText,
            getConversationContext,
          }),
        },
        PreviewCard,
      ),
    );
  });

  // 6. 设置行（root 作用域）
  const settingsStore = createSettingsFormStore();
  const saveConfig = async (raw: Partial<PromptConfig>): Promise<void> => {
    const merged = mergeConfig({ ...configMirror, ...raw });
    const written: PromptConfig = {
      baseUrl: merged.baseUrl,
      apiKey: merged.apiKey.trim(),
      model: merged.model,
      useSessionModel: merged.useSessionModel,
    };
    try {
      const saved = await rpcConfig('set', {
        patch: {
          baseUrl: written.baseUrl,
          apiKey: written.apiKey,
          model: written.model,
          useSessionModel: written.useSessionModel,
        },
      });
      configMirror = mergeConfig(saved as Partial<PromptConfig> | undefined);
    } catch (error) {
      throw new Error(error instanceof Error ? error.message : String(error));
    }
  };
  const resetConfig = async (): Promise<void> => {
    try {
      const saved = await rpcConfig('set', {
        patch: {
          baseUrl: DEFAULTS.baseUrl,
          apiKey: DEFAULTS.apiKey,
          model: DEFAULTS.model,
          useSessionModel: true,
        },
      });
      configMirror = mergeConfig(saved as Partial<PromptConfig> | undefined);
    } catch (error) {
      throw new Error(error instanceof Error ? error.message : String(error));
    }
  };

  ctx.inject(['slots'], (scope) => {
    scope.slots.inject('settings.general.item', () =>
      scope.slots.register(
        {
          name: 'settings.general.item',
          id: 'prompt-optimizer-settings',
          order: 30,
          locale: NS,
          store: settingsStore,
          inject: () => ({
            getConfig: () => configMirror,
            saveConfig,
            resetConfig,
            getEpoch: () => configEpoch,
            // 项目优化目标（2.3.0）：设置行读完整上下文（含项目名/路径）并可保存/清除
            getProjectContext: () => fetchProjectGoal(hostRpc, getActiveSession()),
            saveProjectGoal: (instruction: string) => saveProjectGoal(hostRpc, getActiveSession(), instruction),
            getHostStatus: async () => {
              // 宿主通道自检：零配置模式能否从 server half 拿到当前会话模型
              try {
                const res = await withTimeout(callHost('sessionModel', {}), 5000, 'sessionModel');
                if (res.ok && res.value && typeof res.value === 'object') {
                  const v = res.value as { provider?: string; model?: string };
                  if (typeof v.provider === 'string' && typeof v.model === 'string') {
                    return { available: true, provider: v.provider, model: v.model };
                  }
                  return { available: false, error: (res.error && (res.error.details ?? res.error.code)) || 'no-model' };
                }
                return { available: false, error: (res.error && (res.error.details ?? res.error.code)) || 'rpc-failed' };
              } catch (e) {
                return { available: false, error: String((e as { message?: unknown })?.message ?? e) };
              }
            },
          }),
        },
        SettingsRow,
      ),
    );
  });

  // 7. 快捷键：Alt+O（焦点在输入控件内时等效点击优化按钮）
  const onKeydown = (e: KeyboardEvent) => {
    if (!e.altKey || e.code !== 'KeyO') return;
    const el = document.activeElement;
    const inInput =
      el instanceof HTMLTextAreaElement ||
      (el instanceof HTMLElement && (el.isContentEditable || el.closest('[data-composer-input]') !== null));
    if (!inInput) return;
    e.preventDefault();
    emitOptimizeRequest();
  };
  document.addEventListener('keydown', onKeydown);
}

// 引用守卫：避免 tree-shake 掉类型（仅文档性；无运行时行为）
export type { OptimizerActions };