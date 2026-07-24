use crate::error::SyncError;
use crate::file_api::FileApi;
use crate::item::SyncItem;
use std::collections::HashMap;

/// Core sync orchestrator — delta sync with Joplin-compatible targets.
pub struct SyncEngine {
    target: Box<dyn FileApi>,
    local_items: HashMap<String, SyncItem>,
    dirty_ids: Vec<String>,
    cursor: Option<String>,
}

impl SyncEngine {
    pub fn new(target: Box<dyn FileApi>) -> Self {
        SyncEngine { target, local_items: HashMap::new(), dirty_ids: Vec::new(), cursor: None }
    }

    /// Full sync cycle: push local → pull remote → apply
    pub async fn sync_all(&mut self) -> Result<SyncReport, SyncError> {
        let mut report = SyncReport::default();

        for id in &self.dirty_ids {
            if let Some(item) = self.local_items.get(id) {
                let path = item_path(id, &item.item_type);
                let json = serde_json::to_string(item)?;
                match self.target.put(&path, json.as_bytes()).await {
                    Ok(_) => report.uploaded += 1,
                    Err(e) => { report.errors += 1; eprintln!("Upload failed {}: {}", id, e); }
                }
            }
        }
        self.dirty_ids.clear();

        match self.pull_delta().await {
            Ok(remote_items) => {
                for item in remote_items {
                    if item.is_deleted {
                        self.local_items.remove(&item.id);
                        report.downloaded += 1;
                    } else if let Some(local) = self.local_items.get(&item.id) {
                        if item.updated_time > local.updated_time {
                            self.local_items.insert(item.id.clone(), item);
                            report.downloaded += 1;
                        } else if item.updated_time < local.updated_time {
                            report.conflicts += 1;
                        }
                    } else {
                        self.local_items.insert(item.id.clone(), item);
                        report.downloaded += 1;
                    }
                }
            }
            Err(SyncError::ResyncRequired) => {
                report.resync = true;
                self.cursor = None;
                self.full_resync().await?;
            }
            Err(e) => return Err(e),
        }
        Ok(report)
    }

    async fn pull_delta(&mut self) -> Result<Vec<SyncItem>, SyncError> {
        let mut items = Vec::new();
        // List all Joplin-compatible subdirectories
        for prefix in &["notes", "folders", "tags", "resources", "note_tags", "revisions"] {
            for file in self.target.list(prefix).await? {
                if file.is_dir || !file.path.ends_with(".json") { continue; }
                if let Ok(data) = self.target.get(&file.path).await {
                    if let Ok(item) = serde_json::from_slice::<SyncItem>(&data) {
                        items.push(item);
                    }
                }
            }
        }
        Ok(items)
    }

    async fn full_resync(&mut self) -> Result<(), SyncError> {
        for prefix in &["notes", "folders", "tags", "resources", "note_tags", "revisions"] {
            for file in self.target.list(prefix).await? {
                if file.is_dir || !file.path.ends_with(".json") { continue; }
                if let Ok(data) = self.target.get(&file.path).await {
                    if let Ok(item) = serde_json::from_slice::<SyncItem>(&data) {
                        self.local_items.insert(item.id.clone(), item);
                    }
                }
            }
        }
        Ok(())
    }

    pub fn mark_changed(&mut self, item: SyncItem) {
        let id = item.id.clone();
        self.local_items.insert(id.clone(), item);
        if !self.dirty_ids.contains(&id) { self.dirty_ids.push(id); }
    }

    pub fn get_local(&self, id: &str) -> Option<&SyncItem> { self.local_items.get(id) }

    pub async fn test_connection(&self) -> Result<(), SyncError> { self.target.test().await }
}

#[derive(Debug, Default)]
pub struct SyncReport {
    pub uploaded: usize, pub downloaded: usize,
    pub conflicts: usize, pub errors: usize, pub resync: bool,
}

fn item_path(id: &str, item_type: &crate::item::ItemType) -> String {
    let dir = match item_type {
        crate::item::ItemType::Note => "notes",
        crate::item::ItemType::Folder => "folders",
        crate::item::ItemType::Tag => "tags",
        crate::item::ItemType::Resource => "resources",
        crate::item::ItemType::NoteTag => "note_tags",
        crate::item::ItemType::Revision => "revisions",
    };
    format!("{}/{}.json", dir, id)
}