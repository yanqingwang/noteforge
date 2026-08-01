use crate::file_api::{FileApi, FileEntry};
use async_trait::async_trait;
use nf_crypto::VaultKey;

/// A FileApi wrapper that encrypts on write and decrypts on read.
/// Provides transparent end-to-end encryption for sync operations.
pub struct EncryptionLayer {
    inner: Box<dyn FileApi>,
    key: VaultKey,
}

impl EncryptionLayer {
    pub fn new(inner: Box<dyn FileApi>, key: VaultKey) -> Self {
        EncryptionLayer { inner, key }
    }
}

#[async_trait]
impl FileApi for EncryptionLayer {
    async fn create(&self, path: &str, data: &[u8]) -> Result<(), crate::error::SyncError> {
        let encrypted = nf_crypto::encrypt(&self.key, data)
            .map_err(|e| crate::error::SyncError::Other(format!("encryption failed: {}", e)))?;
        self.inner.create(path, encrypted.as_bytes()).await
    }

    async fn put(&self, path: &str, data: &[u8]) -> Result<(), crate::error::SyncError> {
        let encrypted = nf_crypto::encrypt(&self.key, data)
            .map_err(|e| crate::error::SyncError::Other(format!("encryption failed: {}", e)))?;
        self.inner.put(path, encrypted.as_bytes()).await
    }

    async fn get(&self, path: &str) -> Result<Vec<u8>, crate::error::SyncError> {
        let encrypted = self.inner.get(path).await?;
        let s = std::str::from_utf8(&encrypted)
            .map_err(|e| crate::error::SyncError::Other(format!("invalid UTF-8 in encrypted data: {}", e)))?;
        if nf_crypto::is_encrypted(s) {
            nf_crypto::decrypt(&self.key, s)
                .map(|d| d.into_bytes())
                .map_err(|e| crate::error::SyncError::Other(format!("decryption failed: {}", e)))
        } else {
            Ok(encrypted)
        }
    }

    async fn delete(&self, path: &str) -> Result<(), crate::error::SyncError> {
        self.inner.delete(path).await
    }

    async fn list(&self, prefix: &str) -> Result<Vec<FileEntry>, crate::error::SyncError> {
        self.inner.list(prefix).await
    }

    async fn test(&self) -> Result<(), crate::error::SyncError> {
        self.inner.test().await
    }
}
