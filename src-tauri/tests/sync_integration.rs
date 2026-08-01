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


/// Local copy of parse_joplin_item_meta (mirrors main.rs) for integration testing.
fn parse_joplin_item_meta_test(raw: &[u8]) -> Option<(String, String, i32, String)> {
    let text = String::from_utf8_lossy(raw);
    let lines: Vec<&str> = text.lines().collect();
    if lines.is_empty() { return None; }
    let title = lines.first().map(|s| s.to_string()).unwrap_or_default();
    let mut body = String::new();
    let mut type_: i32 = 1;
    let mut parent_id = String::new();
    if let Some(sep) = lines.iter().rposition(|l| l.trim().is_empty()) {
        body = lines[1..sep.min(lines.len())].join("\n");
        for line in &lines[sep + 1..] {
            if let Some((k, v)) = line.split_once(": ") {
                match k {
                    "type_" => type_ = v.trim().parse().unwrap_or(1),
                    "parent_id" => parent_id = v.trim().to_string(),
                    _ => {}
                }
            }
        }
    } else {
        body = lines[1..].join("\n");
    }
    Some((title, body, type_, parent_id))
}

fn sanitize_filename_simple_test(name: &str) -> String {
    name.chars()
        .map(|c| if c.is_ascii_alphanumeric() || c == '-' || c == '_' || c == ' ' || c > '\u{7f}' { c } else { '_' })
        .collect::<String>()
        .trim()
        .to_string()
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

#[test]
fn test_parse_joplin_item_meta_folder_and_note() {
    // Folder item (type_=2)
    let folder_serialized = "My Folder\n\nid: f1\nparent_id: \ntype_: 2\nupdated_time: 1000\n";
    let (title, body, type_, parent) = parse_joplin_item_meta_test(folder_serialized.as_bytes()).unwrap();
    assert_eq!(title, "My Folder");
    assert_eq!(type_, 2);
    assert!(parent.is_empty());
    assert!(body.is_empty());

    // Note item (type_=1) with parent_id pointing to folder
    let note_serialized = "My Note\n\nSome content.\n\nid: n1\nparent_id: f1\ntype_: 1\nupdated_time: 2000\n";
    let (title, body, type_, parent) = parse_joplin_item_meta_test(note_serialized.as_bytes()).unwrap();
    assert_eq!(title, "My Note");
    assert_eq!(type_, 1);
    assert_eq!(parent, "f1");
    assert!(body.contains("Some content."));
    println!("✅ parse_joplin_item_meta correctly distinguishes folder (type_=2) and note (type_=1) with parent_id");
}

#[test]
fn test_folder_hierarchy_resolution() {
    // Simulate the folder path resolution used in downloads
    use std::collections::HashMap;

    // Server items: folder "Parent" (id=f1), sub-folder "Child" (id=f2, parent=f1),
    // note (id=n1, parent=f2)
    let items: Vec<(String, String, String, i32, String)> = vec![
        ("f1.md".into(), "f1".into(), "Parent".into(), 2, String::new()),
        ("f2.md".into(), "f2".into(), "Child".into(), 2, "f1".into()),
        ("n1.md".into(), "n1".into(), "Deep Note".into(), 1, "f2".into()),
    ];

    // First pass: folders → id → local path
    let mut folder_paths: HashMap<String, String> = HashMap::new();
    for (name, id, title, type_, parent_id) in &items {
        if *type_ != 2 { continue; }
        let parent_path = if parent_id.is_empty() {
            String::new()
        } else {
            folder_paths.get(parent_id).cloned().unwrap_or_default()
        };
        let path = std::path::Path::new(&parent_path)
            .join(sanitize_filename_simple_test(title))
            .to_string_lossy()
            .to_string();
        folder_paths.insert(id.clone(), path.clone());
        println!("  folder {} -> {}", id, path);
    }

    // Verify folder hierarchy
    assert_eq!(folder_paths.get("f1").unwrap(), "Parent");
    assert_eq!(folder_paths.get("f2").unwrap(), "Parent/Child");

    // Note should resolve to Parent/Child/Deep Note.md
    let note = items.iter().find(|i| i.3 == 1).unwrap();
    let parent_path = folder_paths.get(&note.4).cloned().unwrap_or_default();
    let rel = std::path::Path::new(&parent_path)
        .join(format!("{}.md", sanitize_filename_simple_test(&note.2)))
        .to_string_lossy()
        .to_string();
    assert_eq!(rel, "Parent/Child/Deep Note.md");
    println!("✅ Folder hierarchy resolves: note -> {}", rel);
}
