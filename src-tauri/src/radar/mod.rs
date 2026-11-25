//! Recommendations: Capsio follows what each project studies and brings it new papers, each
//! with the reason it was picked, in a daily brief. It works in the background while the app
//! is open, keeps everything on this device and calls the model the user chose for text
//! features; people only see the results. Design: docs/产品设计/专题/主动推荐与用户画像设计方案.md.
//!
//! A pass, for each project opened in the last week: read its library as seeds (`library`),
//! keep its research profile current (`profile`), fetch new papers (`sources`), keep the
//! closest by text (`recall`), have the model screen and score them (`judge`) and put the
//! day's best in a brief (`brief`). `store` keeps it all in one SQLite file.
//!
//! `worker` runs the passes in the background with the real sources and model; `commands`
//! is what the page asks for.

mod brief;
pub(crate) mod commands;
mod judge;
mod library;
mod profile;
mod recall;
mod sources;
mod store;
pub(crate) mod worker;

use crate::scholar::Work;
use library::{Hint, Paper};
use sources::Query;
use store::Store;

/// A library with fewer papers says too little about a project.
const MIN_PAPERS: usize = 3;
/// What a call fails with when no model is set up for text features.
const NO_MODEL: &str = "还没有可用于后台功能的模型。";

/// What a project's recommendations page shows besides a brief.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum State {
    NeedsPapers,
    NoModel,
    Preparing,
}

impl State {
    fn name(self) -> &'static str {
        match self {
            State::NeedsPapers => "needsPapers",
            State::NoModel => "noModel",
            State::Preparing => "preparing",
        }
    }
}

/// The time a pass runs at, local to the user.
#[derive(Clone, Debug)]
pub(crate) struct Clock {
    /// Seconds since 1970.
    pub now: i64,
    /// `YYYY-MM-DD`.
    pub day: String,
    pub hour: u32,
}

impl Clock {
    fn local() -> Self {
        use chrono::Timelike;
        let now = chrono::Local::now();
        Self {
            now: now.timestamp(),
            day: now.format("%Y-%m-%d").to_string(),
            hour: now.hour(),
        }
    }

    /// The day `offset` days from today, `YYYY-MM-DD`.
    pub fn day_offset(&self, offset: i64) -> String {
        chrono::NaiveDate::parse_from_str(&self.day, "%Y-%m-%d")
            .map(|day| {
                (day + chrono::Duration::days(offset))
                    .format("%Y-%m-%d")
                    .to_string()
            })
            .unwrap_or_else(|_| self.day.clone())
    }
}

/// What a pass needs from outside the device: papers from the sources and a model to read
/// them. Tests stand in for both.
pub(crate) trait Outside {
    /// New papers for a query.
    fn search(&self, query: &Query) -> Result<Vec<Work>, String>;
    /// The paper a library file is, by its arXiv id, DOI or title.
    fn identify(&self, hint: &Hint) -> Result<Option<Work>, String>;
    /// Whether a model is set up for text features at all.
    fn has_model(&self) -> bool;
    /// One instruction and one request to the model.
    fn ask(&self, system: &str, user: &str, max_tokens: u32) -> Result<crate::ai::Answer, String>;
}

/// What one project's pass came to.
#[derive(Debug, Default, PartialEq)]
struct Pass {
    /// How many papers today's brief holds, when it was made in this pass.
    brief: Option<usize>,
    /// What went wrong without stopping the pass, for the log.
    warning: Option<String>,
}

/// One project's pass.
fn run_project(
    store: &Store,
    outside: &dyn Outside,
    project: &str,
    papers: &[Paper],
    clock: &Clock,
) -> Result<Pass, String> {
    let seeds = library::seeds(store, outside, papers, clock.now)?;
    if seeds.len() < MIN_PAPERS {
        store.set_status(project, State::NeedsPapers.name(), clock.now)?;
        return Ok(Pass::default());
    }
    if !outside.has_model() {
        store.set_status(project, State::NoModel.name(), clock.now)?;
        return Ok(Pass::default());
    }
    let mut budget = judge::Budget::today(store, project, &clock.day)?;
    let profile = match profile::current(store, outside, &mut budget, project, &seeds, clock.now) {
        Ok(profile) => profile,
        Err(error) if error == judge::SPENT => return Ok(Pass::default()),
        Err(error) => return Err(error),
    };
    store.set_status(project, State::Preparing.name(), clock.now)?;
    // Unreachable sources leave what was fetched before to work with.
    let warning = sources::refresh(store, outside, project, &profile, clock).err();
    recall::pick(store, project, &seeds, &profile, clock)?;
    judge::run(store, outside, &mut budget, project, &profile, &seeds)?;
    Ok(Pass {
        brief: brief::make(store, project, clock)?,
        warning,
    })
}

#[cfg(test)]
pub(crate) mod tests {
    use super::commands::view;
    use super::sources::Source;
    use super::store::Action;
    use super::*;
    use serde_json::json;
    use std::cell::RefCell;
    use std::collections::{HashMap, VecDeque};

    /// Sources and a model that answer from what a test put in.
    #[derive(Default)]
    pub(crate) struct Fake {
        /// Papers library files are found to be, by title.
        pub found: RefCell<HashMap<String, Work>>,
        pub lookups: RefCell<Vec<Hint>>,
        /// What every search returns.
        pub results: RefCell<Vec<Work>>,
        pub searches: RefCell<Vec<Query>>,
        /// The model's answers, in order.
        pub answers: RefCell<VecDeque<String>>,
        pub questions: RefCell<Vec<String>>,
        pub no_model: bool,
    }

    impl Outside for Fake {
        fn search(&self, query: &Query) -> Result<Vec<Work>, String> {
            self.searches.borrow_mut().push(query.clone());
            Ok(self.results.borrow().clone())
        }
        fn identify(&self, hint: &Hint) -> Result<Option<Work>, String> {
            self.lookups.borrow_mut().push(Hint {
                title: hint.title.clone(),
                arxiv: hint.arxiv.clone(),
                doi: hint.doi.clone(),
            });
            Ok(self.found.borrow().get(&hint.title).cloned())
        }
        fn has_model(&self) -> bool {
            !self.no_model
        }
        fn ask(
            &self,
            _system: &str,
            user: &str,
            _max_tokens: u32,
        ) -> Result<crate::ai::Answer, String> {
            if self.no_model {
                return Err(NO_MODEL.into());
            }
            self.questions.borrow_mut().push(user.to_string());
            let text = self
                .answers
                .borrow_mut()
                .pop_front()
                .ok_or("no answer left")?;
            Ok(crate::ai::Answer { text, tokens: None })
        }
    }

    pub(crate) fn clock(day: &str, hour: u32) -> Clock {
        Clock {
            now: chrono::NaiveDate::parse_from_str(day, "%Y-%m-%d")
                .unwrap()
                .and_hms_opt(hour, 0, 0)
                .unwrap()
                .and_utc()
                .timestamp(),
            day: day.into(),
            hour,
        }
    }

    /// A store where project `p` has recalled these works, the first closest.
    pub(crate) fn project_store(ids: &[&str]) -> (tempfile::TempDir, Store) {
        let dir = tempfile::tempdir().unwrap();
        let store = Store::open(&dir.path().join("radar.sqlite")).unwrap();
        let works: Vec<Work> = ids
            .iter()
            .map(|id| Work {
                id: id.to_string(),
                title: format!("Paper {id}"),
                ..Work::default()
            })
            .collect();
        store.add_works(&works, 0).unwrap();
        for (rank, id) in ids.iter().enumerate() {
            store
                .add_pick("p", id, 1.0 - rank as f64 / 10.0, store::Stage::Recalled, 0)
                .unwrap();
        }
        (dir, store)
    }

    fn paper(fingerprint: &str, title: &str, summary: &str) -> Paper {
        Paper {
            fingerprint: fingerprint.into(),
            path: format!("{title}.pdf"),
            modified: 0,
            reference: Some(json!({"title": title, "abstract": summary})),
        }
    }

    fn library() -> Vec<Paper> {
        vec![
            paper(
                "a",
                "A-MEM: Agentic Memory for LLM Agents",
                "Long-term memory for language model agents.",
            ),
            paper(
                "b",
                "LongMemEval",
                "Benchmarking chat assistants on long-term interactive memory.",
            ),
            paper(
                "c",
                "MemGPT",
                "Operating-system style memory management for LLM agents.",
            ),
        ]
    }

    #[test]
    fn a_pass_goes_from_the_library_to_a_brief() {
        let dir = tempfile::tempdir().unwrap();
        let store = Store::open(&dir.path().join("radar.sqlite")).unwrap();
        let outside = Fake::default();
        let today = clock("2026-11-25", 9);
        outside.results.borrow_mut().extend([
            Work {
                id: "arxiv:2611.00001".into(),
                title: "Hierarchical long-term memory for LLM agents".into(),
                summary:
                    "We organise the long-term memory of language model agents into a hierarchy."
                        .into(),
                published: Some("2026-11-24".into()),
                ..Work::default()
            },
            Work {
                id: "arxiv:2611.00002".into(),
                title: "Protein folding with diffusion".into(),
                summary: "A diffusion model predicts protein structures.".into(),
                published: Some("2026-11-24".into()),
                ..Work::default()
            },
            Work {
                id: "arxiv:2001.00003".into(),
                title: "An old paper on agent memory".into(),
                summary: "Long-term memory for agents.".into(),
                published: Some("2020-01-01".into()),
                ..Work::default()
            },
        ]);
        outside.answers.borrow_mut().extend([
            r#"{"topics":[{"name":"智能体记忆","keywords":["agent memory","long-term memory"],"weight":1}],"categories":["cs.CL"]}"#.to_string(),
            r#"[{"id":0,"verdict":"pass"}]"#.to_string(),
            r#"[{"id":0,"rel":9,"sig":8,"nov":8,"cred":7,"title":"大模型智能体的分层长期记忆","summary":"把智能体记忆组织成层级","reason":"和 A-MEM 的记忆组织方式直接相关"}]"#.to_string(),
        ]);
        let made = run_project(&store, &outside, "p", &library(), &today).unwrap();
        assert_eq!(
            made,
            Pass {
                brief: Some(1),
                warning: None
            }
        );
        let shown = view(&store, "p").unwrap();
        assert_eq!(shown.state, "ready");
        assert_eq!(shown.items.len(), 1);
        assert_eq!(shown.items[0].title, "大模型智能体的分层长期记忆");
        assert_eq!(
            shown.items[0].original_title,
            "Hierarchical long-term memory for LLM agents"
        );
        assert!(outside
            .searches
            .borrow()
            .iter()
            .any(|query| query.source == Source::Arxiv && query.text.contains("cat:cs.CL")));
        assert_eq!(
            outside.questions.borrow().len(),
            3,
            "profile, screening, scoring"
        );

        // The next pass the same day has nothing new and asks nothing.
        assert_eq!(
            run_project(&store, &outside, "p", &library(), &clock("2026-11-25", 10)).unwrap(),
            Pass::default()
        );
        assert_eq!(outside.questions.borrow().len(), 3);
        store
            .record("p", "arxiv:2611.00001", Action::Later, None, today.now)
            .unwrap();
        assert_eq!(view(&store, "p").unwrap().items[0].state, Some("later"));
    }

    #[test]
    fn small_libraries_and_missing_models_are_told_apart() {
        let dir = tempfile::tempdir().unwrap();
        let store = Store::open(&dir.path().join("radar.sqlite")).unwrap();
        let today = clock("2026-11-25", 9);
        let outside = Fake::default();
        run_project(&store, &outside, "small", &library()[..2], &today).unwrap();
        assert_eq!(view(&store, "small").unwrap().state, "needsPapers");
        let without = Fake {
            no_model: true,
            ..Fake::default()
        };
        run_project(&store, &without, "p", &library(), &today).unwrap();
        assert_eq!(view(&store, "p").unwrap().state, "noModel");
        assert_eq!(view(&store, "unseen").unwrap().state, "preparing");
    }
}

#[cfg(test)]
mod live {
    use super::commands::view;
    use super::worker::Live;
    use super::*;
    use crate::ai::TextModel;
    use std::path::PathBuf;

    /// The real sources for a hand-written profile, and what recall keeps of them, without a
    /// model: `cargo test -p capsio --lib radar::live -- --ignored --nocapture`.
    #[test]
    #[ignore]
    fn real_sources_feed_recall() {
        let dir = tempfile::tempdir().unwrap();
        let store = Store::open(&dir.path().join("radar.sqlite")).unwrap();
        let clock = Clock::local();
        let seeds: Vec<library::Seed> = [
            "A-MEM: Agentic Memory for LLM Agents",
            "LongMemEval: Benchmarking Chat Assistants on Long-Term Interactive Memory",
            "Evaluating Very Long-Term Conversational Memory of LLM Agents",
            "MemGPT: Towards LLMs as Operating Systems",
            "Evo-Memory: Benchmarking LLM Agent Test-time Learning with Self-Evolving Memory",
        ]
        .iter()
        .map(|title| library::Seed {
            fingerprint: title.to_string(),
            title: title.to_string(),
            summary: String::new(),
            added: clock.now,
        })
        .collect();
        let profile = profile::Profile {
            topics: vec![profile::Topic {
                name: "智能体记忆".into(),
                keywords: vec![
                    "agent memory".into(),
                    "long-term memory".into(),
                    "memory benchmark".into(),
                ],
                weight: 1.0,
            }],
            categories: vec!["cs.CL".into(), "cs.AI".into()],
        };
        let live = Live::new(None);
        let fetched = sources::refresh(&store, &live, "p", &profile, &clock).unwrap();
        let kept = recall::pick(&store, "p", &seeds, &profile, &clock).unwrap();
        println!("fetched {fetched}, kept {kept}");
        for pick in store
            .picks("p", store::Stage::Recalled)
            .unwrap()
            .iter()
            .take(10)
        {
            println!(
                "- {} ({})",
                pick.work.title,
                pick.work.published.as_deref().unwrap_or("?")
            );
        }
        assert!(fetched > 0 && kept > 0);
    }

    /// A whole pass on a real project with the model its workspace uses for text features.
    /// Costs a few model calls. `CAPSIO_LIVE_WORKSPACE` is a workspace folder (the one with
    /// workspace.json), `CAPSIO_LIVE_PROJECT` a project id in it:
    /// `cargo test -p capsio --lib radar::live::a_real -- --ignored --nocapture`.
    #[test]
    #[ignore]
    fn a_real_model_writes_a_brief() {
        let workspace =
            PathBuf::from(std::env::var("CAPSIO_LIVE_WORKSPACE").expect("CAPSIO_LIVE_WORKSPACE"));
        let project = std::env::var("CAPSIO_LIVE_PROJECT").expect("CAPSIO_LIVE_PROJECT");
        let data: serde_json::Value =
            serde_json::from_slice(&std::fs::read(workspace.join("workspace.json")).unwrap())
                .unwrap();
        let settings = crate::ai::text_connection(&data).unwrap();
        let field = |name: &str| settings[name].as_str().unwrap_or_default().to_string();
        let model = TextModel {
            api_key: crate::credentials::load_for_model(
                &workspace,
                &field("provider"),
                &field("endpoint"),
            )
            .unwrap()
            .unwrap_or_default(),
            provider: field("provider"),
            endpoint: field("endpoint"),
            model: field("model"),
            official: false,
        };
        let papers: Vec<Paper> = capsio_core::library::LocalLibrary::new(workspace.clone())
            .papers_for_reading(&project)
            .unwrap()
            .expect("the project has a literature folder")
            .into_iter()
            .map(Paper::from)
            .collect();
        let dir = tempfile::tempdir().unwrap();
        let store = Store::open(&dir.path().join("radar.sqlite")).unwrap();
        let clock = Clock {
            hour: 9,
            ..Clock::local()
        };
        let outcome =
            run_project(&store, &Live::new(Some(model)), &project, &papers, &clock).unwrap();
        println!(
            "outcome {outcome:?}, tokens {}",
            store.tokens(&clock.day, &project).unwrap()
        );
        println!(
            "profile {}",
            store
                .profile(&project)
                .unwrap()
                .map(|(json, ..)| json)
                .unwrap_or_default()
        );
        let shown = view(&store, &project).unwrap();
        for item in &shown.items {
            println!("- {} | {}", item.title, item.original_title);
            println!("  {}\n  理由：{}", item.summary, item.reason);
        }
        assert_eq!(shown.state, "ready");
    }
}
