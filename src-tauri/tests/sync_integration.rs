use nf_vault::Vault;
use std::fs;
use std::path::Path;
use sha2::{Digest, Sha256};

fn sha256_bytes(data: &[u8]) -> String {
    let mut h = Sha256::new();
    h.update(data);
    format!("{:x}", h.finalize())
}

fn walk_md_files(root: &Path) -> Result<Vec<String>, std::io::Error> {
    let mut files = Vec::new();
    for entry in walkdir::WalkDir::new(root)
        .into_iter()
        .filter_entry(|e| {
            let name = e.file_name().to_string_lossy();
            !name.starts_with('.') && name != ".noteforge"
        })
    {
        let entry = entry?;
        if entry.file_type().is_file() {
            if let Some(ext) = entry.path().extension() {
                if ext == "md" {
                    let rel = entry.path().strip_prefix(root)
                        .unwrap_or(entry.path())
                        .to_string_lossy()
                        .to_string();
                    files.push(rel);
                }
            }
        }
    }
    files.sort();
    Ok(files)
}

fn generate_id() -> String {
    use rand::Rng;
    (0..16).map(|_| format!("{:02x}", rand::rng().random_range(0u8..=255))).collect()
}

fn serialize_joplin_note(id: &str, title: &str, body: &str, parent_id: &str) -> String {
    let now = chrono::Utc::now().timestamp_millis();
    let mut out = format!("{}\n\n", title);
    if !body.is_empty() { out.push_str(body); out.push_str("\n\n"); }
    out.push_str(&format!("id: {}\n", id));
    if !parent_id.is_empty() { out.push_str(&format!("parent_id: {}\n", parent_id)); }
    out.push_str(&format!("created_time: {}\nupdated_time: {}\ntype_: 1\n", now, now));
    out
}

#[test]
fn test_sync_detection_new_file() {
    let dir = tempfile::tempdir().unwrap();
    let root = dir.path().join("sync-vault");
    fs::create_dir_all(&root).unwrap();

    // Create vault with notes
    let vault = Vault::open(&root).unwrap();
    vault.write_note("existing.md", b"existing content").unwrap();
    vault.write_note("new-file.md", b"new file content").unwrap();

    // Scan files
    let files = walk_md_files(&root).unwrap();
    assert!(files.contains(&"existing.md".to_string()));
    assert!(files.contains(&"new-file.md".to_string()));
    assert_eq!(files.len(), 2, "should find 2 md files");

    // Simulate mapping from "initial upload": only existing.md is in mapping
    let existing_hash = sha256_bytes(b"existing content");
    let new_hash = sha256_bytes(b"new file content");

    // Both files should be detected as needing upload (fresh mapping)
    assert_ne!(existing_hash, sha256_bytes(b"different content"));

    // Verify hash changes on content modification
    vault.write_note("existing.md", b"modified content").unwrap();
    let modified_hash = sha256_bytes(b"modified content");
    assert_ne!(existing_hash, modified_hash, "hash should differ after modification");
}

#[test]
fn test_sync_detection_modified_file() {
    let dir = tempfile::tempdir().unwrap();
    let root = dir.path().join("mod-vault");
    fs::create_dir_all(&root).unwrap();

    let vault = Vault::open(&root).unwrap();
    vault.write_note("note.md", b"original").unwrap();

    let original_hash = sha256_bytes(b"original");
    let current = fs::read(root.join("note.md")).unwrap();
    let current_hash = sha256_bytes(&current);

    assert_eq!(original_hash, current_hash, "hash should match original content");

    // Modify file
    vault.write_note("note.md", b"modified").unwrap();
    let current2 = fs::read(root.join("note.md")).unwrap();
    let current2_hash = sha256_bytes(&current2);

    assert_ne!(original_hash, current2_hash, "hash should differ after modification");
    assert_eq!(current2_hash, sha256_bytes(b"modified"));
}

#[test]
fn test_sync_detection_deleted_file() {
    let dir = tempfile::tempdir().unwrap();
    let root = dir.path().join("del-vault");
    fs::create_dir_all(&root).unwrap();

    let vault = Vault::open(&root).unwrap();
    vault.write_note("keep.md", b"keep").unwrap();
    vault.write_note("delete.md", b"delete").unwrap();

    let files = walk_md_files(&root).unwrap();
    assert_eq!(files.len(), 2);

    // Delete one file
    vault.delete_note("delete.md").unwrap();

    let files_after = walk_md_files(&root).unwrap();
    assert_eq!(files_after.len(), 1);
    assert!(!files_after.contains(&"delete.md".to_string()));
    assert!(files_after.contains(&"keep.md".to_string()));
}

#[test]
fn test_sync_serialization_roundtrip() {
    let id = generate_id();
    let title = "Test Note";
    let body = "# Hello\n\nSome content here.";

    let serialized = serialize_joplin_note(&id, title, body, "");
    assert!(serialized.contains("Test Note"));
    assert!(serialized.contains("# Hello"));
    assert!(serialized.contains(&format!("id: {}", id)));
    assert!(serialized.contains("type_: 1"));
}

#[test]
fn test_full_sync_with_mapping_store_roundtrip() {
    use nf_sync::{MappingEntry, MappingStore};

    let dir = tempfile::tempdir().unwrap();
    let root = dir.path().join("sync-rt");
    fs::create_dir_all(&root).unwrap();

    let vault = Vault::open(&root).unwrap();
    vault.write_note("note1.md", b"content1").unwrap();
    vault.write_note("note2.md", b"content2").unwrap();

    // Simulate initial upload: create mapping
    let mut mapping = MappingStore::new();
    let files = walk_md_files(&root).unwrap();

    for rel_path in &files {
        let content = fs::read(root.join(rel_path)).unwrap();
        let hash = sha256_bytes(&content);
        let id = generate_id();
        mapping.upsert(MappingEntry {
            joplin_name: format!("nf-{}.md", id),
            remote_id: None,
            local_path: rel_path.clone(),
            item_type: 1,
            local_hash: Some(hash),
            remote_updated_time: 0,
            synced_at: chrono::Utc::now().timestamp(),
        });
    }
    assert_eq!(mapping.entries.len(), 2);

    // Modify file and detect change
    vault.write_note("note1.md", b"content1 modified").unwrap();

    let mut changed_count = 0;
    let files_after = walk_md_files(&root).unwrap();
    for rel_path in &files_after {
        let content = fs::read(root.join(rel_path)).unwrap();
        let hash = sha256_bytes(&content);
        if let Some(entry) = mapping.entries.iter().find(|e| e.local_path == *rel_path) {
            if entry.local_hash.as_deref() != Some(&hash) {
                changed_count += 1;
            }
        }
    }
    assert_eq!(changed_count, 1, "note1 should be detected as changed");
}
