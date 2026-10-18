//! 上次运行遗留内核的 pid 记账与启动期收割（壳闪退 → 孤儿内核的兜底）。
//!
//! 背景（2026-10-16 真机取证）：壳主线程在 tao 事件循环 Destroyed 态 panic
//! 后进程直接消失，`RunEvent::ExitRequested/Exit` 不会运行——`sv.shutdown()`
//! 与 Job Object 之外的收尾全部跳过，内核 node 可能继续监听旧端口；下次启动
//! 再拉一个新内核 = 双 web 实例（synapse「workspace 已被另一个 dsh web 实例
//! 修改」告警的壳侧来源）。
//!
//! 记账协议（纯 std，无 serde 依赖）：
//! - 壳每次 spawn 内核后写 `<app_data>/kernel.pid.json`（`pid=…` / `exe=…` /
//!   `port=…` 三行；tmp+rename 原子落盘）；
//! - 内核退出 / 显式杀树时删除；
//! - 下次启动（拿到单实例锁之后、spawn 新内核之前）读取并判定
//!   [`harvest_decision`]：**记账 exe 必须与本次将使用的 node 一致**，且
//!   **进程映像路径复核一致**（防 pid 复用误杀）才收割。任一不成立一律不动。
//!
//! 非 Windows：不做映像复核（返回 false → 判定 NotRunning → 不动进程）。
//! Unix 的孤儿内核随进程组/会话终结，按 pid 盲杀有 pid 复用误杀面，不值得。

use std::path::Path;

/// 内核 pid 记账（一次 spawn 一条）。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct KernelPidRecord {
    pub pid: u32,
    /// spawn 时使用的 node 可执行文件（绝对/相对原样记账）。
    pub exe: String,
    /// 本次内核监听端口（用于收割后等端口释放；未知为 None）。
    pub port: Option<u16>,
}

/// 启动期孤儿内核判定（纯函数，全平台可单测）。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum HarvestDecision {
    /// 无记账（正常退出/首启）——无事可做。
    NoRecord,
    /// 记账 exe 与本次 node 不一致——可能是另一安装树/另一运行时，不动。
    ExeMismatch,
    /// 进程已不在，或映像路径与记账不符（pid 复用）——不动。
    NotRunning,
    /// 记账一致且映像复核一致——收割整树。
    Kill,
}

/// 读记账文件；格式不符/缺字段/读失败一律 None（保守不动作）。
pub fn read(path: &Path) -> Option<KernelPidRecord> {
    let raw = std::fs::read_to_string(path).ok()?;
    let mut pid: Option<u32> = None;
    let mut exe: Option<String> = None;
    let mut port: Option<u16> = None;
    for line in raw.lines() {
        let Some((key, value)) = line.split_once('=') else {
            continue;
        };
        match key.trim() {
            "pid" => pid = value.trim().parse().ok(),
            "exe" if !value.trim().is_empty() => exe = Some(value.to_string()),
            "port" => port = value.trim().parse().ok(),
            _ => {}
        }
    }
    Some(KernelPidRecord { pid: pid?, exe: exe?, port })
}

/// 原子写记账（tmp+rename；失败静默——记账不可用只降级孤儿收割，绝不影响启动）。
pub fn write(path: &Path, record: &KernelPidRecord) {
    let body = match record.port {
        Some(p) => format!("pid={}\nexe={}\nport={p}\n", record.pid, record.exe),
        None => format!("pid={}\nexe={}\n", record.pid, record.exe),
    };
    let tmp = path.with_extension("json.tmp");
    if let Some(parent) = path.parent() {
        let _ = std::fs::create_dir_all(parent);
    }
    let _ = std::fs::write(&tmp, body).and_then(|_| std::fs::rename(&tmp, path));
}

/// 删除记账（内核已收尸/显式杀树后调用；失败静默）。
pub fn remove(path: &Path) {
    let _ = std::fs::remove_file(path);
}

/// 收割判定（纯函数）：见 [`HarvestDecision`]。`image_matches` 由调用方经
/// [`process_image_matches`] 取得（非 Windows 恒 false）。
pub fn harvest_decision(
    record: Option<&KernelPidRecord>,
    expected_exe: &str,
    image_matches: bool,
) -> HarvestDecision {
    let Some(rec) = record else {
        return HarvestDecision::NoRecord;
    };
    if !same_image_path(&rec.exe, expected_exe) {
        return HarvestDecision::ExeMismatch;
    }
    if !image_matches {
        return HarvestDecision::NotRunning;
    }
    HarvestDecision::Kill
}

/// 路径等值：canonicalize 可用时按规范路径比（消 `\\?\` 前缀与相对段）；
/// Windows 大小写不敏感 + 分隔符归一；其余平台逐字节。
fn same_image_path(a: &str, b: &str) -> bool {
    normalize_image_path(a) == normalize_image_path(b)
}

fn normalize_image_path(raw: &str) -> String {
    let canonical = std::fs::canonicalize(raw)
        .map(|p| p.to_string_lossy().into_owned())
        .unwrap_or_else(|_| raw.to_string());
    let stripped = canonical.strip_prefix(r"\\?\").unwrap_or(&canonical);
    if cfg!(windows) {
        stripped.replace('/', "\\").to_ascii_lowercase()
    } else {
        stripped.to_string()
    }
}

/// 进程存活且映像路径与 `expected` 一致（Windows：OpenProcess +
/// QueryFullProcessImageNameW；其余平台恒 false——见模块注释）。
#[cfg(windows)]
pub fn process_image_matches(pid: u32, expected: &str) -> bool {
    use windows_sys::Win32::Foundation::CloseHandle;
    use windows_sys::Win32::System::Threading::{
        OpenProcess, QueryFullProcessImageNameW, PROCESS_QUERY_LIMITED_INFORMATION,
    };
    if pid <= 1 {
        return false;
    }
    unsafe {
        let handle = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, 0, pid);
        if handle.is_null() {
            return false;
        }
        let mut buf = [0u16; 1024];
        let mut len = buf.len() as u32;
        let ok = QueryFullProcessImageNameW(handle, 0, buf.as_mut_ptr(), &mut len);
        CloseHandle(handle);
        if ok == 0 || len == 0 {
            return false;
        }
        let image = String::from_utf16_lossy(&buf[..len as usize]);
        same_image_path(&image, expected)
    }
}

#[cfg(not(windows))]
pub fn process_image_matches(_pid: u32, _expected: &str) -> bool {
    false
}

/// 按 pid 杀整树（无 Child 句柄）。Windows taskkill /T /F；Unix killpg。
#[cfg(windows)]
pub fn kill_pid_tree(pid: u32) -> bool {
    use std::os::windows::process::CommandExt;
    const CREATE_NO_WINDOW: u32 = 0x0800_0000;
    if pid <= 1 {
        return false;
    }
    std::process::Command::new("taskkill")
        .args(["/PID", &pid.to_string(), "/T", "/F"])
        .creation_flags(CREATE_NO_WINDOW)
        .output()
        .map(|o| o.status.success())
        .unwrap_or(false)
}

#[cfg(unix)]
pub fn kill_pid_tree(pid: u32) -> bool {
    match crate::kill_tree::unix_kill_target(pid) {
        Some(target) => unsafe { libc::kill(target, libc::SIGKILL) == 0 },
        None => false,
    }
}

#[cfg(not(any(windows, unix)))]
pub fn kill_pid_tree(_pid: u32) -> bool {
    false
}

#[cfg(test)]
mod tests {
    use super::*;

    fn tmp_file(name: &str) -> std::path::PathBuf {
        let dir = std::env::temp_dir().join(format!(
            "dsh-stale-kernel-{}-{name}",
            std::process::id()
        ));
        let _ = std::fs::create_dir_all(&dir);
        dir.join("kernel.pid.json")
    }

    /// 记账 round-trip：三行协议读回逐字段一致；port 缺省也合法。
    #[test]
    fn pid_record_roundtrip() {
        let path = tmp_file("roundtrip");
        let rec = KernelPidRecord { pid: 4242, exe: "C:/tmp/node.exe".into(), port: Some(50081) };
        write(&path, &rec);
        assert_eq!(read(&path), Some(rec));
        write(&path, &KernelPidRecord { pid: 7, exe: "node".into(), port: None });
        assert_eq!(read(&path), Some(KernelPidRecord { pid: 7, exe: "node".into(), port: None }));
        remove(&path);
        assert_eq!(read(&path), None, "删除后不得再读到记账");
        let _ = std::fs::remove_dir_all(path.parent().unwrap());
    }

    /// 坏记账（缺 pid / 无 exe / 纯垃圾）一律 None——保守不动作。
    #[test]
    fn malformed_records_are_ignored() {
        let path = tmp_file("malformed");
        for body in ["exe=node\n", "pid=abc\nexe=node\n", "garbage", ""] {
            std::fs::write(&path, body).unwrap();
            assert_eq!(read(&path), None, "坏记账必须判 None: {body:?}");
        }
        let _ = std::fs::remove_dir_all(path.parent().unwrap());
    }

    /// 判定表全臂枚举（含反证）：只允许「exe 一致 + 映像复核一致」走到 Kill。
    #[test]
    fn harvest_decision_table() {
        let rec = KernelPidRecord { pid: 1, exe: "C:/app/node.exe".into(), port: None };
        assert_eq!(harvest_decision(None, "C:/app/node.exe", true), HarvestDecision::NoRecord);
        assert_eq!(
            harvest_decision(Some(&rec), "C:/other/node.exe", true),
            HarvestDecision::ExeMismatch,
            "exe 不一致必须跳过（不得盲杀别的安装树/运行时）"
        );
        assert_eq!(
            harvest_decision(Some(&rec), "C:/app/node.exe", false),
            HarvestDecision::NotRunning,
            "映像复核失败必须跳过（pid 复用误杀面）"
        );
        assert_eq!(harvest_decision(Some(&rec), "C:/app/node.exe", true), HarvestDecision::Kill);
    }

    /// 本进程映像复核正/反证：自己的 exe 命中、别人的路径不命中、
    /// 不存在的 pid 不命中（Windows 实测；非 Windows 恒 false）。
    #[test]
    fn image_match_positive_and_negative() {
        let pid = std::process::id();
        let me = std::env::current_exe().unwrap().to_string_lossy().into_owned();
        assert!(process_image_matches(pid, &me), "本进程映像必须与自身 exe 命中");
        assert!(
            !process_image_matches(pid, "C:/definitely/not/this/exe.exe"),
            "映像路径不符必须判不命中"
        );
        assert!(!process_image_matches(u32::MAX, &me), "不存在的 pid 必须判不命中");
        assert!(!process_image_matches(0, &me), "pid=0 必须判不命中");
    }
}
