use anyhow::{Context, Result};
use nf_core::note::NoteMeta;
use sha2::{Digest, Sha256};
use std::fs;
use std::path::Path;

/// Verify a generated vault against its manifest.
///
/// Checks invariants I-01 through I-05 from the spec.
pub fn verify_vault(vault_dir: &Path, manifest_dir: &Path) -> Result<()> {
    // Read manifest files
    let summary_path = manifest_dir.join("summary.json");
    let files_path = manifest_dir.join("files.jsonl");
    let graph_path = manifest_dir.join("graph.jsonl");
    let checksums_path = manifest_dir.join("checksums.txt");

    if !summary_path.exists() {
        anyhow::bail!("I-FAIL: summary.json not found");
    }
    if !files_path.exists() {
        anyhow::bail!("I-FAIL: files.jsonl not found");
    }
    if !graph_path.exists() {
        anyhow::bail!("I-FAIL: graph.jsonl not found");
    }
    if !checksums_path.exists() {
        anyhow::bail!("I-FAIL: checksums.txt not found");
    }

    // Parse files.jsonl
    let files_content =
        fs::read_to_string(&files_path).context("reading files.jsonl")?;
    let mut docs: Vec<NoteMeta> = Vec::new();
    for line in files_content.lines() {
        if line.trim().is_empty() {
            continue;
        }
        let doc: NoteMeta =
            serde_json::from_str(line).context("parsing files.jsonl line")?;
        docs.push(doc);
    }

    // Parse graph.jsonl
    let graph_content =
        fs::read_to_string(&graph_path).context("reading graph.jsonl")?;
    let mut graph_edges: Vec<crate::manifest::GraphEdge> = Vec::new();
    for line in graph_content.lines() {
        if line.trim().is_empty() {
            continue;
        }
        let edge: crate::manifest::GraphEdge =
            serde_json::from_str(line).context("parsing graph.jsonl line")?;
        graph_edges.push(edge);
    }

    // I-01: graph.jsonl edge count == sum of resolved (non-external) links in files
    let total_links_from_docs: usize = docs
        .iter()
        .flat_map(|d| &d.links_out)
        .filter(|l| l.kind != nf_core::link::LinkKind::External)
        .count();
    if graph_edges.len() != total_links_from_docs {
        anyhow::bail!(
            "I-01 FAIL: graph.jsonl has {} edges, but docs have {} non-external links",
            graph_edges.len(),
            total_links_from_docs
        );
    }

    // I-03: Each span slices to match its raw text
    for doc in &docs {
        let file_path = vault_dir.join(&doc.path);
        if !file_path.exists() {
            // Skip - file might not be present for this verification
            continue;
        }
        let content = fs::read(&file_path)
            .with_context(|| format!("reading {}", file_path.display()))?;
        for link in &doc.links_out {
            let span = &link.span;
            if span.end > content.len() {
                anyhow::bail!(
                    "I-03 FAIL: {} link span [{},{}) exceeds file length {}",
                    doc.path,
                    span.start,
                    span.end,
                    content.len()
                );
            }
            let slice = &content[span.start..span.end];
            let slice_str =
                String::from_utf8_lossy(slice).trim_end().to_string();
            // The raw might have trailing whitespace stripped; compare trimmed
            let raw_trimmed = link.raw.trim();
            if slice_str != raw_trimmed {
                anyhow::bail!(
                    "I-03 FAIL: {} link span [{},{}) slices to {:?}, expected {:?}",
                    doc.path,
                    span.start,
                    span.end,
                    slice_str,
                    raw_trimmed
                );
            }
        }
    }

    // I-04: counts.* matches actual files
    let summary_content = fs::read_to_string(&summary_path)
        .context("reading summary.json")?;
    let summary: crate::manifest::VaultSummary = serde_json::from_str(&summary_content)
        .context("parsing summary.json")?;
    if summary.counts.notes != docs.len() {
        anyhow::bail!(
            "I-04 FAIL: summary counts notes={} but files.jsonl has {} entries",
            summary.counts.notes,
            docs.len()
        );
    }
    let actual_broken = docs.iter().flat_map(|d| &d.links_out).filter(|l| l.resolves_to.is_none()).count();
    if summary.counts.links_broken != actual_broken {
        anyhow::bail!(
            "I-04 FAIL: summary counts links_broken={} but actual broken links in files={}",
            summary.counts.links_broken, actual_broken
        );
    }
    let actual_orphans = crate::manifest::count_orphans(&docs);
    if summary.counts.orphan_notes != actual_orphans {
        anyhow::bail!(
            "I-04 FAIL: summary counts orphan_notes={} but actual orphans={}",
            summary.counts.orphan_notes, actual_orphans
        );
    }

    // I-02: Verify backlinks can be derived from graph edges (invertibility)
    // For every resolved link A→B, B should appear in reverse edges
    let reverse_edges: std::collections::BTreeMap<&str, Vec<&str>> = {
        let mut m: std::collections::BTreeMap<&str, Vec<&str>> = std::collections::BTreeMap::new();
        for edge in &graph_edges {
            if edge.resolved {
                m.entry(edge.target.as_str()).or_default().push(edge.source.as_str());
            }
        }
        m
    };
    for doc in &docs {
        if let Some(backlinks) = reverse_edges.get(doc.path.as_str()) {
            for link in &doc.links_out {
                if let Some(ref resolved) = link.resolves_to {
                    if !backlinks.contains(&resolved.as_str()) {
                        anyhow::bail!(
                            "I-02 FAIL: {} has link to {} but no backlink entry in reverse edges",
                            doc.path, resolved
                        );
                    }
                }
            }
        }
    }

    // I-05: SHA-256 checksums match
    for doc in &docs {
        let file_path = vault_dir.join(&doc.path);
        if !file_path.exists() {
            continue;
        }
        let content = fs::read(&file_path)
            .with_context(|| format!("reading {} for checksum", file_path.display()))?;
        let computed = {
            let mut hasher = Sha256::new();
            hasher.update(&content);
            format!("{:x}", hasher.finalize())
        };
        if computed != doc.sha256 {
            anyhow::bail!(
                "I-05 FAIL: {} SHA-256 mismatch: manifest says {}, computed {}",
                doc.path,
                doc.sha256,
                computed
            );
        }
    }

    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use nf_core::link::Link;
    use nf_core::note::{Frontmatter, NoteMeta};
    fn make_doc(path: &str, links: Vec<Link>) -> NoteMeta {
        NoteMeta {
            path: path.into(),
            size: 100,
            sha256: crate::manifest::sha256_digest(b"test content"),
            archetype: "zettel".into(),
            line_ending: "lf".into(),
            frontmatter: Frontmatter::new(),
            headings: vec![],
            tags_inline: vec![],
            block_ids: vec![],
            links_out: links,
        }
    }

    #[test]
    fn test_verify_missing_manifest_fails() {
        let tmp = tempfile::tempdir().unwrap();
        let vault_dir = tmp.path().join("vault");
        let manifest_dir = tmp.path().join("manifest");
        fs::create_dir_all(&vault_dir).unwrap();
        fs::create_dir_all(&manifest_dir).unwrap();
        // No manifest files written
        let result = verify_vault(&vault_dir, &manifest_dir);
        assert!(result.is_err());
    }

    #[test]
    fn test_verify_passes_on_valid_manifest() {
        let tmp = tempfile::tempdir().unwrap();
        let vault_dir = tmp.path().join("vault");
        let manifest_dir = tmp.path().join("manifest");
        fs::create_dir_all(&vault_dir).unwrap();
        fs::create_dir_all(&manifest_dir).unwrap();

        let doc = make_doc("test.md", vec![]);
        // Write the file with matching content
        let file_path = vault_dir.join("test.md");
        fs::write(&file_path, b"test content").unwrap();

        let summary = crate::manifest::VaultSummary {
            generator_version: "1.0.0".into(),
            profile: "smoke".into(),
            seed: 42,
            mode: "exact".into(),
            counts: crate::manifest::VaultCounts {
                notes: 1,
                attachments: 0,
                dirs: 0,
                links_total: 0,
                links_resolved: 0,
                links_broken: 0,
                embeds: 0,
                orphan_notes: 1,
                tags_unique: 0,
                block_ids: 0,
            },
            graph: crate::manifest::GraphSummary {
                max_out_degree: 0,
                connected_components: 0,
            },
            vault_sha256: "abc".into(),
        };
        let edges = crate::manifest::build_graph_edges(&[doc.clone()]);
        crate::manifest::write_manifest(&[doc], &summary, &edges, &manifest_dir)
            .unwrap();

        let result = verify_vault(&vault_dir, &manifest_dir);
        assert!(result.is_ok(), "verify should pass: {:?}", result.err());
    }
}
