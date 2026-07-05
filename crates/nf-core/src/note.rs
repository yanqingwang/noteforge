use crate::link::Link;
use crate::span::Span;
use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;

/// A heading in a note.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct Heading {
    pub level: u8,
    pub text: String,
    pub span: Span,
    pub line: usize,
}

/// A block ID marker (`^block-id`).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct BlockId {
    pub id: String,
    pub span: Span,
}

/// Note frontmatter metadata (parsed YAML).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct Frontmatter {
    pub fields: BTreeMap<String, serde_json::Value>,
}

impl Frontmatter {
    pub fn new() -> Self {
        Frontmatter {
            fields: BTreeMap::new(),
        }
    }

    pub fn tags(&self) -> Vec<String> {
        self.fields
            .get("tags")
            .and_then(|v| v.as_array())
            .map(|arr| {
                arr.iter()
                    .filter_map(|v| v.as_str().map(String::from))
                    .collect()
            })
            .unwrap_or_default()
    }

    pub fn aliases(&self) -> Vec<String> {
        self.fields
            .get("aliases")
            .and_then(|v| v.as_array())
            .map(|arr| {
                arr.iter()
                    .filter_map(|v| v.as_str().map(String::from))
                    .collect()
            })
            .unwrap_or_default()
    }
}

impl Default for Frontmatter {
    fn default() -> Self {
        Self::new()
    }
}

/// Structured metadata recorded for each note (matches manifest files.jsonl schema).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct NoteMeta {
    pub path: String,
    pub size: usize,
    pub sha256: String,
    pub archetype: String,
    pub line_ending: String,
    pub frontmatter: Frontmatter,
    pub headings: Vec<Heading>,
    pub tags_inline: Vec<TagInline>,
    pub block_ids: Vec<BlockId>,
    pub links_out: Vec<Link>,
}

/// Inline tag with its span.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct TagInline {
    pub tag: String,
    pub span: Span,
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_frontmatter_empty() {
        let fm = Frontmatter::new();
        assert!(fm.tags().is_empty());
        assert!(fm.aliases().is_empty());
    }

    #[test]
    fn test_frontmatter_with_tags() {
        let mut fields = BTreeMap::new();
        fields.insert(
            "tags".into(),
            serde_json::json!(["AI", "机器学习"]),
        );
        let fm = Frontmatter { fields };
        assert_eq!(fm.tags(), vec!["AI", "机器学习"]);
    }

    #[test]
    fn test_notemeta_serde() {
        let meta = NoteMeta {
            path: "test.md".into(),
            size: 100,
            sha256: "abc".into(),
            archetype: "zettel".into(),
            line_ending: "lf".into(),
            frontmatter: Frontmatter::new(),
            headings: vec![],
            tags_inline: vec![],
            block_ids: vec![],
            links_out: vec![],
        };
        let json = serde_json::to_string(&meta).unwrap();
        let back: NoteMeta = serde_json::from_str(&json).unwrap();
        assert_eq!(meta, back);
    }
}
