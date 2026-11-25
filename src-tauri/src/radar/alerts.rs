//! Instant alerts: a few recommendations a day are worth telling at once rather than in the next
//! brief: a new paper citing the project's library, one by an author the user follows, one that
//! scores very high. At most two a day across projects, each once; an alerted work joins the
//! day's brief when there is one, so the page shows it.

use super::judge::threshold;
use super::store::{Action, Entry, Pick, Stage, Store};
use super::Clock;
use serde::Serialize;

/// Alerts a day, across projects.
const PER_DAY: usize = 2;
/// A score this high is news in itself.
const OUTSTANDING: i64 = 90;
/// Works in briefs this recent are not told again.
const RECENT_DAYS: i64 = 7;

#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct Alert {
    pub work_id: String,
    pub title: String,
    pub why: String,
}

/// Why a scored work deserves an alert, strongest first.
enum Reason {
    Cites(String),
    Follows(String),
    Outstanding,
}

impl Reason {
    fn of(pick: &Pick, followed: &[String]) -> Option<Self> {
        if let Some(cites) = &pick.cites {
            return Some(Reason::Cites(cites.clone()));
        }
        if let Some(author) = pick
            .work
            .authors
            .iter()
            .find(|author| followed.contains(author))
        {
            return Some(Reason::Follows(author.clone()));
        }
        (pick.score.unwrap_or(0) >= OUTSTANDING).then_some(Reason::Outstanding)
    }

    fn rank(&self) -> u8 {
        match self {
            Reason::Cites(_) => 0,
            Reason::Follows(_) => 1,
            Reason::Outstanding => 2,
        }
    }

    fn told(&self) -> String {
        match self {
            Reason::Cites(cites) => format!("引用了你文献库里的《{cites}》"),
            Reason::Follows(author) => format!("你关注的 {author} 的新作"),
            Reason::Outstanding => "今天最值得读的一篇".into(),
        }
    }
}

/// Raises the project's alerts due now, within what is left of the day's.
pub(crate) fn raise(
    store: &Store,
    project: &str,
    followed: &[String],
    clock: &Clock,
) -> Result<Vec<Alert>, String> {
    let left = PER_DAY.saturating_sub(store.alerts_on(&clock.day)?);
    if left == 0 {
        return Ok(Vec::new());
    }
    let told: Vec<String> = [
        store.briefed_since(project, &clock.day_offset(-RECENT_DAYS))?,
        store.alerted(project)?,
        store.with_action(project, Action::Dismissed)?,
    ]
    .concat();
    let mut due: Vec<(Pick, Reason)> = store
        .picks(project, Stage::Scored)?
        .into_iter()
        .filter(|pick| pick.score.unwrap_or(0) >= threshold(pick.work.kind))
        .filter(|pick| !told.contains(&pick.work.id))
        .filter_map(|pick| Reason::of(&pick, followed).map(|reason| (pick, reason)))
        .collect();
    // Citations first, then followed authors, then the outstanding; best scored within each.
    due.sort_by_key(|(pick, reason)| (reason.rank(), std::cmp::Reverse(pick.score.unwrap_or(0))));
    let mut brief = store.brief(project, &clock.day)?;
    let mut alerts = Vec::new();
    for (pick, reason) in due.into_iter().take(left) {
        store.put_alert(project, &pick.work.id, &clock.day)?;
        if let Some(entries) = brief.as_mut() {
            entries.push(Entry::from(pick.work.id.as_str()));
        }
        alerts.push(Alert {
            title: pick.title.unwrap_or(pick.work.title),
            work_id: pick.work.id,
            why: reason.told(),
        });
    }
    if let (Some(entries), false) = (brief, alerts.is_empty()) {
        store.put_brief(project, &clock.day, &entries, clock.now)?;
    }
    Ok(alerts)
}

#[cfg(test)]
mod tests {
    use super::super::tests::{clock, project_store};
    use super::*;
    use crate::scholar::Work;

    #[test]
    fn citing_papers_followed_authors_and_outstanding_scores_are_told_twice_a_day_at_most() {
        let (_dir, store) = project_store(&["plain", "outstanding"]);
        let today = clock("2026-11-25", 9);
        let cited = Work {
            id: "cited".into(),
            title: "Cites the library".into(),
            ..Work::default()
        };
        let followed = Work {
            id: "followed".into(),
            title: "By a followed author".into(),
            authors: vec!["Lilian Weng".into()],
            ..Work::default()
        };
        store.add_works(&[cited, followed], 0).unwrap();
        store.add_citation("p", "cited", "A-MEM", 0).unwrap();
        store
            .add_pick("p", "followed", 0.5, Stage::Recalled, 0)
            .unwrap();
        for (id, score) in [
            ("plain", 70),
            ("outstanding", 95),
            ("cited", 66),
            ("followed", 75),
        ] {
            store
                .set_scored("p", id, score, &format!("标题 {id}"), "", "")
                .unwrap();
        }
        store
            .put_brief("p", "2026-11-25", &[Entry::from("plain")], 0)
            .unwrap();

        let alerts = raise(&store, "p", &["Lilian Weng".to_string()], &today).unwrap();
        let ids: Vec<&str> = alerts.iter().map(|alert| alert.work_id.as_str()).collect();
        assert_eq!(ids, ["cited", "followed"], "two a day, citations first");
        assert_eq!(alerts[0].why, "引用了你文献库里的《A-MEM》");
        assert_eq!(alerts[1].why, "你关注的 Lilian Weng 的新作");
        let brief: Vec<String> = store
            .brief("p", "2026-11-25")
            .unwrap()
            .unwrap()
            .into_iter()
            .map(|entry| entry.id)
            .collect();
        assert_eq!(brief, ["plain", "cited", "followed"], "the page shows them");
        assert!(
            raise(&store, "p", &[], &today).unwrap().is_empty(),
            "the day's two are used"
        );
        // The next day the outstanding one is told, and nothing twice.
        let next = raise(&store, "p", &[], &clock("2026-11-26", 9)).unwrap();
        assert_eq!(next.len(), 1);
        assert_eq!(next[0].work_id, "outstanding");
        assert_eq!(next[0].why, "今天最值得读的一篇");
    }
}
