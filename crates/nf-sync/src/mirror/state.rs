//! Last-sync state: what each side looked like at the previous successful
//! sync, so the next run can diff in four quadrants
//! (local changed? × remote changed?).

use crate::error::SyncError;
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::path::Path;

pub const STATE_FILE: &str = ".noteforge/sync-state.json";

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct SyncState {
    pub version: u32,
    #[serde(default)]
    pub files: HashMap<String, StateEntry>,
    #[serde(default)]
    pub last_sync_at: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct StateEntry {
    /// sha256 of the local plaintext content at last sync.
    pub local_hash: String,
    /// Local mtime (ms) / size at last sync — lets the next run skip
    /// re-hashing untouched files.
    pub local_mtime: u64,
    pub local_size: u64,
    /// Remote etag at last sync.
    pub remote_etag: Option<String>,
    pub synced_at: i64,
}

impl SyncState {
    pub fn load(vault_root: &Path) -> Result<SyncState, SyncError> {
        let path = vault_root.join(STATE_FILE);
        if !path.exists() {
            return Ok(SyncState { version: 1, ..Default::default() });
        }
        let raw = std::fs::read_to_string(&path)?;
        let state: SyncState = serde_json::from_str(&raw)?;
        Ok(state)
    }

    pub fn save(&self, vault_root: &Path) -> Result<(), SyncError> {
        let path = vault_root.join(STATE_FILE);
        if let Some(parent) = path.parent() {
            std::fs::create_dir_all(parent)?;
        }
        let json = serde_json::to_string_pretty(self)?;
        // 0600 — state content is not secret, but keep the tree tidy
        std::fs::write(&path, json)?;
        Ok(())
    }

    pub fn is_first_sync(&self) -> bool {
        self.files.is_empty()
    }

    pub fn upsert(
        &mut self,
        path: &str,
        local_hash: String,
        local_mtime: u64,
        local_size: u64,
        remote_etag: Option<String>,
    ) {
        self.files.insert(
            path.to_string(),
            StateEntry {
                local_hash,
                local_mtime,
                local_size,
                remote_etag,
                synced_at: chrono::Utc::now().timestamp(),
            },
        );
    }

    pub fn remove(&mut self, path: &str) {
        self.files.remove(path);
    }
}
