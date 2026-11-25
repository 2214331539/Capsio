//! New papers for a project, from arXiv and OpenAlex, found by its profile's topics.

use super::profile::Profile;
use super::store::Store;
use super::{Clock, Outside};
use crate::scholar::Work;

/// A project's sources are asked again after this long.
const REFRESH: i64 = 6 * 3600;
/// How far back a paper may have been published to count as new.
pub(crate) const WINDOW_DAYS: i64 = 7;
/// Topics searched, most central first.
const TOPICS: usize = 5;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum Source {
    Arxiv,
    OpenAlex,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct Query {
    pub source: Source,
    /// arXiv query syntax for arXiv; plain words for OpenAlex.
    pub text: String,
    /// The earliest publication day wanted, `YYYY-MM-DD`.
    pub since: String,
}

/// One arXiv and one OpenAlex query per topic.
pub(crate) fn queries(profile: &Profile, since: &str) -> Vec<Query> {
    let categories = profile
        .categories
        .iter()
        .map(|category| format!("cat:{category}"))
        .collect::<Vec<_>>()
        .join(" OR ");
    let mut topics: Vec<_> = profile.topics.iter().collect();
    topics.sort_by(|a, b| b.weight.total_cmp(&a.weight));
    topics
        .into_iter()
        .take(TOPICS)
        .flat_map(|topic| {
            let words = topic
                .keywords
                .iter()
                .map(|keyword| format!("abs:\"{keyword}\""))
                .collect::<Vec<_>>()
                .join(" OR ");
            let arxiv = if categories.is_empty() {
                format!("({words})")
            } else {
                format!("({categories}) AND ({words})")
            };
            [
                Query {
                    source: Source::Arxiv,
                    text: arxiv,
                    since: since.to_string(),
                },
                Query {
                    source: Source::OpenAlex,
                    text: topic
                        .keywords
                        .iter()
                        .take(3)
                        .cloned()
                        .collect::<Vec<_>>()
                        .join(" "),
                    since: since.to_string(),
                },
            ]
        })
        .collect()
}

/// Asks the sources for a project's new papers when they are due. Returns how many papers
/// were new to this device.
pub(crate) fn refresh(
    store: &Store,
    outside: &dyn Outside,
    project: &str,
    profile: &Profile,
    clock: &Clock,
) -> Result<usize, String> {
    if store
        .fetched(project)?
        .is_some_and(|at| clock.now - at < REFRESH)
    {
        return Ok(0);
    }
    let since = clock.day_offset(-WINDOW_DAYS);
    let mut found: Vec<Work> = Vec::new();
    let mut failure = None;
    let mut answered = false;
    for query in queries(profile, &since) {
        match outside.search(&query) {
            Ok(works) => {
                answered = true;
                found.extend(works.into_iter().filter(|work| recent(work, &since)));
            }
            // One source being down does not stop the others.
            Err(error) => failure = Some(error),
        }
    }
    if !answered {
        return Err(failure.unwrap_or_else(|| "研究方向里没有可检索的主题。".into()));
    }
    store.mark_fetched(project, clock.now)?;
    store.add_works(&found, clock.now)
}

/// Published on or after `since`; a paper without a date cannot be shown to be new.
fn recent(work: &Work, since: &str) -> bool {
    work.published
        .as_deref()
        .is_some_and(|day| day.len() == 10 && day >= since)
}

#[cfg(test)]
mod tests {
    use super::super::profile::Topic;
    use super::*;

    #[test]
    fn each_topic_becomes_an_arxiv_and_an_openalex_query() {
        let profile = Profile {
            topics: vec![
                Topic {
                    name: "次要".into(),
                    keywords: vec!["tool use".into()],
                    weight: 0.3,
                },
                Topic {
                    name: "记忆".into(),
                    keywords: vec!["agent memory".into(), "long-term memory".into()],
                    weight: 1.0,
                },
            ],
            categories: vec!["cs.CL".into(), "cs.AI".into()],
        };
        let queries = queries(&profile, "2026-11-18");
        assert_eq!(queries.len(), 4);
        assert_eq!(
            queries[0].text,
            "(cat:cs.CL OR cat:cs.AI) AND (abs:\"agent memory\" OR abs:\"long-term memory\")"
        );
        assert_eq!(queries[1].source, Source::OpenAlex);
        assert_eq!(queries[1].text, "agent memory long-term memory");
        assert_eq!(
            queries[2].text,
            "(cat:cs.CL OR cat:cs.AI) AND (abs:\"tool use\")"
        );
    }

    #[test]
    fn only_papers_with_a_recent_date_count_as_new() {
        let dated = |day: Option<&str>| Work {
            published: day.map(str::to_string),
            ..Work::default()
        };
        assert!(recent(&dated(Some("2026-11-20")), "2026-11-18"));
        assert!(!recent(&dated(Some("2026-11-01")), "2026-11-18"));
        assert!(!recent(&dated(Some("2026")), "2026-11-18"));
        assert!(!recent(&dated(None), "2026-11-18"));
    }
}
