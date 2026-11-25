//! Which new papers are close to a project, by their words alone: TF-IDF over the library's
//! titles and abstracts, newer library papers counting more, plus the profile's keywords and
//! minus what the user dismissed. Cheap enough to run over every new paper, so the model
//! only reads the closest.

use super::library::Seed;
use super::profile::Profile;
use super::store::{Action, Stage, Store};
use super::Clock;
use crate::scholar::Work;
use std::collections::{HashMap, HashSet};

/// The closest papers per pass that go on to the model.
const KEEP: usize = 40;
/// Below this a paper shares too little with the project to be worth the model's time.
const FLOOR: f64 = 0.03;
/// A library paper's extra weight for being new halves every this many days: a new paper
/// counts fully, one this old three quarters, a very old one half.
const HALF_LIFE_DAYS: f64 = 120.0;

const STOPWORDS: &[&str] = &[
    "the",
    "and",
    "for",
    "with",
    "from",
    "that",
    "this",
    "these",
    "those",
    "are",
    "was",
    "were",
    "been",
    "being",
    "have",
    "has",
    "had",
    "not",
    "but",
    "can",
    "could",
    "may",
    "might",
    "will",
    "would",
    "should",
    "into",
    "onto",
    "over",
    "under",
    "than",
    "then",
    "there",
    "their",
    "its",
    "our",
    "your",
    "they",
    "them",
    "which",
    "what",
    "when",
    "where",
    "while",
    "who",
    "whom",
    "how",
    "all",
    "any",
    "each",
    "both",
    "such",
    "only",
    "also",
    "very",
    "more",
    "most",
    "less",
    "other",
    "some",
    "many",
    "much",
    "via",
    "using",
    "use",
    "used",
    "based",
    "show",
    "shows",
    "propose",
    "proposed",
    "paper",
    "approach",
    "method",
    "methods",
    "results",
    "new",
    "novel",
    "work",
    "study",
    "two",
    "one",
    "three",
    "first",
    "however",
    "well",
    "among",
    "across",
    "within",
    "without",
    "between",
    "through",
    "towards",
    "toward",
    "does",
    "did",
    "achieve",
    "achieves",
    "existing",
    "recent",
    "present",
    "introduce",
    "framework",
];

type Vector = HashMap<String, f64>;

/// What a project is interested in, ready to compare papers against.
pub(crate) struct Interest {
    idf: HashMap<String, f64>,
    seeds: Vec<(Vector, f64)>,
    rejected: Vec<Vector>,
    keywords: Vec<(String, f64)>,
}

impl Interest {
    /// `others` are the papers about to be compared, so rare words are rare in what is read.
    pub fn new(
        seeds: &[Seed],
        rejected: &[Work],
        others: &[Work],
        profile: &Profile,
        now: i64,
    ) -> Self {
        let seed_terms: Vec<Vec<String>> = seeds
            .iter()
            .map(|seed| terms(&format!("{} {}", seed.title, seed.summary)))
            .collect();
        let rejected_terms: Vec<Vec<String>> = rejected.iter().map(text_terms).collect();
        let other_terms: Vec<Vec<String>> = others.iter().map(text_terms).collect();
        let documents = seed_terms.len() + rejected_terms.len() + other_terms.len();
        let mut frequency: HashMap<&str, usize> = HashMap::new();
        for document in seed_terms.iter().chain(&rejected_terms).chain(&other_terms) {
            for term in document.iter().map(String::as_str).collect::<HashSet<_>>() {
                *frequency.entry(term).or_default() += 1;
            }
        }
        let idf = frequency
            .into_iter()
            .map(|(term, count)| {
                (
                    term.to_string(),
                    ((1 + documents) as f64 / (1 + count) as f64).ln() + 1.0,
                )
            })
            .collect();
        let mut interest = Self {
            idf,
            seeds: Vec::new(),
            rejected: Vec::new(),
            keywords: profile
                .topics
                .iter()
                .flat_map(|topic| {
                    topic
                        .keywords
                        .iter()
                        .map(|keyword| (keyword.clone(), topic.weight))
                })
                .collect(),
        };
        interest.seeds = seeds
            .iter()
            .zip(&seed_terms)
            .map(|(seed, terms)| {
                let age_days = (now - seed.added).max(0) as f64 / 86_400.0;
                (
                    interest.vector(terms),
                    0.5 + 0.5 * (-age_days / HALF_LIFE_DAYS).exp2(),
                )
            })
            .collect();
        interest.rejected = rejected_terms
            .iter()
            .map(|terms| interest.vector(terms))
            .collect();
        interest
    }

    /// How close a paper is to the project, about 0–1.
    pub fn score(&self, work: &Work) -> f64 {
        let vector = self.vector(&text_terms(work));
        let mut similar: Vec<f64> = self
            .seeds
            .iter()
            .map(|(seed, weight)| cosine(&vector, seed) * weight)
            .collect();
        similar.sort_by(|a, b| b.total_cmp(a));
        let best = similar.first().copied().unwrap_or(0.0);
        let near = similar.iter().take(3).sum::<f64>() / similar.len().clamp(1, 3) as f64;
        let text = format!("{} {}", work.title, work.summary).to_lowercase();
        let keywords = self
            .keywords
            .iter()
            .filter(|(keyword, _)| text.contains(keyword.as_str()))
            .map(|(_, weight)| 0.06 * weight)
            .sum::<f64>()
            .min(0.3);
        let rejected = self
            .rejected
            .iter()
            .map(|other| cosine(&vector, other))
            .fold(0.0, f64::max);
        0.75 * best + 0.25 * near + keywords - 0.5 * rejected
    }

    fn vector(&self, terms: &[String]) -> Vector {
        let mut vector: Vector = HashMap::new();
        for term in terms {
            *vector.entry(term.clone()).or_default() += 1.0;
        }
        for (term, weight) in vector.iter_mut() {
            *weight *= self.idf.get(term).copied().unwrap_or(1.0);
        }
        let norm = vector.values().map(|w| w * w).sum::<f64>().sqrt();
        if norm > 0.0 {
            vector.values_mut().for_each(|w| *w /= norm);
        }
        vector
    }
}

fn text_terms(work: &Work) -> Vec<String> {
    terms(&format!("{} {}", work.title, work.summary))
}

/// Lower-case words of three letters or more that are not stopwords, and each pair of
/// neighbouring words, which carries most of the meaning of technical phrases.
fn terms(text: &str) -> Vec<String> {
    let lower = text.to_lowercase();
    let words: Vec<&str> = lower
        .split(|c: char| !c.is_alphanumeric() && c != '-')
        .map(|word| word.trim_matches('-'))
        .filter(|word| {
            word.len() >= 3
                && !STOPWORDS.contains(word)
                && !word.chars().all(|c| c.is_ascii_digit())
        })
        .collect();
    let pairs = words
        .windows(2)
        .map(|pair| format!("{} {}", pair[0], pair[1]));
    words
        .iter()
        .map(|word| word.to_string())
        .chain(pairs)
        .collect()
}

fn cosine(a: &Vector, b: &Vector) -> f64 {
    let (small, large) = if a.len() <= b.len() { (a, b) } else { (b, a) };
    small
        .iter()
        .filter_map(|(term, weight)| large.get(term).map(|other| weight * other))
        .sum()
}

/// Puts this pass's closest new papers in front of the model; the rest are set aside so
/// they are not compared again. Returns how many go on.
pub(crate) fn pick(
    store: &Store,
    project: &str,
    seeds: &[Seed],
    profile: &Profile,
    clock: &Clock,
) -> Result<usize, String> {
    let fresh = store.unconsidered(project, clock.now - super::sources::WINDOW_DAYS * 86_400)?;
    if fresh.is_empty() {
        return Ok(0);
    }
    let rejected = store.works(&store.with_action(project, Action::Dismissed)?)?;
    let interest = Interest::new(seeds, &rejected, &fresh, profile, clock.now);
    let mut scored: Vec<(f64, &Work)> = fresh
        .iter()
        .map(|work| (interest.score(work), work))
        .collect();
    scored.sort_by(|a, b| b.0.total_cmp(&a.0));
    let mut kept = 0;
    for (score, work) in scored {
        if kept < KEEP && score >= FLOOR {
            store.add_pick(project, &work.id, score, Stage::Recalled, clock.now)?;
            kept += 1;
        } else {
            store.add_pick(project, &work.id, score, Stage::Dropped, clock.now)?;
        }
    }
    Ok(kept)
}

#[cfg(test)]
mod tests {
    use super::super::profile::Topic;
    use super::*;

    fn seed(title: &str, summary: &str, added: i64) -> Seed {
        Seed {
            fingerprint: title.into(),
            title: title.into(),
            summary: summary.into(),
            added,
        }
    }
    fn work(title: &str, summary: &str) -> Work {
        Work {
            id: title.into(),
            title: title.into(),
            summary: summary.into(),
            ..Work::default()
        }
    }

    #[test]
    fn papers_on_the_library_s_subject_rank_first() {
        let seeds = [
            seed(
                "A-MEM: Agentic Memory for LLM Agents",
                "Long-term memory lets language model agents remember past interactions.",
                0,
            ),
            seed(
                "LongMemEval",
                "Benchmarking chat assistants on long-term interactive memory.",
                0,
            ),
        ];
        let candidates = [
            work(
                "Hierarchical memory for LLM agents",
                "We organise long-term memory of language model agents into a hierarchy.",
            ),
            work(
                "Protein folding with diffusion",
                "A diffusion model predicts protein structures.",
            ),
            work(
                "Faster image segmentation",
                "Segmenting images with a lighter backbone.",
            ),
        ];
        let profile = Profile {
            topics: vec![Topic {
                name: "记忆".into(),
                keywords: vec!["long-term memory".into()],
                weight: 1.0,
            }],
            categories: vec![],
        };
        let interest = Interest::new(&seeds, &[], &candidates, &profile, 0);
        let scores: Vec<f64> = candidates.iter().map(|work| interest.score(work)).collect();
        assert!(scores[0] > 0.2, "{scores:?}");
        assert!(scores[0] > 4.0 * scores[1].max(scores[2]), "{scores:?}");
    }

    #[test]
    fn newer_library_papers_and_dismissals_shape_the_score() {
        let year = 365 * 86_400;
        let old = [seed(
            "Graph retrieval",
            "Retrieval over knowledge graphs.",
            0,
        )];
        let new = [seed(
            "Graph retrieval",
            "Retrieval over knowledge graphs.",
            year,
        )];
        let paper = work(
            "Knowledge graph retrieval for QA",
            "Retrieval over knowledge graphs answers questions.",
        );
        let profile = Profile::default();
        let older =
            Interest::new(&old, &[], std::slice::from_ref(&paper), &profile, year).score(&paper);
        let newer =
            Interest::new(&new, &[], std::slice::from_ref(&paper), &profile, year).score(&paper);
        assert!(newer > older);
        let dismissed = [work(
            "Knowledge graph retrieval survey",
            "Retrieval over knowledge graphs, surveyed.",
        )];
        let after = Interest::new(
            &new,
            &dismissed,
            std::slice::from_ref(&paper),
            &profile,
            year,
        )
        .score(&paper);
        assert!(after < newer);
    }

    #[test]
    fn terms_keep_technical_words_and_their_pairs() {
        assert_eq!(
            terms("We propose Long-Term memory for the LLM agents (2024)."),
            [
                "long-term",
                "memory",
                "llm",
                "agents",
                "long-term memory",
                "memory llm",
                "llm agents"
            ]
        );
    }
}
