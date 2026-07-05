use anyhow::{Context, Result};
use nf_core::note::NoteMeta;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::fs;
use std::io::Write;
use std::path::Path;

/// Vault-level summary (matches summary.json schema).
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct VaultSummary {
    pub generator_version: String,
    pub profile: String,
    pub seed: u64,
    pub mode: String,
    pub counts: VaultCounts,
    pub graph: GraphSummary,
    pub vault_sha256: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct VaultCounts {
    pub notes: usize,
    pub attachments: usize,
    pub dirs: usize,
    pub links_total: usize,
    pub links_resolved: usize,
    pub links_broken: usize,
    pub embeds: usize,
    pub orphan_notes: usize,
    pub tags_unique: usize,
    pub block_ids: usize,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct GraphSummary {
    pub max_out_degree: usize,
    pub connected_components: usize,
}

/// An edge in the internal link graph.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct GraphEdge {
    pub source: String,
    pub target: String,
    #[serde(rename = "kind")]
    pub link_kind: String,
    pub resolved: bool,
}

/// Write all manifest files to `manifest_dir`.
///
/// Produces: summary.json, files.jsonl, graph.jsonl, checksums.txt
pub fn write_manifest(
    docs: &[NoteMeta],
    summary: &VaultSummary,
    graph_edges: &[GraphEdge],
    manifest_dir: &Path,
) -> Result<()> {
    fs::create_dir_all(manifest_dir)?;

    // summary.json
    let summary_path = manifest_dir.join("summary.json");
    let summary_json = serde_json::to_string_pretty(summary)?;
    fs::write(&summary_path, &summary_json)
        .with_context(|| format!("writing {}", summary_path.display()))?;

    // files.jsonl
    let files_path = manifest_dir.join("files.jsonl");
    let mut files_out = fs::File::create(&files_path)
        .with_context(|| format!("creating {}", files_path.display()))?;
    for doc in docs {
        let line = serde_json::to_string(doc)?;
        writeln!(files_out, "{line}")?;
    }
    files_out.flush()?;

    // graph.jsonl
    let graph_path = manifest_dir.join("graph.jsonl");
    let mut graph_out = fs::File::create(&graph_path)
        .with_context(|| format!("creating {}", graph_path.display()))?;
    for edge in graph_edges {
        let line = serde_json::to_string(edge)?;
        writeln!(graph_out, "{line}")?;
    }
    graph_out.flush()?;

    // checksums.txt (one SHA-256 per file, relative paths)
    let checksums_path = manifest_dir.join("checksums.txt");
    let mut cs_out = fs::File::create(&checksums_path)
        .with_context(|| format!("creating {}", checksums_path.display()))?;
    for doc in docs {
        writeln!(cs_out, "{}  {}", doc.sha256, doc.path)?;
    }
    cs_out.flush()?;

    Ok(())
}

/// Build graph edges from all docs' `links_out`.
pub fn build_graph_edges(docs: &[NoteMeta]) -> Vec<GraphEdge> {
    let mut edges = Vec::new();
    for doc in docs {
        for link in &doc.links_out {
            // Skip external links for the graph
            if link.kind == nf_core::link::LinkKind::External {
                continue;
            }
            edges.push(GraphEdge {
                source: doc.path.clone(),
                target: link.target.clone(),
                link_kind: link_kind_as_str(link),
                resolved: link.resolves_to.is_some(),
            });
        }
    }
    edges
}

/// Infer the link morphology from a Link's fields for graph.jsonl output.
/// Preserves the distinction between wikilink, alias, heading, and block variations.
fn link_kind_as_str(link: &nf_core::link::Link) -> String {
    match link.kind {
        nf_core::link::LinkKind::Embed => "embed".into(),
        nf_core::link::LinkKind::MdLink => "md_link".into(),
        nf_core::link::LinkKind::External => "external".into(),
        nf_core::link::LinkKind::Wikilink => {
            if link.display.is_some() {
                "wikilink_alias".into()
            } else if let Some(ref sub) = link.subpath {
                if sub.starts_with("#^") {
                    "wikilink_block".into()
                } else {
                    "wikilink_heading".into()
                }
            } else {
                "wikilink".into()
            }
        }
    }
}

/// Compute SHA-256 hex digest for a byte slice.
pub fn sha256_digest(data: &[u8]) -> String {
    let mut hasher = Sha256::new();
    hasher.update(data);
    format!("{:x}", hasher.finalize())
}

/// Compute SHA-256 for a file on disk.
pub fn sha256_file(path: &Path) -> Result<String> {
    let data = fs::read(path)?;
    Ok(sha256_digest(&data))
}

/// Compute total count of unique tags across all docs.
pub fn count_unique_tags(docs: &[NoteMeta]) -> usize {
    let mut tags = std::collections::BTreeSet::new();
    for doc in docs {
        for tag in &doc.frontmatter.tags() {
            tags.insert(tag.clone());
        }
        for tag in &doc.tags_inline {
            tags.insert(tag.tag.clone());
        }
    }
    tags.len()
}

/// Count orphan notes (notes with 0 incoming and 0 outgoing links).
pub fn count_orphans(docs: &[NoteMeta]) -> usize {
    let mut has_outgoing = std::collections::BTreeSet::new();
    let mut has_incoming: std::collections::BTreeSet<String> = std::collections::BTreeSet::new();

    for doc in docs {
        if !doc.links_out.is_empty() {
            has_outgoing.insert(doc.path.clone());
        }
        for link in &doc.links_out {
            if let Some(ref resolved) = link.resolves_to {
                has_incoming.insert(resolved.clone());
            }
        }
    }

    docs.iter()
        .filter(|d| !has_outgoing.contains(&d.path) && !has_incoming.contains(&d.path))
        .count()
}

/// Count connected components using BFS.
pub fn count_connected_components(docs: &[NoteMeta]) -> usize {
    // Build adjacency list
    let mut adj: std::collections::BTreeMap<&str, Vec<&str>> = std::collections::BTreeMap::new();
    for doc in docs {
        adj.entry(&doc.path).or_default();
        for link in &doc.links_out {
            if let Some(ref resolved) = link.resolves_to {
                adj.entry(&doc.path).or_default().push(resolved);
                adj.entry(resolved.as_str()).or_default().push(&doc.path);
            }
        }
    }

    let mut visited = std::collections::BTreeSet::new();
    let mut components = 0;

    for node in adj.keys() {
        if visited.contains(*node) {
            continue;
        }
        components += 1;
        // BFS
        let mut stack = vec![*node];
        while let Some(n) = stack.pop() {
            if !visited.insert(n) {
                continue;
            }
            if let Some(neighbors) = adj.get(n) {
                for nb in neighbors {
                    if !visited.contains(nb) {
                        stack.push(nb);
                    }
                }
            }
        }
    }

    components
}

#[cfg(test)]
mod tests {
    use super::*;
    use nf_core::link::{Link, LinkKind};
    use nf_core::note::{Frontmatter, TagInline};
    use nf_core::span::Span;

    fn make_doc(path: &str, links: Vec<Link>) -> NoteMeta {
        NoteMeta {
            path: path.into(),
            size: 100,
            sha256: "abc".into(),
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
    fn test_build_graph_edges_empty() {
        let edges = build_graph_edges(&[]);
        assert!(edges.is_empty());
    }

    #[test]
    fn test_build_graph_edges_basic() {
        let link = Link {
            raw: "[[target]]".into(),
            kind: LinkKind::Wikilink,
            target: "target".into(),
            subpath: None,
            display: None,
            span: Span::new(0, 10).unwrap(),
            resolves_to: Some("target.md".into()),
            ambiguous: false,
        };
        let doc = make_doc("source.md", vec![link]);
        let edges = build_graph_edges(&[doc]);
        assert_eq!(edges.len(), 1);
        assert_eq!(edges[0].source, "source.md");
        assert_eq!(edges[0].target, "target");
        assert!(edges[0].resolved);
    }

    #[test]
    fn test_count_orphans() {
        let link = Link {
            raw: "[[target]]".into(),
            kind: LinkKind::Wikilink,
            target: "target".into(),
            subpath: None,
            display: None,
            span: Span::new(0, 10).unwrap(),
            resolves_to: Some("target.md".into()),
            ambiguous: false,
        };
        let with_links = make_doc("source.md", vec![link]);
        let without_links = make_doc("orphan.md", vec![]);
        let orphans = count_orphans(&[with_links, without_links]);
        assert_eq!(orphans, 1);
    }

    #[test]
    fn test_sha256_digest_known() {
        let digest = sha256_digest(b"hello");
        assert_eq!(
            digest,
            "2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824"
        );
    }

    #[test]
    fn test_manifest_files_written() {
        let dir = tempfile::tempdir().unwrap();
        let doc = make_doc("test.md", vec![]);
        let summary = VaultSummary {
            generator_version: "1.0.0".into(),
            profile: "smoke".into(),
            seed: 42,
            mode: "exact".into(),
            counts: VaultCounts {
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
            graph: GraphSummary {
                max_out_degree: 0,
                connected_components: 0,
            },
            vault_sha256: "abc".into(),
        };
        let edges = build_graph_edges(&[doc.clone()]);
        write_manifest(&[doc], &summary, &edges, dir.path()).unwrap();

        assert!(dir.path().join("summary.json").exists());
        assert!(dir.path().join("files.jsonl").exists());
        assert!(dir.path().join("graph.jsonl").exists());
        assert!(dir.path().join("checksums.txt").exists());
    }

    #[test]
    fn test_count_unique_tags() {
        let doc = NoteMeta {
            path: "test.md".into(),
            size: 0,
            sha256: "".into(),
            archetype: "zettel".into(),
            line_ending: "lf".into(),
            frontmatter: {
                let mut fm = Frontmatter::new();
                fm.fields
                    .insert("tags".into(), serde_json::json!(["AI", "机器学习"]));
                fm
            },
            headings: vec![],
            tags_inline: vec![
                TagInline {
                    tag: "NLP".into(),
                    span: Span::new(0, 4).unwrap(),
                },
            ],
            block_ids: vec![],
            links_out: vec![],
        };
        assert_eq!(count_unique_tags(&[doc]), 3);
    }
}
