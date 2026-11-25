//! Field highlights: the day's big news in the user's fields, whatever each project studies. A
//! narrow project rarely finds the day's news close enough to recommend; an event that several
//! sources report, in a field of the account profile, is still worth a line. The model picks the
//! events and says why they matter to this user; at least three distinct sources is checked
//! here. At most two a day, shown above every project's recommendations.

use super::account::{Account, BUDGET_KEY};
use super::brief::FROM_HOUR;
use super::feeds::{self, FRESH_DAYS};
use super::judge::{json_in, Budget, SPENT};
use super::store::Store;
use super::{Clock, Outside};
use crate::scholar::Work;
use serde::{Deserialize, Serialize};
use serde_json::json;

const PROMPT: &str = include_str!("prompts/highlights.md");
const ANSWER_TOKENS: u32 = 8192;
/// Distinct sources an event needs to be a highlight.
pub(crate) const SOURCES: usize = 3;
/// Highlights a day.
const MOST: usize = 2;
/// Posts shown to the model, newest first.
const CANDIDATES: usize = 120;
/// Earlier highlights the model compares against, so an event is not told twice.
const TOLD_DAYS: i64 = 7;

/// One highlight: the lead report, the others, and what the model wrote about the event.
#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
pub(crate) struct Highlight {
    pub id: String,
    #[serde(default)]
    pub also: Vec<String>,
    pub title: String,
    pub summary: String,
    pub reason: String,
}

#[derive(Deserialize)]
struct Pick {
    #[serde(default)]
    ids: Vec<usize>,
    #[serde(default)]
    title: String,
    #[serde(default)]
    summary: String,
    #[serde(default)]
    reason: String,
}

/// The newest highlights, if made in the last two days.
pub(crate) fn latest(store: &Store, clock: &Clock) -> Result<Vec<Highlight>, String> {
    Ok(store
        .highlights_since(&clock.day_offset(-1))?
        .into_iter()
        .next()
        .and_then(|(_, json)| serde_json::from_str(&json).ok())
        .unwrap_or_default())
}

/// Makes today's highlights once, from six in the morning. Returns how many there are when
/// they were made in this call.
pub(crate) fn make(
    store: &Store,
    outside: &dyn Outside,
    account: &Account,
    clock: &Clock,
) -> Result<Option<usize>, String> {
    if clock.hour < FROM_HOUR || store.highlights(&clock.day)?.is_some() {
        return Ok(None);
    }
    let fields = account.summary(400);
    let mut posts = store.recent_posts(clock.now - FRESH_DAYS * 86_400)?;
    posts.truncate(CANDIDATES);
    let chosen = if fields.is_empty() || distinct_sources(&posts) < SOURCES {
        Vec::new()
    } else {
        let told: Vec<String> = store
            .highlights_since(&clock.day_offset(-TOLD_DAYS))?
            .into_iter()
            .filter_map(|(_, json)| serde_json::from_str::<Vec<Highlight>>(&json).ok())
            .flatten()
            .map(|highlight| highlight.title)
            .collect();
        let mut budget = Budget::today(store, BUDGET_KEY, &clock.day)?;
        match budget.ask(
            outside,
            PROMPT,
            &request(&fields, &posts, &told),
            ANSWER_TOKENS,
        ) {
            Ok(answer) => choose(json_in::<Vec<Pick>>(&answer).unwrap_or_default(), &posts),
            // Tried again in a later pass, once there is budget.
            Err(error) if error == SPENT => return Ok(None),
            // Any other failure: no highlights today, rather than asking again every pass.
            Err(_) => Vec::new(),
        }
    };
    store.put_highlights(
        &clock.day,
        &serde_json::to_string(&chosen).map_err(|e| e.to_string())?,
    )?;
    Ok(Some(chosen.len()))
}

fn request(fields: &str, posts: &[Work], told: &[String]) -> String {
    let list: Vec<_> = posts
        .iter()
        .enumerate()
        .map(|(id, post)| {
            json!({
                "id": id,
                "source": post.venue.as_deref().unwrap_or_default(),
                "title": post.title,
                "summary": post.summary.chars().take(200).collect::<String>(),
            })
        })
        .collect();
    format!(
        "这位研究者的领域：\n{fields}\n\n近两天的动态：\n{}\n\n近一周已经推送过的要闻：\n{}",
        serde_json::to_string_pretty(&list).unwrap_or_default(),
        serde_json::to_string_pretty(told).unwrap_or_default(),
    )
}

/// The model's events that really have enough distinct sources, most sources first.
fn choose(picks: Vec<Pick>, posts: &[Work]) -> Vec<Highlight> {
    let mut chosen: Vec<(usize, Highlight)> = picks
        .into_iter()
        .filter_map(|pick| {
            let mut reports: Vec<&Work> = Vec::new();
            for work in pick.ids.iter().filter_map(|&id| posts.get(id)) {
                if !reports.iter().any(|other| other.id == work.id) {
                    reports.push(work);
                }
            }
            let sources = distinct_sources(reports.iter().copied());
            if sources < SOURCES || pick.title.trim().is_empty() {
                return None;
            }
            // The most official source leads.
            reports.sort_by_key(|work| {
                work.venue
                    .as_deref()
                    .and_then(feeds::source)
                    .map_or(3, |f| f.tier)
            });
            let highlight = Highlight {
                id: reports[0].id.clone(),
                also: reports[1..].iter().map(|work| work.id.clone()).collect(),
                title: pick.title.trim().to_string(),
                summary: pick.summary.trim().to_string(),
                reason: pick.reason.trim().to_string(),
            };
            Some((sources, highlight))
        })
        .collect();
    chosen.sort_by_key(|(sources, _)| std::cmp::Reverse(*sources));
    chosen
        .into_iter()
        .take(MOST)
        .map(|(_, highlight)| highlight)
        .collect()
}

fn distinct_sources<'a>(posts: impl IntoIterator<Item = &'a Work>) -> usize {
    let mut sources: Vec<&str> = posts
        .into_iter()
        .filter_map(|post| post.venue.as_deref())
        .collect();
    sources.sort_unstable();
    sources.dedup();
    sources.len()
}

#[cfg(test)]
mod tests {
    use super::super::account::Fact;
    use super::super::tests::{clock, Fake};
    use super::*;
    use crate::scholar::Kind;

    fn post(id: &str, source: &str) -> Work {
        Work {
            id: id.into(),
            title: format!("Report {id}"),
            venue: Some(source.into()),
            kind: Kind::News,
            ..Work::default()
        }
    }

    fn account() -> Account {
        Account {
            facts: vec![Fact {
                topic: "研究".into(),
                item: "长期方向".into(),
                value: "大模型智能体".into(),
                confidence: 0.9,
                evidence: 5,
            }],
        }
    }

    #[test]
    fn an_event_needs_three_sources_and_the_official_one_leads() {
        let dir = tempfile::tempdir().unwrap();
        let store = Store::open(&dir.path().join("radar.sqlite")).unwrap();
        let today = clock("2026-11-25", 9);
        store
            .add_works(
                &[
                    post("verge", "The Verge"),
                    post("openai", "OpenAI"),
                    post("techcrunch", "TechCrunch"),
                    post("ars", "Ars Technica"),
                    post("verge2", "The Verge"),
                ],
                today.now,
            )
            .unwrap();
        let outside = Fake::default();
        // The model names posts by their place in the request, which lists them as
        // recent_posts returns them.
        let listed: Vec<String> = store
            .recent_posts(0)
            .unwrap()
            .into_iter()
            .map(|work| work.id)
            .collect();
        let at = |id: &str| listed.iter().position(|other| other == id).unwrap();
        outside.answers.borrow_mut().push_back(format!(
            r#"[{{"ids":[{},{},{}],"title":"新模型发布","summary":"一句话","reason":"和智能体相关"}},
                {{"ids":[{},{}],"title":"两家报道","summary":"","reason":""}}]"#,
            at("verge"),
            at("openai"),
            at("techcrunch"),
            at("ars"),
            at("verge2"),
        ));
        assert_eq!(make(&store, &outside, &account(), &today).unwrap(), Some(1));
        let shown = latest(&store, &today).unwrap();
        assert_eq!(shown.len(), 1);
        assert_eq!(shown[0].id, "openai");
        assert_eq!(shown[0].also.len(), 2);
        assert_eq!(shown[0].title, "新模型发布");
        // Once a day.
        assert_eq!(make(&store, &outside, &account(), &today).unwrap(), None);
    }

    #[test]
    fn without_fields_or_enough_sources_there_are_none_and_nothing_is_asked() {
        let dir = tempfile::tempdir().unwrap();
        let store = Store::open(&dir.path().join("radar.sqlite")).unwrap();
        let today = clock("2026-11-25", 9);
        store
            .add_works(&[post("a", "OpenAI"), post("b", "OpenAI")], today.now)
            .unwrap();
        let outside = Fake::default();
        assert_eq!(make(&store, &outside, &account(), &today).unwrap(), Some(0));
        assert!(outside.questions.borrow().is_empty());
        assert!(latest(&store, &today).unwrap().is_empty());
    }
}
