use rand::Rng;
use rand_chacha::ChaCha20Rng;
use std::collections::HashSet;

use crate::ir::LinkSyntax;

// ponytail: This file uses Vec for all accumulators whose iteration order
// must be deterministic.  HashSet/ HashMap would rely on the process-wide
// RandomState seed; Vec pushes in insertion order and is always stable.

/// Configuration for the Barabási–Albert link graph topology.
#[derive(Debug, Clone)]
pub struct TopologyConfig {
    /// Target total number of edges after BA growth.
    pub total_links: usize,
    /// Fraction of nodes that must have zero edges (post-processing).
    pub orphan_ratio: f64,
    /// Fraction of edges to mark as broken.
    pub broken_ratio: f64,
    /// Number of existing edges to make bidirectional (add reverse edge).
    pub bidirectional_pairs: usize,
    /// Number of self-loop edges to inject.
    pub self_loops: usize,
    /// Initial fully-connected core size for BA model.
    pub m0: usize,
    /// Edges added per new node during BA growth.
    pub m: usize,
}

/// A single directed edge in the link graph.
#[derive(Debug, Clone, PartialEq)]
pub struct GraphEdge {
    pub source: usize,
    pub target: usize,
    pub kind: LinkSyntax,
    pub broken: bool,
    pub bidirectional: bool,
}

/// The generated link graph topology after all phases.
#[derive(Debug, Clone)]
pub struct LinkGraph {
    pub edges: Vec<GraphEdge>,
    pub out_degrees: Vec<usize>,
    pub in_degrees: Vec<usize>,
    /// Sorted list of node indices with zero total degree.
    pub orphans: Vec<usize>,
}

// Weighted distribution for link kinds (External merged into MdLink — not in LinkSyntax).
const KIND_WEIGHTS: &[(LinkSyntax, f64)] = &[
    (LinkSyntax::Wikilink, 55.0),
    (LinkSyntax::WikilinkAlias, 15.0),
    (LinkSyntax::WikilinkHeading, 10.0),
    (LinkSyntax::WikilinkBlock, 5.0),
    (LinkSyntax::Embed, 8.0),
    (LinkSyntax::MdLink, 7.0),
];

/// Pick a LinkSyntax variant according to the configured distribution.
fn pick_kind(rng: &mut ChaCha20Rng) -> LinkSyntax {
    let roll: f64 = rng.random_range(0.0..100.0);
    let mut cumulative = 0.0;
    for &(kind, weight) in KIND_WEIGHTS {
        cumulative += weight;
        if roll < cumulative {
            return kind;
        }
    }
    LinkSyntax::MdLink
}

/// Pick `n` distinct indices from `0..max` using a partial Fisher–Yates shuffle.
fn pick_n_distinct(n: usize, max: usize, rng: &mut ChaCha20Rng) -> Vec<usize> {
    if n == 0 || max == 0 {
        return vec![];
    }
    let k = n.min(max);
    let mut pool: Vec<usize> = (0..max).collect();
    for i in 0..k {
        let j = rng.random_range(i..max);
        pool.swap(i, j);
    }
    pool.truncate(k);
    pool
}

/// Build a directed Barabási–Albert graph, then post-process it.
///
/// ## Phases
/// 1. **BA growth** — complete graph on `m0` nodes, then add remaining nodes one at
///    a time with `m` edges each, linked preferentially to high-degree nodes.
/// 2. **Broken links** — mark a fraction of edges as broken.
/// 3. **Self-loops** — inject `self_loops` edges from random nodes to themselves.
/// 4. **Bidirectional pairs** — pick random edge pairs and create a reverse edge.
/// 5. **Orphan ratio** — remove all edges from the lowest-degree nodes until the
///    target orphan fraction is met.
pub fn generate_topology(
    num_docs: usize,
    config: &TopologyConfig,
    rng: &mut ChaCha20Rng,
) -> LinkGraph {
    if num_docs == 0 {
        return LinkGraph {
            edges: vec![],
            out_degrees: vec![],
            in_degrees: vec![],
            orphans: vec![],
        };
    }

    let m0 = config.m0.min(num_docs);
    let mut edges: Vec<GraphEdge> = Vec::new();
    let mut out_degrees = vec![0usize; num_docs];
    let mut in_degrees = vec![0usize; num_docs];

    // ── Phase 1: BA growth ──────────────────────────────────────────────

    // 1a: m0 fully-connected core (directed edges between every distinct pair)
    for i in 0..m0 {
        for j in 0..m0 {
            if i != j {
                let kind = pick_kind(rng);
                edges.push(GraphEdge {
                    source: i,
                    target: j,
                    kind,
                    broken: false,
                    bidirectional: false,
                });
                out_degrees[i] += 1;
                in_degrees[j] += 1;
            }
        }
    }

    // 1b: Preferential attachment for remaining nodes
    // Vec used to guarantee deterministic iteration order (no hash-randomisation).
    for new_node in m0..num_docs {
        let m = config.m.min(new_node);
        if m == 0 {
            continue;
        }

        // Choose m distinct targets via preferential attachment.
        let mut targets: Vec<usize> = Vec::with_capacity(m);
        'outer: while targets.len() < m {
            let total_deg: usize = (0..new_node)
                .map(|i| out_degrees[i] + in_degrees[i])
                .sum();

            if total_deg == 0 {
                let candidate = rng.random_range(0..new_node);
                if !targets.contains(&candidate) {
                    targets.push(candidate);
                }
                continue;
            }

            let roll = rng.random_range(0..total_deg);
            let mut cumulative = 0usize;
            for i in 0..new_node {
                cumulative += out_degrees[i] + in_degrees[i];
                if roll < cumulative {
                    if !targets.contains(&i) {
                        targets.push(i);
                    }
                    continue 'outer;
                }
            }
        }

        for &target in &targets {
            let kind = pick_kind(rng);
            edges.push(GraphEdge {
                source: new_node,
                target,
                kind,
                broken: false,
                bidirectional: false,
            });
            out_degrees[new_node] += 1;
            in_degrees[target] += 1;
        }
    }

    // ── Phase 2: Adjust to approximately match total_links ────────────────

    if config.total_links > 0 {
        let current = edges.len();
        if current < config.total_links {
            let add_count = (config.total_links - current).min(current);
            for _ in 0..add_count {
                let src = rng.random_range(0..num_docs);
                let tgt = rng.random_range(0..num_docs);
                if src != tgt {
                    edges.push(GraphEdge {
                        source: src,
                        target: tgt,
                        kind: pick_kind(rng),
                        broken: false,
                        bidirectional: false,
                    });
                    out_degrees[src] += 1;
                    in_degrees[tgt] += 1;
                }
            }
        } else if current > config.total_links {
            let remove_count = current - config.total_links;
            let remove_indices = pick_n_distinct(remove_count.min(current / 2), current, rng);
            let mut sorted: Vec<usize> = remove_indices.into_iter().collect();
            sorted.sort_unstable_by(|a, b| b.cmp(a));
            for &idx in &sorted {
                if idx < edges.len() {
                    let e = edges.swap_remove(idx);
                    out_degrees[e.source] = out_degrees[e.source].saturating_sub(1);
                    in_degrees[e.target] = in_degrees[e.target].saturating_sub(1);
                }
            }
        }
    }

    // ── Phase 3: Inject broken links ────────────────────────────────────

    let broken_count = (edges.len() as f64 * config.broken_ratio) as usize;
    for idx in pick_n_distinct(broken_count, edges.len(), rng) {
        edges[idx].broken = true;
    }

    // ── Phase 3: Inject self-loops ──────────────────────────────────────

    for _ in 0..config.self_loops {
        let node = rng.random_range(0..num_docs);
        let kind = pick_kind(rng);
        edges.push(GraphEdge {
            source: node,
            target: node,
            kind,
            broken: false,
            bidirectional: false,
        });
        out_degrees[node] += 1;
        in_degrees[node] += 1;
    }

    // ── Phase 4: Inject bidirectional pairs ─────────────────────────────

    {
        let eligible: Vec<usize> = (0..edges.len())
            .filter(|&i| edges[i].source != edges[i].target && !edges[i].bidirectional)
            .collect();

        let pairs = config.bidirectional_pairs.min(eligible.len());
        let chosen = pick_n_distinct(pairs, eligible.len(), rng);

        for &pos in &chosen {
            let idx = eligible[pos];
            let src = edges[idx].source;
            let tgt = edges[idx].target;

            // Mark original as bidirectional
            edges[idx].bidirectional = true;

            // Create reverse edge
            edges.push(GraphEdge {
                source: tgt,
                target: src,
                kind: LinkSyntax::Wikilink,
                broken: false,
                bidirectional: true,
            });
            out_degrees[tgt] += 1;
            in_degrees[src] += 1;
        }
    }

    // ── Phase 5: Ensure orphan ratio ────────────────────────────────────

    let target_orphans = (num_docs as f64 * config.orphan_ratio).round() as usize;
    let mut orphan_set: HashSet<usize> = HashSet::new();

    if target_orphans > 0 {
        // Pick lowest-degree nodes as orphans to minimize edge removal.
        let mut candidates: Vec<usize> = (0..num_docs).collect();
        candidates.sort_by_key(|&i| out_degrees[i] + in_degrees[i]);

        for &node in &candidates {
            if orphan_set.len() >= target_orphans {
                break;
            }
            orphan_set.insert(node);
        }

        // Remove every edge touching an orphan node.
        if !orphan_set.is_empty() {
            edges.retain(|e| {
                !orphan_set.contains(&e.source) && !orphan_set.contains(&e.target)
            });
            // Recompute degrees from scratch.
            out_degrees.iter_mut().for_each(|d| *d = 0);
            in_degrees.iter_mut().for_each(|d| *d = 0);
            for e in &edges {
                out_degrees[e.source] += 1;
                in_degrees[e.target] += 1;
            }
        }
    }

    let mut orphans: Vec<usize> = orphan_set.into_iter().collect();
    orphans.sort();

    LinkGraph {
        edges,
        out_degrees,
        in_degrees,
        orphans,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use rand_chacha::rand_core::SeedableRng;

    fn default_config() -> TopologyConfig {
        TopologyConfig {
            total_links: 305,
            orphan_ratio: 0.0,
            broken_ratio: 0.0,
            bidirectional_pairs: 0,
            self_loops: 0,
            m0: 5,
            m: 3,
        }
    }

    #[test]
    fn test_deterministic_output() {
        let config = default_config();
        let mut rng1 = ChaCha20Rng::seed_from_u64(42);
        let mut rng2 = ChaCha20Rng::seed_from_u64(42);
        let g1 = generate_topology(100, &config, &mut rng1);
        let g2 = generate_topology(100, &config, &mut rng2);

        assert_eq!(g1.edges.len(), g2.edges.len());
        for (e1, e2) in g1.edges.iter().zip(g2.edges.iter()) {
            assert_eq!(e1.source, e2.source);
            assert_eq!(e1.target, e2.target);
            assert_eq!(e1.kind, e2.kind);
            assert_eq!(e1.broken, e2.broken);
            assert_eq!(e1.bidirectional, e2.bidirectional);
        }
        assert_eq!(g1.orphans, g2.orphans);
        assert_eq!(g1.out_degrees, g2.out_degrees);
        assert_eq!(g1.in_degrees, g2.in_degrees);
    }

    #[test]
    fn test_orphans_present() {
        let config = TopologyConfig {
            total_links: 100,
            orphan_ratio: 0.2,
            broken_ratio: 0.0,
            bidirectional_pairs: 0,
            self_loops: 0,
            m0: 3,
            m: 2,
        };
        let mut rng = ChaCha20Rng::seed_from_u64(123);
        let graph = generate_topology(50, &config, &mut rng);

        let expected_min = (50.0 * 0.2) as usize;
        assert!(
            graph.orphans.len() >= expected_min,
            "expected at least {expected_min} orphans, got {}",
            graph.orphans.len()
        );

        for &o in &graph.orphans {
            assert_eq!(
                graph.out_degrees[o] + graph.in_degrees[o],
                0,
                "orphan node {o} has non-zero degree"
            );
        }

        for e in &graph.edges {
            assert!(
                !graph.orphans.contains(&e.source),
                "edge from orphan {}",
                e.source
            );
            assert!(
                !graph.orphans.contains(&e.target),
                "edge to orphan {}",
                e.target
            );
        }
    }

    #[test]
    fn test_self_loops_count() {
        let config = TopologyConfig {
            total_links: 64,
            orphan_ratio: 0.0,
            broken_ratio: 0.0,
            bidirectional_pairs: 0,
            self_loops: 7,
            m0: 4,
            m: 2,
        };
        let mut rng = ChaCha20Rng::seed_from_u64(456);
        let graph = generate_topology(30, &config, &mut rng);

        let self_loop_count = graph
            .edges
            .iter()
            .filter(|e| e.source == e.target)
            .count();
        assert_eq!(
            self_loop_count, 7,
            "expected 7 self-loops, got {self_loop_count}"
        );
    }

    #[test]
    fn test_different_seeds_differ() {
        let config = default_config();
        let mut rng1 = ChaCha20Rng::seed_from_u64(1);
        let mut rng2 = ChaCha20Rng::seed_from_u64(2);
        let g1 = generate_topology(50, &config, &mut rng1);
        let g2 = generate_topology(50, &config, &mut rng2);

        // Extremely unlikely that two different seeds produce identical edges.
        let identical = g1.edges.len() == g2.edges.len()
            && g1.edges.iter().zip(g2.edges.iter()).all(|(a, b)| {
                a.source == b.source
                    && a.target == b.target
                    && a.kind == b.kind
                    && a.broken == b.broken
            });
        assert!(!identical, "different seeds produced identical graphs");
    }

    #[test]
    fn test_empty_graph() {
        let config = default_config();
        let mut rng = ChaCha20Rng::seed_from_u64(0);
        let graph = generate_topology(0, &config, &mut rng);
        assert!(graph.edges.is_empty());
        assert!(graph.orphans.is_empty());
        assert!(graph.out_degrees.is_empty());
    }

    #[test]
    fn test_broken_links_injected() {
        let config = TopologyConfig {
            total_links: 200,
            orphan_ratio: 0.0,
            broken_ratio: 0.1,
            bidirectional_pairs: 0,
            self_loops: 0,
            m0: 4,
            m: 2,
        };
        let mut rng = ChaCha20Rng::seed_from_u64(789);
        let graph = generate_topology(40, &config, &mut rng);

        let broken = graph.edges.iter().filter(|e| e.broken).count();
        assert!(broken > 0, "expected at least one broken edge");
        // Should be approximately 10% of edges (allow ±3 absolute).
        let expected = ((graph.edges.len() as f64) * 0.1).round() as usize;
        assert!(
            broken.abs_diff(expected) <= 3,
            "broken count {broken} too far from expected {expected}"
        );
    }

    #[test]
    fn test_bidirectional_pairs() {
        let config = TopologyConfig {
            total_links: 100,
            orphan_ratio: 0.0,
            broken_ratio: 0.0,
            bidirectional_pairs: 5,
            self_loops: 0,
            m0: 4,
            m: 2,
        };
        let mut rng = ChaCha20Rng::seed_from_u64(111);
        let graph = generate_topology(30, &config, &mut rng);

        let bidi = graph.edges.iter().filter(|e| e.bidirectional).count();
        // Each pair adds one reversed edge + marks the original = 2 per pair.
        assert_eq!(bidi, 10, "expected 10 bidirectional flags (5 pairs)");

        // Every bidirectional edge should have a matching counterpart.
        for e in &graph.edges {
            if e.bidirectional {
                let has_reverse = graph.edges.iter().any(|other| {
                    other.source == e.target
                        && other.target == e.source
                        && other.bidirectional
                });
                assert!(has_reverse, "bidirectional edge ({},{}) lacks reverse", e.source, e.target);
            }
        }
    }
}
