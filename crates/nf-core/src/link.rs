use crate::span::Span;
use serde::{Deserialize, Serialize};

/// The kind of link syntax used.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum LinkKind {
    Wikilink,
    Embed,
    MdLink,
    External,
}

/// A single link extracted from a note.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Link {
    /// Raw text including delimiters, e.g. `[[target|display]]`
    pub raw: String,
    pub kind: LinkKind,
    /// The link target (file name, URL, etc.)
    pub target: String,
    /// Optional subpath: `#heading` or `#^block_id`
    pub subpath: Option<String>,
    /// Optional display text (after `|`)
    pub display: Option<String>,
    /// Byte span in the source file
    pub span: Span,
    /// Resolved absolute path within vault, or None if broken
    pub resolves_to: Option<String>,
    /// True if the link is ambiguous (multiple files match)
    pub ambiguous: bool,
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_link_serde_roundtrip() {
        let l = Link {
            raw: "[[target|Display]]".into(),
            kind: LinkKind::Wikilink,
            target: "target".into(),
            subpath: None,
            display: Some("Display".into()),
            span: crate::Span::new(0, 19).unwrap(),
            resolves_to: Some("path/to/target.md".into()),
            ambiguous: false,
        };
        let json = serde_json::to_string(&l).unwrap();
        let back: Link = serde_json::from_str(&json).unwrap();
        assert_eq!(l, back);
    }
}
