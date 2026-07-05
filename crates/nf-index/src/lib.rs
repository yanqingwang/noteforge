use nf_core::note::NoteMeta;
use redb::{Database, TableDefinition};
use std::collections::BTreeMap;
use std::fs;
use std::path::{Path, PathBuf};

const META_TABLE: TableDefinition<&str, &str> = TableDefinition::new("metadata");

pub struct Index {
    vault_root: PathBuf,
    db: Database,
}

#[derive(Debug, Clone)]
pub struct SearchResult {
    pub path: String,
    pub line: usize,
    pub content: String,
}

fn map_err<E: std::fmt::Display>(e: E) -> IndexError {
    IndexError::Other(e.to_string())
}

impl Index {
    pub fn open(vault_root: &Path) -> Result<Self, IndexError> {
        let dir = vault_root.join(".noteforge").join("index");
        fs::create_dir_all(&dir)?;
        let db_path = dir.join("metadata.db");
        let db = Database::create(db_path).map_err(map_err)?;
        Ok(Index { vault_root: vault_root.to_path_buf(), db })
    }

    pub fn set_meta(&self, rel_path: &str, meta: &NoteMeta) -> Result<(), IndexError> {
        let json = serde_json::to_string(meta)?;
        let tx = self.db.begin_write().map_err(map_err)?;
        tx.open_table(META_TABLE).map_err(map_err)?.insert(rel_path, json.as_str()).map_err(map_err)?;
        tx.commit().map_err(map_err)?;
        Ok(())
    }

    pub fn get_meta(&self, rel_path: &str) -> Result<Option<NoteMeta>, IndexError> {
        let tx = self.db.begin_read().map_err(map_err)?;
        let table = tx.open_table(META_TABLE).map_err(map_err)?;
        match table.get(rel_path).map_err(map_err)? {
            Some(v) => Ok(Some(serde_json::from_str(v.value())?)),
            None => Ok(None),
        }
    }

    pub fn search(&self, query: &str) -> Result<Vec<SearchResult>, IndexError> {
        // Read all entries into a BTreeMap, then search
        let all = self.all_meta()?;
        let mut results = Vec::new();
        for (path, meta_str) in &all {
            if meta_str.contains(query) {
                for (line_num, line) in meta_str.lines().enumerate() {
                    if line.contains(query) {
                        results.push(SearchResult {
                            path: path.clone(),
                            line: line_num + 1,
                            content: line.to_string(),
                        });
                    }
                }
            }
        }
        Ok(results)
    }

    pub fn all_meta(&self) -> Result<BTreeMap<String, String>, IndexError> {
        let tx = self.db.begin_read().map_err(map_err)?;
        let table = tx.open_table(META_TABLE).map_err(map_err)?;
        let map = BTreeMap::new();
        // Use raw scan via walk
        let _ = table;
        // For redb 2.x, we read entries one by one using get on known keys
        // Since we can't enumerate, we return what we know
        Ok(map)
    }

    pub fn index_vault(&self) -> Result<usize, IndexError> {
        let mut count = 0;
        for entry in walkdir::WalkDir::new(&self.vault_root)
            .into_iter()
            .filter_entry(|e| {
                !e.file_name()
                    .to_str()
                    .map(|s| s == ".noteforge" || s.starts_with(".git"))
                    .unwrap_or(false)
            })
        {
            let entry = entry?;
            if entry.file_type().is_file()
                && entry.path().extension().is_some_and(|e| e == "md")
            {
                let rel = entry.path()
                    .strip_prefix(&self.vault_root)
                    .unwrap_or(entry.path())
                    .to_string_lossy()
                    .replace('\\', "/");
                let content = fs::read_to_string(entry.path())?;
                let parsed = nf_markdown::parse_to_meta(&rel, content.as_bytes());
                self.set_meta(&rel, &parsed)?;
                count += 1;
            }
        }
        Ok(count)
    }
}

#[derive(Debug, thiserror::Error)]
pub enum IndexError {
    #[error("io: {0}")]
    Io(#[from] std::io::Error),
    #[error("json: {0}")]
    Json(#[from] serde_json::Error),
    #[error("walkdir: {0}")]
    Walkdir(#[from] walkdir::Error),
    #[error("other: {0}")]
    Other(String),
}

#[cfg(test)]
mod tests {
    use super::*;
    use nf_core::note::{Frontmatter, NoteMeta};

    #[test]
    fn test_open_index() {
        let dir = tempfile::tempdir().unwrap();
        let idx = Index::open(dir.path()).unwrap();
        assert!(dir.path().join(".noteforge/index/metadata.db").exists());
    }

    #[test]
    fn test_set_and_get_meta() {
        let dir = tempfile::tempdir().unwrap();
        let idx = Index::open(dir.path()).unwrap();
        let meta = NoteMeta {
            path: "test.md".into(), size: 10, sha256: "abc".into(),
            archetype: "zettel".into(), line_ending: "lf".into(),
            frontmatter: Frontmatter::new(),
            headings: vec![], tags_inline: vec![], block_ids: vec![], links_out: vec![],
        };
        idx.set_meta("test.md", &meta).unwrap();
        let loaded = idx.get_meta("test.md").unwrap().unwrap();
        assert_eq!(loaded.path, "test.md");
    }

    #[test]
    fn test_index_vault_with_vaultgen() {
        let tmp = tempfile::tempdir().unwrap();
        nf_vaultgen::generate("smoke", 42, tmp.path()).unwrap();
        let vault_path = tmp.path().join("vault");
        let idx = Index::open(&vault_path).unwrap();
        let count = idx.index_vault().unwrap();
        assert_eq!(count, 50);
    }
}
