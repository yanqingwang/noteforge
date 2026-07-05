use serde::{Deserialize, Serialize};

/// A tag, possibly nested (e.g. `#领域/AI/NLP`).
#[derive(Debug, Clone, PartialEq, Eq, Hash, Serialize, Deserialize)]
pub struct Tag {
    /// Full tag name without `#`, e.g. `领域/AI/NLP`
    pub name: String,
    /// Hierarchical parts: `["领域", "AI", "NLP"]`
    pub parts: Vec<String>,
}

impl Tag {
    pub fn new(name: impl Into<String>) -> Self {
        let name = name.into();
        let parts: Vec<String> = name.split('/').map(|s| s.to_string()).collect();
        Tag { name, parts }
    }

    pub fn depth(&self) -> usize {
        self.parts.len()
    }

    pub fn parent(&self) -> Option<Tag> {
        if self.parts.len() <= 1 {
            return None;
        }
        Some(Tag {
            name: self.parts[..self.parts.len() - 1].join("/"),
            parts: self.parts[..self.parts.len() - 1].to_vec(),
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_tag_new_flat() {
        let t = Tag::new("AI");
        assert_eq!(t.name, "AI");
        assert_eq!(t.depth(), 1);
        assert!(t.parent().is_none());
    }

    #[test]
    fn test_tag_new_nested() {
        let t = Tag::new("领域/AI/NLP");
        assert_eq!(t.name, "领域/AI/NLP");
        assert_eq!(t.depth(), 3);
    }

    #[test]
    fn test_tag_parent() {
        let t = Tag::new("领域/AI/NLP");
        let p = t.parent().unwrap();
        assert_eq!(p.name, "领域/AI");
        assert_eq!(p.depth(), 2);
    }
}
