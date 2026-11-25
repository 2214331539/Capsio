//! New papers that cite a project's library: close to the project whatever their words, so they
//! skip recall and go straight to the model, which is told what they cite; they are also the
//! first reason for an instant alert (`alerts`). Through OpenAlex: each library paper is matched
//! to its OpenAlex work once, by its DOI (or arXiv's DOI for its arXiv id) or else by its title,
//! since most library files carry neither; then the papers of the last week citing any of them
//! are asked for with the project's other sources.

use super::library::{Hint, Seed};
use super::sources::WINDOW_DAYS;
use super::store::Store;
use super::{Clock, Outside};
use crate::scholar::{normalized_title, Work};

/// Library papers matched to OpenAlex per pass, so a large library fills in over a few passes.
const LOOKUPS: usize = 10;
/// A paper OpenAlex did not know is tried again after a month.
const RETRY: i64 = 30 * 86_400;
/// The project's citing papers are asked for again after this long.
const REFRESH: i64 = 6 * 3600;
/// OpenAlex works asked about at once: the newest library papers.
const ASKED: usize = 50;
/// Citing papers that go straight to the model per refresh: a well-known library paper is cited
/// dozens of times a week. Those citing more of the library go first; the rest are left to
/// recall like any new paper.
const STRAIGHT: usize = 15;

/// The OpenAlex work a library paper is: by DOI, or by a title OpenAlex agrees with.
fn lookup(outside: &dyn Outside, seed: &Seed) -> Result<Option<Work>, String> {
    match &seed.doi {
        Some(doi) => outside.by_doi(doi),
        None => outside.identify(&Hint {
            title: seed.title.clone(),
            arxiv: None,
            doi: None,
        }),
    }
}

/// Finds the week's papers citing the project's library and puts them in front of the model.
/// Returns how many were found.
pub(crate) fn refresh(
    store: &Store,
    outside: &dyn Outside,
    project: &str,
    seeds: &[Seed],
    clock: &Clock,
) -> Result<usize, String> {
    let mut newest: Vec<&Seed> = seeds.iter().collect();
    newest.sort_by_key(|seed| std::cmp::Reverse(seed.added));
    // OpenAlex works of the library, with the titles of the papers they are.
    let mut known: Vec<(String, &str)> = Vec::new();
    let mut lookups = 0;
    for seed in newest {
        let key = seed
            .doi
            .clone()
            .unwrap_or_else(|| format!("title:{}", normalized_title(&seed.title)));
        let id = match store.openalex_id(&key)? {
            Some((id, checked)) if id.is_some() || clock.now - checked < RETRY => id,
            _ if lookups < LOOKUPS => {
                lookups += 1;
                match lookup(outside, seed) {
                    Ok(found) => {
                        let id = found.and_then(|work| work.openalex);
                        store.put_openalex_id(&key, id.as_deref(), clock.now)?;
                        id
                    }
                    // Offline: tried again next pass.
                    Err(_) => None,
                }
            }
            _ => None,
        };
        if let Some(id) = id {
            known.push((id, &seed.title));
        }
        if known.len() == ASKED {
            break;
        }
    }
    let due = format!("cites:{project}");
    if known.is_empty()
        || store
            .feed_read(&due)?
            .is_some_and(|at| clock.now - at < REFRESH)
    {
        return Ok(0);
    }
    let ids: Vec<String> = known.iter().map(|(id, _)| id.clone()).collect();
    let mut found = outside.citing(&ids, &clock.day_offset(-WINDOW_DAYS))?;
    store.mark_feed_read(&due, clock.now)?;
    // OpenAlex has works dated in the future; they are not new yet.
    found.retain(|(work, _)| work.published.as_deref() <= Some(clock.day.as_str()));
    let works: Vec<_> = found.iter().map(|(work, _)| work.clone()).collect();
    store.add_works(&works, clock.now)?;
    found.sort_by_key(|(work, cited)| {
        (
            std::cmp::Reverse(cited.len()),
            std::cmp::Reverse(work.published.clone()),
        )
    });
    for (work, cited) in found.iter().take(STRAIGHT) {
        let titles: Vec<&str> = known
            .iter()
            .filter(|(id, _)| cited.contains(id))
            .map(|(_, title)| *title)
            .collect();
        if !titles.is_empty() {
            store.add_citation(project, &work.id, &titles.join("》《"), clock.now)?;
        }
    }
    Ok(found.len())
}

#[cfg(test)]
mod tests {
    use super::super::store::Stage;
    use super::super::tests::{clock, Fake};
    use super::*;
    use crate::scholar::Work;

    fn seed(title: &str, doi: Option<&str>) -> Seed {
        Seed {
            fingerprint: title.into(),
            title: title.into(),
            summary: String::new(),
            added: 0,
            doi: doi.map(str::to_string),
        }
    }

    #[test]
    fn papers_citing_the_library_go_straight_to_the_model() {
        let dir = tempfile::tempdir().unwrap();
        let store = Store::open(&dir.path().join("radar.sqlite")).unwrap();
        let outside = Fake::default();
        outside
            .openalex
            .borrow_mut()
            .insert("10.48550/arxiv.2502.12110".into(), "W1".into());
        let citing = Work {
            id: "arxiv:2611.00042".into(),
            title: "Memory that forgets on purpose".into(),
            ..Work::default()
        };
        // A library paper without a DOI is found by its title.
        outside.found.borrow_mut().insert(
            "LongMemEval".into(),
            Work {
                openalex: Some("W2".into()),
                ..Work::default()
            },
        );
        outside
            .citing
            .borrow_mut()
            .push((citing.clone(), vec!["W1".into(), "W2".into()]));
        let seeds = [
            seed("A-MEM", Some("10.48550/arxiv.2502.12110")),
            seed("Unknown to OpenAlex", Some("10.1/none")),
            seed("LongMemEval", None),
        ];
        let today = clock("2026-11-25", 9);
        // The paper was compared by text earlier and set aside.
        store
            .add_works(std::slice::from_ref(&citing), today.now)
            .unwrap();
        store
            .add_pick("p", &citing.id, 0.0, Stage::Dropped, today.now)
            .unwrap();
        assert_eq!(refresh(&store, &outside, "p", &seeds, &today), Ok(1));
        let recalled = store.picks("p", Stage::Recalled).unwrap();
        assert_eq!(recalled.len(), 1, "citing the library brings it back");
        assert_eq!(recalled[0].cites.as_deref(), Some("A-MEM》《LongMemEval"));
        assert_eq!(
            outside.citing_asked.borrow().as_slice(),
            [vec!["W1".to_string(), "W2".to_string()]]
        );
        // Within six hours nothing is asked again, and the unknown DOI waits a month.
        assert_eq!(refresh(&store, &outside, "p", &seeds, &today), Ok(0));
        assert_eq!(outside.citing_asked.borrow().len(), 1);
        assert_eq!(
            store.openalex_id("10.1/none").unwrap().map(|(id, _)| id),
            Some(None)
        );
    }
}
