use serde::{Deserialize, Serialize};

/// Archetype of a note, influencing its structure and link behavior.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Archetype {
    Zettel,
    Moc,
    Journal,
    Literature,
    Stub,
}

/// The syntax variant for a planned link.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum LinkSyntax {
    Wikilink,
    WikilinkAlias,
    WikilinkHeading,
    WikilinkBlock,
    Embed,
    MdLink,
}

/// A planned link before serialization.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct PlannedLink {
    pub target: String,
    pub syntax: LinkSyntax,
    pub display: Option<String>,
    pub subpath: Option<String>,
    pub broken: bool,
}

/// Content element types for document IR.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "type")]
pub enum ContentElement {
    Heading {
        level: u8,
        text: String,
    },
    Paragraph {
        text: String,
    },
    UnorderedList {
        items: Vec<String>,
        depth: u8,
    },
    OrderedList {
        items: Vec<String>,
        depth: u8,
    },
    TaskList {
        items: Vec<(bool, String)>, // (checked, text)
    },
    CodeBlock {
        language: String,
        content: String,
    },
    Table {
        headers: Vec<String>,
        rows: Vec<Vec<String>>,
        alignments: Vec<Alignment>,
    },
    Callout {
        kind: String,
        foldable: bool,
        content: String,
    },
    Math {
        block: bool,
        content: String,
    },
    Footnote {
        id: String,
        content: String,
    },
    Comment {
        content: String,
    },
    Highlight {
        text: String,
    },
    BlockQuote {
        content: String,
    },
    HorizontalRule,
}

/// Table column alignment.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Alignment {
    Left,
    Center,
    Right,
}

/// Plan for generating a single document.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct DocPlan {
    pub path: String,
    pub archetype: Archetype,
    pub frontmatter_tags: Vec<String>,
    pub frontmatter_aliases: Vec<String>,
    pub elements: Vec<ContentElement>,
    pub links_out: Vec<PlannedLink>,
    pub inline_tags: Vec<String>,
    pub target_size_bytes: usize,
}

/// Top-level generation plan for the entire vault.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct GenerationPlan {
    /// Version of the generation logic.
    pub version: String,
    pub profile: String,
    pub seed: u64,
    pub mode: GenerationMode,
    pub docs: Vec<DocPlan>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum GenerationMode {
    Exact,
    Statistical,
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_archetype_serde() {
        let a = Archetype::Zettel;
        let json = serde_json::to_string(&a).unwrap();
        assert_eq!(json, "\"zettel\"");
        let back: Archetype = serde_json::from_str(&json).unwrap();
        assert_eq!(back, Archetype::Zettel);
    }

    #[test]
    fn test_doc_plan_serde() {
        let plan = DocPlan {
            path: "test.md".into(),
            archetype: Archetype::Stub,
            frontmatter_tags: vec![],
            frontmatter_aliases: vec![],
            elements: vec![],
            links_out: vec![],
            inline_tags: vec![],
            target_size_bytes: 100,
        };
        let json = serde_json::to_string(&plan).unwrap();
        let back: DocPlan = serde_json::from_str(&json).unwrap();
        assert_eq!(plan, back);
    }
}
