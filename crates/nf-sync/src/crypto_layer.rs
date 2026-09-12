//! Content encryption layer for vault mirror sync.
//!
//! When enabled, every file's bytes are AES-256-GCM encrypted (via
//! nf-crypto's binary format `[NFC1][nonce][ciphertext+tag]`) before
//! upload and decrypted after download, so the server only ever stores
//! ciphertext. The key is derived from a user password + salt
//! (Argon2id); the salt is published in the remote `nf-sync-meta.json`
//! so other devices can derive the same key from the same password.

use crate::error::SyncError;
use nf_crypto::{decrypt_binary_bytes, encrypt_binary, is_encrypted_binary, VaultKey};

pub struct SyncCrypto {
    key: Option<VaultKey>,
}

impl SyncCrypto {
    /// Plaintext mirror mode (no encryption).
    pub fn disabled() -> Self {
        SyncCrypto { key: None }
    }

    /// Encrypted mode: derive the AES key from password + base64 salt.
    pub fn with_password(password: &str, salt_b64: &str) -> Result<Self, SyncError> {
        use base64::Engine;
        let salt = base64::engine::general_purpose::STANDARD
            .decode(salt_b64)
            .map_err(|e| SyncError::Config(format!("无效的加密盐: {}", e)))?;
        if salt.is_empty() {
            return Err(SyncError::Config("加密盐为空".into()));
        }
        let key = VaultKey::derive_with_salt(password, &salt)?;
        Ok(SyncCrypto { key: Some(key) })
    }

    pub fn enabled(&self) -> bool {
        self.key.is_some()
    }

    /// Prepare file content for upload. No-op when disabled.
    pub fn seal(&self, plain: &[u8]) -> Result<Vec<u8>, SyncError> {
        match &self.key {
            None => Ok(plain.to_vec()),
            Some(k) => Ok(encrypt_binary(k, plain)?),
        }
    }

    /// Restore downloaded content to plaintext. When encryption is on,
    /// non-encrypted remote content is rejected (mode-mismatch guard)
    /// instead of silently overwriting local files with ciphertext.
    pub fn open(&self, data: &[u8]) -> Result<Vec<u8>, SyncError> {
        match &self.key {
            None => Ok(data.to_vec()),
            Some(k) => {
                if !is_encrypted_binary(data) {
                    return Err(SyncError::DecryptFailed(
                        "远端文件不是加密格式（可能由明文模式上传），已跳过以免破坏本地数据".into(),
                    ));
                }
                decrypt_binary_bytes(k, data).map_err(Into::into)
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use nf_crypto::generate_salt_b64;

    #[test]
    fn roundtrip_encrypt_decrypt() {
        let c = SyncCrypto::with_password("pw123", &generate_salt_b64()).unwrap();
        assert!(c.enabled());
        let data = "# 你好 NoteForge\n\n- [ ] 任务".as_bytes();
        let sealed = c.seal(data).unwrap();
        assert_ne!(&sealed, data);
        assert!(is_encrypted_binary(&sealed));
        let opened = c.open(&sealed).unwrap();
        assert_eq!(opened, data);
    }

    #[test]
    fn same_password_same_salt_same_key() {
        let salt = generate_salt_b64();
        let a = SyncCrypto::with_password("pw", &salt).unwrap();
        let b = SyncCrypto::with_password("pw", &salt).unwrap();
        let sealed = a.seal(b"secret").unwrap();
        assert_eq!(b.open(&sealed).unwrap(), b"secret");
    }

    #[test]
    fn wrong_password_fails_to_open() {
        let salt = generate_salt_b64();
        let a = SyncCrypto::with_password("pw", &salt).unwrap();
        let b = SyncCrypto::with_password("other", &salt).unwrap();
        let sealed = a.seal(b"secret").unwrap();
        assert!(b.open(&sealed).is_err());
    }

    #[test]
    fn disabled_passthrough() {
        let c = SyncCrypto::disabled();
        assert!(!c.enabled());
        assert_eq!(c.seal(b"x").unwrap(), b"x");
        assert_eq!(c.open(b"x").unwrap(), b"x");
    }

    #[test]
    fn encrypted_mode_rejects_plaintext_remote() {
        let c = SyncCrypto::with_password("pw", &generate_salt_b64()).unwrap();
        assert!(c.open(b"plain markdown").is_err());
    }
}
