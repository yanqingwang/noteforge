//! Built-in vault generation profiles and utility functions for
//! path planning and archetype assignment.
//!
//! Provides the [`Profile`] struct with built-in profile definitions,
//! deterministic path generation with mixed CN/EN filenames, and
//! weighted-random archetype distribution.

use rand::distr::weighted::WeightedIndex;
use rand::distr::Distribution;
use rand::seq::IndexedRandom;
use rand::Rng;
use rand_chacha::ChaCha20Rng;

use crate::ir::{Archetype, GenerationMode};

// ---------------------------------------------------------------------------
// Word pools for filename / directory generation
// ---------------------------------------------------------------------------

const EN_STEMS: &[&str] = &[
    "readme", "index", "notes", "draft", "journal", "daily", "meeting",
    "project", "ideas", "reference", "todo", "tasks", "summary", "review",
    "plan", "report", "research", "study", "template", "guide", "checklist",
    "archive", "config", "changelog", "backlog", "sprint",
];

const CN_STEMS: &[&str] = &[
    "项目", "笔记", "日记", "想法", "会议", "周报", "月报", "计划",
    "总结", "方案", "报告", "调研", "学习", "阅读", "随笔", "清单",
    "备忘", "流程", "规范", "指南", "手册", "模板", "归档", "参考",
    "工作", "个人", "团队", "知识库", "备份", "配置",
];

/// Windows reserved names that must not be used as filename stems.
const WINDOWS_RESERVED: &[&str] = &[
    "con", "prn", "aux", "nul", "com1", "com2", "com3", "com4", "com5",
    "com6", "com7", "com8", "com9", "lpt1", "lpt2", "lpt3", "lpt4",
    "lpt5", "lpt6", "lpt7", "lpt8", "lpt9",
];

/// Default archetype ratios used by most built-in profiles.
const DEFAULT_ARCHETYPE_RATIOS: [(Archetype, f64); 5] = [
    (Archetype::Zettel, 0.55),
    (Archetype::Moc, 0.05),
    (Archetype::Journal, 0.15),
    (Archetype::Literature, 0.15),
    (Archetype::Stub, 0.10),
];

// MAX_PATH_BYTES: 240 bytes is the safe limit for Windows
// (260 - room for drive prefix + NUL). We use 232 to leave a small safety
// margin.
const MAX_PATH_BYTES: usize = 232;

// ---------------------------------------------------------------------------
// TopologyConfig (inline definition — mirrors src/topology.rs interface)
// ---------------------------------------------------------------------------

pub use crate::topology::TopologyConfig;

// ---------------------------------------------------------------------------
// DepthConfig
// ---------------------------------------------------------------------------

/// Controls the directory-depth distribution for generated paths.
#[derive(Debug, Clone)]
pub struct DepthConfig {
    /// Pairs of `(depth, probability_weight)`.
    ///
    /// Depth 0 means the file sits at the vault root. Depth 4 is a catch-all
    /// that is expanded uniformly into depths 4, 5 or 6.
    pub weights: Vec<(usize, f64)>,
}

impl Default for DepthConfig {
    fn default() -> Self {
        Self {
            weights: vec![
                (0, 0.15),
                (1, 0.35),
                (2, 0.30),
                (3, 0.15),
                (4, 0.05),
            ],
        }
    }
}

// ---------------------------------------------------------------------------
// Profile
// ---------------------------------------------------------------------------

/// A named vault-generation profile that bundles all parameters together.
#[derive(Debug, Clone)]
pub struct Profile {
    pub name: String,
    pub mode: GenerationMode,
    /// Number of Markdown notes to generate.
    pub num_notes: usize,
    /// Number of attachment files to generate.
    pub num_attachments: usize,
    /// Desired distribution of [`Archetype`] values (must sum to ≈1.0).
    ///
    /// Stored as `Vec<(Archetype, f64)>` because `Archetype` does not
    /// implement `Hash`.
    pub archetype_ratios: Vec<(Archetype, f64)>,
    /// Link-graph topology parameters.
    pub topology_config: TopologyConfig,
    /// Ratio of attachments relative to notes (used when mode is Statistical).
    pub attachment_ratio: f64,
}

impl Profile {
    /// Look up a built-in profile by name.
    ///
    /// # Panics
    /// Panics if `name` is not one of the known built-in profile names.
    pub fn builtin(name: &str) -> Self {
        let ratios = default_archetype_ratios();
        match name {
            "smoke" => Profile {
                name: "smoke".into(),
                mode: GenerationMode::Exact,
                num_notes: 50,
                num_attachments: 0,
                archetype_ratios: ratios,
                topology_config: TopologyConfig {
                    total_links: 150,
                    orphan_ratio: 0.0,
                    broken_ratio: 0.0,
                    bidirectional_pairs: 0,
                    self_loops: 0,
                    m0: 3,
                    m: 2,
                },
                attachment_ratio: 0.0,
            },

            "standard-10k" => Profile {
                name: "standard-10k".into(),
                mode: GenerationMode::Statistical,
                num_notes: 10_000,
                num_attachments: 1_500,
                archetype_ratios: ratios,
                topology_config: TopologyConfig {
                    total_links: 50_000,
                    orphan_ratio: 0.03,
                    broken_ratio: 0.01,
                    bidirectional_pairs: 100,
                    self_loops: 0,
                    m0: 5,
                    m: 3,
                },
                attachment_ratio: 0.15,
            },

            "large-100k" => Profile {
                name: "large-100k".into(),
                mode: GenerationMode::Statistical,
                num_notes: 100_000,
                num_attachments: 15_000,
                archetype_ratios: ratios,
                topology_config: TopologyConfig {
                    total_links: 500_000,
                    orphan_ratio: 0.03,
                    broken_ratio: 0.01,
                    bidirectional_pairs: 1_000,
                    self_loops: 0,
                    m0: 5,
                    m: 3,
                },
                attachment_ratio: 0.15,
            },

            "graph-bench" => Profile {
                name: "graph-bench".into(),
                mode: GenerationMode::Exact,
                num_notes: 10_000,
                num_attachments: 0,
                archetype_ratios: ratios,
                topology_config: TopologyConfig {
                    total_links: 30_000,
                    orphan_ratio: 0.0,
                    broken_ratio: 0.0,
                    bidirectional_pairs: 0,
                    self_loops: 0,
                    // m0=1 / m=3 ensures a connected BA graph
                    m0: 1,
                    m: 3,
                },
                attachment_ratio: 0.0,
            },

            "bigfile" => Profile {
                name: "bigfile".into(),
                mode: GenerationMode::Exact,
                num_notes: 4,
                num_attachments: 0,
                archetype_ratios: ratios,
                topology_config: TopologyConfig {
                    total_links: 0,
                    orphan_ratio: 0.0,
                    broken_ratio: 0.0,
                    bidirectional_pairs: 0,
                    self_loops: 0,
                    m0: 1,
                    m: 1,
                },
                attachment_ratio: 0.0,
            },

            "rename-sync" => Profile {
                name: "rename-sync".into(),
                mode: GenerationMode::Exact,
                num_notes: 101,
                num_attachments: 0,
                archetype_ratios: ratios,
                topology_config: TopologyConfig {
                    total_links: 500,
                    orphan_ratio: 0.0,
                    broken_ratio: 0.0,
                    bidirectional_pairs: 0,
                    self_loops: 0,
                    m0: 1,
                    m: 1,
                },
                attachment_ratio: 0.0,
            },
            "search-oracle" => Profile {
                name: "search-oracle".into(), mode: GenerationMode::Exact,
                num_notes: 2000, num_attachments: 0,
                archetype_ratios: default_archetype_ratios(),
                topology_config: TopologyConfig {
                    total_links: 5000, orphan_ratio: 0.05, broken_ratio: 0.0,
                    bidirectional_pairs: 10, self_loops: 0, m0: 5, m: 2,
                }, attachment_ratio: 0.0,
            },
            "edge-corpus" => Profile {
                name: "edge-corpus".into(), mode: GenerationMode::Exact,
                num_notes: 200, num_attachments: 0,
                archetype_ratios: default_archetype_ratios(),
                topology_config: TopologyConfig {
                    total_links: 500, orphan_ratio: 0.1, broken_ratio: 0.05,
                    bidirectional_pairs: 5, self_loops: 2, m0: 3, m: 2,
                }, attachment_ratio: 0.0,
            },
            "unicode-hell" => Profile {
                name: "unicode-hell".into(), mode: GenerationMode::Exact,
                num_notes: 500, num_attachments: 0,
                archetype_ratios: default_archetype_ratios(),
                topology_config: TopologyConfig {
                    total_links: 1000, orphan_ratio: 0.1, broken_ratio: 0.02,
                    bidirectional_pairs: 5, self_loops: 2, m0: 5, m: 2,
                }, attachment_ratio: 0.0,
            },
            "deep-nest" => Profile {
                name: "deep-nest".into(), mode: GenerationMode::Exact,
                num_notes: 100, num_attachments: 0,
                archetype_ratios: default_archetype_ratios(),
                topology_config: TopologyConfig {
                    total_links: 200, orphan_ratio: 0.0, broken_ratio: 0.0,
                    bidirectional_pairs: 0, self_loops: 0, m0: 3, m: 2,
                }, attachment_ratio: 0.0,
            },
            "churn-base" => Profile {
                name: "churn-base".into(), mode: GenerationMode::Statistical,
                num_notes: 1000, num_attachments: 0,
                archetype_ratios: default_archetype_ratios(),
                topology_config: TopologyConfig {
                    total_links: 3000, orphan_ratio: 0.05, broken_ratio: 0.02,
                    bidirectional_pairs: 10, self_loops: 0, m0: 5, m: 2,
                }, attachment_ratio: 0.0,
            },

            _ => panic!(
                "Unknown builtin profile: `{name}`. Available: {}",
                list_builtin_profiles().join(", ")
            ),
        }
    }
}

/// Return the names of all built-in profiles.
pub fn list_builtin_profiles() -> Vec<&'static str> {
    vec![
        "smoke",
        "standard-10k",
        "large-100k",
        "graph-bench",
        "bigfile",
        "rename-sync",
    "search-oracle",
    "edge-corpus",
    "unicode-hell",
    "deep-nest",
    "churn-base",
    ]
}

fn default_archetype_ratios() -> Vec<(Archetype, f64)> {
    DEFAULT_ARCHETYPE_RATIOS.to_vec()
}

// ---------------------------------------------------------------------------
// Windows-reserved-name check
// ---------------------------------------------------------------------------

fn is_windows_reserved(name: &str) -> bool {
    let lower = name.to_lowercase();
    // Check without .md extension first, then without any extension.
    let stem = lower
        .strip_suffix(".md")
        .or_else(|| lower.rsplit_once('.').map(|(s, _)| s))
        .unwrap_or(&lower);
    WINDOWS_RESERVED.contains(&stem) || stem.is_empty()
}

// ---------------------------------------------------------------------------
// Depth sampling
// ---------------------------------------------------------------------------

fn sample_depth(config: &DepthConfig, rng: &mut ChaCha20Rng) -> usize {
    let weights: Vec<f64> = config.weights.iter().map(|(_, w)| *w).collect();
    let dist = WeightedIndex::new(&weights).expect("DepthConfig weights are valid");
    let idx = dist.sample(rng);
    let depth = config.weights[idx].0;
    if depth == 4 {
        // Spread the 5 % budget uniformly over depths 4, 5, 6.
        4 + rng.random_range(0..3)
    } else {
        depth
    }
}

// ---------------------------------------------------------------------------
// Stem / directory-name generation
// ---------------------------------------------------------------------------

/// Pick a random English stem word.
fn pick_en_stem(rng: &mut ChaCha20Rng) -> &'static str {
    EN_STEMS.choose(rng).expect("EN_STEMS non-empty")
}

/// Pick a random Chinese stem.
fn pick_cn_stem(rng: &mut ChaCha20Rng) -> &'static str {
    CN_STEMS.choose(rng).expect("CN_STEMS non-empty")
}

/// Produce a filename stem (no extension) according to the language mix.
fn generate_stem(rng: &mut ChaCha20Rng) -> String {
    let roll: u32 = rng.random_range(0..100);
    let stem: String = if roll < 40 {
        // 40 % Chinese
        pick_cn_stem(rng).to_string()
    } else if roll < 80 {
        // 40 % English
        pick_en_stem(rng).to_string()
    } else if roll < 95 {
        // 15 % mixed CN-EN
        let en = pick_en_stem(rng);
        let cn = pick_cn_stem(rng);
        if rng.random_bool(0.5) {
            format!("{}-{}", cn, en)
        } else {
            format!("{}-{}", en, cn)
        }
    } else {
        // 5 % date-stamped format
        let y = rng.random_range(2020..=2026);
        let m = rng.random_range(1..=12);
        let d = rng.random_range(1..=28);
        format!("{:04}-{:02}-{:02}", y, m, d)
    };

    // Guard against Windows reserved names.
    if is_windows_reserved(&stem) {
        format!("n{}", stem)
    } else {
        stem
    }
}

/// Generate a directory-name (lighter weight, no date format).
fn generate_dirname(rng: &mut ChaCha20Rng) -> String {
    let roll: u32 = rng.random_range(0..100);
    let name: String = if roll < 40 {
        pick_cn_stem(rng).to_string()
    } else if roll < 85 {
        pick_en_stem(rng).to_string()
    } else {
        // mixed
        let en = pick_en_stem(rng);
        let cn = pick_cn_stem(rng);
        if rng.random_bool(0.5) {
            format!("{}-{}", cn, en)
        } else {
            format!("{}-{}", en, cn)
        }
    };

    if is_windows_reserved(&name) {
        format!("dir-{}", name)
    } else {
        name
    }
}

// ---------------------------------------------------------------------------
// Public API — path / filename / archetype helpers
// ---------------------------------------------------------------------------

/// Generate a single realistic filename (including `.md` extension).
pub fn generate_filename(rng: &mut ChaCha20Rng) -> String {
    let mut stem = generate_stem(rng);
    // Final safety: re-prefix if the guard above wasn't enough.
    if is_windows_reserved(&stem) {
        stem = format!("n{}", stem);
    }
    format!("{}.md", stem)
}

/// Generate `num_docs` distinct file paths with realistic depth and naming.
///
/// Paths are guaranteed to be unique within the returned vector, under 240
/// UTF-8 bytes, and free of Windows reserved-name stems.
pub fn generate_paths(
    num_docs: usize,
    depth_config: &DepthConfig,
    rng: &mut ChaCha20Rng,
) -> Vec<String> {
    let mut paths = Vec::with_capacity(num_docs);
    let mut seen = std::collections::HashSet::new();

    while paths.len() < num_docs {
        let depth = sample_depth(depth_config, rng);
        let mut segments: Vec<String> = Vec::with_capacity(depth);
        for _ in 0..depth {
            segments.push(generate_dirname(rng));
        }

        let filename = generate_filename(rng);

        let path = if depth == 0 {
            filename
        } else {
            let dir = segments.join("/");
            format!("{dir}/{filename}")
        };

        // Enforce byte-length limit — truncate the stem if needed.
        let path = enforce_path_length(&path);

        // Deduplicate (extremely unlikely to collide, but be safe).
        if seen.insert(path.clone()) {
            paths.push(path);
        }
    }

    paths
}

/// If the full path is longer than `MAX_PATH_BYTES`, shorten the filename
/// stem to fit.
fn enforce_path_length(path: &str) -> String {
    if path.len() <= MAX_PATH_BYTES {
        return path.to_string();
    }

    // Split into directory part and filename.
    if let Some((dir, file)) = path.rsplit_once('/') {
        let suffix = ".md";
        // How many bytes can the stem use?
        let budget = MAX_PATH_BYTES
            .saturating_sub(dir.len())
            .saturating_sub(1) // '/'
            .saturating_sub(suffix.len());

        if budget < 1 {
            // Extreme case: just hard-truncate.
            return path[..MAX_PATH_BYTES.min(path.len())].to_string();
        }

        // Walk chars (not bytes) so we don't break a multi-byte character.
        let mut stem = String::new();
        for ch in file.strip_suffix(suffix).unwrap_or(&file).chars() {
            let would_be = stem.len() + ch.len_utf8();
            if would_be > budget {
                break;
            }
            stem.push(ch);
        }
        format!("{dir}/{stem}{suffix}")
    } else {
        // No directory — just truncate at byte boundary.
        let mut s = String::new();
        for ch in path.chars() {
            let would_be = s.len() + ch.len_utf8();
            if would_be > MAX_PATH_BYTES {
                break;
            }
            s.push(ch);
        }
        s
    }
}

/// Assign each document an [`Archetype`] according to the weighted ratios.
///
/// Uses `num_docs` independent weighted-random draws from `ratios`. The
/// caller can then sort or leave the result in generation order.
pub fn assign_archetypes(
    num_docs: usize,
    ratios: &[(Archetype, f64)],
    rng: &mut ChaCha20Rng,
) -> Vec<Archetype> {
    if num_docs == 0 {
        return Vec::new();
    }

    let archetypes: Vec<Archetype> = ratios.iter().map(|(a, _)| *a).collect();
    let weights: Vec<f64> = ratios.iter().map(|(_, w)| *w).collect();
    let dist = WeightedIndex::new(&weights).expect("archetype ratios are valid weights");

    (0..num_docs)
        .map(|_| archetypes[dist.sample(rng)])
        .collect()
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;
    use rand_chacha::rand_core::SeedableRng;

    /// Deterministic RNG used throughout tests.
    fn test_rng() -> ChaCha20Rng {
        ChaCha20Rng::seed_from_u64(42)
    }

    // --- Profile built-in definitions ---

    #[test]
    fn test_profile_smoke() {
        let p = Profile::builtin("smoke");
        assert_eq!(p.name, "smoke");
        assert_eq!(p.mode, GenerationMode::Exact);
        assert_eq!(p.num_notes, 50);
        assert_eq!(p.num_attachments, 0);
        assert_eq!(p.attachment_ratio, 0.0);
        assert_eq!(p.topology_config.total_links, 150);
    }

    #[test]
    fn test_profile_standard_10k() {
        let p = Profile::builtin("standard-10k");
        assert_eq!(p.name, "standard-10k");
        assert_eq!(p.mode, GenerationMode::Statistical);
        assert_eq!(p.num_notes, 10_000);
        assert_eq!(p.num_attachments, 1_500);
        assert_eq!(p.topology_config.total_links, 50_000);
    }

    #[test]
    fn test_profile_large_100k() {
        let p = Profile::builtin("large-100k");
        assert_eq!(p.name, "large-100k");
        assert_eq!(p.mode, GenerationMode::Statistical);
        assert_eq!(p.num_notes, 100_000);
        assert_eq!(p.num_attachments, 15_000);
        assert_eq!(p.topology_config.total_links, 500_000);
    }

    #[test]
    fn test_profile_graph_bench() {
        let p = Profile::builtin("graph-bench");
        assert_eq!(p.name, "graph-bench");
        assert_eq!(p.mode, GenerationMode::Exact);
        assert_eq!(p.num_notes, 10_000);
        assert_eq!(p.num_attachments, 0);
        assert_eq!(p.topology_config.total_links, 30_000);
        // Must use connected-graph parameters.
        assert_eq!(p.topology_config.m0, 1);
        assert_eq!(p.topology_config.m, 3);
    }

    #[test]
    fn test_profile_bigfile() {
        let p = Profile::builtin("bigfile");
        assert_eq!(p.name, "bigfile");
        assert_eq!(p.mode, GenerationMode::Exact);
        assert_eq!(p.num_notes, 4);
        assert_eq!(p.topology_config.total_links, 0);
    }

    #[test]
    fn test_profile_rename_sync() {
        let p = Profile::builtin("rename-sync");
        assert_eq!(p.name, "rename-sync");
        assert_eq!(p.mode, GenerationMode::Exact);
        assert_eq!(p.num_notes, 101);
        assert_eq!(p.topology_config.total_links, 500);
    }

    #[test]
    #[should_panic(expected = "Unknown builtin profile")]
    fn test_profile_unknown_panics() {
        let _ = Profile::builtin("nonexistent");
    }

    // --- list_builtin_profiles ---

    #[test]
    fn test_list_builtin_profiles() {
        let names = list_builtin_profiles();
        assert_eq!(names.len(), 11);
        assert!(names.contains(&"smoke"));
        assert!(names.contains(&"standard-10k"));
        assert!(names.contains(&"large-100k"));
        assert!(names.contains(&"graph-bench"));
        assert!(names.contains(&"bigfile"));
        assert!(names.contains(&"rename-sync"));
    }

    // --- Archetype ratios ---

    #[test]
    fn test_default_archetype_ratios_sum() {
        let ratios = default_archetype_ratios();
        let sum: f64 = ratios.iter().map(|(_, w)| w).sum();
        // Allow a tiny fp-impression slack.
        assert!((sum - 1.0).abs() < 1e-12);
    }

    #[test]
    fn test_assign_archetypes_count() {
        let mut rng = test_rng();
        let ratios = default_archetype_ratios();
        let result = assign_archetypes(1000, &ratios, &mut rng);
        assert_eq!(result.len(), 1000);
    }

    #[test]
    fn test_assign_archetypes_all_valid() {
        let mut rng = test_rng();
        let ratios = default_archetype_ratios();
        let valid: Vec<Archetype> = ratios.iter().map(|(a, _)| *a).collect();
        let result = assign_archetypes(500, &ratios, &mut rng);
        for a in &result {
            assert!(valid.contains(a), "Unexpected archetype {a:?}");
        }
    }

    #[test]
    fn test_assign_archetypes_zero_docs() {
        let mut rng = test_rng();
        let ratios = default_archetype_ratios();
        let result = assign_archetypes(0, &ratios, &mut rng);
        assert!(result.is_empty());
    }

    #[test]
    fn test_assign_archetypes_deterministic() {
        let ratios = default_archetype_ratios();
        let a = {
            let mut rng = ChaCha20Rng::seed_from_u64(123);
            assign_archetypes(200, &ratios, &mut rng)
        };
        let b = {
            let mut rng = ChaCha20Rng::seed_from_u64(123);
            assign_archetypes(200, &ratios, &mut rng)
        };
        assert_eq!(a, b);
    }

    // --- generate_filename ---

    #[test]
    fn test_generate_filename_has_extension() {
        let mut rng = test_rng();
        for _ in 0..200 {
            let name = generate_filename(&mut rng);
            assert!(name.ends_with(".md"), "Filename should end with .md: {name}");
        }
    }

    #[test]
    fn test_generate_filename_no_reserved() {
        let mut rng = test_rng();
        for _ in 0..500 {
            let name = generate_filename(&mut rng);
            let stem = name.strip_suffix(".md").unwrap();
            assert!(
                !is_windows_reserved(stem),
                "Filename stem should not be Windows reserved: {stem}"
            );
        }
    }

    #[test]
    fn test_generate_filename_non_empty() {
        let mut rng = test_rng();
        for _ in 0..200 {
            let name = generate_filename(&mut rng);
            assert!(!name.is_empty());
            assert!(name.len() > 4); // at least ".md"
        }
    }

    // --- generate_paths ---

    #[test]
    fn test_generate_paths_count() {
        let mut rng = test_rng();
        let config = DepthConfig::default();
        let paths = generate_paths(100, &config, &mut rng);
        assert_eq!(paths.len(), 100);
    }

    #[test]
    fn test_generate_paths_unique() {
        let mut rng = test_rng();
        let config = DepthConfig::default();
        let paths = generate_paths(500, &config, &mut rng);
        let unique: std::collections::HashSet<_> = paths.iter().collect();
        assert!(unique.len() == paths.len(), "Paths must be unique");
    }

    #[test]
    fn test_generate_paths_path_length() {
        let mut rng = test_rng();
        let config = DepthConfig::default();
        let paths = generate_paths(500, &config, &mut rng);
        for p in &paths {
            assert!(
                p.len() <= MAX_PATH_BYTES,
                "Path too long ({} > {MAX_PATH_BYTES}): {p}",
                p.len()
            );
        }
    }

    #[test]
    fn test_generate_paths_no_reserved_stems() {
        let mut rng = test_rng();
        let config = DepthConfig::default();
        let paths = generate_paths(500, &config, &mut rng);
        for p in &paths {
            let filename = p.rsplit('/').next().unwrap();
            let stem = filename.strip_suffix(".md").unwrap_or(filename);
            assert!(
                !is_windows_reserved(stem),
                "Reserved filename stem: {stem} in path {p}"
            );
        }
    }

    #[test]
    fn test_generate_paths_deterministic() {
        let config = DepthConfig::default();
        let a = {
            let mut rng = ChaCha20Rng::seed_from_u64(99);
            generate_paths(200, &config, &mut rng)
        };
        let b = {
            let mut rng = ChaCha20Rng::seed_from_u64(99);
            generate_paths(200, &config, &mut rng)
        };
        assert_eq!(a, b);
    }

    #[test]
    fn test_generate_paths_zero() {
        let mut rng = test_rng();
        let config = DepthConfig::default();
        let paths = generate_paths(0, &config, &mut rng);
        assert!(paths.is_empty());
    }

    #[test]
    fn test_generate_paths_root_depth_possible() {
        // With a config that only allows depth 0, every path should be a
        // bare filename.
        let mut rng = test_rng();
        let config = DepthConfig {
            weights: vec![(0, 1.0)],
        };
        let paths = generate_paths(100, &config, &mut rng);
        assert_eq!(paths.len(), 100);
        for p in &paths {
            assert!(!p.contains('/'), "Root-depth path should not contain '/': {p}");
        }
    }

    // --- is_windows_reserved ---

    #[test]
    fn test_is_windows_reserved_names() {
        for name in &["con", "CON", "Con", "nul", "NUL", "com1", "lpt9"] {
            assert!(is_windows_reserved(name), "{name} should be reserved");
        }
    }

    #[test]
    fn test_is_windows_reserved_with_ext() {
        assert!(is_windows_reserved("con.md"));
        assert!(is_windows_reserved("NUL.md"));
    }

    #[test]
    fn test_is_not_windows_reserved() {
        for name in &["note", "index", "project", "日记", "项目"] {
            assert!(!is_windows_reserved(name), "{name} should not be reserved");
        }
    }

    // --- DepthConfig defaults ---

    #[test]
    fn test_depth_config_default_weights_sum() {
        let cfg = DepthConfig::default();
        let sum: f64 = cfg.weights.iter().map(|(_, w)| w).sum();
        assert!((sum - 1.0).abs() < 1e-12);
    }

    // --- enforce_path_length ---

    #[test]
    fn test_enforce_path_length_short_path_unchanged() {
        let short = "a/b/c/note.md";
        assert_eq!(enforce_path_length(short), short);
    }

    #[test]
    fn test_enforce_path_length_cuts_stem() {
        let long_stem = "a/".to_string().repeat(20) + &"x".repeat(300) + ".md";
        let result = enforce_path_length(&long_stem);
        assert!(result.len() <= MAX_PATH_BYTES);
        assert!(result.ends_with(".md"));
    }

    // --- sample_depth ---

    #[test]
    fn test_sample_depth_respects_config() {
        let mut rng = test_rng();
        let config = DepthConfig {
            weights: vec![(2, 1.0)], // always depth 2
        };
        for _ in 0..100 {
            assert_eq!(sample_depth(&config, &mut rng), 2);
        }
    }
}
