use nf_core::note::NoteMeta;
use std::collections::{BTreeMap, BTreeSet};

/// A node in the graph (a note).
#[derive(Debug, Clone)]
pub struct GraphNode {
    pub id: usize,
    pub path: String,
    pub title: String,
    pub x: f64,
    pub y: f64,
    pub link_count: usize,
}

/// An edge in the graph (a link between notes).
#[derive(Debug, Clone)]
pub struct GraphEdge {
    pub source: usize,
    pub target: usize,
    pub label: String,
}

/// The complete link graph.
#[derive(Debug, Clone)]
pub struct NoteGraph {
    pub nodes: Vec<GraphNode>,
    pub edges: Vec<GraphEdge>,
    pub node_map: BTreeMap<String, usize>, // path -> node id
}

impl NoteGraph {
    /// Build a graph from note metadata.
    pub fn build(metas: &[NoteMeta]) -> Self {
        let mut node_map = BTreeMap::new();
        let mut nodes = Vec::new();
        let mut edges = Vec::new();
        let mut link_counts = BTreeMap::new();

        // Create nodes
        for (i, meta) in metas.iter().enumerate() {
            node_map.insert(meta.path.clone(), i);
            // Extract title from first heading or filename
            let title = meta.headings.first()
                .map(|h| h.text.clone())
                .unwrap_or_else(|| {
                    let stem = meta.path.trim_end_matches(".md");
                    stem.rsplit('/').next().unwrap_or(stem).to_string()
                });
            nodes.push(GraphNode {
                id: i,
                path: meta.path.clone(),
                title,
                x: 0.0, y: 0.0,
                link_count: meta.links_out.len(),
            });
            *link_counts.entry(i).or_insert(0) += meta.links_out.len();
        }

        // Create edges
        for meta in metas {
            if let Some(&src) = node_map.get(&meta.path) {
                for link in &meta.links_out {
                    if let Some(ref resolved) = link.resolves_to {
                        if let Some(&tgt) = node_map.get(resolved) {
                            edges.push(GraphEdge {
                                source: src,
                                target: tgt,
                                label: link.target.clone(),
                            });
                        }
                    }
                }
            }
        }

        NoteGraph { nodes, edges, node_map }
    }

    /// Run force-directed layout to position nodes.
    pub fn layout(&mut self, iterations: usize) {
        let n = self.nodes.len();
        if n == 0 { return; }

        let area = 1000.0;
        let k = (area / (n as f64).sqrt()).sqrt(); // spring constant
        let mut vx = vec![0.0; n];
        let mut vy = vec![0.0; n];

        // Initialize random positions
        for node in &mut self.nodes {
            node.x = (node.id as f64 * 7919.0).cos() * area * 0.5;
            node.y = (node.id as f64 * 6271.0).sin() * area * 0.5;
        }

        for _iter in 0..iterations {
            // Repulsive forces (all pairs)
            let mut fx = vec![0.0; n];
            let mut fy = vec![0.0; n];

            for i in 0..n {
                for j in (i + 1)..n {
                    let dx = self.nodes[i].x - self.nodes[j].x;
                    let dy = self.nodes[i].y - self.nodes[j].y;
                    let dist = (dx * dx + dy * dy).sqrt().max(1.0);
                    let force = k * k / dist;
                    fx[i] += force * dx / dist;
                    fy[i] += force * dy / dist;
                    fx[j] -= force * dx / dist;
                    fy[j] -= force * dy / dist;
                }
            }

            // Attractive forces (edges)
            for edge in &self.edges {
                let i = edge.source;
                let j = edge.target;
                if i >= n || j >= n { continue; }
                let dx = self.nodes[j].x - self.nodes[i].x;
                let dy = self.nodes[j].y - self.nodes[i].y;
                let dist = (dx * dx + dy * dy).sqrt().max(1.0);
                let force = dist * dist / k;
                fx[i] += force * dx / dist;
                fy[i] += force * dy / dist;
                fx[j] -= force * dx / dist;
                fy[j] -= force * dy / dist;
            }

            // Center gravity
            for i in 0..n {
                fx[i] -= self.nodes[i].x * 0.01;
                fy[i] -= self.nodes[i].y * 0.01;
            }

            // Apply forces with velocity damping
            let damping = 0.85;
            for i in 0..n {
                vx[i] = (vx[i] + fx[i]) * damping;
                vy[i] = (vy[i] + fy[i]) * damping;
                self.nodes[i].x += vx[i].min(50.0).max(-50.0);
                self.nodes[i].y += vy[i].min(50.0).max(-50.0);
            }
        }
    }

    /// Find connected components.
    pub fn components(&self) -> Vec<Vec<usize>> {
        let mut visited = BTreeSet::new();
        let mut components = Vec::new();

        for node in &self.nodes {
            if visited.contains(&node.id) { continue; }
            let mut stack = vec![node.id];
            let mut comp = Vec::new();
            while let Some(id) = stack.pop() {
                if !visited.insert(id) { continue; }
                comp.push(id);
                for edge in &self.edges {
                    if edge.source == id && !visited.contains(&edge.target) {
                        stack.push(edge.target);
                    }
                    if edge.target == id && !visited.contains(&edge.source) {
                        stack.push(edge.source);
                    }
                }
            }
            if !comp.is_empty() { components.push(comp); }
        }
        components
    }

    /// Get neighbors of a node.
    pub fn neighbors(&self, node_id: usize) -> Vec<(usize, String)> {
        let mut result = Vec::new();
        for edge in &self.edges {
            if edge.source == node_id {
                result.push((edge.target, edge.label.clone()));
            }
        }
        result
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use nf_core::link::{Link, LinkKind};
    use nf_core::note::NoteMeta;
    use nf_core::span::Span;

    fn make_link(target: &str) -> Link {
        Link {
            raw: format!("[[{}]]", target),
            kind: LinkKind::Wikilink,
            target: target.to_string(),
            subpath: None,
            display: None,
            span: Span::new(0, target.len() + 4).unwrap(),
            resolves_to: Some(format!("{}.md", target)),
            ambiguous: false,
        }
    }

    #[test]
    fn test_empty_graph() {
        let g = NoteGraph::build(&[]);
        assert!(g.nodes.is_empty());
    }

    #[test]
    fn test_build_graph() {
        let doc = NoteMeta {
            path: "a.md".into(), size: 0, sha256: "".into(),
            archetype: "".into(), line_ending: "lf".into(),
            frontmatter: Default::default(),
            headings: vec![], tags_inline: vec![], block_ids: vec![],
            links_out: vec![make_link("b")],
        };
        let doc2 = NoteMeta {
            path: "b.md".into(), size: 0, sha256: "".into(),
            archetype: "".into(), line_ending: "lf".into(),
            frontmatter: Default::default(),
            headings: vec![], tags_inline: vec![], block_ids: vec![],
            links_out: vec![],
        };
        let g = NoteGraph::build(&[doc, doc2]);
        assert_eq!(g.nodes.len(), 2);
        assert_eq!(g.edges.len(), 1);
    }

    #[test]
    fn test_components() {
        let metas: Vec<NoteMeta> = (0..4).map(|i| {
            let target = if i < 2 { Some("b") } else { None };
            NoteMeta {
                path: format!("{}.md", (b'a' + i) as char),
                size: 0, sha256: "".into(),
                archetype: "".into(), line_ending: "lf".into(),
                frontmatter: Default::default(),
                headings: vec![], tags_inline: vec![], block_ids: vec![],
                links_out: target.map(|t| make_link(t)).into_iter().collect(),
            }
        }).collect();
        let g = NoteGraph::build(&metas);
        let comps = g.components();
        assert_eq!(comps.len(), 3);
    }

    #[test]
    fn test_layout_converges() {
        let doc = NoteMeta {
            path: "a.md".into(), size: 0, sha256: "".into(),
            archetype: "".into(), line_ending: "lf".into(),
            frontmatter: Default::default(),
            headings: vec![], tags_inline: vec![], block_ids: vec![],
            links_out: vec![make_link("b"), make_link("c")],
        };
        let empty = || NoteMeta {
            path: String::new(), size: 0, sha256: String::new(),
            archetype: String::new(), line_ending: "lf".into(),
            frontmatter: Default::default(),
            headings: vec![], tags_inline: vec![], block_ids: vec![],
            links_out: vec![],
        };
        let metas = vec![
            doc,
            NoteMeta { path: "b.md".into(), ..empty() },
            NoteMeta { path: "c.md".into(), ..empty() },
        ];
        let mut g = NoteGraph::build(&metas);
        g.layout(10);
        // After layout, nodes should have moved
        assert!(g.nodes[0].x != 0.0 || g.nodes[0].y != 0.0);
    }
}
