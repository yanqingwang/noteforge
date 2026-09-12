//! Ignore rules for the vault mirror (glob-style, no external deps).

use std::path::Path;

#[derive(Debug, Clone)]
pub struct IgnoreRules {
    patterns: Vec<String>,
}

pub const DEFAULT_PATTERNS: &[&str] = &[
    ".noteforge/",
    ".obsidian/",
    ".git/",
    ".trash/",
    "node_modules/",
    "*.tmp",
    "*.part",
    "*.crdownload",
    ".DS_Store",
    "Thumbs.db",
    "desktop.ini",
];

impl IgnoreRules {
    pub fn new(extra: &[String]) -> Self {
        let mut patterns: Vec<String> = DEFAULT_PATTERNS.iter().map(|s| s.to_string()).collect();
        for p in extra {
            let p = p.trim();
            if !p.is_empty() && !patterns.iter().any(|x| x == p) {
                patterns.push(p.to_string());
            }
        }
        IgnoreRules { patterns }
    }

    /// Should this relative path be excluded from syncing?
    pub fn ignored(&self, rel_path: &str) -> bool {
        let normalized = rel_path.trim_start_matches('/');
        // System files written by the sync engine itself are always excluded.
        if normalized == crate::mirror::META_NAME {
            return true;
        }
        for pat in &self.patterns {
            if matches_pattern(pat, normalized) {
                return true;
            }
        }
        false
    }
}

/// `dir/` pattern → any path under that directory (at any depth);
/// pattern without `/` → match against the file name;
/// pattern with `/` → match against the whole relative path.
/// `*` matches within one segment; `**` matches across segments.
fn matches_pattern(pattern: &str, path: &str) -> bool {
    if let Some(dir) = pattern.strip_suffix('/') {
        let dir = dir.trim_start_matches('/');
        // Match anything inside that directory, at any depth.
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
                // `**` — match anything (including '/')
                let rest = if p.len() >= 3 && p[2] == b'/' { &p[3..] } else { &p[2..] };
                for i in 0..=t.len() {
                    if glob_inner(rest, &t[i..]) {
                        return true;
                    }
                }
                false
            } else {
                // `*` — match within the current segment
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

    fn rules(extra: &[&str]) -> IgnoreRules {
        let v: Vec<String> = extra.iter().map(|s| s.to_string()).collect();
        IgnoreRules::new(&v)
    }

    #[test]
    fn default_dirs_ignored() {
        let r = rules(&[]);
        assert!(r.ignored(".noteforge/sync-state.json"));
        assert!(r.ignored(".obsidian/app.json"));
        assert!(r.ignored("sub/.obsidian/x"));
        assert!(r.ignored("notes/a.md") == false);
        assert!(r.ignored("a.tmp"));
        assert!(!r.ignored("a.md"));
    }

    #[test]
    fn custom_rules() {
        let r = rules(&["secret/**", "*.pdf"]);
        assert!(r.ignored("secret/a.md"));
        assert!(r.ignored("secret/x/y.md"));
        assert!(r.ignored("docs/report.pdf"));
        assert!(!r.ignored("docs/report.md"));
    }

    #[test]
    fn star_does_not_cross_slash() {
        let r = rules(&["build/*"]);
        assert!(r.ignored("build/out.js"));
        assert!(!r.ignored("build/sub/out.js"));
    }

    #[test]
    fn meta_always_ignored() {
        let r = rules(&[]);
        assert!(r.ignored("nf-sync-meta.json"));
    }
}
