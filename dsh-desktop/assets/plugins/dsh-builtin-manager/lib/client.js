// dsh-builtin-manager — client 半边：设置页「内置插件」栏。
//
// 页面只做两件事：读 sidecar 那份内置件清单（含启用态），以及把用户的开关交给
// sidecar 写。所有文件写入都在壳侧（单一写者），所以这里不碰 cordis.patch.yml，
// 也不假装能即时生效——停用是**下次启动生效**（patch 层在内核装配期读取）。
//
// 组件刻意保持单层（不拆 Toggle 子组件）：本仓库的 client 回归夹具是「真实 React +
// 手驱钩子」的迷你挂载器，只能展开一层函数组件；拆出去就不是难测，而是测不到。
window.__ModuleLoader__.load({
  id: "dsh-builtin-manager",
  factory: (require) => {
    var module = { exports: {} };
    var exports = module.exports;
    Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });

    const react = require("react");
    const { jsx, jsxs } = require("react/jsx-runtime");

    const ZH = {
      tab: "内置插件",
      loading: "正在读取内置插件清单…",
      noBridge: "没接到桌面客户端的插件通道（页面里没有 window.dshDesktop）。"
        + "内置插件的启停由桌面客户端执行，请在 DSH Desktop 窗口里打开本页；"
        + "用浏览器直接访问内核页面时只能查看，不能修改。",
      loadFailed: "读取内置插件清单失败：",
      saveFailed: "保存失败：",
      saved: "已保存「{name}」为{state}，下次启动生效。",
      retry: "重新读取",
      empty: "清单里没有任何内置插件（随包交付门禁可能被裁过）。",
      restartNote: "停用/启用在下次启动时生效：内核在装配阶段才读取这份覆盖，本页不会改动正在运行的插件。",
      on: "启用",
      off: "停用",
      stateOn: "已启用",
      stateOff: "已停用",
      locked: "这一项由内核或交付清单管理，不能在这里改。",
      removed: "已卸载，不能在这里改。",
      configLock: "带自定义配置，禁止在此停用。",
      count: "共 {n} 条内置插件"
    };
    const EN = {
      tab: "Built-in plugins",
      loading: "Reading the built-in plugin list…",
      noBridge: "No desktop bridge on this page (window.dshDesktop is missing). Built-in plugins are "
        + "switched by the DSH Desktop shell, so open this page inside the app; a plain browser view is read-only.",
      loadFailed: "Failed to read the built-in plugin list: ",
      saveFailed: "Save failed: ",
      saved: "Saved “{name}” as {state}. Effective on next launch.",
      retry: "Reload",
      empty: "No built-in plugin in the list (the packaging gate may have trimmed it).",
      restartNote: "Switches take effect on the next launch: the patch layer is read while the kernel assembles.",
      on: "enabled",
      off: "disabled",
      stateOn: "Enabled",
      stateOff: "Disabled",
      locked: "Managed by the kernel or the delivery list; not editable here.",
      removed: "Uninstalled; not editable here.",
      configLock: "Has custom configuration, so it cannot be switched here.",
      count: "{n} built-in plugins"
    };
    // 语言每次渲染时取：页面刷新即换，不值得为它订阅字典事件。
    const dict = () => (String((typeof navigator !== "undefined" && navigator.language) || "")
      .toLowerCase().indexOf("zh") === 0 ? ZH : EN);

    const NAME = { fontWeight: 600, fontSize: 13, minWidth: 190 };
    const DESC = { fontSize: 12, opacity: .65, flex: "1 1 auto" };

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
      const [saveError, setSaveError] = react.useState("");
      const [notice, setNotice] = react.useState("");

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
        setSaveError(""); setNotice("");
        try {
          const r = await bridge.setEnabled(row.id, next);
          if (r && r.ok === false) {
            // sidecar 拒了就是拒了：状态不回写、不显示「已保存」，把原因原文请出来。
            setSaveError(String(r.error || r.message || ""));
            return;
          }
          setRows((prev) => prev.map((x) => (x.id === row.id ? { ...x, enabled: next } : x)));
          setNotice(L.saved.replace("{name}", row.name || row.id).replace("{state}", next ? L.on : L.off));
        } catch (e) {
          setSaveError(String((e && e.message) || e));
        }
      }, [bridge, L]);

      if (state === "no-bridge") {
        return jsx("section", {
          children: jsx("p", { style: { fontSize: 12, opacity: .75 }, children: L.noBridge }, "msg")
        }, "no-bridge");
      }
      if (state === "loading") return jsx("p", { children: L.loading }, "loading");

      return jsxs("section", {
        style: { display: "flex", flexDirection: "column", gap: 10 },
        children: [
          jsxs("div", {
            style: { display: "flex", alignItems: "center", gap: 10 },
            children: [
              jsx("span", { style: { fontSize: 12, opacity: .7 }, children: L.count.replace("{n}", String(rows.length)) }, "count"),
              jsx("button", { type: "button", onClick: load, style: { fontSize: 12 }, children: L.retry }, "reload")
            ]
          }, "head"),
          notice ? jsx("p", { style: { fontSize: 12, color: "#2e7d32" }, children: notice }, "notice") : null,
          loadError ? jsx("p", { style: { fontSize: 12, color: "#c62828" }, children: L.loadFailed + loadError }, "loaderr") : null,
          saveError ? jsx("p", { style: { fontSize: 12, color: "#c62828" }, children: L.saveFailed + saveError }, "saveerr") : null,
          rows.length === 0 ? jsx("p", { style: { fontSize: 12, opacity: .7 }, children: L.empty }, "empty") : null,
          rows.map((row) => {
            const locked = row.toggleable !== true || row.removed === true;
            const why = row.removed === true ? L.removed
              : (row.hasConfig === true && row.enabled === false ? L.configLock : L.locked);
            return jsxs("div", {
              style: { display: "flex", alignItems: "center", gap: 10, padding: "8px 0", borderBottom: "1px solid rgba(128,128,128,.18)" },
              children: [
                jsx("div", { style: NAME, children: row.name || row.id }, "name"),
                jsx("div", { style: DESC, children: row.description || "" }, "desc"),
                jsxs("label", {
                  style: { display: "flex", alignItems: "center", gap: 6, fontSize: 12, opacity: locked ? .55 : 1 },
                  children: [
                    jsx("input", {
                      type: "checkbox",
                      checked: row.enabled === true,
                      disabled: locked,
                      onChange: (e) => toggle(row, e.target.checked)
                    }, "sw"),
                    jsx("span", { children: locked ? why : (row.enabled ? L.stateOn : L.stateOff) }, "tx")
                  ]
                }, "toggle")
              ]
            }, row.id);
          })
          ,
          jsx("p", { style: { fontSize: 12, opacity: .65 }, children: L.restartNote }, "restart")
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
