/// Crypto errors
#[derive(Debug, thiserror::Error)]
pub enum CryptoError {
    #[error("encryption failed: {0}")]
    EncryptionFailed(String),

    #[error("decryption failed: {0}")]
    DecryptionFailed(String),

    #[error("invalid magic bytes: expected {0}, found {1}")]
    InvalidMagic(String, String),

    #[error("key derivation failed: {0}")]
    KeyDerivationFailed(String),

    #[error("data too short for encryption format")]
    DataTooShort,

    #[error("password verification failed")]
    PasswordMismatch,

    #[error("invalid key: {0}")]
    InvalidKey(String),

    #[error("IO error: {0}")]
    Io(#[from] std::io::Error),

    #[error("base64 decode error: {0}")]
    Base64Decode(#[from] base64::DecodeError),
}

/// Result alias for crypto operations
pub type CryptoResult<T> = std::result::Result<T, CryptoError>;

impl From<serde_json::Error> for CryptoError {
    fn from(e: serde_json::Error) -> Self {
        CryptoError::EncryptionFailed(format!("JSON: {}", e))
    }
}
