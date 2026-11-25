//! Recommendations: Capsio follows what each project studies and brings it new papers, news
//! and blog posts, each with the reason it was picked, in a daily brief. It works in the background while the app
//! is open, keeps everything on this device and calls the model the user chose for text
//! features; people only see the results. Design: docs/产品设计/专题/主动推荐与用户画像设计方案.md.
//!
//! A pass, for each project opened in the last week: read its library as seeds (`library`),
//! keep its research profile current (`profile`), fetch new papers (`sources`) and the posts
//! of its fields' news sites and blogs (`feeds`), keep the closest by text (`recall`), have the
//! model screen and score them (`judge`) and put the day's best in a brief (`brief`), with the
//! reports of one event as one entry (`events`). `store` keeps it all in one SQLite file.
//!
//! Across projects, an account profile (`account`) says who the user is: the screening and
//! scoring and the assistant read it, and it picks the day's field highlights (`highlights`).
//! `worker` runs the passes in the background with the real sources and model; `commands`
//! is what the page and the assistant ask for.

mod account;
mod alerts;
mod brief;
pub(crate) mod commands;
mod events;
mod feeds;
mod highlights;
mod judge;
mod library;
mod profile;
mod recall;
mod relations;
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
    /// A news or blog feed's document.
    fn feed(&self, url: &str) -> Result<String, String>;
    /// The OpenAlex work with this DOI.
    fn by_doi(&self, doi: &str) -> Result<Option<Work>, String>;
    /// Works published on or after `since` citing these OpenAlex works, each with the ones
    /// among them it cites.
    fn citing(&self, ids: &[String], since: &str) -> Result<Vec<(Work, Vec<String>)>, String>;
}

/// What one project's pass came to.
#[derive(Debug, Default, PartialEq)]
struct Pass {
    /// How many papers today's brief holds, when it was made in this pass.
    brief: Option<usize>,
    /// What is worth telling at once.
    alerts: Vec<alerts::Alert>,
    /// What went wrong without stopping the pass, for the log.
    warning: Option<String>,
}

/// One project's pass.
fn run_project(
    store: &Store,
    outside: &dyn Outside,
    project: &str,
    papers: &[Paper],
    account: Option<&account::Account>,
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
    let unreachable: Vec<String> = [
        sources::refresh(store, outside, project, &profile, clock).err(),
        feeds::refresh(store, outside, &profile, clock).err(),
        relations::refresh(store, outside, project, &seeds, clock).err(),
    ]
    .into_iter()
    .flatten()
    .collect();
    recall::pick(store, project, &seeds, &profile, clock)?;
    let about = account.map_or_else(String::new, |account| account.summary(600));
    judge::run(
        store,
        outside,
        &mut budget,
        project,
        &profile,
        &seeds,
        &about,
    )?;
    let brief = brief::make(store, outside, &mut budget, project, clock)?;
    let followed = account.map(account::Account::followed).unwrap_or_default();
    Ok(Pass {
        brief,
        alerts: alerts::raise(store, project, &followed, clock)?,
        warning: (!unreachable.is_empty()).then(|| unreachable.join("；")),
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
        /// Feed documents by address; other feeds cannot be reached.
        pub feeds: RefCell<HashMap<String, String>>,
        pub feeds_asked: RefCell<Vec<String>>,
        /// OpenAlex ids by DOI; papers citing library papers, with what they cite.
        pub openalex: RefCell<HashMap<String, String>>,
        pub citing: RefCell<Vec<(Work, Vec<String>)>>,
        pub citing_asked: RefCell<Vec<Vec<String>>>,
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
        fn feed(&self, url: &str) -> Result<String, String> {
            self.feeds_asked.borrow_mut().push(url.to_string());
            self.feeds
                .borrow()
                .get(url)
                .cloned()
                .ok_or_else(|| "unreachable".to_string())
        }
        fn by_doi(&self, doi: &str) -> Result<Option<Work>, String> {
            Ok(self.openalex.borrow().get(doi).map(|id| Work {
                id: format!("doi:{doi}"),
                openalex: Some(id.clone()),
                ..Work::default()
            }))
        }
        fn citing(&self, ids: &[String], _since: &str) -> Result<Vec<(Work, Vec<String>)>, String> {
            self.citing_asked.borrow_mut().push(ids.to_vec());
            Ok(self
                .citing
                .borrow()
                .iter()
                .filter(|(_, cited)| cited.iter().any(|id| ids.contains(id)))
                .cloned()
                .collect())
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
        // Of the field's news sources only TechCrunch answers, with one fresh post.
        outside.feeds.borrow_mut().insert(
            feeds::source("TechCrunch").unwrap().url.clone(),
            "<rss><channel><item><title>An assistant gets agent memory</title>\
             <link>https://techcrunch.com/memory</link><pubDate>Wed, 25 Nov 2026 01:00:00 GMT</pubDate>\
             <description>The assistant now keeps memory across chats.</description></item></channel></rss>"
                .into(),
        );
        // News is screened and scored before papers, so the post is first in each batch.
        outside.answers.borrow_mut().extend([
            r#"{"topics":[{"name":"智能体记忆","keywords":["agent memory","long-term memory"],"weight":1}],"categories":["cs.CL"]}"#.to_string(),
            r#"[{"id":0,"verdict":"pass"},{"id":1,"verdict":"pass"}]"#.to_string(),
            r#"[{"id":0,"rel":9,"sig":7,"nov":8,"cred":6,"use":8,"title":"助手加入跨对话记忆","summary":"助手可以记住之前的对话","reason":"和项目的长期记忆主题相关"},
                {"id":1,"rel":9,"sig":8,"nov":8,"cred":7,"title":"大模型智能体的分层长期记忆","summary":"把智能体记忆组织成层级","reason":"和 A-MEM 的记忆组织方式直接相关"}]"#.to_string(),
        ]);
        let made = run_project(&store, &outside, "p", &library(), None, &today).unwrap();
        assert_eq!(made.brief, Some(2));
        assert!(
            made.warning
                .is_some_and(|warning| warning.contains("OpenAI")),
            "the sources that did not answer are noted"
        );
        let shown = view(&store, "p").unwrap();
        assert_eq!(shown.state, "ready");
        assert_eq!(shown.items.len(), 2);
        assert_eq!(shown.items[1].kind, "news");
        assert_eq!(shown.items[1].title, "助手加入跨对话记忆");
        assert_eq!(shown.items[1].venue.as_deref(), Some("TechCrunch"));
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

        // The next pass, half an hour later, has nothing new and asks nothing.
        let later = Clock {
            now: today.now + 1800,
            ..today.clone()
        };
        assert_eq!(
            run_project(&store, &outside, "p", &library(), None, &later).unwrap(),
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
        run_project(&store, &outside, "small", &library()[..2], None, &today).unwrap();
        assert_eq!(view(&store, "small").unwrap().state, "needsPapers");
        let without = Fake {
            no_model: true,
            ..Fake::default()
        };
        run_project(&store, &without, "p", &library(), None, &today).unwrap();
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
            doi: None,
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

    /// The new papers citing a real project's library, through OpenAlex, without a model:
    /// `cargo test -p capsio --lib radar::live::real_citations -- --ignored --nocapture`, with
    /// `CAPSIO_LIVE_WORKSPACE` and `CAPSIO_LIVE_PROJECT` as below.
    #[test]
    #[ignore]
    fn real_citations_of_a_library() {
        let workspace =
            PathBuf::from(std::env::var("CAPSIO_LIVE_WORKSPACE").expect("CAPSIO_LIVE_WORKSPACE"));
        let project = std::env::var("CAPSIO_LIVE_PROJECT").expect("CAPSIO_LIVE_PROJECT");
        let papers: Vec<Paper> = capsio_core::library::LocalLibrary::new(workspace)
            .papers_for_reading(&project)
            .unwrap()
            .expect("the project has a literature folder")
            .into_iter()
            .map(Paper::from)
            .collect();
        let dir = tempfile::tempdir().unwrap();
        let store = Store::open(&dir.path().join("radar.sqlite")).unwrap();
        let live = Live::new(None);
        let clock = Clock::local();
        let seeds = library::seeds(&store, &live, &papers, clock.now).unwrap();
        let with_doi = seeds.iter().filter(|seed| seed.doi.is_some()).count();
        let found = relations::refresh(&store, &live, &project, &seeds, &clock).unwrap();
        for seed in &seeds {
            let key = seed.doi.clone().unwrap_or_else(|| {
                format!("title:{}", crate::scholar::normalized_title(&seed.title))
            });
            let id = store.openalex_id(&key).unwrap().and_then(|(id, _)| id);
            println!("  {:?} <- {}", id, seed.title);
        }
        println!(
            "{} library papers, {with_doi} with a DOI, {found} citing papers this week",
            seeds.len()
        );
        for pick in store
            .picks(&project, store::Stage::Recalled)
            .unwrap()
            .iter()
            .take(10)
        {
            println!(
                "- {} (cites {})",
                pick.work.title,
                pick.cites.as_deref().unwrap_or("?")
            );
        }
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
        let outcome = run_project(
            &store,
            &Live::new(Some(model)),
            &project,
            &papers,
            None,
            &clock,
        )
        .unwrap();
        println!(
            "outcome {outcome:?}, tokens {}",
            store.tokens(&clock.day, &project).unwrap()
        );
        for stage in [
            store::Stage::Dropped,
            store::Stage::Recalled,
            store::Stage::Blocked,
            store::Stage::Passed,
            store::Stage::Scored,
        ] {
            let picks = store.picks(&project, stage).unwrap();
            let posts = picks
                .iter()
                .filter(|pick| pick.work.kind != crate::scholar::Kind::Paper);
            println!(
                "{stage:?}: {} papers, {} posts",
                picks.len() - posts.clone().count(),
                posts.count()
            );
        }
        for pick in store.picks(&project, store::Stage::Scored).unwrap() {
            if pick.work.kind != crate::scholar::Kind::Paper {
                let venue = pick.work.venue.as_deref().unwrap_or_default();
                let title = pick.title.as_deref().unwrap_or_default();
                println!("post {:?} {venue}: {title}", pick.score);
            }
        }
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
            println!("- [{}] {} | {}", item.kind, item.title, item.original_title);
            println!("  {}\n  理由：{}", item.summary, item.reason);
            for report in &item.also {
                println!("  另见 {}", report.source);
            }
        }
        assert_eq!(shown.state, "ready");
    }
}
