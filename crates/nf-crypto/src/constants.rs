/// Authentication tag length for AES-256-GCM (in bytes)
pub const TAG_LEN: usize = 16;

/// Nonce length for AES-256-GCM (in bytes)
pub const NONCE_LEN: usize = 12;

/// Magic header for encrypted content: "NFC1"
pub const MAGIC: &[u8; 4] = b"NFC1";

/// Magic header for base64-encoded encrypted content
pub const MAGIC_STR: &str = "NFC1";

/// Argon2id memory cost (64 MiB)
pub const ARGON_MEMORY: u32 = 65536;

/// Argon2id iteration count
pub const ARGON_ITERATIONS: u32 = 3;

/// Argon2id parallelism
pub const ARGON_PARALLELISM: u32 = 4;

/// Salt length (32 bytes)
pub const SALT_LEN: usize = 32;

/// Key length for AES-256 (32 bytes)
pub const KEY_LEN: usize = 32;
