//! Obsidian 插件管理：发现已安装插件、市场索引、下载安装、启用/禁用、卸载。
//!
//! 目录约定沿用 Obsidian：`<vault>/.obsidian/plugins/<id>/{main.js,manifest.json,styles.css,data.json}`，
//! 启用列表在 `<vault>/.obsidian/community-plugins.json`。沿用同一套布局的好处是
//! 同一个 vault 在 Obsidian 里和 noteforge 里共享插件与设置。
//!
//! 下载源：本机到 github.com / raw.githubusercontent.com 常不可达，因此顺序是
//! ① jsDelivr（仓库内已提交产物的插件）② GitHub Release 资产（经代理）。
//! 两条路都失败时返回明确错误，不静默失败。

use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};

/// GitHub 代理（Release 资产下载用；实测 ghfast.top / gh-proxy.com 可用）
const GH_PROXIES: [&str; 2] = ["https://ghfast.top", "https://gh-proxy.com"];
const JSDELIVR: &str = "https://cdn.jsdelivr.net/gh";
const MARKET_INDEX: &str = "https://cdn.jsdelivr.net/gh/obsidianmd/obsidian-releases@master/community-plugins.json";

#[derive(Serialize, Deserialize, Clone)]
pub struct InstalledPlugin {
    pub id: String,
    pub name: String,
    pub version: String,
    pub description: String,
    pub author: String,
    pub enabled: bool,
    pub has_main: bool,
    pub bytes: u64,
}

#[derive(Serialize)]
pub struct MarketplaceEntry {
    pub id: String,
    pub name: String,
    pub repo: String,
    pub author: String,
    pub description: String,
}

#[derive(Serialize)]
pub struct InstallReport {
    pub id: String,
    pub source: String,
    pub version: String,
    pub files: Vec<String>,
}

fn plugins_dir(vault_root: &Path) -> PathBuf {
    vault_root.join(".obsidian").join("plugins")
}

fn enabled_set(vault_root: &Path) -> Vec<String> {
    let p = vault_root.join(".obsidian").join("community-plugins.json");
    std::fs::read_to_string(&p)
        .ok()
        .and_then(|s| serde_json::from_str::<Vec<String>>(&s).ok())
        .unwrap_or_default()
}

fn write_enabled_set(vault_root: &Path, list: &[String]) -> Result<(), String> {
    let dir = vault_root.join(".obsidian");
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    let json = serde_json::to_string_pretty(list).map_err(|e| e.to_string())?;
    std::fs::write(dir.join("community-plugins.json"), json).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn list_plugins(vault_root: &str) -> Result<Vec<InstalledPlugin>, String> {
    let root = PathBuf::from(vault_root);
    let dir = plugins_dir(&root);
    let enabled = enabled_set(&root);
    let mut out: Vec<InstalledPlugin> = Vec::new();
    let entries = match std::fs::read_dir(&dir) {
        Ok(e) => e,
        Err(_) => return Ok(out),
    };
    for entry in entries.flatten() {
        if !entry.path().is_dir() {
            continue;
        }
        let mf = entry.path().join("manifest.json");
        let text = match std::fs::read_to_string(&mf) {
            Ok(t) => t,
            Err(_) => continue,
        };
        let manifest: serde_json::Value = serde_json::from_str(&text).unwrap_or_default();
        let id = entry.file_name().to_string_lossy().to_string();
        let main = entry.path().join("main.js");
        out.push(InstalledPlugin {
            name: manifest
                .get("name")
                .and_then(|v| v.as_str())
                .unwrap_or(&id)
                .to_string(),
            version: manifest
                .get("version")
                .and_then(|v| v.as_str())
                .unwrap_or("?")
                .to_string(),
            description: manifest
                .get("description")
                .and_then(|v| v.as_str())
                .unwrap_or("")
                .to_string(),
            author: manifest
                .get("author")
                .and_then(|v| v.as_str())
                .unwrap_or("")
                .to_string(),
            enabled: enabled.iter().any(|e| e == &id),
            has_main: main.exists(),
            bytes: std::fs::metadata(&main).map(|m| m.len()).unwrap_or(0),
            id,
        });
    }
    out.sort_by(|a, b| a.name.cmp(&b.name));
    Ok(out)
}

#[tauri::command]
pub fn set_plugin_enabled(vault_root: &str, id: &str, enabled: bool) -> Result<bool, String> {
    let root = PathBuf::from(vault_root);
    let mut list = enabled_set(&root);
    list.retain(|x| x != id);
    if enabled {
        list.push(id.to_string());
    }
    write_enabled_set(&root, &list)?;
    Ok(enabled)
}

#[tauri::command]
pub fn uninstall_plugin(vault_root: &str, id: &str) -> Result<(), String> {
    let root = PathBuf::from(vault_root);
    let dir = plugins_dir(&root).join(id);
    if dir.exists() {
        std::fs::remove_dir_all(&dir).map_err(|e| e.to_string())?;
    }
    let list: Vec<String> = enabled_set(&root).into_iter().filter(|x| x != id).collect();
    write_enabled_set(&root, &list)
}

/// 列目录（shim 的 vault.adapter / Vault 索引需要；一次性返回直接子项）
#[tauri::command]
pub fn list_dir(vault_root: &str, path: &str) -> Result<Vec<serde_json::Value>, String> {
    let dir = PathBuf::from(vault_root).join(path);
    let entries = match std::fs::read_dir(&dir) {
        Ok(e) => e,
        Err(_) => return Ok(vec![]),
    };
    let mut out = Vec::new();
    for entry in entries.flatten() {
        let meta = match entry.metadata() {
            Ok(m) => m,
            Err(_) => continue,
        };
        let rel = entry
            .path()
            .strip_prefix(vault_root)
            .map(|p| p.to_string_lossy().to_string())
            .unwrap_or_else(|_| entry.path().to_string_lossy().to_string());
        out.push(serde_json::json!({
            "path": rel,
            "is_dir": meta.is_dir(),
            "size": meta.len(),
            "modified": meta.modified().ok()
                .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
                .map(|d| d.as_millis() as u64).unwrap_or(0),
        }));
    }
    Ok(out)
}

/// 建目录（插件创建 folder / 写 data.json 前需要）
#[tauri::command]
pub fn make_dir(vault_root: &str, path: &str) -> Result<(), String> {
    std::fs::create_dir_all(PathBuf::from(vault_root).join(path)).map_err(|e| e.to_string())
}

/// 官方社区插件索引（community-plugins.json）。前端缓存 24h。
#[tauri::command]
pub async fn marketplace_index() -> Result<String, String> {
    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(30))
        .user_agent("NoteForge/0.2")
        .build()
        .map_err(|e| e.to_string())?;
    let res = client.get(MARKET_INDEX).send().await.map_err(|e| e.to_string())?;
    if !res.status().is_success() {
        return Err(format!("HTTP {}", res.status()));
    }
    res.text().await.map_err(|e| e.to_string())
}

/// 从文本里取搜索/展示需要的字段，避免把 2.5MB 的索引整体丢给前端。
#[tauri::command]
pub fn marketplace_search(index_json: &str, query: &str, limit: usize) -> Result<Vec<MarketplaceEntry>, String> {
    let all: Vec<serde_json::Value> = serde_json::from_str(index_json).map_err(|e| e.to_string())?;
    let q = query.trim().to_lowercase();
    let mut out = Vec::new();
    for v in all {
        let id = v.get("id").and_then(|x| x.as_str()).unwrap_or("").to_string();
        let name = v.get("name").and_then(|x| x.as_str()).unwrap_or("").to_string();
        let repo = v.get("repo").and_then(|x| x.as_str()).unwrap_or("").to_string();
        let author = v.get("author").and_then(|x| x.as_str()).unwrap_or("").to_string();
        let description = v.get("description").and_then(|x| x.as_str()).unwrap_or("").to_string();
        if q.is_empty() || id.to_lowercase().contains(&q)
            || name.to_lowercase().contains(&q)
            || description.to_lowercase().contains(&q)
            || author.to_lowercase().contains(&q)
        {
            out.push(MarketplaceEntry { id, name, repo, author, description });
            if out.len() >= limit.max(1) {
                break;
            }
        }
    }
    Ok(out)
}

async fn fetch_bytes(client: &reqwest::Client, url: &str) -> Result<Vec<u8>, String> {
    let res = client.get(url).send().await.map_err(|e| e.to_string())?;
    if !res.status().is_success() {
        return Err(format!("HTTP {}", res.status()));
    }
    res.bytes().await.map(|b| b.to_vec()).map_err(|e| e.to_string())
}

/// 安装插件：把 main.js / manifest.json / styles.css 写进 `.obsidian/plugins/<id>/`。
#[tauri::command]
pub async fn install_plugin(
    vault_root: &str,
    repo: &str,
    id_hint: Option<String>,
) -> Result<InstallReport, String> {
    if repo.trim().is_empty() || !repo.contains('/') {
        return Err(format!("repo 格式无效: {repo}"));
    }
    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(60))
        .user_agent("NoteForge/0.2")
        .build()
        .map_err(|e| e.to_string())?;

    // ① jsDelivr：先默认分支，再试 master/main（探测的默认分支名不一定对）
    // ① jsDelivr：默认分支 → master → main（探测到的默认分支名不一定对）
    let refs: Vec<String> = vec![String::new(), "master".into(), "main".into()];
    // ② GitHub Release 资产（多数头部插件只在这里发 main.js）
    let mut release_files: Vec<(String, Vec<u8>)> = Vec::new();

    let mut manifest_text: Option<String> = None;
    let mut main_bytes: Option<Vec<u8>> = None;
    let mut source = String::new();
    let mut used_ref = String::new();

    for r in &refs {
        let suffix = if r.is_empty() { String::new() } else { format!("@{r}") };
        if manifest_text.is_none() {
            if let Ok(b) = fetch_bytes(&client, &format!("{JSDELIVR}/{repo}{suffix}/manifest.json")).await {
                if let Ok(text) = String::from_utf8(b) {
                    if serde_json::from_str::<serde_json::Value>(&text).is_ok() {
                        manifest_text = Some(text);
                    }
                }
            }
        }
        if main_bytes.is_none() {
            if let Ok(b) = fetch_bytes(&client, &format!("{JSDELIVR}/{repo}{suffix}/main.js")).await {
                if b.len() > 32 {
                    main_bytes = Some(b);
                    used_ref = r.clone();
                    source = format!("jsDelivr{suffix}");
                }
            }
        }
        if main_bytes.is_some() && manifest_text.is_some() {
            break;
        }
    }

    if main_bytes.is_none() || manifest_text.is_none() {
        for proxy in GH_PROXIES {
            let base = format!("{proxy}/https://github.com/{repo}/releases/latest/download");
            let m = fetch_bytes(&client, &format!("{base}/manifest.json")).await;
            let jb = fetch_bytes(&client, &format!("{base}/main.js")).await;
            let (Ok(mt), Ok(j)) = (m, jb) else { continue };
            let Ok(text) = String::from_utf8(mt) else { continue };
            if serde_json::from_str::<serde_json::Value>(&text).is_err() {
                continue;
            }
            manifest_text = Some(text);
            main_bytes = Some(j);
            source = format!("{proxy} (Release)");
            if let Ok(css) = fetch_bytes(&client, &format!("{base}/styles.css")).await {
                release_files.push(("styles.css".into(), css));
            }
            break;
        }
    }

    let main_bytes = main_bytes.ok_or_else(|| {
        "取不到 main.js：该插件可能既未在仓库提交产物，GitHub Release 代理也不可达".to_string()
    })?;
    let manifest_text =
        manifest_text.ok_or_else(|| "取不到 manifest.json（jsDelivr 与 Release 代理都失败）".to_string())?;
    let manifest: serde_json::Value =
        serde_json::from_str(&manifest_text).map_err(|e| format!("manifest 解析失败: {e}"))?;
    let id = id_hint
        .filter(|s| !s.is_empty())
        .or_else(|| manifest.get("id").and_then(|v| v.as_str()).map(String::from))
        .ok_or_else(|| "无法确定插件 id".to_string())?;

    let version = manifest
        .get("version")
        .and_then(|v| v.as_str())
        .unwrap_or("?")
        .to_string();

    let dir = plugins_dir(Path::new(vault_root)).join(&id);
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    let mut files = Vec::new();
    std::fs::write(dir.join("main.js"), &main_bytes).map_err(|e| e.to_string())?;
    files.push("main.js".into());
    std::fs::write(dir.join("manifest.json"), &manifest_text).map_err(|e| e.to_string())?;
    files.push("manifest.json".into());
    for (name, bytes) in release_files {
        std::fs::write(dir.join(&name), bytes).map_err(|e| e.to_string())?;
        files.push(name);
    }
    if !files.iter().any(|f| f == "styles.css") {
        // jsDelivr 路径下补一次样式（Release 路径已在上面取过）
        let suffix = if used_ref.is_empty() {
            String::new()
        } else {
            format!("@{used_ref}")
        };
        if let Ok(css) = fetch_bytes(&client, &format!("{JSDELIVR}/{repo}{suffix}/styles.css")).await {
            if let Ok(text) = String::from_utf8(css) {
                std::fs::write(dir.join("styles.css"), text).map_err(|e| e.to_string())?;
                files.push("styles.css".into());
            }
        }
    }

    // 安装即启用（与 Obsidian 的「安装后默认启用」一致）
    let mut list = enabled_set(Path::new(vault_root));
    if !list.iter().any(|x| x == &id) {
        list.push(id.clone());
        write_enabled_set(Path::new(vault_root), &list)?;
    }

    Ok(InstallReport { id, source, version, files })
}
#[cfg(test)]
mod tests {
    use super::*;

    /// 每个用例独立目录：cargo test 同进程并行跑，只用 pid 会互相清空状态
    /// （这个坑真踩过一次：两个用例互相把对方的启用列表删了）。
    static SEQ: std::sync::atomic::AtomicUsize = std::sync::atomic::AtomicUsize::new(0);

    fn tmp_vault() -> PathBuf {
        let n = SEQ.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
        let dir = std::env::temp_dir().join(format!("nf-plugin-test-{}-{n}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(dir.join(".obsidian")).unwrap();
        dir
    }

    fn fake_plugin(root: &Path, id: &str, version: &str) {
        let dir = root.join(".obsidian").join("plugins").join(id);
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(
            dir.join("manifest.json"),
            format!(
                r#"{{"id":"{id}","name":"Fake {id}","version":"{version}","description":"d","author":"t"}}"#
            ),
        )
        .unwrap();
        std::fs::write(dir.join("main.js"), "module.exports={};// 1234567890").unwrap();
    }

    #[test]
    fn list_plugins_reads_manifest_and_enabled_flag() {
        let root = tmp_vault();
        let root_s = root.to_string_lossy().to_string();
        fake_plugin(&root, "alpha", "1.0.0");
        fake_plugin(&root, "beta", "2.3.4");
        std::fs::write(
            root.join(".obsidian").join("community-plugins.json"),
            r#"["beta"]"#,
        )
        .unwrap();

        let list = list_plugins(&root_s).unwrap();
        assert_eq!(list.len(), 2);
        let beta = list.iter().find(|p| p.id == "beta").unwrap();
        assert_eq!(beta.version, "2.3.4");
        assert!(beta.enabled, "beta 应在启用列表里");
        assert!(beta.has_main);
        assert!(list.iter().find(|p| p.id == "alpha").unwrap().enabled == false);

        // 缺 main.js 的目录要标出来，而不是静默消失
        let empty = root.join(".obsidian").join("plugins").join("gamma");
        std::fs::create_dir_all(&empty).unwrap();
        std::fs::write(empty.join("manifest.json"), r#"{"id":"gamma","name":"G","version":"0"}"#).unwrap();
        let list2 = list_plugins(&root_s).unwrap();
        assert!(!list2.iter().find(|p| p.id == "gamma").unwrap().has_main);
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn enable_disable_and_uninstall_round_trip() {
        let root = tmp_vault();
        let root_s = root.to_string_lossy().to_string();
        fake_plugin(&root, "alpha", "1.0.0");

        assert!(set_plugin_enabled(&root_s, "alpha", true).unwrap());
        assert!(list_plugins(&root_s).unwrap()[0].enabled);
        // 重复启用不应产生重复项
        assert!(set_plugin_enabled(&root_s, "alpha", true).unwrap());
        let raw = std::fs::read_to_string(root.join(".obsidian").join("community-plugins.json")).unwrap();
        assert_eq!(raw.matches("alpha").count(), 1, "启用列表出现重复：{raw}");

        assert!(!set_plugin_enabled(&root_s, "alpha", false).unwrap());
        assert!(!list_plugins(&root_s).unwrap()[0].enabled);

        uninstall_plugin(&root_s, "alpha").unwrap();
        assert!(list_plugins(&root_s).unwrap().is_empty());
        assert!(!root.join(".obsidian").join("plugins").join("alpha").exists());
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn marketplace_search_filters_by_name_id_description() {
        let idx = r#"[
            {"id":"dataview","name":"Dataview","repo":"a/b","author":"x","description":"query your notes"},
            {"id":"obsidian-tasks-plugin","name":"Tasks","repo":"c/d","author":"y","description":"todo"},
            {"id":"quickadd","name":"QuickAdd","repo":"e/f","author":"z","description":"capture anything"}
        ]"#;
        assert_eq!(marketplace_search(idx, "todo", 10).unwrap().len(), 1);
        assert_eq!(marketplace_search(idx, "quick", 10).unwrap()[0].id, "quickadd");
        assert_eq!(marketplace_search(idx, "query", 10).unwrap()[0].id, "dataview");
        assert_eq!(marketplace_search(idx, "作者", 10).unwrap().len(), 0);
        assert_eq!(marketplace_search(idx, "", 2).unwrap().len(), 2, "空查询应返回前 N 条");
    }

    /// 真实网络测试：验证「从官方市场安装插件」这条路真的能走通。
    /// 设 NOTEFORGE_NET_TESTS=1 才跑（默认跳过，保持 cargo test 离线可用）。
    #[tokio::test]
    async fn install_plugin_from_market() {
        if std::env::var("NOTEFORGE_NET_TESTS").is_err() {
            eprintln!("跳过网络测试（设 NOTEFORGE_NET_TESTS=1 运行）");
            return;
        }
        let root = tmp_vault();
        let root_s = root.to_string_lossy().to_string();
        // obsidian-hider 体积小、产物提交在仓库里，适合当安装用例
        let rep = install_plugin(&root_s, "kepano/obsidian-hider", Some("obsidian-hider".into()))
            .await
            .expect("安装应成功");
        assert_eq!(rep.id, "obsidian-hider");
        assert!(rep.files.contains(&"main.js".to_string()));
        let dir = root.join(".obsidian").join("plugins").join("obsidian-hider");
        assert!(dir.join("main.js").exists());
        assert!(dir.join("manifest.json").exists());
        // 安装即启用
        assert!(list_plugins(&root_s).unwrap()[0].enabled);
        let _ = std::fs::remove_dir_all(&root);
    }
}
