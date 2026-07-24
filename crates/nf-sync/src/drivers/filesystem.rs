use crate::error::SyncError;
use crate::file_api::{FileApi, FileEntry};
use async_trait::async_trait;
use std::path::{Path, PathBuf};

pub struct FsDriver {
    root: PathBuf,
}

impl FsDriver {
    pub fn new(root: impl Into<PathBuf>) -> Self {
        FsDriver { root: root.into() }
    }

    fn full_path(&self, path: &str) -> PathBuf {
        // Strip leading slash to avoid absolute paths
        let clean = path.trim_start_matches('/');
        self.root.join(clean)
    }
}

#[async_trait]
impl FileApi for FsDriver {
    async fn create(&self, path: &str, data: &[u8]) -> Result<(), SyncError> {
        let full = self.full_path(path);
        if full.exists() {
            return Err(SyncError::Other(format!("File exists: {}", path)));
        }
        if let Some(parent) = full.parent() {
            tokio::fs::create_dir_all(parent).await?;
        }
        tokio::fs::write(&full, data).await?;
        Ok(())
    }

    async fn put(&self, path: &str, data: &[u8]) -> Result<(), SyncError> {
        let full = self.full_path(path);
        if let Some(parent) = full.parent() {
            tokio::fs::create_dir_all(parent).await?;
        }
        tokio::fs::write(&full, data).await?;
        Ok(())
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

    async fn list(&self, prefix: &str) -> Result<Vec<FileEntry>, SyncError> {
        let dir = self.full_path(prefix);
        let mut entries = Vec::new();
        if !dir.exists() {
            return Ok(entries);
        }
        let mut read_dir = tokio::fs::read_dir(&dir).await?;
        while let Some(entry) = read_dir.next_entry().await? {
            let meta = entry.metadata().await?;
            let rel = match entry.path().strip_prefix(&self.root) {
                Ok(p) => p.to_string_lossy().to_string(),
                Err(_) => entry.path().to_string_lossy().to_string(),
            };
            entries.push(FileEntry {
                path: rel,
                is_dir: meta.is_dir(),
                size: meta.len(),
                updated_time: meta.modified()
                    .ok()
                    .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
                    .map(|d| d.as_millis() as i64)
                    .unwrap_or(0),
            });
        }
        Ok(entries)
    }

    async fn test(&self) -> Result<(), SyncError> {
        let dir = &self.root;
        tokio::fs::create_dir_all(dir).await?;
        // Write and read a test file
        let test_path = dir.join(".sync_test");
        tokio::fs::write(&test_path, b"ok").await?;
        let content = tokio::fs::read_to_string(&test_path).await?;
        tokio::fs::remove_file(&test_path).await?;
        if content == "ok" {
            Ok(())
        } else {
            Err(SyncError::Other("Filesystem test failed".into()))
        }
    }
}