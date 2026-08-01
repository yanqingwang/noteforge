use crate::constants::*;
use crate::error::{CryptoError, CryptoResult};
use aes_gcm::aead::KeyInit;
use aes_gcm::Aes256Gcm;
use argon2::password_hash::{PasswordHash, PasswordHasher, PasswordVerifier, SaltString};
use aes_gcm::aead::OsRng;
use zeroize::Zeroize;

/// Encryption key derived from password via Argon2id.
/// Implements Drop to zeroize memory on cleanup.
#[derive(Clone)]
pub struct VaultKey {
    /// AES-256 key material
    pub(crate) key_bytes: [u8; KEY_LEN],
}

impl VaultKey {
    /// Derive an AES-256 key from password using Argon2id.
    pub fn derive(password: &str) -> CryptoResult<Self> {
        let salt = crate::salt::generate_salt();
        Self::derive_with_salt(password, &salt)
    }

    /// Derive from password + known salt (for unlocking).
    pub fn derive_with_salt(password: &str, salt: &[u8]) -> CryptoResult<Self> {
        let mut key_bytes = [0u8; KEY_LEN];

        argon2::Argon2::new(
            argon2::Algorithm::Argon2id,
            argon2::Version::V0x13,
            argon2::Params::new(
                ARGON_MEMORY,
                ARGON_ITERATIONS,
                ARGON_PARALLELISM,
                Some(KEY_LEN),
            )
            .map_err(|e| CryptoError::KeyDerivationFailed(e.to_string()))?,
        )
        .hash_password_into(
            password.as_bytes(),
            salt,
            &mut key_bytes,
        )
        .map_err(|e| CryptoError::KeyDerivationFailed(e.to_string()))?;

        Ok(VaultKey { key_bytes })
    }

    /// Compute password hash (for verification/storage).
    /// Returns (base64_hash, base64_salt)
    pub fn password_hash(password: &str) -> CryptoResult<(String, String)> {
        let salt = SaltString::generate(&mut OsRng);
        let hash = PasswordHasher::hash_password(
            &argon2::Argon2::default(),
            password.as_bytes(),
            &salt,
        )
        .map_err(|e| CryptoError::KeyDerivationFailed(e.to_string()))?
        .to_string();

        let salt_bytes = crate::salt::generate_salt();
        let salt_b64 = base64::Engine::encode(&base64::engine::general_purpose::STANDARD, &salt_bytes);

        Ok((hash, salt_b64))
    }

    /// Verify password against stored hash and salt.
    pub fn verify_password(password: &str, hash: &str, _salt_b64: &str) -> CryptoResult<bool> {
        let parsed_hash = PasswordHash::new(hash)
            .map_err(|e| CryptoError::KeyDerivationFailed(e.to_string()))?;

        Ok(argon2::Argon2::default()
            .verify_password(password.as_bytes(), &parsed_hash)
            .is_ok())
    }

    /// Create an AES-256-GCM cipher instance
    pub(crate) fn cipher(&self) -> Aes256Gcm {
        Aes256Gcm::new_from_slice(&self.key_bytes)
            .expect("KEY_LEN is 32 bytes, this cannot fail")
    }
}

impl Drop for VaultKey {
    fn drop(&mut self) {
        self.key_bytes.zeroize();
    }
}

impl std::fmt::Debug for VaultKey {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("VaultKey").finish_non_exhaustive()
    }
}
