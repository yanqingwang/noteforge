//! Vault mirror engine: scan → diff → apply → report.
//!
//! Safety rules baked into the applier:
//! - Every delete lands in a trash (local `.noteforge/trash/` or the
//!   Nextcloud server trashbin) — nothing is destroyed outright.
//! - Downloaded remote content is decrypted (when encryption is on)
//!   before it ever touches a local file; decrypt failure aborts that
//!   file, never the whole sync.
//! - Local writes go through temp-file + rename.
//! - A first sync writes a one-time safety backup of the losing side.

pub mod diff;
pub mod ignore;
pub mod report;
pub mod snapshot;
pub mod state;

use crate::crypto_layer::SyncCrypto;
use crate::error::SyncError;
use crate::file_api::FileApi;
use crate::mirror::diff::{build_plan, Action, Direction, FirstSyncPolicy};
use crate::mirror::ignore::IgnoreRules;
use crate::mirror::report::SyncReport;
use crate::mirror::snapshot::{hash_local, read_local, scan_local};
use crate::mirror::state::SyncState;
use std::path::Path;

pub const META_NAME: &str = "nf-sync-meta.json";
const TRASH_DIR: &str = ".noteforge/trash";

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
    ignore: IgnoreRules,
    direction: Direction,
    first_policy: FirstSyncPolicy,
}

/// Progress callback: (phase, done, total, current_path).
pub type ProgressFn<'p> = &'p (dyn Fn(&str, usize, usize, &str) + Send + Sync);

impl<'a> MirrorEngine<'a> {
    pub fn new(
        target: &'a dyn FileApi,
        crypto: SyncCrypto,
        ignore: IgnoreRules,
        direction: Direction,
        first_policy: FirstSyncPolicy,
    ) -> Self {
        MirrorEngine { target, crypto, ignore, direction, first_policy }
    }

    /// List remote files under the sync root (files only, ignore rules applied).
    pub async fn list_remote(&self) -> Result<Vec<crate::file_api::FileEntry>, SyncError> {
        let entries = self.target.list("").await?;
        Ok(entries
            .into_iter()
            .filter(|e| !e.is_dir && !self.ignore.ignored(&e.path))
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

        on_progress("scan-local", 0, 1, "");
        let local = scan_local(vault_root, &self.ignore)?;
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

        on_progress("apply", 0, total, "");
        for (i, action) in plan.actions.iter().enumerate() {
            let path = action.path().to_string();
            let result = self.apply_action(vault_root, action, &mut state).await;
            match result {
                Ok((kind, msg)) => {
                    report.push(&path, kind, true, msg);
                }
                Err(e) => {
                    report.push(&path, action.kind(), false, e.to_string());
                }
            }
            on_progress("apply", i + 1, total, &path);
        }

        state.last_sync_at = chrono::Utc::now().timestamp();
        state.save(vault_root)?;
        report.finished_at = chrono::Utc::now().timestamp();
        Ok(report)
    }

    /// Execute one planned action and record the new baseline entry.
    #[allow(clippy::type_complexity)]
    async fn apply_action(
        &mut self,
        vault_root: &Path,
        action: &Action,
        state: &mut SyncState,
    ) -> Result<(&'static str, String), SyncError> {
        match action {
            Action::Upload { path } | Action::Reupload { path } => {
                let plain = read_local(vault_root, path)?;
                let etag = self.write_remote_sealed(path, &plain).await?;
                self.record_state(vault_root, path, etag, state)?;
                let kind = if matches!(action, Action::Reupload { .. }) { "reupload" } else { "upload" };
                Ok((kind, "已上传".into()))
            }
            Action::Download { path } => {
                let plain = self.read_remote_plain(path).await?;
                self.write_local(vault_root, path, &plain)?;
                let etag = self.current_etag(path).await;
                self.record_state(vault_root, path, etag, state)?;
                Ok(("download", "已下载".into()))
            }
            Action::Restore { path } => {
                // Deleted locally, changed remotely → download back
                let plain = self.read_remote_plain(path).await?;
                self.write_local(vault_root, path, &plain)?;
                let etag = self.current_etag(path).await;
                self.record_state(vault_root, path, etag, state)?;
                Ok(("restore", "本地已删除但远端有更新，已恢复".into()))
            }
            Action::Compare { path } => {
                // First sync, both sides have the file: content-compare
                let plain = self.read_remote_plain(path).await?;
                let local_plain = read_local(vault_root, path)?;
                let remote_hash = crate::mirror::snapshot::sha256_hex(&plain);
                let local_hash = crate::mirror::snapshot::sha256_hex(&local_plain);
                if remote_hash == local_hash {
                    let etag = self.current_etag(path).await;
                    self.record_state(vault_root, path, etag, state)?;
                    Ok(("compare-equal", "两侧内容一致".into()))
                } else {
                    // Diverged before ever syncing: keep both.
                    let backup = self.conflict_backup(vault_root, path, &local_plain)?;
                    self.write_local(vault_root, path, &plain)?;
                    let etag = self.current_etag(path).await;
                    self.record_state(vault_root, path, etag, state)?;
                    Ok(("conflict", format!("首次同步两侧内容不同，本地版本已保留为 {}", backup)))
                }
            }
            Action::Conflict { path } => {
                let local_plain = read_local(vault_root, path)?;
                let backup = self.conflict_backup(vault_root, path, &local_plain)?;
                let plain = self.read_remote_plain(path).await?;
                self.write_local(vault_root, path, &plain)?;
                let etag = self.current_etag(path).await;
                self.record_state(vault_root, path, etag, state)?;
                Ok(("conflict", format!("双方都修改了此文件，本地版本已保留为 {}", backup)))
            }
            Action::DeleteRemote { path } => {
                self.target.delete(path).await?;
                state.remove(path);
                Ok(("delete-remote", "远端已删除（服务器回收站可恢复）".into()))
            }
            Action::DeleteLocal { path } => {
                self.local_trash(vault_root, path)?;
                state.remove(path);
                Ok(("delete-local", "远端已删除，本地文件移入 .noteforge/trash/".into()))
            }
        }
    }

    async fn current_etag(&self, path: &str) -> Option<String> {
        // After PUT we get the etag directly; after GET we re-list. To stay
        // cheap, accept the state entry recorded at upload time; for
        // downloads, look the file up in a fresh listing of its directory.
        let dir = std::path::Path::new(path).parent().map(|p| p.to_string_lossy().to_string()).unwrap_or_default();
        if let Ok(entries) = self.target.list(&dir).await {
            if let Some(e) = entries.into_iter().find(|e| e.path == path) {
                return e.etag;
            }
        }
        None
    }

    fn record_state(
        &self,
        vault_root: &Path,
        path: &str,
        etag: Option<String>,
        state: &mut SyncState,
    ) -> Result<(), SyncError> {
        let full = vault_root.join(path);
        let meta = std::fs::metadata(&full).map_err(|e| SyncError::Io(e))?;
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

    /// Keep both versions: local copy becomes `name (冲突 YYYYMMDD-HHMMSS).ext`.
    fn conflict_backup(&self, vault_root: &Path, path: &str, local_plain: &[u8]) -> Result<String, SyncError> {
        let stamp = chrono::Local::now().format("%Y%m%d-%H%M%S").to_string();
        let p = std::path::Path::new(path);
        let stem = p.file_stem().map(|s| s.to_string_lossy().to_string()).unwrap_or_default();
        let ext = p.extension().map(|s| format!(".{}", s.to_string_lossy())).unwrap_or_default();
        let parent = p.parent().map(|d| d.to_string_lossy().to_string()).unwrap_or_default();
        let backup_rel = if parent.is_empty() {
            format!("{} (冲突 {}).{}", stem, stamp, ext.trim_start_matches('.'))
        } else {
            format!("{}/{} (冲突 {}).{}", parent, stem, stamp, ext.trim_start_matches('.'))
        };
        let backup_rel = if ext.is_empty() { backup_rel.trim_end_matches('.').to_string() } else { backup_rel };
        self.write_local(vault_root, &backup_rel, local_plain)?;
        Ok(backup_rel)
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
            if self.ignore.ignored(&e.path) {
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
