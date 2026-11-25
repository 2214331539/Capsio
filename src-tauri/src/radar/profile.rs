//! What a project studies, as the recommendations see it: a few topics with the words papers
//! about them use, and the arXiv categories to watch. The model writes it from the library;
//! nobody is shown it.

use super::judge::{json_in, Budget};
use super::library::Seed;
use super::store::Store;
use super::Outside;
use serde::{Deserialize, Serialize};

const PROMPT: &str = include_str!("prompts/profile.md");
/// Rebuilt when the library has grown by this many papers, or after a week.
const GROWTH: usize = 3;
const STALE: i64 = 7 * 86_400;
/// The papers the model reads: the newest, which say most about where the project is going.
const READ: usize = 40;
/// Room for the answer and for the thoughts of a model that thinks first.
const ANSWER_TOKENS: u32 = 4096;

/// arXiv's categories in computing and its neighbours; the first disciplines covered.
const CATEGORIES: &[&str] = &[
    "cs.AI", "cs.AR", "cs.CC", "cs.CE", "cs.CG", "cs.CL", "cs.CR", "cs.CV", "cs.CY", "cs.DB",
    "cs.DC", "cs.DL", "cs.DM", "cs.DS", "cs.ET", "cs.FL", "cs.GR", "cs.GT", "cs.HC", "cs.IR",
    "cs.IT", "cs.LG", "cs.LO", "cs.MA", "cs.MM", "cs.MS", "cs.NE", "cs.NI", "cs.OS", "cs.PF",
    "cs.PL", "cs.RO", "cs.SC", "cs.SD", "cs.SE", "cs.SI", "cs.SY", "eess.AS", "eess.IV", "eess.SP",
    "eess.SY", "stat.ML", "math.OC", "q-bio.NC",
];

#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
pub(crate) struct Profile {
    pub topics: Vec<Topic>,
    pub categories: Vec<String>,
}

#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
pub(crate) struct Topic {
    /// A short Chinese name.
    pub name: String,
    /// English words and phrases papers on the topic use.
    pub keywords: Vec<String>,
    /// 0–1: how central the topic is to the project.
    pub weight: f64,
}

impl Profile {
    /// Keeps what can be used: known categories, topics with keywords, sane weights and sizes.
    fn checked(mut self) -> Option<Self> {
        let mut seen = std::collections::HashSet::new();
        self.categories.retain(|category| {
            CATEGORIES.contains(&category.as_str()) && seen.insert(category.clone())
        });
        self.categories.truncate(4);
        for topic in &mut self.topics {
            topic.name = topic.name.trim().chars().take(24).collect();
            topic.keywords = topic
                .keywords
                .iter()
                .map(|keyword| keyword.trim().to_lowercase())
                .filter(|keyword| (3..=60).contains(&keyword.len()) && keyword.is_ascii())
                .take(6)
                .collect();
            topic.weight = topic.weight.clamp(0.1, 1.0);
        }
        self.topics
            .retain(|topic| !topic.name.is_empty() && !topic.keywords.is_empty());
        self.topics.truncate(8);
        (!self.topics.is_empty()).then_some(self)
    }
}

/// The project's profile, rebuilt first when the library has changed enough. Fails only
/// when there is none yet and the model cannot write one now.
pub(crate) fn current(
    store: &Store,
    outside: &dyn Outside,
    budget: &mut Budget,
    project: &str,
    seeds: &[Seed],
    now: i64,
) -> Result<Profile, String> {
    let saved = store.profile(project)?.and_then(|(json, papers, built)| {
        Some((serde_json::from_str::<Profile>(&json).ok()?, papers, built))
    });
    match saved {
        Some((profile, papers, built)) if seeds.len() < papers + GROWTH && now - built < STALE => {
            Ok(profile)
        }
        saved => match build(outside, budget, seeds) {
            Ok(profile) => {
                let json = serde_json::to_string(&profile).map_err(|e| e.to_string())?;
                store.put_profile(project, &json, seeds.len(), now)?;
                Ok(profile)
            }
            // The old profile serves until a new one can be written.
            Err(error) => saved.map(|(profile, _, _)| profile).ok_or(error),
        },
    }
}

fn build(outside: &dyn Outside, budget: &mut Budget, seeds: &[Seed]) -> Result<Profile, String> {
    let mut newest: Vec<&Seed> = seeds.iter().collect();
    newest.sort_by_key(|seed| std::cmp::Reverse(seed.added));
    let papers: Vec<String> = newest
        .iter()
        .take(READ)
        .map(|seed| {
            let summary: String = seed.summary.chars().take(400).collect();
            if summary.is_empty() {
                format!("- {}", seed.title)
            } else {
                format!("- {}：{summary}", seed.title)
            }
        })
        .collect();
    let answer = budget.ask(outside, PROMPT, &papers.join("\n"), ANSWER_TOKENS)?;
    json_in::<Profile>(&answer)
        .and_then(Profile::checked)
        .ok_or_else(|| "模型没有给出可用的研究方向。".to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn profiles_keep_only_what_the_sources_can_use() {
        let profile = Profile {
            topics: vec![
                Topic {
                    name: "  智能体记忆 ".into(),
                    keywords: vec![
                        "Agent Memory".into(),
                        "x".into(),
                        "记忆".into(),
                        "long-term memory".into(),
                    ],
                    weight: 3.0,
                },
                Topic {
                    name: "空主题".into(),
                    keywords: vec!["ab".into()],
                    weight: 0.5,
                },
            ],
            categories: vec![
                "cs.CL".into(),
                "cs.CL".into(),
                "physics.optics".into(),
                "cs.AI".into(),
            ],
        }
        .checked()
        .unwrap();
        assert_eq!(profile.categories, ["cs.CL", "cs.AI"]);
        assert_eq!(profile.topics.len(), 1);
        assert_eq!(profile.topics[0].name, "智能体记忆");
        assert_eq!(
            profile.topics[0].keywords,
            ["agent memory", "long-term memory"]
        );
        assert_eq!(profile.topics[0].weight, 1.0);
        assert!(Profile::default().checked().is_none());
    }
}
