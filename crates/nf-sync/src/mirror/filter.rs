//! Sync filter: decides which vault-relative paths are synced.
//!
//! Layers (first match wins):
//! 1. Permanent hard exclusions — `.noteforge/`, `.git/`, `.trash/`,
//!    `node_modules/`, the sync meta file, OS junk (`*.tmp`, `.DS_Store`…).
//! 2. `.obsidian` config-folder allowlist (only when `sync_config_folder`
//!    is on; plugins/ and workspace state are NEVER synced).
//! 3. Name toggles — hidden files, dotfolders, underscore files/folders.
//! 4. User folder lists — `excluded_folders` (blacklist, wins),
//!    `sync_only_folders` (whitelist; empty = whole vault).
//! 5. `excluded_extensions` (lowercase, no dot, compound like `tar.gz`).
//! 6. Extra glob patterns (legacy `ignore_rules`).

use std::path::Path;

/// Directory names excluded at any depth, regardless of toggles.
const HARD_DIRS: &[&str] = &[".noteforge", ".git", ".trash", "node_modules"];

/// File junk patterns excluded regardless of toggles.
const HARD_FILE_PATTERNS: &[&str] = &[
    "*.tmp",
    "*.part",
    "*.crdownload",
    "*.nf-sync-tmp",
    ".DS_Store",
    "Thumbs.db",
    "desktop.ini",
];

/// `.obsidian` files synced under the "bookmarks" category.
const CONFIG_BOOKMARKS: &[&str] = &["bookmarks.json"];

/// `.obsidian` files synced under the "others" category (fixed allowlist;
/// `plugins/` and `workspace*` are intentionally absent — never synced).
const CONFIG_OTHERS_FILES: &[&str] = &[
    "appearance.json",
    "app.json",
    "hotkeys.json",
    "core-plugins.json",
    "core-plugins-migration.json",
    "community-plugins.json",
    "types.json",
];
const CONFIG_OTHERS_DIRS: &[&str] = &["themes", "snippets"];

#[derive(Debug, Clone, Default)]
pub struct SyncFilter {
    /// Legacy glob ignore rules (from config `ignore_rules`).
    pub extra_patterns: Vec<String>,
    /// Lowercase extensions without leading dot; compound allowed (`tar.gz`).
    pub excluded_extensions: Vec<String>,
    /// Vault-relative folder paths never synced (prefix match at boundary).
    pub excluded_folders: Vec<String>,
    /// When non-empty, ONLY these vault-relative folders sync.
    pub sync_only_folders: Vec<String>,
    /// Hide `.*` files (default ON in yanc).
    pub exclude_hidden_files: bool,
    /// Hide `.*` folders and everything beneath (default ON in yanc).
    pub exclude_dot_folders: bool,
    /// Hide `_*` files (default OFF).
    pub exclude_underscore_files: bool,
    /// Hide `_*` folders and everything beneath (default OFF).
    pub exclude_underscore_folders: bool,
    /// Lazy-sync attachments: record remote identity, download on demand.
    pub lazy_sync_attachments: bool,
    /// Plain folder name (any depth) or vault-relative path (contains `/`).
    pub lazy_attachment_folders: Vec<String>,
    /// Master switch for `.obsidian` config sync.
    pub sync_config_folder: bool,
    pub config_sync_bookmarks: bool,
    pub config_sync_others: bool,
    /// Absolute file-size cap in MB; 0 = unlimited (yanc `maxFileSizeMB`).
    pub max_file_size_mb: u64,
}

impl SyncFilter {
    /// Backwards-compatible default: same behaviour as the old
    /// `IgnoreRules::new(extra)` — hidden/dot content excluded.
    pub fn new(extra: &[String]) -> Self {
        SyncFilter {
            extra_patterns: extra.iter().map(|s| s.trim().to_string()).filter(|s| !s.is_empty()).collect(),
            exclude_hidden_files: true,
            exclude_dot_folders: true,
            ..Default::default()
        }
    }

    fn segments(path: &str) -> impl Iterator<Item = &str> {
        path.split('/').filter(|s| !s.is_empty())
    }

    /// Files above the configured size cap are skipped in both directions.
    pub fn too_large(&self, size_bytes: u64) -> bool {
        self.max_file_size_mb > 0 && size_bytes > self.max_file_size_mb * 1024 * 1024
    }

    fn basename(path: &str) -> &str {
        path.rsplit('/').next().unwrap_or(path)
    }

    /// All directory segments of a path (everything before the basename).
    fn dir_segments(path: &str) -> Vec<&str> {
        match path.rfind('/') {
            Some(i) => path[..i].split('/').filter(|s| !s.is_empty()).collect(),
            None => Vec::new(),
        }
    }

    /// Is `path` at or under folder `folder` (boundary match)?
    fn under_folder(path: &str, folder: &str) -> bool {
        let folder = folder.trim_matches('/');
        if folder.is_empty() {
            return false;
        }
        path == folder || path.starts_with(&format!("{}/", folder))
    }

    /// `.obsidian` allowlist check. Only consulted when the master switch is on.
    fn config_allowed(&self, path: &str) -> bool {
        let Some(rest) = path.strip_prefix(".obsidian/") else { return false };
        if rest.is_empty() || rest.contains("//") {
            return false;
        }
        // Never sync plugins or workspace state, whatever the categories say.
        if rest.starts_with("plugins/") || rest.starts_with("workspace") {
            return false;
        }
        if self.config_sync_bookmarks && CONFIG_BOOKMARKS.contains(&rest) {
            return true;
        }
        if self.config_sync_others {
            if CONFIG_OTHERS_FILES.contains(&rest) {
                return true;
            }
            if CONFIG_OTHERS_DIRS.iter().any(|d| Self::under_folder(rest, d)) {
                return true;
            }
        }
        false
    }

    /// Full exclusion check for a vault-relative file path.
    pub fn ignored(&self, rel_path: &str) -> bool {
        self.ignored_inner(rel_path, true)
    }

    /// Same as `ignored` but with the extension layer disabled — used by the
    /// remote purge pass to find files excluded *only* by extension.
    pub fn ignored_without_extensions(&self, rel_path: &str) -> bool {
        self.ignored_inner(rel_path, false)
    }

    fn ignored_inner(&self, rel_path: &str, with_extensions: bool) -> bool {
        let path = rel_path.trim_start_matches('/');
        if path.is_empty() {
            return true;
        }
        // 1. meta file + hard dirs
        if path == crate::mirror::META_NAME {
            return true;
        }
        if Self::segments(path).any(|s| HARD_DIRS.contains(&s)) {
            return true;
        }
        // 2. .obsidian allowlist wins over the dotfolder toggle.
        if self.sync_config_folder && path.starts_with(".obsidian/") && self.config_allowed(path) {
            return false;
        }
        let name = Self::basename(path);
        let dir_segments: Vec<&str> = Self::dir_segments(path);
        // 3. name toggles
        if self.exclude_hidden_files && name.starts_with('.') {
            return true;
        }
        if self.exclude_dot_folders && dir_segments.iter().any(|s| s.starts_with('.')) {
            return true;
        }
        if self.exclude_underscore_files && name.starts_with('_') {
            return true;
        }
        if self.exclude_underscore_folders && dir_segments.iter().any(|s| s.starts_with('_')) {
            return true;
        }
        // 4. folder black/white lists
        if self.excluded_folders.iter().any(|f| Self::under_folder(path, f)) {
            return true;
        }
        if !self.sync_only_folders.is_empty()
            && !self.sync_only_folders.iter().any(|f| Self::under_folder(path, f))
        {
            return true;
        }
        // 5. extensions (case-insensitive, compound suffixes included)
        if with_extensions && !self.excluded_extensions.is_empty() {
            let lower = name.to_lowercase();
            if self
                .excluded_extensions
                .iter()
                .any(|ext| !ext.is_empty() && lower.ends_with(&format!(".{}", ext.to_lowercase())))
            {
                return true;
            }
        }
        // 6. extra glob patterns (legacy semantics)
        for pat in &self.extra_patterns {
            if matches_pattern(pat, path) {
                return true;
            }
        }
        for pat in HARD_FILE_PATTERNS {
            if glob_match(pat, name) {
                return true;
            }
        }
        false
    }

    /// Should the walker prune this directory (skip its whole subtree)?
    pub fn prune_dir(&self, rel_path: &str) -> bool {
        let path = rel_path.trim_matches('/');
        if path.is_empty() {
            return false;
        }
        let name = Self::basename(path);
        if HARD_DIRS.contains(&name) {
            return true;
        }
        // Keep `.obsidian` when config sync might allow content beneath it.
        if name == ".obsidian" && self.sync_config_folder {
            return false;
        }
        if self.exclude_dot_folders && name.starts_with('.') {
            return true;
        }
        if self.exclude_underscore_folders && name.starts_with('_') {
            return true;
        }
        if self.excluded_folders.iter().any(|f| Self::under_folder(path, f)) {
            return true;
        }
        // Whitelist mode: prune dirs that can hold no whitelisted content.
        if !self.sync_only_folders.is_empty() {
            let could_contain = self.sync_only_folders.iter().any(|f| {
                let f = f.trim_matches('/');
                Self::under_folder(path, f) || f.starts_with(&format!("{}/", path)) || f == path
            });
            if !could_contain {
                return true;
            }
        }
        false
    }

    /// Is this path inside a lazy-sync attachment folder?
    pub fn is_lazy_attachment(&self, rel_path: &str) -> bool {
        if !self.lazy_sync_attachments {
            return false;
        }
        let path = rel_path.trim_start_matches('/');
        self.lazy_attachment_folders.iter().any(|spec| {
            let spec = spec.trim().trim_matches('/');
            if spec.is_empty() {
                return false;
            }
            if spec.contains('/') {
                // Vault-relative path: only that directory.
                Self::under_folder(path, spec)
            } else {
                // Plain folder name: that directory name at any depth.
                Self::dir_segments(path).iter().any(|s| *s == spec)
            }
        })
    }
}

/// `dir/` pattern → any path under that directory (at any depth);
/// pattern without `/` → match against the file name;
/// pattern with `/` → match against the whole relative path.
/// `*` matches within one segment; `**` matches across segments.
fn matches_pattern(pattern: &str, path: &str) -> bool {
    if let Some(dir) = pattern.strip_suffix('/') {
        let dir = dir.trim_start_matches('/');
        return path.split('/').any(|segment| segment == dir);
    }
    let name = Path::new(path).file_name().map(|s| s.to_string_lossy().to_string()).unwrap_or_default();
    if !pattern.contains('/') {
        return glob_match(pattern, &name);
    }
    glob_match(pattern.trim_start_matches('/'), path)
}

fn glob_match(pattern: &str, text: &str) -> bool {
    glob_inner(pattern.as_bytes(), text.as_bytes())
}

fn glob_inner(p: &[u8], t: &[u8]) -> bool {
    if p.is_empty() {
        return t.is_empty();
    }
    match p[0] {
        b'*' => {
            if p.len() >= 2 && p[1] == b'*' {
                let rest = if p.len() >= 3 && p[2] == b'/' { &p[3..] } else { &p[2..] };
                for i in 0..=t.len() {
                    if glob_inner(rest, &t[i..]) {
                        return true;
                    }
                }
                false
            } else {
                for i in 0..=t.len() {
                    if glob_inner(&p[1..], &t[i..]) {
                        return true;
                    }
                    if i < t.len() && t[i] == b'/' {
                        break;
                    }
                }
                false
            }
        }
        b'?' => !t.is_empty() && t[0] != b'/' && glob_inner(&p[1..], &t[1..]),
        c => !t.is_empty() && t[0] == c && glob_inner(&p[1..], &t[1..]),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn filter(extra: &[&str]) -> SyncFilter {
        let v: Vec<String> = extra.iter().map(|s| s.to_string()).collect();
        SyncFilter::new(&v)
    }

    #[test]
    fn defaults_exclude_dots_and_junk() {
        let f = filter(&[]);
        assert!(f.ignored(".noteforge/sync-state.json"));
        assert!(f.ignored(".obsidian/app.json"));
        assert!(f.ignored("sub/.obsidian/x"));
        assert!(f.ignored(".env"));
        assert!(f.ignored("sub/.gitignore"));
        assert!(f.ignored("a.tmp"));
        assert!(f.ignored("notes/a.nf-sync-tmp"), "engine temp files never sync");
        assert!(f.ignored(".DS_Store"));
        assert!(!f.ignored("notes/a.md"));
    }

    #[test]
    fn dot_toggles_can_be_disabled() {
        let mut f = filter(&[]);
        f.exclude_dot_folders = false;
        f.exclude_hidden_files = false;
        assert!(!f.ignored(".obsidian/app.json"));
        assert!(!f.ignored(".env"));
        // Hard exclusions still hold.
        assert!(f.ignored(".git/HEAD"));
        assert!(f.ignored(".noteforge/x"));
    }

    #[test]
    fn underscore_toggles() {
        let mut f = filter(&[]);
        assert!(!f.ignored("_draft.md"));
        f.exclude_underscore_files = true;
        assert!(f.ignored("_draft.md"));
        f.exclude_underscore_folders = true;
        assert!(f.ignored("_inbox/a.md"));
        assert!(!f.ignored("inbox/a.md"));
    }

    #[test]
    fn excluded_extensions_compound() {
        let mut f = filter(&[]);
        f.excluded_extensions = vec!["exe".into(), "tar.gz".into()];
        assert!(f.ignored("setup.EXE"));
        assert!(f.ignored("backup.tar.gz"));
        assert!(!f.ignored("backup.gz"));
        assert!(!f.ignored("notes.md"));
        // ignored_without_extensions re-enables them for the purge pass.
        assert!(!f.ignored_without_extensions("setup.EXE"));
    }

    #[test]
    fn folder_blacklist_and_whitelist() {
        let mut f = filter(&[]);
        f.excluded_folders = vec!["archive".into(), "docs/private".into()];
        assert!(f.ignored("archive/a.md"));
        assert!(f.ignored("archive/sub/b.md"));
        assert!(f.ignored("docs/private/c.md"));
        assert!(!f.ignored("archived/a.md")); // boundary match
        assert!(!f.ignored("docs/public/c.md"));

        // Whitelist: only listed folders sync; blacklist still wins.
        f.sync_only_folders = vec!["notes".into(), "archive".into()];
        assert!(!f.ignored("notes/a.md"));
        assert!(f.ignored("archive/a.md")); // blacklist precedence
        assert!(f.ignored("other/a.md"));
    }

    #[test]
    fn whitelist_dir_pruning_keeps_parents() {
        let mut f = filter(&[]);
        f.sync_only_folders = vec!["docs/deep".into()];
        assert!(f.prune_dir("other"));
        assert!(!f.prune_dir("docs")); // parent of whitelisted
        assert!(!f.prune_dir("docs/deep"));
        assert!(!f.prune_dir("docs/deep/sub"));
        assert!(f.prune_dir("docs/sibling"));
    }

    #[test]
    fn config_folder_allowlist() {
        let mut f = filter(&[]);
        f.sync_config_folder = true;
        f.config_sync_bookmarks = true;
        f.config_sync_others = true;
        assert!(!f.ignored(".obsidian/bookmarks.json"));
        assert!(!f.ignored(".obsidian/app.json"));
        assert!(!f.ignored(".obsidian/themes/x/theme.css"));
        assert!(!f.ignored(".obsidian/snippets/a.css"));
        assert!(f.ignored(".obsidian/plugins/yanc/main.js")); // never
        assert!(f.ignored(".obsidian/workspace.json")); // never
        assert!(f.ignored(".obsidian/graph.json")); // not allowlisted
        // Master off → dotfolder rule applies.
        f.sync_config_folder = false;
        assert!(f.ignored(".obsidian/app.json"));
    }

    #[test]
    fn lazy_attachment_specs() {
        let mut f = filter(&[]);
        assert!(!f.is_lazy_attachment("files/a.png"));
        f.lazy_sync_attachments = true;
        f.lazy_attachment_folders = vec!["files".into(), "assets/img".into()];
        assert!(f.is_lazy_attachment("files/a.png"));
        assert!(f.is_lazy_attachment("notes/files/a.png")); // any depth
        assert!(f.is_lazy_attachment("assets/img/a.png"));
        assert!(!f.is_lazy_attachment("notes/assets/img/a.png")); // vault-relative
        assert!(!f.is_lazy_attachment("notes/a.png"));
        assert!(!f.is_lazy_attachment("myfiles/a.png"));
    }

    #[test]
    fn extra_glob_patterns_still_work() {
        let f = filter(&["secret/**", "*.pdf", "build/*"]);
        assert!(f.ignored("secret/a.md"));
        assert!(f.ignored("docs/report.pdf"));
        assert!(f.ignored("build/x"));
        assert!(!f.ignored("build/x/y")); // * does not cross /
        assert!(!f.ignored("docs/report.md"));
    }
}
