use crate::constants::SALT_LEN;
use rand::Rng;

/// Generate a cryptographically random salt.
pub fn generate_salt() -> Vec<u8> {
    let mut salt = vec![0u8; SALT_LEN];
    rand::rng().fill(&mut salt[..]);
    salt
}

/// Generate a base64-encoded random salt for storage.
pub fn generate_salt_b64() -> String {
    base64::Engine::encode(
        &base64::engine::general_purpose::STANDARD,
        &generate_salt(),
    )
}
