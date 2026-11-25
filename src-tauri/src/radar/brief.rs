//! A project's daily brief, made once a day: the day's news and blog posts as events (`events`),
//! at most five and at most two from any one source, and its best new papers in the rest of the
//! fifteen places, all ordered by rank. Updates have their places so that a day of strong papers
//! does not crowd them out. Nothing a brief of the past week showed, and nothing the user
//! dismissed, comes back.

use super::events;
use super::judge::{threshold, Budget};
use super::store::{Action, Entry, Pick, Stage, Store};
use super::{Clock, Outside};
use crate::scholar::Kind;
use std::collections::HashMap;

pub(crate) const SIZE: usize = 15;
/// News and blog events in one brief, so papers stay at its core.
const POSTS: usize = 5;
/// Events in one brief led by the same source.
const PER_SOURCE: usize = 2;
/// A work in a brief of the last week is not shown again.
const REPEAT_DAYS: i64 = 7;
/// Briefs are made from this hour on, so a late-night pass does not use up the next day.
pub(crate) const FROM_HOUR: u32 = 6;

/// Makes today's brief when it is due and there is something to put in it. Returns how many
/// entries it holds.
pub(crate) fn make(
    store: &Store,
    outside: &dyn Outside,
    budget: &mut Budget,
    project: &str,
    clock: &Clock,
) -> Result<Option<usize>, String> {
    if clock.hour < FROM_HOUR || store.brief(project, &clock.day)?.is_some() {
        return Ok(None);
    }
    let shown = store.briefed_since(project, &clock.day_offset(-REPEAT_DAYS))?;
    let dismissed = store.with_action(project, Action::Dismissed)?;
    let (papers, posts): (Vec<Pick>, Vec<Pick>) = store
        .picks(project, Stage::Scored)?
        .into_iter()
        .filter(|pick| pick.score.unwrap_or(0) >= threshold(pick.work.kind))
        .filter(|pick| !shown.contains(&pick.work.id) && !dismissed.contains(&pick.work.id))
        .partition(|pick| pick.work.kind == Kind::Paper);
    let mut ranked: Vec<(f64, Entry)> = Vec::new();
    if !posts.is_empty() {
        let mut told = Vec::new();
        for id in shown.iter().rev() {
            told.extend(
                store
                    .pick(project, id)?
                    .filter(|pick| pick.work.kind != Kind::Paper),
            );
        }
        let mut per_source: HashMap<String, usize> = HashMap::new();
        let events = events::group(outside, budget, posts, &told, clock)
            .into_iter()
            .filter(|event| {
                let source = event.lead.work.venue.clone().unwrap_or_default();
                let count = per_source.entry(source).or_default();
                *count += 1;
                *count <= PER_SOURCE
            })
            .take(POSTS);
        ranked.extend(events.map(|event| {
            let entry = Entry {
                id: event.lead.work.id.clone(),
                also: event.also.iter().map(|pick| pick.work.id.clone()).collect(),
            };
            (event.rank(), entry)
        }));
    }
    // Papers come best first; they fill the places the updates left.
    let room = SIZE - ranked.len();
    ranked.extend(papers.iter().take(room).map(|pick| {
        (
            pick.score.unwrap_or(0) as f64,
            Entry::from(pick.work.id.as_str()),
        )
    }));
    ranked.sort_by(|a, b| b.0.total_cmp(&a.0));
    let items: Vec<Entry> = ranked
        .into_iter()
        .take(SIZE)
        .map(|(_, entry)| entry)
        .collect();
    if items.is_empty() {
        return Ok(None);
    }
    store.put_brief(project, &clock.day, &items, clock.now)?;
    Ok(Some(items.len()))
}

#[cfg(test)]
mod tests {
    use super::super::tests::{clock, project_store, Fake};
    use super::*;
    use crate::scholar::Work;

    fn made(store: &Store, outside: &Fake, day: &str, hour: u32) -> Option<usize> {
        let mut budget = Budget::today(store, "p", day).unwrap();
        make(store, outside, &mut budget, "p", &clock(day, hour)).unwrap()
    }

    fn ids(entries: Vec<Entry>) -> Vec<String> {
        entries.into_iter().map(|entry| entry.id).collect()
    }

    #[test]
    fn an_update_keeps_its_place_on_a_day_of_strong_papers() {
        let papers: Vec<String> = (0..20).map(|n| format!("paper{n}")).collect();
        let names: Vec<&str> = papers.iter().map(String::as_str).collect();
        let (_dir, store) = project_store(&names);
        for id in &names {
            store.set_scored("p", id, 90, id, "", "").unwrap();
        }
        let update = Work {
            id: "update".into(),
            kind: Kind::Blog,
            ..Work::default()
        };
        store.add_works(&[update], 0).unwrap();
        store
            .add_pick("p", "update", 0.1, Stage::Recalled, 0)
            .unwrap();
        store.set_scored("p", "update", 66, "u", "", "").unwrap();
        assert_eq!(made(&store, &Fake::default(), "2026-11-25", 9), Some(SIZE));
        let brief = ids(store.brief("p", "2026-11-25").unwrap().unwrap());
        assert_eq!(brief.last().map(String::as_str), Some("update"));
    }

    #[test]
    fn a_brief_takes_the_best_new_papers_once_a_day() {
        let (_dir, store) = project_store(&["a", "b", "c", "d"]);
        let outside = Fake::default();
        for (id, score) in [("a", 90), ("b", 75), ("c", 55), ("d", 70)] {
            store.set_scored("p", id, score, id, "", "").unwrap();
        }
        store.record("p", "d", Action::Dismissed, None, 0).unwrap();
        assert_eq!(
            made(&store, &outside, "2026-11-25", 5),
            None,
            "not before six"
        );
        assert_eq!(made(&store, &outside, "2026-11-25", 9), Some(2));
        assert_eq!(
            ids(store.brief("p", "2026-11-25").unwrap().unwrap()),
            ["a", "b"]
        );
        assert_eq!(made(&store, &outside, "2026-11-25", 15), None, "once a day");
        assert_eq!(
            made(&store, &outside, "2026-11-26", 9),
            None,
            "nothing new to show"
        );
        store.set_scored("p", "c", 80, "c", "", "").unwrap();
        assert_eq!(made(&store, &outside, "2026-11-26", 9), Some(1));
        assert_eq!(ids(store.brief("p", "2026-11-26").unwrap().unwrap()), ["c"]);
    }

    #[test]
    fn posts_join_as_events_two_per_source_and_at_most_five() {
        let ids_in: Vec<String> = (0..8).map(|n| format!("post{n}")).collect();
        let names: Vec<&str> = ids_in.iter().map(String::as_str).collect();
        let (_dir, store) = project_store(&["paper"]);
        let posts: Vec<Work> = names
            .iter()
            .enumerate()
            .map(|(n, id)| Work {
                id: id.to_string(),
                title: id.to_string(),
                kind: Kind::News,
                // Posts 0–3 come from one source.
                venue: Some(if n < 4 {
                    "TechCrunch".into()
                } else {
                    format!("Site {n}")
                }),
                published: Some("2026-11-25".into()),
                ..Work::default()
            })
            .collect();
        store.add_works(&posts, 0).unwrap();
        store.set_scored("p", "paper", 70, "paper", "", "").unwrap();
        for (n, id) in names.iter().enumerate() {
            store.add_pick("p", id, 0.5, Stage::Recalled, 0).unwrap();
            store
                .set_scored("p", id, 90 - n as i64, id, "", "")
                .unwrap();
        }
        let outside = Fake::default();
        // The model groups posts 4 and 5 as one event.
        outside
            .answers
            .borrow_mut()
            .push_back(r#"{"groups":[[4,5]],"shown":[]}"#.into());
        assert_eq!(made(&store, &outside, "2026-11-25", 9), Some(6));
        let brief = store.brief("p", "2026-11-25").unwrap().unwrap();
        let leads: Vec<&str> = brief.iter().map(|entry| entry.id.as_str()).collect();
        // post4 (86) rises to 90 with a second source; posts 2 and 3 are a third and fourth
        // from TechCrunch.
        assert_eq!(
            leads,
            ["post0", "post4", "post1", "post6", "post7", "paper"]
        );
        let event = brief.iter().find(|entry| entry.id == "post4").unwrap();
        assert_eq!(event.also, ["post5"]);
        // Every report of the event counts as shown.
        assert!(store
            .briefed_since("p", "2026-11-20")
            .unwrap()
            .contains(&"post5".to_string()));
    }
}
