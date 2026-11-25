//! Scholarly sources over plain HTTP, with no key and nothing charged: arXiv and OpenAlex.
//! The AI's paper search and the recommendations read papers through here. Everything
//! returned is untrusted material, like the pages the embedded browser reads.

use scraper::{ElementRef, Html, Selector};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::time::Duration;

const ARXIV: &str = "https://export.arxiv.org/api/query";
const OPENALEX: &str = "https://api.openalex.org/works";
const AGENT: &str = "Capsio/1.0 (desktop research app; https://github.com/2214331539/Capsio)";
/// Longer abstracts are cut; they only need to say what a paper is about.
const SUMMARY_CHARS: usize = 3000;

/// A paper as a source describes it. The recommendations also keep posts from news sites
/// and blogs in this shape, with `kind` saying which.
#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Work {
    /// `arxiv:<id>`, `doi:<doi>` or `openalex:<id>`: the same paper gets the same id from
    /// both sources whenever it has an arXiv id or a DOI.
    pub id: String,
    pub title: String,
    pub authors: Vec<String>,
    #[serde(rename = "abstract")]
    pub summary: String,
    /// `YYYY-MM-DD` when known.
    pub published: Option<String>,
    pub venue: Option<String>,
    /// Lower case, without the `https://doi.org/` prefix.
    pub doi: Option<String>,
    /// Without the version suffix.
    pub arxiv: Option<String>,
    pub url: String,
    pub pdf_url: Option<String>,
    /// arXiv categories, or OpenAlex topics.
    pub categories: Vec<String>,
    pub citations: Option<u64>,
    #[serde(default)]
    pub kind: Kind,
}

/// What a work is. Everything from arXiv and OpenAlex is a paper.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Kind {
    #[default]
    Paper,
    News,
    Blog,
}

impl Kind {
    pub fn name(self) -> &'static str {
        match self {
            Kind::Paper => "paper",
            Kind::News => "news",
            Kind::Blog => "blog",
        }
    }
}

impl Work {
    fn identify(mut self, openalex: Option<&str>) -> Self {
        self.id = match (&self.arxiv, &self.doi, openalex) {
            (Some(arxiv), _, _) => format!("arxiv:{arxiv}"),
            (None, Some(doi), _) => format!("doi:{doi}"),
            (None, None, Some(openalex)) => format!("openalex:{openalex}"),
            (None, None, None) => format!("url:{}", self.url),
        };
        self
    }
}

fn client() -> Result<reqwest::Client, String> {
    reqwest::Client::builder()
        .user_agent(AGENT)
        .connect_timeout(Duration::from_secs(10))
        .timeout(Duration::from_secs(30))
        .build()
        .map_err(|e| e.to_string())
}

async fn fetch(url: &reqwest::Url) -> Result<String, String> {
    let response = client()?
        .get(url.clone())
        .send()
        .await
        .map_err(|e| format!("网络请求失败：{e}"))?;
    let status = response.status();
    if !status.is_success() {
        return Err(format!(
            "{} 返回 HTTP {}。",
            url.host_str().unwrap_or("服务"),
            status.as_u16()
        ));
    }
    response.text().await.map_err(|e| e.to_string())
}

fn url(base: &str, query: &[(&str, &str)]) -> reqwest::Url {
    let mut url = reqwest::Url::parse(base).expect("static base url");
    url.query_pairs_mut().extend_pairs(query);
    url
}

// ---------- arXiv ----------

/// arXiv's own query syntax, e.g. `all:agent memory` or `cat:cs.CL AND abs:retrieval`, best
/// matches first.
pub async fn arxiv_search(query: &str, limit: usize) -> Result<Vec<Work>, String> {
    arxiv_list(query, "relevance", limit).await
}

/// The same, newest submissions first.
pub async fn arxiv_newest(query: &str, limit: usize) -> Result<Vec<Work>, String> {
    arxiv_list(query, "submittedDate", limit).await
}

async fn arxiv_list(query: &str, order: &str, limit: usize) -> Result<Vec<Work>, String> {
    let limit = limit.clamp(1, 200).to_string();
    let body = fetch(&url(
        ARXIV,
        &[
            ("search_query", query),
            ("sortBy", order),
            ("sortOrder", "descending"),
            ("max_results", &limit),
        ],
    ))
    .await?;
    Ok(arxiv_feed(&body))
}

/// The papers with these arXiv ids (versions allowed).
pub async fn arxiv_ids(ids: &[&str]) -> Result<Vec<Work>, String> {
    let body = fetch(&url(ARXIV, &[("id_list", &ids.join(","))])).await?;
    Ok(arxiv_feed(&body))
}

fn selector(css: &str) -> Selector {
    Selector::parse(css).expect("static selector")
}

fn text_of(element: ElementRef) -> String {
    element
        .text()
        .collect::<String>()
        .split_whitespace()
        .collect::<Vec<_>>()
        .join(" ")
}

fn clip(text: &str, limit: usize) -> String {
    text.chars().take(limit).collect()
}

/// `2410.12361v3` → `2410.12361`; old-style ids such as `cs/0112017v1` keep their slash.
pub fn arxiv_id(text: &str) -> Option<String> {
    let id = text
        .trim()
        .trim_start_matches("arXiv:")
        .trim_start_matches("arxiv:")
        .rsplit("/abs/")
        .next()?
        .rsplit("/pdf/")
        .next()?
        .trim_end_matches(".pdf");
    let id = match id.rfind('v') {
        Some(at)
            if at > 0 && id[at + 1..].chars().all(|c| c.is_ascii_digit()) && at + 1 < id.len() =>
        {
            &id[..at]
        }
        _ => id,
    };
    let new_style = id.len() >= 9
        && id.split_once('.').is_some_and(|(month, number)| {
            month.len() == 4
                && month.chars().all(|c| c.is_ascii_digit())
                && (4..=5).contains(&number.len())
                && number.chars().all(|c| c.is_ascii_digit())
        });
    let old_style = id.split_once('/').is_some_and(|(archive, number)| {
        !archive.is_empty() && number.len() == 7 && number.chars().all(|c| c.is_ascii_digit())
    });
    (new_style || old_style).then(|| id.to_string())
}

pub fn arxiv_feed(feed: &str) -> Vec<Work> {
    let document = Html::parse_document(feed);
    let (entry, title, summary, id, published, author, pdf, category) = (
        selector("entry"),
        selector("title"),
        selector("summary"),
        selector("id"),
        selector("published"),
        selector("author name"),
        selector("link[title=pdf]"),
        selector("category"),
    );
    document
        .select(&entry)
        .filter_map(|item| {
            let field = |s: &Selector| item.select(s).next().map(text_of).unwrap_or_default();
            let link = field(&id);
            let arxiv = arxiv_id(&link)?;
            let work = Work {
                title: field(&title),
                authors: item.select(&author).map(text_of).collect(),
                summary: clip(&field(&summary), SUMMARY_CHARS),
                published: field(&published).get(..10).map(str::to_string),
                venue: Some("arXiv".into()),
                pdf_url: item
                    .select(&pdf)
                    .next()
                    .and_then(|link| link.value().attr("href"))
                    .map(str::to_string),
                categories: item
                    .select(&category)
                    .filter_map(|c| c.value().attr("term"))
                    .map(str::to_string)
                    .collect(),
                url: format!("https://arxiv.org/abs/{arxiv}"),
                arxiv: Some(arxiv),
                ..Work::default()
            };
            (!work.title.is_empty()).then(|| work.identify(None))
        })
        .collect()
}

// ---------- OpenAlex ----------

/// Full-text search, optionally only works published on or after `since` (`YYYY-MM-DD`).
pub async fn openalex_search(
    query: &str,
    since: Option<&str>,
    limit: usize,
) -> Result<Vec<Work>, String> {
    let limit = limit.clamp(1, 50).to_string();
    let filter = since.map(|day| format!("from_publication_date:{day}"));
    let mut pairs = vec![("search", query), ("per-page", limit.as_str())];
    if let Some(filter) = &filter {
        pairs.push(("filter", filter));
        pairs.push(("sort", "publication_date:desc"));
    }
    openalex_list(&url(OPENALEX, &pairs)).await
}

/// The work with this DOI, if OpenAlex knows it.
pub async fn openalex_doi(doi: &str) -> Result<Option<Work>, String> {
    let body = match fetch(
        &reqwest::Url::parse(&format!("{OPENALEX}/https://doi.org/{doi}"))
            .map_err(|e| e.to_string())?,
    )
    .await
    {
        Ok(body) => body,
        Err(error) if error.contains("HTTP 404") => return Ok(None),
        Err(error) => return Err(error),
    };
    let value: Value = serde_json::from_str(&body).map_err(|_| "OpenAlex 返回的内容无法解析。")?;
    Ok(Some(openalex_work(&value)))
}

/// The work best matching a title, when one matches closely enough to be the same paper.
pub async fn openalex_title(title: &str) -> Result<Option<Work>, String> {
    let wanted = normalized_title(title);
    if wanted.split(' ').count() < 3 {
        return Ok(None);
    }
    let filter = format!("title.search:{}", title.replace([',', '|', ':'], " "));
    let works = openalex_list(&url(OPENALEX, &[("filter", &filter), ("per-page", "5")])).await?;
    Ok(works
        .into_iter()
        .find(|work| same_title(&normalized_title(&work.title), &wanted)))
}

async fn openalex_list(url: &reqwest::Url) -> Result<Vec<Work>, String> {
    let body = fetch(url).await?;
    let value: Value = serde_json::from_str(&body).map_err(|_| "OpenAlex 返回的内容无法解析。")?;
    Ok(value["results"]
        .as_array()
        .into_iter()
        .flatten()
        .map(openalex_work)
        .filter(|work| !work.title.is_empty())
        .collect())
}

pub fn openalex_work(work: &Value) -> Work {
    let locations = || {
        work["locations"]
            .as_array()
            .into_iter()
            .flatten()
            .chain([&work["primary_location"], &work["best_oa_location"]])
    };
    let arxiv = locations()
        .filter_map(|location| location["landing_page_url"].as_str())
        .find(|url| url.contains("arxiv.org/abs/"))
        .and_then(arxiv_id);
    let doi = work["doi"]
        .as_str()
        .map(|doi| doi.trim_start_matches("https://doi.org/").to_lowercase())
        .filter(|doi| doi.starts_with("10."));
    let openalex = work["id"]
        .as_str()
        .map(|id| id.trim_start_matches("https://openalex.org/").to_string());
    Work {
        title: work["display_name"]
            .as_str()
            .unwrap_or_default()
            .split_whitespace()
            .collect::<Vec<_>>()
            .join(" "),
        authors: work["authorships"]
            .as_array()
            .into_iter()
            .flatten()
            .filter_map(|a| a["author"]["display_name"].as_str().map(str::to_string))
            .collect(),
        summary: clip(
            &inverted_abstract(&work["abstract_inverted_index"]),
            SUMMARY_CHARS,
        ),
        published: work["publication_date"]
            .as_str()
            .map(str::to_string)
            .or_else(|| {
                work["publication_year"]
                    .as_u64()
                    .map(|year| year.to_string())
            }),
        venue: work["primary_location"]["source"]["display_name"]
            .as_str()
            .map(str::to_string),
        url: work["primary_location"]["landing_page_url"]
            .as_str()
            .or(work["doi"].as_str())
            .or(work["id"].as_str())
            .unwrap_or_default()
            .to_string(),
        pdf_url: work["best_oa_location"]["pdf_url"]
            .as_str()
            .or(work["open_access"]["oa_url"]
                .as_str()
                .filter(|url| url.ends_with(".pdf")))
            .map(str::to_string),
        categories: work["topics"]
            .as_array()
            .into_iter()
            .flatten()
            .filter_map(|topic| topic["display_name"].as_str().map(str::to_string))
            .collect(),
        citations: work["cited_by_count"].as_u64(),
        doi,
        arxiv,
        ..Work::default()
    }
    .identify(openalex.as_deref())
}

fn inverted_abstract(index: &Value) -> String {
    let Some(words) = index.as_object() else {
        return String::new();
    };
    let mut placed: Vec<(u64, &str)> = words
        .iter()
        .flat_map(|(word, positions)| {
            positions
                .as_array()
                .into_iter()
                .flatten()
                .filter_map(Value::as_u64)
                .map(move |position| (position, word.as_str()))
        })
        .collect();
    placed.sort_by_key(|(position, _)| *position);
    placed
        .into_iter()
        .map(|(_, word)| word)
        .collect::<Vec<_>>()
        .join(" ")
}

/// Lower case letters and digits, words separated by single spaces.
pub fn normalized_title(title: &str) -> String {
    title
        .to_lowercase()
        .chars()
        .map(|c| if c.is_alphanumeric() { c } else { ' ' })
        .collect::<String>()
        .split_whitespace()
        .collect::<Vec<_>>()
        .join(" ")
}

/// Two normalized titles name the same paper: equal, or one a prefix of the other when a
/// file name cut the title short.
fn same_title(found: &str, wanted: &str) -> bool {
    let long = |title: &str| title.len() >= 24;
    found == wanted
        || (long(wanted) && found.starts_with(wanted))
        || (long(found) && wanted.starts_with(found))
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn arxiv_feeds_become_works_with_stable_ids() {
        let feed = r#"<?xml version='1.0'?><feed xmlns="http://www.w3.org/2005/Atom"><title>query</title>
            <entry><id>http://arxiv.org/abs/1706.03762v7</id><published>2017-06-12T17:57:34Z</published>
            <title>Attention Is All
              You Need</title><summary>The dominant models...</summary><author><name>Ashish Vaswani</name></author>
            <category term="cs.CL" scheme="http://arxiv.org/schemas/atom"/><category term="cs.LG"/>
            <link title="pdf" href="https://arxiv.org/pdf/1706.03762v7" rel="related" type="application/pdf"/></entry></feed>"#;
        let works = arxiv_feed(feed);
        assert_eq!(works.len(), 1);
        let work = &works[0];
        assert_eq!(work.id, "arxiv:1706.03762");
        assert_eq!(work.title, "Attention Is All You Need");
        assert_eq!(work.published.as_deref(), Some("2017-06-12"));
        assert_eq!(work.authors, ["Ashish Vaswani"]);
        assert_eq!(work.categories, ["cs.CL", "cs.LG"]);
        assert_eq!(
            work.pdf_url.as_deref(),
            Some("https://arxiv.org/pdf/1706.03762v7")
        );
        assert_eq!(work.url, "https://arxiv.org/abs/1706.03762");
    }

    #[test]
    fn openalex_works_share_the_arxiv_id_when_there_is_one() {
        let work = json!({"id":"https://openalex.org/W1","display_name":"Attention Is All You Need",
            "publication_date":"2017-06-12","cited_by_count":100,"doi":"https://doi.org/10.1/X",
            "authorships":[{"author":{"display_name":"A. Vaswani"}}],
            "abstract_inverted_index":{"is":[1],"Attention":[0],"all":[2]},
            "primary_location":{"landing_page_url":"https://papers.example/1","source":{"display_name":"NeurIPS"}},
            "locations":[{"landing_page_url":"https://arxiv.org/abs/1706.03762v5"}],
            "best_oa_location":{"pdf_url":"https://papers.example/1.pdf"},
            "topics":[{"display_name":"Natural Language Processing"}]});
        let parsed = openalex_work(&work);
        assert_eq!(parsed.id, "arxiv:1706.03762");
        assert_eq!(parsed.doi.as_deref(), Some("10.1/x"));
        assert_eq!(parsed.summary, "Attention is all");
        assert_eq!(parsed.venue.as_deref(), Some("NeurIPS"));
        assert_eq!(parsed.categories, ["Natural Language Processing"]);
        let mut plain = work.clone();
        plain["locations"] = json!([]);
        assert_eq!(openalex_work(&plain).id, "doi:10.1/x");
        plain["doi"] = Value::Null;
        assert_eq!(openalex_work(&plain).id, "openalex:W1");
    }

    #[test]
    fn arxiv_ids_are_recognised_in_links_and_file_names() {
        assert_eq!(
            arxiv_id("http://arxiv.org/abs/2410.12361v3").as_deref(),
            Some("2410.12361")
        );
        assert_eq!(arxiv_id("2410.12361v12").as_deref(), Some("2410.12361"));
        assert_eq!(
            arxiv_id("https://arxiv.org/pdf/1706.03762.pdf").as_deref(),
            Some("1706.03762")
        );
        assert_eq!(
            arxiv_id("arXiv:cs/0112017v1").as_deref(),
            Some("cs/0112017")
        );
        assert_eq!(arxiv_id("Attention Is All You Need"), None);
        assert_eq!(arxiv_id("2024.1"), None);
    }

    #[test]
    fn titles_match_across_punctuation_and_file_name_cuts() {
        let full = normalized_title("Beyond Static Dialogues: Benchmarking Realistic, Heterogeneous, and Long Conversations");
        let cut =
            normalized_title("Beyond Static Dialogues Benchmarking Realistic, Heterogeneous, and");
        assert!(same_title(&full, &cut));
        assert!(same_title(
            &normalized_title("A-MEM: Agentic Memory"),
            &normalized_title("A MEM Agentic Memory")
        ));
        assert!(!same_title(
            &normalized_title("Memory for agents"),
            &normalized_title("Memory for robots")
        ));
    }
}

#[cfg(test)]
mod live {
    use super::*;

    /// Reaches arXiv and OpenAlex: `cargo test -p capsio --lib scholar::live -- --ignored`.
    #[test]
    #[ignore]
    fn the_real_sources_answer() {
        let block = |future| tauri::async_runtime::block_on(future);
        let newest = block(arxiv_newest("cat:cs.CL AND abs:\"agent memory\"", 5)).unwrap();
        assert!(!newest.is_empty());
        assert!(
            newest
                .iter()
                .all(|work| work.id.starts_with("arxiv:") && work.published.is_some()),
            "{newest:?}"
        );
        let since = (chrono::Local::now() - chrono::Duration::days(30))
            .format("%Y-%m-%d")
            .to_string();
        let recent =
            tauri::async_runtime::block_on(openalex_search("agent memory", Some(&since), 5))
                .unwrap();
        assert!(
            recent.iter().all(|work| work
                .published
                .as_deref()
                .is_some_and(|day| day >= since.as_str())),
            "{recent:?}"
        );
        let found =
            tauri::async_runtime::block_on(openalex_title("A-MEM: Agentic Memory for LLM Agents"))
                .unwrap();
        assert!(
            found.as_ref().is_some_and(|work| !work.summary.is_empty()),
            "{found:?}"
        );
        let by_id = tauri::async_runtime::block_on(arxiv_ids(&["1706.03762"])).unwrap();
        assert_eq!(by_id[0].title, "Attention Is All You Need");
    }
}
