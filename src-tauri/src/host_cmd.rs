//! 插件沙箱需要的宿主能力：真实平台信息 + 受限的 git 执行。
//!
//! 兼容层把 `os.platform()` 与 `child_process.execFile("git", …)` 映射到这里。
//! 目的：① Windows 上不再向插件谎报 linux；② 让依赖 git 的插件（如 vault-force-sync）
//! 在沙箱里可用，同时把执行面收窄到「只跑 git、只在 vault 目录、拒危险 flag」。

use serde::Serialize;
use std::path::PathBuf;
use std::process::Command;

#[derive(Serialize)]
pub struct HostOs {
    pub os: &'static str,
    pub arch: &'static str,
    pub homedir: String,
}

/// 真实平台。`os` 用 Node 风格（win32/darwin/linux），与兼容层一致。
#[tauri::command]
pub fn host_os() -> HostOs {
    let node_os = match std::env::consts::OS {
        "windows" => "win32",
        "macos" => "darwin",
        other => other,
    };
    let homedir = std::env::var("USERPROFILE")
        .or_else(|_| std::env::var("HOME"))
        .unwrap_or_default();
    HostOs {
        os: node_os,
        arch: std::env::consts::ARCH,
        homedir,
    }
}

#[derive(Serialize)]
pub struct GitResult {
    pub status: i32,
    pub stdout: String,
    pub stderr: String,
}

/// 会改变仓库根/工作树、或注入其它可执行文件的 flag，一律拒绝。
const FORBIDDEN: [&str; 6] = [
    "--git-dir",
    "--work-tree",
    "--exec-path",
    "--upload-pack",
    "--receive-pack",
    "--config-env",
];

/// 受限执行：可执行文件固定 `git`，cwd 固定为 vault 根。
#[tauri::command]
pub fn run_git(vault_root: String, args: Vec<String>) -> Result<GitResult, String> {
    for a in &args {
        if a.contains('\0') {
            return Err("参数包含非法字符".into());
        }
        let key = a.split('=').next().unwrap_or(a);
        if FORBIDDEN.contains(&key) || (a.starts_with("-c") && !a.starts_with("--")) {
            return Err(format!("禁止的 git 参数：{a}"));
        }
    }
    let root = PathBuf::from(&vault_root);
    if !root.is_dir() {
        return Err(format!("vault 目录不存在：{vault_root}"));
    }
    // 规范化，确保工作目录落在 vault 之内
    let root = root.canonicalize().map_err(|e| e.to_string())?;
    let mut cmd = Command::new("git");
    cmd.args(&args).current_dir(&root);
    // 从 GUI 进程 spawn 控制台程序（git.exe）会弹出一个黑框；CREATE_NO_WINDOW 抑制它。
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        cmd.creation_flags(CREATE_NO_WINDOW);
    }
    let out = cmd
        .output()
        .map_err(|e| format!("执行 git 失败：{e}"))?;
    Ok(GitResult {
        status: out.status.code().unwrap_or(-1),
        stdout: String::from_utf8_lossy(&out.stdout).to_string(),
        stderr: String::from_utf8_lossy(&out.stderr).to_string(),
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn host_os_reports_node_style_platform() {
        let h = host_os();
        assert!(["win32", "darwin", "linux"].contains(&h.os), "unexpected os: {}", h.os);
        assert!(!h.arch.is_empty());
    }

    #[test]
    fn run_git_rejects_dangerous_flags() {
        for bad in ["--git-dir=/tmp/x", "--work-tree", "--exec-path=/x", "-cuser.x=1", "--upload-pack=/bin/sh"] {
            let r = run_git(".".into(), vec![bad.into()]);
            assert!(r.is_err(), "should reject: {bad}");
        }
    }

    #[test]
    fn run_git_rejects_nul_and_missing_dir() {
        assert!(run_git(".".into(), vec!["status\0".into()]).is_err());
        assert!(run_git("/definitely/not/here/xyz".into(), vec!["status".into()]).is_err());
    }
}
