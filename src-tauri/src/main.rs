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

    fn with_vault_mut<F, R>(&self, f: F) -> Result<R, String>
    where
        F: FnOnce(&mut Vault) -> Result<R, String>,
    {
        let mut v = self.vault.lock().map_err(|e| e.to_string())?;
        v.as_mut().ok_or_else(|| "No vault open".to_string()).and_then(f)
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
    let result = run_sync_start(&client, &vault_root, &emit).await;

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
                for d in delta.items {
                    // Only ever touch the user's real `<hex>.md` notes; skip `nf-`
                    // uploads and junk so a sync never pulls or deletes local
                    // files for them.
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
                        if item.type_ == 1 {
                            if let Some((title, body)) = parse_joplin_body(item.body.as_bytes()) {
                                let filename = format!("{}.md", sanitize_filename_simple(&title));
                                std::fs::write(vault_root.join(&filename), &body).map_err(|e| e.to_string()).ok();
                                let hash = sha256_str(&body);
                                mapping.upsert(nf_sync::MappingEntry {
                                    joplin_name: d.name.clone(),
                                    remote_id: Some(item.id.clone()),
                                    local_path: sanitize_filename_simple(&title),
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

    let result = run_sync_initial_download(&client, &vault_root, &emit).await;

    // Refresh file tree cache
    if result.is_ok() {
        if let Ok(mut tc) = state.tree_cache.lock() { tc.clear(); }
    }
    result
}

/// Download every remote item into the vault, recording each in a fresh mapping.
pub(crate) async fn run_sync_initial_download(
    client: &SyncClient,
    vault_root: &std::path::Path,
    emit: &(dyn Fn(&str) + Send + Sync),
) -> Result<String, String> {
    emit("⏳ 正在列出远程文件...");
    let children = client.list_all_children().await.map_err(|e| e.to_string())?;
    // Only pull the user's real notes (`<hex>.md`). Skip NoteForge's own `nf-`
    // uploads and any test/garbage items (`probe-*`, `info.json`, …) so a sync
    // never pulls junk back into the vault.
    let children: Vec<_> = children.into_iter().filter(|c| is_hex_note_name(&c.name)).collect();
    let total = children.len();
    emit(&format!("⏳ 找到 {} 个远程笔记，正在下载...", total));

    let mut mapping = nf_sync::MappingStore::new();
    let mut downloaded: usize = 0;
    let mut errors: usize = 0;
    for (i, child) in children.iter().enumerate() {
        match client.get_item(&child.name).await {
            Ok(raw) => {
                if let Some((title, body)) = parse_joplin_body(&raw) {
                    if title.trim().is_empty() {
                        // Skip items that have no usable title (junk/empty server items).
                        errors += 1;
                        continue;
                    }
                    let filename = format!("{}.md", sanitize_filename_simple(&title));
                    if std::fs::write(vault_root.join(&filename), &body).is_ok() {
                        let hash = sha256_str(&body);
                        mapping.upsert(nf_sync::MappingEntry {
                            joplin_name: child.name.clone(),
                            remote_id: Some(child.id.clone()),
                            local_path: sanitize_filename_simple(&title),
                            item_type: 1,
                            local_hash: Some(hash),
                            remote_updated_time: child.updated_time,
                            synced_at: chrono::Utc::now().timestamp(),
                        });
                        downloaded += 1;
                    } else {
                        errors += 1;
                    }
                }
            }
            Err(e) => { errors += 1; eprintln!("Download failed {}: {}", child.name, e); }
        }
        if (i + 1) % 10 == 0 || i == total - 1 {
            emit(&format!("⏳ 下载 {}/{}", i + 1, total));
        }
    }
    save_mapping(vault_root, &mapping).ok();
    let msg = format!("✅ 下载完成: {} 个文件, {} 个错误", downloaded, errors);
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

// ── E2EE Commands ──────────────────────────────────────────────────

#[tauri::command]
fn vault_set_password(password: &str, state: tauri::State<'_, AppState>) -> Result<(), String> {
    state.with_vault_mut(|vault| vault.set_password(password).map_err(|e| e.to_string()))
}

#[tauri::command]
fn vault_unlock(password: &str, state: tauri::State<'_, AppState>) -> Result<(), String> {
    state.with_vault_mut(|vault| vault.unlock(password).map_err(|e| e.to_string()))
}

#[tauri::command]
fn vault_lock(state: tauri::State<'_, AppState>) -> Result<(), String> {
    state.with_vault_mut(|vault| { vault.lock(); Ok(()) })
}

#[tauri::command]
fn vault_is_encrypted(state: tauri::State<'_, AppState>) -> Result<bool, String> {
    state.with_vault(|vault| Ok(vault.is_encrypted()))
}

#[tauri::command]
fn vault_change_password(old_password: &str, new_password: &str, state: tauri::State<'_, AppState>) -> Result<(), String> {
    state.with_vault_mut(|vault| vault.change_password(old_password, new_password).map_err(|e| e.to_string()))
}

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
            sync_initial_upload,
            sync_initial_download,
            vault_set_password,
            vault_unlock,
            vault_lock,
            vault_is_encrypted,
            vault_change_password,
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
        let msg = run_sync_start(&client, &up, &emit).await.unwrap();
        println!("[A:sync_start after edit] {}", msg);
        assert!(msg.contains("推送 1"), "edit must be detected as push 1, got: {}", msg);
        assert!(msg.contains("拉取 0"), "no remote changes expected, got: {}", msg);

        // (3) Run sync_start again with NO change — must be a clean 0/0/0.
        let msg = run_sync_start(&client, &up, &emit).await.unwrap();
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
        let msg = run_sync_initial_download(&client2, &dl, &emit).await.unwrap();
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
        let msg = run_sync_initial_download(&client, &dl, &emit).await.unwrap();
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
}
