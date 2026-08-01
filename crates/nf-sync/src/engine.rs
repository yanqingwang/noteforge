use crate::drivers::joplin_server::{JoplinItem, JoplinServerDriver};
use crate::encryption::JoplinE2eeLayer;
use crate::error::SyncError;
use crate::file_api::FileApi;
use crate::item::SyncItem;
use crate::mapper::{MappingEntry, MappingStore};
use std::collections::HashMap;
use std::path::Path;

/// Sync mode determines the operation type.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SyncMode {
    /// Pull all items from server, create local file tree (first-time).
    InitialDownload,
    /// Push all local items to server, create remote hierarchy (first-time).
    InitialUpload,
    /// Full bidirectional sync (push local, pull remote, resolve).
    FullSync,
}

/// Core sync orchestrator — supports Joplin Server delta & full sync modes.
pub struct SyncEngine {
    target: Box<dyn FileApi>,
    local_items: HashMap<String, SyncItem>,
    dirty_ids: Vec<String>,
    cursor: Option<String>,
    mapping: MappingStore,
    joplin: Option<JoplinServerDriver>,
    e2ee: Option<JoplinE2eeLayer>,
    /// master key ID used when encrypting new items
    active_master_key_id: Option<String>,
    /// password used to decrypt server-side master keys (type_=9)
    e2ee_password: Option<String>,
}

impl SyncEngine {
    pub fn new(target: Box<dyn FileApi>) -> Self {
        SyncEngine {
            target,
            local_items: HashMap::new(),
            dirty_ids: Vec::new(),
            cursor: None,
            mapping: MappingStore::new(),
            joplin: None,
            e2ee: None,
            active_master_key_id: None,
            e2ee_password: None,
        }
    }

    /// Attach a Joplin Server driver for advanced sync operations.
    /// The target must also be the same JoplinServerDriver instance.
    pub fn with_joplin(mut self, joplin: JoplinServerDriver) -> Self {
        self.joplin = Some(joplin);
        self
    }

    /// Enable Joplin-compatible E2EE with the given layer.
    pub fn with_e2ee(mut self, e2ee: JoplinE2eeLayer, active_master_key_id: Option<String>) -> Self {
        self.e2ee = Some(e2ee);
        self.active_master_key_id = active_master_key_id;
        self
    }

    /// Set the E2EE password so server-side master keys can be loaded.
    pub fn with_e2ee_password(mut self, password: Option<String>) -> Self {
        self.e2ee_password = password;
        self
    }

    /// Scan a list of Joplin items for master keys (type_=9) and load them
    /// using the configured E2EE password. This enables decrypting items that
    /// were encrypted by Obsidian/official Joplin on other devices.
    pub fn feed_server_master_keys(&mut self, items: &[JoplinItem]) -> Result<(), SyncError> {
        let (Some(e2ee), Some(password)) = (&mut self.e2ee, &self.e2ee_password) else { return Ok(()); };
        for item in items {
            if item.type_ != 9 { continue; } // MasterKey
            let content = item.extra.get("content")
                .and_then(|v| v.as_str())
                .unwrap_or("")
                .to_string();
            if content.is_empty() { continue; }
            let method = item.extra.get("encryption_method")
                .and_then(|v| v.as_i64())
                .unwrap_or(8); // KeyV1 default
            if method != 8 { continue; } // only KeyV1 supported
            match e2ee.load_master_key(&item.id, &password, &content) {
                Ok(_) => {
                    if self.active_master_key_id.is_none() {
                        self.active_master_key_id = Some(item.id.clone());
                    }
                }
                Err(e) => eprintln!("load server master key {} failed: {}", item.id, e),
            }
        }
        Ok(())
    }

    /// Is E2EE enabled?
    pub fn e2ee_enabled(&self) -> bool { self.e2ee.is_some() }

    pub fn get_active_master_key_id(&self) -> Option<&str> {
        self.active_master_key_id.as_deref()
    }

    /// Decrypt a Joplin item's content if it's encrypted; otherwise return body as-is.
    pub fn decrypt_joplin_item(&self, item: &JoplinItem) -> Result<String, SyncError> {
        if item.encryption_applied == 1 {
            let e2ee = self.e2ee.as_ref()
                .ok_or_else(|| SyncError::Other("Item is encrypted but E2EE is not enabled".into()))?;
            if item.encryption_cipher_text.is_empty() {
                return Err(SyncError::Other(format!(
                    "Item {} marked encrypted but has no cipher text", item.id)));
            }
            e2ee.decrypt_item(&item.encryption_cipher_text)
        } else {
            Ok(item.body.clone())
        }
    }

    /// Encrypt an item body if E2EE is enabled (StringV1). Returns body to store.
    fn encrypt_body(&self, body: &str) -> Result<String, SyncError> {
        if let (Some(e2ee), Some(key_id)) = (&self.e2ee, &self.active_master_key_id) {
            e2ee.encrypt_item(body, key_id)
        } else {
            Ok(body.to_string())
        }
    }

    /// Load mapping from persistence.
    pub fn load_mapping(&mut self, mapping: MappingStore) {
        self.cursor = Some(mapping.delta_cursor.clone());
        self.mapping = mapping;
    }

    /// Get a reference to the current mapping store.
    pub fn mapping(&self) -> &MappingStore {
        &self.mapping
    }

    // ── Initial Download ────────────────────────────────────────────

    /// Initial download: pull all items from Joplin server and create local file tree.
    /// Returns the generated file tree entries and updated mapping.
    pub async fn initial_download(&mut self, vault_root: &Path, joplin: &JoplinServerDriver) -> Result<SyncReport, SyncError> {
        let mut report = SyncReport::default();

        // 1. List all remote children
        let children = joplin.list_all_children().await?;

        // 2. Build all items from metadata
        let mut items: Vec<JoplinItem> = Vec::new();
        for child in &children {
            match joplin.get_item(&child.name).await {
                Ok(raw) => {
                    if let Ok(parsed) = parse_joplin_item(&raw) {
                        items.push(parsed);
                    }
                }
                Err(SyncError::NotFound(_)) => continue,
                Err(e) => { report.errors += 1; eprintln!("Download failed {}: {}", child.name, e); }
            }
        }

        // 2.5 Load server master keys (type_=9) if E2EE enabled
        self.feed_server_master_keys(&items)?;

        // 3. Build folder hierarchy: map id -> local path
        let mut id_to_path: HashMap<String, String> = HashMap::new();
        let root = vault_root.to_path_buf();

        // First pass: resolve folders
        for item in &items {
            if item.type_ == 2 {
                // Folder
                let parent_path = if item.parent_id.is_empty() {
                    String::new()
                } else {
                    id_to_path.get(&item.parent_id).cloned().unwrap_or_default()
                };
                let path = Path::new(&parent_path)
                    .join(&item.title)
                    .to_string_lossy()
                    .to_string();
                let full = root.join(&path);
                std::fs::create_dir_all(&full)
                    .map_err(|e| SyncError::Other(format!("create dir {}: {}", path, e)))?;
                id_to_path.insert(item.id.clone(), path.clone());
                self.mapping.upsert(MappingEntry {
                    joplin_name: format!("nf-{}.md", item.id),
                    remote_id: Some(item.id.clone()),
                    local_path: format!("{}/", path),
                    item_type: 2,
                    local_hash: None,
                    remote_updated_time: item.updated_time,
                    synced_at: chrono::Utc::now().timestamp(),
                });
                report.downloaded += 1;
            }
        }

        // Second pass: write notes
        for item in &items {
            if item.type_ == 1 {
                let parent_path = if item.parent_id.is_empty() {
                    String::new()
                } else {
                    id_to_path.get(&item.parent_id).cloned().unwrap_or_default()
                };
                let filename = sanitize_filename(&item.title);
                let path = Path::new(&parent_path)
                    .join(&filename)
                    .with_extension("md");
                let rel = path.to_string_lossy().to_string();
                let full = root.join(&rel);
                if let Some(parent) = full.parent() {
                    std::fs::create_dir_all(parent).ok();
                }
                // Decrypt if E2EE is enabled and item is encrypted
                let body = match self.decrypt_joplin_item(item) {
                    Ok(b) => b,
                    Err(e) => {
                        report.errors += 1;
                        eprintln!("Decrypt {} failed: {}", item.id, e);
                        continue;
                    }
                };
                std::fs::write(&full, &body)
                    .map_err(|e| SyncError::Other(format!("write {}: {}", rel, e)))?;

                let hash = sha256(&body);
                self.mapping.upsert(MappingEntry {
                    joplin_name: format!("nf-{}.md", item.id),
                    remote_id: Some(item.id.clone()),
                    local_path: rel.clone(),
                    item_type: 1,
                    local_hash: Some(hash),
                    remote_updated_time: item.updated_time,
                    synced_at: chrono::Utc::now().timestamp(),
                });
                report.downloaded += 1;
            }
        }

        // 4. Consume delta to advance cursor
        self.mapping.delta_cursor = joplin.consume_delta().await?;
        self.cursor = Some(self.mapping.delta_cursor.clone());
        Ok(report)
    }

    // ── Initial Upload ──────────────────────────────────────────────

    /// Initial upload: push all local markdown files to Joplin server.
    /// Walks the vault directory and creates folder hierarchy + notes on server.
    pub async fn initial_upload(&mut self, joplin: &JoplinServerDriver) -> Result<SyncReport, SyncError> {
        let mut report = SyncReport::default();

        // 1. Discover all .md files
        let paths: Vec<String> = self.discover_markdown_files();
        if paths.is_empty() {
            // If no items tracked, this may be called before mark_changed
            return Err(SyncError::Other("No files to upload. Add files via mark_changed first.".into()));
        }

        // 2. Discover all unique directories
        let mut dirs: HashMap<String, String> = HashMap::new();
        for p in &paths {
            if let Some(parent) = Path::new(p).parent() {
                let parent_str = parent.to_string_lossy().to_string();
                if !parent_str.is_empty() {
                    dirs.insert(parent_str.clone(), String::new());
                }
            }
        }

        // Sort by depth (shallow first)
        let mut sorted_dirs: Vec<&String> = dirs.keys().collect();
        sorted_dirs.sort_by_key(|d| d.split('/').count());

        // 3. Upload folders to server
        for dir in &sorted_dirs {
            let parent_id = self.mapping.entries.iter()
                .find(|e| e.item_type == 2 && !e.local_path.is_empty() && {
                    let dir_with_slash = format!("{}/", dir);
                    let parent_dir = Path::new(&dir_with_slash).parent()
                        .map(|p| format!("{}/", p.to_string_lossy().to_string()))
                        .unwrap_or_default();
                    e.local_path == parent_dir
                })
                .map(|e| e.joplin_name.trim_end_matches(".md").to_string())
                .unwrap_or_default();

            let title = dir.rsplit('/').next().unwrap_or(dir);
            let id = generate_joplin_id();
            let name = format!("nf-{}.md", id);
            let serialized = serialize_item(&id, title, "", &parent_id, 2, 0, 0);
            let remote_id = joplin.put_item(&name, serialized.as_bytes(), true).await?;

            self.mapping.upsert(MappingEntry {
                joplin_name: name,
                remote_id: Some(remote_id),
                local_path: format!("{}/", dir),
                item_type: 2,
                local_hash: None,
                remote_updated_time: 0,
                synced_at: chrono::Utc::now().timestamp(),
            });
            report.uploaded += 1;
        }

        // 4. Upload notes to server
        for p in &paths {
            let content = std::fs::read(p)
                .map_err(|e| SyncError::Other(format!("read {}: {}", p, e)))?;
            let body = String::from_utf8_lossy(&content).to_string();
            let title = Path::new(p).file_stem()
                .and_then(|s| s.to_str())
                .unwrap_or("untitled");

            let parent_id = {
                let parent_dir = Path::new(p).parent()
                    .map(|d| format!("{}/", d.to_string_lossy().to_string()))
                    .unwrap_or_default();
                self.mapping.entries.iter()
                    .find(|e| e.item_type == 2 && e.local_path == parent_dir)
                    .map(|e| e.joplin_name.trim_end_matches(".md").to_string())
                    .unwrap_or_default()
            };

            let id = generate_joplin_id();
            let name = format!("nf-{}.md", id);
            // Encrypt body if E2EE enabled (StringV1)
            let (body_out, enc_applied) = if let (Some(e2ee), Some(key_id)) = (&self.e2ee, &self.active_master_key_id) {
                match e2ee.encrypt_item(&body, key_id) {
                    Ok(ct) => (ct, 1),
                    Err(e) => { report.errors += 1; eprintln!("Encrypt {} failed: {}", p, e); continue; }
                }
            } else {
                (body.clone(), 0)
            };
            let serialized = serialize_item(&id, title, &body_out, &parent_id, 1, enc_applied, 0);
            let remote_id = joplin.put_item(&name, serialized.as_bytes(), true).await?;

            let hash = sha256(&body);
            self.mapping.upsert(MappingEntry {
                joplin_name: name,
                remote_id: Some(remote_id),
                local_path: p.clone(),
                item_type: 1,
                local_hash: Some(hash),
                remote_updated_time: 0,
                synced_at: chrono::Utc::now().timestamp(),
            });
            report.uploaded += 1;
        }

        // 5. Consume delta
        self.mapping.delta_cursor = joplin.consume_delta().await?;
        self.cursor = Some(self.mapping.delta_cursor.clone());
        Ok(report)
    }

    // ── Full Sync ───────────────────────────────────────────────────

    /// Full sync: push local changes → pull remote delta → resolve.
    pub async fn full_sync(&mut self, joplin: &JoplinServerDriver) -> Result<SyncReport, SyncError> {
        let mut report = SyncReport::default();

        // Phase 1: Push local dirty items
        for id in &self.dirty_ids {
            if let Some(item) = self.local_items.get(id) {
                let name = format!("nf-{}.md", id);
                // Encrypt body if E2EE enabled
                let (body_out, enc_applied) = if let (Some(e2ee), Some(key_id)) = (&self.e2ee, &self.active_master_key_id) {
                    let body = item.body.as_deref().unwrap_or("");
                    match e2ee.encrypt_item(body, key_id) {
                        Ok(ct) => (ct, 1),
                        Err(e) => { report.errors += 1; eprintln!("Encrypt {} failed: {}", id, e); continue; }
                    }
                } else {
                    (item.body.clone().unwrap_or_default(), 0)
                };
                let serialized = serialize_item(
                    &item.id, &item.title, &body_out,
                    item.parent_id.as_deref().unwrap_or(""),
                    1, enc_applied, 0);
                match joplin.put_item(&name, serialized.as_bytes(), true).await {
                    Ok(remote_id) => {
                        report.uploaded += 1;
                        self.mapping.upsert(MappingEntry {
                            joplin_name: name,
                            remote_id: Some(remote_id),
                            local_path: id.clone(),
                            item_type: 1,
                            local_hash: None,
                            remote_updated_time: 0,
                            synced_at: chrono::Utc::now().timestamp(),
                        });
                    }
                    Err(e) => { report.errors += 1; eprintln!("Push failed {}: {}", id, e); }
                }
            }
        }
        self.dirty_ids.clear();

        // Phase 2: Pull delta changes from server
        let cursor = self.cursor.clone().unwrap_or_default();
        let delta = joplin.get_delta(&cursor).await?;
        self.cursor = Some(delta.cursor.clone());
        self.mapping.delta_cursor = delta.cursor.clone();

        // Feed master keys from delta items first (so encrypted notes can decrypt)
        {
            let mk_items: Vec<JoplinItem> = delta.items.iter()
                .filter_map(|d| d.item.as_ref().filter(|i| i.type_ == 9).cloned())
                .collect();
            self.feed_server_master_keys(&mk_items)?;
        }

        for d in &delta.items {
            if d.event_type == 3 {
                // Delete
                self.local_items.remove(&d.id);
                self.mapping.remove(&d.id);
                report.downloaded += 1;
            } else if let Some(ref item) = d.item {
                if item.type_ == 1 {
                    // Note create/update
                    let body = if item.encryption_applied > 0 {
                        item.encryption_cipher_text.clone()
                    } else {
                        item.body.clone()
                    };
                    let sync_item = SyncItem {
                        id: item.id.clone(),
                        item_type: crate::item::ItemType::Note,
                        title: item.title.clone(),
                        body: Some(body),
                        parent_id: if item.parent_id.is_empty() { None } else { Some(item.parent_id.clone()) },
                        created_time: item.created_time,
                        updated_time: item.updated_time,
                        is_deleted: item.is_deleted,
                        extra: HashMap::new(),
                    };
                    if let Some(local) = self.local_items.get(&item.id) {
                        if item.updated_time > local.updated_time {
                            self.local_items.insert(item.id.clone(), sync_item);
                            report.downloaded += 1;
                        } else if item.updated_time < local.updated_time {
                            report.conflicts += 1;
                        }
                    } else {
                        self.local_items.insert(item.id.clone(), sync_item);
                        report.downloaded += 1;
                    }
                }
            }
        }
        Ok(report)
    }

    // ── Legacy compatibility ────────────────────────────────────────

    /// Full sync cycle: push local → pull remote → apply (legacy).
    pub async fn sync_all(&mut self) -> Result<SyncReport, SyncError> {
        let mut report = SyncReport::default();

        for id in &self.dirty_ids {
            if let Some(item) = self.local_items.get(id) {
                let path = item_path(id, &item.item_type);
                // Encrypt body if E2EE enabled (StringV1, Joplin-compatible)
                let json = if let (Some(e2ee), Some(key_id)) = (&self.e2ee, &self.active_master_key_id) {
                    let body = item.body.as_deref().unwrap_or("");
                    match e2ee.encrypt_item(body, key_id) {
                        Ok(ct) => {
                            let mut enc = item.clone();
                            enc.body = Some(ct);
                            serde_json::to_string(&enc)?
                        }
                        Err(e) => { report.errors += 1; eprintln!("Encrypt {} failed: {}", id, e); continue; }
                    }
                } else {
                    serde_json::to_string(item)?
                };
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

    /// Discover all .md files from local_items (used for initial upload).
    fn discover_markdown_files(&self) -> Vec<String> {
        let mut paths: Vec<String> = self.local_items.iter()
            .filter(|(_, item)| matches!(item.item_type, crate::item::ItemType::Note))
            .map(|(_, item)| item.title.clone())
            .filter(|t| !t.is_empty())
            .collect();
        paths.sort();
        paths.dedup();
        paths
    }
}

// ── Helpers ─────────────────────────────────────────────────────────

fn parse_joplin_item(raw: &[u8]) -> Result<JoplinItem, String> {
    let text = String::from_utf8_lossy(raw);
    let lines: Vec<&str> = text.lines().collect();

    // Find the last blank line separator
    let sep = lines.iter().rposition(|l| l.trim().is_empty()).unwrap_or(lines.len());
    let body = lines[..sep].join("\n");

    // Parse k:v metadata after separator
    let meta: Vec<&str> = lines[sep + 1..].to_vec();
    let mut id = String::new();
    let mut parent_id = String::new();
    let mut type_: i32 = 1;
    let mut created_time: i64 = 0;
    let mut updated_time: i64 = 0;
    let mut encryption_applied: i32 = 0;
    let mut encryption_cipher_text = String::new();

    // Title is the first non-empty line of body
    let body_title = body.lines().next().unwrap_or("untitled");

    for line in meta {
        if let Some((k, v)) = line.split_once(": ") {
            match k {
                "id" => id = v.to_string(),
                "parent_id" => parent_id = v.to_string(),
                "type_" => type_ = v.parse().unwrap_or(3),
                "created_time" => created_time = v.parse().unwrap_or(0),
                "updated_time" => updated_time = v.parse().unwrap_or(0),
                "encryption_applied" => encryption_applied = v.parse().unwrap_or(0),
                "encryption_cipher_text" => encryption_cipher_text = v.to_string(),
                _ => {}
            }
        }
    }

    Ok(JoplinItem {
        id,
        parent_id,
        title: body_title.to_string(),
        body: if body.lines().count() > 1 { body.lines().skip(1).collect::<Vec<_>>().join("\n") } else { body.clone() },
        type_,
        encryption_applied,
        encryption_cipher_text,
        created_time,
        updated_time,
        is_deleted: false,
        mime: String::new(),
        filename: String::new(),
        file_extension: String::new(),
        size: 0,
        note_id: String::new(),
        tag_id: String::new(),
        extra: HashMap::new(),
    })
}

fn serialize_item(id: &str, title: &str, body: &str, parent_id: &str, type_: i32, encryption_applied: i32, _encrypted: i32) -> String {
    let now = chrono::Utc::now().timestamp_millis();
    let mut out = format!("{}\n\n", title);
    if !body.is_empty() {
        out.push_str(body);
        out.push_str("\n\n");
    }
    out.push_str(&format!("id: {}\n", id));
    if !parent_id.is_empty() {
        out.push_str(&format!("parent_id: {}\n", parent_id));
    }
    out.push_str(&format!("created_time: {}\n", now));
    out.push_str(&format!("updated_time: {}\n", now));
    out.push_str(&format!("type_: {}\n", type_));
    if encryption_applied > 0 {
        out.push_str(&format!("encryption_applied: {}\n", encryption_applied));
    }
    out
}

fn sanitize_filename(name: &str) -> String {
    name.chars()
        .map(|c| if c.is_ascii_alphanumeric() || c == '-' || c == '_' || c == '.' || c == ' ' || c > '\u{7f}' { c } else { '_' })
        .collect::<String>()
        .trim()
        .to_string()
}

fn generate_joplin_id() -> String {
    use rand::Rng;
    let bytes: Vec<u8> = (0..16).map(|_| rand::rng().random_range(0..=255u8)).collect();
    bytes.iter().map(|b| format!("{:02x}", b)).collect()
}

fn sha256(data: &str) -> String {
    use sha2::{Digest, Sha256};
    let mut h = Sha256::new();
    h.update(data.as_bytes());
    format!("{:x}", h.finalize())
}

#[derive(Debug, Default)]
pub struct SyncReport {
    pub uploaded: usize,
    pub downloaded: usize,
    pub conflicts: usize,
    pub errors: usize,
    pub resync: bool,
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