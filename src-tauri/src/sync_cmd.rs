//! Nextcloud (WebDAV) sync Tauri commands.
//!
//! Replaces the former Joplin Server sync (deleted). The vault is
//! mirrored 1:1 to a remote WebDAV tree; content can be AES-encrypted
//! (password-derived key, salt published in the remote `nf-sync-meta.json`).

use crate::AppState;
use nf_sync::crypto_layer::SyncCrypto;
use nf_sync::drivers::filesystem::FsDriver;
use nf_sync::drivers::webdav::{nextcloud_files_url, WebDavDriver};
use nf_sync::file_api::FileApi;
use nf_sync::mirror::diff::{Direction, FirstSyncPolicy};
use nf_sync::mirror::ignore::IgnoreRules;
use nf_sync::mirror::report::SyncReport;
use nf_sync::mirror::MirrorEngine;
use serde::{Deserialize, Serialize};
use tauri::Emitter;

#[derive(Clone, Serialize, Deserialize, Default)]
pub struct NextcloudConfig {
    /// Bare server URL (`https://nc.example.com`) or a full DAV path.
    /// The literal value "filesystem" selects the local-folder test driver.
    pub server_url: String,
    pub username: String,
    /// Nextcloud App Password (never the login password). Not persisted.
    #[serde(default)]
    pub app_password: String,
    /// Remote directory under the user's files, e.g. `NoteForge`.
    #[serde(default = "default_remote_root")]
    pub remote_root: String,
    /// Extra ignore globs, one per entry.
    #[serde(default)]
    pub ignore_rules: Vec<String>,
    /// bidirectional | upload | download
    #[serde(default = "default_direction")]
    pub direction: String,
    /// Sync password for content encryption (NOT persisted).
    #[serde(default)]
    pub sync_password: String,
    /// Whether content encryption is enabled (default true).
    #[serde(default = "default_true")]
    pub encrypted: bool,
    /// Auto-sync interval in minutes (0 = disabled).
    #[serde(default)]
    pub auto_sync_minutes: u32,
    /// Run a sync when the app starts with this vault.
    #[serde(default)]
    pub sync_on_startup: bool,
}

fn default_remote_root() -> String { "NoteForge".into() }
fn default_direction() -> String { "bidirectional".into() }
fn default_true() -> bool { true }

/// What the frontend receives — secrets stripped.
#[derive(Clone, Serialize)]
pub struct NextcloudConfigView {
    pub server_url: String,
    pub username: String,
    pub remote_root: String,
    pub ignore_rules: Vec<String>,
    pub direction: String,
    pub encrypted: bool,
    pub has_password: bool,
    pub auto_sync_minutes: u32,
    pub sync_on_startup: bool,
}

impl NextcloudConfig {
    fn view(&self) -> NextcloudConfigView {
        NextcloudConfigView {
            server_url: self.server_url.clone(),
            username: self.username.clone(),
            remote_root: self.remote_root.clone(),
            ignore_rules: self.ignore_rules.clone(),
            direction: self.direction.clone(),
            encrypted: self.encrypted,
            has_password: !self.sync_password.is_empty() && !self.app_password.is_empty(),
            auto_sync_minutes: self.auto_sync_minutes,
            sync_on_startup: self.sync_on_startup,
        }
    }
}

fn config_path(state: &AppState) -> Result<std::path::PathBuf, String> {
    let v = state.vault.lock().map_err(|e| e.to_string())?;
    v.as_ref()
        .map(|v| v.root().join(".noteforge").join("sync-config.json"))
        .ok_or_else(|| "没有打开的笔记库".to_string())
}

fn save_config(state: &AppState, config: &NextcloudConfig) -> Result<(), String> {
    let path = config_path(state)?;
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }
    // Secrets are intentionally NOT written to disk.
    let mut persisted = config.clone();
    persisted.sync_password = String::new();
    persisted.app_password = String::new();
    let json = serde_json::to_string_pretty(&persisted).map_err(|e| e.to_string())?;
    std::fs::write(&path, json).map_err(|e| e.to_string())?;
    if let Ok(mut slot) = state.sync_config.lock() {
        *slot = Some(config.clone());
    }
    Ok(())
}

fn load_config(state: &AppState) -> Result<Option<NextcloudConfig>, String> {
    if let Ok(slot) = state.sync_config.lock() {
        if slot.is_some() {
            return Ok(slot.clone());
        }
    }
    let path = config_path(state)?;
    if !path.exists() {
        return Ok(None);
    }
    let raw = std::fs::read_to_string(&path).map_err(|e| e.to_string())?;
    let cfg: NextcloudConfig = serde_json::from_str(&raw).map_err(|e| e.to_string())?;
    if let Ok(mut slot) = state.sync_config.lock() {
        *slot = Some(cfg.clone());
    }
    Ok(Some(cfg))
}

fn parse_direction(s: &str) -> Direction {
    match s {
        "upload" => Direction::UploadOnly,
        "download" => Direction::DownloadOnly,
        _ => Direction::Bidirectional,
    }
}

/// Build the driver for the configured target.
fn build_driver(config: &NextcloudConfig) -> Result<Box<dyn FileApi>, String> {
    if config.server_url == "filesystem" {
        // Local-folder driver for tests / offline usage.
        return Ok(Box::new(FsDriver::new(&config.remote_root)));
    }
    let url = nextcloud_files_url(&config.server_url, &config.username, &config.remote_root)
        .map_err(|e| e.to_string())?;
    Ok(Box::new(
        WebDavDriver::new(&url, &config.username, &config.app_password)
            .map_err(|e| e.to_string())?,
    ))
}

async fn build_crypto(config: &NextcloudConfig) -> Result<SyncCrypto, String> {
    if !config.encrypted {
        return Ok(SyncCrypto::disabled());
    }
    if config.sync_password.is_empty() {
        return Err("已启用加密同步，但本次未输入同步密码".into());
    }
    // Salt: reuse from remote meta when present, else generate and publish.
    let driver = build_driver(config)?;
    let probe = MirrorEngine::new(
        driver.as_ref(),
        SyncCrypto::disabled(),
        IgnoreRules::new(&config.ignore_rules),
        parse_direction(&config.direction),
        FirstSyncPolicy::Bidirectional,
    );
    let salt = match probe.fetch_meta().await.map_err(|e| e.to_string())? {
        Some(meta) if !meta.salt_b64.is_empty() => meta.salt_b64,
        _ => {
            let salt = nf_crypto::generate_salt_b64();
            probe.publish_meta(&salt).await.map_err(|e| e.to_string())?;
            salt
        }
    };
    SyncCrypto::with_password(&config.sync_password, &salt).map_err(|e| e.to_string())
}

fn vault_root(state: &AppState) -> Result<std::path::PathBuf, String> {
    let v = state.vault.lock().map_err(|e| e.to_string())?;
    v.as_ref().map(|v| v.root().to_path_buf()).ok_or_else(|| "没有打开的笔记库".to_string())
}

fn progress_emitter<'w>(window: &'w tauri::Window) -> impl Fn(&str, usize, usize, &str) + 'w {
    move |phase: &str, done: usize, total: usize, path: &str| {
        let _ = window.emit(
            "sync-progress",
            serde_json::json!({ "phase": phase, "done": done, "total": total, "path": path }),
        );
    }
}

// ── Commands ─────────────────────────────────────────────────────────

#[tauri::command]
pub fn sync_configure(config: NextcloudConfig, state: tauri::State<'_, AppState>) -> Result<(), String> {
    if config.server_url.is_empty() {
        return Err("服务器地址不能为空".into());
    }
    if config.server_url != "filesystem" && config.username.is_empty() {
        return Err("用户名不能为空".into());
    }
    save_config(&state, &config)
}

#[tauri::command]
pub fn sync_get_config(state: tauri::State<'_, AppState>) -> Result<Option<NextcloudConfigView>, String> {
    load_config(&state).map(|opt| opt.map(|c| c.view()))
}

/// Remember the Nextcloud app password and sync password for this
/// session only (never persisted to disk).
#[tauri::command]
pub fn sync_set_passwords(
    app_password: String,
    sync_password: String,
    state: tauri::State<'_, AppState>,
) -> Result<(), String> {
    let mut cfg = load_config(&state)?.ok_or_else(|| "尚未配置同步".to_string())?;
    if !app_password.is_empty() {
        cfg.app_password = app_password;
    }
    if !sync_password.is_empty() {
        cfg.sync_password = sync_password;
    }
    if let Ok(mut slot) = state.sync_config.lock() {
        *slot = Some(cfg);
    }
    Ok(())
}

#[tauri::command]
pub async fn sync_test(window: tauri::Window, state: tauri::State<'_, AppState>) -> Result<String, String> {
    let config = load_config(&state)?.ok_or_else(|| "尚未配置同步".to_string())?;
    let _ = window.emit("sync-progress", "⏳ 正在测试连接...");
    let driver = build_driver(&config)?;
    driver.test().await.map_err(|e| e.to_string())?;
    // Ensure the remote root directory exists.
    driver.mkdir("").await.map_err(|e| e.to_string())?;
    let _ = window.emit("sync-progress", "✅ 连接成功");
    Ok("连接成功".into())
}

/// Run one sync round. `first_policy` only applies when no previous
/// sync state exists ("bidirectional" | "upload_all" | "download_all").
#[tauri::command]
pub async fn sync_start(
    window: tauri::Window,
    state: tauri::State<'_, AppState>,
    first_policy: Option<String>,
) -> Result<SyncReport, String> {
    let config = load_config(&state)?.ok_or_else(|| "尚未配置同步".to_string())?;
    let root = vault_root(&state)?;

    let _ = window.emit("sync-progress", "⏳ 正在连接...");
    let driver = build_driver(&config)?;
    let crypto = build_crypto(&config).await?;
    let policy = match first_policy.as_deref() {
        Some("upload_all") => FirstSyncPolicy::UploadAll,
        Some("download_all") => FirstSyncPolicy::DownloadAll,
        _ => FirstSyncPolicy::Bidirectional,
    };
    let mut engine = MirrorEngine::new(
        driver.as_ref(),
        crypto,
        IgnoreRules::new(&config.ignore_rules),
        parse_direction(&config.direction),
        policy,
    );

    let report = engine
        .sync(&root, &progress_emitter(&window))
        .await
        .map_err(|e| e.to_string())?;

    // Persist the report for the "last report" dialog.
    let report_path = root.join(".noteforge/last-sync-report.json");
    if let Some(parent) = report_path.parent() {
        std::fs::create_dir_all(parent).ok();
    }
    if let Ok(json) = serde_json::to_string_pretty(&report) {
        std::fs::write(&report_path, json).ok();
    }

    // Refresh the file tree cache after any download/delete-local.
    if report.downloaded > 0 || report.deleted_local > 0 {
        if let Ok(mut tc) = state.tree_cache.lock() {
            tc.clear();
        }
    }
    let _ = window.emit("sync-done", report.summary());
    Ok(report)
}

/// True when this vault has no previous sync state (first sync).
#[tauri::command]
pub fn sync_first_sync_needed(state: tauri::State<'_, AppState>) -> Result<bool, String> {
    let root = vault_root(&state)?;
    Ok(!root.join(nf_sync::mirror::state::STATE_FILE).exists())
}

#[tauri::command]
pub fn sync_get_report(state: tauri::State<'_, AppState>) -> Result<Option<SyncReport>, String> {
    let root = vault_root(&state)?;
    let path = root.join(".noteforge/last-sync-report.json");
    if !path.exists() {
        return Ok(None);
    }
    let raw = std::fs::read_to_string(&path).map_err(|e| e.to_string())?;
    serde_json::from_str(&raw).map(Some).map_err(|e| e.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn config_serialization_roundtrip() {
        let cfg = NextcloudConfig {
            server_url: "https://nc.example.com".into(),
            username: "alice".into(),
            app_password: "secret".into(),
            remote_root: "NoteForge".into(),
            ignore_rules: vec!["drafts/".into()],
            direction: "bidirectional".into(),
            sync_password: "pw".into(),
            encrypted: true,
            auto_sync_minutes: 0,
            sync_on_startup: false,
        };
        let json = serde_json::to_string(&cfg).unwrap();
        let back: NextcloudConfig = serde_json::from_str(&json).unwrap();
        assert_eq!(back.server_url, "https://nc.example.com");
        assert_eq!(back.encrypted, true);
        assert_eq!(back.remote_root, "NoteForge");
    }

    #[test]
    fn persisted_config_missing_fields_default() {
        let cfg: NextcloudConfig = serde_json::from_str(
            r#"{"server_url":"https://nc.example.com","username":"a"}"#,
        ).unwrap();
        assert_eq!(cfg.remote_root, "NoteForge");
        assert!(cfg.encrypted);
        assert_eq!(cfg.direction, "bidirectional");
        assert!(cfg.app_password.is_empty());
    }

    #[test]
    fn view_strips_secrets() {
        let cfg = NextcloudConfig {
            server_url: "https://nc.example.com".into(),
            username: "alice".into(),
            app_password: "secret".into(),
            remote_root: "NoteForge".into(),
            ignore_rules: vec![],
            direction: "upload".into(),
            sync_password: "pw".into(),
            encrypted: true,
            auto_sync_minutes: 0,
            sync_on_startup: false,
        };
        let view = cfg.view();
        assert!(view.has_password);
        assert_eq!(view.direction, "upload");
    }
}
