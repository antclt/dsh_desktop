//! N2 对抗验收：会话监视线（active_turns / 退避 / 收割）边界测试。
//!
//! 2026-10-22 起壳层「回合完成」通知链已下线（通知改由内置插件 dsh-notify
//! 在渲染进程发送），本文件只保留监视线相关面：会话 ID 校验、重启退避、
//! 接线形态、子进程安全形态、JS 发射器保真锚点。
//!
//! N1 的 `session_notify` 模块目前是 `mod session_notify;`（私有），tests/
//! 集成测试无法经 `dsh_tauri_app::` 访问其 pub 纯函数——因此这里用 `#[path]`
//! 把同一份源文件**只读编入**本测试 crate（字节相同 = 测的就是实现），并为
//! 其中 `crate::` 引用提供最小垫片。

// 垫片类型仅满足被编入模块的编译，不构造使用。
#![allow(dead_code)]

// N1 的实现源，只读编入（字节一致，非复制粘贴）。
#[path = "../src/session_notify.rs"]
mod session_notify_live;

// ---------------------------------------------------------------------------
// session_notify.rs 内 `crate::` 引用的最小垫片（仅满足编译，不参与断言）
// ---------------------------------------------------------------------------

use std::path::PathBuf;
use std::sync::Mutex;

pub struct SupervisorShim {
    pub node_exe: PathBuf,
    pub app_dir: PathBuf,
}

/// 与真实 AppState 字段面同构（session_notify 只用到这三个字段）。
pub struct AppState {
    pub supervisor: Mutex<Option<std::sync::Arc<SupervisorShim>>>,
    pub current_session: Mutex<Option<String>>,
    pub paths: shell_core::DshPaths,
}

pub mod commands {
    /// creation_flags_no_window 垫片（真实实现在 commands/common.rs）。
    pub trait NoWindow {
        fn creation_flags_no_window(&mut self) -> &mut Self;
    }

    #[cfg(windows)]
    impl NoWindow for std::process::Command {
        fn creation_flags_no_window(&mut self) -> &mut Self {
            use std::os::windows::process::CommandExt;
            const CREATE_NO_WINDOW: u32 = 0x0800_0000;
            self.creation_flags(CREATE_NO_WINDOW);
            self
        }
    }

    #[cfg(not(windows))]
    impl NoWindow for std::process::Command {
        fn creation_flags_no_window(&mut self) -> &mut Self {
            self
        }
    }
}

pub mod supervisor {
    /// 路由层日志垫片：丢弃（测试进程不写 desktop.log）。
    pub fn file_log(_msg: &str) {}
}

/// 退出闸门垫片：测试进程不模拟生产退出态（恒 false）。
pub fn is_exiting() -> bool { false }

// ---------------------------------------------------------------------------
// 会话 ID 校验（行协议/垫片同款：trim 非空、≤256 字节）
// ---------------------------------------------------------------------------

#[test]
fn session_id_boundaries() {
    use session_notify_live::{valid_session_id, MAX_SESSION_ID_LEN};
    assert_eq!(MAX_SESSION_ID_LEN, 256);
    assert!(valid_session_id("abc"));
    assert!(valid_session_id("  abc  "), "首尾空白可 trim");
    assert!(!valid_session_id("   "));
    assert!(!valid_session_id(""));
    let exact = "x".repeat(256);
    assert!(valid_session_id(&exact), "恰 256 放");
    assert!(!valid_session_id(&format!("{}x", exact)), "257 拦");
}

/// 重启退避：1s→2s→…→60s 封顶（纯函数）。
#[test]
fn restart_backoff_progression() {
    use session_notify_live::restart_backoff_ms;
    let mut prev = 0;
    for n in 1..=64 {
        let ms = restart_backoff_ms(n);
        assert!(ms >= prev && ms <= 60_000, "单调不减且封顶 60s：n={n} ms={ms}");
        prev = ms;
    }
    assert_eq!(restart_backoff_ms(1), 1_000);
    assert_eq!(restart_backoff_ms(7), 60_000);
    assert_eq!(restart_backoff_ms(1_000), 60_000, "恒封顶");
}

// ---------------------------------------------------------------------------
// 接线形态锚点（lib.rs / bridge-shim.js / session-watcher.js）
// ---------------------------------------------------------------------------

fn read_norm(p: &str) -> String {
    let full = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join(p);
    std::fs::read_to_string(&full)
        .unwrap_or_else(|_| panic!("读不到 {}", full.display()))
        .replace("\r\n", "\n")
}

/// lib.rs 接线：模块声明 / KernelReady 启动 / 退出收割；通知链已下线
/// （不得再出现聚焦路由与发射调用）。
#[test]
fn lib_wiring_anchors() {
    let lib = read_norm("src/lib.rs");
    assert!(lib.contains("mod session_notify;"), "模块声明");
    assert!(
        lib.contains("session_notify::start_watcher(app.clone());"),
        "KernelReady 后启动（Electron main.js:6337 同点位）"
    );
    assert!(
        !lib.contains("session_notify::on_main_window_focused("),
        "通知跳转兜底已下线，lib.rs 不得再路由聚焦事件"
    );
    // 退出收割：ExitRequested 与 Exit 两个分支都要挂（std::process::exit 不跑 Drop）。
    // 锚点必须是代码形态（`tauri::RunEvent::...`）——注释里提到同名事件不该参与切段。
    let xreq = lib
        .split("tauri::RunEvent::ExitRequested {")
        .nth(1)
        .and_then(|s| s.split("tauri::RunEvent::Exit =>").next())
        .unwrap_or("");
    assert!(xreq.contains("session_notify::shutdown_watcher();"), "ExitRequested 收割");
    let exit_seg = lib
        .split("tauri::RunEvent::Exit =>")
        .nth(1)
        .and_then(|s| s.split("_ => {}").next())
        .unwrap_or("");
    assert!(exit_seg.contains("session_notify::shutdown_watcher();"), "Exit 收割");
}

/// 监视线消费面：只把行喂给 parse_turn_activity，不得再解析 turn-end 通知。
#[test]
fn watcher_loop_only_tracks_turn_activity() {
    let src = read_norm("src/session_notify.rs");
    assert!(
        src.contains("parse_turn_activity(&line)"),
        "行协议必须驱动 active_turns（issue #159 假死豁免）"
    );
    for gone in [
        "fn fire_notification",
        "fn request_main_window_attention",
        "fn notification_text",
        "struct NotifyThrottle",
        "static PENDING_JUMP",
    ] {
        assert!(!src.contains(gone), "通知链残留：{gone}");
    }
}

/// watcher 子进程安全形态：CREATE_NO_WINDOW + stdin 保活 + CLI 参数。
#[test]
fn watcher_spawn_safety_anchors() {
    let src = read_norm("src/session_notify.rs");
    let seg = src
        .split("fn spawn_watcher_process")
        .nth(1)
        .and_then(|s| s.split("\n}").next())
        .expect("spawn_watcher_process 函数体");
    assert!(seg.contains(".creation_flags_no_window()"), "抑制终端窗");
    assert!(seg.contains(".stdin(Stdio::piped())"), "stdin 保活管道");
    assert!(seg.contains("--sessions-dir"), "CLI 协议参数");

    // JS 侧防孤儿：stdin end/close 自退 + Electron 导出面零变化。
    let js = read_norm("../../../../dsh-desktop/session-watcher.js");
    assert!(js.contains("require.main === module"), "CLI 守卫（require 路径不受影响）");
    assert!(js.contains("process.stdin.resume()"), "stdin 保活");
    assert!(js.contains("process.stdin.on('end', bye)"), "管道断自退");
    assert!(js.contains("module.exports = { SessionWatcher, scanZstdFrames, expandRow }"), "导出面不变");
}

/// JS 发射器 Electron 保真锚点：默认标题 / 聚合后缀 / subagent 抑制 /
/// cwd 非串守卫（issue #88）。行协议本身仍被 active_turns 消费。
#[test]
fn js_emitter_electron_parity_anchors() {
    let js = read_norm("../../../../dsh-desktop/session-watcher.js");
    assert!(js.contains("let title = 'DSH 任务完成';"));
    assert!(js.contains("（' + count + ' 轮任务完成）"), "多轮聚合后缀");
    assert!(js.contains("if (h.delegationDepth > 0) return;"), "subagent 抑制");
    assert!(js.contains("typeof h.cwd === 'string'"), "cwd 非串守卫（issue #88）");
}
