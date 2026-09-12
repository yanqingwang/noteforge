//! nf-crypto — End-to-End Encryption for NoteForge
//!
//! Provides AES-256-GCM encryption, Argon2id key derivation,
//! password verification, and transparent encrypt/decrypt
//! for vault notes and sync operations.

pub mod constants;
pub mod cipher;
pub mod error;
pub mod key;
pub mod salt;

pub use cipher::{decrypt, decrypt_binary, decrypt_binary_bytes, encrypt, encrypt_binary, is_encrypted, is_encrypted_binary};
pub use constants::MAGIC;
pub use error::{CryptoError, CryptoResult};
pub use key::VaultKey;
pub use salt::{generate_salt, generate_salt_b64};
