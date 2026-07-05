use nf_vault::{FileEntry, Vault};
use serde::{Deserialize, Serialize};
use std::sync::Mutex;

// ── Managed State ───────────────────────────────────────────────────
struct AppState {
    vault: Mutex<Option<Vault>>,
    tree_cache: Mutex<Vec<FileEntry>>,
}

impl AppState {
    fn new() -> Self {
        AppState {
            vault: Mutex::new(None),
            tree_cache: Mutex::new(Vec::new()),
        }
    }

    fn ensure_open(&self, path: &str) -> Result<(), String> {
        let mut v = self.vault.lock().map_err(|e| e.to_string())?;
        if v.as_ref().is_none_or(|v| v.root().to_string_lossy() != path) {
            *v = Some(Vault::open(std::path::Path::new(path)).map_err(|e| e.to_string())?);
            // invalidate tree cache on vault switch
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
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
