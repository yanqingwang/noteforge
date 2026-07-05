use tree_sitter::{InputEdit, Parser, Point};

pub struct IncrementalParser {
    parser: Parser,
    tree: Option<tree_sitter::Tree>,
    source: String,
}

#[derive(Debug, Clone)]
pub struct SyntaxNode {
    pub kind: String,
    pub start: usize,
    pub end: usize,
    pub children: Vec<SyntaxNode>,
}

impl IncrementalParser {
    pub fn new() -> Self {
        let mut parser = Parser::new();
        parser.set_language(tree_sitter_markdown::language())
            .expect("tree-sitter-markdown language");
        IncrementalParser { parser, tree: None, source: String::new() }
    }

    pub fn parse(&mut self, source: &str) {
        self.source.clear();
        self.source.push_str(source);
        self.tree = self.parser.parse(source, None);
    }

    pub fn edit(&mut self, start: usize, deleted: usize, inserted: &str) {
        let mut new_src = self.source.clone();
        new_src.replace_range(start..start + deleted, inserted);
        self.source = new_src;

        if let Some(ref mut tree) = self.tree {
            tree.edit(&InputEdit {
                start_byte: start,
                old_end_byte: start + deleted,
                new_end_byte: start + inserted.len(),
                start_position: Point { row: 0, column: start },
                old_end_position: Point { row: 0, column: start + deleted },
                new_end_position: Point { row: 0, column: start + inserted.len() },
            });
        }
        self.tree = self.parser.parse(&self.source, self.tree.as_ref());
    }

    pub fn source(&self) -> &str { &self.source }

    pub fn syntax_tree(&self) -> Vec<SyntaxNode> {
        self.tree.as_ref().map(|t| collect_nodes(t.root_node())).unwrap_or_default()
    }

    pub fn find_nodes(&self, kind: &str) -> Vec<(usize, usize)> {
        let t = match self.tree.as_ref() { Some(t) => t, None => return vec![] };
        let mut r = Vec::new();
        find_nodes_rec(t.root_node(), kind, &mut r);
        r
    }
}

impl Default for IncrementalParser { fn default() -> Self { Self::new() } }

fn collect_nodes(node: tree_sitter::Node) -> Vec<SyntaxNode> {
    let mut children = Vec::new();
    let mut cur = node.walk();
    for c in node.children(&mut cur) {
        children.push(SyntaxNode {
            kind: c.kind().to_string(),
            start: c.start_byte(),
            end: c.end_byte(),
            children: collect_nodes(c),
        });
    }
    children
}

fn find_nodes_rec(node: tree_sitter::Node, kind: &str, r: &mut Vec<(usize, usize)>) {
    if node.kind() == kind { r.push((node.start_byte(), node.end_byte())); }
    let mut cur = node.walk();
    for c in node.children(&mut cur) { find_nodes_rec(c, kind, r); }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test] fn test_parse() { let mut p = IncrementalParser::new(); p.parse("# A\n"); assert!(p.tree.is_some()); }
    #[test] fn test_edit() {
        let mut p = IncrementalParser::new();
        p.parse("ab");
        p.edit(1, 0, "XX");
        assert_eq!(p.source(), "aXXb");
    }
    #[test] fn test_headings() { let mut p = IncrementalParser::new(); p.parse("# A\n## B\n"); assert!(p.find_nodes("atx_heading").len() >= 2); }
    #[test] fn test_empty() { let mut p = IncrementalParser::new(); p.parse(""); assert!(p.syntax_tree().is_empty()); }
}
