//! A project's daily brief: its best scored papers that no brief of the past week showed and
//! the user has not dismissed, at most fifteen, made once a day.

use super::judge::THRESHOLD;
use super::store::{Action, Stage, Store};
use super::Clock;

pub(crate) const SIZE: usize = 15;
/// A paper in a brief of the last week is not shown again.
const REPEAT_DAYS: i64 = 7;
/// Briefs are made from this hour on, so a late-night pass does not use up the next day.
const FROM_HOUR: u32 = 6;

/// Makes today's brief when it is due and there is something to put in it. Returns how many
/// papers it holds.
pub(crate) fn make(store: &Store, project: &str, clock: &Clock) -> Result<Option<usize>, String> {
    if clock.hour < FROM_HOUR || store.brief(project, &clock.day)?.is_some() {
        return Ok(None);
    }
    let shown = store.briefed_since(project, &clock.day_offset(-REPEAT_DAYS))?;
    let dismissed = store.with_action(project, Action::Dismissed)?;
    let items: Vec<String> = store
        .picks(project, Stage::Scored)?
        .into_iter()
        .filter(|pick| pick.score.unwrap_or(0) >= THRESHOLD)
        .map(|pick| pick.work.id)
        .filter(|id| !shown.contains(id) && !dismissed.contains(id))
        .take(SIZE)
        .collect();
    if items.is_empty() {
        return Ok(None);
    }
    store.put_brief(project, &clock.day, &items, clock.now)?;
    Ok(Some(items.len()))
}

#[cfg(test)]
mod tests {
    use super::super::tests::{clock, project_store};
    use super::*;

    #[test]
    fn a_brief_takes_the_best_new_papers_once_a_day() {
        let (_dir, store) = project_store(&["a", "b", "c", "d"]);
        for (id, score) in [("a", 90), ("b", 75), ("c", 55), ("d", 70)] {
            store.set_scored("p", id, score, id, "", "").unwrap();
        }
        store.record("p", "d", Action::Dismissed, None, 0).unwrap();
        assert_eq!(
            make(&store, "p", &clock("2026-11-25", 5)).unwrap(),
            None,
            "not before six"
        );
        assert_eq!(make(&store, "p", &clock("2026-11-25", 9)).unwrap(), Some(2));
        assert_eq!(store.brief("p", "2026-11-25").unwrap().unwrap(), ["a", "b"]);
        assert_eq!(
            make(&store, "p", &clock("2026-11-25", 15)).unwrap(),
            None,
            "once a day"
        );
        assert_eq!(
            make(&store, "p", &clock("2026-11-26", 9)).unwrap(),
            None,
            "nothing new to show"
        );
        store.set_scored("p", "c", 80, "c", "", "").unwrap();
        assert_eq!(make(&store, "p", &clock("2026-11-26", 9)).unwrap(), Some(1));
        assert_eq!(store.brief("p", "2026-11-26").unwrap().unwrap(), ["c"]);
    }
}
