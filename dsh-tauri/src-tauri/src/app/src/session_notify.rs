//! # session_notify —— 会话监视线（仅 active_turns，不再发通知）
//!
//! 2026-10-22 起壳层「回合完成」通知链整体下线：通知改由内置插件 dsh-notify
//! 在渲染进程用 Web Notification 发送（见 `.tmp-agents/ext-notify.md`）。
//! 本模块只剩监视线与回合计数：
//!
//! ```text
//! lib.rs route_one_event(KernelReady)
//!   └─ start_watcher() ──spawn──▶ vendor node <app_dir>/session-watcher.js
//!                                  （payload 根级脚本；stage-payload.sh 根级
//!                                   *.js 全量镜像随包分发）
//!                                  CLI 模式：--sessions-dir <DSH_HOME>/sessions，
//!                                   stdout 每行一个 JSON，日志走 stderr；
//!                                   stdin 管道保活防孤儿。
//!        ├─ 读 stdout（capped 行协议）→ parse_turn_activity → ACTIVE_TURNS
//!        ├─ 读 stderr → 转发 desktop.log（取证）
//!        └─ 子进程退出 → 指数退避（1s…60s 封顶）自动重启；app 退出时收割
//! ```
//!
//! [`active_turns`] 是 supervisor 探活环「内核正在工作」的唯一判据（issue
//! #159：agent 长时间思考/压缩占住事件循环时不得误判假死强杀），因此监视
//! 线、行协议、退避与收割必须保留。
//!
//! 已删除面：NotifyThrottle / should_notify / notification_text /
//! fire_notification / request_main_window_attention / PENDING_JUMP /
//! on_main_window_focused / JUMP_EVENT。页面侧 `onNotificationJump` 方法位
//! 仍保留在垫片与契约里（兼容旧页面调用），但壳层不再主动 emit
//! notification-jump。监视路径仍是 Windows 侧 `<DSH_HOME>/sessions`；WSL
//! 模式下与 Electron 版一致（可能延迟/不触发，只影响回合计数）。

use std::io::Read;
use std::path::PathBuf;
use std::process::{Child, ChildStderr, ChildStdin, ChildStdout, Stdio};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::Mutex;

use tauri::{AppHandle, Manager};

use crate::AppState;
use crate::commands::NoWindow;
use kernel_process::sanitized_node_command;

// ---------------------------------------------------------------------------
// 常量（Electron main.js onSessionTurnEnd / preload 逐字对齐）
// ---------------------------------------------------------------------------

/// 会话 ID 合法长度（行协议校验：trim 后 1..=256）。
pub const MAX_SESSION_ID_LEN: usize = 256;
/// watcher 行协议单行上限（协议行 ~百字节级；超限整行流式丢弃不驻留）。
const WATCHER_LINE_CAP: usize = 8 * 1024;
/// 崩溃重启退避基数 / 封顶（1s→2s→…→60s 封顶）。
const BACKOFF_BASE_MS: u64 = 1_000;
const BACKOFF_CAP_MS: u64 = 60_000;
/// 连续 spawn 失败上限（vendor node/脚本被杀等永久形态：放弃并留终日志；
/// 内核重启会再次 start_watcher 复活）。自然崩溃（跑起来后退出）不设上限。
const MAX_SPAWN_FAILURES: u32 = 10;
/// 子进程存活超过该时长视为一次健康运行周期：退出时归零崩溃退避计数
/// （N2 P1-A——防「立刻退」形态被 spawn 成功重置成 1s 重启风暴，同时
/// 偶发/长跑后崩溃不永久累积退避）。
const WATCHER_HEALTHY_ALIVE: std::time::Duration = std::time::Duration::from_secs(60);

// ---------------------------------------------------------------------------
// 纯函数契约（pub，供对抗测试）
// ---------------------------------------------------------------------------

/// 会话 ID 可作协议载荷（trim 非空且 ≤256；与垫片 notification-jump 的
/// 载荷校验同口径，保留供行协议测试使用）。
pub fn valid_session_id(raw: &str) -> bool {
    let id = raw.trim();
    !id.is_empty() && id.len() <= MAX_SESSION_ID_LEN
}

/// 崩溃重启退避：第 `consecutive_restarts` 次重启前等待 1s→2s→4s→…，
/// 60s 封顶（指数退避封顶，纯函数供单测）。
pub fn restart_backoff_ms(consecutive_restarts: u32) -> u64 {
    let shift = consecutive_restarts.saturating_sub(1).min(6);
    (BACKOFF_BASE_MS << shift).min(BACKOFF_CAP_MS)
}

/// 进行中的顶层 agent 回合数（supervisor 探活环「忙碌」判定源）。
pub fn active_turns() -> u64 {
    ACTIVE_TURNS.load(Ordering::Relaxed)
}

/// 回合活动（行协议对 ACTIVE_TURNS 的影响）。纯函数，供对抗测试。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum TurnActivity {
    /// turn-start：进行中回合 +n。
    Start(u64),
    /// turn-end：进行中回合 -n（saturating，绝不落到负）。
    End(u64),
}

/// 从 watcher 行提取回合活动。turn-start 恒 +count；turn-end **仅当带 count**
/// 才 -count（count 缺省 = assistant/message 兜底通知，非真实 turn 结束，不得
/// 误消进行中的真实回合）。畸形行 / 其他 type → None。
pub fn parse_turn_activity(line: &str) -> Option<TurnActivity> {
    let v: serde_json::Value = serde_json::from_str(line.trim()).ok()?;
    let count = |v: &serde_json::Value| v.get("count").and_then(|c| c.as_u64()).unwrap_or(0);
    match v.get("type")?.as_str()? {
        "turn-start" => Some(TurnActivity::Start(count(&v).max(1))),
        "turn-end" => {
            // 缺 count（旧协议 / 兜底通知）→ 不减（0）。
            Some(TurnActivity::End(count(&v)))
        }
        _ => None,
    }
}

/// 应用一次回合活动到全局计数（saturating，跨会话并发安全）。
pub fn apply_turn_activity(activity: TurnActivity) {
    match activity {
        TurnActivity::Start(n) => {
            ACTIVE_TURNS.fetch_add(n, Ordering::Relaxed);
        }
        TurnActivity::End(n) if n > 0 => {
            let _ = ACTIVE_TURNS.fetch_update(Ordering::Relaxed, Ordering::Relaxed, |cur| {
                Some(cur.saturating_sub(n))
            });
        }
        TurnActivity::End(_) => {}
    }
}

/// capped 读行的结果。
#[derive(Debug, PartialEq, Eq)]
pub(crate) enum LineOutcome {
    /// 一行（不含换行；行尾 `\r` 已剥——Windows CRLF 容错）。
    Line(String),
    /// 超过上限的行：已流式丢弃（不整行驻留内存），继续读下一行。
    Oversized,
    /// 流结束且无待返回内容。
    Eof,
}

/// 流式读一行（带上限）：逐字节扫描换行，超限即转入丢弃模式直至行尾——
/// 对端灌超大/无换行垃圾也不撑爆内存；EOF 处的半行按 Line 返回（交由
/// 解析层拒收——半行容错）。
pub(crate) fn read_capped_line<R: Read>(r: &mut R, cap: usize) -> std::io::Result<LineOutcome> {
    let mut line: Vec<u8> = Vec::new();
    let mut oversized = false;
    let mut byte = [0u8; 1];
    loop {
        let n = r.read(&mut byte)?;
        if n == 0 {
            if oversized {
                return Ok(LineOutcome::Oversized);
            }
            if line.is_empty() {
                return Ok(LineOutcome::Eof);
            }
            break; // 末行无换行收尾：按行返回，解析层裁决
        }
        if byte[0] == b'\n' {
            break;
        }
        if line.len() >= cap {
            oversized = true;
            line.clear();
            line.shrink_to_fit();
        }
        if !oversized {
            line.push(byte[0]);
        }
    }
    if oversized {
        return Ok(LineOutcome::Oversized);
    }
    let mut s = String::from_utf8_lossy(&line).into_owned();
    if s.ends_with('\r') {
        s.pop();
    }
    Ok(LineOutcome::Line(s))
}

// ---------------------------------------------------------------------------
// 运行时（监视线 / 子进程生命周期）
// ---------------------------------------------------------------------------

/// watcher 子进程槽：child + 保活 stdin（Rust 退出哪怕被强杀，管道断 →
/// JS 侧 stdin 'end' 自退，防孤儿）+ 槽主线程代数号。
struct WatcherSlot {
    child: Option<Child>,
    stdin: Option<ChildStdin>,
    owner_gen: u64,
}

static WATCHER_SLOT: Mutex<WatcherSlot> =
    Mutex::new(WatcherSlot { child: None, stdin: None, owner_gen: 0 });
/// 监视线程代数号（新线启动即令旧线退役——KernelReady 单次 boot 发两回 /
/// 内核重启重入的幂等守卫，同 lib.rs HEARTBEAT_WATCHER_GEN 手法）。
static WATCHER_GEN: AtomicU64 = AtomicU64::new(0);
/// 退出中旗标（Electron `quitting`：退出中不再打扰；亦阻断崩溃重启）。
static QUITTING: AtomicBool = AtomicBool::new(false);
/// 进行中的顶层 agent 回合计数（turn-start +1 / turn-end -1，saturating）。
/// supervisor 探活环据其判定「内核正在工作」——agent 长时间思考/压缩导致
/// 内核事件循环被占、HTTP 无响应时不得误判假死强杀（issue #159）。
static ACTIVE_TURNS: AtomicU64 = AtomicU64::new(0);

/// watcher 子进程的三路流。
struct SpawnedWatcher {
    stdout: ChildStdout,
    stderr: ChildStderr,
}

/// 启动会话监视线（KernelReady 路由调用；幂等）：
/// 当前代线程在岗且子进程存活 → no-op；否则换代起新线（旧线自退）。
pub fn start_watcher(app: AppHandle) {
    {
        let mut slot = WATCHER_SLOT.lock().unwrap_or_else(|p| p.into_inner());
        let alive = slot
            .child
            .as_mut()
            .map(|c| c.try_wait().map_or(true, |st| st.is_none()))
            .unwrap_or(false);
        if alive && slot.owner_gen == WATCHER_GEN.load(Ordering::Relaxed) {
            return; // Electron 的 SessionWatcher 也全程只 start 一次
        }
    }
    // 永久形态前置校验（supervisor 未装配 / payload 脚本缺失）：不起线程，
    // 单条日志了结（内核重启会再走这里重试）。
    let paths = match resolve_watcher_paths(&app) {
        Ok(p) => p,
        Err(e) => {
            log(format!("[notify] session watcher 不启动（不影响主窗）：{e}"));
            return;
        }
    };
    let gen = WATCHER_GEN.fetch_add(1, Ordering::Relaxed) + 1;
    std::thread::spawn(move || run_watcher(app, gen, paths));
}

/// watcher 子进程参数（supervisor 的 vendor node + payload 脚本 + 会话目录）。
struct WatcherPaths {
    node: PathBuf,
    script: PathBuf,
    sessions_dir: PathBuf,
}

fn resolve_watcher_paths(app: &AppHandle) -> Result<WatcherPaths, String> {
    let state = app.try_state::<AppState>().ok_or("AppState 未就绪")?;
    let sv = state
        .supervisor
        .lock()
        .unwrap_or_else(|p| p.into_inner())
        .clone()
        .ok_or("supervisor 未装配（内核未就绪）")?;
    // payload 根级脚本（stage-payload.sh 镜像 dsh-desktop 根级 *.js；
    // Electron require('./session-watcher') 同件）。
    let script = sv.app_dir.join("session-watcher.js");
    if !script.exists() {
        return Err(format!("payload 脚本缺失：{}", script.display()));
    }
    // <DSH_HOME>/sessions（Electron main.js:6340：effectiveDshHome() || ~/.dsh
    // + 'sessions'；DshPaths.dsh_home 与 sidecar resolveHome 同源，含 DSH_HOME
    // 覆盖）。
    Ok(WatcherPaths {
        node: sv.node_exe.clone(),
        script,
        sessions_dir: state.paths.dsh_home.join("sessions"),
    })
}

fn run_watcher(_app: AppHandle, my_gen: u64, paths: WatcherPaths) {
    let mut spawn_failures: u32 = 0;
    // 崩溃重启计数：成功跑起来一轮即清零（退避阶梯重新从 1s 起算）——
    // 崩溃退避计数（N2 P1-A：spawn 成功不归零——只有存活满 60s 的健康周期
    // 在退出时归零；「起得来但立刻退」不再被重置成 1s 风暴）。
    let mut restarts: u32 = 0;
    loop {
        if is_retired(my_gen) {
            return;
        }
        // 互斥注册：先清残留（前代/上一轮尸体），再 spawn 入槽。
        let streams = {
            let mut slot = WATCHER_SLOT.lock().unwrap_or_else(|p| p.into_inner());
            if is_retired(my_gen) {
                return; // 已换代：在位 child 归新代线程管，不动
            }
            if let Some(mut old) = slot.child.take() {
                let _ = old.kill();
                let _ = old.wait();
            }
            match spawn_watcher_process(&paths) {
                Ok((mut child, streams)) => {
                    let SpawnedWatcher { stdout, stderr } = streams;
                    // watcher (重)启动即重基线：上一代遗留的「进行中回合」计数作废
                    // （新基线不再吐历史 turn/start/turn-end），否则滞留计数会让
                    // 真死内核永远逃过假死重启兜底（issue #159）。
                    ACTIVE_TURNS.store(0, Ordering::Relaxed);
                    // stdin 句柄留在槽内保活（drop 即管道断 → JS 自退）。
                    slot.stdin = child.stdin.take();
                    slot.owner_gen = my_gen;
                    slot.child = Some(child);
                    Some((stdout, stderr))
                }
                Err(e) => {
                    log(format!("[notify] session watcher 启动失败：{e}"));
                    None
                }
            }
        };
        let Some((stdout, stderr)) = streams else {
            spawn_failures += 1;
            if spawn_failures >= MAX_SPAWN_FAILURES {
                log(format!(
                    "[notify] session watcher 连续 {spawn_failures} 次启动失败，放弃（内核重启可复活）"
                ));
                return;
            }
            if sleep_unless_retired(my_gen, restart_backoff_ms(spawn_failures)) {
                return;
            }
            continue;
        };
        spawn_failures = 0;
        // N2 P1-A：spawn 成功不重置 restarts——「起得来但立刻退」的形态（sessions
        // 目录在异常盘上等）此前恒 1000ms 退避 = 永久 1 次/秒重启风暴刷日志。
        // 退避计数只在「子进程存活超过 WATCHER_HEALTHY_ALIVE（60s）」时视为
        // 健康运行过、于退出时归零：偶发崩溃不累加，慢性泄漏式长跑后崩溃也不
        // 会被 1s 风暴化。
        let spawned_at = std::time::Instant::now();
        forward_stderr(stderr);
        log(format!(
            "[notify] session watcher 在岗（{}，监视 {}）",
            paths.script.display(),
            paths.sessions_dir.display()
        ));
        // stdout 行消费（EOF = 子进程退出/被杀）。
        let mut reader = std::io::BufReader::new(stdout);
        loop {
            match read_capped_line(&mut reader, WATCHER_LINE_CAP) {
                Ok(LineOutcome::Line(line)) => {
                    if is_retired(my_gen) {
                        break;
                    }
                    // 回合进行中计数（issue #159）：turn-start +1 / turn-end -1，
                    // 供 supervisor 探活环判定「内核正在工作」时豁免假死强杀。
                    if let Some(activity) = parse_turn_activity(&line) {
                        apply_turn_activity(activity);
                    }
                }
                Ok(LineOutcome::Oversized) => {
                    log(format!("[notify] watcher 超长行丢弃（>{WATCHER_LINE_CAP}B）"));
                }
                Ok(LineOutcome::Eof) | Err(_) => break,
            }
        }
        // 收割：仅当前代收割槽内 child（被换代/关闭者已由其所属路径处理）。
        {
            let mut slot = WATCHER_SLOT.lock().unwrap_or_else(|p| p.into_inner());
            if !is_retired(my_gen) {
                if let Some(mut c) = slot.child.take() {
                    let _ = c.wait();
                }
                slot.stdin = None;
            }
        }
        if is_retired(my_gen) {
            return;
        }
        // 崩溃自动重启：指数退避封顶，不设次数上限（Electron 语义靠 in-process
        // 兜底；进程形态下重启即等价恢复，zstd 基线逻辑防通知重放）。
        // N2 P1-A：存活超过健康线的运行视为一次健康周期，退出时归零退避计数。
        if spawned_at.elapsed() >= WATCHER_HEALTHY_ALIVE {
            restarts = 0;
        }
        restarts += 1;
        log(format!(
            "[notify] session watcher 退出，{}ms 后第 {restarts} 次重启",
            restart_backoff_ms(restarts)
        ));
        if sleep_unless_retired(my_gen, restart_backoff_ms(restarts)) {
            return;
        }
    }
}

fn spawn_watcher_process(
    paths: &WatcherPaths,
) -> Result<(Child, SpawnedWatcher), String> {
    let mut cmd = sanitized_node_command(&paths.node);
    cmd.arg(&paths.script)
        .arg("--sessions-dir")
        .arg(&paths.sessions_dir)
        // stdin 保活管道（见 WatcherSlot 注释）；stdout 行协议 / stderr 日志。
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        // GUI 进程起 console 子进程必须抑制终端窗（与 run_sidecar 同口径）。
        .creation_flags_no_window();
    let mut child = cmd.spawn().map_err(|e| format!("spawn {:?}: {e}", paths.node))?;
    let stdout = child.stdout.take().ok_or("stdout 管道缺失")?;
    let stderr = child.stderr.take().ok_or("stderr 管道缺失")?;
    Ok((child, SpawnedWatcher { stdout, stderr }))
}

/// stderr 转发线程：watcher 人类日志 → desktop.log（防管道写满阻塞子进程）。
fn forward_stderr(stderr: ChildStderr) {
    std::thread::spawn(move || {
        let mut reader = std::io::BufReader::new(stderr);
        loop {
            match read_capped_line(&mut reader, WATCHER_LINE_CAP) {
                Ok(LineOutcome::Line(line)) if !line.is_empty() => {
                    log(format!("[watcher] {line}"));
                }
                Ok(LineOutcome::Line(_)) => {}
                Ok(LineOutcome::Oversized) => {}
                Ok(LineOutcome::Eof) | Err(_) => return,
            }
        }
    });
}

fn is_retired(my_gen: u64) -> bool {
    QUITTING.load(Ordering::Relaxed) || WATCHER_GEN.load(Ordering::Relaxed) != my_gen
}

/// 退避睡眠（分片检查退役）；返回 true = 睡眠期间已退役。
fn sleep_unless_retired(my_gen: u64, total_ms: u64) -> bool {
    let deadline = std::time::Instant::now() + std::time::Duration::from_millis(total_ms);
    while std::time::Instant::now() < deadline {
        if is_retired(my_gen) {
            return true;
        }
        std::thread::sleep(std::time::Duration::from_millis(500).min(deadline.saturating_duration_since(std::time::Instant::now())));
    }
    is_retired(my_gen)
}

/// 收割 watcher 子进程（lib.rs RunEvent::ExitRequested/Exit 调用；幂等）。
pub fn shutdown_watcher() {
    QUITTING.store(true, Ordering::Relaxed);
    WATCHER_GEN.fetch_add(1, Ordering::Relaxed); // 令在岗监视线退役
    let mut slot = WATCHER_SLOT.lock().unwrap_or_else(|p| p.into_inner());
    slot.stdin = None; // 先断保活管道（JS 侧优雅退出路径）
    if let Some(mut c) = slot.child.take() {
        let _ = c.kill();
        let _ = c.wait(); // 收割，不留僵尸
    }
}

/// 路由层日志（与 lib.rs route_log 同口径：stderr + logs/desktop.log）。
fn log(msg: String) {
    eprintln!("{msg}");
    crate::supervisor::file_log(&msg);
}

// ---------------------------------------------------------------------------
// 测试
// ---------------------------------------------------------------------------

#[cfg(test)]
mod text_and_backoff_tests {
    use super::*;

    #[test]
    fn session_id_validation() {
        assert!(valid_session_id("  abc  "));
        assert!(!valid_session_id("   "));
        assert!(!valid_session_id(""));
        let long = "x".repeat(MAX_SESSION_ID_LEN);
        assert!(valid_session_id(&long), "恰 256 放行");
        assert!(!valid_session_id(&format!("{}x", long)), "257 拦截");
    }

    /// 指数退避封顶：1s→2s→…→32s→60s（64s 封顶到 60s）→恒 60s。
    #[test]
    fn backoff_exponential_capped() {
        assert_eq!(restart_backoff_ms(1), 1_000);
        assert_eq!(restart_backoff_ms(2), 2_000);
        assert_eq!(restart_backoff_ms(3), 4_000);
        assert_eq!(restart_backoff_ms(6), 32_000);
        assert_eq!(restart_backoff_ms(7), 60_000, "2^6*1000=64s → 封顶 60s");
        assert_eq!(restart_backoff_ms(50), 60_000, "恒封顶");
        assert_eq!(restart_backoff_ms(0), 1_000, "0 按 1 处理（saturating）");
    }
}

#[cfg(test)]
mod line_protocol_tests {
    use super::*;
    use std::io::Cursor;

    #[test]
    fn capped_reader_lines_crlf_eof_halfline() {
        let mut c = Cursor::new(b"line1\r\nline2\n".to_vec());
        assert_eq!(read_capped_line(&mut c, 64).unwrap(), LineOutcome::Line("line1".into()), "CRLF 行尾 \\r 应剥");
        assert_eq!(read_capped_line(&mut c, 64).unwrap(), LineOutcome::Line("line2".into()));
        assert_eq!(read_capped_line(&mut c, 64).unwrap(), LineOutcome::Eof);

        // 半行（无换行即 EOF）：按行返回，交解析层拒收。
        let mut c = Cursor::new(b"{\"type\":\"turn-e".to_vec());
        assert_eq!(read_capped_line(&mut c, 64).unwrap(), LineOutcome::Line("{\"type\":\"turn-e".into()));
        assert_eq!(read_capped_line(&mut c, 64).unwrap(), LineOutcome::Eof);

        // 空行。
        let mut c = Cursor::new(b"\n\n".to_vec());
        assert_eq!(read_capped_line(&mut c, 64).unwrap(), LineOutcome::Line(String::new()));
        assert_eq!(read_capped_line(&mut c, 64).unwrap(), LineOutcome::Line(String::new()));
        assert_eq!(read_capped_line(&mut c, 64).unwrap(), LineOutcome::Eof);
    }

    /// 超大行：整行流式丢弃，后续正常行不受影响（内存不随对端行长增长）。
    #[test]
    fn capped_reader_drops_oversized_and_recovers() {
        let big = "x".repeat(300);
        let mut stream = Vec::new();
        stream.extend_from_slice(big.as_bytes());
        stream.push(b'\n');
        stream.extend_from_slice(br#"{"type":"turn-end","sessionId":"ok"}"#);
        stream.push(b'\n');
        let mut c = Cursor::new(stream);
        assert_eq!(read_capped_line(&mut c, 64).unwrap(), LineOutcome::Oversized);
        let line = match read_capped_line(&mut c, 64).unwrap() {
            LineOutcome::Line(l) => l,
            o => panic!("超大行后应恢复读行：{o:?}"),
        };
        assert!(
            parse_turn_activity(&line).is_some(),
            "恢复后的合法行仍可解析（turn-end 带 count 才计活动）"
        );
    }
}

/// 回合活动计数（issue #159 内核「忙碌」判定源）：parse/apply 纯函数。
#[cfg(test)]
mod turn_activity_tests {
    use super::*;

    fn reset_active_turns() {
        ACTIVE_TURNS.store(0, Ordering::Relaxed);
    }

    #[test]
    fn parse_turn_activity_shapes() {
        assert_eq!(
            parse_turn_activity(r#"{"type":"turn-start","sessionId":"s","count":2}"#),
            Some(TurnActivity::Start(2))
        );
        assert_eq!(
            parse_turn_activity(r#"{"type":"turn-start","sessionId":"s"}"#),
            Some(TurnActivity::Start(1)),
            "缺 count 的 turn-start 按 1 计"
        );
        assert_eq!(
            parse_turn_activity(r#"{"type":"turn-end","sessionId":"s","count":1}"#),
            Some(TurnActivity::End(1))
        );
        assert_eq!(
            parse_turn_activity(r#"{"type":"turn-end","sessionId":"s"}"#),
            Some(TurnActivity::End(0)),
            "缺 count 的 turn-end 是兜底通知，不减"
        );
        assert_eq!(
            parse_turn_activity(r#"{"type":"turn-end","sessionId":"s","title":"t","body":"b"}"#),
            Some(TurnActivity::End(0))
        );
        for bad in ["", "not json", "{", r#"{"type":"ready"}"#, r#"{"type":"log"}"#] {
            assert_eq!(parse_turn_activity(bad), None, "应拒收：{bad}");
        }
    }

    #[test]
    fn apply_turn_activity_balances_and_saturates() {
        reset_active_turns();
        apply_turn_activity(TurnActivity::Start(2));
        assert_eq!(active_turns(), 2);
        apply_turn_activity(TurnActivity::End(1));
        assert_eq!(active_turns(), 1);
        apply_turn_activity(TurnActivity::End(5));
        assert_eq!(active_turns(), 0, "saturating 不到负");
        apply_turn_activity(TurnActivity::Start(1));
        apply_turn_activity(TurnActivity::End(0));
        assert_eq!(active_turns(), 1, "End(0) 不减");
        reset_active_turns();
    }
}

/// 形态锚点（接线不漂移）：监听点/子进程形态/镜像对齐。
#[cfg(test)]
mod shape_tests {
    /// lib.rs 接线形态：模块声明 / KernelReady 启动 / 退出收割；且通知链
    /// 已下线（不得再出现聚焦路由/发射调用）。
    #[test]
    fn lib_wiring_shape() {
        let src = include_str!("lib.rs").replace("\r\n", "\n");
        assert!(src.contains("mod session_notify;"), "模块声明");
        assert!(
            src.contains("session_notify::start_watcher(app.clone())"),
            "KernelReady 后启动监视线（Electron main.js:6337 同点位）"
        );
        assert!(
            src.contains("session_notify::shutdown_watcher();"),
            "退出路径必须收割 watcher 子进程"
        );
        assert!(
            !src.contains("session_notify::on_main_window_focused("),
            "壳层通知跳转兜底已下线，lib.rs 不得再路由聚焦事件"
        );
    }

    /// watcher 子进程 spawn 形态：抑制终端窗 + 行协议参数 + payload 脚本名。
    #[test]
    fn watcher_spawn_shape() {
        let src = include_str!("session_notify.rs").replace("\r\n", "\n");
        let seg = src
            .split("fn spawn_watcher_process")
            .nth(1)
            .and_then(|s| s.split("\n}").next())
            .expect("spawn_watcher_process 函数体");
        assert!(seg.contains(".creation_flags_no_window()"), "GUI 起 console 子进程必须抑制终端窗: {seg}");
        assert!(seg.contains("--sessions-dir"), "CLI 协议参数: {seg}");
        assert!(
            src.contains("join(\"session-watcher.js\")"),
            "payload 脚本必须是 dsh-desktop 根级 session-watcher.js（stage-payload 根级 *.js 镜像）"
        );
    }

    /// payload 脚本 CLI 形态（Electron require 路径零变化 + 行协议标记）。
    #[test]
    fn payload_cli_shape() {
        let js = include_str!("../../../../../dsh-desktop/session-watcher.js").replace("\r\n", "\n");
        assert!(js.contains("require.main === module"), "CLI 模式守卫（Electron require 不受影响）");
        assert!(js.contains("--sessions-dir"), "sessions 目录参数");
        assert!(js.contains("'turn-end'"), "行协议 type 标记");
        assert!(js.contains("process.stdin.resume()"), "stdin 保活（防孤儿）");
        // Electron 侧接口零回归：导出面不变。
        assert!(js.contains("module.exports = { SessionWatcher, scanZstdFrames, expandRow }"));
    }

    /// 分发链形态：stage-payload.sh 根级 *.js 镜像覆盖 session-watcher.js。
    #[test]
    fn stage_payload_mirrors_watcher_script() {
        let sh = include_str!("../../../../scripts/stage-payload.sh").replace("\r\n", "\n");
        assert!(
            sh.contains("\"$SRC\"/*.js"),
            "根级 *.js 全量镜像（session-watcher.js 随包分发依赖此行）"
        );
    }
}
