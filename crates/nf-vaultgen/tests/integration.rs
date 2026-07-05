use std::path::Path;

/// Verify that generate produces the expected number of files for smoke profile.
#[test]
fn test_smoke_generates_50_notes() {
    let dir = tempfile::tempdir().unwrap();
    let summary = nf_vaultgen::generate("smoke", 42, dir.path()).unwrap();
    assert_eq!(summary.counts.notes, 50);
    // Verify vault directory has 50 .md files
    let vault_dir = dir.path().join("vault");
    let md_count = count_md_files(&vault_dir);
    assert_eq!(md_count, 50);
}

/// Verify that manifest files are all written.
#[test]
fn test_manifest_files_exist() {
    let dir = tempfile::tempdir().unwrap();
    let _summary = nf_vaultgen::generate("smoke", 42, dir.path()).unwrap();
    let manifest_dir = dir.path().join("manifest");
    assert!(manifest_dir.join("summary.json").exists());
    assert!(manifest_dir.join("files.jsonl").exists());
    assert!(manifest_dir.join("graph.jsonl").exists());
    assert!(manifest_dir.join("checksums.txt").exists());
}

/// Verify that same seed produces identical output (determinism).
#[test]
fn test_deterministic_generation() {
    let dir1 = tempfile::tempdir().unwrap();
    let dir2 = tempfile::tempdir().unwrap();
    let s1 = nf_vaultgen::generate("smoke", 42, dir1.path()).unwrap();
    let s2 = nf_vaultgen::generate("smoke", 42, dir2.path()).unwrap();
    assert_eq!(s1.vault_sha256, s2.vault_sha256);
}

/// Verify that different seeds produce different output.
#[test]
fn test_different_seeds_differ() {
    let dir1 = tempfile::tempdir().unwrap();
    let dir2 = tempfile::tempdir().unwrap();
    let s1 = nf_vaultgen::generate("smoke", 42, dir1.path()).unwrap();
    let s2 = nf_vaultgen::generate("smoke", 99, dir2.path()).unwrap();
    assert_ne!(s1.vault_sha256, s2.vault_sha256);
}

/// Verify generating with standard-10k profile works.
#[test]
fn test_standard_10k_generates_10000_notes() {
    let dir = tempfile::tempdir().unwrap();
    let summary = nf_vaultgen::generate("standard-10k", 42, dir.path()).unwrap();
    assert_eq!(summary.counts.notes, 10000);
}

/// Verify generate_in_memory works.
#[test]
fn test_generate_in_memory() {
    let (_dir, summary) = nf_vaultgen::generate_in_memory("smoke", 42).unwrap();
    assert_eq!(summary.counts.notes, 50);
}

/// Verify list-profiles returns expected profiles.
#[test]
fn test_list_profiles() {
    let profiles = nf_vaultgen::profiles::list_builtin_profiles();
    assert!(profiles.contains(&"smoke"));
    assert!(profiles.contains(&"standard-10k"));
    assert!(profiles.contains(&"large-100k"));
    assert!(profiles.contains(&"graph-bench"));
}

/// Verify that links resolve (manifest shows resolved > 0).
#[test]
fn test_links_resolve() {
    let dir = tempfile::tempdir().unwrap();
    let summary = nf_vaultgen::generate("smoke", 42, dir.path()).unwrap();
    assert!(
        summary.counts.links_resolved > 0,
        "expected resolved links > 0, got {}",
        summary.counts.links_resolved
    );
}

fn count_md_files(dir: &Path) -> usize {
    walkdir::WalkDir::new(dir)
        .into_iter()
        .filter_map(|e| e.ok())
        .filter(|e| e.file_type().is_file() && e.path().extension().is_some_and(|ext| ext == "md"))
        .count()
}
