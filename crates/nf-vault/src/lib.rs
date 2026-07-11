use nf_core::vault::VaultConfig;
use serde::{Deserialize, Serialize};
use std::fs;
use std::path::{Path, PathBuf};

/// Vault file system operations.
pub struct Vault {
    root: PathBuf,
    config: VaultConfig,
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

        Ok(Vault { root, config })
    }

    /// The vault root path.
    pub fn root(&self) -> &Path {
        &self.root
    }

    /// The vault config.
    pub fn config(&self) -> &VaultConfig {
        &self.config
    }

    /// Build the complete file tree (recursive), excluding configured dirs.
    pub fn file_tree(&self) -> Result<Vec<FileEntry>, VaultError> {
        let mut entries = Vec::new();
        let exclude = &self.config.exclude_dirs;
        for entry in walkdir::WalkDir::new(&self.root)
            .into_iter()
            .filter_entry(|e| {
                if is_hidden(e) { return false; }
                if !e.file_type().is_dir() { return true; }
                // Filter out excluded directories
                let rel = e.path().strip_prefix(&self.root)
                    .unwrap_or(e.path())
                    .to_string_lossy()
                    .replace('\\', "/");
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

    /// Read a note's content by relative path.
    pub fn read_note(&self, rel_path: &str) -> Result<Vec<u8>, VaultError> {
        let full = self.root.join(rel_path);
        if !full.exists() {
            return Err(VaultError::NotFound(rel_path.into()));
        }
        fs::read(&full).map_err(|e| VaultError::Read(rel_path.into(), e))
    }

    /// Write a note using atomic save (temp file + rename).
    pub fn write_note(&self, rel_path: &str, content: &[u8]) -> Result<(), VaultError> {
        let full = self.root.join(rel_path);
        if let Some(parent) = full.parent() {
            fs::create_dir_all(parent)
                .map_err(|e| VaultError::Write(rel_path.into(), e))?;
        }
        let tmp = full.with_extension("tmp");
        fs::write(&tmp, content)
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
        fs::write(&full, b"")
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

    /// Delete a note (moves to system trash via `rm` — simple unlink for now).
    pub fn delete_note(&self, rel_path: &str) -> Result<(), VaultError> {
        let full = self.root.join(rel_path);
        if !full.exists() {
            return Err(VaultError::NotFound(rel_path.into()));
        }
        fs::remove_file(&full).map_err(|e| VaultError::Delete(rel_path.into(), e))?;
        Ok(())
    }
}

fn is_hidden(entry: &walkdir::DirEntry) -> bool {
    entry
        .file_name()
        .to_str()
        .map(|s| s == ".noteforge" || s.starts_with(".git"))
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
            .map_err(|e| VaultError::ConfigSerialize(e))?;
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
    ConfigSerialize(#[from] serde_json::Error),
}

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
        assert!(vault.root().join("moved-note.md").exists());
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
}
