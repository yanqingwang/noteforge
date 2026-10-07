//! Bases 元数据索引：一次遍历 vault，产出 Bases 查询引擎（以及插件
//! `metadataCache`）需要的全部结构化信息。
//!
//! 为什么单独一个命令：Bases 要对**整个 vault** 求值（没写 filters 时就是所有文件），
//! 逐文件走 IPC 读几千次在 webview 里要几十秒。Rust 侧一次走完，返回一个紧凑 JSON。
//!
//! frontmatter 只回**原始 YAML 文本**，不在这里解析：nf-markdown 自带的
//! `extract_frontmatter` 是逐行 key-value 解析（注释里写明 "not full YAML"），
//! 所有值都变成 String，Bases 的数值/日期比较会全废。前端用 `yaml` 包真解析。

use serde::Serialize;
use std::collections::HashMap;
use std::path::Path;

/// 只对这些扩展名解析正文（frontmatter / 链接 / 标签 / 标题）。
/// 与 Obsidian 一致：note properties 只对 Markdown 系文件可用。
const TEXT_EXTS: &[&str] = &["md", "markdown", "mdx", "html", "htm", "txt"];

#[derive(Serialize, Clone)]
pub struct MetaLink {
    /// 链接原文里的目标（未解析，可能是文件名、路径后缀或 URL）
    pub target: String,
    /// 解析到的 vault 内路径；解析不到时为 null
    pub path: Option<String>,
    pub display: Option<String>,
    pub subpath: Option<String>,
}

#[derive(Serialize, Clone)]
pub struct MetaHeading {
    pub level: u8,
    pub text: String,
}

#[derive(Serialize, Clone)]
pub struct MetaFileEntry {
    pub path: String,
    pub ext: String,
    pub size: u64,
    pub mtime_ms: u64,
    /// 创建时间。Linux ext4 常拿不到 birth time，这时退回 mtime。
    pub ctime_ms: u64,
    /// 原始 frontmatter YAML 文本（不含 --- 分隔符）
    pub frontmatter: Option<String>,
    /// 行内标签（`#tag`，已去掉 `#`）
    pub tags: Vec<String>,
    pub links: Vec<MetaLink>,
    pub embeds: Vec<MetaLink>,
    pub headings: Vec<MetaHeading>,
}

#[derive(Serialize)]
pub struct MetaIndex {
    pub files: Vec<MetaFileEntry>,
    /// 目标路径 → 指向它的文件路径列表
    pub backlinks: HashMap<String, Vec<String>>,
    pub scanned: usize,
    pub skipped: usize,
}

/// 从正文开头切出 frontmatter 原文。返回 None 表示没有 frontmatter。
///
/// 判定规则与 Obsidian 一致：`---` 开头行，逐行找结束 `---` 或 `...`。
fn split_frontmatter(text: &str) -> Option<String> {
    let rest = text.strip_prefix('\u{feff}').unwrap_or(text);
    let rest = if rest.starts_with("\r\n") { &rest[2..] } else { rest.strip_prefix('\n').unwrap_or(rest) };
    let first = rest.lines().next()?;
    if first.trim_end() != "---" {
        return None;
    }
    let mut out = String::new();
    let mut lines = rest.lines().skip(1);
    while let Some(line) = lines.next() {
        let t = line.trim_end();
        if t == "---" || t == "..." {
            return Some(out);
        }
        out.push_str(line);
        out.push('\n');
    }
    None
}

/// 扩展名（小写，不含点）。没有点时返回空串。
fn ext_of(path: &str) -> String {
    let name = path.rsplit('/').next().unwrap_or(path);
    match name.rfind('.') {
        Some(i) if i > 0 => name[i + 1..].to_lowercase(),
        _ => String::new(),
    }
}

fn basename_of(path: &str) -> &str {
    let name = path.rsplit('/').next().unwrap_or(path);
    match name.rfind('.') {
        Some(i) if i > 0 => &name[..i],
        _ => name,
    }
}

fn strip_ext(path: &str) -> String {
    match path.rfind('.') {
        Some(i) if !path[i..].contains('/') => path[..i].to_lowercase(),
        _ => path.to_lowercase(),
    }
}

/// 链接解析器：按 Obsidian 的优先级把 `[[target]]` 落到 vault 内路径上。
///
/// 优先级（与前端 `resolveWikilink` 一致，改一处必须改两处）：
/// 1) 完整路径（含补 .md/.html） 2) 路径后缀（多命中取层级最浅）
/// 3) 文件名（忽略大小写与扩展名） 4) 唯一模糊包含
struct LinkResolver {
    /// 小写路径 → 真实路径
    by_path: HashMap<String, String>,
    /// 小写 basename → 真实路径列表
    by_basename: HashMap<String, Vec<String>>,
    /// 小写路径 → 真实路径（用于模糊匹配）
    all_lower: Vec<String>,
}

impl LinkResolver {
    fn new(files: &[FileEntryLite]) -> Self {
        let mut by_path = HashMap::new();
        let mut by_basename: HashMap<String, Vec<String>> = HashMap::new();
        let mut all_lower = Vec::new();
        for f in files {
            let p = f.path.to_lowercase();
            by_path.entry(p.clone()).or_insert_with(|| f.path.clone());
            by_basename
                .entry(basename_of(&f.path).to_lowercase())
                .or_default()
                .push(f.path.clone());
            all_lower.push(p);
        }
        Self { by_path, by_basename, all_lower }
    }

    fn resolve(&self, target: &str) -> Option<String> {
        if target.is_empty() || target.contains("://") {
            return None;
        }
        let t = target.to_lowercase();
        let t_noext = strip_ext(target);
        // 1) 完整路径
        for cand in [t.clone(), format!("{t}.md"), format!("{t}.html")] {
            if let Some(p) = self.by_path.get(&cand) {
                return Some(p.clone());
            }
        }
        // 2) 路径后缀
        let mut suffix: Vec<&String> = self
            .all_lower
            .iter()
            .filter(|p| {
                p.ends_with(&format!("/{t}"))
                    || p.ends_with(&format!("/{t}.md"))
                    || self
                        .by_path
                        .get(*p)
                        .map(|real| strip_ext(real).ends_with(&format!("/{t_noext}")))
                        .unwrap_or(false)
            })
            .collect();
        if suffix.len() > 1 {
            suffix.sort_by_key(|p| (p.split('/').count(), p.to_string()));
        }
        if let Some(first) = suffix.first() {
            return self.by_path.get(*first).cloned();
        }
        // 3) basename（忽略大小写与扩展名）
        if let Some(list) = self.by_basename.get(&t_noext) {
            if let Some(best) = list
                .iter()
                .min_by_key(|p| (p.split('/').count(), p.to_string()))
            {
                return Some(best.clone());
            }
        }
        // 4) 唯一模糊包含
        let mut fuzzy = self.all_lower.iter().filter(|p| p.contains(&t));
        if let (Some(only), None) = (fuzzy.next(), fuzzy.next()) {
            return self.by_path.get(only).cloned();
        }
        None
    }
}

struct FileEntryLite {
    path: String,
}

/// 走一遍 vault，产出索引。`files` 是已经列好的文件清单（复用前端那份文件树）。
#[tauri::command]
pub fn index_metadata(
    files: Vec<String>,
    root: String,
    state: tauri::State<'_, super::AppState>,
) -> Result<MetaIndex, String> {
    // 与其它命令一致：确保打开的就是这个 vault（否则前端传错 root 会静默读到空索引）
    state.ensure_open(&root)?;
    let entries: Vec<FileEntryLite> = files.into_iter().map(|path| FileEntryLite { path }).collect();
    let resolver = LinkResolver::new(&entries);
    let root_path = Path::new(&root);

    let mut out: Vec<MetaFileEntry> = Vec::with_capacity(entries.len());
    let mut backlinks: HashMap<String, Vec<String>> = HashMap::new();
    let mut scanned = 0usize;
    let mut skipped = 0usize;

    for e in &entries {
        let ext = ext_of(&e.path);
        let abs = root_path.join(&e.path);
        let (size, mtime_ms, ctime_ms) = match std::fs::metadata(&abs) {
            Ok(md) => {
                let mtime = md
                    .modified()
                    .ok()
                    .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
                    .map(|d| d.as_millis() as u64)
                    .unwrap_or(0);
                // Linux ext4 一般拿不到 birth time，退回 mtime（Obsidian 的 file.ctime）
                let ctime = md
                    .created()
                    .ok()
                    .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
                    .map(|d| d.as_millis() as u64)
                    .unwrap_or(mtime);
                (md.len(), mtime, ctime)
            }
            Err(_) => (0, 0, 0),
        };

        let mut frontmatter = None;
        let mut tags: Vec<String> = Vec::new();
        let mut links: Vec<MetaLink> = Vec::new();
        let mut embeds: Vec<MetaLink> = Vec::new();
        let mut headings: Vec<MetaHeading> = Vec::new();

        if TEXT_EXTS.contains(&ext.as_str()) {
            match std::fs::read(&abs) {
                Ok(bytes) => {
                    scanned += 1;
                    let text = String::from_utf8_lossy(&bytes);
                    frontmatter = split_frontmatter(&text);
                    let meta = nf_markdown::parse_to_meta(&e.path, &bytes);
                    tags = meta
                        .tags_inline
                        .iter()
                        .map(|t| t.tag.trim_start_matches('#').to_string())
                        .filter(|t| !t.is_empty())
                        .collect();
                    // 链接：正文里的 [[...]]。nf-markdown 把 embed 也按 wikilink 抽（kind 恒为
                    // Wikilink），靠 span 前面那个字符区分 —— span 是相对**全文**的偏移。
                    for l in &meta.links_out {
                        let is_embed = l.span.start > 0
                            && text.as_bytes().get(l.span.start - 1) == Some(&b'!');
                        let resolved = resolver.resolve(&l.target);
                        let ml = MetaLink {
                            target: l.target.clone(),
                            path: resolved.clone(),
                            display: l.display.clone(),
                            subpath: l.subpath.clone(),
                        };
                        if is_embed {
                            embeds.push(ml);
                        } else {
                            links.push(ml);
                        }
                        if let Some(p) = resolved {
                            backlinks.entry(p).or_default().push(e.path.clone());
                        }
                    }
                    headings = meta
                        .headings
                        .iter()
                        .map(|h| MetaHeading { level: h.level, text: h.text.clone() })
                        .collect();
                }
                Err(_) => skipped += 1,
            }
        } else {
            skipped += 1;
        }

        out.push(MetaFileEntry {
            path: e.path.clone(),
            ext,
            size,
            mtime_ms,
            ctime_ms,
            frontmatter,
            tags,
            links,
            embeds,
            headings,
        });
    }

    for v in backlinks.values_mut() {
        v.sort();
        v.dedup();
    }
    Ok(MetaIndex { files: out, backlinks, scanned, skipped })
}
#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn split_frontmatter_basic() {
        let text = "---\ntitle: A\ntags: [x, y]\n---\nbody\n";
        let fm = split_frontmatter(text).expect("应有 frontmatter");
        assert_eq!(fm, "title: A\ntags: [x, y]\n");
    }

    #[test]
    fn split_frontmatter_none_when_absent() {
        assert!(split_frontmatter("# 标题\n正文").is_none());
        // 只有开头 --- 没有结束符 → 不是 frontmatter
        assert!(split_frontmatter("---\ntitle: A\n正文").is_none());
    }

    #[test]
    fn split_frontmatter_handles_crlf_and_bom() {
        // BOM + CRLF 也要认；行尾统一归一成 \n（str::lines 会吃掉 \r，YAML 两种都吃）
        let text = "\u{feff}---\r\ntitle: A\r\n---\r\nbody";
        assert_eq!(split_frontmatter(text).as_deref(), Some("title: A\n"));
    }

    #[test]
    fn ext_and_basename() {
        assert_eq!(ext_of("a/b/note.md"), "md");
        assert_eq!(ext_of("a/b/note.MDX"), "mdx");
        assert_eq!(ext_of("a/b/noext"), "");
        // 点开头的隐藏文件不算扩展名
        assert_eq!(ext_of(".obsidian"), "");
        assert_eq!(basename_of("a/b/my.note.md"), "my.note");
    }

    fn resolver(paths: &[&str]) -> LinkResolver {
        let entries: Vec<FileEntryLite> = paths
            .iter()
            .map(|p| FileEntryLite { path: p.to_string() })
            .collect();
        LinkResolver::new(&entries)
    }

    #[test]
    fn resolve_full_path_and_basename() {
        let r = resolver(&["notes/a.md", "notes/deep/b.md"]);
        assert_eq!(r.resolve("notes/a.md").as_deref(), Some("notes/a.md"));
        // 补 .md
        assert_eq!(r.resolve("notes/a").as_deref(), Some("notes/a.md"));
        // 文件名（忽略大小写）
        assert_eq!(r.resolve("B").as_deref(), Some("notes/deep/b.md"));
        // 路径后缀
        assert_eq!(r.resolve("deep/b").as_deref(), Some("notes/deep/b.md"));
    }

    #[test]
    fn resolve_shallowest_on_ambiguity() {
        let r = resolver(&["x/deep/dup.md", "dup.md"]);
        assert_eq!(r.resolve("dup").as_deref(), Some("dup.md"));
    }

    #[test]
    fn resolve_rejects_url_and_missing() {
        let r = resolver(&["a.md"]);
        assert_eq!(r.resolve("https://obsidian.md"), None);
        assert_eq!(r.resolve("nope"), None);
    }
}
