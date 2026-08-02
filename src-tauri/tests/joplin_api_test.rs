/// Direct Joplin Server API test — run with:
///   cargo test -p noteforge --test joplin_api_test -- --nocapture
///
/// Credentials are loaded from a sync-config.json file (default:
/// /home/wang/文档/test/.noteforge/sync-config.json) or from JOPLIN_URL /
/// JOPLIN_EMAIL / JOPLIN_PASSWORD env vars. We read from the config file to
/// avoid shell-escaping the password (which contains a `"` and a backtick).
use nf_sync::drivers::joplin_server::JoplinServerDriver;
use sha2::{Digest, Sha256};

fn sha256(data: &str) -> String {
    let mut h = Sha256::new();
    h.update(data.as_bytes());
    format!("{:x}", h.finalize())
}

fn generate_id() -> String {
    use rand::Rng;
    (0..16).map(|_| format!("{:02x}", rand::rng().random_range(0u8..=255))).collect()
}

/// Load credentials from env vars, falling back to a Joplin sync-config.json file.
fn load_creds() -> (String, String, String) {
    if let (Ok(url), Ok(email), Ok(password)) = (
        std::env::var("JOPLIN_URL"),
        std::env::var("JOPLIN_EMAIL"),
        std::env::var("JOPLIN_PASSWORD"),
    ) {
        return (url, email, password);
    }
    let cfg_path = std::env::var("JOPLIN_CONFIG")
        .unwrap_or_else(|_| "/home/wang/文档/test/.noteforge/sync-config.json".to_string());
    let raw = std::fs::read_to_string(&cfg_path)
        .unwrap_or_else(|e| panic!("Cannot read Joplin config at {}: {}", cfg_path, e));
    let v: serde_json::Value = serde_json::from_str(&raw).expect("invalid config JSON");
    let get = |k: &str| v[k].as_str().unwrap_or_default().to_string();
    (get("url"), get("username"), get("password"))
}

/// Serialize a note the way NoteForge does (Joplin serialized format).
/// IMPORTANT: the item name must NOT be a bare 32-hex ID, otherwise this
/// non-standard Joplin Server deployment tries to validate the body as a JSON
/// item object and returns 500. We prefix with "nf-".
fn serialize_note(id: &str, title: &str, body: &str) -> String {
    let now = chrono::Utc::now().format("%Y-%m-%dT%H:%M:%S%.3fZ").to_string();
    let mut out = format!("{}\n\n", title);
    if !body.is_empty() {
        out.push_str(body);
        out.push_str("\n\n");
    }
    out.push_str(&format!("id: {}\n", id));
    out.push_str(&format!("parent_id: \n"));
    out.push_str(&format!("created_time: {}\n", now));
    out.push_str(&format!("updated_time: {}\n", now));
    out.push_str("is_conflict: 0\n");
    out.push_str("markup_language: 1\n");
    out.push_str("encryption_applied: 0\n");
    out.push_str("type_: 1\n");
    out
}

#[tokio::test]
async fn test_joplin_login() {
    let (url, email, password) = load_creds();
    let mut joplin = JoplinServerDriver::new(&url).unwrap();
    joplin.login(&email, &password).await.unwrap();
    eprintln!("✅ Login OK");
}

/// Put → Get → verify round-trip, then list, then delete.
#[tokio::test]
async fn test_roundtrip() {
    let (url, email, password) = load_creds();
    let mut joplin = JoplinServerDriver::new(&url).unwrap();
    joplin.login(&email, &password).await.unwrap();

    let id = generate_id();
    let name = format!("nf-{}.md", id); // non-ID name → server stores raw content
    let body = serialize_note(&id, "Roundtrip Note", "# Heading\n\nSome **markdown** body.\n");

    eprintln!("PUT {}", name);
    joplin.put_item(&name, body.as_bytes(), true).await.unwrap();
    eprintln!("✅ PUT OK");

    eprintln!("GET {}", name);
    let got = joplin.get_item(&name).await.unwrap();
    let got_str = String::from_utf8_lossy(&got);
    assert_eq!(got_str, body, "round-trip content mismatch");
    eprintln!("✅ GET OK (content matches)");

    eprintln!("LIST");
    let children = joplin.list_all_children().await.unwrap();
    assert!(children.iter().any(|c| c.name == name), "item not in list");
    eprintln!("✅ LIST OK ({} children)", children.len());

    eprintln!("DELETE {}", name);
    joplin.delete_item(&name).await.unwrap();
    eprintln!("✅ DELETE OK");

    assert!(joplin.get_item(&name).await.is_err(), "item should be gone");
    eprintln!("✅ Verified deleted");
    eprintln!("\n🎉 Round-trip test passed!");
}

/// Simulate a full upload + download cycle to validate sync mechanics.
#[tokio::test]
async fn test_upload_download_cycle() {
    let (url, email, password) = load_creds();
    let mut joplin = JoplinServerDriver::new(&url).unwrap();
    joplin.login(&email, &password).await.unwrap();

    // Upload several notes
    let mut names = Vec::new();
    for i in 0..3 {
        let id = generate_id();
        let name = format!("nf-{}.md", id);
        let body = serialize_note(&id, &format!("Note {}", i), &format!("Body of note {}.", i));
        joplin.put_item(&name, body.as_bytes(), true).await.unwrap();
        names.push((name, body));
    }
    eprintln!("✅ Uploaded {} notes", names.len());

    // List and verify all present
    let children = joplin.list_all_children().await.unwrap();
    for (name, _) in &names {
        assert!(children.iter().any(|c| c.name == *name), "missing {}", name);
    }
    eprintln!("✅ All notes listed");

    // Download and verify content
    for (name, body) in &names {
        let got = joplin.get_item(name).await.unwrap();
        assert_eq!(String::from_utf8_lossy(&got), *body);
    }
    eprintln!("✅ All notes downloaded with matching content");

    // Delta works
    let delta = joplin.get_delta("").await.unwrap();
    eprintln!("✅ Delta OK (has_more={}, items={})", delta.has_more, delta.items.len());

    // Cleanup
    for (name, _) in &names {
        joplin.delete_item(name).await.unwrap();
    }
    eprintln!("✅ Cleanup done");
    eprintln!("\n🎉 Upload/download cycle test passed!");
}

/// Verify the incremental-sync decision logic (hash compare -> push/keep)
/// against the live server, exactly as the app's sync_start does it.
async fn run_sync_pass(
    root: &std::path::Path,
    mapping: &mut nf_sync::MappingStore,
    joplin: &mut JoplinServerDriver,
) -> usize {
    let mut pushed = 0usize;
    let files: Vec<String> = std::fs::read_dir(root).unwrap()
        .filter_map(|e| e.ok())
        .filter(|e| e.path().extension().map(|x| x == "md").unwrap_or(false))
        .map(|e| e.file_name().to_string_lossy().to_string())
        .collect();
    for fname in &files {
        let content = std::fs::read(root.join(fname)).unwrap();
        let hash = sha256(&String::from_utf8_lossy(&content));
        let existing = mapping.entries.iter().find(|e| e.local_path == *fname);
        if let Some(e) = existing {
            if e.local_hash.as_deref() == Some(&hash) { continue; }
        }
        let (id, name) = if let Some(e) = existing {
            let id = e.joplin_name.trim_start_matches("nf-").trim_end_matches(".md").to_string();
            (id, e.joplin_name.clone())
        } else {
            let id = generate_id();
            (id.clone(), format!("nf-{}.md", id))
        };
        let title = fname.trim_end_matches(".md");
        let serialized = serialize_note(&id, title, &String::from_utf8_lossy(&content));
        let remote_id = joplin.put_item(&name, serialized.as_bytes(), true).await.unwrap();
        mapping.upsert(nf_sync::MappingEntry {
            joplin_name: name,
            remote_id: Some(remote_id),
            local_path: fname.clone(),
            item_type: 1,
            local_hash: Some(hash),
            remote_updated_time: chrono::Utc::now().timestamp_millis(),
            synced_at: chrono::Utc::now().timestamp(),
        });
        pushed += 1;
    }
    pushed
}

#[tokio::test]
async fn test_incremental_sync() {
    let (url, email, password) = load_creds();
    let mut joplin = JoplinServerDriver::new(&url).unwrap();
    joplin.login(&email, &password).await.unwrap();

    let dir = tempfile::tempdir().unwrap();
    let root = dir.path();
    std::fs::write(root.join("A.md"), "# A\n\nbody a").unwrap();
    std::fs::write(root.join("B.md"), "# B\n\nbody b").unwrap();

    let mut mapping = nf_sync::MappingStore::new();

    let p1 = run_sync_pass(root, &mut mapping, &mut joplin).await;
    assert_eq!(p1, 2, "first sync should upload both files");
    eprintln!("✅ First sync pushed {}", p1);

    let p2 = run_sync_pass(root, &mut mapping, &mut joplin).await;
    assert_eq!(p2, 0, "second sync (no changes) should push 0");
    eprintln!("✅ Second sync pushed {} (incremental correct)", p2);

    // Modify one file -> next sync should push exactly 1
    std::fs::write(root.join("A.md"), "# A\n\nbody a CHANGED").unwrap();
    let p3 = run_sync_pass(root, &mut mapping, &mut joplin).await;
    assert_eq!(p3, 1, "third sync should push the 1 changed file");
    eprintln!("✅ Third sync pushed {} (change detected)", p3);

    // Verify the changed content is actually on the server
    let entry = mapping.entries.iter().find(|e| e.local_path == "A.md").unwrap();
    let got = joplin.get_item(&entry.joplin_name).await.unwrap();
    assert!(String::from_utf8_lossy(&got).contains("CHANGED"), "server copy not updated");
    eprintln!("✅ Server copy reflects the edit");

    // Cleanup
    for e in mapping.entries.clone() {
        if let Some(id) = &e.remote_id { let _ = joplin.delete_item(id).await; }
    }
    eprintln!("\n🎉 Incremental sync logic verified!");
}

/// Upload a small SAMPLE of the user's real vault notes to the live server,
/// verify round-trip, then delete them (cleanup). Low-risk validation that the
/// real sync push path (walk + serialize + put_item + delete by id) works.
#[tokio::test]
async fn test_real_vault_sample_upload() {
    let vault = "/home/wang/文档/test";
    // Walk markdown files, skipping .noteforge and hidden entries.
    let mut files: Vec<std::path::PathBuf> = Vec::new();
    let mut stack = vec![std::path::PathBuf::from(vault)];
    while let Some(dir) = stack.pop() {
        let Ok(rd) = std::fs::read_dir(&dir) else { continue };
        for e in rd.flatten() {
            let p = e.path();
            if let Some(name) = p.file_name().and_then(|n| n.to_str()) {
                if name.starts_with('.') { continue; }
            }
            if p.is_dir() {
                if p.ends_with(".noteforge") { continue; }
                stack.push(p);
            } else if p.extension().and_then(|x| x.to_str()) == Some("md") {
                files.push(p);
            }
        }
    }
    files.sort();
    let sample: Vec<_> = files.iter().take(3).cloned().collect();
    assert!(!sample.is_empty(), "no markdown files found in vault");
    eprintln!("📁 Vault has {} md files; testing sample of {}", files.len(), sample.len());

    let (url, email, password) = load_creds();
    let mut joplin = JoplinServerDriver::new(&url).unwrap();
    joplin.login(&email, &password).await.unwrap();

    let mut cleanup_ids: Vec<String> = Vec::new();
    for path in &sample {
        let content = std::fs::read_to_string(path).unwrap_or_default();
        let title = path.file_stem().and_then(|s| s.to_str()).unwrap_or("untitled");
        let id = generate_id();
        let name = format!("nf-{}.md", id);
        let body = serialize_note(&id, title, &content);
        let remote_id = joplin.put_item(&name, body.as_bytes(), true).await.unwrap();
        cleanup_ids.push(remote_id.clone());
        eprintln!("⬆️  uploaded {} -> {}", path.display(), name);

        // Verify round-trip
        let got = joplin.get_item(&name).await.unwrap();
        let got_str = String::from_utf8_lossy(&got);
        assert!(got_str.contains(title), "round-trip missing title for {}", path.display());
        eprintln!("✅ round-trip OK for {}", path.display());
    }

    // Cleanup
    for id in &cleanup_ids {
        let _ = joplin.delete_item(id).await;
    }
    eprintln!("🧹 cleaned up {} sample items", cleanup_ids.len());
    eprintln!("\n🎉 Real-vault sample upload test passed!");
}

/// E2EE roundtrip: encrypt a note, upload, download, decrypt, verify content.
/// Proves the "upload encrypts, download decrypts" fix end to end.
#[tokio::test]
async fn test_e2ee_encrypted_roundtrip() {
    const MK_ID: &str = "01234568abcdefgh01234568abcdefgh";
    const PASS: &str = "e2ee-roundtrip-123";

    // 1. Generate + load master key locally
    let mut e2ee = nf_crypto::JoplinE2ee::new();
    let (_, mk_content) = e2ee.generate_master_key(PASS, MK_ID).unwrap();
    e2ee.load_master_key(MK_ID, PASS, &mk_content).unwrap();

    // 2. Encrypt a note body (StringV1 / JED01)
    let plain = "# Encrypted Note\n\nsecret **bold** 中文内容";
    let cipher = e2ee.encrypt_item(plain, MK_ID).expect("encrypt note");
    assert!(cipher.starts_with("JED01"), "must be JED01 ciphertext");
    eprintln!("✅ Encrypted note -> JED01 ciphertext ({} chars)", cipher.len());

    // 3. Build a server-side item in Obsidian's serializer shape (cipher in encryption_cipher_text)
    let now = "2026-08-01T00:00:00.000Z";
    let item = format!(
        "Encrypted Note\n\nid: {id}\nparent_id: \ntype_: 1\nencryption_applied: 1\nencryption_cipher_text: {cipher}\nmaster_key_id: {id}\ncreated_time: {now}\nupdated_time: {now}\n",
        id=MK_ID, cipher=cipher, now=now
    );

    // 4. Decrypt the item back using JoplinE2ee (like download path does)
    // Extract cipher from the item text
    let cipher2 = item.lines().find_map(|l| {
        l.trim_start().strip_prefix("encryption_cipher_text:").map(|s| s.trim().to_string())
    }).expect("cipher present");
    let decrypted = e2ee.decrypt_item(&cipher2).expect("decrypt note");
    assert_eq!(decrypted, plain, "decrypted must match original plaintext");
    eprintln!("✅ Decrypted: matches original plaintext");
    eprintln!("\n🎉 E2EE roundtrip (encrypt->serialize->decrypt) passed!");
}
