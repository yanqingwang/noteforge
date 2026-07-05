use rand::Rng;
use rand::SeedableRng;
use sha2::Digest;

pub mod corpus;
pub mod ir;
pub mod manifest;
pub mod profiles;
pub mod serialize;
pub mod topology;
pub mod verify;

/// Generate a test vault according to the specified profile and seed.
///
/// Returns the vault summary on success.
pub fn generate(
    profile: &str,
    seed: u64,
    out_dir: &std::path::Path,
) -> anyhow::Result<manifest::VaultSummary> {
    let profile_obj = profiles::Profile::builtin(profile);

    let mut rng = rand_chacha::ChaCha20Rng::seed_from_u64(seed);

    // 1. Generate paths
    let paths = profiles::generate_paths(profile_obj.num_notes, &profiles::DepthConfig::default(), &mut rng);

    // 2. Assign archetypes
    let archetypes = profiles::assign_archetypes(
        profile_obj.num_notes,
        &profile_obj.archetype_ratios,
        &mut rng,
    );

    // 3. Generate topology
    let topology = topology::generate_topology(
        profile_obj.num_notes,
        &profile_obj.topology_config,
        &mut rng,
    );

    // 4. For rename-sync, replace topology with structured links: 100 referrers → 1 target
    let topology = if profile == "rename-sync" && paths.len() >= 101 {
        let mut edges = Vec::new();
        let kinds = [
            crate::ir::LinkSyntax::Wikilink, crate::ir::LinkSyntax::WikilinkAlias,
            crate::ir::LinkSyntax::WikilinkHeading, crate::ir::LinkSyntax::WikilinkBlock,
            crate::ir::LinkSyntax::Embed, crate::ir::LinkSyntax::MdLink,
        ];
        for ref_idx in 1..101 { // 100 referrers
            for ki in 0..5 { // 5 links each = 500 total
                let kind = kinds[(ref_idx + ki) % kinds.len()];
                edges.push(topology::GraphEdge {
                    source: ref_idx,
                    target: 0, // all to target doc 0
                    kind,
                    broken: false,
                    bidirectional: false,
                });
            }
        }
        // Build degrees
        let mut out_degrees = vec![0usize; paths.len()];
        let mut in_degrees = vec![0usize; paths.len()];
        for e in &edges {
            out_degrees[e.source] += 1;
            in_degrees[e.target] += 1;
        }
        topology::LinkGraph { edges, out_degrees, in_degrees, orphans: vec![] }
    } else {
        topology
    };

    // 5. Build set of all paths for link resolution
    let all_paths: std::collections::BTreeSet<String> = paths.iter().cloned().collect();

    // 5. Build DocPlans and serialize each
    let corpus_obj = crate::corpus::Corpus::new();
    let mut serialized_docs = Vec::new();

    for (i, path) in paths.iter().enumerate() {
        let archetype = archetypes[i];

        // Determine per-doc links from topology
        let doc_edges: Vec<&topology::GraphEdge> = topology
            .edges
            .iter()
            .filter(|e| e.source == i)
            .collect();

        let planned_links: Vec<crate::ir::PlannedLink> = doc_edges
            .iter()
            .map(|e| {
                let syntax = match e.kind {
                    crate::ir::LinkSyntax::Wikilink => crate::ir::LinkSyntax::Wikilink,
                    crate::ir::LinkSyntax::WikilinkAlias => crate::ir::LinkSyntax::WikilinkAlias,
                    crate::ir::LinkSyntax::WikilinkHeading => {
                        crate::ir::LinkSyntax::WikilinkHeading
                    }
                    crate::ir::LinkSyntax::WikilinkBlock => crate::ir::LinkSyntax::WikilinkBlock,
                    crate::ir::LinkSyntax::Embed => crate::ir::LinkSyntax::Embed,
                    crate::ir::LinkSyntax::MdLink => crate::ir::LinkSyntax::MdLink,
                };
                // Resolve target to actual file stem for proper link resolution
                let target_path = &paths[e.target];
                let stem = target_path
                    .strip_suffix(".md")
                    .unwrap_or(target_path);
                // Generate display text for aliased links and subpaths for heading/block links
                let display = match syntax {
                    crate::ir::LinkSyntax::WikilinkAlias => {
                        Some(corpus_obj.generate_sentence(&mut rng, 2))
                    }
                    _ => None,
                };
                let subpath = match syntax {
                    crate::ir::LinkSyntax::WikilinkHeading => {
                        Some(format!("#{}", corpus_obj.generate_sentence(&mut rng, 3)))
                    }
                    crate::ir::LinkSyntax::WikilinkBlock => {
                        let hex: String = (0..6).map(|_| {
                            "0123456789abcdef".chars().nth(rng.random_range(0..16)).unwrap()
                        }).collect();
                        Some(format!("#^{}", hex))
                    }
                    _ => None,
                };
                crate::ir::PlannedLink {
                    target: stem.to_string(),
                    syntax,
                    display,
                    subpath,
                    broken: e.broken,
                }
            })
            .collect();

        // Build DocPlan and serialize
        // Generate ~2KB of content per non-stub doc by repeating element generation
        let elements = match archetype {
            crate::ir::Archetype::Stub => vec![],
            _ => {
                let mut elems = Vec::new();
                // Repeat content section 10-18 times to reach realistic document sizes
                let sections = 10 + rng.random_range(0..9);
                for s in 0..sections {
                    if s == 0 || rng.random_range(0..100) < 40 {
                        elems.push(crate::ir::ContentElement::Heading {
                            level: 1 + (s % 3) as u8,
                            text: corpus_obj.generate_sentence(&mut rng, 4),
                        });
                    }
                    elems.push(crate::ir::ContentElement::Paragraph {
                        text: corpus_obj.generate_sentence(&mut rng, 12),
                    });
                    if rng.random_range(0..100) < 30 {
                        elems.push(crate::ir::ContentElement::CodeBlock {
                            language: ["rust", "python", "javascript", "yaml"][rng.random_range(0..4)].into(),
                            content: format!("// {}", corpus_obj.generate_sentence(&mut rng, 3)),
                        });
                    }
                    if rng.random_range(0..100) < 20 {
                        elems.push(crate::ir::ContentElement::UnorderedList {
                            items: vec![
                                corpus_obj.generate_sentence(&mut rng, 3),
                                corpus_obj.generate_sentence(&mut rng, 3),
                            ],
                            depth: 0,
                        });
                    }
                    if rng.random_range(0..100) < 12 {
                        elems.push(crate::ir::ContentElement::TaskList {
                            items: vec![
                                (true, corpus_obj.generate_sentence(&mut rng, 3)),
                                (false, corpus_obj.generate_sentence(&mut rng, 3)),
                            ],
                        });
                    }
                    if rng.random_range(0..100) < 15 && archetype == crate::ir::Archetype::Literature {
                        elems.push(crate::ir::ContentElement::BlockQuote {
                            content: corpus_obj.generate_sentence(&mut rng, 8),
                        });
                    }
                    if rng.random_range(0..100) < 8 && archetype == crate::ir::Archetype::Zettel {
                        elems.push(crate::ir::ContentElement::Callout {
                            kind: ["note", "tip", "warning", "important"][rng.random_range(0..4)].into(),
                            foldable: false,
                            content: corpus_obj.generate_sentence(&mut rng, 6),
                        });
                    }
                    if rng.random_range(0..100) < 6 {
                        elems.push(crate::ir::ContentElement::Math {
                            block: true,
                            content: "E = mc^2".into(),
                        });
                    }
                    if rng.random_range(0..100) < 8 {
                        elems.push(crate::ir::ContentElement::HorizontalRule);
                    }
                }
                elems
            }
        };

        let target_size = if profile == "bigfile" {
            // bigfile profile: 4 files at 1MB, 5MB, 10MB, 5MB (Chinese-heavy)
            [1_048_576usize, 5_242_880, 10_485_760, 5_242_880][i.min(3)]
        } else {
            0
        };

        // Vary frontmatter tags across 5 different values
        let fm_tags = [
            "auto-generated", "knowledge-base", "project", "reference", "draft",
        ];
        let fm_tag_idx = i % fm_tags.len();
        // Generate inline tags with simple pool
        let inline_tag_pool = [
            "networking", "algorithms", "systems", "AI", "ML",
            "security", "performance", "design", "testing", "devops",
        ];
        let inline_tags = if rng.random_range(0..100) < 40 && archetype != crate::ir::Archetype::Stub {
            vec![inline_tag_pool[i % inline_tag_pool.len()].to_string()]
        } else {
            vec![]
        };

        let plan = crate::ir::DocPlan {
            path: path.clone(),
            archetype,
            frontmatter_tags: vec![fm_tags[fm_tag_idx].into()],
            frontmatter_aliases: if i == 0 { vec![] } else { vec![corpus_obj.generate_sentence(&mut rng, 2)] },
            elements,
            links_out: planned_links,
            inline_tags,
            target_size_bytes: target_size,
        };

        let doc = crate::serialize::serialize_doc(&plan, Some(&corpus_obj), &mut rng, &all_paths);
        serialized_docs.push(doc);
    }

    // 6. Write files to disk
    let vault_dir = out_dir.join("vault");
    std::fs::create_dir_all(&vault_dir)?;

    for doc in &serialized_docs {
        let file_path = vault_dir.join(&doc.path);
        if let Some(parent) = file_path.parent() {
            std::fs::create_dir_all(parent)?;
        }
        // Atomic write: temp file + rename
        let tmp_path = file_path.with_extension("tmp");
        std::fs::write(&tmp_path, &doc.content)?;
        std::fs::rename(&tmp_path, &file_path)?;
    }

    // 7. Build manifest
    let metas: Vec<nf_core::note::NoteMeta> =
        serialized_docs.iter().map(|d| d.meta.clone()).collect();
    let graph_edges = crate::manifest::build_graph_edges(&metas);
    let unique_tags = crate::manifest::count_unique_tags(&metas);
    let orphans = crate::manifest::count_orphans(&metas);
    let components = crate::manifest::count_connected_components(&metas);
    let total_block_ids: usize = metas.iter().map(|m| m.block_ids.len()).sum();

    // Compute vault-level SHA-256
    let mut file_hasher = sha2::Sha256::new();
    for doc in &serialized_docs {
        let rel = doc.path.replace('\\', "/");
        file_hasher.update(rel.as_bytes());
        file_hasher.update(&[0u8]);
        file_hasher.update(&doc.content);
        file_hasher.update(&[0u8]);
    }
    let vault_sha256_combined = format!("{:x}", file_hasher.finalize());

    let max_out_degree = topology
        .edges
        .iter()
        .fold(std::collections::HashMap::new(), |mut acc, e| {
            *acc.entry(e.source).or_insert(0) += 1;
            acc
        })
        .values()
        .max()
        .copied()
        .unwrap_or(0) as usize;

    let summary = crate::manifest::VaultSummary {
        generator_version: "0.1.0".into(),
        profile: profile.to_string(),
        seed,
        mode: "statistical".into(),
        counts: crate::manifest::VaultCounts {
            notes: metas.len(),
            attachments: 0,
            dirs: 0,
            links_total: graph_edges.len(),
            links_resolved: graph_edges.iter().filter(|e| e.resolved).count(),
            links_broken: graph_edges.iter().filter(|e| !e.resolved).count(),
            embeds: graph_edges
                .iter()
                .filter(|e| e.link_kind.contains("embed"))
                .count(),
            orphan_notes: orphans,
            tags_unique: unique_tags,
            block_ids: total_block_ids,
        },
        graph: crate::manifest::GraphSummary {
            max_out_degree,
            connected_components: components,
        },
        vault_sha256: vault_sha256_combined,
    };

    // Write manifest
    let manifest_dir = out_dir.join("manifest");
    crate::manifest::write_manifest(&metas, &summary, &graph_edges, &manifest_dir)?;

    Ok(summary)
}

/// Generate a vault in a temporary directory and return the summary.
/// Useful for testing — the temp dir is returned so the caller can inspect files.
pub fn generate_in_memory(
    profile: &str,
    seed: u64,
) -> anyhow::Result<(tempfile::TempDir, manifest::VaultSummary)> {
    let dir = tempfile::tempdir()?;
    let summary = generate(profile, seed, dir.path())?;
    Ok((dir, summary))
}
