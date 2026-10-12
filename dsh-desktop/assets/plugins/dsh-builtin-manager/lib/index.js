// dsh-builtin-manager — host 半边（刻意近乎为空）
//
// 这个插件的页面是纯客户端的：清单数据与启停写入都走桌面壳**已经接线好**的那条链
//   window.dshDesktop.pluginManager.list / setEnabled
//     → Tauri command dsh:plugin-list / dsh:plugin-set-enabled（契约表 ipc-commands.md）
//     → sidecar cli.js 的 createPluginManager（dsh-tauri/sidecar/cli.js）
//     → profile 的 cordis.patch.yml 里那条 "- id: <插件id>\n  name: <包名>\n  disabled: true"
//
// 所以 host 侧不再实现第二个写者。这一条是刻意的：本仓库为「两个写者改同一份用户文件」
// 付过两次学费——别名链接劫持 scoped 解析（mac 端 9 插件 failed to load 真根因）与
// 「同步确保全部在位」把用户的停用覆写掉。启停只有**一个**入口（sidecar 的
// togglePluginInPatch），页面只读它写的那份状态，就不会出现「页面显示开着、文件里写着关」。
//
// 内核自己那份插件管理面（@deepseek-ai/dsh-plugin-manager）这里也不去改：它的包级开关
// 会把名字从 dsh.profile.bundles 摘掉，而 listBundles 的行名单 = bundles ∪ dependencies ∪
// 安装锚点（内置件三处都不在），一关就从页面上消失、开不回来；条目级开关的解锁条件
// row.entryId !== void 0 又只认「当前活着的条目」，一关同样锁死。内置件要「关得掉且
// 开得回来」，就必须有一条不依赖活条目/活 bundle 的清单来源——那份来源就是 COMPANION_PLUGINS。
export const name = 'dsh-builtin-manager';

export const inject = [];

export function apply() {}
