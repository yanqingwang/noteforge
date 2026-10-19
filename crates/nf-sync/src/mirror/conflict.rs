//! Conflict resolution strategies and the mass-delete circuit breaker.
//!
//! The decision is pure (no I/O): `decide` picks one of five strategies
//! from the yanc feature set and returns what the engine should do.
//! `delete_cap` implements the mass-delete guard (feature 049).

use crate::mirror::merge::{is_mergeable_text, merge3};

/// Per-file-type conflict strategy. `merge` is only valid for
/// "Auto Merge File" types; the other four are deterministic.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Strategy {
    /// Three-way merge; clean → merged body, text conflict → markers,
    /// non-text or oversized → safe-hold.
    Merge,
    /// Keep the larger side; equal size → no-op.
    BiggestSize,
    /// Keep the newer side; equal mtime → no-op.
    LatestMtime,
    /// Always keep local, overwrite remote.
    LocalWin,
    /// Always keep remote, overwrite local.
    RemoteWin,
}

impl Strategy {
    pub fn parse(s: &str) -> Strategy {
        match s {
            "biggest-size" => Strategy::BiggestSize,
            "latest-mtime" => Strategy::LatestMtime,
            "local-win" => Strategy::LocalWin,
            "remote-win" => Strategy::RemoteWin,
            _ => Strategy::Merge,
        }
    }

    /// `merge` is not offered for non-markdown "other" files.
    pub fn as_str(&self) -> &'static str {
        match self {
            Strategy::Merge => "merge",
            Strategy::BiggestSize => "biggest-size",
            Strategy::LatestMtime => "latest-mtime",
            Strategy::LocalWin => "local-win",
            Strategy::RemoteWin => "remote-win",
        }
    }
}

/// Inputs to a conflict decision (the two sides plus their mtimes).
pub struct ConflictCtx<'a> {
    pub local: &'a [u8],
    pub remote: &'a [u8],
    /// Last converged body (the common ancestor) for a real 3-way merge.
    /// `None` falls back to an empty ancestor — competing edits then
    /// surface as explicit marker conflicts rather than silent loss.
    pub base: Option<&'a [u8]>,
    /// Local mtime, milliseconds since epoch.
    pub local_mtime: u64,
    /// Remote lastModified, milliseconds since epoch.
    pub remote_mtime: u64,
}

/// What the engine must do about a conflicted file.
#[derive(Debug, Clone, PartialEq)]
pub enum Resolution {
    /// Converge on `content`: write it locally, then upload.
    /// `clean` = a real merge with no conflict regions.
    Write { content: Vec<u8>, clean: bool },
    /// Keep the local copy, overwrite the remote.
    PreferLocal,
    /// Keep the remote copy, overwrite the local.
    PreferRemote,
    /// Leave BOTH sides untouched and flag the file conflicted
    /// (non-text / unmergeable under `merge`).
    SafeHold,
    /// Deterministic tie: both sides untouched, NOT conflicted.
    NoOp,
}

/// Decide how to resolve one conflict (pure).
pub fn decide(strategy: Strategy, ctx: &ConflictCtx<'_>) -> Resolution {
    match strategy {
        Strategy::Merge => {
            if !is_mergeable_text(ctx.local) || !is_mergeable_text(ctx.remote) {
                return Resolution::SafeHold;
            }
            if !ctx.base.is_none_or(is_mergeable_text) {
                return Resolution::SafeHold;
            }
            let local = String::from_utf8_lossy(ctx.local);
            let remote = String::from_utf8_lossy(ctx.remote);
            let base = ctx.base.map(String::from_utf8_lossy).unwrap_or_default();
            let outcome = merge3(&base, &local, &remote);
            if outcome.hold {
                Resolution::SafeHold
            } else {
                Resolution::Write { content: outcome.content.into_bytes(), clean: !outcome.had_conflicts }
            }
        }
        Strategy::BiggestSize => match ctx.local.len().cmp(&ctx.remote.len()) {
            std::cmp::Ordering::Greater => Resolution::PreferLocal,
            std::cmp::Ordering::Less => Resolution::PreferRemote,
            std::cmp::Ordering::Equal => Resolution::NoOp,
        },
        Strategy::LatestMtime => match ctx.local_mtime.cmp(&ctx.remote_mtime) {
            std::cmp::Ordering::Greater => Resolution::PreferLocal,
            std::cmp::Ordering::Less => Resolution::PreferRemote,
            std::cmp::Ordering::Equal => Resolution::NoOp,
        },
        Strategy::LocalWin => Resolution::PreferLocal,
        Strategy::RemoteWin => Resolution::PreferRemote,
    }
}

/// Cap on how many deletions one sync round may perform (feature 049).
///
/// `-1` → automatic dynamic limit `max(20, 20% of tracked entries)`;
/// `0`  → unlimited (RISKY); `N > 0` → that fixed limit.
/// `None` means "no cap".
pub fn delete_cap(mass_delete_limit: i64, tracked: usize) -> Option<usize> {
    match mass_delete_limit {
        0 => None,
        n if n < 0 => Some(std::cmp::max(20, tracked / 5)),
        n => Some(n as usize),
    }
}

/// Running count of deletions in one round, checked against a cap.
pub struct MassDeleteGuard {
    cap: Option<usize>,
    count: usize,
    /// Paths that were refused because the cap was already reached.
    pub refused: Vec<String>,
}

impl MassDeleteGuard {
    pub fn new(mass_delete_limit: i64, tracked: usize) -> Self {
        MassDeleteGuard { cap: delete_cap(mass_delete_limit, tracked), count: 0, refused: Vec::new() }
    }

    /// Ask permission to delete `path`. Records the refusal when denied.
    pub fn allow(&mut self, path: &str) -> bool {
        match self.cap {
            Some(cap) if self.count >= cap => {
                self.refused.push(path.to_string());
                false
            }
            _ => {
                self.count += 1;
                true
            }
        }
    }

    pub fn refused_count(&self) -> usize {
        self.refused.len()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn ctx<'a>(local: &'a [u8], remote: &'a [u8], lm: u64, rm: u64) -> ConflictCtx<'a> {
        ConflictCtx { local, remote, base: None, local_mtime: lm, remote_mtime: rm }
    }

    fn ctx_base<'a>(base: &'a [u8], local: &'a [u8], remote: &'a [u8]) -> ConflictCtx<'a> {
        ConflictCtx { local, remote, base: Some(base), local_mtime: 1, remote_mtime: 2 }
    }

    #[test]
    fn biggest_size_keeps_larger() {
        let c = ctx(b"12345", b"1", 0, 99);
        assert_eq!(decide(Strategy::BiggestSize, &c), Resolution::PreferLocal);
        assert_eq!(decide(Strategy::BiggestSize, &ctx(b"1", b"12345", 99, 0)), Resolution::PreferRemote);
        assert_eq!(decide(Strategy::BiggestSize, &ctx(b"ab", b"cd", 1, 2)), Resolution::NoOp);
    }

    #[test]
    fn latest_mtime_keeps_newer() {
        assert_eq!(decide(Strategy::LatestMtime, &ctx(b"a", b"b", 500, 100)), Resolution::PreferLocal);
        assert_eq!(decide(Strategy::LatestMtime, &ctx(b"a", b"b", 100, 500)), Resolution::PreferRemote);
        assert_eq!(decide(Strategy::LatestMtime, &ctx(b"a", b"b", 7, 7)), Resolution::NoOp);
    }

    #[test]
    fn local_and_remote_win_are_unconditional() {
        assert_eq!(decide(Strategy::LocalWin, &ctx(b"a", b"bbbb", 1, 999)), Resolution::PreferLocal);
        assert_eq!(decide(Strategy::RemoteWin, &ctx(b"aaaa", b"b", 999, 1)), Resolution::PreferRemote);
    }

    #[test]
    fn merge_holds_binary_and_writes_text() {
        let binary = decide(Strategy::Merge, &ctx(&[0x00, 0x01], &[0x00, 0x02], 1, 2));
        assert_eq!(binary, Resolution::SafeHold);
        let text = decide(Strategy::Merge, &ctx(b"a\n", b"a\n", 1, 2));
        match text {
            Resolution::Write { content, clean } => {
                assert!(clean);
                assert_eq!(content, b"a\n");
            }
            other => panic!("expected Write, got {:?}", other),
        }
    }

    #[test]
    fn merge_of_competing_edits_flags_conflict() {
        match decide(Strategy::Merge, &ctx(b"mine\n", b"theirs\n", 1, 2)) {
            Resolution::Write { content, clean } => {
                assert!(!clean);
                let s = String::from_utf8(content).unwrap();
                assert!(s.contains("<<<<<<< 本地") && s.contains(">>>>>>> 远端"));
            }
            other => panic!("expected Write, got {:?}", other),
        }
    }

    #[test]
    fn merge_with_real_base_resolves_disjoint_edits() {
        let base = b"a\nb\nc\nd\n";
        let local = b"a\nB\nc\nd\n";
        let remote = b"a\nb\nc\nD\n";
        match decide(Strategy::Merge, &ctx_base(base, local, remote)) {
            Resolution::Write { content, clean } => {
                assert!(clean, "disjoint edits merge cleanly with a base");
                assert_eq!(content, b"a\nB\nc\nD\n");
            }
            other => panic!("expected Write, got {:?}", other),
        }
    }

    #[test]
    fn strategy_parsing_round_trips() {
        for s in ["merge", "biggest-size", "latest-mtime", "local-win", "remote-win"] {
            assert_eq!(Strategy::parse(s).as_str(), s);
        }
        assert_eq!(Strategy::parse("nonsense"), Strategy::Merge);
    }

    #[test]
    fn delete_cap_modes() {
        assert_eq!(delete_cap(-1, 100), Some(20)); // 20% of 100 = 20
        assert_eq!(delete_cap(-1, 1000), Some(200));
        assert_eq!(delete_cap(-1, 10), Some(20)); // floor of 20
        assert_eq!(delete_cap(0, 1000), None); // unlimited
        assert_eq!(delete_cap(5, 1000), Some(5));
    }

    #[test]
    fn guard_blocks_after_cap() {
        let mut g = MassDeleteGuard::new(2, 100);
        assert!(g.allow("a"));
        assert!(g.allow("b"));
        assert!(!g.allow("c"));
        assert!(!g.allow("d"));
        assert_eq!(g.refused_count(), 2);
        assert_eq!(g.refused, vec!["c".to_string(), "d".to_string()]);
    }

    #[test]
    fn unlimited_guard_never_blocks() {
        let mut g = MassDeleteGuard::new(0, 10);
        for i in 0..100 {
            assert!(g.allow(&format!("f{}", i)));
        }
        assert_eq!(g.refused_count(), 0);
    }
}
