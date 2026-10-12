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
- **生效时机如实写明（2026-10-12 在真内核页面上实测后校正）**：改动**立刻写入** patch 层；
  界面这一侧**重载页面即更新**（客户端半边由「当前活动的 loader 条目」门控——实测停用本页自己之后
  重载页面就读不到这条 tab 了），插件的内核半边才等下次启动。页面按这两层分别措辞，
  不写一刀切的「下次启动生效」。
- **自己那一行锁成不可停用**：既然关掉本页会连开关面一起收掉，而它是唯一能改回来的界面，
  放它停用等于一次性销毁自己。`lib/client.js` 以 `SELF` 常量识别本行并给出原因（`selfLock` 文案）；
  `SELF` ↔ bundle 层 loader id ↔ 在册清单行 id 三方同源由测试咬住，守卫摘掉后的变形由「反证 3」锁住。
- **无桥兜底**：浏览器直连内核页面（或 WSL 后端）时 `window.dshDesktop` 不存在，
  本页只说明原因、不渲染任何可写开关——可读不可写。
- **为什么不复用内核那份插件中心页**（实测结论，见 `docs/plugin-center-architecture.md` §4.7）：
  内核的两个开关都只认「当前活着的条目/选中的 bundle」。包级 `setBundleEnabled(false)` 把名字从
  `dsh.profile.bundles` 摘掉后，`listBundles` 的行名单 = `bundles ∪ dependencies ∪ 安装锚点`，
  内置件三处都不在（实测 profile `dependencies` 里内置件命中 0 条）→ 一关就从页面上消失、开不回来；
  条目级开关的解锁条件 `row.entryId !== void 0` 同样只认活条目 → 一关就锁死。
  内置件要「关得掉且开得回来」，清单来源就不能依赖运行态——所以用交付清单 `COMPANION_PLUGINS`。
- **验证**：`scripts/test/unit-builtin-manager-client.test.js` 10 例（模块契约 / normalize
  形状与剔除 + 阳性对照 / 渲染与置灰 / 成功与失败两条写路径 / 自锁与生效时机 / 无桥兜底 /
  包面 id 与 `SELF` 三方同源 / 三条反证）；
  `scripts/test/unit-companion-disable-override.test.js` 4 例（停用块活过 boot 登记
  逐条全量 / 纯登记块必须被删的反证 / toggle→登记→再 toggle 串测 / 卸载行为停用行超集）；
  真沙箱端到端：`sidecar boot` 五步全绿 → 插件镜像进 profile 并进 `bundles` →
  `plugin-set-enabled … 0` → **再 boot 一次 `disabled: true` 原样在位**（拉锯消失）。
  2026-10-12 补真机一轮：`stage-payload` → `smoke-installed`（PASS，29 个插件目录进包、
  内置件镜像进 profile、page-error 0）→ 手动续跑壳不杀 → 浏览器开内核页，
  「设置 → 内置插件」里本页真实挂载并渲染；桩桥下逐条行状态、置灰原因、
  `setEnabled(id, enabled)` 调用参数与「已保存」提示全部按预期；写路径用同一条
  `plugin-set-enabled … 0/1` 在隔离 profile 上往返核对（写入块与回收块逐字对齐）。
