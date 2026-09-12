//! End-to-end mirror engine tests using the local-filesystem driver as
//! the "remote" (a second temp directory). Covers the four quadrants,
//! first-sync policies, encryption, and trash safety.

use nf_sync::crypto_layer::SyncCrypto;
use nf_sync::drivers::filesystem::FsDriver;
use nf_sync::mirror::diff::{Direction, FirstSyncPolicy};
use nf_sync::mirror::ignore::IgnoreRules;
use nf_sync::mirror::state::SyncState;
use nf_sync::mirror::MirrorEngine;
use std::path::Path;

fn no_progress() -> impl Fn(&str, usize, usize, &str) {
    |_phase, _d, _t, _p| {}
}

/// Build an engine over an existing driver (caller keeps the driver alive).
fn engine<'a>(
    driver: &'a FsDriver,
    crypto: SyncCrypto,
    direction: Direction,
    policy: FirstSyncPolicy,
) -> MirrorEngine<'a> {
    MirrorEngine::new(driver, crypto, IgnoreRules::new(&[]), direction, policy)
}

fn disabled() -> SyncCrypto {
    SyncCrypto::disabled()
}

fn write(root: &Path, rel: &str, content: &str) {
    let p = root.join(rel);
    if let Some(parent) = p.parent() {
        std::fs::create_dir_all(parent).unwrap();
    }
    std::fs::write(p, content).unwrap();
}

fn read(root: &Path, rel: &str) -> String {
    std::fs::read_to_string(root.join(rel)).unwrap()
}

/// Make sure a file's mtime actually advances between writes so the
/// incremental (mtime+size fast path) detects the change.
fn touch_later(root: &Path, rel: &str, content: &str) {
    std::thread::sleep(std::time::Duration::from_millis(20));
    write(root, rel, content);
    let p = root.join(rel);
    let new_time = std::time::SystemTime::now() + std::time::Duration::from_millis(50);
    let f = std::fs::File::options().write(true).open(&p).unwrap();
    f.set_modified(new_time).unwrap();
}

#[tokio::test]
async fn first_sync_upload_then_incremental() {
    let local = tempfile::tempdir().unwrap();
    let remote = tempfile::tempdir().unwrap();
    write(local.path(), "a.md", "# A");
    write(local.path(), "sub/b.md", "B body");

    {
        let drv = FsDriver::new(remote.path());
        let mut e = engine(&drv, disabled(), Direction::Bidirectional, FirstSyncPolicy::UploadAll);
        let rep = e.sync(local.path(), &no_progress()).await.unwrap();
        assert_eq!(rep.uploaded, 2, "both files uploaded on first sync");
        assert!(rep.first_sync);
    }
    assert_eq!(read(remote.path(), "a.md"), "# A");
    assert_eq!(read(remote.path(), "sub/b.md"), "B body");

    let drv = FsDriver::new(remote.path());
    let mut e = engine(&drv, disabled(), Direction::Bidirectional, FirstSyncPolicy::UploadAll);
    // No-change round: everything skipped
    let rep = e.sync(local.path(), &no_progress()).await.unwrap();
    assert_eq!(rep.uploaded + rep.downloaded + rep.conflicts, 0, "no-op round");

    // Local edit → upload exactly 1
    touch_later(local.path(), "a.md", "# A edited");
    let rep = e.sync(local.path(), &no_progress()).await.unwrap();
    assert_eq!(rep.uploaded, 1);
    assert_eq!(read(remote.path(), "a.md"), "# A edited");

    // Local delete → remote delete
    std::fs::remove_file(local.path().join("sub/b.md")).unwrap();
    let rep = e.sync(local.path(), &no_progress()).await.unwrap();
    assert_eq!(rep.deleted_remote, 1);
    assert!(!remote.path().join("sub/b.md").exists());
}

#[tokio::test]
async fn remote_change_downloads_and_delete_moves_to_trash() {
    let local = tempfile::tempdir().unwrap();
    let remote = tempfile::tempdir().unwrap();
    write(local.path(), "a.md", "v1");
    write(local.path(), "b.md", "keep");

    let drv = FsDriver::new(remote.path());
    let mut e = engine(&drv, disabled(), Direction::Bidirectional, FirstSyncPolicy::UploadAll);
    e.sync(local.path(), &no_progress()).await.unwrap();

    // Remote-side change and delete
    touch_later(remote.path(), "a.md", "remote v2");
    std::fs::remove_file(remote.path().join("b.md")).unwrap();

    let rep = e.sync(local.path(), &no_progress()).await.unwrap();
    assert_eq!(rep.downloaded, 1, "remote change pulled");
    assert_eq!(rep.deleted_local, 1, "remote delete mirrored to local trash");
    assert_eq!(read(local.path(), "a.md"), "remote v2");
    assert!(!local.path().join("b.md").exists());
    // Trash must contain b.md
    let trash = local.path().join(".noteforge/trash");
    assert!(trash.exists());
    let trashed: Vec<_> = std::fs::read_dir(&trash).unwrap().collect();
    assert_eq!(trashed.len(), 1);
    assert!(trashed[0].as_ref().unwrap().path().to_string_lossy().contains("b.md"));
}

#[tokio::test]
async fn conflict_keeps_both_versions() {
    let local = tempfile::tempdir().unwrap();
    let remote = tempfile::tempdir().unwrap();
    write(local.path(), "doc.md", "base");

    let drv = FsDriver::new(remote.path());
    let mut e = engine(&drv, disabled(), Direction::Bidirectional, FirstSyncPolicy::UploadAll);
    e.sync(local.path(), &no_progress()).await.unwrap();

    // Both sides change the same file
    touch_later(local.path(), "doc.md", "local edit");
    touch_later(remote.path(), "doc.md", "remote edit");

    let rep = e.sync(local.path(), &no_progress()).await.unwrap();
    assert_eq!(rep.conflicts, 1);
    // Canonical file = remote version
    assert_eq!(read(local.path(), "doc.md"), "remote edit");
    // Conflict copy contains the local version
    let conflict: Vec<_> = std::fs::read_dir(local.path()).unwrap()
        .filter_map(|en| en.ok())
        .map(|en| en.file_name().to_string_lossy().to_string())
        .filter(|n| n.starts_with("doc (冲突 "))
        .collect();
    assert_eq!(conflict.len(), 1, "one conflict copy expected: {:?}", conflict);
    assert_eq!(read(local.path(), &conflict[0]), "local edit");
}

#[tokio::test]
async fn encrypted_mirror_roundtrip() {
    let local = tempfile::tempdir().unwrap();
    let remote = tempfile::tempdir().unwrap();
    write(local.path(), "secret.md", "# 机密内容");

    let salt = nf_crypto::generate_salt_b64();
    {
        let crypto = SyncCrypto::with_password("pw-中文-123", &salt).unwrap();
        let drv = FsDriver::new(remote.path());
        let mut e = engine(&drv, crypto, Direction::Bidirectional, FirstSyncPolicy::UploadAll);
        let rep = e.sync(local.path(), &no_progress()).await.unwrap();
        assert!(rep.encrypted);
        assert_eq!(rep.uploaded, 1);
    }
    // Server stores ciphertext, not plaintext
    let stored = std::fs::read(remote.path().join("secret.md")).unwrap();
    assert!(nf_crypto::is_encrypted_binary(&stored));
    assert!(!String::from_utf8_lossy(&stored).contains("机密"));

    // Second device: same password + salt → decrypts fine
    let fresh_local = tempfile::tempdir().unwrap();
    let crypto = SyncCrypto::with_password("pw-中文-123", &salt).unwrap();
    let drv = FsDriver::new(remote.path());
    let mut e = engine(&drv, crypto, Direction::Bidirectional, FirstSyncPolicy::DownloadAll);
    let rep = e.sync(fresh_local.path(), &no_progress()).await.unwrap();
    assert_eq!(rep.downloaded, 1);
    assert_eq!(read(fresh_local.path(), "secret.md"), "# 机密内容");

    // Wrong password → clear failure, no local file overwritten
    let fresh2 = tempfile::tempdir().unwrap();
    write(fresh2.path(), "secret.md", "DO NOT TOUCH");
    let crypto = SyncCrypto::with_password("wrong", &salt).unwrap();
    let drv = FsDriver::new(remote.path());
    let mut e = engine(&drv, crypto, Direction::Bidirectional, FirstSyncPolicy::DownloadAll);
    let rep = e.sync(fresh2.path(), &no_progress()).await.unwrap();
    assert!(rep.errors >= 1);
    assert_eq!(read(fresh2.path(), "secret.md"), "DO NOT TOUCH");
}

#[tokio::test]
async fn first_sync_bidirectional_compares_equal_content() {
    let local = tempfile::tempdir().unwrap();
    let remote = tempfile::tempdir().unwrap();
    write(local.path(), "same.md", "identical");
    write(remote.path(), "same.md", "identical");
    write(remote.path(), "only-remote.md", "r");

    let drv = FsDriver::new(remote.path());
    let mut e = engine(&drv, disabled(), Direction::Bidirectional, FirstSyncPolicy::Bidirectional);
    let rep = e.sync(local.path(), &no_progress()).await.unwrap();
    assert_eq!(rep.downloaded, 1, "only-remote downloaded");
    assert_eq!(rep.conflicts, 0, "equal content is not a conflict");
    assert_eq!(rep.uploaded, 0, "identical file not re-uploaded");
    assert_eq!(read(local.path(), "only-remote.md"), "r");
}

#[tokio::test]
async fn ignore_rules_excluded_from_sync() {
    let local = tempfile::tempdir().unwrap();
    let remote = tempfile::tempdir().unwrap();
    write(local.path(), "keep.md", "k");
    write(local.path(), ".obsidian/app.json", "{}");
    write(local.path(), "note.tmp", "junk");

    let drv = FsDriver::new(remote.path());
    let mut e = engine(&drv, disabled(), Direction::Bidirectional, FirstSyncPolicy::UploadAll);
    let rep = e.sync(local.path(), &no_progress()).await.unwrap();
    assert_eq!(rep.uploaded, 1);
    assert!(remote.path().join("keep.md").exists());
    assert!(!remote.path().join(".obsidian").exists());
    assert!(!remote.path().join("note.tmp").exists());
}

#[tokio::test]
async fn download_only_direction_does_not_upload() {
    let local = tempfile::tempdir().unwrap();
    let remote = tempfile::tempdir().unwrap();
    write(remote.path(), "r.md", "from remote");

    let drv = FsDriver::new(remote.path());
    let mut e = engine(&drv, disabled(), Direction::DownloadOnly, FirstSyncPolicy::Bidirectional);
    let rep = e.sync(local.path(), &no_progress()).await.unwrap();
    assert_eq!(rep.downloaded, 1);

    // Local-only new file is NOT uploaded in download-only mode
    write(local.path(), "local-only.md", "mine");
    let rep = e.sync(local.path(), &no_progress()).await.unwrap();
    assert_eq!(rep.uploaded, 0);
    assert!(!remote.path().join("local-only.md").exists());
}

#[tokio::test]
async fn meta_publish_and_fetch() {
    let remote = tempfile::tempdir().unwrap();
    let salt = nf_crypto::generate_salt_b64();
    let crypto = SyncCrypto::with_password("pw", &salt).unwrap();
    let drv = FsDriver::new(remote.path());
    let e = engine(&drv, crypto, Direction::Bidirectional, FirstSyncPolicy::UploadAll);
    e.publish_meta(&salt).await.unwrap();
    let meta = e.fetch_meta().await.unwrap().expect("meta present");
    assert!(meta.encrypted);
    assert_eq!(meta.salt_b64, salt);
}

#[tokio::test]
async fn state_persists_across_rounds() {
    let local = tempfile::tempdir().unwrap();
    let remote = tempfile::tempdir().unwrap();
    write(local.path(), "a.md", "v1");
    let drv = FsDriver::new(remote.path());
    let mut e = engine(&drv, disabled(), Direction::Bidirectional, FirstSyncPolicy::UploadAll);
    e.sync(local.path(), &no_progress()).await.unwrap();
    let st = SyncState::load(local.path()).unwrap();
    assert_eq!(st.files.len(), 1);
    assert!(st.files.contains_key("a.md"));
    assert!(st.files["a.md"].remote_etag.is_some(), "fs driver must supply synthetic etags");
}
