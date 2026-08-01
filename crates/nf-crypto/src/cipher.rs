use crate::constants::*;
use crate::error::CryptoError;
use crate::key::VaultKey;
use aes_gcm::aead::Aead;
use base64::Engine;
use generic_array::typenum::U12;
use generic_array::GenericArray;
use rand::Rng;

/// Format: "NFC1:<base64_nonce>:<base64_ciphertext_with_tag>"

/// Create a 12-byte nonce from a slice.
fn make_nonce(bytes: &[u8]) -> GenericArray<u8, U12> {
    let mut arr = GenericArray::default();
    arr.copy_from_slice(bytes);
    arr
}

/// Encrypt plaintext using AES-256-GCM. Returns formatted ciphertext string.
/// Format: "NFC1:<nonce_b64>:<ciphertext_b64>"
pub fn encrypt(key: &VaultKey, plaintext: &[u8]) -> Result<String, CryptoError> {
    let mut nonce_bytes = [0u8; NONCE_LEN];
    rand::rng().fill(&mut nonce_bytes);
    let nonce = make_nonce(&nonce_bytes);

    let cipher = key.cipher();
    let ciphertext = cipher
        .encrypt(&nonce, plaintext)
        .map_err(|e| CryptoError::EncryptionFailed(e.to_string()))?;

    let nonce_b64 = base64::engine::general_purpose::STANDARD.encode(&nonce_bytes);
    let ct_b64 = base64::engine::general_purpose::STANDARD.encode(&ciphertext);

    Ok(format!("{}:{}:{}", MAGIC_STR, nonce_b64, ct_b64))
}

/// Decrypt ciphertext from the format produced by `encrypt()`.
pub fn decrypt(key: &VaultKey, data: &str) -> Result<String, CryptoError> {
    let parts: Vec<&str> = data.splitn(3, ':').collect();
    if parts.len() != 3 {
        return Err(CryptoError::DataTooShort);
    }
    if parts[0] != MAGIC_STR {
        return Err(CryptoError::InvalidMagic(
            MAGIC_STR.to_string(),
            parts[0].to_string(),
        ));
    }

    let nonce_bytes = base64::engine::general_purpose::STANDARD
        .decode(parts[1])
        .map_err(|_| CryptoError::DecryptionFailed("invalid nonce base64".into()))?;

    let ciphertext = base64::engine::general_purpose::STANDARD
        .decode(parts[2])
        .map_err(|_| CryptoError::DecryptionFailed("invalid ciphertext base64".into()))?;

    let nonce = make_nonce(&nonce_bytes);
    let cipher = key.cipher();
    let plaintext = cipher
        .decrypt(&nonce, ciphertext.as_ref())
        .map_err(|e| CryptoError::DecryptionFailed(e.to_string()))?;

    String::from_utf8(plaintext)
        .map_err(|e| CryptoError::DecryptionFailed(format!("invalid UTF-8: {}", e)))
}

/// Encrypt raw bytes, returning binary format: [MAGIC][nonce][ciphertext]
pub fn encrypt_binary(key: &VaultKey, plaintext: &[u8]) -> Result<Vec<u8>, CryptoError> {
    let mut nonce_bytes = [0u8; NONCE_LEN];
    rand::rng().fill(&mut nonce_bytes);
    let nonce = make_nonce(&nonce_bytes);

    let cipher = key.cipher();
    let ciphertext = cipher
        .encrypt(&nonce, plaintext)
        .map_err(|e| CryptoError::EncryptionFailed(e.to_string()))?;

    let mut result = Vec::with_capacity(4 + NONCE_LEN + ciphertext.len());
    result.extend_from_slice(MAGIC);
    result.extend_from_slice(&nonce_bytes);
    result.extend_from_slice(&ciphertext);
    Ok(result)
}

/// Decrypt binary format produced by `encrypt_binary()`.
pub fn decrypt_binary(key: &VaultKey, data: &[u8]) -> Result<String, CryptoError> {
    if data.len() < 4 + NONCE_LEN + TAG_LEN {
        return Err(CryptoError::DataTooShort);
    }
    if &data[..4] != MAGIC {
        return Err(CryptoError::InvalidMagic(
            MAGIC_STR.to_string(),
            String::from_utf8_lossy(&data[..4]).to_string(),
        ));
    }

    let nonce_bytes = &data[4..4 + NONCE_LEN];
    let ciphertext = &data[4 + NONCE_LEN..];
    let nonce = make_nonce(nonce_bytes);

    let cipher = key.cipher();
    let plaintext = cipher
        .decrypt(&nonce, ciphertext)
        .map_err(|e| CryptoError::DecryptionFailed(e.to_string()))?;

    String::from_utf8(plaintext)
        .map_err(|e| CryptoError::DecryptionFailed(format!("invalid UTF-8: {}", e)))
}

/// Check if a string starts with the NFC1 magic prefix (indicating encrypted content).
pub fn is_encrypted(data: &str) -> bool {
    data.starts_with(MAGIC_STR)
}

/// Check if binary data starts with NFC1 magic bytes.
pub fn is_encrypted_binary(data: &[u8]) -> bool {
    data.len() >= 4 && &data[..4] == MAGIC
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::key::VaultKey;

    #[test]
    fn test_encrypt_decrypt_roundtrip() {
        let key = VaultKey::derive("test-password").unwrap();
        let plaintext = "Hello, 世界! This is a secret note.";
        let encrypted = encrypt(&key, plaintext.as_bytes()).unwrap();
        assert!(encrypted.starts_with("NFC1:"));
        let decrypted = decrypt(&key, &encrypted).unwrap();
        assert_eq!(plaintext, decrypted);
    }

    #[test]
    fn test_wrong_key_fails() {
        let key1 = VaultKey::derive("password1").unwrap();
        let key2 = VaultKey::derive("password2").unwrap();
        let encrypted = encrypt(&key1, b"secret").unwrap();
        assert!(decrypt(&key2, &encrypted).is_err());
    }

    #[test]
    fn test_is_encrypted() {
        assert!(is_encrypted("NFC1:abc:def"));
        assert!(!is_encrypted("plain text"));
        assert!(is_encrypted_binary(b"NFC1hello"));
        assert!(!is_encrypted_binary(b"plain"));
    }

    #[test]
    fn test_empty_content() {
        let key = VaultKey::derive("pw").unwrap();
        let encrypted = encrypt(&key, b"").unwrap();
        let decrypted = decrypt(&key, &encrypted).unwrap();
        assert_eq!("", decrypted);
    }

    #[test]
    fn test_unicode_content() {
        let key = VaultKey::derive("pw").unwrap();
        let plaintext = "中文测试 🎉 emoji 日本語 한국어";
        let encrypted = encrypt(&key, plaintext.as_bytes()).unwrap();
        let decrypted = decrypt(&key, &encrypted).unwrap();
        assert_eq!(plaintext, decrypted);
    }

    #[test]
    fn test_large_content() {
        let key = VaultKey::derive("pw").unwrap();
        let plaintext = "A".repeat(100_000);
        let encrypted = encrypt(&key, plaintext.as_bytes()).unwrap();
        let decrypted = decrypt(&key, &encrypted).unwrap();
        assert_eq!(plaintext, decrypted);
    }

    #[test]
    fn test_binary_format_roundtrip() {
        let key = VaultKey::derive("pw").unwrap();
        let plaintext = "binary test";
        let encrypted = encrypt_binary(&key, plaintext.as_bytes()).unwrap();
        assert_eq!(&encrypted[..4], MAGIC);
        let decrypted = decrypt_binary(&key, &encrypted).unwrap();
        assert_eq!(plaintext, decrypted);
    }

    #[test]
    fn test_each_encrypt_unique() {
        let key = VaultKey::derive("pw").unwrap();
        let plaintext = "same text";
        let e1 = encrypt(&key, plaintext.as_bytes()).unwrap();
        let e2 = encrypt(&key, plaintext.as_bytes()).unwrap();
        let e3 = encrypt(&key, plaintext.as_bytes()).unwrap();
        assert_ne!(e1, e2);
        assert_ne!(e2, e3);
        assert_ne!(e1, e3);
        assert_eq!(plaintext, decrypt(&key, &e1).unwrap());
        assert_eq!(plaintext, decrypt(&key, &e2).unwrap());
        assert_eq!(plaintext, decrypt(&key, &e3).unwrap());
    }

    #[test]
    fn test_tampered_data_fails() {
        let key = VaultKey::derive("pw").unwrap();
        let encrypted = encrypt(&key, b"secret").unwrap();
        // Tamper with the ciphertext part (third segment)
        let parts: Vec<&str> = encrypted.splitn(3, ':').collect();
        // Flip the last character to create an invalid MAC
        let mut ct: Vec<u8> = parts[2].as_bytes().to_vec();
        if let Some(last) = ct.last_mut() {
            *last ^= 0x01; // XOR flip last byte
        }
        let tampered_ct = String::from_utf8_lossy(&ct);
        let tampered = format!("{}:{}:{}", parts[0], parts[1], tampered_ct);
        assert!(decrypt(&key, &tampered).is_err());
    }

    #[test]
    fn test_derive_deterministic_with_salt() {
        let salt = b"fixed-salt-for-testing-1234567890";
        let plaintext = "Hello";
        let key1 = VaultKey::derive_with_salt("mypassword", salt).unwrap();
        let key2 = VaultKey::derive_with_salt("mypassword", salt).unwrap();
        let e1 = encrypt(&key1, plaintext.as_bytes()).unwrap();
        let d2 = decrypt(&key2, &e1).unwrap();
        assert_eq!(plaintext, d2);
    }
}
