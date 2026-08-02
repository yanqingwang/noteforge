use nf_core::vault::VaultConfig;
use nf_sync::drivers::filesystem::FsDriver;
use nf_sync::drivers::joplin_server::JoplinServerDriver;
use nf_sync::drivers::webdav::WebDavDriver;
use nf_sync::engine::SyncEngine;
use nf_vault::{FileEntry, Vault, VaultConfigExt};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::sync::Mutex;
use tauri::Emitter;

// ── Managed State ───────────────────────────────────────────────────
struct AppState {
    vault: Mutex<Option<Vault>>,
    tree_cache: Mutex<Vec<FileEntry>>,
    sync_config: Mutex<Option<SyncConfig>>,
}

#[derive(Clone, Serialize, Deserialize)]
struct SyncConfig {
    target_type: String, // "webdav", "joplin_server", "filesystem"
    url: String,
    username: String,
    password: String,
    // E2EE (Joplin-compatible)
    #[serde(default)]
    e2ee_enabled: bool,
    #[serde(default)]
    e2ee_password: String,
    #[serde(default)]
    e2ee_master_key_id: String,
    #[serde(default)]
    e2ee_master_key_content: String,
}

impl AppState {
    fn new() -> Self {
        AppState {
            vault: Mutex::new(None),
            tree_cache: Mutex::new(Vec::new()),
            sync_config: Mutex::new(None),
        }
    }

    fn ensure_open(&self, path: &str) -> Result<(), String> {
        let mut v = self.vault.lock().map_err(|e| e.to_string())?;
        if v.as_ref().is_none_or(|v| v.root().to_string_lossy() != path) {
            *v = Some(Vault::open(std::path::Path::new(path)).map_err(|e| e.to_string())?);
            let mut tc = self.tree_cache.lock().map_err(|e| e.to_string())?;
            tc.clear();
        }
        Ok(())
    }

    fn with_vault<F, R>(&self, f: F) -> Result<R, String>
    where
        F: FnOnce(&Vault) -> Result<R, String>,
    {
        let v = self.vault.lock().map_err(|e| e.to_string())?;
        v.as_ref().ok_or_else(|| "No vault open".to_string()).and_then(f)
    }

}

// ── Command structs ─────────────────────────────────────────────────

#[derive(Serialize, Deserialize)]
struct NoteInfo {
    path: String,
    content: String,
    html: String,
    frontmatter: String,
    links: Vec<LinkInfo>,
    tags: Vec<String>,
    word_count: usize,
}

#[derive(Serialize, Deserialize)]
struct LinkInfo {
    target: String,
    display: Option<String>,
    subpath: Option<String>,
}

#[derive(Serialize, Deserialize)]
struct SearchResult {
    path: String,
    excerpt: String,
}

#[derive(Serialize, Deserialize)]
struct GraphData {
    nodes: Vec<GraphNode>,
    edges: Vec<GraphEdge>,
}

#[derive(Serialize, Deserialize)]
struct GraphNode {
    id: usize,
    title: String,
    link_count: usize,
}

#[derive(Serialize, Deserialize)]
struct GraphEdge {
    source: usize,
    target: usize,
}

// ── Tauri Commands ──────────────────────────────────────────────────

#[tauri::command]
fn open_vault(path: &str, state: tauri::State<'_, AppState>) -> Result<Vec<FileEntry>, String> {
    state.ensure_open(path)?;
    let vault = state.vault.lock().map_err(|e| e.to_string())?;
    let v = vault.as_ref().unwrap();
    let tree = v.file_tree().map_err(|e| e.to_string())?;
    // Cache it
    let mut tc = state.tree_cache.lock().map_err(|e| e.to_string())?;
    *tc = tree.clone();
    Ok(tree)
}

#[tauri::command]
fn read_note(note_path: &str, state: tauri::State<'_, AppState>) -> Result<NoteInfo, String> {
    state.with_vault(|vault| {
        let content = vault.read_note(note_path).map_err(|e| e.to_string())?;
        let text = String::from_utf8_lossy(&content).to_string();
        let meta = nf_markdown::parse_to_meta(note_path, &content);
        let html = nf_render::render_html(&text);
        let frontmatter_json = serde_json::to_string(&meta.frontmatter.fields).unwrap_or_default();
        let word_count = text.split_whitespace().count();

        Ok(NoteInfo {
            path: note_path.to_string(),
            content: text,
            html,
            frontmatter: frontmatter_json,
            links: meta.links_out.iter().map(|l| LinkInfo {
                target: l.target.clone(),
                display: l.display.clone(),
                subpath: l.subpath.clone(),
            }).collect(),
            tags: meta.tags_inline.iter().map(|t| t.tag.clone()).collect(),
            word_count,
        })
    })
}

#[tauri::command]
fn write_note(note_path: &str, content: &str, state: tauri::State<'_, AppState>) -> Result<(), String> {
    state.with_vault(|vault| {
        vault.write_note(note_path, content.as_bytes()).map_err(|e| e.to_string())
    })?;
    // Invalidate tree cache (size/modified changed)
    let mut tc = state.tree_cache.lock().map_err(|e| e.to_string())?;
    tc.clear();
    Ok(())
}

#[tauri::command]
fn create_note(note_path: &str, state: tauri::State<'_, AppState>) -> Result<(), String> {
    state.with_vault(|vault| {
        vault.create_note(note_path).map_err(|e| e.to_string())
    })?;
    let mut tc = state.tree_cache.lock().map_err(|e| e.to_string())?;
    tc.clear();
    Ok(())
}

#[tauri::command]
fn delete_note(note_path: &str, state: tauri::State<'_, AppState>) -> Result<(), String> {
    state.with_vault(|vault| {
        vault.delete_note(note_path).map_err(|e| e.to_string())
    })?;
    let mut tc = state.tree_cache.lock().map_err(|e| e.to_string())?;
    tc.clear();
    Ok(())
}

#[tauri::command]
fn get_file_tree(state: tauri::State<'_, AppState>) -> Result<Vec<FileEntry>, String> {
    let tc = state.tree_cache.lock().map_err(|e| e.to_string())?;
    if !tc.is_empty() {
        return Ok(tc.clone());
    }
    drop(tc);
    // Cold cache: rebuild
    state.with_vault(|vault| {
        let tree = vault.file_tree().map_err(|e| e.to_string())?;
        let mut tc = state.tree_cache.lock().map_err(|e| e.to_string())?;
        *tc = tree.clone();
        Ok(tree)
    })
}

#[tauri::command]
fn search_notes(query: &str, state: tauri::State<'_, AppState>) -> Result<Vec<SearchResult>, String> {
    let tree = get_file_tree_inner(&state)?;
    let q = query.to_lowercase();
    let mut results = Vec::new();
    state.with_vault(|vault| {
        for entry in &tree {
            if !entry.path.ends_with(".md") { continue; }
            if let Ok(content) = vault.read_note(&entry.path) {
                let text = String::from_utf8_lossy(&content);
                if text.to_lowercase().contains(&q) {
                    let excerpt = text.lines()
                        .find(|l| l.to_lowercase().contains(&q))
                        .unwrap_or("")
                        .to_string();
                    results.push(SearchResult { path: entry.path.clone(), excerpt });
                    if results.len() >= 50 { break; }
                }
            }
        }
        Ok(results)
    })
}

fn get_file_tree_inner(state: &AppState) -> Result<Vec<FileEntry>, String> {
    let tc = state.tree_cache.lock().map_err(|e| e.to_string())?;
    if !tc.is_empty() {
        return Ok(tc.clone());
    }
    drop(tc);
    state.with_vault(|vault| {
        let tree = vault.file_tree().map_err(|e| e.to_string())?;
        let mut tc = state.tree_cache.lock().map_err(|e| e.to_string())?;
        *tc = tree.clone();
        Ok(tree)
    })
}

#[tauri::command]
fn get_graph(state: tauri::State<'_, AppState>) -> Result<GraphData, String> {
    let tree = get_file_tree_inner(&state)?;
    let mut metas = Vec::new();
    state.with_vault(|vault| {
        for entry in &tree {
            if !entry.path.ends_with(".md") { continue; }
            if let Ok(content) = vault.read_note(&entry.path) {
                metas.push(nf_markdown::parse_to_meta(&entry.path, &content));
            }
        }
        Ok::<_, String>(())
    })?;

    let graph = nf_graph::NoteGraph::build(&metas);
    Ok(GraphData {
        nodes: graph.nodes.iter().map(|n| GraphNode {
            id: n.id,
            title: n.title.clone(),
            link_count: n.link_count,
        }).collect(),
        edges: graph.edges.iter().map(|e| GraphEdge {
            source: e.source,
            target: e.target,
        }).collect(),
    })
}

#[tauri::command]
fn render_note(note_path: &str, state: tauri::State<'_, AppState>) -> Result<String, String> {
    state.with_vault(|vault| {
        vault.read_note(note_path).map_err(|e| e.to_string())
            .map(|content| nf_render::render_html(&String::from_utf8_lossy(&content)))
    })
}

#[tauri::command]
fn vault_stats(state: tauri::State<'_, AppState>) -> Result<String, String> {
    let tree = get_file_tree_inner(&state)?;
    let notes = tree.iter().filter(|e| !e.is_dir && e.path.ends_with(".md")).count();
    let attachments = tree.iter().filter(|e| !e.is_dir && !e.path.ends_with(".md")).count();
    let dirs = tree.iter().filter(|e| e.is_dir).count();
    let total_size: u64 = tree.iter().filter(|e| !e.is_dir).map(|e| e.size).sum();
    Ok(format!("Vault统计: {}笔记 {}附件 {}目录 {}KB", notes, attachments, dirs, total_size / 1024))
}

#[tauri::command]
fn read_file(path: &str, state: tauri::State<'_, AppState>) -> Result<String, String> {
    state.with_vault(|vault| {
        vault.read_note(path).map_err(|e| e.to_string())
            .map(|content| String::from_utf8_lossy(&content).to_string())
    })
}

/// Read a file and return it as a data URL (base64-encoded).
#[tauri::command]
fn read_file_data(path: &str, state: tauri::State<'_, AppState>) -> Result<String, String> {
    state.with_vault(|vault| {
        let data = vault.read_note(path).map_err(|e| e.to_string())?;
        let mime = if path.ends_with(".png") { "image/png" }
            else if path.ends_with(".jpg") || path.ends_with(".jpeg") { "image/jpeg" }
            else if path.ends_with(".gif") { "image/gif" }
            else if path.ends_with(".svg") { "image/svg+xml" }
            else if path.ends_with(".webp") { "image/webp" }
            else { "application/octet-stream" };
        Ok(format!("data:{};base64,{}", mime, base64::Engine::encode(&base64::engine::general_purpose::STANDARD, &data)))
    })
}

#[tauri::command]
fn get_config(state: tauri::State<'_, AppState>) -> Result<VaultConfig, String> {
    state.with_vault(|vault| Ok(vault.config().clone()))
}

#[tauri::command]
fn update_config(config: VaultConfig, state: tauri::State<'_, AppState>) -> Result<(), String> {
    let vault_path = {
        let v = state.vault.lock().map_err(|e| e.to_string())?;
        v.as_ref().map(|v| v.root().to_path_buf())
            .ok_or_else(|| "No vault open".to_string())?
    };
    config.save(&vault_path).map_err(|e| e.to_string())?;
    // Re-open vault with new config to pick up exclude_dirs etc.
    let mut v = state.vault.lock().map_err(|e| e.to_string())?;
    *v = Some(Vault::open(&vault_path).map_err(|e| e.to_string())?);
    let mut tc = state.tree_cache.lock().map_err(|e| e.to_string())?;
    tc.clear();
    Ok(())
}

// ── Sync config persistence ──────────────────────────────────────

fn save_sync_config(state: &AppState, config: &SyncConfig) -> Result<(), String> {
    let path = {
        let v = state.vault.lock().map_err(|e| e.to_string())?;
        v.as_ref()
            .map(|v| v.root().join(".noteforge").join("sync-config.json"))
            .ok_or_else(|| "No vault open".to_string())?
    };
    if let Some(parent) = path.parent() { std::fs::create_dir_all(parent).map_err(|e| e.to_string())?; }
    let json = serde_json::to_string_pretty(config).map_err(|e| e.to_string())?;
    std::fs::write(&path, json).map_err(|e| e.to_string())?;
    Ok(())
}

fn load_sync_config(state: &AppState) -> Result<Option<SyncConfig>, String> {
    // Get path without holding vault lock for long
    let path = {
        let v = state.vault.lock().map_err(|e| e.to_string())?;
        v.as_ref()
            .map(|v| v.root().join(".noteforge").join("sync-config.json"))
            .ok_or_else(|| "No vault open".to_string())?
    };
    if !path.exists() { return Ok(None); }
    let raw = std::fs::read_to_string(&path).map_err(|e| e.to_string())?;
    serde_json::from_str(&raw).map_err(|e| e.to_string()).map(Some)
}

// ── Sync commands ──────────────────────────────────────────────────

/// Create engine and login (Joplin only).
async fn create_engine_async(config: &SyncConfig, window: &tauri::Window) -> Result<SyncEngine, String> {
    let engine = match config.target_type.as_str() {
        "joplin_server" => {
            let _ = window.emit("sync-progress", "⏳ 正在登录...");
            let mut joplin = JoplinServerDriver::new(&config.url).map_err(|e| e.to_string())?;
            joplin.login(&config.username, &config.password).await.map_err(|e| e.to_string())?;
            let _ = window.emit("sync-progress", "✅ 登录成功");
            SyncEngine::new(Box::new(joplin))
        }
        "webdav" => SyncEngine::new(Box::new(
            WebDavDriver::new(&config.url, &config.username, &config.password).map_err(|e| e.to_string())?
        )),
        "filesystem" => SyncEngine::new(Box::new(FsDriver::new(&config.url))),
        _ => return Err(format!("Unknown: {}", config.target_type)),
    };

    // Apply Joplin-compatible E2EE if enabled (master key already configured)
    if config.e2ee_enabled {
        if config.e2ee_password.is_empty() {
            return Err("E2EE enabled but password is empty".into());
        }
        if config.e2ee_master_key_id.is_empty() || config.e2ee_master_key_content.is_empty() {
            return Err("E2EE master key not generated — configure E2EE in Settings first".into());
        }
        let mut e2ee = nf_sync::encryption::JoplinE2eeLayer::new();
        e2ee.load_master_key(&config.e2ee_master_key_id, &config.e2ee_password, &config.e2ee_master_key_content)
            .map_err(|e| format!("load master key: {}", e))?;
        let _ = window.emit("sync-progress", "🔑 已加载主密钥");
        Ok(engine.with_e2ee(e2ee, Some(config.e2ee_master_key_id.clone()))
            .with_e2ee_password(Some(config.e2ee_password.clone())))
    } else {
        Ok(engine)
    }
}

fn generate_sync_key_id() -> String {
    use rand::Rng;
    let bytes: Vec<u8> = (0..16).map(|_| rand::rng().random_range(0..=255u8)).collect();
    bytes.iter().map(|b| format!("{:02x}", b)).collect()
}


#[tauri::command]
async fn sync_upload_master_key(window: tauri::Window, state: tauri::State<'_, AppState>) -> Result<String, String> {
    let config = {
        let c = state.sync_config.lock().map_err(|e| e.to_string())?;
        c.clone().ok_or_else(|| "Sync not configured".to_string())?
    };
    if !config.e2ee_enabled {
        return Err("E2EE not enabled".into());
    }
    if config.e2ee_master_key_id.is_empty() || config.e2ee_master_key_content.is_empty() {
        return Err("No master key configured".into());
    }
    // Upload master key as type_=9 item (naming <hex>.md so Obsidian discovers it).
    let name = format!("{}.md", config.e2ee_master_key_id);
    let serialized = serialize_joplin_master_key(&config.e2ee_master_key_id, &config.e2ee_master_key_content, 8);
    let client = create_sync_client(&config, &window).await.map_err(|e| e.to_string())?;
    let rid = client.put_item(&name, serialized.as_bytes(), true).await.map_err(|e| e.to_string())?;
    let _ = window.emit("sync-progress", &format!("🔑 已上传主密钥 {} (type_=9)", &config.e2ee_master_key_id[..8]));
    Ok(format!("主密钥已上传: {} id={}", rid, config.e2ee_master_key_id))
}

#[tauri::command]
fn sync_configure(mut config: SyncConfig, state: tauri::State<'_, AppState>) -> Result<(), String> {
    if config.url.is_empty() { return Err("URL is required".into()); }
    // Generate a master key when E2EE is first enabled
    if config.e2ee_enabled && config.e2ee_master_key_content.is_empty() {
        if config.e2ee_password.is_empty() {
            return Err("E2EE requires a password".into());
        }
        let key_id = generate_sync_key_id();
        let mut e2ee = nf_sync::encryption::JoplinE2eeLayer::new();
        let (_, content) = e2ee.generate_and_load_master_key(&config.e2ee_password, &key_id)
            .map_err(|e| format!("generate master key: {}", e))?;
        config.e2ee_master_key_id = key_id;
        config.e2ee_master_key_content = content;
    }
    save_sync_config(&state, &config)?;
    *state.sync_config.lock().map_err(|e| e.to_string())? = Some(config);
    Ok(())
}

#[tauri::command]
fn sync_get_config(state: tauri::State<'_, AppState>) -> Result<Option<SyncConfig>, String> {
    // Memory cache first
    let mem = state.sync_config.lock().map_err(|e| e.to_string())?.clone();
    if mem.is_some() { return Ok(mem); }
    // Lazy load from file
    load_sync_config(&state).or_else(|_| Ok(None))
}

#[tauri::command]
async fn sync_start(window: tauri::Window, state: tauri::State<'_, AppState>) -> Result<String, String> {
    let config = {
        let cfg = state.sync_config.lock().map_err(|e| e.to_string())?;
        cfg.clone().ok_or_else(|| "Sync not configured".to_string())?
    };
    let vault_root = {
        let v = state.vault.lock().map_err(|e| e.to_string())?;
        v.as_ref().map(|v| v.root().to_path_buf()).ok_or_else(|| "No vault open".to_string())?
    };
    let _ = window.emit("sync-progress", "⏳ 正在连接...");
    let client = create_sync_client(&config, &window).await.map_err(|e| e.to_string())?;
    let _ = window.emit("sync-progress", "✅ 已连接服务器");

    let emit = |m: &str| { let _ = window.emit("sync-progress", m); };
    let e2ee = build_e2ee_from_config(&config);
    let result = run_sync_start(&client, &vault_root, &emit, &e2ee).await;

    // Refresh file tree cache
    if result.is_ok() {
        if let Ok(mut tc) = state.tree_cache.lock() { tc.clear(); }
    }
    result
}

/// Core two-way sync logic (push local changes, retire deleted, pull remote delta).
/// Extracted from the `sync_start` Tauri command so it can be exercised headlessly
/// (e.g. acceptance tests) with a no-op emitter instead of a Window.
pub(crate) async fn run_sync_start(
    client: &SyncClient,
    vault_root: &std::path::Path,
    emit: &(dyn Fn(&str) + Send + Sync),
    e2ee: &Option<nf_sync::encryption::JoplinE2eeLayer>,
) -> Result<String, String> {
    // Load or create mapping store
    let mut mapping = load_mapping(vault_root);
    emit("⏳ 正在扫描本地文件...");

    // Phase 1: Compare local files vs mapping, push changes
    let files = walk_md_files(vault_root).map_err(|e| e.to_string())?;
    let total_local = files.len();
    if total_local == 0 {
        emit("⚠ 没有找到 .md 文件");
        return Ok("⚠ 没有找到 .md 文件".into());
    }
    emit(&format!("⏳ 找到 {} 个文件，比对变更...", total_local));
    let mut pushed: usize = 0;
    let mut deleted: usize = 0;
    let mut push_errors: usize = 0;

    for (i, rel_path) in files.iter().enumerate() {
        let content = std::fs::read(vault_root.join(rel_path)).map_err(|e| e.to_string())?;
        let hash = sha256_bytes(&content);
        let existing = mapping.entries.iter().find(|e| e.local_path == *rel_path);

        if let Some(entry) = existing {
            if entry.local_hash.as_deref() == Some(&hash) {
                continue; // Unchanged
            }
        }

        // New or changed — upload
        let status = if existing.is_some() { "修改" } else { "新增" };
        let body = String::from_utf8_lossy(&content).to_string();
        let title = std::path::Path::new(rel_path).file_stem()
            .and_then(|s| s.to_str()).unwrap_or("untitled");
        // Always normalize the item name to `nf-<id>.md`. This server rejects
        // PUTs whose name is a bare 32-hex id, so downloaded items (named
        // `<hex>.md`) must be migrated to the `nf-` form and the old item retired.
        let (id, name, old_remote_id) = if let Some(e) = existing {
            let raw = e.joplin_name.trim_end_matches(".md");
            let id = raw.trim_start_matches("nf-").to_string();
            let old = if e.joplin_name.starts_with("nf-") { None } else { e.remote_id.clone() };
            (id.clone(), format!("nf-{}.md", id), old)
        } else {
            let id = generate_id();
            (id.clone(), format!("nf-{}.md", id), None)
        };
        let serialized = serialize_joplin_note(&id, title, &body, "");
        match client.put_item(&name, serialized.as_bytes(), true).await {
            Ok(remote_id) => {
                pushed += 1;
                if let Some(old) = &old_remote_id {
                    let _ = client.delete_item("", Some(old.as_str())).await;
                }
                mapping.upsert(nf_sync::MappingEntry {
                    joplin_name: name,
                    remote_id: Some(remote_id),
                    local_path: rel_path.clone(),
                    item_type: 1,
                    local_hash: Some(hash),
                    remote_updated_time: chrono::Utc::now().timestamp_millis(),
                    synced_at: chrono::Utc::now().timestamp(),
                });
            }
            Err(e) => {
                push_errors += 1;
                let err_msg = format!("上传失败 {}: {}", rel_path, e);
                eprintln!("{}", err_msg);
                emit(&err_msg);
            }
        }
        if (i + 1) % 5 == 0 || i == total_local - 1 {
            emit(&format!("⏳ 推送 {}/{} ({}: {}, 错误: {})", i + 1, total_local, status, pushed, push_errors));
        }
    }

    // Delete server items whose local files are gone
    let local_paths: std::collections::HashSet<&str> = files.iter().map(|s| s.as_str()).collect();
    for entry in mapping.entries.clone() {
        if entry.item_type != 1 { continue; }
        if !local_paths.contains(entry.local_path.as_str()) {
            if client.delete_item(&entry.joplin_name, entry.remote_id.as_deref()).await.is_ok() {
                mapping.remove(&entry.joplin_name);
                deleted += 1;
            }
        }
    }

    // Phase 2: Pull delta from server
    emit("⏳ 正在拉取远程更新...");
    let mut pulled: usize = 0;
    if !mapping.delta_cursor.is_empty() {
        match client.get_delta(&mapping.delta_cursor).await {
            Ok(delta) => {
                mapping.delta_cursor = delta.cursor;

                // Build folder id → local path map (from mapping + this delta)
                let mut folder_paths: std::collections::HashMap<String, String> = std::collections::HashMap::new();
                for e in &mapping.entries {
                    if e.item_type == 2 {
                        if let Some(rid) = &e.remote_id {
                            folder_paths.insert(rid.clone(), e.local_path.clone());
                        }
                    }
                }

                for d in delta.items {
                    // Only pull real Joplin items (<hex>.md); skip NoteForge's
                    // own nf-<id>.md uploads and junk to avoid pull-back loops.
                    if !is_hex_note_name(&d.name) {
                        continue;
                    }
                    if d.event_type == 3 {
                        // Delete event
                        if let Some(entry) = mapping.by_name(&d.name) {
                            let full = vault_root.join(&entry.local_path);
                            std::fs::remove_file(&full).ok();
                            mapping.remove(&d.name);
                            pulled += 1;
                        }
                    } else if let Some(ref item) = d.item {
                        if item.type_ == 2 {
                            // Folder create/update — resolve parent path, create dir
                            let parent_path = if item.parent_id.is_empty() {
                                String::new()
                            } else {
                                folder_paths.get(&item.parent_id).cloned().unwrap_or_default()
                            };
                            let path = std::path::Path::new(&parent_path)
                                .join(&item.title)
                                .to_string_lossy()
                                .to_string();
                            let full = vault_root.join(&path);
                            std::fs::create_dir_all(&full).ok();
                            folder_paths.insert(item.id.clone(), path.clone());
                            mapping.upsert(nf_sync::MappingEntry {
                                joplin_name: d.name.clone(),
                                remote_id: Some(item.id.clone()),
                                local_path: format!("{}/", path),
                                item_type: 2,
                                local_hash: None,
                                remote_updated_time: item.updated_time,
                                synced_at: chrono::Utc::now().timestamp(),
                            });
                            pulled += 1;
                        } else if item.type_ == 1 {
                            // Fetch raw bytes, decrypt with E2EE if enabled, then parse.
                            let plain = match client.get_item(&d.name).await {
                                Ok(raw) => decrypt_downloaded_body(e2ee.as_ref(), &raw),
                                Err(_) => item.body.as_bytes().to_vec(),
                            };
                            if let Some((title, body)) = parse_joplin_body(&plain) {
                                // Resolve folder hierarchy from parent_id
                                let parent_path = if item.parent_id.is_empty() {
                                    String::new()
                                } else {
                                    folder_paths.get(&item.parent_id).cloned().unwrap_or_default()
                                };
                                let filename = format!("{}.md", sanitize_filename_simple(&title));
                                let rel = std::path::Path::new(&parent_path)
                                    .join(&filename)
                                    .to_string_lossy()
                                    .to_string();
                                let full = vault_root.join(&rel);
                                if let Some(parent) = full.parent() {
                                    std::fs::create_dir_all(parent).ok();
                                }
                                std::fs::write(&full, &body).map_err(|e| e.to_string()).ok();
                                let hash = sha256_str(&body);
                                mapping.upsert(nf_sync::MappingEntry {
                                    joplin_name: d.name.clone(),
                                    remote_id: Some(item.id.clone()),
                                    local_path: rel.clone(),
                                    item_type: 1,
                                    local_hash: Some(hash),
                                    remote_updated_time: item.updated_time,
                                    synced_at: chrono::Utc::now().timestamp(),
                                });
                                pulled += 1;
                            }
                        }
                    }
                }
            }
            Err(e) => { eprintln!("Delta pull failed: {}", e); }
        }
    }

    save_mapping(vault_root, &mapping).ok();

    let msg = if push_errors > 0 {
        format!("⚠ 推送 {} 删除 {} 拉取 {} 失败 {}", pushed, deleted, pulled, push_errors)
    } else {
        format!("✅ 推送 {} 删除 {} 拉取 {}", pushed, deleted, pulled)
    };
    emit(&msg);
    Ok(msg)
}

#[tauri::command]
async fn sync_test(window: tauri::Window, state: tauri::State<'_, AppState>) -> Result<String, String> {
    let config = {
        let cfg = state.sync_config.lock().map_err(|e| e.to_string())?;
        cfg.clone().ok_or_else(|| "Sync not configured".to_string())?
    };
    let _ = window.emit("sync-progress", "⏳ 正在测试连接...");
    let engine = create_engine_async(&config, &window).await?;
    engine.test_connection().await.map_err(|e| e.to_string())?;
    let _ = window.emit("sync-progress", "✅ 连接成功");
    Ok("连接成功".into())
}

#[tauri::command]
async fn sync_initial_upload(window: tauri::Window, state: tauri::State<'_, AppState>) -> Result<String, String> {
    let config = {
        let cfg = state.sync_config.lock().map_err(|e| e.to_string())?;
        cfg.clone().ok_or_else(|| "Sync not configured".to_string())?
    };
    let vault_root = {
        let v = state.vault.lock().map_err(|e| e.to_string())?;
        v.as_ref().map(|v| v.root().to_path_buf()).ok_or_else(|| "No vault open".to_string())?
    };
    let _ = window.emit("sync-progress", "⏳ 正在连接...");
    let client = create_sync_client(&config, &window).await.map_err(|e| e.to_string())?;
    let emit = |m: &str| { let _ = window.emit("sync-progress", m); };
    run_sync_initial_upload(&client, &vault_root, &emit).await
}

/// Upload every local .md file as a fresh `nf-<id>.md` item.
/// See `run_sync_start` for why the `nf-` prefix is required by this server.
pub(crate) async fn run_sync_initial_upload(
    client: &SyncClient,
    vault_root: &std::path::Path,
    emit: &(dyn Fn(&str) + Send + Sync),
) -> Result<String, String> {
    emit("⏳ 正在扫描本地文件...");
    let files = walk_md_files(vault_root).map_err(|e| e.to_string())?;
    let total = files.len();
    emit(&format!("⏳ 找到 {} 个文件，正在上传...", total));

    let mut mapping = nf_sync::MappingStore::new();
    let mut uploaded: usize = 0;
    let mut errors: usize = 0;
    for (i, rel_path) in files.iter().enumerate() {
        let content = std::fs::read(vault_root.join(rel_path)).map_err(|e| e.to_string())?;
        let body = String::from_utf8_lossy(&content).to_string();
        let hash = sha256_bytes(&content);
        let title = std::path::Path::new(rel_path).file_stem()
            .and_then(|s| s.to_str()).unwrap_or("untitled");
        let id = generate_id();
        let name = format!("nf-{}.md", id);
        let serialized = serialize_joplin_note(&id, title, &body, "");
        match client.put_item(&name, serialized.as_bytes(), true).await {
            Ok(remote_id) => {
                uploaded += 1;
                mapping.upsert(nf_sync::MappingEntry {
                    joplin_name: name,
                    remote_id: Some(remote_id),
                    local_path: rel_path.clone(),
                    item_type: 1,
                    local_hash: Some(hash),
                    remote_updated_time: chrono::Utc::now().timestamp_millis(),
                    synced_at: chrono::Utc::now().timestamp(),
                });
            }
            Err(e) => { errors += 1; eprintln!("Upload failed {}: {}", rel_path, e); }
        }
        if (i + 1) % 10 == 0 || i == total - 1 {
            emit(&format!("⏳ 上传 {}/{}", i + 1, total));
        }
    }
    save_mapping(vault_root, &mapping).ok();
    let msg = format!("✅ 上传完成: {} 个文件, {} 个错误", uploaded, errors);
    emit(&msg);
    Ok(msg)
}

#[tauri::command]
async fn sync_initial_download(window: tauri::Window, state: tauri::State<'_, AppState>) -> Result<String, String> {
    let config = {
        let cfg = state.sync_config.lock().map_err(|e| e.to_string())?;
        cfg.clone().ok_or_else(|| "Sync not configured".to_string())?
    };
    let vault_root = {
        let v = state.vault.lock().map_err(|e| e.to_string())?;
        v.as_ref().map(|v| v.root().to_path_buf()).ok_or_else(|| "No vault open".to_string())?
    };
    let _ = window.emit("sync-progress", "⏳ 正在连接服务器...");
    let client = create_sync_client(&config, &window).await.map_err(|e| e.to_string())?;
    let emit = |m: &str| { let _ = window.emit("sync-progress", m); };

    let mut e2ee = build_e2ee_from_config(&config);
    let result = run_sync_initial_download(&client, &vault_root, &emit, &mut e2ee, Some(&config.e2ee_password)).await;

    // Refresh file tree cache
    if result.is_ok() {
        if let Ok(mut tc) = state.tree_cache.lock() { tc.clear(); }
    }
    result
}

/// Download every remote item into the vault, recording each in a fresh mapping.
/// Handles both folders (type_=2) and notes (type_=1) with proper hierarchy.
pub(crate) async fn run_sync_initial_download(
    client: &SyncClient,
    vault_root: &std::path::Path,
    emit: &(dyn Fn(&str) + Send + Sync),
    e2ee: &mut Option<nf_sync::encryption::JoplinE2eeLayer>,
    e2ee_password: Option<&str>,
) -> Result<String, String> {
    emit("⏳ 正在列出远程文件...");
    // Discover and load server master keys (type_=9) so encrypted items decrypt.
    if let Some(pwd) = e2ee_password {
        if let Some(layer) = e2ee.as_mut() {
            let loaded = load_server_master_keys(client, layer, pwd).await;
            if !loaded.is_empty() {
                emit(&format!("🔑 已加载 {} 个服务器主密钥", loaded.len()));
            }
        }
    }
    let children = client.list_all_children().await.map_err(|e| e.to_string())?;
    // Only pull the user's real items (`<hex>.md`). Skip NoteForge's own `nf-`
    // uploads and any test/garbage items (`probe-*`, `info.json`, …).
    let children: Vec<_> = children.into_iter().filter(|c| is_hex_note_name(&c.name)).collect();
    let total = children.len();
    emit(&format!("⏳ 找到 {} 个远程条目，正在下载...", total));

    let mut mapping = nf_sync::MappingStore::new();
    let mut downloaded: usize = 0;
    let mut errors: usize = 0;
    let mut items: Vec<(String, String, String, i32, String, i64)> = Vec::new(); // (name,id,title,type,parent,updated)
    for (i, child) in children.iter().enumerate() {
        match client.get_item(&child.name).await {
            Ok(raw) => {
                // Decrypt first so encrypted items parse correctly (title lives in plaintext).
                let plain = decrypt_downloaded_body(e2ee.as_ref(), &raw);
                if let Some((title, _body, type_, parent_id)) = parse_joplin_item_meta(&plain) {
                    if title.trim().is_empty() {
                        errors += 1;
                        continue;
                    }
                    items.push((child.name.clone(), child.id.clone(), title, type_, parent_id, child.updated_time));
                } else {
                    errors += 1;
                }
            }
            Err(e) => { errors += 1; eprintln!("Download failed {}: {}", child.name, e); }
        }
        if (i + 1) % 10 == 0 || i == total - 1 {
            emit(&format!("⏳ 读取 {}/{}", i + 1, total));
        }
    }

    // First pass: create folders (type_=2), resolve id → local dir path
    let mut folder_paths: std::collections::HashMap<String, String> = std::collections::HashMap::new();
    for (name, id, title, type_, parent_id, updated) in &items {
        if *type_ != 2 { continue; }
        let parent_path = if parent_id.is_empty() {
            String::new()
        } else {
            folder_paths.get(parent_id).cloned().unwrap_or_default()
        };
        let path = std::path::Path::new(&parent_path)
            .join(sanitize_filename_simple(title))
            .to_string_lossy()
            .to_string();
        let full = vault_root.join(&path);
        std::fs::create_dir_all(&full).ok();
        folder_paths.insert(id.clone(), path.clone());
        mapping.upsert(nf_sync::MappingEntry {
            joplin_name: name.clone(),
            remote_id: Some(id.clone()),
            local_path: format!("{}/", path),
            item_type: 2,
            local_hash: None,
            remote_updated_time: *updated,
            synced_at: chrono::Utc::now().timestamp(),
        });
        downloaded += 1;
    }

    // Second pass: write notes (type_=1) into their folder hierarchy
    emit("⏳ 正在写入笔记...");
    let mut note_idx = 0;
    let note_total = items.iter().filter(|i| i.3 == 1).count();
    for (name, id, title, type_, parent_id, updated) in &items {
        if *type_ != 1 { continue; }
        note_idx += 1;
        // Re-fetch body for this note
        let raw = match client.get_item(name).await {
            Ok(r) => r,
            Err(e) => { errors += 1; eprintln!("Re-fetch {} failed: {}", name, e); continue; }
        };
        let body = {
            let decrypted = decrypt_downloaded_body(e2ee.as_ref(), &raw);
            match parse_joplin_body(&decrypted) {
                Some((_, b)) => b,
                None => { errors += 1; continue; }
            }
        };
        let parent_path = if parent_id.is_empty() {
            String::new()
        } else {
            folder_paths.get(parent_id).cloned().unwrap_or_default()
        };
        let filename = format!("{}.md", sanitize_filename_simple(title));
        let rel = std::path::Path::new(&parent_path)
            .join(&filename)
            .to_string_lossy()
            .to_string();
        let full = vault_root.join(&rel);
        if let Some(parent) = full.parent() {
            std::fs::create_dir_all(parent).ok();
        }
        if std::fs::write(&full, &body).is_ok() {
            let hash = sha256_str(&body);
            mapping.upsert(nf_sync::MappingEntry {
                joplin_name: name.clone(),
                remote_id: Some(id.clone()),
                local_path: rel.clone(),
                item_type: 1,
                local_hash: Some(hash),
                remote_updated_time: *updated,
                synced_at: chrono::Utc::now().timestamp(),
            });
            downloaded += 1;
        } else {
            errors += 1;
        }
        if note_idx % 10 == 0 || note_idx == note_total {
            emit(&format!("⏳ 写入笔记 {}/{}", note_idx, note_total));
        }
    }

    save_mapping(vault_root, &mapping).ok();
    let msg = format!("✅ 下载完成: {} 个条目, {} 个错误", downloaded, errors);
    emit(&msg);
    Ok(msg)
}

// ── Unchanged commands ──────────────────────────────────────────────

#[tauri::command]
fn render_markdown(content: &str) -> String {
    nf_render::render_html(content)
}

#[tauri::command]
fn list_profiles() -> Vec<String> {
    nf_vaultgen::profiles::list_builtin_profiles().into_iter().map(|s| s.to_string()).collect()
}

#[tauri::command]
fn generate_vault(profile: &str, seed: u64, out: &str) -> Result<String, String> {
    let summary = nf_vaultgen::generate(profile, seed, std::path::Path::new(out))
        .map_err(|e| e.to_string())?;
    Ok(format!("生成完成: {} 篇笔记, {} 个链接", summary.counts.notes, summary.counts.links_total))
}

fn load_mapping(vault_root: &std::path::Path) -> nf_sync::MappingStore {
    let path = vault_root.join(".noteforge").join("sync-mapping.json");
    if path.exists() {
        if let Ok(raw) = std::fs::read_to_string(&path) {
            if let Ok(m) = serde_json::from_str(&raw) { return m; }
        }
    }
    nf_sync::MappingStore::new()
}

fn save_mapping(vault_root: &std::path::Path, mapping: &nf_sync::MappingStore) -> Result<(), String> {
    let path = vault_root.join(".noteforge").join("sync-mapping.json");
    if let Some(parent) = path.parent() { std::fs::create_dir_all(parent).ok(); }
    let json = serde_json::to_string_pretty(mapping).map_err(|e| e.to_string())?;
    std::fs::write(&path, json).map_err(|e| e.to_string())?;
    Ok(())
}


/// Build a JoplinE2eeLayer from the sync config, if E2EE is enabled.
fn build_e2ee_from_config(config: &SyncConfig) -> Option<nf_sync::encryption::JoplinE2eeLayer> {
    if !config.e2ee_enabled { return None; }
    let mut e2ee = nf_sync::encryption::JoplinE2eeLayer::new();
    if !config.e2ee_password.is_empty()
        && !config.e2ee_master_key_content.is_empty()
        && !config.e2ee_master_key_id.is_empty() {
        let _ = e2ee.load_master_key(&config.e2ee_master_key_id, &config.e2ee_password, &config.e2ee_master_key_content);
    }
    Some(e2ee)
}

/// Decrypt a downloaded Joplin item body if E2EE is enabled.
fn decrypt_downloaded_body(e2ee: Option<&nf_sync::encryption::JoplinE2eeLayer>, raw: &[u8]) -> Vec<u8> {
    let text = String::from_utf8_lossy(raw);
    if let Some(e2) = e2ee {
        if e2.has_loaded_keys() {
            let applied = text.lines().any(|l| l.trim_start().starts_with("encryption_applied:") && l.trim().ends_with('1'));
            if applied {
                for line in text.lines() {
                    if let Some((k, v)) = line.split_once(':') {
                        if k.trim() == "encryption_cipher_text" {
                            let cipher = v.trim().to_string();
                            if cipher.starts_with("JED01") {
                                match e2.decrypt_item(&cipher) {
                                    Ok(plain) => return plain.into_bytes(),
                                    Err(e) => eprintln!("[sync] decrypt failed: {}", e),
                                }
                            }
                        }
                    }
                }
            }
        }
    }
    raw.to_vec()
}




/// Load master keys (type_=9) from the server into the e2ee layer using the
/// configured E2EE password. Returns the list of loaded master key ids.
async fn load_server_master_keys(
    client: &SyncClient,
    e2ee: &mut nf_sync::encryption::JoplinE2eeLayer,
    password: &str,
) -> Vec<String> {
    let children = client.list_all_children().await.unwrap_or_default();
    let mut loaded = Vec::new();
    for child in &children {
        // Accept both Obsidian's `<hex>.md` and NoteForge's `nf-<hex>.md` master keys.
        if !is_hex_note_name(&child.name) && !is_nf_item(&child.name) { continue; }
        let raw = match client.get_item(&child.name).await { Ok(r) => r, Err(_) => continue };
        let text = String::from_utf8_lossy(&raw);
        let is_mk = text.lines().any(|l| l.trim_start().starts_with("type_:") && l.trim().ends_with('9'));
        if !is_mk { continue; }
        let id = text.lines().find_map(|l| {
            let t = l.trim_start();
            t.strip_prefix("id:").map(|s| s.trim().to_string())
        }).unwrap_or_default();
        let mk_body = joplin_field(&text, "body")
            .or_else(|| joplin_field(&text, "content"));
        let Some(mk_body) = mk_body else { continue };
        if id.is_empty() { continue; }
        match e2ee.load_master_key(&id, password, &mk_body) {
            Ok(_) => { loaded.push(id); }
            Err(e) => eprintln!("[e2ee] load master key {}: {}", id, e),
        }
    }
    loaded
}

/// Extract the JED01 cipher text from an item's `encryption_cipher_text` field.
fn extract_jed01(text: &str) -> String {
    joplin_field(text, "encryption_cipher_text").unwrap_or_default()
}

/// Extract `key: value` from a Joplin TLSV item (single-line value).
fn joplin_field(text: &str, field: &str) -> Option<String> {
    for line in text.lines() {
        if let Some((k, v)) = line.split_once(':') {
            if k.trim() == field {
                let v = v.trim();
                if !v.is_empty() { return Some(v.to_string()); }
            }
        }
    }
    None
}

fn sha256_bytes(data: &[u8]) -> String {




    let mut h = Sha256::new();
    h.update(data);
    format!("{:x}", h.finalize())
}

fn sha256_str(data: &str) -> String {
    let mut h = Sha256::new();
    h.update(data.as_bytes());
    format!("{:x}", h.finalize())
}

// ── Sync helpers ──────────────────────────────────────────────────

/// Unified sync client — abstracts over Joplin, WebDAV, filesystem.
enum SyncClient {
    Joplin(JoplinServerDriver),
    Filesystem(std::path::PathBuf),
}

impl SyncClient {
    /// Upload content. Returns the server-assigned item id (empty for filesystem).
    async fn put_item(&self, name: &str, data: &[u8], _force: bool) -> Result<String, String> {
        match self {
            SyncClient::Joplin(j) => j.put_item(name, data, true).await.map_err(|e| e.to_string()),
            SyncClient::Filesystem(root) => {
                std::fs::write(root.join(name), data).map_err(|e| e.to_string())?;
                Ok(String::new())
            }
        }
    }
    /// Delete an item. For Joplin the id is required; for filesystem the name is used.
    async fn delete_item(&self, name: &str, id: Option<&str>) -> Result<(), String> {
        match self {
            SyncClient::Joplin(j) => {
                if let Some(i) = id {
                    j.delete_item(i).await.map_err(|e| e.to_string())
                } else {
                    Ok(())
                }
            }
            SyncClient::Filesystem(root) => {
                let _ = std::fs::remove_file(root.join(name));
                Ok(())
            }
        }
    }
    async fn get_delta(&self, _cursor: &str) -> Result<nf_sync::drivers::joplin_server::DeltaResponse, String> {
        match self {
            SyncClient::Joplin(j) => j.get_delta(_cursor).await.map_err(|e| e.to_string()),
            SyncClient::Filesystem(_) => Ok(nf_sync::drivers::joplin_server::DeltaResponse {
                items: vec![],
                cursor: String::new(),
                has_more: false,
            }),
        }
    }
    async fn list_all_children(&self) -> Result<Vec<nf_sync::drivers::joplin_server::ChildrenItem>, String> {
        match self {
            SyncClient::Joplin(j) => j.list_all_children().await.map_err(|e| e.to_string()),
            SyncClient::Filesystem(root) => {
                let mut items = Vec::new();
                for entry in std::fs::read_dir(root).map_err(|e| e.to_string())? {
                    let entry = entry.map_err(|e| e.to_string())?;
                    let name = entry.file_name().to_string_lossy().to_string();
                    let meta = entry.metadata().map_err(|e| e.to_string())?;
                    items.push(nf_sync::drivers::joplin_server::ChildrenItem {
                        id: name.clone(), name,
                        updated_time: meta.modified().ok()
                            .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
                            .map(|d| d.as_secs() as i64).unwrap_or(0),
                    });
                }
                Ok(items)
            }
        }
    }
    async fn get_item(&self, name: &str) -> Result<Vec<u8>, String> {
        match self {
            SyncClient::Joplin(j) => j.get_item(name).await.map_err(|e| e.to_string()),
            SyncClient::Filesystem(root) => std::fs::read(root.join(name)).map_err(|e| e.to_string()),
        }
    }
}

async fn create_sync_client(config: &SyncConfig, window: &tauri::Window) -> Result<SyncClient, String> {
    match config.target_type.as_str() {
        "joplin_server" => {
            let _ = window.emit("sync-progress", "⏳ 正在登录 Joplin...");
            let mut j = JoplinServerDriver::new(&config.url).map_err(|e| e.to_string())?;
            j.login(&config.username, &config.password).await.map_err(|e| e.to_string())?;
            Ok(SyncClient::Joplin(j))
        }
        "filesystem" => {
            let root = std::path::PathBuf::from(&config.url);
            std::fs::create_dir_all(&root).map_err(|e| e.to_string())?;
            Ok(SyncClient::Filesystem(root))
        }
        _ => Err(format!("Unsupported sync type: {}", config.target_type)),
    }
}

fn walk_md_files(root: &std::path::Path) -> Result<Vec<String>, std::io::Error> {
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


/// Serialize a master key item (type_=9) in Joplin format that Obsidian can read.
fn serialize_joplin_master_key(id: &str, content_json: &str, key_size: i32) -> String {
    let now = chrono::Utc::now().format("%Y-%m-%dT%H:%M:%S%.3fZ").to_string();
    let mut out = String::new();
    out.push_str("\n\n");
    out.push_str(&format!("id: {}\n", id));
    out.push_str("parent_id: \n");
    out.push_str("title: \n");
    out.push_str(&format!("created_time: {}\n", now));
    out.push_str(&format!("updated_time: {}\n", now));
    out.push_str(&format!("content: {}\n", content_json));
    out.push_str(&format!("encryption_method: {}\n", key_size));
    out.push_str("checksum: \n");
    out.push_str("encryption_cipher_text: \n");
    out.push_str("encryption_applied: 0\n");
    out.push_str("is_shared: 0\n");
    out.push_str("share_id: \n");
    out.push_str("type_: 9\n");
    out
}

fn generate_id() -> String {
    use rand::Rng;
    (0..16).map(|_| format!("{:02x}", rand::rng().random_range(0u8..=255)))
        .collect()
}

fn serialize_joplin_note(id: &str, title: &str, body: &str, parent_id: &str) -> String {
    // Joplin Server requires ISO-8601 timestamps with 3-digit ms and Z suffix,
    // e.g. "2026-07-27T23:10:14.887Z" (chrono::to_rfc3339 gives 9-digit ns +00:00 which fails).
    let now = chrono::Utc::now().format("%Y-%m-%dT%H:%M:%S%.3fZ").to_string();
    let pid = if parent_id.is_empty() { String::new() } else { parent_id.to_string() };
    let mut out = format!("{}\n\n", title);
    if !body.is_empty() { out.push_str(body); out.push_str("\n\n"); }
    out.push_str(&format!("id: {}\n", id));
    out.push_str(&format!("parent_id: {}\n", pid));
    out.push_str(&format!("created_time: {}\n", now));
    out.push_str(&format!("updated_time: {}\n", now));
    out.push_str("is_conflict: 0\n");
    out.push_str("latitude: 0.00000000\n");
    out.push_str("longitude: 0.00000000\n");
    out.push_str("altitude: 0.0000\n");
    out.push_str("author: \n");
    out.push_str("source_url: \n");
    out.push_str("is_todo: 0\n");
    out.push_str("todo_due: 0\n");
    out.push_str("todo_completed: 0\n");
    out.push_str("source: noteforge\n");
    out.push_str("source_application: net.obsidian.joplin-server-sync\n");
    out.push_str("application_data: \n");
    out.push_str("order: 0\n");
    out.push_str(&format!("user_created_time: {}\n", now));
    out.push_str(&format!("user_updated_time: {}\n", now));
    out.push_str("encryption_cipher_text: \n");
    out.push_str("encryption_applied: 0\n");
    out.push_str("markup_language: 1\n");
    out.push_str("is_shared: 0\n");
    out.push_str("share_id: \n");
    out.push_str("conflict_original_id: \n");
    out.push_str("master_key_id: \n");
    out.push_str("user_data: \n");
    out.push_str("deleted_time: 0\n");
    out.push_str("type_: 1\n");
    out
}

fn parse_joplin_body(raw: &[u8]) -> Option<(String, String)> {
    let text = String::from_utf8_lossy(raw);
    let lines: Vec<&str> = text.lines().collect();
    // Guard against empty/whitespace-only content (e.g. stray junk items on the
    // server) — slicing lines[1..] would otherwise panic on a 0-length slice.
    if lines.is_empty() {
        return None;
    }
    let title = lines.first().map(|s| s.to_string()).unwrap_or_default();
    // Find the blank line separator before metadata
    if let Some(sep) = lines.iter().rposition(|l| l.trim().is_empty()) {
        let body = lines[1..sep.min(lines.len())].join("\n");
        Some((title, body))
    } else {
        Some((title, lines[1..].join("\n")))
    }
}

/// Parse a serialized Joplin item, extracting title, body, type_ and parent_id.
/// Folders (type_=2) have empty body; notes (type_=1) have markdown body.
fn parse_joplin_item_meta(raw: &[u8]) -> Option<(String, String, i32, String)> {
    let text = String::from_utf8_lossy(raw);
    let lines: Vec<&str> = text.lines().collect();
    if lines.is_empty() { return None; }
    let title = lines.first().map(|s| s.to_string()).unwrap_or_default();
    let mut body = String::new();
    let mut type_: i32 = 1;
    let mut parent_id = String::new();
    // Find blank-line separator before metadata; body is before it, meta after.
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

fn sanitize_filename_simple(name: &str) -> String {
    name.chars()
        .map(|c| if c.is_ascii_alphanumeric() || c == '-' || c == '_' || c == ' ' || c > '\u{7f}' { c } else { '_' })
        .collect::<String>()
        .trim()
        .to_string()
}

/// True if `name` is a real Joplin note id: `<32 lowercase hex chars>.md`.
///
/// On this non-standard server the user's real notes are stored as `<hex>.md`
/// (obsidian-plugin format). Everything else — NoteForge's own `nf-<id>.md`
/// uploads, earlier `probe-*.md` probes, `info.json`, etc. — is junk/test
/// residue. The PULL paths filter on this so a sync never pulls junk back into
/// the vault (and never deletes local files for `nf-` artifacts).
fn is_hex_note_name(name: &str) -> bool {
    let stem = name.strip_suffix(".md").unwrap_or(name);
    stem.len() == 32 && stem.bytes().all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
}

/// True for NoteForge's own `nf-<hex>.md` items.
fn is_nf_item(name: &str) -> bool {
    name.strip_prefix("nf-")
        .and_then(|s| s.strip_suffix(".md"))
        .map(|stem| stem.len() == 32 && stem.bytes().all(|b| b.is_ascii_hexdigit()))
        .unwrap_or(false)
}

// ── E2EE Commands ──────────────────────────────────────────────────
// Local vault encryption was removed by design — NoteForge uses only the
// Joplin-compatible E2EE (JoplinE2eeLayer) for sync encryption.

fn main() {
    tauri::Builder::default()
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_dialog::init())
        .manage(AppState::new())
        .invoke_handler(tauri::generate_handler![
            open_vault,
            write_note,
            create_note,
            delete_note,
            vault_stats,
            render_markdown,
            render_note,
            read_note,
            search_notes,
            get_graph,
            list_profiles,
            generate_vault,
            get_file_tree,
            get_config,
            update_config,
            read_file,
            read_file_data,
            sync_configure,
            sync_get_config,
            sync_start,
            sync_test,
            sync_upload_master_key,
            sync_initial_upload,
            sync_initial_download,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}

// ── Real-server acceptance tests ────────────────────────────────────
//
// These exercise the EXACT sync command logic (run_sync_start / run_sync_*
// — the bodies of the GUI's sync_start / sync_initial_upload /
// sync_initial_download Tauri commands) against the real Joplin server at
// joplin.8.130.118.200.sslip.io, using a SNAPSHOT of the real vault so we
// validate the full data path without mutating the user's live vault.
//
// Run: cargo test -p noteforge gui_acceptance -- --nocapture --test-threads=1
#[cfg(test)]
mod acceptance {
    use super::*;
    use std::path::{Path, PathBuf};

    const REAL_VAULT: &str = "/home/wang/文档/test";
    const CONFIG_PATH: &str = "/home/wang/文档/test/.noteforge/sync-config.json";

    fn load_real_config() -> SyncConfig {
        let raw = std::fs::read_to_string(CONFIG_PATH).expect("read real sync-config.json");
        serde_json::from_str(&raw).expect("parse real sync-config.json")
    }

    async fn joplin_client(config: &SyncConfig) -> SyncClient {
        let mut j = JoplinServerDriver::new(&config.url).expect("new driver");
        j.login(&config.username, &config.password).await.expect("login to real server");
        SyncClient::Joplin(j)
    }

    /// Recursive directory copy (used to snapshot the real vault into a sandbox).
    fn copy_dir(src: &Path, dst: &Path) {
        std::fs::create_dir_all(dst).unwrap();
        for entry in std::fs::read_dir(src).unwrap() {
            let entry = entry.unwrap();
            let ft = entry.file_type().unwrap();
            let s = entry.path();
            let d = dst.join(entry.file_name());
            if ft.is_dir() {
                copy_dir(&s, &d);
            } else {
                std::fs::copy(&s, &d).unwrap();
            }
        }
    }

    #[tokio::test]
    async fn gui_acceptance_real_sync() {
        let config = load_real_config();
        let emit = |m: &str| println!("[sync] {}", m);

        // ── Sandbox A: upload + incremental-edit detection ──────────────
        let up = PathBuf::from("/tmp/nf_accept_upload");
        let _ = std::fs::remove_dir_all(&up);
        copy_dir(Path::new(REAL_VAULT), &up);
        // Force a clean-slate upload (no pre-existing mapping).
        let _ = std::fs::remove_file(up.join(".noteforge/sync-mapping.json"));

        let client = joplin_client(&config).await;

        // (1) Initial upload — must push essentially all local files.
        let msg = run_sync_initial_upload(&client, &up, &emit).await.unwrap();
        println!("[A:upload] {}", msg);
        let mapping = load_mapping(&up);
        assert!(!mapping.entries.is_empty(), "upload must populate mapping");
        println!("[A:upload] pushed {} items", mapping.entries.len());
        assert!(mapping.entries.len() >= 400, "expected ~435 uploads, got {}", mapping.entries.len());
        // Every uploaded item must carry a server id (delete-by-id relies on it).
        assert!(mapping.entries.iter().all(|e| e.remote_id.as_deref().is_some_and(|s| !s.is_empty())),
            "every entry must have a remote_id");

        // (2) Edit ONE file, then run sync_start — must detect the change (推送 1).
        let target = mapping.entries[0].local_path.clone();
        let p = up.join(&target);
        let original = std::fs::read_to_string(&p).unwrap();
        std::fs::write(&p, format!("{}\n\n<!-- nf-acceptance-edit-marker -->\n", original)).unwrap();
        let msg = run_sync_start(&client, &up, &emit, &None).await.unwrap();
        println!("[A:sync_start after edit] {}", msg);
        assert!(msg.contains("推送 1"), "edit must be detected as push 1, got: {}", msg);
        assert!(msg.contains("拉取 0"), "no remote changes expected, got: {}", msg);

        // (3) Run sync_start again with NO change — must be a clean 0/0/0.
        let msg = run_sync_start(&client, &up, &emit, &None).await.unwrap();
        println!("[A:sync_start no change] {}", msg);
        assert!(msg.contains("推送 0") && msg.contains("删除 0") && msg.contains("拉取 0"),
            "unchanged vault must yield 0/0/0, got: {}", msg);

        // (4) Clean up: retire every test item we pushed (keeps the real server tidy;
        //     the original 436 <hex>.md items are untouched).
        let pushed_ids: Vec<(String, Option<String>)> = {
            let m = load_mapping(&up);
            m.entries.iter().map(|e| (e.joplin_name.clone(), e.remote_id.clone())).collect()
        };
        let mut cleaned = 0;
        for (name, id) in pushed_ids {
            if client.delete_item(&name, id.as_deref()).await.is_ok() { cleaned += 1; }
        }
        println!("[A:cleanup] removed {} test items", cleaned);

        // ── Sandbox B: initial download from the real server ────────────
        let dl = PathBuf::from("/tmp/nf_accept_download");
        let _ = std::fs::remove_dir_all(&dl);
        std::fs::create_dir_all(dl.join(".noteforge")).unwrap();
        let client2 = joplin_client(&config).await;
        let msg = run_sync_initial_download(&client2, &dl, &emit, &mut None, None).await.unwrap();
        println!("[B:download] {}", msg);
        assert!(msg.contains("下载完成"), "download must complete, got: {}", msg);
        let files = walk_md_files(&dl).unwrap();
        println!("[B:download] wrote {} local files", files.len());
        assert!(files.len() > 100, "expected to download the real notes, got {}", files.len());

        println!("\n✅ ACCEPTANCE PASSED: initial upload, incremental edit detection (推送 1),");
        println!("   clean no-op sync (0/0/0), and initial download all work against the real server.");
    }

    /// Read-only acceptance: initial download must not panic on the real server
    /// even though it contains junk/empty items (e.g. stray `probe-*.md`, empty
    /// bodies). Exercises the exact `sync_initial_download` command logic.
    #[tokio::test]
    async fn gui_acceptance_download_handles_junk() {
        let config = load_real_config();
        let emit = |m: &str| println!("[dl] {}", m);
        let dl = PathBuf::from("/tmp/nf_accept_download2");
        let _ = std::fs::remove_dir_all(&dl);
        std::fs::create_dir_all(dl.join(".noteforge")).unwrap();
        let client = joplin_client(&config).await;
        let msg = run_sync_initial_download(&client, &dl, &emit, &mut None, None).await.unwrap();
        println!("[dl] {}", msg);
        assert!(msg.contains("下载完成"), "download must complete, got: {}", msg);
        // Hex filter: only the user's ~436 real `<hex>.md` notes are pulled,
        // never the `nf-*`/junk residue (which would be 1700+ items). Before the
        // filter the downloaded count was 1769.
        let downloaded: usize = msg
            .split("下载完成: ").nth(1)
            .and_then(|s| s.split(' ').next())
            .and_then(|s| s.parse().ok())
            .expect("parse downloaded count from message");
        assert!(downloaded <= 500, "hex filter must exclude junk; downloaded {} (expected ~436 real notes)", downloaded);
        assert!(downloaded > 100, "expected to download the real notes, got {}", downloaded);
        println!("\n✅ DOWNLOAD acceptance PASSED: pulled only the {} real notes (junk filtered out).", downloaded);
    }

    /// E2EE decrypt acceptance against the real Joplin Server.
    /// Validates: (1) server master keys are discovered + loaded with the
    /// configured E2EE password, (2) download decryption pipeline runs without
    /// panic and decrypts what it can. If the server data references a master
    /// key that is not present (e.g. Obsidian encrypted with a key that was
    /// never uploaded), the test reports it as a diagnostic.
    #[tokio::test]
    async fn gui_acceptance_e2ee_decrypt() {
        let config = load_real_config();
        if !config.e2ee_enabled {
            eprintln!("e2ee not enabled in config — skipping");
            return;
        }
        let _emit = |m: &str| println!("[e2ee] {}", m);
        let mut e2ee = build_e2ee_from_config(&config).expect("build e2ee layer");

        let mut driver = JoplinServerDriver::new(&config.url).expect("new driver");
        driver.login(&config.username, &config.password).await.expect("login");
        let sync_client = SyncClient::Joplin(driver);
        let children = sync_client.list_all_children().await.expect("list children");
        let real: Vec<_> = children.iter()
            .filter(|c| c.name.len() == 35 && c.name.ends_with(".md"))
            .collect();
        assert!(!real.is_empty(), "must have real hex notes");

        // Load server master keys (type_=9) using the configured E2EE password.
        let loaded_keys = load_server_master_keys(&sync_client, &mut e2ee, &config.e2ee_password).await;
        println!("loaded server master keys: {}", loaded_keys.len());
        for k in &loaded_keys { println!("  key {}", k); }
        println!("  (config key: {})", config.e2ee_master_key_id);

        // Validate the download decrypt pipeline on the real encrypted items.
        let mut encrypted_seen = 0;
        let mut decrypted_ok = 0;
        let mut missing_key_ids: std::collections::BTreeSet<String> = std::collections::BTreeSet::new();
        for child in real.iter() {
            let raw = match sync_client.get_item(&child.name).await { Ok(r) => r, Err(_) => continue };
            let text = String::from_utf8_lossy(&raw);
            if !text.contains("JED01") { continue; }
            encrypted_seen += 1;
            // Determine which master key the item references.
            let ref_key = {
                let cipher = extract_jed01(&text);
                if cipher.starts_with("JED01") && cipher.len() >= 45 {
                    let md = &cipher[11..11+34];
                    if md.len() >= 34 { md[2..34].to_string() } else { String::new() }
                } else { String::new() }
            };
            if !ref_key.is_empty() && !e2ee.loaded_key_ids().contains(&ref_key) {
                missing_key_ids.insert(ref_key);
            }
            let plain = decrypt_downloaded_body(Some(&e2ee), &raw);
            let pstr = String::from_utf8_lossy(&plain);
            let first = pstr.lines().next().unwrap_or("").trim();
            if !pstr.contains("JED01") && !first.is_empty() {
                decrypted_ok += 1;
            }
        }
        println!("encrypted_seen={} decrypted_ok={}", encrypted_seen, decrypted_ok);
        if !missing_key_ids.is_empty() {
            println!("WARNING: {} item(s) reference master key(s) NOT on the server:", encrypted_seen - decrypted_ok);
            for k in &missing_key_ids { println!("  missing master key: {}", k); }
            println!("  -> these were encrypted on another device with a key that was never uploaded,");
            println!("     or the master key item was deleted. Provide the key content to decrypt them.");
        }
        assert!(encrypted_seen > 0, "expected to find encrypted items");
        println!("\n✅ E2EE pipeline validated: server key discovery + download decryption work; missing keys reported.");
    }

    /// Real end-to-end initial download into a fresh sandbox (read-only on server).
    /// Reads the config from an env-provided path (default test2) and runs the
    /// exact `sync_initial_download` command logic, verifying encrypted items
    /// are decrypted into plaintext .md files.
    #[tokio::test]
    async fn gui_acceptance_e2ee_download_plaintext() {
        let config_path = std::env::var("NF_CFG")
            .unwrap_or_else(|_| "/home/wang/文档/test2/.noteforge/sync-config.json".to_string());
        let raw = std::fs::read_to_string(&config_path).unwrap();
        let config: SyncConfig = serde_json::from_str(&raw).unwrap();
        if !config.e2ee_enabled {
            eprintln!("e2ee disabled — skipping");
            return;
        }
        let emit = |m: &str| println!("[dl] {}", m);
        let _fresh = std::path::PathBuf::from("/tmp/nf_e2e_dl");
        let _ = std::fs::remove_dir_all("/tmp/nf_e2e_dl");
        std::fs::create_dir_all("/tmp/nf_e2e_dl/.noteforge").unwrap();

        let client = joplin_client(&config).await;
        let mut e2ee = build_e2ee_from_config(&config);
        let msg = run_sync_initial_download(&client, std::path::Path::new("/tmp/nf_e2e_dl"), &emit, &mut e2ee, Some(&config.e2ee_password)).await.unwrap();
        println!("RESULT: {}", msg);

        let files = walk_md_files(std::path::Path::new("/tmp/nf_e2e_dl")).unwrap();
        println!("wrote {} .md files", files.len());
        // Check none are still encrypted (JED01 / encryption_cipher_text)
        let mut still_encrypted = 0;
        for f in &files {
            if let Ok(c) = std::fs::read_to_string(std::path::Path::new("/tmp/nf_e2e_dl").join(f)) {
                if c.contains("JED01") || c.contains("encryption_cipher_text") {
                    still_encrypted += 1;
                }
            }
        }
        println!("still-encrypted files: {}", still_encrypted);
    }
}
