// dsh-builtin-manager — client 半边：设置页「内置插件」栏。
//
// 0.2.0 重做（用户裁定「搜索+筛选+单列表」）—— 交互与视觉同时回炉：
//   1. 工具栏：搜索框（名称/标识/描述）+「重新读取」；状态筛选（全部/已启用/已停用）带计数，
//      计数与列表同源（都从 rows 现算），筛选后另给「当前显示 M 条」——数字不会互相说谎。
//   2. 单列表卡片行：名称 + 状态 Tag + 描述（两行截断，悬停看全文）+ 行尾开关。
//      写入成功给行下一条反馈 +「已改动 · 下次启动生效」标记；写入失败不翻转行状态、
//      原因原文落在行下（行内反馈，不再把全页提示顶在列表上方互相盖）。
//   3. 全套内核设计系统原语（Button/Switch/SegmentedControl/Input/Tag + 官方图标），
//      颜色与圆角走 --dsw-* 变量 —— 与「内置插件」等既有设置页同语言，不再是自绘 checkbox。
//
// 页面只做两件事：读 sidecar 那份内置件清单（含启用态），以及把用户的开关交给
// sidecar 写。所有文件写入都在壳侧（单一写者），所以这里不碰 cordis.patch.yml，
// 也不假装能即时生效——停用是**下次启动生效**（patch 层在内核装配期读取）。
//
// 组件刻意保持单层（不拆子组件）：本仓库的 client 回归夹具是「真实 React +
// 手驱钩子」的迷你挂载器，只能展开一层函数组件；拆出去就不是难测，而是测不到。
// note()/normalize() 是纯函数，不进组件树，随便放。
window.__ModuleLoader__.load({
  id: "dsh-builtin-manager",
  factory: (require) => {
    var module = { exports: {} };
    var exports = module.exports;
    Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });

    const react = require("react");
    const { jsx, jsxs } = require("react/jsx-runtime");
    // 内核设计系统原语（与 dsh-prompt-custom 等伴随插件同款引入姿势：顶部一次性引入）。
    const {
      Button, Input, SegmentedControl, Switch, Tag,
      IconRefreshOutlineRegular, IconSearchOutlineRegular
    } = require("@deepseek-ai/dsh-client-ui-primitives");

    const ZH = {
      tab: "内置插件",
      loading: "正在读取内置插件清单…",
      noBridge: "没接到桌面客户端的插件通道（页面里没有 window.dshDesktop）。"
        + "内置插件的启停由桌面客户端执行，请在 DSH Desktop 窗口里打开本页；"
        + "用浏览器直接访问内核页面时只能查看，不能修改。",
      loadFailed: "读取内置插件清单失败：",
      saveFailed: "保存失败：",
      saved: "已保存「{name}」为{state}。",
      saving: "正在保存…",
      retry: "重新读取",
      searchAria: "搜索内置插件",
      searchPlaceholder: "搜索名称、标识或描述",
      filterLabel: "按状态筛选",
      filterAll: "全部 {n}",
      filterOn: "已启用 {n}",
      filterOff: "已停用 {n}",
      count: "共 {n} 条内置插件",
      countShown: "共 {n} 条内置插件 · 当前显示 {m} 条",
      noneMatch: "没有匹配的内置插件——换个关键词，或把筛选切回「全部」。",
      empty: "清单里没有任何内置插件（随包交付门禁可能被裁过）。",
      restartNote: "改动会立刻写进配置：本页与界面里的插件视图刷新页面即更新（实测：停用后重载就读不到这条了），"
        + "插件的内核半边则在下次启动生效。",
      on: "启用",
      off: "停用",
      stateOn: "已启用",
      stateOff: "已停用",
      changed: "已改动 · 下次启动生效",
      switchLabel: "切换「{name}」的启用状态",
      locked: "这一项由内核或交付清单管理，不能在这里改。",
      removed: "已卸载，不能在这里改。",
      configLock: "带自定义配置，禁止在此停用。",
      selfLock: "这是本管理页自己：停用后这条唯一的内置插件开关面就跟着消失，界面上再也开不回来，所以不能在这里关。"
    };
    const EN = {
      tab: "Built-in plugins",
      loading: "Reading the built-in plugin list…",
      noBridge: "No desktop bridge on this page (window.dshDesktop is missing). Built-in plugins are "
        + "switched by the DSH Desktop shell, so open this page inside the app; a plain browser view is read-only.",
      loadFailed: "Failed to read the built-in plugin list: ",
      saveFailed: "Save failed: ",
      saved: "Saved “{name}” as {state}.",
      saving: "Saving…",
      retry: "Reload",
      searchAria: "Search built-in plugins",
      searchPlaceholder: "Search name, id or description",
      filterLabel: "Filter by state",
      filterAll: "All {n}",
      filterOn: "Enabled {n}",
      filterOff: "Disabled {n}",
      count: "{n} built-in plugins",
      countShown: "{n} built-in plugins · showing {m}",
      noneMatch: "No matching built-in plugin — try another keyword or switch the filter back to All.",
      empty: "No built-in plugin in the list (the packaging gate may have trimmed it).",
      restartNote: "The change is written to the config at once: this page and the in-page plugin views update on reload, "
        + "while each plugin's host half takes effect on the next launch.",
      on: "enabled",
      off: "disabled",
      stateOn: "Enabled",
      stateOff: "Disabled",
      changed: "Changed · takes effect on next launch",
      switchLabel: "Toggle “{name}”",
      locked: "Managed by the kernel or the delivery list; not editable here.",
      removed: "Uninstalled; not editable here.",
      configLock: "Has custom configuration, so it cannot be switched here.",
      selfLock: "This is the manager page itself. Switching it off also removes the only built-in plugin switch surface, "
        + "and the UI can no longer turn it back on, so it cannot be disabled here."
    };
    // 语言每次渲染时取：页面刷新即换，不值得为它订阅字典事件。
    const dict = () => (String((typeof navigator !== "undefined" && navigator.language) || "")
      .toLowerCase().indexOf("zh") === 0 ? ZH : EN);

    // 与本包 cordis.patch.yml 的 loader id、sidecar 行 id 同值（回归测试咬三方一致）。
    const SELF = "dsh-builtin-manager";

    // 颜色与圆角全走内核设计系统变量（--dsw-*）。
    const S = {
      root: { display: "flex", flexDirection: "column", gap: 12, minWidth: 0 },
      toolbar: { display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" },
      // grid 包裹是为了让原语的 inline-flex 外框被拉伸到可用宽度（flex 项的内容宽度默认收在 240）。
      search: { flex: "1 1 240px", minWidth: 200, display: "grid" },
      filterRow: { display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap" },
      hint: { fontSize: 12, lineHeight: "18px", color: "var(--dsw-alias-label-tertiary)" },
      list: { display: "flex", flexDirection: "column", gap: 8, minWidth: 0 },
      card: {
        display: "flex", alignItems: "flex-start", gap: 12,
        padding: "10px 12px",
        border: "1px solid var(--dsw-alias-border-l2)",
        borderRadius: "var(--dsw-radius-md)",
        background: "var(--dsw-alias-bg-layer-2)"
      },
      body: { flex: "1 1 auto", minWidth: 0, display: "flex", flexDirection: "column", gap: 4 },
      nameRow: { display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" },
      name: { fontWeight: 600, fontSize: 13, lineHeight: "20px", color: "var(--dsw-alias-label-primary)", wordBreak: "break-all" },
      desc: {
        fontSize: 12, lineHeight: "18px", color: "var(--dsw-alias-label-secondary)",
        display: "-webkit-box", WebkitLineClamp: 2, WebkitBoxOrient: "vertical", overflow: "hidden"
      },
      note: { fontSize: 12, lineHeight: "18px", whiteSpace: "pre-wrap", wordBreak: "break-word" },
      switchWrap: { paddingTop: 2, flex: "0 0 auto" }
    };

    // 行内反馈/说明共用的文字块：ok=成功（绿）、error=失败原文（红）、muted=说明。
    function note(text, tone) {
      return jsx("div", {
        style: Object.assign({}, S.note, {
          color: tone === "error" ? "var(--dsw-alias-label-error)"
            : (tone === "ok" ? "var(--dsw-alias-state-success-primary)"
              : "var(--dsw-alias-label-tertiary)")
        }),
        children: text
      });
    }

    // 桥返回的形状既可能是裸数组，也可能是 {plugins:[...]}，两种都收；
    // 只留在册内置件（group==='companion'），坏行直接丢——清单不全是页面不能整页炸。
    function normalize(rows) {
      const list = Array.isArray(rows) ? rows : (rows && Array.isArray(rows.plugins) ? rows.plugins : []);
      return list
        .filter((r) => r && typeof r === "object" && typeof r.id === "string")
        .filter((r) => r.group === "companion");
    }

    function PanelSection() {
      const L = dict();
      const bridge = (typeof window !== "undefined" && window.dshDesktop && window.dshDesktop.pluginManager) || null;
      const [rows, setRows] = react.useState([]);
      const [state, setState] = react.useState(bridge ? "loading" : "no-bridge");
      const [loadError, setLoadError] = react.useState("");
      // 三张按行 id 索引的过程态表：行内反馈（成功/失败/在途）、写入在途、本次会话改过。
      const [notes, setNotes] = react.useState({});
      const [busy, setBusy] = react.useState({});
      const [changed, setChanged] = react.useState({});
      const [query, setQuery] = react.useState("");
      const [filter, setFilter] = react.useState("all");

      const load = react.useCallback(async () => {
        if (!bridge) { setState("no-bridge"); return; }
        setState("loading"); setLoadError("");
        try {
          const list = normalize(await bridge.list());
          setRows(list);
          setState(list.length === 0 ? "empty" : "ready");
        } catch (e) {
          setLoadError(String((e && e.message) || e));
          setState("failed");
        }
      }, [bridge]);

      react.useEffect(() => { load(); }, [load]);

      const toggle = react.useCallback(async (row, next) => {
        if (!bridge) return;
        setNotes((prev) => ({ ...prev, [row.id]: { text: L.saving, tone: "muted" } }));
        setBusy((prev) => ({ ...prev, [row.id]: true }));
        try {
          const r = await bridge.setEnabled(row.id, next);
          if (r && r.ok === false) {
            // sidecar 拒了就是拒了：状态不回写、不显示「已保存」，把原因原文请出来。
            setNotes((prev) => ({ ...prev, [row.id]: { text: L.saveFailed + String(r.error || r.message || ""), tone: "error" } }));
            return;
          }
          setRows((prev) => prev.map((x) => (x.id === row.id ? { ...x, enabled: next } : x)));
          setChanged((prev) => ({ ...prev, [row.id]: true }));
          setNotes((prev) => ({ ...prev, [row.id]: {
            text: L.saved.replace("{name}", row.name || row.id).replace("{state}", next ? L.on : L.off),
            tone: "ok"
          } }));
        } catch (e) {
          setNotes((prev) => ({ ...prev, [row.id]: { text: L.saveFailed + String((e && e.message) || e), tone: "error" } }));
        } finally {
          setBusy((prev) => { const n = { ...prev }; delete n[row.id]; return n; });
        }
      }, [bridge, L]);

      if (state === "no-bridge") {
        return jsx("section", {
          children: jsx("p", { style: { fontSize: 12, opacity: .75 }, children: L.noBridge }, "msg")
        }, "no-bridge");
      }
      if (state === "loading") return jsx("p", { children: L.loading }, "loading");

      const q = query.trim().toLowerCase();
      const shown = rows.filter((row) => {
        if (filter === "on" && row.enabled !== true) return false;
        if (filter === "off" && row.enabled === true) return false;
        if (q === "") return true;
        return [row.name, row.id, row.description].some((v) => String(v || "").toLowerCase().indexOf(q) !== -1);
      });
      const enabledCount = rows.filter((r) => r.enabled === true).length;
      const anyBusy = Object.keys(busy).length > 0;
      const filterOptions = [
        { value: "all", label: L.filterAll.replace("{n}", String(rows.length)) },
        { value: "on", label: L.filterOn.replace("{n}", String(enabledCount)) },
        { value: "off", label: L.filterOff.replace("{n}", String(rows.length - enabledCount)) }
      ];
      const countText = shown.length === rows.length
        ? L.count.replace("{n}", String(rows.length))
        : L.countShown.replace("{n}", String(rows.length)).replace("{m}", String(shown.length));

      return jsxs("section", {
        style: S.root,
        children: [
          jsxs("div", {
            style: S.toolbar,
            children: [
              jsx("div", {
                style: S.search,
                children: jsx(Input, {
                  type: "search",
                  value: query,
                  disabled: state !== "ready",
                  placeholder: L.searchPlaceholder,
                  "aria-label": L.searchAria,
                  icon: jsx(IconSearchOutlineRegular, {}),
                  onChange: (e) => setQuery(e.target.value)
                }, "input")
              }, "search"),
              jsx(Button, {
                variant: "ghost",
                size: "sm",
                icon: jsx(IconRefreshOutlineRegular, {}),
                disabled: anyBusy,
                title: L.retry,
                onClick: load,
                children: L.retry
              }, "reload")
            ]
          }, "toolbar"),
          state === "failed" ? note(L.loadFailed + loadError, "error") : null,
          state === "empty" ? note(L.empty, "muted") : null,
          state === "ready" ? jsxs("div", {
            style: S.filterRow,
            children: [
              jsx(SegmentedControl, {
                id: "dsh-builtin-manager-filter",
                value: filter,
                options: filterOptions,
                label: L.filterLabel,
                onChange: (v) => setFilter(v)
              }, "filter"),
              jsx("span", { style: S.hint, children: countText }, "count")
            ]
          }, "filters") : null,
          state === "ready" && rows.length > 0 && shown.length === 0 ? note(L.noneMatch, "muted") : null,
          state === "ready" && shown.length > 0 ? jsx("div", {
            style: S.list,
            children: shown.map((row) => {
              // 本管理页自己必须锁死：停用它就把这条唯一的内置件开关面一起关掉，界面上开不回来
              // （实测：写进 disabled 之后页面重载就读不到这条了，不必等下次启动）。
              const self = row.id === SELF;
              const locked = self || row.toggleable !== true || row.removed === true;
              const why = self ? L.selfLock
                : (row.removed === true ? L.removed
                  : (row.hasConfig === true && row.enabled === false ? L.configLock : L.locked));
              const rowBusy = busy[row.id] === true;
              const rowNote = notes[row.id];
              return jsxs("div", {
                "data-plugin-id": row.id,
                style: S.card,
                children: [
                  jsxs("div", {
                    style: S.body,
                    children: [
                      jsxs("div", {
                        style: S.nameRow,
                        children: [
                          jsx("span", { style: S.name, children: row.name || row.id }, "name"),
                          jsx(Tag, {
                            tone: row.enabled === true ? "success" : "neutral",
                            children: row.enabled === true ? L.stateOn : L.stateOff
                          }, "state"),
                          changed[row.id] ? jsx(Tag, { tone: "warning", children: L.changed }, "changed") : null
                        ]
                      }, "head"),
                      row.description ? jsx("div", { style: S.desc, title: row.description, children: row.description }, "desc") : null,
                      locked ? note(why, "muted") : null,
                      rowNote ? note(rowNote.text, rowNote.tone) : null
                    ]
                  }, "body"),
                  jsx("div", {
                    style: S.switchWrap,
                    children: jsx(Switch, {
                      checked: row.enabled === true,
                      disabled: locked || rowBusy,
                      label: L.switchLabel.replace("{name}", row.name || row.id),
                      title: locked ? why : undefined,
                      onChange: (next) => toggle(row, next)
                    }, "switch")
                  }, "switch")
                ]
              }, row.id);
            })
          }, "list") : null,
          note(L.restartNote, "muted")
        ]
      }, "panel");
    }

    function apply(ctx) {
      ctx.slots.inject("settings.plugins.tab", () => ctx.slots.register({
        name: "settings.plugins.tab",
        id: "builtin",
        order: 20,
        label: () => dict().tab
      }, (props) => jsx(PanelSection, props)));
    }

    const inject = ["slots"];
    exports.apply = apply;
    exports.inject = inject;
    return module.exports;
  }
});
