use nf_sync::drivers::filesystem::FsDriver;
use nf_sync::engine::SyncEngine;
use nf_sync::item::SyncItem;
use std::path::Path;

#[tokio::test]
async fn test_filesystem_sync_cycle() {
    let dir = tempfile::tempdir().unwrap();
    let sync_path = dir.path().join("sync_root");

    // Create engine with filesystem driver
    let driver = FsDriver::new(&sync_path);
    let mut engine = SyncEngine::new(Box::new(driver));

    // Create some test items (Joplin-compatible format)
    let note = SyncItem::new_note(
        "test-note-1".into(),
        "Test Note".into(),
        "# Hello\nThis is a **test** note.".into(),
        None,
    );
    let folder = SyncItem::new_folder(
        "test-folder-1".into(),
        "Test Folder".into(),
        None,
    );

    // Mark items as changed and sync
    engine.mark_changed(note);
    engine.mark_changed(folder);
    let report = engine.sync_all().await.expect("Sync should succeed");

    assert_eq!(report.uploaded, 2, "Should upload 2 items");
    assert_eq!(report.errors, 0, "Should have no errors");

    // Verify files were created on disk
    assert!(
        sync_path.join("notes/test-note-1.json").exists(),
        "Note JSON should exist"
    );
    assert!(
        sync_path.join("folders/test-folder-1.json").exists(),
        "Folder JSON should exist"
    );

    // Verify content
    let content = std::fs::read_to_string(sync_path.join("notes/test-note-1.json")).unwrap();
    assert!(content.contains("Test Note"), "Should contain title");
    assert!(content.contains("test-note-1"), "Should contain ID");

    // Test delta sync: create new engine and pull
    let driver2 = FsDriver::new(&sync_path);
    let mut engine2 = SyncEngine::new(Box::new(driver2));
    let report2 = engine2.sync_all().await.expect("Delta sync should succeed");

    assert_eq!(report2.downloaded, 2, "Should download 2 items");
    assert_eq!(report2.conflicts, 0, "Should have no conflicts");

    // Verify items are accessible
    assert!(engine2.get_local("test-note-1").is_some(), "Note should be in local store");
    assert!(engine2.get_local("test-folder-1").is_some(), "Folder should be in local store");

    // Test: update an item and sync again
    let updated = SyncItem::new_note(
        "test-note-1".into(),
        "Updated Note".into(),
        "Updated content".into(),
        None,
    );
    engine2.mark_changed(updated);
    let report3 = engine2.sync_all().await.expect("Update sync should succeed");
    assert_eq!(report3.uploaded, 1, "Should upload 1 updated item");

    // Verify updated content on disk
    let content2 = std::fs::read_to_string(sync_path.join("notes/test-note-1.json")).unwrap();
    assert!(content2.contains("Updated Note"), "Should contain updated title");

    println!("✅ Filesystem sync cycle test passed");
    println!("   Uploaded: {}, Downloaded: {}, Conflicts: {}, Errors: {}",
        report.uploaded + report3.uploaded,
        report2.downloaded,
        report.conflicts + report2.conflicts + report3.conflicts,
        report.errors + report2.errors + report3.errors,
    );
}

#[tokio::test]
async fn test_sync_connection_test() {
    let dir = tempfile::tempdir().unwrap();
    let driver = FsDriver::new(dir.path().join("sync_test"));
    let engine = SyncEngine::new(Box::new(driver));
    let result = engine.test_connection().await;
    assert!(result.is_ok(), "Connection test should succeed");
    println!("✅ Connection test passed");
}

#[tokio::test]
async fn test_sync_empty_sync() {
    let dir = tempfile::tempdir().unwrap();
    let driver = FsDriver::new(dir.path().join("empty_sync"));
    let mut engine = SyncEngine::new(Box::new(driver));
    let report = engine.sync_all().await.expect("Empty sync should succeed");
    assert_eq!(report.uploaded, 0, "No items to upload");
    assert_eq!(report.downloaded, 0, "No items to download");
    println!("✅ Empty sync test passed");
}

#[tokio::test]
async fn test_sync_joplin_format() {
    let dir = tempfile::tempdir().unwrap();
    let sync_path = dir.path().join("joplin_format");
    let driver = FsDriver::new(&sync_path);
    let mut engine = SyncEngine::new(Box::new(driver));

    // Create items in Joplin-compatible format
    let items = vec![
        SyncItem::new_note("n1".into(), "Note 1".into(), "Body 1".into(), Some("f1".into())),
        SyncItem::new_note("n2".into(), "Note 2".into(), "Body 2".into(), Some("f1".into())),
        SyncItem::new_folder("f1".into(), "Folder 1".into(), None),
    ];

    for item in items {
        engine.mark_changed(item);
    }
    let report = engine.sync_all().await.expect("Joplin format sync should succeed");
    assert_eq!(report.uploaded, 3);

    // Verify Joplin directory structure
    assert!(sync_path.join("notes").is_dir(), "notes/ dir should exist");
    assert!(sync_path.join("folders").is_dir(), "folders/ dir should exist");
    assert!(sync_path.join("notes/n1.json").exists(), "n1.json should exist");
    assert!(sync_path.join("notes/n2.json").exists(), "n2.json should exist");
    assert!(sync_path.join("folders/f1.json").exists(), "f1.json should exist");

    println!("✅ Joplin format sync test passed");
}
use nf_crypto::JoplinE2ee;

#[tokio::test]
async fn test_e2ee_encrypted_sync_cycle() {
    let dir = tempfile::tempdir().unwrap();
    let sync_path = dir.path().join("e2ee_sync");

    // Setup E2EE layer with master key
    let mut e2ee = nf_sync::encryption::JoplinE2eeLayer::new();
    let key_id = "01234568abcdefgh01234568abcdefgh";
    let password = "e2ee-test-password";
    let (_, master_key_content) = e2ee.generate_and_load_master_key(password, key_id).unwrap();

    // Create engine with E2EE enabled
    let driver = FsDriver::new(&sync_path);
    let mut engine = SyncEngine::new(Box::new(driver));
    engine = engine.with_e2ee(e2ee, Some(key_id.to_string()));

    // Encrypt + upload a note
    let note = SyncItem::new_note(
        "enc-note-1".into(),
        "Encrypted Note".into(),
        "Secret content 加密内容 🔐".into(),
        None,
    );
    engine.mark_changed(note);
    let report = engine.sync_all().await.expect("E2EE sync should succeed");
    assert_eq!(report.uploaded, 1, "Should upload 1 encrypted item");

    // Verify stored file is encrypted (JED01 header, no plaintext)
    let stored = std::fs::read_to_string(sync_path.join("notes/enc-note-1.json")).unwrap();
    assert!(stored.contains("JED01"), "Stored content should be JED01-encrypted");
    assert!(!stored.contains("Secret content"), "Plaintext should NOT be stored");

    // Receive side: load master key from the SAME content, decrypt and verify
    let driver2 = FsDriver::new(&sync_path);
    let mut e2ee2 = nf_sync::encryption::JoplinE2eeLayer::new();
    e2ee2.load_master_key(key_id, password, &master_key_content).unwrap();
    let mut engine2 = SyncEngine::new(Box::new(driver2));
    engine2 = engine2.with_e2ee(e2ee2, Some(key_id.to_string()));

    let report2 = engine2.sync_all().await.expect("E2EE pull should succeed");
    assert_eq!(report2.downloaded, 1, "Should download 1 item");

    // Manually decrypt the stored cipher to verify roundtrip
    let cipher = serde_json::from_str::<serde_json::Value>(&stored).unwrap();
    let body = cipher["body"].as_str().unwrap_or("");
    if body.starts_with("JED01") {
        let mut e2ee_check = nf_crypto::JoplinE2ee::new();
        e2ee_check.load_master_key(key_id, password, &master_key_content).unwrap();
        let plain = e2ee_check.decrypt_item(body).unwrap();
        assert!(plain.contains("Secret content"), "Decrypted content should match original");
        println!("✅ E2EE roundtrip: encrypted -> sync -> decrypted matches original");
    } else {
        panic!("Expected encrypted body with JED01 header");
    }
}
