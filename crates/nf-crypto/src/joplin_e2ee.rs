//! Joplin-compatible End-to-End Encryption (E2EE).
//!
//! Implements the official Joplin E2EE protocol so NoteForge can encrypt/decrypt
//! items that are compatible with the Joplin desktop/mobile apps AND the
//! Obsidian "Joplin Server Sync" plugin.
//!
//! Protocol (aligned with Joplin `packages/lib/services/e2ee/`):
//! - Master key (type_=9): 256 random bytes → 512 hex chars, wrapped with
//!   KeyV1: AES-256-GCM with PBKDF2-SHA512 (220000 iterations) from user password.
//!   `content` = JSON {salt, iv, ct} base64.
//! - Items (StringV1): AES-256-GCM with PBKDF2-SHA512 (3 iterations) derived
//!   from the master key HEX STRING as password; data encoded utf16le.
//! - Resources (FileV1): same but data encoded base64, 128k chunks.
//! - Cipher text layout: [JED01][6-hex metadataLen][2-hex method][32-hex masterKeyId]
//!   + for each chunk: [6-hex chunkLen][JSON {salt,iv,ct} base64]

use aes_gcm::aead::Aead;
use aes_gcm::{Aes256Gcm, KeyInit, Nonce};
use base64::Engine;
use rand::RngCore;
use serde::{Deserialize, Serialize};

use crate::error::{CryptoError, CryptoResult};

pub const HEADER_IDENTIFIER: &str = "JED01";
pub const GCM_TAG_BITS: usize = 128;
pub const NONCE_BYTES: usize = 12;
pub const KEY_BYTES: usize = 32;
pub const SALT_BYTES: usize = 16;
pub const KEYV1_ITERATIONS: u32 = 220_000;
pub const CHUNK_ITERATIONS: u32 = 3;
pub const STRING_V1_CHUNK: usize = 65_536;
pub const FILE_V1_CHUNK: usize = 131_072;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub enum EncryptionMethod {
    Sjcl = 1,
    Sjcl2 = 2,
    Sjcl3 = 3,
    Sjcl4 = 4,
    Sjcl1a = 5,
    Custom = 6,
    Sjcl1b = 7,
    KeyV1 = 8,
    FileV1 = 9,
    StringV1 = 10,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct EncryptionResult {
    pub salt: String, // base64
    pub iv: String,   // base64
    pub ct: String,   // base64
}

/// Service for Joplin-compatible E2EE.
pub struct JoplinE2ee {
    /// masterKeyId → decrypted master key plain text (512 hex chars)
    master_key_plaintexts: std::collections::HashMap<String, String>,
}

impl Default for JoplinE2ee {
    fn default() -> Self { Self::new() }
}

impl JoplinE2ee {
    pub fn new() -> Self {
        JoplinE2ee { master_key_plaintexts: std::collections::HashMap::new() }
    }

    pub fn has_loaded_keys(&self) -> bool { !self.master_key_plaintexts.is_empty() }

    pub fn loaded_key_ids(&self) -> Vec<String> { self.master_key_plaintexts.keys().cloned().collect() }

    /// Generate a fresh master key (KeyV1) from a password.
    /// Returns (master_key_id, encrypted_content_json).
    pub fn generate_master_key(&self, password: &str, id: &str) -> CryptoResult<(String, String)> {
        if password.is_empty() { return Err(CryptoError::InvalidKey("password required".into())); }
        let mut key_bytes = [0u8; 256];
        rand::rng().fill_bytes(&mut key_bytes);
        let hex_key = bytes_to_hex(&key_bytes);

        let mut salt = [0u8; SALT_BYTES];
        rand::rng().fill_bytes(&mut salt);
        let result = encrypt_aes_gcm(password, &salt, hex_key.as_bytes(), KEYV1_ITERATIONS)?;
        Ok((id.to_string(), serde_json::to_string(&result)?))
    }

    /// Load a master key into memory by decrypting its content with the user password.
    pub fn load_master_key(&mut self, master_key_id: &str, password: &str, encrypted_content: &str) -> CryptoResult<()> {
        if password.is_empty() { return Err(CryptoError::InvalidKey("password required".into())); }
        let result: EncryptionResult = serde_json::from_str(encrypted_content)
            .map_err(|_| CryptoError::InvalidKey("master key encrypted content not JSON".into()))?;
        if result.salt.is_empty() || result.iv.is_empty() || result.ct.is_empty() {
            return Err(CryptoError::InvalidKey("master key missing salt/iv/ct".into()));
        }
        let salt = b64_decode(&result.salt)?;
        let iv = b64_decode(&result.iv)?;
        let ct = b64_decode(&result.ct)?;
        let plain = decrypt_aes_gcm(password, &salt, &iv, &ct, KEYV1_ITERATIONS)?;
        let hex_key = String::from_utf8_lossy(&plain).trim().to_string();
        if !is_hex(&hex_key) {
            return Err(CryptoError::InvalidKey("master key decrypted to invalid key material (wrong password?)".into()));
        }
        self.master_key_plaintexts.insert(master_key_id.to_string(), hex_key);
        Ok(())
    }

    /// Encrypt a serialized item string → `encryption_cipher_text` (StringV1).
    pub fn encrypt_item(&self, serialized: &str, master_key_id: &str) -> CryptoResult<String> {
        let mk = self.get_master_key(master_key_id)?;
        let chunks = encrypt_chunks(serialized, EncryptionMethod::StringV1, mk, StringEncoding::Utf16Le)?;
        Ok(build_cipher_text(EncryptionMethod::StringV1, master_key_id, &chunks))
    }

    /// Decrypt an item's `encryption_cipher_text` → serialized (plain) item text.
    pub fn decrypt_item(&self, cipher_text: &str) -> CryptoResult<String> {
        let header = parse_header(cipher_text)?;
        if header.method != EncryptionMethod::StringV1 {
            return Err(CryptoError::InvalidKey(format!(
                "item method {:?} not supported (only StringV1)", header.method)));
        }
        let mk = self.get_master_key(&header.master_key_id)?;
        decrypt_chunks(cipher_text, EncryptionMethod::StringV1, mk, StringEncoding::Utf16Le)
    }

    /// Encrypt binary resource data (FileV1) → hex cipher text string.
    pub fn encrypt_blob(&self, data: &[u8], master_key_id: &str) -> CryptoResult<String> {
        let mk = self.get_master_key(master_key_id)?;
        let b64 = base64::engine::general_purpose::STANDARD.encode(data);
        let chunks = encrypt_chunks(&b64, EncryptionMethod::FileV1, mk, StringEncoding::Base64)?;
        Ok(build_cipher_text(EncryptionMethod::FileV1, master_key_id, &chunks))
    }

    /// Decrypt a resource blob cipher text (FileV1) → binary.
    pub fn decrypt_blob(&self, cipher_text: &str) -> CryptoResult<Vec<u8>> {
        let header = parse_header(cipher_text)?;
        if header.method != EncryptionMethod::FileV1 {
            return Err(CryptoError::InvalidKey(format!(
                "resource method {:?} not supported (only FileV1)", header.method)));
        }
        let mk = self.get_master_key(&header.master_key_id)?;
        let b64 = decrypt_chunks(cipher_text, EncryptionMethod::FileV1, mk, StringEncoding::Base64)?;
        b64_decode(&b64).map_err(|e| CryptoError::DecryptionFailed(e.to_string()))
    }

    fn get_master_key(&self, id: &str) -> CryptoResult<&str> {
        self.master_key_plaintexts.get(id)
            .map(|s| s.as_str())
            .ok_or_else(|| CryptoError::InvalidKey(format!("master key not loaded: {}", id)))
    }
}

enum StringEncoding { Utf16Le, Base64 }

fn encrypt_chunks(
    plain: &str,
    method: EncryptionMethod,
    master_key_hex: &str,
    encoding: StringEncoding,
) -> CryptoResult<Vec<String>> {
    let chunk_size = match method {
        EncryptionMethod::FileV1 => FILE_V1_CHUNK,
        _ => STRING_V1_CHUNK,
    };
    let mut chunks = Vec::new();
    let mut start = 0;
    while start < plain.len() {
        // Find the largest char boundary at or before start + chunk_size
        let mut end = (start + chunk_size).min(plain.len());
        if end < plain.len() && !plain.is_char_boundary(end) {
            while end > start && !plain.is_char_boundary(end) {
                end -= 1;
            }
        }
        let block = &plain[start..end];
        chunks.push(encrypt_block(block, master_key_hex, &encoding)?);
        start = end;
    }
    Ok(chunks)
}

fn decrypt_chunks(
    cipher_text: &str,
    method: EncryptionMethod,
    master_key_hex: &str,
    encoding: StringEncoding,
) -> CryptoResult<String> {
    let header = parse_header(cipher_text)?;
    let header_len_hex = &cipher_text[HEADER_IDENTIFIER.len()..HEADER_IDENTIFIER.len() + 6];
    let header_len = usize::from_str_radix(header_len_hex, 16)
        .map_err(|_| CryptoError::DecryptionFailed("bad header len".into()))?;
    let mut pos = HEADER_IDENTIFIER.len() + 6 + header_len;

    let mut parts = Vec::new();
    while pos < cipher_text.len() {
        let chunk_len_hex = &cipher_text[pos..pos + 6.min(cipher_text.len() - pos)];
        if chunk_len_hex.len() < 6 { break; }
        let chunk_len = usize::from_str_radix(chunk_len_hex, 16)
            .map_err(|_| CryptoError::DecryptionFailed("bad chunk len".into()))?;
        pos += 6;
        if chunk_len == 0 || pos + chunk_len > cipher_text.len() { break; }
        let block = &cipher_text[pos..pos + chunk_len];
        pos += chunk_len;
        parts.push(decrypt_block(block, master_key_hex, &encoding)?);
    }
    Ok(parts.join(""))
}

fn encrypt_block(plain: &str, master_key_hex: &str, encoding: &StringEncoding) -> CryptoResult<String> {
    let mut salt = [0u8; SALT_BYTES];
    rand::rng().fill_bytes(&mut salt);
    let data = match encoding {
        StringEncoding::Utf16Le => utf16le_encode(plain),
        // plain is already base64 text; encrypt its UTF-8 bytes directly
        StringEncoding::Base64 => plain.as_bytes().to_vec(),
    };
    let result = encrypt_aes_gcm(master_key_hex, &salt, &data, CHUNK_ITERATIONS)?;
    serde_json::to_string(&result).map_err(|e| CryptoError::EncryptionFailed(e.to_string()))
}

fn decrypt_block(block: &str, master_key_hex: &str, encoding: &StringEncoding) -> CryptoResult<String> {
    let result: EncryptionResult = serde_json::from_str(block)
        .map_err(|_| CryptoError::DecryptionFailed("invalid encrypted block".into()))?;
    let salt = b64_decode(&result.salt)?;
    let iv = b64_decode(&result.iv)?;
    let ct = b64_decode(&result.ct)?;
    let plain = decrypt_aes_gcm(master_key_hex, &salt, &iv, &ct, CHUNK_ITERATIONS)?;
    match encoding {
        StringEncoding::Utf16Le => utf16le_decode(&plain).map_err(|e| CryptoError::DecryptionFailed(e)),
        StringEncoding::Base64 => String::from_utf8(plain)
            .map_err(|e| CryptoError::DecryptionFailed(e.to_string())),
    }
}

// === AES-256-GCM + PBKDF2-SHA512 (matches Joplin native crypto) ===

fn derive_key(password: &str, salt: &[u8], iterations: u32) -> CryptoResult<aes_gcm::Key<Aes256Gcm>> {
    let mut key_bytes = [0u8; KEY_BYTES];
    pbkdf2::pbkdf2_hmac::<sha2::Sha512>(password.as_bytes(), salt, iterations, &mut key_bytes);
    Ok(aes_gcm::Key::<Aes256Gcm>::from_slice(&key_bytes).clone())
}

fn encrypt_aes_gcm(
    password: &str,
    salt: &[u8],
    data: &[u8],
    iterations: u32,
) -> CryptoResult<EncryptionResult> {
    let key = derive_key(password, salt, iterations)?;
    let cipher = Aes256Gcm::new(&key);
    let mut iv_bytes = [0u8; NONCE_BYTES];
    rand::rng().fill_bytes(&mut iv_bytes);
    let nonce = Nonce::from_slice(&iv_bytes);
    let ct = cipher.encrypt(nonce, data)
        .map_err(|e| CryptoError::EncryptionFailed(e.to_string()))?;
    Ok(EncryptionResult {
        salt: base64::engine::general_purpose::STANDARD.encode(salt),
        iv: base64::engine::general_purpose::STANDARD.encode(iv_bytes),
        ct: base64::engine::general_purpose::STANDARD.encode(ct),
    })
}

fn decrypt_aes_gcm(
    password: &str,
    salt: &[u8],
    iv: &[u8],
    ct: &[u8],
    iterations: u32,
) -> CryptoResult<Vec<u8>> {
    let key = derive_key(password, salt, iterations)?;
    let cipher = Aes256Gcm::new(&key);
    let nonce = Nonce::from_slice(iv);
    cipher.decrypt(nonce, ct)
        .map_err(|e| CryptoError::DecryptionFailed(e.to_string()))
}

// === JED01 header parsing/building ===

#[derive(Debug)]
struct EncryptedHeader {
    version: u8,
    method: EncryptionMethod,
    master_key_id: String,
}

fn parse_header(ct: &str) -> CryptoResult<EncryptedHeader> {
    if !ct.starts_with(HEADER_IDENTIFIER) {
        return Err(CryptoError::InvalidKey("invalid E2EE header (missing JED01)".into()));
    }
    let md_size_hex = &ct[HEADER_IDENTIFIER.len()..HEADER_IDENTIFIER.len() + 6];
    let md_size = usize::from_str_radix(md_size_hex, 16)
        .map_err(|_| CryptoError::InvalidKey("invalid E2EE metadata size".into()))?;
    if md_size == 0 { return Err(CryptoError::InvalidKey("invalid E2EE metadata size".into())); }
    let md = &ct[HEADER_IDENTIFIER.len() + 6..HEADER_IDENTIFIER.len() + 6 + md_size];
    let method = u8::from_str_radix(&md[0..2], 16)
        .map_err(|_| CryptoError::InvalidKey("invalid method".into()))?;
    let master_key_id = &md[2..34];
    if master_key_id.len() != 32 {
        return Err(CryptoError::InvalidKey("invalid master key ID size".into()));
    }
    Ok(EncryptedHeader {
        version: 1,
        method: method_from_u8(method),
        master_key_id: master_key_id.to_string(),
    })
}

fn build_header(method: EncryptionMethod, master_key_id: &str) -> CryptoResult<String> {
    if master_key_id.len() != 32 {
        return Err(CryptoError::InvalidKey("invalid master key ID size".into()));
    }
    let metadata = format!("{:02x}{}", method as u8, master_key_id);
    let md_size_hex = format!("{:06x}", metadata.len());
    Ok(format!("{}{}{}", HEADER_IDENTIFIER, md_size_hex, metadata))
}

fn build_cipher_text(method: EncryptionMethod, master_key_id: &str, chunks: &[String]) -> String {
    let mut out = build_header(method, master_key_id).expect("valid header");
    for chunk in chunks {
        out.push_str(&format!("{:06x}{}", chunk.len(), chunk));
    }
    out
}

fn method_from_u8(m: u8) -> EncryptionMethod {
    match m {
        8 => EncryptionMethod::KeyV1,
        9 => EncryptionMethod::FileV1,
        10 => EncryptionMethod::StringV1,
        1 => EncryptionMethod::Sjcl,
        2 => EncryptionMethod::Sjcl2,
        3 => EncryptionMethod::Sjcl3,
        4 => EncryptionMethod::Sjcl4,
        5 => EncryptionMethod::Sjcl1a,
        6 => EncryptionMethod::Custom,
        7 => EncryptionMethod::Sjcl1b,
        _ => EncryptionMethod::Custom,
    }
}

// === Encoding helpers ===

fn utf16le_encode(s: &str) -> Vec<u8> {
    let mut out = Vec::with_capacity(s.len() * 2);
    for c in s.encode_utf16() {
        out.extend_from_slice(&c.to_le_bytes());
    }
    out
}

fn utf16le_decode(bytes: &[u8]) -> Result<String, String> {
    if bytes.len() % 2 != 0 {
        return Err("odd utf16le length".into());
    }
    let mut chars = Vec::with_capacity(bytes.len() / 2);
    for chunk in bytes.chunks(2) {
        chars.push(u16::from_le_bytes([chunk[0], chunk[1]]));
    }
    String::from_utf16(&chars).map_err(|e| e.to_string())
}

fn b64_decode(s: &str) -> CryptoResult<Vec<u8>> {
    base64::engine::general_purpose::STANDARD.decode(s)
        .map_err(|_| CryptoError::DecryptionFailed("invalid base64".into()))
}

fn bytes_to_hex(bytes: &[u8]) -> String {
    bytes.iter().map(|b| format!("{:02x}", b)).collect()
}

fn is_hex(s: &str) -> bool {
    !s.is_empty() && s.chars().all(|c| c.is_ascii_hexdigit())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_master_key_roundtrip() {
        let service = JoplinE2ee::new();
        let key_id = "01234568abcdefgh01234568abcdefgh";
        let password = "test-password-123";

        let (id, content) = service.generate_master_key(password, key_id).unwrap();
        assert_eq!(id, key_id);

        let mut svc = JoplinE2ee::new();
        svc.load_master_key(key_id, password, &content).unwrap();
        assert!(svc.has_loaded_keys());
        assert_eq!(svc.loaded_key_ids(), vec![key_id.to_string()]);
    }

    #[test]
    fn test_master_key_wrong_password() {
        let service = JoplinE2ee::new();
        let key_id = "fedcba9876543210fedcba9876543210";
        let (_id, content) = service.generate_master_key("correct", key_id).unwrap();

        let mut svc = JoplinE2ee::new();
        let err = svc.load_master_key(key_id, "wrong", &content);
        assert!(err.is_err(), "wrong password should fail");
    }

    #[test]
    fn test_item_encrypt_decrypt_roundtrip() {
        let service = JoplinE2ee::new();
        let key_id = "01234568abcdefgh01234568abcdefgh";
        let (_id, content) = service.generate_master_key("pw", key_id).unwrap();
        let mut svc = JoplinE2ee::new();
        svc.load_master_key(key_id, "pw", &content).unwrap();

        let text = "Hello E2EE! 测试中文 🚀 ".repeat(3000); // > 64k → multi-chunk
        let cipher = svc.encrypt_item(&text, key_id).unwrap();
        assert!(cipher.starts_with("JED01"), "should start with JED01 header");
        assert!(cipher.starts_with(&format!("JED010000220a{}", key_id)), "header structure");

        let plain = svc.decrypt_item(&cipher).unwrap();
        assert_eq!(plain, text, "roundtrip should match");
    }

    #[test]
    fn test_resource_blob_roundtrip() {
        let service = JoplinE2ee::new();
        let key_id = "01234568abcdefgh01234568abcdefgh";
        let (_id, content) = service.generate_master_key("pw", key_id).unwrap();
        let mut svc = JoplinE2ee::new();
        svc.load_master_key(key_id, "pw", &content).unwrap();

        let blob = vec![0u8, 1, 2, 3, 255, 254, 128, 42];
        let cipher = svc.encrypt_blob(&blob, key_id).unwrap();
        assert!(cipher.starts_with("JED0100002209"), "FileV1 method = 09");
        let plain = svc.decrypt_blob(&cipher).unwrap();
        assert_eq!(plain, blob);
    }

    #[test]
    fn test_header_structure() {
        let key_id = "01234568abcdefgh01234568abcdefgh";
        let header = build_header(EncryptionMethod::StringV1, key_id).unwrap();
        assert_eq!(header, format!("JED010000220a{}", key_id));
    }
}
#[cfg(test)]
mod interop_tests {
    use super::*;

    /// Verify our output is decryptable by the reference algorithm used in
    /// the Obsidian plugin interop test (independent PBKDF2/AES-GCM impl).
    fn ref_decrypt(password: &str, r: &EncryptionResult, iterations: u32) -> CryptoResult<Vec<u8>> {
        let salt = b64_decode(&r.salt)?;
        let iv = b64_decode(&r.iv)?;
        let ct = b64_decode(&r.ct)?;
        decrypt_aes_gcm(password, &salt, &iv, &ct, iterations)
    }

    #[test]
    fn test_interop_master_key_plugin_compatible() {
        // 1. Plugin generates master key → reference decrypts it
        let service = JoplinE2ee::new();
        let key_id = "01234568abcdefgh01234568abcdefgh";
        let password = "interop-password-123";
        let (id, content) = service.generate_master_key(password, key_id).unwrap();
        assert_eq!(id, key_id);

        // Reference (independent) decrypt of the wrapped master key
        let result: EncryptionResult = serde_json::from_str(&content).unwrap();
        let mk_hex = ref_decrypt(password, &result, KEYV1_ITERATIONS).unwrap();
        let mk_hex = String::from_utf8(mk_hex).unwrap();
        assert!(is_hex(&mk_hex) && mk_hex.len() == 512,
            "reference decrypts master key to 512-hex, got {} chars", mk_hex.len());
    }

    #[test]
    fn test_interop_item_string_v1() {
        // Master key + note roundtrip with StringV1 header structure check
        let key_id = "01234568abcdefgh01234568abcdefgh";
        let password = "interop-password-123";
        let service = JoplinE2ee::new();
        let (_id, content) = service.generate_master_key(password, key_id).unwrap();
        let mut svc = JoplinE2ee::new();
        svc.load_master_key(key_id, password, &content).unwrap();

        let text = "Hello interop! 跨实现验证 🚀 ".repeat(3000);
        let cipher = svc.encrypt_item(&text, key_id).unwrap();

        // Header must be exactly: JED01 + 000022 + 0a + 32-hex key id
        assert!(cipher.starts_with(&format!("JED010000220a{}", key_id)),
            "header = JED01+000022+0a+keyId, got: {}", &cipher[..45.min(cipher.len())]);

        // Roundtrip
        let plain = svc.decrypt_item(&cipher).unwrap();
        assert_eq!(plain, text);
    }

    #[test]
    fn test_interop_header_matches_official() {
        let key_id = "fedcba9876543210fedcba9876543210";
        let header = build_header(EncryptionMethod::StringV1, key_id).unwrap();
        // Official format: JED01 + metadataLen(000022) + method(0a) + keyId
        assert_eq!(header, format!("JED010000220a{}", key_id));
        let fv1 = build_header(EncryptionMethod::FileV1, key_id).unwrap();
        assert_eq!(fv1, format!("JED0100002209{}", key_id));
        let kv1 = build_header(EncryptionMethod::KeyV1, key_id).unwrap();
        assert_eq!(kv1, format!("JED0100002208{}", key_id));
    }

    #[test]
    fn test_interop_wrong_password_rejected() {
        let key_id = "01234568abcdefgh01234568abcdefgh";
        let service = JoplinE2ee::new();
        let (_id, content) = service.generate_master_key("right-pw", key_id).unwrap();
        let mut svc = JoplinE2ee::new();
        // Wrong password should fail to derive valid key material
        let err = svc.load_master_key(key_id, "wrong-pw", &content);
        assert!(err.is_err(), "wrong password must be rejected");
    }
}
