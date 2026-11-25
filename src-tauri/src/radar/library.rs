//! A project's library as evidence of what it studies: each PDF becomes a seed with a title
//! and, when one can be found, an abstract. Both come from the paper's record when it has
//! one; otherwise the title comes from the file name and the abstract from arXiv or OpenAlex,
//! looked up once per file and kept.

use super::store::{SeedRow, Store};
use super::Outside;
use serde_json::Value;

/// A lookup that found nothing is tried again after a month.
const RETRY: i64 = 30 * 86_400;
/// At most this many lookups per pass, so a large library fills in over a few passes.
const LOOKUPS: usize = 12;

/// A PDF in the library, as the library reports it.
pub(crate) struct Paper {
    pub fingerprint: String,
    /// Relative to the library folder.
    pub path: String,
    /// When the file last changed, in seconds since 1970.
    pub modified: i64,
    /// The record's `reference`, when there is one.
    pub reference: Option<Value>,
}

impl From<capsio_core::library::LibraryPaper> for Paper {
    fn from(paper: capsio_core::library::LibraryPaper) -> Self {
        Self {
            fingerprint: paper.fingerprint,
            path: paper.path,
            modified: paper
                .modified
                .duration_since(std::time::UNIX_EPOCH)
                .map_or(0, |since| since.as_secs() as i64),
            reference: paper.reference,
        }
    }
}

/// What a source is asked to find a library file by.
#[derive(Debug, Default, PartialEq)]
pub(crate) struct Hint {
    pub title: String,
    pub arxiv: Option<String>,
    pub doi: Option<String>,
}

/// A library paper as evidence of the project's interests.
#[derive(Clone, Debug, PartialEq)]
pub(crate) struct Seed {
    pub fingerprint: String,
    pub title: String,
    pub summary: String,
    /// When it was added (its file last changed), in seconds since 1970.
    pub added: i64,
}

pub(crate) fn seeds(
    store: &Store,
    outside: &dyn Outside,
    papers: &[Paper],
    now: i64,
) -> Result<Vec<Seed>, String> {
    let mut lookups = 0;
    let mut seeds = Vec::new();
    for paper in papers {
        let reference = paper.reference.as_ref();
        let field = |name: &str| {
            reference
                .and_then(|reference| reference[name].as_str())
                .map(str::trim)
                .filter(|text| !text.is_empty())
                .map(str::to_string)
        };
        let (title, summary) = match (field("title"), field("abstract")) {
            (Some(title), Some(summary)) => (title, summary),
            (title, _) => {
                let hint = Hint {
                    title: title.unwrap_or_else(|| title_from_path(&paper.path)),
                    arxiv: crate::scholar::arxiv_id(stem(&paper.path)),
                    doi: field("doi"),
                };
                match store.seed(&paper.fingerprint)? {
                    Some(row) if !row.summary.is_empty() || now - row.checked < RETRY => {
                        (row.title, row.summary)
                    }
                    _ if lookups < LOOKUPS => {
                        lookups += 1;
                        match outside.identify(&hint) {
                            Ok(found) => {
                                let row = SeedRow {
                                    fingerprint: paper.fingerprint.clone(),
                                    title: found
                                        .as_ref()
                                        .map_or(hint.title.clone(), |work| work.title.clone()),
                                    summary: found.map(|work| work.summary).unwrap_or_default(),
                                    checked: now,
                                };
                                store.put_seed(&row)?;
                                (row.title, row.summary)
                            }
                            // Offline or refused: the file name serves this pass; it is looked up again next pass.
                            Err(_) => (hint.title, String::new()),
                        }
                    }
                    _ => (hint.title, String::new()),
                }
            }
        };
        if !title.is_empty() {
            seeds.push(Seed {
                fingerprint: paper.fingerprint.clone(),
                title,
                summary,
                added: paper.modified,
            });
        }
    }
    Ok(seeds)
}

fn stem(path: &str) -> &str {
    let name = path.rsplit('/').next().unwrap_or(path);
    name.rsplit_once('.').map_or(name, |(stem, _)| stem)
}

/// What a file name says the paper is called: `A-MEM_Agentic Memory (1).pdf` → `A-MEM Agentic
/// Memory`. A name that is only an arXiv id says nothing until it is looked up.
fn title_from_path(path: &str) -> String {
    let stem = stem(path);
    if crate::scholar::arxiv_id(stem).is_some() {
        return String::new();
    }
    let stem = match stem.rsplit_once(" (") {
        Some((base, copy))
            if copy
                .trim_end_matches(')')
                .chars()
                .all(|c| c.is_ascii_digit()) =>
        {
            base
        }
        _ => stem,
    };
    stem.replace('_', " ")
        .split_whitespace()
        .collect::<Vec<_>>()
        .join(" ")
}

#[cfg(test)]
mod tests {
    use super::super::tests::Fake;
    use super::*;
    use serde_json::json;

    fn paper(fingerprint: &str, path: &str, reference: Option<Value>) -> Paper {
        Paper {
            fingerprint: fingerprint.into(),
            path: path.into(),
            modified: 50,
            reference,
        }
    }

    #[test]
    fn file_names_say_what_a_paper_is_called() {
        assert_eq!(
            title_from_path("A-MEM_Agentic Memory (1).pdf"),
            "A-MEM Agentic Memory"
        );
        assert_eq!(title_from_path("nested/Graph  RAG.pdf"), "Graph RAG");
        assert_eq!(title_from_path("2410.12361v3.pdf"), "");
        assert_eq!(title_from_path("Results (final).pdf"), "Results (final)");
    }

    #[test]
    fn records_are_trusted_and_other_files_are_looked_up_once() {
        let dir = tempfile::tempdir().unwrap();
        let store = Store::open(&dir.path().join("radar.sqlite")).unwrap();
        let outside = Fake::default();
        outside.found.borrow_mut().insert(
            "Graph RAG".into(),
            crate::scholar::Work {
                title: "Graph RAG: Retrieval".into(),
                summary: "About graphs.".into(),
                ..Default::default()
            },
        );
        let papers = [
            paper(
                "a",
                "Recorded.pdf",
                Some(json!({"title":"From the record","abstract":"Known."})),
            ),
            paper("b", "Graph RAG.pdf", None),
            paper("c", "Unknown paper.pdf", None),
            paper("d", "2410.12361.pdf", None),
        ];
        let found = seeds(&store, &outside, &papers, 1_000).unwrap();
        let titles: Vec<_> = found.iter().map(|seed| seed.title.as_str()).collect();
        assert_eq!(
            titles,
            ["From the record", "Graph RAG: Retrieval", "Unknown paper"]
        );
        assert_eq!(found[1].summary, "About graphs.");
        assert_eq!(outside.lookups.borrow().len(), 3, "records need no lookup");
        assert_eq!(
            outside.lookups.borrow()[2].arxiv.as_deref(),
            Some("2410.12361")
        );
        seeds(&store, &outside, &papers, 2_000).unwrap();
        assert_eq!(
            outside.lookups.borrow().len(),
            3,
            "found or not, a file is looked up once"
        );
        seeds(&store, &outside, &papers, 2_000 + RETRY).unwrap();
        assert_eq!(
            outside.lookups.borrow().len(),
            5,
            "what was not found is tried again a month later"
        );
    }
}
