use serde::{Deserialize, Serialize};
use std::fs;
use std::path::Path;

/// Saved workspace layout state.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct WorkspaceState {
    pub version: String,
    pub open_files: Vec<String>,
    pub active_file: Option<String>,
    pub show_preview: bool,
    pub show_search: bool,
    pub sidebar_width: f64,
    pub last_vault_path: Option<String>,
    pub cursor_positions: Vec<CursorPosition>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CursorPosition {
    pub path: String,
    pub line: usize,
    pub column: usize,
}

impl Default for WorkspaceState {
    fn default() -> Self {
        WorkspaceState {
            version: env!("CARGO_PKG_VERSION").into(),
            open_files: vec![],
            active_file: None,
            show_preview: false,
            show_search: false,
            sidebar_width: 280.0,
            last_vault_path: None,
            cursor_positions: vec![],
        }
    }
}

impl WorkspaceState {
    /// Save workspace state to vault directory.
    pub fn save(&self, vault_root: &Path) -> Result<(), WorkspaceError> {
        let dir = vault_root.join(".noteforge");
        fs::create_dir_all(&dir)?;
        let path = dir.join("workspace.json");
        let json = serde_json::to_string_pretty(self)?;
        let tmp = path.with_extension("tmp");
        fs::write(&tmp, &json)?;
        fs::rename(&tmp, &path)?;
        Ok(())
    }

    /// Load workspace state from vault directory.
    pub fn load(vault_root: &Path) -> Result<Self, WorkspaceError> {
        let path = vault_root.join(".noteforge").join("workspace.json");
        if !path.exists() {
            return Ok(WorkspaceState::default());
        }
        let json = fs::read_to_string(&path)?;
        Ok(serde_json::from_str(&json)?)
    }

    /// Add a file to the open files list (avoid duplicates).
    pub fn open_file(&mut self, path: &str) {
        if !self.open_files.iter().any(|f| f == path) {
            self.open_files.push(path.to_string());
        }
        self.active_file = Some(path.to_string());
    }

    /// Remove a file from the open files list.
    pub fn close_file(&mut self, path: &str) {
        self.open_files.retain(|f| f != path);
        if self.active_file.as_deref() == Some(path) {
            self.active_file = self.open_files.first().cloned();
        }
    }
}

#[derive(Debug, thiserror::Error)]
pub enum WorkspaceError {
    #[error("io: {0}")]
    Io(#[from] std::io::Error),
    #[error("json: {0}")]
    Json(#[from] serde_json::Error),
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_default_state() {
        let s = WorkspaceState::default();
        assert_eq!(s.version, "0.1.0");
        assert!(s.open_files.is_empty());
    }

    #[test]
    fn test_open_close_file() {
        let mut s = WorkspaceState::default();
        s.open_file("a.md");
        s.open_file("b.md");
        assert_eq!(s.open_files.len(), 2);
        assert_eq!(s.active_file.as_deref(), Some("b.md"));
        s.close_file("b.md");
        assert_eq!(s.active_file.as_deref(), Some("a.md"));
    }

    #[test]
    fn test_save_load_roundtrip() {
        let dir = tempfile::tempdir().unwrap();
        let mut s = WorkspaceState::default();
        s.open_file("test.md");
        s.show_preview = true;
        s.save(dir.path()).unwrap();
        let loaded = WorkspaceState::load(dir.path()).unwrap();
        assert_eq!(loaded.open_files, vec!["test.md"]);
        assert!(loaded.show_preview);
    }

    #[test]
    fn test_load_nonexistent() {
        let dir = tempfile::tempdir().unwrap();
        let s = WorkspaceState::load(dir.path()).unwrap();
        assert!(s.open_files.is_empty());
    }
}
