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
use nf_sync::mirror::conflict::Strategy;
use nf_sync::mirror::diff::{Direction, FirstSyncPolicy};
use nf_sync::mirror::filter::SyncFilter;
use nf_sync::mirror::report::SyncReport;
use nf_sync::mirror::{MirrorEngine, SyncOptions};
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

    // ── Path filter (yanc capabilities) ───────────────────────────────
    /// File extensions never synced, lowercase without a dot; compound
    /// suffixes such as `tar.gz` are allowed.
    #[serde(default)]
    pub excluded_extensions: Vec<String>,
    /// Also delete server-side copies of excluded file types.
    #[serde(default)]
    pub purge_excluded_extensions_remote: bool,
    /// Vault-relative folders never synced (blacklist; wins over the whitelist).
    #[serde(default)]
    pub excluded_folders: Vec<String>,
    /// When non-empty, ONLY these vault-relative folders are synced.
    #[serde(default)]
    pub sync_only_folders: Vec<String>,
    /// Skip `.*` files (default on).
    #[serde(default = "default_true")]
    pub exclude_hidden_files: bool,
    /// Skip `.*` folders and everything beneath (default on).
    #[serde(default = "default_true")]
    pub exclude_dot_folders: bool,
    /// Skip `_*` files (opt-in; often real content).
    #[serde(default)]
    pub exclude_underscore_files: bool,
    /// Skip `_*` folders (opt-in).
    #[serde(default)]
    pub exclude_underscore_folders: bool,
    /// Absolute file-size cap in MB; 0 = unlimited.
    #[serde(default)]
    pub max_file_size_mb: u64,

    // ── Lazy attachments ──────────────────────────────────────────────
    /// Index attachments and fetch their bytes on demand.
    #[serde(default)]
    pub lazy_sync_attachments: bool,
    /// Folder specs for lazy sync: plain name (any depth), vault-relative
    /// path (contains `/`), or `@obsidian` for the app's attachment folder.
    #[serde(default)]
    pub lazy_attachment_folders: Vec<String>,
    /// The app's configured attachment folder, used by the `@obsidian` spec.
    #[serde(default)]
    pub obsidian_attachment_folder: String,

    // ── Conflict strategies ───────────────────────────────────────────
    /// Extensions treated as "Auto Merge File" types (lowercase, no dot).
    #[serde(default = "default_merge_types")]
    pub auto_merge_file_types: Vec<String>,
    /// Strategy for those types (merge | biggest-size | latest-mtime | local-win | remote-win).
    #[serde(default = "default_merge_strategy")]
    pub auto_merge_file_strategy: String,
    /// Strategy for every other file type (`merge` not offered).
    #[serde(default = "default_other_strategy")]
    pub other_file_strategy: String,
    /// Mass-delete circuit breaker: -1 automatic, 0 unlimited, N fixed.
    #[serde(default = "default_mass_delete")]
    pub mass_delete_limit: i64,

    // ── Config folder, logging, runtime ───────────────────────────────
    /// Sync parts of the app config folder (`.noteforge`-style dotfolder).
    #[serde(default)]
    pub sync_config_folder: bool,
    #[serde(default = "default_true")]
    pub config_sync_bookmarks: bool,
    #[serde(default = "default_true")]
    pub config_sync_others: bool,
    /// User-facing device label.
    #[serde(default)]
    pub device_name: String,
    /// Vault-relative folder holding the sync log; blank = vault root.
    #[serde(default)]
    pub logs_folder: String,
    /// Master on/off for sync logging.
    #[serde(default)]
    pub logging_enabled: bool,
    /// Startup sync delay in seconds (0 = no startup sync).
    #[serde(default = "default_startup_delay")]
    pub startup_sync_delay_seconds: u32,
    /// Number of concurrent WebDAV requests.
    #[serde(default = "default_concurrency")]
    pub network_concurrency: u32,
    /// Watch local edits and sync immediately.
    #[serde(default = "default_true")]
    pub watch_on_change_enabled: bool,
}

fn default_remote_root() -> String { "NoteForge".into() }
fn default_direction() -> String { "bidirectional".into() }
fn default_true() -> bool { true }
fn default_mass_delete() -> i64 { -1 }
fn default_startup_delay() -> u32 { 1 }
fn default_concurrency() -> u32 { 16 }
fn default_merge_strategy() -> String { "merge".into() }
fn default_other_strategy() -> String { "latest-mtime".into() }
fn default_merge_types() -> Vec<String> {
    ["txt", "cpp", "py", "c", "h", "hpp", "rs", "go", "ts", "js", "java", "sh"]
        .iter()
        .map(|s| s.to_string())
        .collect()
}

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
    pub excluded_extensions: Vec<String>,
    pub purge_excluded_extensions_remote: bool,
    pub excluded_folders: Vec<String>,
    pub sync_only_folders: Vec<String>,
    pub exclude_hidden_files: bool,
    pub exclude_dot_folders: bool,
    pub exclude_underscore_files: bool,
    pub exclude_underscore_folders: bool,
    pub max_file_size_mb: u64,
    pub lazy_sync_attachments: bool,
    pub lazy_attachment_folders: Vec<String>,
    pub obsidian_attachment_folder: String,
    pub auto_merge_file_types: Vec<String>,
    pub auto_merge_file_strategy: String,
    pub other_file_strategy: String,
    pub mass_delete_limit: i64,
    pub sync_config_folder: bool,
    pub config_sync_bookmarks: bool,
    pub config_sync_others: bool,
    pub device_name: String,
    pub logs_folder: String,
    pub logging_enabled: bool,
    pub startup_sync_delay_seconds: u32,
    pub network_concurrency: u32,
    pub watch_on_change_enabled: bool,
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
            excluded_extensions: self.excluded_extensions.clone(),
            purge_excluded_extensions_remote: self.purge_excluded_extensions_remote,
            excluded_folders: self.excluded_folders.clone(),
            sync_only_folders: self.sync_only_folders.clone(),
            exclude_hidden_files: self.exclude_hidden_files,
            exclude_dot_folders: self.exclude_dot_folders,
            exclude_underscore_files: self.exclude_underscore_files,
            exclude_underscore_folders: self.exclude_underscore_folders,
            max_file_size_mb: self.max_file_size_mb,
            lazy_sync_attachments: self.lazy_sync_attachments,
            lazy_attachment_folders: self.lazy_attachment_folders.clone(),
            obsidian_attachment_folder: self.obsidian_attachment_folder.clone(),
            auto_merge_file_types: self.auto_merge_file_types.clone(),
            auto_merge_file_strategy: self.auto_merge_file_strategy.clone(),
            other_file_strategy: self.other_file_strategy.clone(),
            mass_delete_limit: self.mass_delete_limit,
            sync_config_folder: self.sync_config_folder,
            config_sync_bookmarks: self.config_sync_bookmarks,
            config_sync_others: self.config_sync_others,
            device_name: self.device_name.clone(),
            logs_folder: self.logs_folder.clone(),
            logging_enabled: self.logging_enabled,
            startup_sync_delay_seconds: self.startup_sync_delay_seconds,
            network_concurrency: self.network_concurrency,
            watch_on_change_enabled: self.watch_on_change_enabled,
        }
    }
}

/// Build the path/size filter from the persisted config.
pub fn build_filter(config: &NextcloudConfig) -> SyncFilter {
    SyncFilter {
        extra_patterns: config
            .ignore_rules
            .iter()
            .map(|s| s.trim().to_string())
            .filter(|s| !s.is_empty())
            .collect(),
        excluded_extensions: config.excluded_extensions.clone(),
        excluded_folders: config.excluded_folders.clone(),
        sync_only_folders: config.sync_only_folders.clone(),
        exclude_hidden_files: config.exclude_hidden_files,
        exclude_dot_folders: config.exclude_dot_folders,
        exclude_underscore_files: config.exclude_underscore_files,
        exclude_underscore_folders: config.exclude_underscore_folders,
        lazy_sync_attachments: config.lazy_sync_attachments,
        lazy_attachment_folders: resolved_lazy_folders(config),
        sync_config_folder: config.sync_config_folder,
        config_sync_bookmarks: config.config_sync_bookmarks,
        config_sync_others: config.config_sync_others,
        max_file_size_mb: config.max_file_size_mb,
    }
}

/// Expand the `@obsidian` lazy-folder placeholder into the app's own
/// attachment folder (only when it is a fixed vault path).
fn resolved_lazy_folders(config: &NextcloudConfig) -> Vec<String> {
    config
        .lazy_attachment_folders
        .iter()
        .filter_map(|spec| {
            let spec = spec.trim();
            if spec == "@obsidian" {
                let dir = config.obsidian_attachment_folder.trim();
                if dir.is_empty() {
                    None
                } else {
                    Some(dir.trim_matches('/').to_string())
                }
            } else if spec.is_empty() {
                None
            } else {
                Some(spec.to_string())
            }
        })
        .collect()
}

/// Build the merge/conflict/purge/logging options from the persisted config.
pub fn build_options(config: &NextcloudConfig) -> SyncOptions {
    SyncOptions {
        purge_excluded_extensions_remote: config.purge_excluded_extensions_remote,
        mass_delete_limit: config.mass_delete_limit,
        auto_merge_file_types: config.auto_merge_file_types.clone(),
        auto_merge_file_strategy: Strategy::parse(&config.auto_merge_file_strategy),
        other_file_strategy: Strategy::parse(&config.other_file_strategy),
        logging_enabled: config.logging_enabled,
        logs_folder: config.logs_folder.clone(),
        device_name: config.device_name.clone(),
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
        build_filter(&config),
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
        build_filter(&config),
        parse_direction(&config.direction),
        policy,
    )
    .with_options(build_options(&config));

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

/// Download one lazy-synced attachment on demand (from the remote server).
///
/// Used when a note that embeds the attachment is opened: the bytes were
/// deliberately not pulled during sync, so this fetches just that one file.
#[tauri::command]
pub async fn sync_fetch_attachment(
    path: String,
    state: tauri::State<'_, AppState>,
) -> Result<(), String> {
    let config = load_config(&state)?.ok_or_else(|| "尚未配置同步".to_string())?;
    let root = vault_root(&state)?;
    let driver = build_driver(&config)?;
    let crypto = build_crypto(&config).await?;
    let engine = MirrorEngine::new(
        driver.as_ref(),
        crypto,
        build_filter(&config),
        parse_direction(&config.direction),
        FirstSyncPolicy::Bidirectional,
    )
    .with_options(build_options(&config));
    engine.fetch_lazy(&root, &path).await.map_err(|e| e.to_string())
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
            ..Default::default()
        };
        let json = serde_json::to_string(&cfg).unwrap();
        let back: NextcloudConfig = serde_json::from_str(&json).unwrap();
        assert_eq!(back.server_url, "https://nc.example.com");
        assert_eq!(back.encrypted, true);
        assert_eq!(back.remote_root, "NoteForge");
        // Every field survives the roundtrip.
        assert_eq!(back.mass_delete_limit, cfg.mass_delete_limit);
        assert_eq!(back.exclude_dot_folders, cfg.exclude_dot_folders);
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
        // yanc-derived defaults
        assert!(cfg.exclude_hidden_files, "hidden files skipped by default");
        assert!(cfg.exclude_dot_folders, "dotfolders skipped by default");
        assert!(!cfg.exclude_underscore_files, "underscore files opt-in");
        assert!(!cfg.lazy_sync_attachments);
        assert!(!cfg.purge_excluded_extensions_remote);
        assert_eq!(cfg.auto_merge_file_strategy, "merge");
        assert_eq!(cfg.other_file_strategy, "latest-mtime");
        assert_eq!(cfg.startup_sync_delay_seconds, 1);
        assert_eq!(cfg.network_concurrency, 16);
        assert_eq!(cfg.mass_delete_limit, -1, "breaker defaults to automatic");
        assert!(cfg.watch_on_change_enabled);
    }

    #[test]
    fn view_strips_secrets() {
        let cfg = NextcloudConfig {
            server_url: "https://nc.example.com".into(),
            username: "alice".into(),
            app_password: "secret".into(),
            sync_password: "pw".into(),
            direction: "upload".into(),
            ..Default::default()
        };
        let view = cfg.view();
        assert!(view.has_password);
        assert_eq!(view.direction, "upload");
        // The view must not carry either secret.
        let json = serde_json::to_string(&view).unwrap();
        assert!(!json.contains("secret"));
        assert!(!json.contains("\"pw\""));
    }

    #[test]
    fn filter_and_options_built_from_config() {
        let cfg = NextcloudConfig {
            excluded_extensions: vec!["exe".into()],
            excluded_folders: vec!["archive".into()],
            sync_only_folders: vec!["notes".into()],
            lazy_sync_attachments: true,
            lazy_attachment_folders: vec!["files".into(), "@obsidian".into()],
            obsidian_attachment_folder: "attachments".into(),
            auto_merge_file_strategy: "biggest-size".into(),
            other_file_strategy: "remote-win".into(),
            mass_delete_limit: 7,
            purge_excluded_extensions_remote: true,
            device_name: "我的 Mac".into(),
            ..Default::default()
        };
        let filter = build_filter(&cfg);
        assert_eq!(filter.excluded_extensions, vec!["exe".to_string()]);
        assert!(filter.ignored("setup.exe"));
        assert!(filter.ignored("archive/a.md"));
        assert!(filter.ignored("other/a.md"), "whitelist excludes non-listed folders");
        // `@obsidian` expands to the app's attachment folder.
        assert_eq!(filter.lazy_attachment_folders, vec!["files".to_string(), "attachments".to_string()]);
        assert!(filter.is_lazy_attachment("notes/files/a.png"));

        let options = build_options(&cfg);
        assert_eq!(options.auto_merge_file_strategy, Strategy::BiggestSize);
        assert_eq!(options.other_file_strategy, Strategy::RemoteWin);
        assert_eq!(options.mass_delete_limit, 7);
        assert!(options.purge_excluded_extensions_remote);
        assert_eq!(options.device_name, "我的 Mac");
    }
}
