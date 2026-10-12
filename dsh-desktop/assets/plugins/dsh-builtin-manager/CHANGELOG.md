# Changelog — dsh-builtin-manager

DSH Desktop 自研内置插件管理页（随安装包分发，登记在 `scripts/lib/companion-plugins.js`）。

## [0.1.0] - 2026-10-11

### feat：首版 —— 内置插件在界面里第一次可管

- **形态**：在「设置 → 插件」的 tab 槽（`settings.plugins.tab`，id `builtin`）里加一页
  「内置插件」，逐条列出随安装包内置的插件（名称 / 说明 / 启用态），行上给一个复选开关。
- **数据来源与写入都只有一条路**：`window.dshDesktop.pluginManager.list / setEnabled`
  → Tauri 命令 `dsh:plugin-list` / `dsh:plugin-set-enabled`（契约表 `ipc-commands.md`）
  → sidecar `createPluginManager`（`dsh-tauri/sidecar/cli.js`）
  → profile 的 `cordis.patch.yml` 里那条 `- id / name / disabled: true`。
  **插件自身不写任何文件**（host 半边是空的，且有回归锁禁止它写），避免出现第二个写者——
  本仓库为「两个写者改同一份用户文件」付过两次学费（别名链接劫持 scoped 解析、
  「同步确保全部在位」覆写用户停用）。
- **生效时机如实写明**：停用/启用在**下次启动**生效（patch 层在内核装配期读取），
  页面上明确写这一句，不做「看起来立刻生效」的假象。
- **无桥兜底**：浏览器直连内核页面（或 WSL 后端）时 `window.dshDesktop` 不存在，
  本页只说明原因、不渲染任何可写开关——可读不可写。
- **为什么不复用内核那份插件中心页**（实测结论，见 `docs/plugin-center-architecture.md` §4.7）：
  内核的两个开关都只认「当前活着的条目/选中的 bundle」。包级 `setBundleEnabled(false)` 把名字从
  `dsh.profile.bundles` 摘掉后，`listBundles` 的行名单 = `bundles ∪ dependencies ∪ 安装锚点`，
  内置件三处都不在（实测 profile `dependencies` 里内置件命中 0 条）→ 一关就从页面上消失、开不回来；
  条目级开关的解锁条件 `row.entryId !== void 0` 同样只认活条目 → 一关就锁死。
  内置件要「关得掉且开得回来」，清单来源就不能依赖运行态——所以用交付清单 `COMPANION_PLUGINS`。
- **验证**：`scripts/test/unit-builtin-manager-client.test.js` 8 例（模块契约 / normalize
  形状与剔除 + 阳性对照 / 渲染与置灰 / 成功与失败两条写路径 / 无桥兜底 / 包面 id 同源 /
  两条反证）；`scripts/test/unit-companion-disable-override.test.js` 4 例（停用块活过 boot 登记
  逐条全量 / 纯登记块必须被删的反证 / toggle→登记→再 toggle 串测 / 卸载行为停用行超集）；
  真沙箱端到端：`sidecar boot` 五步全绿 → 插件镜像进 profile 并进 `bundles` →
  `plugin-set-enabled … 0` → **再 boot 一次 `disabled: true` 原样在位**（拉锯消失）。
