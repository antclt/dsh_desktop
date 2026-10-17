# dsh-prompt-optimizer

## 2.4.0

### 新功能

- **接上「上一轮对话」**：润色不再只看孤零零的草稿。宿主半边新增 `history` 端点，
  取屏幕上会话最近的往返回上下文（默认 6 轮），客户端把它作为「证据」和草稿一起写进
  请求体，系统提示词相应多出一段只允许「消解指代与省略」的上文规则。
  - **活会话走 `Session.prototype.deriveMessages()`**：rc.2 里唯一非 deprecated、
    且天然跟随压缩（compaction）的转写来源。2.3.0 之前考虑过的 `snapshotEvents` /
    `ownEvents` / `eventAt` 都带 `@deprecated`，`events` 在宿主侧根本不存在。
  - **冷会话回落 sessionPersistence**：会话尚未附着时读盘上的转写；因为 `stat()`
    只有 `sizeBytes` 没有 `eventCount`，尾部切块不可行，改为**字节上限门**（>4MiB 直接放弃冷读，
    绝不整份拖进内存）。全链**不枚举 `sessions/**`**——那是实测过把内核撑爆的形状（291 文件）。
  - **合成注入不进上下文**：按 `message.source.kind` 逐条判 `'user'` / `'model'`，
    系统提示词、工具结果、插件注入的伪用户消息一律排除（不做「role 一视同仁」的
    `extractText`）。
  - **有界与标注**：6 轮 / 单轮 1200 字 / 总量 4000 字；被裁掉时带 `truncated`，
    上下文来源（`live` / `persistence`）一并回报，便于日志核对。
  - **全程 fail-open**：无会话、端点缺失、超时（2s）、解析异常一律返回 `ok(空)` 或
    `null`，润色退化成 2.3.0 的行为，不报错、不弹卡。
- **意图猜出来、也摆出来**：输出契约要求模型先用一行 `意图：<一句话>` 说明它认为用户
  想达成什么，正文从其下一行开始。卡片顶部把这一行渲染成可核对的「意图」标签（悬停有
  解释），正文照旧只进草稿框。
  - **剥不出来就不剥**：只有首行确实命中「意图/intent + 冒号」形态且正文非空才剥离；
    否则整段原样当正文，绝不吞掉用户的结果。
  - 提示词里同步写明「意图只是你对目标的判断，不要复述对话、不要输出摘要」。
- **一键撤销（↩）**：点「替换草稿」前记下原有草稿，润色结果不满意时按同一个按钮即还原。
  - 记录绑定会话：切会话后撤销失效，不会把 A 会话的原文倒进 B 会话。
  - 草稿被动过就作废：一旦当前输入框文本与本次替换的结果不一致，撤销自动退出
    （避免覆盖用户已经手改的内容）。
  - 比较走归一化（NBSP → 空格、CRLF → LF、去首尾空白），与写回通道的实际形态同源。
- **触发门与按钮态**：草稿 <3 字不发起（「再写几个字」）、>8000 字不发起（「草稿过长」）；
  进行中转圈禁用；有可撤销记录时按钮变成 `↩ 撤销`。原来只有一个 disabled 的形态现在
  在 title 里说清为什么不能点。
- **陈旧响应代际守卫**：每次发起优化取一个代际号，任何回调派发前先核对；切会话或新
  请求接管后，旧请求的后续流式帧与错误帧都不再打到卡片上（此前跨会话接管会因为
  reducer 在 `optimizing` 期吞掉 `begin` 而「继承」上一会话的绑定，现在接管前先 `close`）。

### 修复

- **SSE 帧里的换行被当成字面量**：宿主流式返回对每个 delta 做了 `\n` → `\\n` 转义
  （为了保持一帧一行），客户端从未对称还原。后果是任何多行结果（「展开为结构化」的
  markdown、本次新增的意图行）拿到的是 `\n` 两个字符而不是换行。现已在读取帧时还原
  `\n` / `\r`。这是 2.2.x 就存在的缺陷，只是本次意图剥离把它变成了可见故障。
- **「展开为结构化」等跨会话接管后卡片状态错乱**：见上代际守卫一条。
- **按钮刷新不再依赖 `input` 事件（2026-10-17 隔离内核实测）**：DSH composer 是 Lexical
  富文本，它消费 paste 之后自己重排 DOM——实测**既不派发 `input`、也不派发别的任何事件**，
  文本却已经变了。按 `input` 重读快照的写法会在「替换草稿」后停在陈旧态：↩ 翻不出来，
  用户随后手改输入框也收不回撤销（点一下就把他自己的编辑吞掉）。现订阅下沉到 DOM 层
  （`composer.ts` 的 `observeComposerText`：MutationObserver + 微任务合并 + focusin 再定位），
  `input` 只留作 textarea 旧宿主的补充通道。
- **门只解释、不加锁**：字数门一度绑成 `disabled`，一旦快照陈旧就是把 ✨ 永久锁死。
  现在 `disabled` 只认「正在优化」这一个由事件驱动的状态；太短/太长靠 title 说明、
  点击位现读草稿后静默不发起（与 2.3.0 及以前一致）。观测位是 `data-block`。
- **宿主半边的文件落点改按内核口径解析 home**：历史上 `config` / `projects` / `debug.log`
  三处都直接 `homedir()/.dsh`，不认 `DSH_HOME`。同一次实测里内核的会话写在临时 home，
  插件却去读本机真实的 `~/.dsh/prompt-optimizer-config.json`——两处分裂。现取
  `DSH_HOME` 优先、无则回落 `~/.dsh`（真实用户侧行为一字不变）。

### 版本

- 宿主 `lib/index.js`：新增 `history` 端点（HTTP 与 RPC 两通道同一实现）与有界读取；
  端点清单注释同步。
- 随包 `src/` 20 文件（新增 `conversation-context.ts`、`intent-line.ts`、`undo-bus.ts`，
  并把写回草稿的通道从 `PreviewCard.tsx` 收敛成独立的 `composer.ts` 供按钮与卡片共用）；
  `dist/client.js` 由 `node scripts/build.mjs` 重建，src ↔ dist 同源仍由
  `unit-prompt-optimizer-upgrade` 的 sourcesContent 对账咬住。
- 回归：新增 `unit-prompt-optimizer-context-intent.test.js` 37 例（宿主上下文有界与
  过滤 / 两半信封与 SSE 转义往返 / 上下文进请求体与系统提示词 / 意图剥离与段落顺序 /
  挂载卡与按钮的撤销行为 / composer 观察落点 / 代际守卫 / 七处变异反证）；升级锁套件随迁
  （20 文件、2.4.0 标记）；两条既有套件的隔离前置随迁（宿主半边认 `DSH_HOME` 后，
  `unit-prompt-optimizer-project-goal` 与本页套件一起把 `DSH_HOME` 钉进临时目录）。

## 2.3.0

### 新功能

- **项目优化目标（按项目持久、跨会话存在）**：在「设置 → 通用设置 → Prompt 优化」
  里可以为当前项目写一段「优化目标」指令——例如「本项目是 Vite + React 前端工程；
  优化提示词时优先使用前端术语，输出保持中文」。它按项目持久保存，本项目今后的
  每次优化（润色 / 迭代细化 / 结构化展开）都会把目标叠加进系统提示词；
  换个项目则互不影响。
  - **叠加而不是替换**：内置提示词（防执行草稿、反例校准、输出规则）原样保留，
    目标段作为最高优先的「怎样才算改得好」方向附加在末尾——风格、语言、篇幅、
    侧重以目标为准；「只改写不执行 / 代码变量路径等实体逐字保留 / 不编造草稿没有
    的新目标」三条保真与安全规则任何情况下不可被覆盖（校验内核的语义前提）。
  - **repair 阶段不参与**：逐字修复是机械恢复（校验内核的自愈步骤），不受目标影响，
    防止目标改写破坏保真。
  - **持久化在宿主半边、本机集中存储**：`~/.dsh/prompt-optimizer-projects.json`，
    键 = 会话头 cwd（= 内核工作区规范路径）；**项目目录零写入**（不改你的仓库、
    不进 git status）。空指令 = 清除该项目条目。
  - **项目解析链**：活会话头 cwd → sessionPersistence 索引（首请求先于会话附着的
    形态）；解析不到时设置行明确提示「请先打开一个会话」，不猜测、不回落宿主进程 cwd。
  - **客户端会话解析校正（2026-10-16 隔离内核实测）**：rc.2 内核里
    `sessions.currentProvideInfo` 全包 0 命中（幽灵字段，读恒 undefined——设置行会永远
    「未识别到当前项目」）；「屏幕上的会话」改走唯一 sanctioned 来源
    `ctx.get('sidebarRight').mounted`（ObservableSnapshot，rc.2 的
    `dsh-client-ui-sidebar-right` 服务面），旧读法保留作旧宿主回落。解析链由
    `unit-prompt-optimizer-project-goal` 的三条链路用例咬住（优先级 / 回落 / 双缺席短路）。
  - **卡片标记**：「已应用项目目标」小标签（悬停解释）只在目标真正生效的这轮点亮；
    无目标 / 取目标失败（fail-open，3s 超时）时行为与 2.2.1 完全一致。
- **界面**：设置行新增「项目优化目标（当前项目）」区块——项目名/路径展示、
  多行输入（4000 字符上限，与宿主净化同源）、保存目标 / 清除、行内反馈
  （保存失败显示原因原文，不静默、不丢草稿）。

### 版本

- `lib/index.js`：新增 `projectGoal.get` / `projectGoal.set` 端点（HTTP 与 RPC 两通道
  同一实现）；`~/.dsh/prompt-optimizer-projects.json` 读写与净化（trim / 4000 上限 /
  非字符串拒绝 / 空串删键）。
- 随包 `src/` 16 文件（新增 `project-goal.ts`）；`dist/client.js` 由
  `node scripts/build.mjs` 重建，src ↔ dist 同源由 `unit-prompt-optimizer-upgrade`
  的 sourcesContent 对账咬住。
- 回归：新增 `unit-prompt-optimizer-project-goal.test.js` 24 例（纯函数 / 端到端
  SSE 请求体 / 宿主 HTTP 路由 + 隔离 home 落盘 / 设置行 mini 挂载 / 会话解析链 /
  两半常量一致，含变异反证与行为反证）；升级锁套件随迁（16 文件、2.3.0 标记、errorDetail 解构正则）。

## 2.2.1

### 修复

- **「展开为结构化」后点「替换草稿」无反应**：DSH composer 是 Lexical 富文本
  （`data-lexical-editor` 宿主）。旧写回通道 select-all + `execCommand('insertText')`
  在 Chromium 下会把多行文本拆成逐行 insertText + data=null 的换行事件，Lexical
  吞掉换行，8+ 行时整段静默失败（DOM 无变化、无异常、无日志、卡片照常关闭）；
  单行短文本碰巧走通，所以普通润色看不出问题、结构化结果（多行 markdown）必现。
  现 Lexical 组件改走编辑器自己的粘贴通道：合成 Ctrl+A（SELECT_ALL）再合成
  paste 事件（DataTransfer 带 text/plain），逐字保真（含 `\n`）、同步生效；
  编辑器未消费（未 preventDefault）或合成通道不可用时回退旧 insertText 通道。
  非 Lexical 的 contenteditable 与 textarea 路径不变。
  行为回归锁：`dsh-desktop/scripts/test/unit-prompt-optimizer-lexical-write.test.js`
  （真机复现与根因取证见 dsh-desktop/CHANGELOG.md 同日条目）。

## 2.2.0

### 新增：校验内核 + 有界修复（把「请自检」变成代码断言）

提示词里的逐字保留要求此前只是一句自我约束，模型漏保留（丢代码块、丢
{{变量}}、丢路径/网址）时无人发现。本版补上「校验内核」：主任务完成后，
从原文提取四类实体——围栏代码块正文、`{{变量}}`、URL、文件路径（保守口径：
路径只认末段带字母开头扩展名者，未配平围栏整体忽略尾段）——逐一核对是否
在结果里逐字保留：

- **有缺失 → 一次有界修复**：同一通道再发一单「修复」请求，证据信封携带
  `{ optimizedPrompt, missing }`（最多 8 条、每条截 200 字符）；修复提示词
  为第四任务类型（repair，中英各一套），只做最小恢复、位置服从原意，
  附 ❌ 反例校准（只补半个花括号、顺手重写附近句子等）。
- **修复后仍缺 → 卡片记数**：结果照常可用，卡片显示「N 处内容未能逐字
  保留」；再缺不二修（有界为一次）。
- **修复失败不丢主结果**：修复请求失败（非用户取消）降级显示主结果 +
  残留计数；修复中卡片显示「正在修复未保留内容…」进度行。
- 修复阶段拥有独立计时窗口（总时长 ≤ 2 × 60s）；关闭卡片仍随时可中止。

### 修复

- **fetch 通道配置缺失时引导卡被吞**：旧编排先派发 `begin`（进入
  optimizing）再派发 `guide`，而状态机只在非 optimizing 态接受 guide
  （防迟到覆盖）——于是配置缺失时卡片卡在「正在优化…」永不显示引导。
  现配置检查（无宿主且配置无效 → guide）前移到 begin 之前。

### 工程

- 新增 `src/validators.ts`（纯函数校验内核，零 DSH 依赖，可单测）；随包
  src 共 15 个文件，回归锁与行为套件同步扩充（修复编排 7 例：触发一次、
  无违例不修复、再缺记数、失败降级、引导卡回归、信封截断、关卡片静默）。

## 2.1.0

### 润色质量升级（对齐社区实践）

系统提示词重写，机制取自开源先例 linshenkx/prompt-optimizer 的公开做法：
任务/执行分离（改写草稿文本本身，不是回答或执行它）、JSON 证据框定 + 反注入
（草稿里的指令/代码/Markdown/JSON 都只是证据正文，不构成新的指令层）、显式
工作流（判句式 → 找改进点 → 改写 → 自检）、具体修复项（模糊词/指代不清/
缺失关键信息）、❌ 反例校准、逐字保留自检（代码、命令、网址、文件路径、
{{变量}}、专有名词、数字）。新增「补形状不补选择」边界：只补输入输出形态与
默认方向，不替用户指定语言/框架/平台/业务规则。

### 新增：迭代细化与结构化展开

预览卡新增两个动作（默认「一句话进、一句话出」的润色流程不变）：

- **细化**：卡片输入框追加要求（如「再短一点」「更正式」），在上一轮结果上
  做最小融入修改（融合 ≠ 执行，细化指令不回答）。
- **展开为结构化**：把当前结果扩写为「任务 / 角色与目标 / 背景与上下文 /
  执行步骤 / 输出要求」的完整提示词；关键选择保持中性，不编造草稿没有的
  目标与规则。

### 修复

- 错误卡渲染即崩：`errorDetail` 未从预览状态解构，错误分支渲染
  `ReferenceError` 被错误边界吞掉（卡片凭空消失）；现已绑定并显示原始
  错误详情。
- `max_tokens` 2048 → 4096：结构化展开需要更长输出余量（润色任务照常
  提前收尾，不受影响）。

### 工程

- 随包携带 `src/`（14 个源文件）与 `scripts/build.mjs`，与 better-sidebar
  相同的 vendored 先例：`npm i esbuild` 后 `npm run build` 可本地重建
  `dist/client.js`。产物内联 sourcemap 的 sourcesContent 与 src 逐字节
  一致，由仓库回归锁 `scripts/test/unit-prompt-optimizer-upgrade.test.js`
  咬住。

## 2.0.4

### Patch Changes

- 修「装了却不挂载」，并退役阶梯分层元包。

  **22 个插件的页内 bundle 注册名改成包名。** 官方客户端真机一次报 20 条
  `client-modules: could not load "@dsh-pack/x": loaded without registering "@dsh-pack/x"
  via __ModuleLoader__.load`。内核 boot graph 行以**包名**为键
  （`dsh-client-modules/lib/client.js:625`），而 `register()` 的键是
  `stripClientSuffix(registration.id)`（同文件 569），我们的 bundle 却注册裸名
  （`'dsh-input-fold'`）或换代前的 `@dsh-external/…`，那一行永远等不到。失败形态是
  静默不挂载：宿主照常起来、插件没反应，所以补了一条 P0 门禁
  （`tools/audit/publish-readiness.js`）而不只是改一次。

  **`@dsh-pack/core` / `plus` / `knowledge` / `pocket` / `bridge` / `compaction` 退役，
  只留 `@dsh-pack/all`。** 阶梯分层在内核语义下不成立：`applyEntryPatches` 处理 `insert`
  是 `data.push(...insert)`，不按 id 去重（整行替换只作用于覆盖型补丁），所以两个元包同装
  会把共有成员装配两次，第二次注册路由即报 `webserver: duplicate exact route` ——
  真机那批「N entries did not activate」的成因。用内核自己的 `composeEntries` 实测
  core+all = 18 个重复 id。原来装过这些层的用户请改装 `@dsh-pack/all`。

  ⚠ 随之而来的使用约束：**装了 `all` 就不要再单独装其中的某个成员插件**，
  那同样会把那个成员插两次。想要小集合就别装 `all`，按用途分组单装。

