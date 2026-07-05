//! Embedded Chinese/English corpus with Zipf-weighted word selection
//! and template-based sentence generation.
//!
//! Used by the vault generator to produce natural-looking document text
//! that reads like real knowledge-work notes rather than placeholder garbage.

use rand::Rng;
use rand::seq::IndexedRandom;
use rand_chacha::ChaCha20Rng;

// ── Word entries ────────────────────────────────────────────────────────────

/// A single word with its Zipf frequency weight.
///
/// Weights follow an approximate Zipf distribution (higher rank = lower weight)
/// so common words appear far more often than rare ones.
struct WordEntry {
    word: &'static str,
    /// Higher = more frequent.  Follows a Zipf-like distribution (≈ 30 / rank).
    weight: u32,
}

// Weights: rank → weight = max(1, 30 / rank)
//   1:30,  2:15,  3:10,  4:7,   5:6,
//   6:5,   7:4,   8:3,   9:3,  10:3,
//  11:2,  12:2,  13:2,  14:2,  15:2,
//  16+:1

const CHINESE_WORDS: &[WordEntry] = &[
    WordEntry { word: "概念", weight: 30 }, WordEntry { word: "理论", weight: 15 },
    WordEntry { word: "方法", weight: 10 }, WordEntry { word: "系统", weight: 7 },
    WordEntry { word: "结构", weight: 6 }, WordEntry { word: "过程", weight: 5 },
    WordEntry { word: "模型", weight: 4 }, WordEntry { word: "框架", weight: 4 },
    WordEntry { word: "策略", weight: 3 }, WordEntry { word: "机制", weight: 3 },
    WordEntry { word: "分析", weight: 3 }, WordEntry { word: "设计", weight: 2 },
    WordEntry { word: "实现", weight: 2 }, WordEntry { word: "数据", weight: 2 },
    WordEntry { word: "算法", weight: 2 }, WordEntry { word: "网络", weight: 1 },
    WordEntry { word: "资源", weight: 1 }, WordEntry { word: "工具", weight: 1 },
    WordEntry { word: "文档", weight: 1 }, WordEntry { word: "代码", weight: 1 },
    WordEntry { word: "版本", weight: 1 }, WordEntry { word: "接口", weight: 1 },
    WordEntry { word: "配置", weight: 1 }, WordEntry { word: "环境", weight: 1 },
    WordEntry { word: "架构", weight: 2 }, WordEntry { word: "协议", weight: 1 },
    WordEntry { word: "模块", weight: 1 }, WordEntry { word: "组件", weight: 1 },
    WordEntry { word: "标准", weight: 1 }, WordEntry { word: "分类", weight: 1 },
    WordEntry { word: "索引", weight: 1 }, WordEntry { word: "查询", weight: 1 },
    WordEntry { word: "存储", weight: 1 }, WordEntry { word: "计算", weight: 1 },
    WordEntry { word: "推理", weight: 1 }, WordEntry { word: "验证", weight: 1 },
    WordEntry { word: "优化", weight: 1 }, WordEntry { word: "评估", weight: 1 },
    WordEntry { word: "诊断", weight: 1 }, WordEntry { word: "监控", weight: 1 },
    WordEntry { word: "调度", weight: 1 }, WordEntry { word: "抽象", weight: 1 },
    WordEntry { word: "封装", weight: 1 }, WordEntry { word: "继承", weight: 1 },
    WordEntry { word: "多态", weight: 1 }, WordEntry { word: "耦合", weight: 1 },
    WordEntry { word: "内聚", weight: 1 }, WordEntry { word: "冗余", weight: 1 },
    WordEntry { word: "容错", weight: 1 }, WordEntry { word: "事务", weight: 1 },
    WordEntry { word: "并发", weight: 1 }, WordEntry { word: "并行", weight: 1 },
    WordEntry { word: "同步", weight: 1 }, WordEntry { word: "异步", weight: 1 },
    WordEntry { word: "回调", weight: 1 }, WordEntry { word: "委托", weight: 1 },
    WordEntry { word: "事件", weight: 1 }, WordEntry { word: "消息", weight: 1 },
    WordEntry { word: "队列", weight: 1 }, WordEntry { word: "缓存", weight: 1 },
    WordEntry { word: "会话", weight: 1 }, WordEntry { word: "令牌", weight: 1 },
    WordEntry { word: "凭证", weight: 1 }, WordEntry { word: "权限", weight: 1 },
    WordEntry { word: "角色", weight: 1 }, WordEntry { word: "审计", weight: 1 },
    WordEntry { word: "日志", weight: 1 }, WordEntry { word: "指标", weight: 1 },
    WordEntry { word: "阈值", weight: 1 }, WordEntry { word: "基线", weight: 1 },
    WordEntry { word: "拓扑", weight: 1 }, WordEntry { word: "维度", weight: 1 },
    WordEntry { word: "实体", weight: 1 }, WordEntry { word: "属性", weight: 1 },
    WordEntry { word: "关系", weight: 1 }, WordEntry { word: "映射", weight: 1 },
    WordEntry { word: "转换", weight: 1 }, WordEntry { word: "聚合", weight: 1 },
    WordEntry { word: "分发", weight: 1 }, WordEntry { word: "路由", weight: 1 },
    WordEntry { word: "代理", weight: 1 }, WordEntry { word: "网关", weight: 1 },
    WordEntry { word: "中间件", weight: 1 }, WordEntry { word: "插件", weight: 1 },
    WordEntry { word: "扩展", weight: 1 }, WordEntry { word: "集成", weight: 1 },
    WordEntry { word: "部署", weight: 1 }, WordEntry { word: "发布", weight: 1 },
    WordEntry { word: "管道", weight: 1 }, WordEntry { word: "过滤", weight: 1 },
    WordEntry { word: "排序", weight: 1 }, WordEntry { word: "搜索", weight: 1 },
    WordEntry { word: "匹配", weight: 1 }, WordEntry { word: "替换", weight: 1 },
    WordEntry { word: "分割", weight: 1 }, WordEntry { word: "合并", weight: 1 },
    WordEntry { word: "领域", weight: 1 }, WordEntry { word: "项目", weight: 1 },
    WordEntry { word: "任务", weight: 1 }, WordEntry { word: "目标", weight: 1 },
    WordEntry { word: "计划", weight: 1 }, WordEntry { word: "执行", weight: 1 },
    WordEntry { word: "反馈", weight: 1 }, WordEntry { word: "循环", weight: 1 },
    WordEntry { word: "迭代", weight: 1 }, WordEntry { word: "增量", weight: 1 },
    WordEntry { word: "敏捷", weight: 1 }, WordEntry { word: "精益", weight: 1 },
    WordEntry { word: "看板", weight: 1 }, WordEntry { word: "回顾", weight: 1 },
    WordEntry { word: "评审", weight: 1 }, WordEntry { word: "演示", weight: 1 },
    WordEntry { word: "质量", weight: 1 }, WordEntry { word: "安全", weight: 1 },
    WordEntry { word: "性能", weight: 1 }, WordEntry { word: "可用", weight: 1 },
    WordEntry { word: "可靠", weight: 1 }, WordEntry { word: "伸缩", weight: 1 },
    WordEntry { word: "成本", weight: 1 }, WordEntry { word: "收益", weight: 1 },
    WordEntry { word: "价值", weight: 1 }, WordEntry { word: "风险", weight: 1 },
    WordEntry { word: "问题", weight: 1 }, WordEntry { word: "缺陷", weight: 1 },
    WordEntry { word: "故障", weight: 1 }, WordEntry { word: "异常", weight: 1 },
    WordEntry { word: "错误", weight: 1 }, WordEntry { word: "警告", weight: 1 },
    WordEntry { word: "信息", weight: 1 }, WordEntry { word: "调试", weight: 1 },
    WordEntry { word: "跟踪", weight: 1 }, WordEntry { word: "概要", weight: 1 },
    WordEntry { word: "详情", weight: 1 }, WordEntry { word: "摘要", weight: 1 },
    WordEntry { word: "附件", weight: 1 }, WordEntry { word: "模板", weight: 1 },
    WordEntry { word: "示例", weight: 1 }, WordEntry { word: "参考", weight: 1 },
    WordEntry { word: "手册", weight: 1 }, WordEntry { word: "指南", weight: 1 },
    WordEntry { word: "规范", weight: 1 },
];const ENGLISH_WORDS: &[WordEntry] = &[
    WordEntry { word: "concept", weight: 30 }, WordEntry { word: "theory", weight: 15 },
    WordEntry { word: "method", weight: 10 }, WordEntry { word: "system", weight: 7 },
    WordEntry { word: "structure", weight: 6 }, WordEntry { word: "process", weight: 5 },
    WordEntry { word: "model", weight: 4 }, WordEntry { word: "framework", weight: 4 },
    WordEntry { word: "strategy", weight: 3 }, WordEntry { word: "mechanism", weight: 3 },
    WordEntry { word: "analysis", weight: 3 }, WordEntry { word: "design", weight: 2 },
    WordEntry { word: "pattern", weight: 2 }, WordEntry { word: "abstraction", weight: 2 },
    WordEntry { word: "implementation", weight: 2 }, WordEntry { word: "network", weight: 1 },
    WordEntry { word: "resource", weight: 1 }, WordEntry { word: "protocol", weight: 1 },
    WordEntry { word: "algorithm", weight: 1 }, WordEntry { word: "standard", weight: 1 },
    WordEntry { word: "interface", weight: 1 }, WordEntry { word: "component", weight: 1 },
    WordEntry { word: "dependency", weight: 1 }, WordEntry { word: "constraint", weight: 1 },
    WordEntry { word: "architecture", weight: 2 }, WordEntry { word: "repository", weight: 1 },
    WordEntry { word: "pipeline", weight: 1 }, WordEntry { word: "workflow", weight: 1 },
    WordEntry { word: "runtime", weight: 1 }, WordEntry { word: "middleware", weight: 1 },
    WordEntry { word: "endpoint", weight: 1 }, WordEntry { word: "throughput", weight: 1 },
    WordEntry { word: "latency", weight: 1 }, WordEntry { word: "bandwidth", weight: 1 },
    WordEntry { word: "traffic", weight: 1 }, WordEntry { word: "payload", weight: 1 },
    WordEntry { word: "cluster", weight: 1 }, WordEntry { word: "container", weight: 1 },
    WordEntry { word: "scheduler", weight: 1 }, WordEntry { word: "registry", weight: 1 },
    WordEntry { word: "discovery", weight: 1 }, WordEntry { word: "gateway", weight: 1 },
    WordEntry { word: "balancer", weight: 1 }, WordEntry { word: "timeout", weight: 1 },
    WordEntry { word: "circuit", weight: 1 }, WordEntry { word: "retry", weight: 1 },
    WordEntry { word: "fallback", weight: 1 }, WordEntry { word: "provision", weight: 1 },
    WordEntry { word: "deployment", weight: 1 }, WordEntry { word: "rollback", weight: 1 },
    WordEntry { word: "migration", weight: 1 }, WordEntry { word: "upgrade", weight: 1 },
    WordEntry { word: "backup", weight: 1 }, WordEntry { word: "restore", weight: 1 },
    WordEntry { word: "compress", weight: 1 }, WordEntry { word: "encrypt", weight: 1 },
    WordEntry { word: "decrypt", weight: 1 }, WordEntry { word: "signature", weight: 1 },
    WordEntry { word: "certificate", weight: 1 }, WordEntry { word: "authentication", weight: 1 },
    WordEntry { word: "authorization", weight: 1 }, WordEntry { word: "permission", weight: 1 },
    WordEntry { word: "policy", weight: 1 }, WordEntry { word: "audit", weight: 1 },
    WordEntry { word: "monitor", weight: 1 }, WordEntry { word: "metric", weight: 1 },
    WordEntry { word: "threshold", weight: 1 }, WordEntry { word: "baseline", weight: 1 },
    WordEntry { word: "topology", weight: 1 }, WordEntry { word: "dimension", weight: 1 },
    WordEntry { word: "entity", weight: 1 }, WordEntry { word: "attribute", weight: 1 },
    WordEntry { word: "relationship", weight: 1 }, WordEntry { word: "mapping", weight: 1 },
    WordEntry { word: "transformation", weight: 1 }, WordEntry { word: "aggregation", weight: 1 },
    WordEntry { word: "distribution", weight: 1 }, WordEntry { word: "routing", weight: 1 },
    WordEntry { word: "proxy", weight: 1 }, WordEntry { word: "plugin", weight: 1 },
    WordEntry { word: "extension", weight: 1 }, WordEntry { word: "integration", weight: 1 },
    WordEntry { word: "validation", weight: 1 }, WordEntry { word: "verification", weight: 1 },
    WordEntry { word: "testing", weight: 1 }, WordEntry { word: "debugging", weight: 1 },
    WordEntry { word: "logging", weight: 1 }, WordEntry { word: "tracing", weight: 1 },
    WordEntry { word: "profiling", weight: 1 }, WordEntry { word: "optimization", weight: 1 },
    WordEntry { word: "refactoring", weight: 1 }, WordEntry { word: "iteration", weight: 1 },
    WordEntry { word: "increment", weight: 1 }, WordEntry { word: "feedback", weight: 1 },
    WordEntry { word: "quality", weight: 1 }, WordEntry { word: "security", weight: 1 },
    WordEntry { word: "performance", weight: 1 }, WordEntry { word: "availability", weight: 1 },
    WordEntry { word: "reliability", weight: 1 }, WordEntry { word: "scalability", weight: 1 },
    WordEntry { word: "efficiency", weight: 1 }, WordEntry { word: "capacity", weight: 1 },
    WordEntry { word: "management", weight: 1 }, WordEntry { word: "governance", weight: 1 },
    WordEntry { word: "compliance", weight: 1 }, WordEntry { word: "provisioning", weight: 1 },
    WordEntry { word: "automation", weight: 1 }, WordEntry { word: "collaboration", weight: 1 },
    WordEntry { word: "communication", weight: 1 }, WordEntry { word: "coordination", weight: 1 },
    WordEntry { word: "synchronization", weight: 1 }, WordEntry { word: "consistency", weight: 1 },
    WordEntry { word: "isolation", weight: 1 }, WordEntry { word: "durability", weight: 1 },
    WordEntry { word: "integrity", weight: 1 }, WordEntry { word: "accountability", weight: 1 },
];// ── Sentence templates ──────────────────────────────────────────────────────
// {c} = Chinese word slot, {e} = English word slot.

const TEMPLATES: &[&str] = &[
    "{e} is the foundation of {c}.",
    "{c}的{e}决定了整体的{e}。",
    "The {e} of {c} depends on the underlying {e}.",
    "通过{c}的{e}可以优化{e}。",
    "When {e} interacts with {c}, the {e} of {c} evolves.",
    "{c}和{c}的{e}是{e}的核心要素。",
    "A robust {e} requires careful {c} and {e}.",
    "在{e}中，{c}的{e}比{c}的{e}更加重要。",
];

// ── Corpus ──────────────────────────────────────────────────────────────────

/// Embedded bilingual corpus that produces natural-looking text via
/// Zipf-weighted word selection and slot-filling sentence templates.
pub struct Corpus {
    chinese_words: &'static [WordEntry],
    english_words: &'static [WordEntry],
    templates: &'static [&'static str],
}

impl Corpus {
    /// Create a new `Corpus` with the built-in word lists and templates.
    pub const fn new() -> Self {
        Self {
            chinese_words: CHINESE_WORDS,
            english_words: ENGLISH_WORDS,
            templates: TEMPLATES,
        }
    }

    /// Pick a Chinese word using Zipf-weighted random selection.
    ///
    /// Words with higher frequency weights are proportionally more likely
    /// to be chosen.
    pub fn random_chinese_word(&self, rng: &mut ChaCha20Rng) -> &'static str {
        self.chinese_words
            .choose_weighted(rng, |entry| entry.weight as u64)
            .expect("chinese_words is non-empty")
            .word
    }

    /// Pick an English word using Zipf-weighted random selection.
    pub fn random_english_word(&self, rng: &mut ChaCha20Rng) -> &'static str {
        self.english_words
            .choose_weighted(rng, |entry| entry.weight as u64)
            .expect("english_words is non-empty")
            .word
    }

    /// Generate a sentence by filling a random template with words from
    /// the corpus.
    ///
    /// `max_words` caps the number of template slots filled; templates
    /// with more slots than `max_words` are skipped.  If no template fits
    /// (e.g. `max_words == 0`), returns an empty string.
    pub fn generate_sentence(&self, rng: &mut ChaCha20Rng, max_words: usize) -> String {
        if max_words == 0 {
            return String::new();
        }

        // Collect templates whose slot count fits within max_words.
        let fitting: Vec<&&str> = self
            .templates
            .iter()
            .filter(|t| count_slots(t) <= max_words)
            .collect();

        let template: &&str = if fitting.is_empty() {
            // Fallback: shortest template — every template has ≥2 slots
            // so this only triggers when max_words is 1.
            self.templates
                .iter()
                .min_by_key(|t| count_slots(t))
                .expect("templates is non-empty")
        } else {
            fitting[rng.random_range(0..fitting.len())]
        };

        fill_template(template, rng, self)
    }
}

// ── Helpers ─────────────────────────────────────────────────────────────────

/// Count the number of `{c}` and `{e}` slot markers in a template string.
fn count_slots(template: &str) -> usize {
    let mut count = 0;
    let bytes = template.as_bytes();
    let mut i = 0;
    while i + 2 < bytes.len() {
        // Look for '{c}' or '{e}' (each is exactly 3 bytes in UTF-8).
        if bytes[i] == b'{' && bytes[i + 2] == b'}' && (bytes[i + 1] == b'c' || bytes[i + 1] == b'e')
        {
            count += 1;
            i += 3;
        } else {
            i += 1;
        }
    }
    count
}

/// Replace `{c}` and `{e}` placeholders in a template with random words
/// from the corpus.
fn fill_template(template: &str, rng: &mut ChaCha20Rng, corpus: &Corpus) -> String {
    let mut result = String::with_capacity(template.len() * 2);
    let mut chars = template.chars().peekable();

    while let Some(&ch) = chars.peek() {
        if ch == '{' {
            chars.next(); // '{'
            let slot = chars.next(); // 'c' | 'e'
            chars.next(); // '}'
            match slot {
                Some('c') => result.push_str(corpus.random_chinese_word(rng)),
                Some('e') => result.push_str(corpus.random_english_word(rng)),
                _ => {} // malformed slot, skip
            }
        } else {
            result.push(ch);
            chars.next();
        }
    }

    result
}

// ── Tests ───────────────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;
    use rand_chacha::rand_core::SeedableRng;

    /// Same seed → same sentence every time (determinism).
    #[test]
    fn test_deterministic_output() {
        let corpus = Corpus::new();
        let mut rng_a = ChaCha20Rng::seed_from_u64(42);
        let mut rng_b = ChaCha20Rng::seed_from_u64(42);

        let a = corpus.generate_sentence(&mut rng_a, 4);
        let b = corpus.generate_sentence(&mut rng_b, 4);

        assert_eq!(a, b);
    }

    /// Generated sentences are never empty (except when max_words = 0).
    #[test]
    fn test_non_empty() {
        let corpus = Corpus::new();
        let mut rng = ChaCha20Rng::seed_from_u64(99);
        let sentence = corpus.generate_sentence(&mut rng, 4);
        assert!(!sentence.is_empty(), "sentence should not be empty");
    }

    /// Empty string when max_words is 0.
    #[test]
    fn test_max_words_zero() {
        let corpus = Corpus::new();
        let mut rng = ChaCha20Rng::seed_from_u64(77);
        let sentence = corpus.generate_sentence(&mut rng, 0);
        assert_eq!(sentence, "");
    }

    /// Different seeds produce different sentences (with overwhelming
    /// probability).
    #[test]
    fn test_different_seeds_differ() {
        let corpus = Corpus::new();
        let mut rng1 = ChaCha20Rng::seed_from_u64(1);
        let mut rng2 = ChaCha20Rng::seed_from_u64(999);

        let s1 = corpus.generate_sentence(&mut rng1, 4);
        let s2 = corpus.generate_sentence(&mut rng2, 4);

        assert_ne!(s1, s2, "different seeds should produce different sentences");
    }

    /// Chinese word selection returns a non-empty string from the list.
    #[test]
    fn test_random_chinese_word() {
        let corpus = Corpus::new();
        let mut rng = ChaCha20Rng::seed_from_u64(7);
        let word = corpus.random_chinese_word(&mut rng);
        assert!(!word.is_empty());
        // Verify it's actually one of our words.
        assert!(
            CHINESE_WORDS.iter().any(|e| e.word == word),
            "unexpected word: {word}"
        );
    }

    /// English word selection returns a non-empty string from the list.
    #[test]
    fn test_random_english_word() {
        let corpus = Corpus::new();
        let mut rng = ChaCha20Rng::seed_from_u64(13);
        let word = corpus.random_english_word(&mut rng);
        assert!(!word.is_empty());
        assert!(
            ENGLISH_WORDS.iter().any(|e| e.word == word),
            "unexpected word: {word}"
        );
    }

    /// Zipf weighting: the highest-weight word should appear more often
    /// than the lowest-weight word over many samples.
    #[test]
    fn test_zipf_weighting() {
        let corpus = Corpus::new();
        let mut rng = ChaCha20Rng::seed_from_u64(12345);

        let mut counts: [usize; 2] = [0; 2];
        let heavy = CHINESE_WORDS[0].word; // weight 30
        let light = CHINESE_WORDS[15].word; // weight 1

        for _ in 0..5000 {
            let w = corpus.random_chinese_word(&mut rng);
            if w == heavy {
                counts[0] += 1;
            } else if w == light {
                counts[1] += 1;
            }
        }

        // With weight 30 vs 1 over 5000 trials the heavy word should
        // easily win.  We assert > (not just >=) to catch a broken
        // choose_weighted implementation.
        assert!(
            counts[0] > counts[1],
            "heavy word (count={}) should appear more than light word (count={})",
            counts[0],
            counts[1],
        );
    }
}
