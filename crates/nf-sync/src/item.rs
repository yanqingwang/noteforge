use serde::{Deserialize, Serialize};
use std::collections::HashMap;

/// Joplin-compatible item types
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ItemType {
    Note,
    Folder,
    Tag,
    Resource,
    NoteTag,
    Revision,
}

/// A sync item compatible with Joplin's data model.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SyncItem {
    pub id: String,
    #[serde(rename = "type")]
    pub item_type: ItemType,
    pub title: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub body: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub parent_id: Option<String>,
    pub created_time: i64,
    pub updated_time: i64,
    #[serde(default)]
    pub is_deleted: bool,
    /// Extra fields preserved for Joplin compatibility
    #[serde(flatten)]
    pub extra: HashMap<String, serde_json::Value>,
}

impl SyncItem {
    pub fn new_note(id: String, title: String, body: String, parent_id: Option<String>) -> Self {
        let now = chrono::Utc::now().timestamp_millis();
        SyncItem {
            id,
            item_type: ItemType::Note,
            title,
            body: Some(body),
            parent_id,
            created_time: now,
            updated_time: now,
            is_deleted: false,
            extra: HashMap::new(),
        }
    }

    pub fn new_folder(id: String, title: String, parent_id: Option<String>) -> Self {
        let now = chrono::Utc::now().timestamp_millis();
        SyncItem {
            id,
            item_type: ItemType::Folder,
            title,
            body: None,
            parent_id,
            created_time: now,
            updated_time: now,
            is_deleted: false,
            extra: HashMap::new(),
        }
    }

    pub fn new_tag(id: String, title: String) -> Self {
        let now = chrono::Utc::now().timestamp_millis();
        SyncItem {
            id,
            item_type: ItemType::Tag,
            title,
            body: None,
            parent_id: None,
            created_time: now,
            updated_time: now,
            is_deleted: false,
            extra: HashMap::new(),
        }
    }
}

/// Delta sync result from Joplin Server
#[derive(Debug, Deserialize)]
pub struct DeltaResult {
    pub items: Vec<DeltaItem>,
    #[serde(default)]
    pub cursor: Option<String>,
    #[serde(default)]
    pub has_more: bool,
}

#[derive(Debug, Deserialize)]
pub struct DeltaItem {
    pub id: String,
    #[serde(rename = "type")]
    pub event_type: String, // "create", "update", "delete"
    #[serde(skip_serializing_if = "Option::is_none")]
    pub item: Option<SyncItem>,
}