//! The reports of one event become one brief entry, led by the report from the most official
//! source and ranked higher the more sources carry it. The model decides which reports tell the
//! same thing, and which tell what a brief of the past week already showed; heat counts each
//! source once and halves by the day, as AIHOT does (MIT, github.com/KKKKhazix/AIHOT).

use super::feeds;
use super::judge::{json_in, Budget};
use super::store::Pick;
use super::{Clock, Outside};
use serde::Deserialize;
use serde_json::json;
use std::collections::HashMap;

const PROMPT: &str = include_str!("prompts/events.md");
const ANSWER_TOKENS: u32 = 8192;
/// Candidates grouped in one call, best first; a brief only takes a few.
const MOST: usize = 40;
/// Reports already shown that the model compares against.
const TOLD: usize = 30;
/// Each source beyond the first, while fresh, adds this much to an event's rank, up to `MOST_HEAT`.
const HEAT_POINTS: f64 = 4.0;
const MOST_HEAT: f64 = 12.0;

pub(crate) struct Event {
    pub lead: Pick,
    pub also: Vec<Pick>,
    /// The sources carrying it, each counted once and halving by the day: one fresh report is 1.
    pub heat: f64,
}

impl Event {
    /// Its best report's score, raised for an event many sources carry. (The lead is the most
    /// official report, not always the best scored.)
    pub fn rank(&self) -> f64 {
        let best = std::iter::once(&self.lead)
            .chain(&self.also)
            .filter_map(|pick| pick.score)
            .max()
            .unwrap_or(0) as f64;
        best + (HEAT_POINTS * (self.heat - 1.0)).clamp(0.0, MOST_HEAT)
    }
}

#[derive(Default, Deserialize)]
struct Grouping {
    #[serde(default)]
    groups: Vec<Vec<usize>>,
    #[serde(default)]
    shown: Vec<usize>,
}

/// The day's scored posts as events, highest ranked first. Without an answer from the model
/// (the budget spent, a reply that is not JSON), each post is its own event.
pub(crate) fn group(
    outside: &dyn Outside,
    budget: &mut Budget,
    mut posts: Vec<Pick>,
    told: &[Pick],
    clock: &Clock,
) -> Vec<Event> {
    posts.sort_by_key(|pick| std::cmp::Reverse(pick.score.unwrap_or(0)));
    posts.truncate(MOST);
    let grouping = if posts.len() > 1 || !(posts.is_empty() || told.is_empty()) {
        ask(outside, budget, &posts, told).unwrap_or_default()
    } else {
        Grouping::default()
    };
    // Each post joins the first group that names it; the rest stand alone.
    let mut owner: Vec<Option<usize>> = vec![None; posts.len()];
    for (index, members) in grouping.groups.iter().enumerate() {
        for &member in members {
            if let Some(slot @ None) = owner.get_mut(member) {
                *slot = Some(index);
            }
        }
    }
    let mut events: Vec<Vec<usize>> = Vec::new();
    let mut event_of: HashMap<usize, usize> = HashMap::new();
    for (member, group) in owner.into_iter().enumerate() {
        let event = match group {
            Some(group) => *event_of.entry(group).or_insert_with(|| {
                events.push(Vec::new());
                events.len() - 1
            }),
            None => {
                events.push(Vec::new());
                events.len() - 1
            }
        };
        events[event].push(member);
    }
    let mut slots: Vec<Option<Pick>> = posts.into_iter().map(Some).collect();
    let mut result: Vec<Event> = events
        .into_iter()
        .filter(|members| !members.iter().any(|member| grouping.shown.contains(member)))
        .map(|members| {
            let mut reports: Vec<Pick> = members
                .into_iter()
                .filter_map(|member| slots[member].take())
                .collect();
            // The most official source leads; among equals, the better scored report.
            reports.sort_by_key(|pick| (tier(pick), std::cmp::Reverse(pick.score.unwrap_or(0))));
            let heat = heat(&reports, clock);
            let lead = reports.remove(0);
            Event {
                lead,
                also: reports,
                heat,
            }
        })
        .collect();
    result.sort_by(|a, b| b.rank().total_cmp(&a.rank()));
    result
}

fn ask(
    outside: &dyn Outside,
    budget: &mut Budget,
    posts: &[Pick],
    told: &[Pick],
) -> Option<Grouping> {
    let today: Vec<_> = posts
        .iter()
        .enumerate()
        .map(|(id, pick)| {
            json!({
                "id": id,
                "title": pick.title.as_deref().unwrap_or(&pick.work.title),
                "summary": pick.summary.as_deref().unwrap_or_default(),
            })
        })
        .collect();
    let earlier: Vec<&str> = told
        .iter()
        .take(TOLD)
        .map(|pick| pick.title.as_deref().unwrap_or(&pick.work.title))
        .collect();
    let request = format!(
        "今天的候选动态：\n{}\n\n近一周已经推送过的动态：\n{}",
        serde_json::to_string_pretty(&today).unwrap_or_default(),
        serde_json::to_string_pretty(&earlier).unwrap_or_default(),
    );
    let answer = budget.ask(outside, PROMPT, &request, ANSWER_TOKENS).ok()?;
    json_in(&answer)
}

/// 1 an official source, 2 a researcher or semi-official, 3 media or unknown.
fn tier(pick: &Pick) -> u8 {
    pick.work
        .venue
        .as_deref()
        .and_then(feeds::source)
        .map_or(3, |feed| feed.tier)
}

/// Each source counts once, by its freshest report, halving for each day since it was published.
fn heat(reports: &[Pick], clock: &Clock) -> f64 {
    let today = chrono::NaiveDate::parse_from_str(&clock.day, "%Y-%m-%d").ok();
    let mut freshest: Vec<(String, f64)> = Vec::new();
    for pick in reports {
        let age = pick
            .work
            .published
            .as_deref()
            .and_then(|day| chrono::NaiveDate::parse_from_str(day, "%Y-%m-%d").ok())
            .zip(today)
            .map_or(0, |(published, today)| {
                (today - published).num_days().max(0)
            });
        let weight = 0.5f64.powi(age as i32);
        let source = pick
            .work
            .venue
            .clone()
            .unwrap_or_else(|| pick.work.url.clone());
        match freshest.iter_mut().find(|(name, _)| *name == source) {
            Some((_, best)) => *best = best.max(weight),
            None => freshest.push((source, weight)),
        }
    }
    freshest.iter().map(|(_, weight)| weight).sum()
}

#[cfg(test)]
mod tests {
    use super::super::judge::Budget;
    use super::super::tests::{clock, Fake};
    use super::*;
    use crate::scholar::{Kind, Work};

    fn post(id: &str, source: &str, score: i64, day: &str) -> Pick {
        Pick {
            work: Work {
                id: id.into(),
                title: id.into(),
                venue: Some(source.into()),
                published: Some(day.into()),
                kind: Kind::News,
                ..Work::default()
            },
            score: Some(score),
            title: Some(format!("标题 {id}")),
            summary: None,
            reason: None,
            cites: None,
        }
    }

    fn grouped(answer: &str, posts: Vec<Pick>, told: &[Pick]) -> Vec<Event> {
        let dir = tempfile::tempdir().unwrap();
        let store = super::super::store::Store::open(&dir.path().join("radar.sqlite")).unwrap();
        let outside = Fake::default();
        outside.answers.borrow_mut().push_back(answer.into());
        let mut budget = Budget::today(&store, "p", "2026-11-25").unwrap();
        group(&outside, &mut budget, posts, told, &clock("2026-11-25", 9))
    }

    #[test]
    fn reports_of_one_event_are_led_by_the_official_source_and_rank_higher() {
        let events = grouped(
            r#"{"groups":[[1,2,3]],"shown":[]}"#,
            vec![
                post("verge", "The Verge", 80, "2026-11-25"),
                post("techcrunch", "TechCrunch", 75, "2026-11-25"),
                post("openai", "OpenAI", 70, "2026-11-24"),
                post("alone", "Ars Technica", 82, "2026-11-25"),
            ],
            &[],
        );
        assert_eq!(events.len(), 2);
        let event = &events[0];
        assert_eq!(event.lead.work.id, "openai", "the official report leads");
        assert_eq!(event.also.len(), 2);
        assert!(
            (event.heat - 2.5).abs() < 1e-9,
            "two fresh sources and one a day old"
        );
        assert!(
            event.rank() > events[1].rank(),
            "three sources outrank one better report"
        );
    }

    #[test]
    fn what_a_brief_already_told_is_left_out() {
        let told = [post("old", "OpenAI", 90, "2026-11-23")];
        let events = grouped(
            r#"{"groups":[],"shown":[1]}"#,
            vec![
                post("new", "TechCrunch", 80, "2026-11-25"),
                post("again", "The Verge", 78, "2026-11-25"),
            ],
            &told,
        );
        assert_eq!(events.len(), 1);
        assert_eq!(events[0].lead.work.id, "new");
    }

    #[test]
    fn without_an_answer_each_report_stands_alone() {
        let events = grouped(
            "不是 JSON",
            vec![
                post("a", "TechCrunch", 70, "2026-11-25"),
                post("b", "The Verge", 90, "2026-11-25"),
            ],
            &[],
        );
        let leads: Vec<&str> = events
            .iter()
            .map(|event| event.lead.work.id.as_str())
            .collect();
        assert_eq!(leads, ["b", "a"]);
    }
}
