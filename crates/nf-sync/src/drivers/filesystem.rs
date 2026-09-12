//! Local-filesystem FileApi driver.
//!
//! Used for unit/integration tests and for "sync to a local folder"
//! setups. Etags are synthesized from mtime+size so the diff algorithm
//! behaves the same as against a real WebDAV server.

use crate::error::SyncError;
use crate::file_api::{FileApi, FileEntry};
use async_trait::async_trait;
use std::path::PathBuf;

pub struct FsDriver {
    root: PathBuf,
}

impl FsDriver {
    pub fn new(root: impl Into<PathBuf>) -> Self {
        FsDriver { root: root.into() }
    }

    fn full_path(&self, path: &str) -> PathBuf {
        // Strip leading slash to avoid absolute paths
        self.root.join(path.trim_start_matches('/'))
    }

    fn etag_of(meta: &std::fs::Metadata) -> String {
        let mtime = meta
            .modified()
            .ok()
            .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
            .map(|d| d.as_nanos())
            .unwrap_or(0);
        format!("fs-{:x}-{}", mtime, meta.len())
    }
}

#[async_trait]
impl FileApi for FsDriver {
    async fn put(&self, path: &str, data: &[u8]) -> Result<Option<String>, SyncError> {
        let full = self.full_path(path);
        if let Some(parent) = full.parent() {
            tokio::fs::create_dir_all(parent).await?;
        }
        // Atomic-ish write: temp file + rename
        let tmp = full.with_extension("nf-sync-tmp");
        tokio::fs::write(&tmp, data).await?;
        tokio::fs::rename(&tmp, &full).await?;
        let meta = tokio::fs::metadata(&full).await?;
        Ok(Some(Self::etag_of(&meta)))
    }

    async fn get(&self, path: &str) -> Result<Vec<u8>, SyncError> {
        let full = self.full_path(path);
        if !full.exists() {
            return Err(SyncError::NotFound(path.to_string()));
        }
        Ok(tokio::fs::read(&full).await?)
    }

    async fn delete(&self, path: &str) -> Result<(), SyncError> {
        let full = self.full_path(path);
        if !full.exists() {
            return Err(SyncError::NotFound(path.to_string()));
        }
        tokio::fs::remove_file(&full).await?;
        Ok(())
    }

    async fn mkdir(&self, path: &str) -> Result<(), SyncError> {
        tokio::fs::create_dir_all(self.full_path(path)).await?;
        Ok(())
    }

    async fn list(&self, prefix: &str) -> Result<Vec<FileEntry>, SyncError> {
        let base = self.full_path(prefix);
        let mut entries = Vec::new();
        if !base.exists() {
            return Ok(entries);
        }
        for entry in walkdir::WalkDir::new(&base)
            .min_depth(if prefix.trim_matches('/').is_empty() { 1 } else { 0 })
            .into_iter()
            .filter_map(|e| e.ok())
        {
            let meta = match entry.metadata() {
                Ok(m) => m,
                Err(_) => continue,
            };
            let rel = match entry.path().strip_prefix(&self.root) {
                Ok(p) => p.to_string_lossy().to_string(),
                Err(_) => continue,
            };
            if rel.is_empty() {
                continue;
            }
            entries.push(FileEntry {
                path: rel,
                is_dir: meta.is_dir(),
                size: meta.len(),
                updated_time: meta
                    .modified()
                    .ok()
                    .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
                    .map(|d| d.as_millis() as i64)
                    .unwrap_or(0),
                etag: if meta.is_dir() { None } else { Some(Self::etag_of(&meta)) },
            });
        }
        Ok(entries)
    }

    async fn test(&self) -> Result<(), SyncError> {
        tokio::fs::create_dir_all(&self.root).await?;
        Ok(())
    }
}
