//! Four-quadrant diff: compare (local vs last-sync) × (remote vs
//! last-sync) and emit an action plan. Content hashes are resolved
//! lazily so untouched files never get re-hashed.

use crate::file_api::FileEntry;
use crate::mirror::snapshot::LocalFile;
use crate::mirror::state::SyncState;
use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Direction {
    Bidirectional,
    UploadOnly,
    DownloadOnly,
}

/// What to do when there is no baseline state (first sync).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum FirstSyncPolicy {
    /// Safe default: upload local-only, download remote-only,
    /// content-compare files present on both sides.
    Bidirectional,
    /// Local wins: upload everything, delete remote files that don't
    /// exist locally.
    UploadAll,
    /// Remote wins: download everything, move local-only files to the
    /// local trash so nothing is lost.
    DownloadAll,
}

impl Default for FirstSyncPolicy {
    fn default() -> Self {
        FirstSyncPolicy::Bidirectional
    }
}

#[derive(Debug, Clone)]
pub enum Action {
    /// Upload a new or locally-changed file.
    Upload { path: String },
    /// Download a new or remotely-changed file.
    Download { path: String },
    /// Both sides changed: keep both (local gets a conflict copy, then
    /// the remote version is downloaded as the canonical file).
    Conflict { path: String },
    /// Deleted locally, unchanged remotely → remove on the remote
    /// (Nextcloud moves it to its server trashbin).
    DeleteRemote { path: String },
    /// Deleted remotely, unchanged locally → move the local file into
    /// `.noteforge/trash/`.
    DeleteLocal { path: String },
    /// Deleted locally but changed remotely → modify wins: re-download.
    Restore { path: String },
    /// Changed locally but deleted remotely → modify wins: re-upload.
    Reupload { path: String },
    /// Present on both sides with no baseline (first sync): download,
    /// compare content; equal → record state, differ → conflict.
    Compare { path: String },
}

impl Action {
    pub fn path(&self) -> &str {
        match self {
            Action::Upload { path }
            | Action::Download { path }
            | Action::Conflict { path }
            | Action::DeleteRemote { path }
            | Action::DeleteLocal { path }
            | Action::Restore { path }
            | Action::Reupload { path }
            | Action::Compare { path } => path,
        }
    }

    pub fn kind(&self) -> &'static str {
        match self {
            Action::Upload { .. } => "upload",
            Action::Download { .. } => "download",
            Action::Conflict { .. } => "conflict",
            Action::DeleteRemote { .. } => "delete-remote",
            Action::DeleteLocal { .. } => "delete-local",
            Action::Restore { .. } => "restore",
            Action::Reupload { .. } => "reupload",
            Action::Compare { .. } => "compare",
        }
    }
}

#[derive(Debug, Clone, Default)]
pub struct SyncPlan {
    pub actions: Vec<Action>,
}

/// Resolve a local file's change state against the baseline.
/// `hash_fn` computes the content hash lazily.
#[derive(PartialEq, Clone, Copy)]
enum LocalChange {
    Missing,
    Unchanged,
    Changed,
}

fn local_change(
    file: Option<&LocalFile>,
    state: Option<&crate::mirror::state::StateEntry>,
    hash_fn: &dyn Fn(&str) -> String,
) -> LocalChange {
    let Some(f) = file else { return LocalChange::Missing };
    let Some(s) = state else { return LocalChange::Changed }; // new file
    // Fast path: mtime+size match the baseline → content unchanged.
    if f.mtime == s.local_mtime && f.size == s.local_size {
        return LocalChange::Unchanged;
    }
    if hash_fn(&f.path) == s.local_hash {
        LocalChange::Unchanged
    } else {
        LocalChange::Changed
    }
}

/// Build the action plan.
///
/// `local` — scanned local files; `remote` — remote file entries
/// (files only); `state` — last-sync baseline; `hash_fn` — lazy local
/// content hash.
pub fn build_plan(
    local: &[LocalFile],
    remote: &[FileEntry],
    state: &SyncState,
    direction: Direction,
    first_policy: &FirstSyncPolicy,
    hash_fn: &dyn Fn(&str) -> String,
) -> SyncPlan {
    let local_map: BTreeMap<&str, &LocalFile> = local.iter().map(|f| (f.path.as_str(), f)).collect();
    let remote_map: BTreeMap<&str, &FileEntry> = remote.iter().map(|e| (e.path.as_str(), e)).collect();
    let first = state.is_first_sync();

    let mut actions: Vec<Action> = Vec::new();
    let mut paths: std::collections::BTreeSet<&str> = std::collections::BTreeSet::new();
    paths.extend(local_map.keys().copied());
    paths.extend(remote_map.keys().copied());

    for path in paths {
        let l = local_map.get(path).copied();
        let r = remote_map.get(path);
        let s = state.files.get(path);

        // ── First sync (no baseline) ────────────────────────────────
        if first {
            match (l.is_some(), r.is_some()) {
                (true, false) => {
                    if direction != Direction::DownloadOnly {
                        actions.push(Action::Upload { path: path.to_string() });
                    }
                }
                (false, true) => match first_policy {
                    FirstSyncPolicy::UploadAll => {
                        actions.push(Action::DeleteRemote { path: path.to_string() });
                    }
                    _ => {
                        if direction != Direction::UploadOnly {
                            actions.push(Action::Download { path: path.to_string() });
                        }
                    }
                },
                (true, true) => match first_policy {
                    FirstSyncPolicy::UploadAll => {
                        actions.push(Action::Upload { path: path.to_string() });
                    }
                    FirstSyncPolicy::DownloadAll | FirstSyncPolicy::Bidirectional => {
                        actions.push(Action::Compare { path: path.to_string() });
                    }
                },
                (false, false) => unreachable!(),
            }
            continue;
        }

        // ── Incremental: four quadrants ─────────────────────────────
        let lc = local_change(l, s, hash_fn);
        let rc = remote_change(r.copied(), s);

        match (lc, rc) {
            (LocalChange::Unchanged, RemoteChange::Unchanged) => { /* skip */ }
            (LocalChange::Changed, RemoteChange::Unchanged) => {
                if direction != Direction::DownloadOnly {
                    actions.push(Action::Upload { path: path.to_string() });
                }
            }
            (LocalChange::Unchanged, RemoteChange::Changed) => {
                if direction != Direction::UploadOnly {
                    actions.push(Action::Download { path: path.to_string() });
                }
            }
            (LocalChange::Changed, RemoteChange::Changed) => {
                if direction == Direction::UploadOnly {
                    actions.push(Action::Upload { path: path.to_string() });
                } else if direction == Direction::DownloadOnly {
                    actions.push(Action::Conflict { path: path.to_string() });
                } else {
                    actions.push(Action::Conflict { path: path.to_string() });
                }
            }
            (LocalChange::Missing, RemoteChange::Unchanged | RemoteChange::Missing) => {
                // Deleted locally, remote untouched (or both deleted)
                if rc == RemoteChange::Unchanged && direction != Direction::DownloadOnly {
                    actions.push(Action::DeleteRemote { path: path.to_string() });
                }
                // both deleted → just drop from state
            }
            (LocalChange::Missing, RemoteChange::Changed) => {
                // Deleted locally but modified remotely → modify wins
                if direction != Direction::UploadOnly {
                    actions.push(Action::Restore { path: path.to_string() });
                }
            }
            (LocalChange::Unchanged | LocalChange::Changed, RemoteChange::Missing) => {
                // Deleted remotely
                if matches!(lc, LocalChange::Changed) {
                    if direction != Direction::DownloadOnly {
                        actions.push(Action::Reupload { path: path.to_string() });
                    }
                } else if direction != Direction::UploadOnly {
                    actions.push(Action::DeleteLocal { path: path.to_string() });
                }
            }
        }
    }

    SyncPlan { actions }
}

#[derive(PartialEq, Clone, Copy)]
enum RemoteChange {
    Missing,
    Unchanged,
    Changed,
}

fn remote_change(r: Option<&FileEntry>, s: Option<&crate::mirror::state::StateEntry>) -> RemoteChange {
    let Some(e) = r else { return RemoteChange::Missing };
    let Some(st) = s else { return RemoteChange::Changed }; // new remote file
    match (&st.remote_etag, &e.etag) {
        (Some(a), Some(b)) if a == b => RemoteChange::Unchanged,
        // etag missing/unreliable → fall back to size heuristic
        _ if e.size == 0 && st.local_size == 0 => RemoteChange::Unchanged,
        _ => RemoteChange::Changed,
    }
}
