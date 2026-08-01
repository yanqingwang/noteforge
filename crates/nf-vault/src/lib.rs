use nf_core::vault::VaultConfig;
use nf_crypto::VaultKey;
use serde::{Deserialize, Serialize};
use std::fs;
use std::path::{Path, PathBuf};

/// Vault file system operations with optional encryption support.
pub struct Vault {
    root: PathBuf,
    config: VaultConfig,
    /// Decryption key (present only when the vault is encrypted and unlocked).
    key: Option<VaultKey>,
}

/// A single entry in the vault file tree.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct FileEntry {
    pub path: String,
    pub is_dir: bool,
    pub size: u64,
    pub modified: u64,
}

impl Vault {
    /// Open an existing vault folder (looks for `.noteforge/config.json`).
    /// If no config exists, creates one with defaults.
    pub fn open(root: impl Into<PathBuf>) -> Result<Self, VaultError> {
        let root = root.into();
        if !root.is_dir() {
            return Err(VaultError::NotADirectory(root));
        }

        let config_path = root.join(".noteforge").join("config.json");
        let config = if config_path.exists() {
            let content = fs::read_to_string(&config_path)
                .map_err(|e| VaultError::ConfigRead(config_path.clone(), e))?;
            serde_json::from_str(&content)
                .map_err(|e| VaultError::ConfigParse(config_path.clone(), e))?
        } else {
            let cfg = VaultConfig::default();
            cfg.save(&root)?;
            cfg
        };

        Ok(Vault { root, config, key: None })
    }

    /// The vault root path.
    pub fn root(&self) -> &Path {
        &self.root
    }

    /// The vault config.
    pub fn config(&self) -> &VaultConfig {
        &self.config
    }

    /// Whether the vault is encrypted and currently locked.
    pub fn is_encrypted(&self) -> bool {
        self.config.encrypted
    }

    /// Whether the vault is unlocked (key is available).
    pub fn is_unlocked(&self) -> bool {
        self.key.is_some()
    }

    // ── Encryption management ──────────────────────────────────────────────

    /// Set the vault password. Uses a single salt for key derivation
    /// (stored in config) and a separate PHC hash for verification.
    pub fn set_password(&mut self, password: &str) -> Result<(), VaultError> {
        // Generate the key-derivation salt (store in config for unlock)
        let key_salt = nf_crypto::generate_salt();
        let key_salt_b64 = base64::Engine::encode(
            &base64::engine::general_purpose::STANDARD,
            &key_salt,
        );
        let key = VaultKey::derive_with_salt(password, &key_salt)
            .map_err(|e| VaultError::Encryption(e.to_string()))?;

        // Generate a separate PHC hash for password verification
        let (hash, _) = VaultKey::password_hash(password)
            .map_err(|e| VaultError::Encryption(e.to_string()))?;

        self.config.encrypted = true;
        self.config.password_hash = Some(hash);
        self.config.salt = Some(key_salt_b64);
        self.config.save(&self.root)?;
        self.key = Some(key);
        Ok(())
    }

    /// Unlock the vault with a password. Derives key from stored salt + password.
    pub fn unlock(&mut self, password: &str) -> Result<(), VaultError> {
        if !self.config.encrypted {
            return Err(VaultError::NotEncrypted);
        }

        let hash = self.config.password_hash.as_ref()
            .ok_or(VaultError::Encryption("no password hash stored".into()))?;
        let salt = self.config.salt.as_ref()
            .ok_or(VaultError::Encryption("no salt stored".into()))?;

        if !VaultKey::verify_password(password, hash, salt)
            .map_err(|e| VaultError::Encryption(e.to_string()))?
        {
            return Err(VaultError::WrongPassword);
        }

        let salt_bytes = base64::Engine::decode(
            &base64::engine::general_purpose::STANDARD,
            salt,
        ).map_err(|e| VaultError::Encryption(e.to_string()))?;

        let key = VaultKey::derive_with_salt(password, &salt_bytes)
            .map_err(|e| VaultError::Encryption(e.to_string()))?;

        self.key = Some(key);
        Ok(())
    }

    /// Lock the vault (discard in-memory key).
    pub fn lock(&mut self) {
        self.key = None;
    }

    /// Change the vault password. Requires correct current password.
    pub fn change_password(&mut self, old_password: &str, new_password: &str) -> Result<(), VaultError> {
        if !self.config.encrypted {
            return Err(VaultError::NotEncrypted);
        }

        let hash = self.config.password_hash.as_ref()
            .ok_or(VaultError::Encryption("no password hash stored".into()))?;
        let salt = self.config.salt.as_ref()
            .ok_or(VaultError::Encryption("no salt stored".into()))?;

        if !VaultKey::verify_password(old_password, hash, salt)
            .map_err(|e| VaultError::Encryption(e.to_string()))?
        {
            return Err(VaultError::WrongPassword);
        }

        // Derive new hash and salt
        let (new_hash, new_salt) = VaultKey::password_hash(new_password)
            .map_err(|e| VaultError::Encryption(e.to_string()))?;

        // Derive new key from new salt + password
        let new_salt_bytes = base64::Engine::decode(
            &base64::engine::general_purpose::STANDARD,
            &new_salt,
        ).map_err(|e| VaultError::Encryption(e.to_string()))?;
        let new_key = VaultKey::derive_with_salt(new_password, &new_salt_bytes)
            .map_err(|e| VaultError::Encryption(e.to_string()))?;

        self.config.password_hash = Some(new_hash);
        self.config.salt = Some(new_salt);
        self.config.save(&self.root)?;
        self.key = Some(new_key);
        Ok(())
    }

    // ── File tree ──────────────────────────────────────────────────────────

    /// Build the complete file tree (recursive), excluding hidden + configured dirs.
    pub fn file_tree(&self) -> Result<Vec<FileEntry>, VaultError> {
        let mut entries = Vec::new();
        let exclude = &self.config.exclude_dirs;
        let show_hidden = self.config.show_hidden;
        for entry in walkdir::WalkDir::new(&self.root)
            .into_iter()
            .filter_entry(|e| {
                if !show_hidden && is_hidden(e) { return false; }
                if !e.file_type().is_dir() { return true; }
                let rel = e.path().strip_prefix(&self.root)
                    .unwrap_or(e.path())
                    .to_string_lossy()
                    .replace('\\', "/");
                if rel == ".noteforge" || rel.starts_with(".noteforge/") { return false; }
                !exclude.iter().any(|d| rel == *d || rel.starts_with(&format!("{}/", d)))
            })
        {
            let entry = entry.map_err(VaultError::WalkDir)?;
            let rel = entry
                .path()
                .strip_prefix(&self.root)
                .unwrap_or(entry.path())
                .to_string_lossy()
                .replace('\\', "/");
            if rel.is_empty() || rel.starts_with(".noteforge/") {
                continue;
            }
            let meta = entry.metadata().map_err(VaultError::WalkDir)?;
            entries.push(FileEntry {
                path: rel,
                is_dir: entry.file_type().is_dir(),
                size: if entry.file_type().is_file() { meta.len() } else { 0 },
                modified: meta.modified()
                    .ok()
                    .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
                    .map(|d| d.as_secs())
                    .unwrap_or(0),
            });
        }
        Ok(entries)
    }

    // ── Note I/O ───────────────────────────────────────────────────────────

    /// Read a note's content by relative path. If the vault is unlocked and
    /// content is encrypted, returns decrypted plaintext.
    pub fn read_note(&self, rel_path: &str) -> Result<Vec<u8>, VaultError> {
        let full = self.root.join(rel_path);
        if !full.exists() {
            return Err(VaultError::NotFound(rel_path.into()));
        }
        let raw = fs::read(&full).map_err(|e| VaultError::Read(rel_path.into(), e))?;

        // Auto-decrypt if key is available and content looks encrypted
        if let Some(ref key) = self.key {
            // Check string format first (our default write format)
            if is_encrypted_str(&raw) {
                let plaintext = decrypt_content(key, &raw)?;
                return Ok(plaintext.into_bytes());
            }
            // Then check binary format
            if is_encrypted_binary_slice(&raw) {
                let plaintext = decrypt_content(key, &raw)?;
                return Ok(plaintext.into_bytes());
            }
        }

        Ok(raw)
    }

    /// Write a note using atomic save. If the vault is unlocked, encrypts
    /// content before writing.
    pub fn write_note(&self, rel_path: &str, content: &[u8]) -> Result<(), VaultError> {
        let full = self.root.join(rel_path);
        if let Some(parent) = full.parent() {
            fs::create_dir_all(parent)
                .map_err(|e| VaultError::Write(rel_path.into(), e))?;
        }

        let data = if let Some(ref key) = self.key {
            nf_crypto::encrypt(key, content)
                .map_err(|e| VaultError::Encryption(e.to_string()))?
                .into_bytes()
        } else {
            content.to_vec()
        };

        let tmp = full.with_extension("tmp");
        fs::write(&tmp, &data)
            .map_err(|e| VaultError::Write(rel_path.into(), e))?;
        fs::rename(&tmp, &full)
            .map_err(|e| VaultError::Write(rel_path.into(), e))?;
        Ok(())
    }

    /// Create a new empty note (only if it doesn't exist).
    pub fn create_note(&self, rel_path: &str) -> Result<(), VaultError> {
        let full = self.root.join(rel_path);
        if full.exists() {
            return Err(VaultError::AlreadyExists(rel_path.into()));
        }
        if let Some(parent) = full.parent() {
            fs::create_dir_all(parent)
                .map_err(|e| VaultError::Write(rel_path.into(), e))?;
        }
        let data = if let Some(ref key) = self.key {
            nf_crypto::encrypt(key, b"")
                .map_err(|e| VaultError::Encryption(e.to_string()))?
                .into_bytes()
        } else {
            Vec::new()
        };
        fs::write(&full, &data)
            .map_err(|e| VaultError::Write(rel_path.into(), e))?;
        Ok(())
    }

    /// Rename/move a note.
    pub fn rename_note(&self, old_rel: &str, new_rel: &str) -> Result<(), VaultError> {
        let old = self.root.join(old_rel);
        let new = self.root.join(new_rel);
        if !old.exists() {
            return Err(VaultError::NotFound(old_rel.into()));
        }
        if new.exists() {
            return Err(VaultError::AlreadyExists(new_rel.into()));
        }
        if let Some(parent) = new.parent() {
            fs::create_dir_all(parent)
                .map_err(|e| VaultError::Write(new_rel.into(), e))?;
        }
        fs::rename(&old, &new).map_err(|e| VaultError::Write(old_rel.into(), e))?;
        Ok(())
    }

    /// Delete a note.
    pub fn delete_note(&self, rel_path: &str) -> Result<(), VaultError> {
        let full = self.root.join(rel_path);
        if !full.exists() {
            return Err(VaultError::NotFound(rel_path.into()));
        }
        fs::remove_file(&full).map_err(|e| VaultError::Delete(rel_path.into(), e))?;
        Ok(())
    }
}

/// Check if raw bytes start with NFC1 magic.
fn is_encrypted_binary_slice(data: &[u8]) -> bool {
    nf_crypto::is_encrypted_binary(data)
}

/// Check if raw bytes decode to an NFC1-prefixed string.
fn is_encrypted_str(data: &[u8]) -> bool {
    if let Ok(s) = std::str::from_utf8(data) {
        return nf_crypto::is_encrypted(s);
    }
    false
}

/// Decrypt content using the vault key. Tries string format first.
fn decrypt_content(key: &VaultKey, data: &[u8]) -> Result<String, VaultError> {
    // Try string format first (our default write format)
    if let Ok(s) = std::str::from_utf8(data) {
        if nf_crypto::is_encrypted(s) {
            return nf_crypto::decrypt(key, s)
                .map_err(|e| VaultError::Encryption(e.to_string()));
        }
    }
    // Try binary format
    nf_crypto::decrypt_binary(key, data)
        .map_err(|e| VaultError::Encryption(e.to_string()))
}

fn is_hidden(entry: &walkdir::DirEntry) -> bool {
    entry
        .file_name()
        .to_str()
        .map(|s| s.starts_with('.'))
        .unwrap_or(false)
}

// ── Config persistence ──────────────────────────────────────────────────────

/// Extension trait for VaultConfig persistence.
pub trait VaultConfigExt {
    fn save(&self, vault_root: &Path) -> Result<(), VaultError>;
    fn load(vault_root: &Path) -> Result<VaultConfig, VaultError>;
}

impl VaultConfigExt for VaultConfig {
    fn save(&self, vault_root: &Path) -> Result<(), VaultError> {
        let dir = vault_root.join(".noteforge");
        fs::create_dir_all(&dir)
            .map_err(|e| VaultError::ConfigWrite(dir.clone(), e))?;
        let json = serde_json::to_string_pretty(self)
            .map_err(VaultError::ConfigSerialize)?;
        let config_path = dir.join("config.json");
        let tmp = config_path.with_extension("tmp");
        fs::write(&tmp, &json)
            .map_err(|e| VaultError::ConfigWrite(config_path.clone(), e))?;
        fs::rename(&tmp, &config_path)
            .map_err(|e| VaultError::ConfigWrite(config_path, e))?;
        Ok(())
    }

    fn load(vault_root: &Path) -> Result<VaultConfig, VaultError> {
        let config_path = vault_root.join(".noteforge").join("config.json");
        let content = fs::read_to_string(&config_path)
            .map_err(|e| VaultError::ConfigRead(config_path.clone(), e))?;
        serde_json::from_str(&content)
            .map_err(|e| VaultError::ConfigParse(config_path, e))
    }
}

// ── Errors ──────────────────────────────────────────────────────────────────

#[derive(Debug, thiserror::Error)]
pub enum VaultError {
    #[error("not a directory: {0}")]
    NotADirectory(PathBuf),

    #[error("file not found: {0}")]
    NotFound(String),

    #[error("file already exists: {0}")]
    AlreadyExists(String),

    #[error("read error: {0}: {1}")]
    Read(String, std::io::Error),

    #[error("write error: {0}: {1}")]
    Write(String, std::io::Error),

    #[error("delete error: {0}: {1}")]
    Delete(String, std::io::Error),

    #[error("walkdir error: {0}")]
    WalkDir(#[from] walkdir::Error),

    #[error("config read error: {0}: {1}")]
    ConfigRead(PathBuf, std::io::Error),

    #[error("config parse error: {0}: {1}")]
    ConfigParse(PathBuf, serde_json::Error),

    #[error("config write error: {0}: {1}")]
    ConfigWrite(PathBuf, std::io::Error),

    #[error("config serialize error: {0}")]
    ConfigSerialize(serde_json::Error),

    #[error("encryption error: {0}")]
    Encryption(String),

    #[error("vault is not encrypted")]
    NotEncrypted,

    #[error("wrong password")]
    WrongPassword,
}

// ── Re-exports ──────────────────────────────────────────────────────────────

// ── Tests ───────────────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;

    fn create_smoke_vault() -> (tempfile::TempDir, PathBuf) {
        let dir = tempfile::tempdir().unwrap();
        let vault_path = dir.path().join("vault");
        nf_vaultgen::generate("smoke", 42, dir.path()).unwrap();
        (dir, vault_path)
    }

    #[test]
    fn test_open_vault() {
        let (_tmp, vault_path) = create_smoke_vault();
        let vault = Vault::open(&vault_path).unwrap();
        assert!(vault.root().exists());
        assert!(!vault.is_encrypted());
    }

    #[test]
    fn test_file_tree_counts_notes() {
        let (_tmp, vault_path) = create_smoke_vault();
        let vault = Vault::open(&vault_path).unwrap();
        let tree = vault.file_tree().unwrap();
        let notes = tree.iter().filter(|e| e.path.ends_with(".md")).count();
        assert_eq!(notes, 50);
    }

    #[test]
    fn test_read_note() {
        let (_tmp, vault_path) = create_smoke_vault();
        let vault = Vault::open(&vault_path).unwrap();
        let tree = vault.file_tree().unwrap();
        let first_md = tree.iter().find(|e| e.path.ends_with(".md")).unwrap();
        let content = vault.read_note(&first_md.path).unwrap();
        assert!(!content.is_empty());
    }

    #[test]
    fn test_write_note_atomic() {
        let (_tmp, vault_path) = create_smoke_vault();
        let vault = Vault::open(&vault_path).unwrap();
        vault.write_note("test-atomic.md", b"hello world").unwrap();
        let content = vault.read_note("test-atomic.md").unwrap();
        assert_eq!(content, b"hello world");
    }

    #[test]
    fn test_create_and_delete_note() {
        let (_tmp, vault_path) = create_smoke_vault();
        let vault = Vault::open(&vault_path).unwrap();
        vault.create_note("new-note.md").unwrap();
        assert!(vault.root().join("new-note.md").exists());
        vault.rename_note("new-note.md", "moved-note.md").unwrap();
        assert!(!vault.root().join("new-note.md").exists());
        vault.delete_note("moved-note.md").unwrap();
        assert!(!vault.root().join("moved-note.md").exists());
    }

    #[test]
    fn test_config_persistence() {
        let dir = tempfile::tempdir().unwrap();
        let cfg = VaultConfig::default();
        cfg.save(dir.path()).unwrap();
        let loaded = VaultConfig::load(dir.path()).unwrap();
        assert_eq!(cfg.name, loaded.name);
        assert_eq!(cfg.line_ending, loaded.line_ending);
    }

    #[test]
    fn test_encrypt_decrypt_vault() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path().join("enc-vault");
        std::fs::create_dir_all(&root).unwrap();
        let mut vault = Vault::open(&root).unwrap();

        vault.set_password("test123").unwrap();
        vault.write_note("test.md", b"Hello encrypted world!").unwrap();

        // Read back without any intermediate operations
        let content = vault.read_note("test.md").unwrap();
        assert_eq!(content, b"Hello encrypted world!");

        // Verify raw format
        vault.lock();
        let raw = std::fs::read_to_string(root.join("test.md")).unwrap();
        assert!(raw.starts_with("NFC1:"));

        // Re-unlock and verify
        vault.unlock("test123").unwrap();
        let decrypted = vault.read_note("test.md").unwrap();
        assert_eq!(decrypted, b"Hello encrypted world!");
    }

    #[test]
    fn test_wrong_password_fails() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path().join("wrong-pw-vault");
        fs::create_dir_all(&root).unwrap();

        let mut vault = Vault::open(&root).unwrap();
        vault.set_password("correct").unwrap();
        vault.lock();

        let result = vault.unlock("wrong");
        assert!(result.is_err());
        match result {
            Err(VaultError::WrongPassword) => {} // Expected
            _ => panic!("expected WrongPassword error"),
        }
    }

    #[test]
    fn test_change_password() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path().join("chpw-vault");
        std::fs::create_dir_all(&root).unwrap();
        let mut vault = Vault::open(&root).unwrap();

        vault.set_password("old-pass").unwrap();
        vault.write_note("n.md", b"test").unwrap();
        // Verify read with old key
        assert_eq!(vault.read_note("n.md").unwrap(), b"test");

        vault.change_password("old-pass", "new-pass").unwrap();
        // After password change, write & read a new file with new key
        vault.write_note("n2.md", b"test2").unwrap();
        assert_eq!(vault.read_note("n2.md").unwrap(), b"test2");

        vault.lock();
        vault.unlock("new-pass").unwrap();
        // After unlock, read files encrypted with new key
        assert_eq!(vault.read_note("n2.md").unwrap(), b"test2");

        vault.lock();
        assert!(vault.unlock("old-pass").is_err());
    }
}
