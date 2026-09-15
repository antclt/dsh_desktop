# 0.1.5-rc.2 → 0.1.6-alpha.1 内核升级冲击评估（0.6.5 M1 输入）

> 评估日期：2026-09-15。方法：官方仓库双 tag 浅克隆（dsh-v0.1.5-rc.2 ↔ dsh-v0.1.6-alpha.1）
> 树级 diff（3942 文件，+784113/-47018 行）× 包集合枚举（302 workspace 成员）×
> 桌面 64 条 PATCH_SPECS / 38 个 file 目标源级代理判定（lib/*.js → src/*.ts 反查）。
> 侦察脚本：`.tmp-recon-016.cjs`（包集合差集）/ `.tmp-recon-patchmap2.cjs`（红黄区）。

## 1. 版本事实

- 新内核 tag：`dsh-v0.1.6-alpha.1`（2026-09-15 04:57 UTC 发布，prerelease，GitHub release 无
  资产 tarball——与 rc.2 同惯例，采集走源码构建 `pnpm pack`）。
- npm 侧 `@deepseek-ai/dsh@0.1.6-alpha.1` 已存在（官方 CLI 发布线，与本离线 vendor 线并行）。
- 当前 pin：`dsh-v0.1.5-rc.2`（exact 策略，禁止浮动）。

## 2. 发布内容概要（官方 notes 摘译）

新增：Web 侧边栏终端（多标签）、设置-已归档会话列表、MCP resources/URI 模板（MCP SDK v2、
工具分页）、Headless stdin/--session-id/--json、SSH 远端工作区、Browser Use（实验）、
Computer Use（实验）、Auto review（实验）、DeepSeek V4.1 图片缩放/Token 估算适配、
Node PTC `run_code` 按次超时（默认 120s 上限 600s）。
修复：会话排序、按轮次分叉、PTC 提示词双花括号误替换等。

## 3. 包集合变化（302 vs 259：保留 253 / 新增 49 / 移除 6）

### 3.1 新增 49（按族归类）

| 族 | 包 | 桌面影响 |
|---|---|---|
| **SSH 远端工作区** | dsh-ssh / dsh-fs-ssh / dsh-sandbox-ssh / dsh-subprocess-ssh | 新能力，四件套 |
| **PTC runtime**（接替 code-runtime） | dsh-ptc-runtime / -node / experimental-ptc-runtime-python / dsh-workflow-ptc | **code-runtime 家族退役的接替者** |
| **Browser Use（实验）** | dsh-browser-use + experimental-browser-use-{playwright-mcp, chrome-devtools-mcp, stagehand-native, runtime} | 5 包 |
| **Computer Use（实验）** | dsh-computer-use + experimental-computer-use-{cua-driver-mcp, cua-driver-native} | 3 包 |
| **Agent Team（实验）** | experimental-agent-team{-profile,-web-profile} + experimental-{client-ui,tool}-agent-team | 5 包 |
| **其他实验** | experimental-auto-review / -inspector / -webworker-{packer,runtime} | 4 包 |
| **MCP resources** | dsh-mcp-resources | 1 包 |
| **终端 API** | dsh-api-terminal-controller | 1 包（Web 终端新特性的 API 面） |
| **客户端 UI 新槽** | client-ui-{dockkit, sidebar-terminal, settings-unarchive-sessions} | 3 包 |
| **压缩** | dsh-compaction-image-offload | 1 包 |
| **杂项** | dsh-remote-mock | 1 包 |
| **vendored 第三方收编** | @deepseek-ai/cordis@4.0.2 / cosmokit@1.8.3 / schemastery@3.18.2 / cordis-plugin-{group,hmr,include,loader,logger-console,timer} | **9 包——cordis 生态收编进 vendor**（0.6.4 时代是外部 npm 依赖） |
| **node-addon-system** | node-addon-system{,-darwin-arm64,-darwin-x64,-linux-arm64,…} @0.1.2（1 private） | Landlock 启动器的平台原生件 |

### 3.2 移除 6

| 包 | 说明 |
|---|---|
| dsh-code-runtime / dsh-code-runtime-worker-thread | **JS code-runtime 退役**，由 PTC runtime 接替（run_code 按次超时） |
| dsh-e2b / dsh-fs-e2b / dsh-subprocess-e2b | E2B 云沙箱三件套移除 |
| dsh-workflow-worker-thread | workflow worker 退役（并入 workflow-ptc） |

### 3.3 桌面 services 面影响

- pin.json `services.required` 13 项**无一直接除名**；但 `code-runtime` 家族若被任何伴随
  插件引用（如 compaction-acp 的压缩链路）需在 M2 排查引用面。
- pin.json `services.removed` 建议追加：`code-runtime`（0.1.6-alpha.1 退役，PTC 接替）、
  `e2b`（同批移除）。

## 4. 补丁目标冲击判定（38 file 目标）

**红区 17（源 index/client.ts 被改 → 构建产物锚点可能漂移，M2 重校准主战场）：**
dsh-agent-presets、dsh-api-gateway、dsh-api-session-controller、dsh-app-boot、
dsh-attachment-local、dsh-client-ui-chat、dsh-client-ui-conversation、
dsh-client-ui-workspace、dsh-host-directory-picker-auto、dsh-llm-deepseek、dsh-llm、
dsh-skill-filesystem、dsh-system-prompt、dsh-terminal-bash、dsh-tool-bash、
dsh-tool-pwsh、dsh-tools。

**黄区 14（源未改 → 产物大概率字节不变，补丁预期直接生效；M2 仍需运行期复验）：**
dsh-agent-presets/invariant、dsh-api-session-controller/client、dsh-api-settings-controller、
dsh-client-ui-settings-plugins、**dsh-client-ui-slots**、dsh-cordis-client-runner、
dsh-credentials-local、**dsh-session-format-v0-to-v1**、**dsh-session-persistence-jsonl**、
**dsh-session-persistence**、dsh-settings、dsh-subagent-claude-code、
dsh-tool-bash-persistent、dsh-tool-pwsh-persistent。

**外包 7（随自身版本/构建走，不在 harness tag 冲击面）：**
@deepseek-ai/dsh-llm-pi-ai、@earendil-works/pi-ai ×3（配额/工具名/Responses 补丁的靶——
注意 pi-ai 升级与 harness tag 解耦，锁版本即安全）、@openai/codex、
cordis-plugin-loader（**升级后属 vendored 收编族，需确认加载器行为变化**）、
dsh-web-frontend/dist/index.html（compat 构建输入，M2 重新产出）。

**高优修复重靶的意外好消息**：rc.1 重校准的高优三靶——session-persistence-jsonl
（会话头扫描+TTL）、session-persistence、session-format-v0-to-v1——**源级全部未改**，
预判零重锚（运行期仍须复验）。

## 5. 风险分级与 M2 执行顺序建议

1. **红（先攻）**：dsh-llm / dsh-llm-deepseek（58 文件变更族）、
   dsh-api-session-controller（35）、dsh-client-ui-conversation（48）、
   dsh-client-ui-workspace（15）、dsh-tools / dsh-tool-bash / dsh-tool-pwsh（工具域）。
2. **黄（复验即过预期）**：session 三靶 + slots + runner + credentials-local。
3. **结构性新工作**：① code-runtime→PTC 迁移面排查；② vendored cordis 收编后
   `cordis-plugin-loader` 补丁的靶包归属核对（loader 是否进 vendor 采集清单）；
   ③ 新增 49 包的 vendor 采集面扩大（259→~300 tarball 量级）；④ node-addon-system
   平台原生件对 Windows 采集的影响（darwin/linux 件在 win 机器 pack 无碍，按清单全收）。
4. **发布节奏判断**：0.1.6-alpha.1 是首	alpha（破坏性变更随时发生），建议 0.6.5 遵循
   exact pin + alpha 适配先行验证（同 0.1.5-rc.1 先例），等 rc 线再出正式版。

## 6. M1 产出与 M2 输入

- 评估文档：本文。
- 侦察脚本：`.tmp-recon-016.cjs`（包集合差集）、`.tmp-recon-patchmap2.cjs`（红黄区，
  含 lib→src 源级代理判定）。
- 源码克隆：`%TEMP%/harness-016a1`（dsh-v0.1.6-alpha.1 + rc2 tag，供 M2 深挖）。
