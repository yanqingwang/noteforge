use crate::error::SyncError;
use crate::file_api::{FileApi, FileEntry};
use async_trait::async_trait;
use nf_crypto::joplin_e2ee::JoplinE2ee;

/// Joplin-compatible E2EE for sync operations.
///
/// Joplin encrypts at the ITEM level, not the file level:
/// - Master key items (type_=9) store a password-wrapped 512-hex key.
/// - Data items (notes/resources) store their content in `encryption_cipher_text`
///   as JED01-format ciphertext (StringV1 for text, FileV1 for blobs).
///
/// This layer provides:
/// - `encrypt_item` / `decrypt_item` for SyncItem serialization (StringV1)
/// - Master key management (generate / load from password)
pub struct JoplinE2eeLayer {
    e2ee: JoplinE2ee,
}

impl JoplinE2eeLayer {
    pub fn new() -> Self {
        JoplinE2eeLayer { e2ee: JoplinE2ee::new() }
    }

    /// Generate a new master key and load it.
    /// Returns (master_key_id, encrypted_content_json).
    pub fn generate_and_load_master_key(&mut self, password: &str, id: &str) -> Result<(String, String), SyncError> {
        let (key_id, content) = self.e2ee.generate_master_key(password, id)?;
        self.e2ee.load_master_key(&key_id, password, &content)?;
        Ok((key_id, content))
    }

    /// Load an existing master key from its encrypted content.
    pub fn load_master_key(&mut self, master_key_id: &str, password: &str, content: &str) -> Result<(), SyncError> {
        self.e2ee.load_master_key(master_key_id, password, content)
            .map_err(|e| SyncError::Other(format!("load master key: {}", e)))
    }

    pub fn has_loaded_keys(&self) -> bool { self.e2ee.has_loaded_keys() }

    pub fn loaded_key_ids(&self) -> Vec<String> { self.e2ee.loaded_key_ids() }

    /// Encrypt a serialized item (StringV1, JED01 format).
    pub fn encrypt_item(&self, serialized: &str, master_key_id: &str) -> Result<String, SyncError> {
        self.e2ee.encrypt_item(serialized, master_key_id)
            .map_err(|e| SyncError::Other(format!("encrypt item: {}", e)))
    }

    /// Decrypt a serialized item cipher text (StringV1).
    pub fn decrypt_item(&self, cipher_text: &str) -> Result<String, SyncError> {
        self.e2ee.decrypt_item(cipher_text)
            .map_err(|e| SyncError::Other(format!("decrypt item: {}", e)))
    }

    /// Encrypt binary resource data (FileV1).
    pub fn encrypt_blob(&self, data: &[u8], master_key_id: &str) -> Result<String, SyncError> {
        self.e2ee.encrypt_blob(data, master_key_id)
            .map_err(|e| SyncError::Other(format!("encrypt blob: {}", e)))
    }

    /// Decrypt binary resource data (FileV1).
    pub fn decrypt_blob(&self, cipher_text: &str) -> Result<Vec<u8>, SyncError> {
        self.e2ee.decrypt_blob(cipher_text)
            .map_err(|e| SyncError::Other(format!("decrypt blob: {}", e)))
    }
}

/// Backward-compatible FileApi wrapper for local vault key encryption.
/// Deprecated in favor of JoplinE2eeLayer for Joplin-compatible sync.
#[deprecated(note = "use JoplinE2eeLayer for Joplin-compatible E2EE")]
pub struct EncryptionLayer {
    inner: Box<dyn FileApi>,
    key: nf_crypto::VaultKey,
}

#[allow(deprecated)]
impl EncryptionLayer {
    pub fn new(inner: Box<dyn FileApi>, key: nf_crypto::VaultKey) -> Self {
        EncryptionLayer { inner, key }
    }
}

#[allow(deprecated)]
#[async_trait]
impl FileApi for EncryptionLayer {
    async fn create(&self, path: &str, data: &[u8]) -> Result<(), SyncError> {
        let encrypted = nf_crypto::encrypt(&self.key, data)
            .map_err(|e| SyncError::Other(format!("encryption failed: {}", e)))?;
        self.inner.create(path, encrypted.as_bytes()).await
    }

    async fn put(&self, path: &str, data: &[u8]) -> Result<(), SyncError> {
        let encrypted = nf_crypto::encrypt(&self.key, data)
            .map_err(|e| SyncError::Other(format!("encryption failed: {}", e)))?;
        self.inner.put(path, encrypted.as_bytes()).await
    }

    async fn get(&self, path: &str) -> Result<Vec<u8>, SyncError> {
        let encrypted = self.inner.get(path).await?;
        let s = std::str::from_utf8(&encrypted)
            .map_err(|e| SyncError::Other(format!("invalid UTF-8 in encrypted data: {}", e)))?;
        if nf_crypto::is_encrypted(s) {
            nf_crypto::decrypt(&self.key, s)
                .map(|d| d.into_bytes())
                .map_err(|e| SyncError::Other(format!("decryption failed: {}", e)))
        } else {
            Ok(encrypted)
        }
    }

    async fn delete(&self, path: &str) -> Result<(), SyncError> {
        self.inner.delete(path).await
    }

    async fn list(&self, prefix: &str) -> Result<Vec<FileEntry>, SyncError> {
        self.inner.list(prefix).await
    }

    async fn test(&self) -> Result<(), SyncError> {
        self.inner.test().await
    }
}