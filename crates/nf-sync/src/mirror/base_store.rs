//! Merge-base store: the last CONVERGED body of each text file.
//!
//! A real three-way merge needs the common ancestor, not just the two
//! current sides. After each successful convergence the engine saves the
//! plaintext here (mirrors yanc feature 038's merge base) and reads it
//! back when a conflict on that path appears. Only mergeable text under
//! `MAX_BASE_BYTES` is stored; everything else simply has no base, and
//! the merge falls back to an empty ancestor.

use crate::mirror::merge::is_mergeable_text;
use std::path::{Path, PathBuf};

/// Root of the base copies, relative to the vault root.
pub const BASE_DIR: &str = ".noteforge/bases";
/// Files larger than this are not worth keeping a base copy for.
pub const MAX_BASE_BYTES: usize = 2 * 1024 * 1024;

pub struct BaseStore {
    root: PathBuf,
}

impl BaseStore {
    pub fn new(vault_root: &Path) -> Self {
        BaseStore { root: vault_root.join(BASE_DIR) }
    }

    fn path_of(&self, rel_path: &str) -> PathBuf {
        self.root.join(rel_path)
    }

    /// Store the converged body. No-op for binary or oversized content.
    pub fn put(&self, rel_path: &str, plain: &[u8]) -> std::io::Result<()> {
        if plain.len() > MAX_BASE_BYTES || !is_mergeable_text(plain) {
            return Ok(());
        }
        let dest = self.path_of(rel_path);
        if let Some(parent) = dest.parent() {
            std::fs::create_dir_all(parent)?;
        }
        let tmp = dest.with_extension("base-tmp");
        std::fs::write(&tmp, plain)?;
        std::fs::rename(&tmp, &dest)?;
        Ok(())
    }

    /// The stored ancestor, if any.
    pub fn get(&self, rel_path: &str) -> Option<Vec<u8>> {
        std::fs::read(self.path_of(rel_path)).ok()
    }

    /// Drop the base when the file leaves the sync set.
    pub fn remove(&self, rel_path: &str) {
        let _ = std::fs::remove_file(self.path_of(rel_path));
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn roundtrip_text_base() {
        let tmp = tempfile::tempdir().unwrap();
        let store = BaseStore::new(tmp.path());
        store.put("notes/a.md", b"v1\n").unwrap();
        assert_eq!(store.get("notes/a.md").unwrap(), b"v1\n");
        store.remove("notes/a.md");
        assert!(store.get("notes/a.md").is_none());
    }

    #[test]
    fn binary_is_not_stored() {
        let tmp = tempfile::tempdir().unwrap();
        let store = BaseStore::new(tmp.path());
        store.put("img.png", &[0x00, 0x01, 0x02]).unwrap();
        assert!(store.get("img.png").is_none());
    }

    #[test]
    fn oversized_is_not_stored() {
        let tmp = tempfile::tempdir().unwrap();
        let store = BaseStore::new(tmp.path());
        let big = vec![b'x'; MAX_BASE_BYTES + 1];
        store.put("big.txt", &big).unwrap();
        assert!(store.get("big.txt").is_none());
    }
}
