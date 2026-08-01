use serde::{Deserialize, Serialize};

/// Maps between Joplin server item names (ID-based) and local file paths.
/// Also tracks sync state: hashes, remote timestamps, and the delta cursor.
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct MappingStore {
    /// Latest delta cursor from server.
    pub delta_cursor: String,
    /// ID of the root folder item on the server.
    pub root_folder_id: Option<String>,
    /// All mapping entries.
    pub entries: Vec<MappingEntry>,
}

/// A single mapping entry: local path <-> Joplin server item.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct MappingEntry {
    /// Joplin item name (e.g., "nf-abc123.md").
    pub joplin_name: String,
    /// Server-assigned item id. Required for deletion on this server
    /// (name-based delete is rejected for non-32-hex names).
    #[serde(default)]
    pub remote_id: Option<String>,
    /// Local file path relative to vault root.
    pub local_path: String,
    /// 1=Note, 2=Folder, 4=Resource.
    pub item_type: i32,
    /// SHA-256 hash of local content at last sync.
    pub local_hash: Option<String>,
    /// Server updated_time at last sync.
    pub remote_updated_time: i64,
    /// When this entry was last synced (Unix timestamp).
    pub synced_at: i64,
}

impl MappingStore {
    pub fn new() -> Self {
        MappingStore::default()
    }

    /// Find entry by Joplin item name.
    pub fn by_name(&self, name: &str) -> Option<&MappingEntry> {
        self.entries.iter().find(|e| e.joplin_name == name)
    }

    /// Find entry by local path.
    pub fn by_path(&self, path: &str) -> Option<&MappingEntry> {
        self.entries.iter().find(|e| e.local_path == path)
    }

    /// Upsert (insert or update) a mapping entry.
    pub fn upsert(&mut self, entry: MappingEntry) {
        if let Some(pos) = self.entries.iter().position(|e| e.joplin_name == entry.joplin_name) {
            self.entries[pos] = entry;
        } else {
            self.entries.push(entry);
        }
    }

    /// Remove entry by Joplin name.
    pub fn remove(&mut self, name: &str) {
        self.entries.retain(|e| e.joplin_name != name);
    }

    /// Bulk rename: update all paths under old_prefix to new_prefix.
    pub fn rename_prefix(&mut self, old_prefix: &str, new_prefix: &str) {
        for e in &mut self.entries {
            if e.local_path.starts_with(old_prefix) {
                e.local_path = new_prefix.to_string() + &e.local_path[old_prefix.len()..];
            }
        }
    }

    /// Count notes in mapping.
    pub fn note_count(&self) -> usize {
        self.entries.iter().filter(|e| e.item_type == 1).count()
    }

    /// Count folders in mapping.
    pub fn folder_count(&self) -> usize {
        self.entries.iter().filter(|e| e.item_type == 2).count()
    }
}
