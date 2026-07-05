use crate::ir::{Alignment, ContentElement, DocPlan, LinkSyntax, PlannedLink};
use nf_core::link::{Link, LinkKind};
use nf_core::note::{BlockId, Heading, NoteMeta, TagInline};
use nf_core::span::Span;
use sha2::{Digest, Sha256};
use std::collections::BTreeSet;

/// Output of serializing a single document.
#[derive(Debug, Clone)]
pub struct SerializedDoc {
    pub path: String,
    pub content: Vec<u8>,
    pub sha256: String,
    pub meta: NoteMeta,
}

/// Serialize a DocPlan to Markdown bytes, recording all spans.
///
/// The `corpus` is used to generate realistic text content for elements
/// that need random text. If `corpus` is None, placeholder text is used.
pub fn serialize_doc(
    plan: &DocPlan,
    _corpus: Option<&crate::corpus::Corpus>,
    _rng: &mut rand_chacha::ChaCha20Rng,
    all_paths: &BTreeSet<String>,
) -> SerializedDoc {
    let mut out = Vec::new();
    let mut headings = Vec::new();
    let mut tags_inline = Vec::new();
    let mut block_ids = Vec::new();
    let mut links_out = Vec::new();
    let _line_ending = "\n";

    // --- Frontmatter ---
    if !plan.frontmatter_tags.is_empty() || !plan.frontmatter_aliases.is_empty() {
        writeln_str(&mut out, "---");
        if !plan.frontmatter_tags.is_empty() {
            let tags_str = plan
                .frontmatter_tags
                .iter()
                .map(|t| format!("\"{t}\""))
                .collect::<Vec<_>>()
                .join(", ");
            writeln_str(&mut out, &format!("tags: [{}]", tags_str));
        }
        if !plan.frontmatter_aliases.is_empty() {
            let aliases_str = plan
                .frontmatter_aliases
                .iter()
                .map(|a| format!("\"{a}\""))
                .collect::<Vec<_>>()
                .join(", ");
            writeln_str(&mut out, &format!("aliases: [{}]", aliases_str));
        }
        writeln_str(&mut out, "---");
        writeln_str(&mut out, "");
    }

    // --- Content Elements ---
    for elem in &plan.elements {
        match elem {
            ContentElement::Heading { level, text } => {
                let prefix = "#".repeat(*level as usize);
                let line = format!("{prefix} {text}");
                let start = out.len();
                let heading_end = start + line.len(); // before the \n that writeln_str adds
                writeln_str(&mut out, &line);
                writeln_str(&mut out, "");
                headings.push(Heading {
                    level: *level,
                    text: text.clone(),
                    span: Span::new(start, heading_end).unwrap(),
                    line: out.iter().filter(|&&b| b == b'\n').count(),
                });
            }

            ContentElement::Paragraph { text } => {
                writeln_str(&mut out, text);
                writeln_str(&mut out, "");
            }

            ContentElement::UnorderedList { items, depth } => {
                let indent = "  ".repeat(*depth as usize);
                for item in items {
                    writeln_str(&mut out, &format!("{indent}- {item}"));
                }
                writeln_str(&mut out, "");
            }

            ContentElement::OrderedList { items, depth } => {
                let indent = "  ".repeat(*depth as usize);
                for (i, item) in items.iter().enumerate() {
                    writeln_str(&mut out, &format!("{indent}{}. {item}", i + 1));
                }
                writeln_str(&mut out, "");
            }

            ContentElement::TaskList { items } => {
                for (checked, text) in items {
                    let box_char = if *checked { "x" } else { " " };
                    writeln_str(&mut out, &format!("- [{box_char}] {text}"));
                }
                writeln_str(&mut out, "");
            }

            ContentElement::CodeBlock { language, content } => {
                writeln_str(&mut out, &format!("```{language}"));
                writeln_str(&mut out, content);
                writeln_str(&mut out, "```");
                writeln_str(&mut out, "");
            }

            ContentElement::Table {
                headers,
                rows,
                alignments,
            } => {
                // Header row
                let header_line = format!(
                    "| {} |",
                    headers
                        .iter()
                        .map(|h| escape_table_cell(h))
                        .collect::<Vec<_>>()
                        .join(" | ")
                );
                writeln_str(&mut out, &header_line);

                // Alignment row
                let align_line = format!(
                    "| {} |",
                    alignments
                        .iter()
                        .map(|a| match a {
                            Alignment::Left => ":---",
                            Alignment::Center => ":---:",
                            Alignment::Right => "---:",
                        })
                        .collect::<Vec<_>>()
                        .join(" | ")
                );
                writeln_str(&mut out, &align_line);

                // Data rows
                for row in rows {
                    let row_line = format!(
                        "| {} |",
                        row.iter()
                            .map(|c| escape_table_cell(c))
                            .collect::<Vec<_>>()
                            .join(" | ")
                    );
                    writeln_str(&mut out, &row_line);
                }
                writeln_str(&mut out, "");
            }

            ContentElement::Callout {
                kind,
                foldable,
                content,
            } => {
                let fold = if *foldable { "-" } else { "" };
                writeln_str(&mut out, &format!("> [!{kind}]{fold}"));
                for line in content.lines() {
                    writeln_str(&mut out, &format!("> {line}"));
                }
                writeln_str(&mut out, "");
            }

            ContentElement::Math { block, content } => {
                if *block {
                    writeln_str(&mut out, "$$");
                    writeln_str(&mut out, content);
                    writeln_str(&mut out, "$$");
                } else {
                    writeln_str(&mut out, &format!("${content}$"));
                }
                writeln_str(&mut out, "");
            }

            ContentElement::Footnote { id, content } => {
                writeln_str(&mut out, &format!("[^{id}]: {content}"));
                writeln_str(&mut out, "");
            }

            ContentElement::Comment { content } => {
                writeln_str(&mut out, &format!("%%{content}%%"));
                writeln_str(&mut out, "");
            }

            ContentElement::Highlight { text } => {
                writeln_str(&mut out, &format!("=={text}=="));
                writeln_str(&mut out, "");
            }

            ContentElement::BlockQuote { content } => {
                for line in content.lines() {
                    writeln_str(&mut out, &format!("> {line}"));
                }
                writeln_str(&mut out, "");
            }

            ContentElement::HorizontalRule => {
                writeln_str(&mut out, "---");
                writeln_str(&mut out, "");
            }
        }
    }

    // --- Links section ---
    // Insert planned links at the end of the content
    for planned in &plan.links_out {
        let raw = render_link(planned);
        let start = out.len();
        writeln_str(&mut out, &raw);
        writeln_str(&mut out, "");

        // span covers only the raw link text, excluding trailing newlines
        let span = Span::new(start, start + raw.len()).unwrap();
        let (kind, resolves_to, ambiguous) = resolve_link(planned, all_paths);

        links_out.push(Link {
            raw: raw.trim_end().to_string(),
            kind,
            target: planned.target.clone(),
            subpath: planned.subpath.clone(),
            display: planned.display.clone(),
            span,
            resolves_to,
            ambiguous,
        });
    }

    // --- Inline tags ---
    for tag in &plan.inline_tags {
        let tag_text = format!("#{tag}");
        let start = out.len();
        let tag_end = start + tag_text.len();
        writeln_str(&mut out, &tag_text);
        writeln_str(&mut out, "");
        tags_inline.push(TagInline {
            tag: tag.clone(),
            span: Span::new(start, tag_end).unwrap(),
        });
    }

    // --- Block IDs ---
    // ponytail: generates one block ID per doc using path hash
    // upgrade when the spec requires block-reference resolution testing
    {
        let path_hash: u64 = plan.path.bytes().fold(0u64, |acc, b| acc.wrapping_mul(31).wrapping_add(b as u64));
        let hex = format!("{:06x}", path_hash & 0xFFFFFF);
        let block_text = format!("^{}", hex);
        let start = out.len();
        writeln_str(&mut out, &block_text);
        writeln_str(&mut out, "");
        block_ids.push(BlockId {
            id: hex,
            span: Span::new(start, start + block_text.len()).unwrap(),
        });
    }

    // Pad output to target_size_bytes if specified (for bigfile profile)
    if plan.target_size_bytes > out.len() {
        let pad_line = b"Additional context and supporting details for this document section.\n\n";
        while out.len() < plan.target_size_bytes {
            out.extend_from_slice(pad_line);
        }
        // Truncate to exact target size, ensuring UTF-8 safety
        out.truncate(plan.target_size_bytes);
        // Pop any split multi-byte UTF-8 sequence at the truncation boundary
        while !out.is_empty() && out[out.len()-1] & 0x80 == 0x80 {
            out.pop();
        }
    }

    // Compute SHA-256
    let sha256 = {
        let mut hasher = Sha256::new();
        hasher.update(&out);
        format!("{:x}", hasher.finalize())
    };

    // Build NoteMeta
    let meta = NoteMeta {
        path: plan.path.clone(),
        size: out.len(),
        sha256: sha256.clone(),
        archetype: serde_json::to_value(&plan.archetype)
            .ok()
            .and_then(|v| v.as_str().map(String::from))
            .unwrap_or_default(),
        line_ending: "lf".into(),
        frontmatter: {
            let mut fm = nf_core::note::Frontmatter::new();
            if !plan.frontmatter_tags.is_empty() {
                let tags_val: Vec<serde_json::Value> = plan
                    .frontmatter_tags
                    .iter()
                    .map(|t| serde_json::Value::String(t.clone()))
                    .collect();
                fm.fields
                    .insert("tags".into(), serde_json::Value::Array(tags_val));
            }
            if !plan.frontmatter_aliases.is_empty() {
                let aliases_val: Vec<serde_json::Value> = plan
                    .frontmatter_aliases
                    .iter()
                    .map(|a| serde_json::Value::String(a.clone()))
                    .collect();
                fm.fields
                    .insert("aliases".into(), serde_json::Value::Array(aliases_val));
            }
            fm
        },
        headings,
        tags_inline,
        block_ids,
        links_out,
    };

    SerializedDoc {
        path: plan.path.clone(),
        content: out,
        sha256,
        meta,
    }
}

/// Helper: write a string as bytes, appending newline.
fn writeln_str(out: &mut Vec<u8>, s: &str) {
    out.extend_from_slice(s.as_bytes());
    out.push(b'\n');
}

/// Render a PlannedLink as Markdown text.
fn render_link(link: &PlannedLink) -> String {
    let target = &link.target;
    match link.syntax {
        LinkSyntax::Wikilink => format!("[[{target}]]"),
        LinkSyntax::WikilinkAlias => {
            let display = link.display.as_deref().unwrap_or(target);
            format!("[[{target}|{display}]]")
        }
        LinkSyntax::WikilinkHeading => {
            let subpath = link.subpath.as_deref().unwrap_or("#");
            format!("[[{target}{subpath}]]")
        }
        LinkSyntax::WikilinkBlock => {
            let subpath = link.subpath.as_deref().unwrap_or("#^block");
            format!("[[{target}{subpath}]]")
        }
        LinkSyntax::Embed => {
            format!("![[{target}]]")
        }
        LinkSyntax::MdLink => {
            let display = link.display.as_deref().unwrap_or(target);
            format!("[{display}]({target}.md)")
        }
    }
}

/// Resolve a planned link: determine its kind, resolved path, and ambiguity.
fn resolve_link(
    link: &PlannedLink,
    all_paths: &BTreeSet<String>,
) -> (LinkKind, Option<String>, bool) {
    let kind = match link.syntax {
        LinkSyntax::Embed => LinkKind::Embed,
        LinkSyntax::MdLink => LinkKind::MdLink,
        _ => LinkKind::Wikilink,
    };

    if link.broken {
        return (kind, None, false);
    }

    // Try to resolve: find paths that end with the target + ".md"
    let target_md = format!("{}.md", link.target);
    let matches: Vec<&String> = all_paths.iter().filter(|p| p.ends_with(&target_md)).collect();

    match matches.len() {
        0 => (kind, None, false), // broken
        1 => (kind, Some(matches[0].clone()), false),
        _ => (kind, Some(matches[0].clone()), true), // ambiguous, pick first
    }
}

/// Escape special chars for table cells.
fn escape_table_cell(s: &str) -> String {
    s.replace('|', "\\|")
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::ir::{Archetype, ContentElement, DocPlan, PlannedLink};
    use rand::SeedableRng;
    use std::collections::BTreeSet;

    #[test]
    fn test_serialize_empty_doc() {
        let plan = DocPlan {
            path: "empty.md".into(),
            archetype: Archetype::Stub,
            frontmatter_tags: vec![],
            frontmatter_aliases: vec![],
            elements: vec![],
            links_out: vec![],
            inline_tags: vec![],
            target_size_bytes: 0,
        };
        let mut rng = rand_chacha::ChaCha20Rng::seed_from_u64(42);
        let paths = BTreeSet::new();
        let result = serialize_doc(&plan, None, &mut rng, &paths);
        assert_eq!(result.path, "empty.md");
        assert!(result.meta.headings.is_empty());
        assert!(result.meta.links_out.is_empty());
    }

    #[test]
    fn test_serialize_heading() {
        let plan = DocPlan {
            path: "test.md".into(),
            archetype: Archetype::Zettel,
            frontmatter_tags: vec![],
            frontmatter_aliases: vec![],
            elements: vec![ContentElement::Heading {
                level: 2,
                text: "Test Heading".into(),
            }],
            links_out: vec![],
            inline_tags: vec![],
            target_size_bytes: 0,
        };
        let mut rng = rand_chacha::ChaCha20Rng::seed_from_u64(42);
        let paths = BTreeSet::new();
        let result = serialize_doc(&plan, None, &mut rng, &paths);
        assert_eq!(result.meta.headings.len(), 1);
        assert_eq!(result.meta.headings[0].level, 2);
        assert_eq!(result.meta.headings[0].text, "Test Heading");
        let content = String::from_utf8(result.content).unwrap();
        assert!(content.contains("## Test Heading"));
    }

    #[test]
    fn test_serialize_frontmatter() {
        let plan = DocPlan {
            path: "fm.md".into(),
            archetype: Archetype::Zettel,
            frontmatter_tags: vec!["AI".into(), "ML".into()],
            frontmatter_aliases: vec!["Machine Learning".into()],
            elements: vec![],
            links_out: vec![],
            inline_tags: vec![],
            target_size_bytes: 0,
        };
        let mut rng = rand_chacha::ChaCha20Rng::seed_from_u64(42);
        let paths = BTreeSet::new();
        let result = serialize_doc(&plan, None, &mut rng, &paths);
        let content = String::from_utf8(result.content).unwrap();
        assert!(content.contains("tags:"));
        assert!(content.contains("aliases:"));
        assert!(content.contains("AI"));
        assert!(content.contains("Machine Learning"));
    }

    #[test]
    fn test_render_link_wikilink() {
        let link = PlannedLink {
            target: "target".into(),
            syntax: LinkSyntax::Wikilink,
            display: None,
            subpath: None,
            broken: false,
        };
        assert_eq!(render_link(&link), "[[target]]");
    }

    #[test]
    fn test_render_link_alias() {
        let link = PlannedLink {
            target: "target".into(),
            syntax: LinkSyntax::WikilinkAlias,
            display: Some("Display".into()),
            subpath: None,
            broken: false,
        };
        assert_eq!(render_link(&link), "[[target|Display]]");
    }

    #[test]
    fn test_render_link_embed() {
        let link = PlannedLink {
            target: "image.png".into(),
            syntax: LinkSyntax::Embed,
            display: None,
            subpath: None,
            broken: false,
        };
        assert_eq!(render_link(&link), "![[image.png]]");
    }
}
