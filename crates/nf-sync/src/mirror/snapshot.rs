//! Local vault snapshot: walk the vault, apply ignore rules, and hash
//! files lazily (only when mtime/size differ from the last-sync state).

use crate::error::SyncError;
use crate::mirror::ignore::IgnoreRules;
use sha2::{Digest, Sha256};
use std::path::Path;

#[derive(Debug, Clone)]
pub struct LocalFile {
    /// Path relative to vault root, `/`-separated.
    pub path: String,
    pub size: u64,
    /// mtime in milliseconds since the Unix epoch.
    pub mtime: u64,
}

pub fn sha256_hex(data: &[u8]) -> String {
    let mut h = Sha256::new();
    h.update(data);
    format!("{:x}", h.finalize())
}

/// Walk the vault and collect non-ignored files (sorted by path).
pub fn scan_local(vault_root: &Path, ignore: &IgnoreRules) -> Result<Vec<LocalFile>, SyncError> {
    let mut files = Vec::new();
    if !vault_root.exists() {
        return Ok(files);
    }
    for entry in walkdir::WalkDir::new(vault_root)
        .into_iter()
        .filter_entry(|e| {
            // Never prune the root itself (its name may start with '.').
            if e.depth() == 0 {
                return true;
            }
            let name = e.file_name().to_string_lossy();
            !name.starts_with('.')
        })
        .filter_map(|e| e.ok())
    {
        let meta = match entry.metadata() {
            Ok(m) => m,
            Err(_) => continue,
        };
        if !meta.is_file() {
            continue;
        }
        let rel = match entry.path().strip_prefix(vault_root) {
            Ok(p) => p.to_string_lossy().to_string(),
            Err(_) => continue,
        };
        if rel.is_empty() || ignore.ignored(&rel) {
            continue;
        }
        let mtime = meta
            .modified()
            .ok()
            .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
            .map(|d| d.as_millis() as u64)
            .unwrap_or(0);
        files.push(LocalFile { path: rel, size: meta.len(), mtime });
    }
    files.sort_by(|a, b| a.path.cmp(&b.path));
    Ok(files)
}

/// Full read + hash of one local file.
pub fn hash_local(vault_root: &Path, rel_path: &str) -> Result<String, SyncError> {
    let data = std::fs::read(vault_root.join(rel_path))?;
    Ok(sha256_hex(&data))
}

/// Read one local file's bytes.
pub fn read_local(vault_root: &Path, rel_path: &str) -> Result<Vec<u8>, SyncError> {
    Ok(std::fs::read(vault_root.join(rel_path))?)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn scan_respects_ignore() {
        let tmp = tempfile::tempdir().unwrap();
        let root = tmp.path();
        std::fs::create_dir_all(root.join("notes/sub")).unwrap();
        std::fs::write(root.join("notes/a.md"), b"a").unwrap();
        std::fs::write(root.join("notes/sub/b.md"), b"b").unwrap();
        std::fs::create_dir_all(root.join(".noteforge")).unwrap();
        std::fs::write(root.join(".noteforge/sync-state.json"), b"{}").unwrap();
        std::fs::write(root.join("scratch.tmp"), b"x").unwrap();
        let files = scan_local(root, &IgnoreRules::new(&[])).unwrap();
        let paths: Vec<&str> = files.iter().map(|f| f.path.as_str()).collect();
        assert_eq!(paths, vec!["notes/a.md", "notes/sub/b.md"]);
    }
}
