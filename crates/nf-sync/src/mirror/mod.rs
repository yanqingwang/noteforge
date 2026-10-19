//! Vault mirror engine: scan → diff → apply → report.
//!
//! This module is deliberately thin: the path/exclusion policy lives in
//! [`filter`], the three-way merge in [`merge`], the strategy decisions
//! and mass-delete guard in [`conflict`], the remote purge pass in
//! [`purge`], and the merge-base copies in [`base_store`].
//!
//! Safety rules baked into the applier:
//! - Every delete lands in a trash (local `.noteforge/trash/` or the
//!   Nextcloud server trashbin) — nothing is destroyed outright.
//! - Downloaded remote content is decrypted (when encryption is on)
//!   before it ever touches a local file; decrypt failure aborts that
//!   file, never the whole sync.
//! - Local writes go through temp-file + rename.
//! - A first sync writes a one-time safety backup of the losing side.
//! - A single round may not exceed the mass-delete circuit-breaker cap.

pub mod base_store;
pub mod conflict;
pub mod diff;
pub mod filter;
pub mod merge;
pub mod purge;
pub mod report;
pub mod snapshot;
pub mod state;

use crate::crypto_layer::SyncCrypto;
use crate::error::SyncError;
use crate::file_api::{FileApi, FileEntry};
use crate::mirror::base_store::BaseStore;
use crate::mirror::conflict::{decide, ConflictCtx, MassDeleteGuard, Resolution, Strategy};
use crate::mirror::diff::{build_plan, Action, Direction, FirstSyncPolicy};
use crate::mirror::filter::SyncFilter;
use crate::mirror::report::SyncReport;
use crate::mirror::snapshot::{hash_local, read_local, scan_local};
use crate::mirror::state::SyncState;
use std::io::Write;
use std::path::Path;

pub const META_NAME: &str = "nf-sync-meta.json";
const TRASH_DIR: &str = ".noteforge/trash";

/// Runtime behaviour knobs that are not part of the path filter.
#[derive(Debug, Clone)]
pub struct SyncOptions {
    /// Delete server-side copies of excluded file types (yanc purge).
    pub purge_excluded_extensions_remote: bool,
    /// Mass-delete circuit breaker: -1 = automatic, 0 = unlimited, N = fixed.
    pub mass_delete_limit: i64,
    /// Extensions (lowercase, no dot) treated as "Auto Merge File" types.
    pub auto_merge_file_types: Vec<String>,
    /// Strategy for those types (and always for `.md`).
    pub auto_merge_file_strategy: Strategy,
    /// Strategy for every other file type (`merge` is not offered there).
    pub other_file_strategy: Strategy,
    /// Write a sync log under `logs_folder`.
    pub logging_enabled: bool,
    /// Vault-relative folder holding the log; blank = vault root.
    pub logs_folder: String,
    /// Device label, recorded in the log header.
    pub device_name: String,
}

impl Default for SyncOptions {
    fn default() -> Self {
        SyncOptions {
            purge_excluded_extensions_remote: false,
            mass_delete_limit: -1,
            auto_merge_file_types: vec![
                "txt", "cpp", "py", "c", "h", "hpp", "rs", "go", "ts", "js", "java", "sh",
            ]
            .into_iter()
            .map(String::from)
            .collect(),
            auto_merge_file_strategy: Strategy::Merge,
            other_file_strategy: Strategy::LatestMtime,
            logging_enabled: false,
            logs_folder: String::new(),
            device_name: String::new(),
        }
    }
}

/// Metadata published on the remote root so other devices can join the
/// same encrypted sync (they need the salt; the password stays with the user).
#[derive(serde::Serialize, serde::Deserialize, Default)]
pub struct RemoteMeta {
    pub salt_b64: String,
    pub encrypted: bool,
    pub app: String,
}

pub struct MirrorEngine<'a> {
    target: &'a dyn FileApi,
    crypto: SyncCrypto,
    filter: SyncFilter,
    options: SyncOptions,
    direction: Direction,
    first_policy: FirstSyncPolicy,
}

/// Progress callback: (phase, done, total, current_path).
pub type ProgressFn<'p> = &'p (dyn Fn(&str, usize, usize, &str) + Send + Sync);

impl<'a> MirrorEngine<'a> {
    pub fn new(
        target: &'a dyn FileApi,
        crypto: SyncCrypto,
        filter: SyncFilter,
        direction: Direction,
        first_policy: FirstSyncPolicy,
    ) -> Self {
        MirrorEngine {
            target,
            crypto,
            filter,
            options: SyncOptions::default(),
            direction,
            first_policy,
        }
    }

    /// Attach behaviour knobs; without this the defaults apply.
    pub fn with_options(mut self, options: SyncOptions) -> Self {
        self.options = options;
        self
    }

    /// List remote files under the sync root (files only, filter applied).
    ///
    /// This is always a REAL listing — the engine keeps no root-ETag
    /// short-circuit cache, so a purge can never be fooled by a stale tree.
    pub async fn list_remote(&self) -> Result<Vec<FileEntry>, SyncError> {
        let entries = self.target.list("").await?;
        Ok(entries
            .into_iter()
            .filter(|e| !e.is_dir)
            .filter(|e| !self.filter.ignored(&e.path))
            .filter(|e| !self.filter.too_large(e.size))
            .collect())
    }

    /// Read + decrypt one remote file.
    pub async fn read_remote_plain(&self, path: &str) -> Result<Vec<u8>, SyncError> {
        let raw = self.target.get(path).await?;
        self.crypto.open(&raw)
    }

    /// Encrypt + upload one file. Returns the new remote etag.
    pub async fn write_remote_sealed(&self, path: &str, plain: &[u8]) -> Result<Option<String>, SyncError> {
        let sealed = self.crypto.seal(plain)?;
        self.target.put(path, &sealed).await
    }

    /// Run one full sync round. `on_progress` receives (phase, done, total, path).
    pub async fn sync(
        &mut self,
        vault_root: &Path,
        on_progress: ProgressFn<'_>,
    ) -> Result<SyncReport, SyncError> {
        let mut report = SyncReport::new();
        report.encrypted = self.crypto.enabled();
        self.log(vault_root, &format!("—— 开始同步（设备：{}）", self.device_label()));

        on_progress("scan-local", 0, 1, "");
        let local = scan_local(vault_root, &self.filter)?;
        on_progress("scan-remote", 0, 1, "");
        let remote = self.list_remote().await?;
        let mut state = SyncState::load(vault_root)?;
        let first = state.is_first_sync();
        report.first_sync = first;

        // Hash function with lazy evaluation (only called when mtime+size differ)
        let hash_fn = |p: &str| hash_local(vault_root, p).unwrap_or_default();
        let plan = build_plan(&local, &remote, &state, self.direction, &self.first_policy, &hash_fn);

        let total = plan.actions.len();
        if first && total > 0 {
            // One-time safety backup before the very first sync touches data.
            self.first_sync_backup(vault_root, &local, on_progress).await?;
        }

        let mut guard = MassDeleteGuard::new(self.options.mass_delete_limit, state.files.len());

        on_progress("apply", 0, total, "");
        for (i, action) in plan.actions.iter().enumerate() {
            let path = action.path().to_string();
            let result = self.apply_action(vault_root, action, &mut state, &mut guard).await;
            match result {
                Ok((kind, msg)) => {
                    self.log(vault_root, &format!("{} [{}] {}", kind, path, msg));
                    report.push(&path, kind, true, msg);
                }
                Err(e) => {
                    self.log(vault_root, &format!("error [{}] {}", path, e));
                    report.push(&path, action.kind(), false, e.to_string());
                }
            }
            on_progress("apply", i + 1, total, &path);
        }

        if self.options.purge_excluded_extensions_remote {
            self.purge_remote(vault_root, &mut state, &mut report, &mut guard, on_progress).await;
        }

        if guard.refused_count() > 0 {
            self.log(
                vault_root,
                &format!("⚠ 批量删除断路器拦截了 {} 项删除", guard.refused_count()),
            );
        }

        state.last_sync_at = chrono::Utc::now().timestamp();
        state.save(vault_root)?;
        report.finished_at = chrono::Utc::now().timestamp();
        self.log(vault_root, &report.summary());
        Ok(report)
    }

    /// Download one lazy-synced attachment on demand (yanc lazy sync).
    pub async fn fetch_lazy(&self, vault_root: &Path, path: &str) -> Result<(), SyncError> {
        let plain = self.read_remote_plain(path).await?;
        self.write_local(vault_root, path, &plain)?;
        let mut state = SyncState::load(vault_root)?;
        let etag = self.current_etag(path).await;
        self.record_state(vault_root, path, etag, &mut state)?;
        self.bases(vault_root).put(path, &plain).ok();
        state.save(vault_root)?;
        Ok(())
    }

    // ── internals ────────────────────────────────────────────────────

    fn bases(&self, vault_root: &Path) -> BaseStore {
        BaseStore::new(vault_root)
    }

    fn device_label(&self) -> String {
        if self.options.device_name.trim().is_empty() {
            "未命名设备".to_string()
        } else {
            self.options.device_name.clone()
        }
    }

    fn log(&self, vault_root: &Path, line: &str) {
        if !self.options.logging_enabled {
            return;
        }
        let dir = if self.options.logs_folder.trim().is_empty() {
            vault_root.to_path_buf()
        } else {
            vault_root.join(self.options.logs_folder.trim())
        };
        if std::fs::create_dir_all(&dir).is_err() {
            return;
        }
        let stamp = chrono::Local::now().format("%Y-%m-%d %H:%M:%S");
        if let Ok(mut f) = std::fs::OpenOptions::new().create(true).append(true).open(dir.join("nf-sync.log")) {
            let _ = writeln!(f, "[{}] {}", stamp, line);
        }
    }

    /// The conflict strategy that applies to one path.
    fn strategy_for(&self, path: &str) -> Strategy {
        let ext = Path::new(path)
            .extension()
            .map(|e| e.to_string_lossy().to_lowercase())
            .unwrap_or_default();
        // Markdown always gets the auto-merge strategy (yanc special-case).
        if ext == "md" {
            return self.options.auto_merge_file_strategy;
        }
        if self.options.auto_merge_file_types.iter().any(|t| t.trim_start_matches('.').eq_ignore_ascii_case(&ext))
            && !ext.is_empty()
        {
            return self.options.auto_merge_file_strategy;
        }
        // `merge` is not offered for other types.
        match self.options.other_file_strategy {
            Strategy::Merge => Strategy::LatestMtime,
            s => s,
        }
    }

    /// Execute one planned action and record the new baseline entry.
    #[allow(clippy::type_complexity)]
    async fn apply_action(
        &mut self,
        vault_root: &Path,
        action: &Action,
        state: &mut SyncState,
        guard: &mut MassDeleteGuard,
    ) -> Result<(&'static str, String), SyncError> {
        match action {
            Action::Upload { path } | Action::Reupload { path } => {
                let plain = read_local(vault_root, path)?;
                let etag = self.write_remote_sealed(path, &plain).await?;
                self.record_state(vault_root, path, etag, state)?;
                self.bases(vault_root).put(path, &plain).ok();
                let kind = if matches!(action, Action::Reupload { .. }) { "reupload" } else { "upload" };
                Ok((kind, "已上传".into()))
            }
            Action::Download { path } => {
                if self.filter.is_lazy_attachment(path) {
                    // Lazy mode: index the remote identity only; the bytes
                    // are fetched on demand when the note that embeds it opens.
                    let etag = self.remote_entry(path).await.and_then(|e| e.etag);
                    state.upsert_lazy(path, etag);
                    return Ok(("index-lazy", "附件已登记，打开笔记时按需下载".into()));
                }
                let plain = self.read_remote_plain(path).await?;
                self.write_local(vault_root, path, &plain)?;
                let etag = self.current_etag(path).await;
                self.record_state(vault_root, path, etag, state)?;
                self.bases(vault_root).put(path, &plain).ok();
                Ok(("download", "已下载".into()))
            }
            Action::Restore { path } => {
                // Deleted locally, changed remotely → download back
                let plain = self.read_remote_plain(path).await?;
                self.write_local(vault_root, path, &plain)?;
                let etag = self.current_etag(path).await;
                self.record_state(vault_root, path, etag, state)?;
                self.bases(vault_root).put(path, &plain).ok();
                Ok(("restore", "本地已删除但远端有更新，已恢复".into()))
            }
            Action::Compare { path } => {
                // First sync, both sides have the file: content-compare first,
                // then fall through to the configured conflict strategy.
                let plain = self.read_remote_plain(path).await?;
                let local_plain = read_local(vault_root, path)?;
                let remote_hash = crate::mirror::snapshot::sha256_hex(&plain);
                let local_hash = crate::mirror::snapshot::sha256_hex(&local_plain);
                if remote_hash == local_hash {
                    let etag = self.current_etag(path).await;
                    self.record_state(vault_root, path, etag, state)?;
                    self.bases(vault_root).put(path, &local_plain).ok();
                    return Ok(("compare-equal", "两侧内容一致".into()));
                }
                self.resolve_conflict(vault_root, path, None, state).await
            }
            Action::Conflict { path } => {
                let base = self.bases(vault_root).get(path);
                self.resolve_conflict(vault_root, path, base.as_deref(), state).await
            }
            Action::DeleteRemote { path } => {
                if !guard.allow(path) {
                    return Ok(("delete-blocked", "已达批量删除上限，本轮跳过（服务器回收站未改动）".into()));
                }
                self.target.delete(path).await?;
                state.remove(path);
                self.bases(vault_root).remove(path);
                Ok(("delete-remote", "远端已删除（服务器回收站可恢复）".into()))
            }
            Action::DeleteLocal { path } => {
                if !guard.allow(path) {
                    return Ok(("delete-blocked", "已达批量删除上限，本轮跳过（本地文件未移入回收站）".into()));
                }
                self.local_trash(vault_root, path)?;
                state.remove(path);
                self.bases(vault_root).remove(path);
                Ok(("delete-local", "远端已删除，本地文件移入 .noteforge/trash/".into()))
            }
        }
    }

    /// Resolve a two-sided conflict according to the configured strategy.
    async fn resolve_conflict(
        &mut self,
        vault_root: &Path,
        path: &str,
        base: Option<&[u8]>,
        state: &mut SyncState,
    ) -> Result<(&'static str, String), SyncError> {
        let local_plain = read_local(vault_root, path).unwrap_or_default();
        let remote_plain = self.read_remote_plain(path).await?;
        let entry = self.remote_entry(path).await;
        let remote_mtime = entry.as_ref().map(|e| e.updated_time.max(0) as u64).unwrap_or(0);
        let local_mtime = std::fs::metadata(vault_root.join(path))
            .ok()
            .and_then(|m| m.modified().ok())
            .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
            .map(|d| d.as_millis() as u64)
            .unwrap_or(0);

        let strategy = self.strategy_for(path);
        let ctx = ConflictCtx {
            local: &local_plain,
            remote: &remote_plain,
            base,
            local_mtime,
            remote_mtime,
        };

        match decide(strategy, &ctx) {
            Resolution::Write { content, clean } => {
                self.write_local(vault_root, path, &content)?;
                let etag = self.write_remote_sealed(path, &content).await?;
                self.record_state(vault_root, path, etag, state)?;
                self.bases(vault_root).put(path, &content).ok();
                if clean {
                    Ok(("merge-clean", "三方合并成功，无冲突".into()))
                } else {
                    Ok(("conflict-markers", "存在冲突区域，已在文件内用标记保留两侧内容".into()))
                }
            }
            Resolution::PreferLocal => {
                let etag = self.write_remote_sealed(path, &local_plain).await?;
                self.record_state(vault_root, path, etag, state)?;
                self.bases(vault_root).put(path, &local_plain).ok();
                Ok(("conflict-local-win", "按本地版本覆盖远端".into()))
            }
            Resolution::PreferRemote => {
                self.write_local(vault_root, path, &remote_plain)?;
                let etag = entry.as_ref().and_then(|e| e.etag.clone());
                let etag = match etag {
                    Some(e) => Some(e),
                    None => self.current_etag(path).await,
                };
                self.record_state(vault_root, path, etag, state)?;
                self.bases(vault_root).put(path, &remote_plain).ok();
                Ok(("conflict-remote-win", "按远端版本覆盖本地".into()))
            }
            Resolution::SafeHold => {
                // Both sides untouched; remember the state as-observed so the
                // next round does not re-plan the same file, and keep the flag.
                let etag = entry.as_ref().and_then(|e| e.etag.clone());
                let etag = match etag {
                    Some(e) => Some(e),
                    None => self.current_etag(path).await,
                };
                self.record_state(vault_root, path, etag, state)?;
                state.mark_conflicted(path);
                self.log(vault_root, &format!("hold [{}] 非文本/无法三方合并，两侧均保留", path));
                Ok(("conflict-hold", "无法自动合并，两侧内容均已原样保留".into()))
            }
            Resolution::NoOp => Ok(("conflict-noop", "两侧大小/时间相同，无需处理".into())),
        }
    }

    /// Remove server-side copies of excluded file types (yanc purge).
    async fn purge_remote(
        &self,
        vault_root: &Path,
        state: &mut SyncState,
        report: &mut SyncReport,
        guard: &mut MassDeleteGuard,
        on_progress: ProgressFn<'_>,
    ) {
        // Deliberately a REAL full listing (see `list_remote`): a stale root
        // ETag must never be able to hide excluded files from the purge.
        let all = match self.target.list("").await {
            Ok(entries) => entries,
            Err(e) => {
                report.push("", "purge", false, format!("列举远端失败，已跳过清理: {}", e));
                return;
            }
        };
        let candidates = purge::purge_candidates(&all, &self.filter);
        let total = candidates.len();
        for (i, path) in candidates.iter().enumerate() {
            if !guard.allow(path) {
                report.push(path, "delete-blocked", true, "已达批量删除上限，未从服务器删除");
                on_progress("purge", i + 1, total, path);
                continue;
            }
            match self.target.delete(path).await {
                Ok(()) => {
                    state.remove(path);
                    self.log(vault_root, &format!("purge [{}] 已从服务器清理（排除的扩展名）", path));
                    report.push(path, "purge", true, "已从服务器清理（排除的扩展名）");
                }
                Err(e) => report.push(path, "purge", false, e.to_string()),
            }
            on_progress("purge", i + 1, total, path);
        }
    }

    /// Fetch the remote entry for one path (parent-directory listing).
    async fn remote_entry(&self, path: &str) -> Option<FileEntry> {
        let dir = Path::new(path).parent().map(|p| p.to_string_lossy().to_string()).unwrap_or_default();
        let entries = self.target.list(&dir).await.ok()?;
        entries.into_iter().find(|e| e.path == path)
    }

    async fn current_etag(&self, path: &str) -> Option<String> {
        // After PUT we get the etag directly; after GET we re-list. To stay
        // cheap, accept the state entry recorded at upload time; for
        // downloads, look the file up in a fresh listing of its directory.
        self.remote_entry(path).await.and_then(|e| e.etag)
    }

    fn record_state(
        &self,
        vault_root: &Path,
        path: &str,
        etag: Option<String>,
        state: &mut SyncState,
    ) -> Result<(), SyncError> {
        let full = vault_root.join(path);
        let meta = std::fs::metadata(&full).map_err(SyncError::Io)?;
        let hash = hash_local(vault_root, path)?;
        state.upsert(
            path,
            hash,
            meta.modified().ok()
                .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
                .map(|d| d.as_millis() as u64)
                .unwrap_or(0),
            meta.len(),
            etag,
        );
        Ok(())
    }

    fn write_local(&self, vault_root: &Path, path: &str, data: &[u8]) -> Result<(), SyncError> {
        let full = vault_root.join(path);
        if let Some(parent) = full.parent() {
            std::fs::create_dir_all(parent)?;
        }
        let tmp = full.with_extension("nf-sync-tmp");
        std::fs::write(&tmp, data)?;
        std::fs::rename(&tmp, &full)?;
        Ok(())
    }

    /// Move a local file into `.noteforge/trash/` preserving relative path
    /// plus a timestamp prefix to avoid collisions.
    fn local_trash(&self, vault_root: &Path, path: &str) -> Result<(), SyncError> {
        let stamp = chrono::Local::now().format("%Y%m%d-%H%M%S").to_string();
        let dest_rel = format!("{}/{}-{}", TRASH_DIR, stamp, path.replace('/', "_"));
        let dest = vault_root.join(&dest_rel);
        if let Some(parent) = dest.parent() {
            std::fs::create_dir_all(parent)?;
        }
        let src = vault_root.join(path);
        if src.exists() {
            std::fs::rename(&src, &dest)?;
        }
        Ok(())
    }

    /// Before the first sync, snapshot the losing side of every planned
    /// destructive action into `.noteforge/backup-首次同步前/`.
    async fn first_sync_backup(
        &self,
        vault_root: &Path,
        local: &[snapshot::LocalFile],
        on_progress: ProgressFn<'_>,
    ) -> Result<(), SyncError> {
        let backup_root = vault_root.join(".noteforge/backup-首次同步前");
        std::fs::create_dir_all(&backup_root)?;
        let total = local.len();
        for (i, f) in local.iter().enumerate() {
            let src = vault_root.join(&f.path);
            let dest = backup_root.join(&f.path);
            if let Some(parent) = dest.parent() {
                std::fs::create_dir_all(parent).ok();
            }
            std::fs::copy(&src, &dest).ok();
            if i % 20 == 0 || i == total.saturating_sub(1) {
                on_progress("backup", i + 1, total, &f.path);
            }
        }
        // Also snapshot remote files that will be downloaded over / deleted.
        let remote = self.list_remote().await?;
        let rtotal = remote.len();
        for (i, e) in remote.iter().enumerate() {
            if self.filter.ignored(&e.path) {
                continue;
            }
            if let Ok(raw) = self.target.get(&e.path).await {
                let dest = backup_root.join(&e.path);
                if let Some(parent) = dest.parent() {
                    std::fs::create_dir_all(parent).ok();
                }
                std::fs::write(dest, raw).ok();
            }
            if i % 20 == 0 || i == rtotal.saturating_sub(1) {
                on_progress("backup-remote", i + 1, rtotal, &e.path);
            }
        }
        Ok(())
    }

    /// Publish/refresh `nf-sync-meta.json` on the remote root (salt etc.).
    pub async fn publish_meta(&self, salt_b64: &str) -> Result<(), SyncError> {
        let meta = RemoteMeta {
            salt_b64: salt_b64.to_string(),
            encrypted: self.crypto.enabled(),
            app: "noteforge".into(),
        };
        let data = serde_json::to_vec_pretty(&meta)?;
        self.target.put(META_NAME, &data).await?;
        Ok(())
    }

    /// Fetch remote meta (None when absent).
    pub async fn fetch_meta(&self) -> Result<Option<RemoteMeta>, SyncError> {
        match self.target.get(META_NAME).await {
            Ok(data) => Ok(Some(serde_json::from_slice(&data)?)),
            Err(SyncError::NotFound(_)) => Ok(None),
            Err(e) => Err(e),
        }
    }
}
