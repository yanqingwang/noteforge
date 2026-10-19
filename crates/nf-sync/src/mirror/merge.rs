//! Three-way (diff3) line merge for text files.
//!
//! Used by the `merge` conflict strategy on "Auto Merge File" types: a
//! clean merge converges silently; a real conflict keeps BOTH sides in
//! the file as `<<<<<<<` / `=======` / `>>>>>>>` marker regions so no
//! data is lost. Binary content and oversized inputs are reported as
//! `hold` — the caller must then leave both sides untouched.

/// Result of a three-way merge.
#[derive(Debug, Clone, PartialEq)]
pub struct MergeOutcome {
    /// Merged body (line-joined, original line endings preserved).
    pub content: String,
    /// A real (unresolvable) conflict region was emitted.
    pub had_conflicts: bool,
    /// How many `<<<<<<<` regions the output contains.
    pub conflict_regions: usize,
    /// Merge impossible (binary, or input too large) — caller must not
    /// write anything; both sides stay as they are.
    pub hold: bool,
}

impl MergeOutcome {
    fn hold_result() -> Self {
        MergeOutcome { content: String::new(), had_conflicts: false, conflict_regions: 0, hold: true }
    }
}

/// Ceiling on the LCS table (`base_lines × other_lines`) before giving up.
/// Above this the merge is reported as a hold instead of burning memory.
const MAX_LCS_CELLS: usize = 4_000_000;

/// Can these bytes be merged as text? UTF-8 and free of NUL bytes.
pub fn is_mergeable_text(data: &[u8]) -> bool {
    !data.contains(&0) && std::str::from_utf8(data).is_ok()
}

/// Three-way merge of `base` (last converged), `local` and `remote`.
pub fn merge3(base: &str, local: &str, remote: &str) -> MergeOutcome {
    let base_l: Vec<&str> = base.split('\n').collect();
    let local_l: Vec<&str> = local.split('\n').collect();
    let remote_l: Vec<&str> = remote.split('\n').collect();

    if base_l.len().saturating_mul(local_l.len()) > MAX_LCS_CELLS
        || base_l.len().saturating_mul(remote_l.len()) > MAX_LCS_CELLS
    {
        return MergeOutcome::hold_result();
    }

    // Align every side against the base.
    let base_to_local = map_to_base(&base_l, &local_l);
    let base_to_remote = map_to_base(&base_l, &remote_l);

    let mut out: Vec<String> = Vec::new();
    let mut conflicts = 0usize;
    let mut i = 0usize;
    let mut j = 0usize;
    let mut k = 0usize;

    while i < base_l.len() {
        // Stable line: unchanged on both sides.
        if base_to_local[i] == Some(j) && base_to_remote[i] == Some(k) {
            out.push(base_l[i].to_string());
            i += 1;
            j += 1;
            k += 1;
            continue;
        }
        // Unstable region: find the next line both sides still share.
        let mut next: Option<(usize, usize, usize)> = None;
        let mut probe = i + 1;
        while probe < base_l.len() {
            if let (Some(l2), Some(r2)) = (base_to_local[probe], base_to_remote[probe]) {
                if l2 >= j && r2 >= k {
                    next = Some((probe, l2, r2));
                    break;
                }
            }
            probe += 1;
        }
        let (end, l_end, r_end) = next.unwrap_or((base_l.len(), local_l.len(), remote_l.len()));

        let base_seg = &base_l[i..end];
        let local_seg = &local_l[j..l_end];
        let remote_seg = &remote_l[k..r_end];

        if local_seg == base_seg && remote_seg == base_seg {
            // Both sides identical to base: keep the base lines as-is.
            push_lines(&mut out, base_seg);
        } else if local_seg == remote_seg {
            push_lines(&mut out, local_seg);
        } else if local_seg == base_seg {
            push_lines(&mut out, remote_seg);
        } else if remote_seg == base_seg {
            push_lines(&mut out, local_seg);
        } else {
            conflicts += 1;
            out.push("<<<<<<< 本地".to_string());
            push_lines(&mut out, local_seg);
            out.push("=======".to_string());
            push_lines(&mut out, remote_seg);
            out.push(">>>>>>> 远端".to_string());
        }
        i = end;
        j = l_end;
        k = r_end;
    }

    MergeOutcome {
        content: out.join("\n"),
        had_conflicts: conflicts > 0,
        conflict_regions: conflicts,
        hold: false,
    }
}

fn push_lines(out: &mut Vec<String>, seg: &[&str]) {
    out.extend(seg.iter().map(|s| s.to_string()));
}

/// For each base line, the index of the local/remote line it aligns with
/// (longest common subsequence), or `None` when the line has no match.
fn map_to_base(base: &[&str], other: &[&str]) -> Vec<Option<usize>> {
    let mut map = vec![None; base.len()];
    for (bi, oi) in lcs_pairs(base, other) {
        map[bi] = Some(oi);
    }
    map
}

/// Index pairs of one longest common subsequence of `a` and `b`.
fn lcs_pairs(a: &[&str], b: &[&str]) -> Vec<(usize, usize)> {
    let n = a.len();
    let m = b.len();
    let width = m + 1;
    let mut dp = vec![0u32; (n + 1) * width];
    for i in (0..n).rev() {
        for j in (0..m).rev() {
            dp[i * width + j] = if a[i] == b[j] {
                dp[(i + 1) * width + j + 1] + 1
            } else {
                dp[(i + 1) * width + j].max(dp[i * width + j + 1])
            };
        }
    }
    let mut pairs = Vec::new();
    let (mut i, mut j) = (0usize, 0usize);
    while i < n && j < m {
        if a[i] == b[j] {
            pairs.push((i, j));
            i += 1;
            j += 1;
        } else if dp[(i + 1) * width + j] >= dp[i * width + j + 1] {
            i += 1;
        } else {
            j += 1;
        }
    }
    pairs
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn disjoint_edits_merge_cleanly() {
        let base = "a\nb\nc\nd\n";
        let local = "a\nB\nc\nd\n"; // changed line 2
        let remote = "a\nb\nc\nD\n"; // changed line 4
        let r = merge3(base, local, remote);
        assert!(!r.had_conflicts);
        assert!(!r.hold);
        assert_eq!(r.content, "a\nB\nc\nD\n");
    }

    #[test]
    fn additions_on_both_sides_are_kept() {
        let base = "start\nend\n";
        let local = "start\nlocal only\nend\n";
        let remote = "start\nremote only\nend\n";
        let r = merge3(base, local, remote);
        assert_eq!(r.conflict_regions, 1, "competing insertions at one spot conflict");
        assert!(r.had_conflicts);
        assert!(r.content.contains("<<<<<<< 本地"));
        assert!(r.content.contains("local only"));
        assert!(r.content.contains("remote only"));
    }

    #[test]
    fn same_edit_on_both_sides_is_not_a_conflict() {
        let base = "x\n";
        let r = merge3(base, "y\n", "y\n");
        assert!(!r.had_conflicts);
        assert_eq!(r.content, "y\n");
    }

    #[test]
    fn only_local_changed_takes_local() {
        let r = merge3("a\nb\n", "a\nb2\n", "a\nb\n");
        assert!(!r.had_conflicts);
        assert_eq!(r.content, "a\nb2\n");
    }

    #[test]
    fn only_remote_changed_takes_remote() {
        let r = merge3("a\nb\n", "a\nb\n", "a\nb3\n");
        assert_eq!(r.content, "a\nb3\n");
    }

    #[test]
    fn real_conflict_writes_markers() {
        let r = merge3("base\n", "mine\n", "theirs\n");
        assert!(r.had_conflicts);
        assert_eq!(r.conflict_regions, 1);
        assert_eq!(r.content, "<<<<<<< 本地\nmine\n=======\ntheirs\n>>>>>>> 远端\n");
    }

    #[test]
    fn trailing_newline_is_preserved() {
        assert_eq!(merge3("a\n", "a\n", "a\n").content, "a\n");
        assert_eq!(merge3("a", "a", "a").content, "a");
    }

    #[test]
    fn deletion_one_side_only_still_merges() {
        let r = merge3("a\nb\nc\n", "a\nc\n", "a\nb\nc\n");
        assert!(!r.had_conflicts);
        assert_eq!(r.content, "a\nc\n");
    }

    #[test]
    fn binary_is_not_mergeable() {
        assert!(!is_mergeable_text(&[0x00, 0xff]));
        assert!(is_mergeable_text("ok\n".as_bytes()));
    }

    #[test]
    fn identical_input_is_a_noop_merge() {
        let r = merge3("same\n", "same\n", "same\n");
        assert_eq!(r.content, "same\n");
        assert_eq!(r.conflict_regions, 0);
    }
}
