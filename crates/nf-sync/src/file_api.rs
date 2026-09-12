use crate::error::SyncError;
use async_trait::async_trait;

/// A file entry from listing a sync target.
#[derive(Debug, Clone)]
pub struct FileEntry {
    /// Path relative to the sync root, `/`-separated, no leading slash.
    pub path: String,
    pub is_dir: bool,
    pub size: u64,
    pub updated_time: i64,
    /// Remote entity tag; changes whenever the content changes (Nextcloud etag).
    pub etag: Option<String>,
}

/// Abstract file operations that each sync driver must implement.
///
/// All paths are relative to the sync root and use `/` separators.
#[async_trait]
pub trait FileApi: Send + Sync {
    /// Create or overwrite a file. Returns the new remote etag when the
    /// server provides one (drivers must always return a usable value so
    /// the next diff round can skip unchanged files).
    async fn put(&self, path: &str, data: &[u8]) -> Result<Option<String>, SyncError>;

    /// Read a file's contents.
    async fn get(&self, path: &str) -> Result<Vec<u8>, SyncError>;

    /// Delete a file (Nextcloud moves it to its server-side trashbin).
    async fn delete(&self, path: &str) -> Result<(), SyncError>;

    /// Create a directory including parents (idempotent).
    async fn mkdir(&self, path: &str) -> Result<(), SyncError>;

    /// Recursively list all entries under the root (or a prefix).
    /// Directories are included as `is_dir` entries.
    async fn list(&self, prefix: &str) -> Result<Vec<FileEntry>, SyncError>;

    /// Test the connection and that the sync root is reachable.
    async fn test(&self) -> Result<(), SyncError>;
}
