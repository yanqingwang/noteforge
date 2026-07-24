use crate::error::SyncError;
use async_trait::async_trait;

/// A file entry from listing a sync target.
#[derive(Debug, Clone)]
pub struct FileEntry {
    pub path: String,
    pub is_dir: bool,
    pub size: u64,
    pub updated_time: i64,
}

/// Abstract file operations that each sync driver must implement.
#[async_trait]
pub trait FileApi: Send + Sync {
    /// Create a new file (fails if exists).
    async fn create(&self, path: &str, data: &[u8]) -> Result<(), SyncError>;

    /// Create or overwrite a file.
    async fn put(&self, path: &str, data: &[u8]) -> Result<(), SyncError>;

    /// Read a file's contents.
    async fn get(&self, path: &str) -> Result<Vec<u8>, SyncError>;

    /// Delete a file.
    async fn delete(&self, path: &str) -> Result<(), SyncError>;

    /// List files under a prefix/directory.
    async fn list(&self, prefix: &str) -> Result<Vec<FileEntry>, SyncError>;

    /// Check if a file exists.
    async fn exists(&self, path: &str) -> Result<bool, SyncError> {
        match self.get(path).await {
            Ok(_) => Ok(true),
            Err(SyncError::NotFound(_)) => Ok(false),
            Err(e) => Err(e),
        }
    }

    /// Test the connection (e.g., ping or list root).
    async fn test(&self) -> Result<(), SyncError>;
}