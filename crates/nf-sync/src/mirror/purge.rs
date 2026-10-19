//! Remote purge of excluded file types (yanc `purgeExcludedExtensionsRemote`).
//!
//! By default an excluded file type is simply skipped — copies already on
//! the server stay there and drift between clients. When the user turns
//! purge ON, those server-side copies are deleted during sync.
//!
//! The candidate list is derived from a REAL full remote listing, never
//! from a cached/short-circuited one: otherwise a stale remote tree would
//! hide (or invent) files and the purge would silently do the wrong thing.

use crate::file_api::FileEntry;
use crate::mirror::filter::SyncFilter;

/// Remote paths that are excluded *only* by the extension rule, and would
/// therefore be deleted when purge is enabled.
///
/// A path is a candidate when the extension layer alone excludes it:
/// `ignored(path)` is true yet `ignored_without_extensions(path)` is false.
/// Anything excluded by a folder/name/glob rule is NOT purged (the user
/// never asked for those to be removed from the server).
pub fn purge_candidates(entries: &[FileEntry], filter: &SyncFilter) -> Vec<String> {
    entries
        .iter()
        .filter(|e| !e.is_dir)
        .filter(|e| filter.ignored(&e.path) && !filter.ignored_without_extensions(&e.path))
        .map(|e| e.path.clone())
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::file_api::FileEntry;

    fn entry(path: &str) -> FileEntry {
        FileEntry {
            path: path.to_string(),
            is_dir: false,
            size: 1,
            updated_time: 0,
            etag: Some("e".into()),
        }
    }

    fn filter() -> SyncFilter {
        let mut f = SyncFilter::new(&[]);
        f.excluded_extensions = vec!["exe".into(), "tar.gz".into()];
        f.excluded_folders = vec!["archive".into()];
        f
    }

    #[test]
    fn picks_only_extension_excluded_files() {
        let entries = vec![
            entry("notes/a.md"),
            entry("setup.exe"),
            entry("backup.tar.gz"),
            entry("archive/old.md"), // folder rule, not purged
            entry("secret/.hidden"), // dot rule, not purged
        ];
        let c = purge_candidates(&entries, &filter());
        assert_eq!(c, vec!["setup.exe".to_string(), "backup.tar.gz".to_string()]);
    }

    #[test]
    fn nothing_to_purge_when_no_excluded_types() {
        let entries = vec![entry("a.exe")];
        assert!(purge_candidates(&entries, &SyncFilter::new(&[])).is_empty());
    }

    #[test]
    fn directories_are_never_candidates() {
        let mut dir = entry("tools.exe");
        dir.is_dir = true;
        assert!(purge_candidates(&[dir], &filter()).is_empty());
    }
}
