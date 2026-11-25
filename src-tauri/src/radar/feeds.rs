//! News and blog posts, from a built-in list of feeds (`catalog.json`): official labs,
//! researchers' blogs and media, grouped by field. A project follows the feeds of its fields;
//! each feed is read at most hourly and its posts serve every project. Following AIHOT (MIT,
//! github.com/KKKKhazix/AIHOT), each source has a tier, and old posts never flood in: only
//! posts from the last two days are kept.

use super::profile::Profile;
use super::store::Store;
use super::{Clock, Outside};
use crate::scholar::{Kind, Work};
use roxmltree::{Document, Node, ParsingOptions};
use serde::Deserialize;
use std::collections::HashMap;
use std::sync::OnceLock;

const CATALOG: &str = include_str!("catalog.json");
/// A feed is read again after this long, whether or not it answered.
const REFRESH: i64 = 3600;
/// Posts published longer ago than this are left out.
pub(crate) const FRESH_DAYS: i64 = 2;
/// A post's summary only needs to say what it is about.
const SUMMARY_CHARS: usize = 1500;

#[derive(Debug, Deserialize)]
struct Catalog {
    /// arXiv categories by field.
    areas: HashMap<String, Vec<String>>,
    feeds: Vec<Feed>,
}

#[derive(Debug, Deserialize)]
pub(crate) struct Feed {
    pub id: String,
    /// What its posts show as their source.
    pub name: String,
    pub url: String,
    pub kind: Kind,
    /// 1 an official source, 2 a researcher or a semi-official one, 3 media.
    pub tier: u8,
    /// Fields, by name in the catalog's `areas`.
    areas: Vec<String>,
}

fn catalog() -> &'static Catalog {
    static CATALOG_DATA: OnceLock<Catalog> = OnceLock::new();
    CATALOG_DATA.get_or_init(|| serde_json::from_str(CATALOG).expect("catalog.json is valid"))
}

impl Feed {
    /// The arXiv categories of the feed's fields, which its posts carry.
    fn categories(&self) -> Vec<String> {
        let mut categories: Vec<String> = Vec::new();
        for area in &self.areas {
            for category in catalog().areas.get(area).into_iter().flatten() {
                if !categories.contains(category) {
                    categories.push(category.clone());
                }
            }
        }
        categories
    }
}

/// The feeds of a project's fields.
pub(crate) fn wanted(profile: &Profile) -> Vec<&'static Feed> {
    catalog()
        .feeds
        .iter()
        .filter(|feed| {
            feed.categories()
                .iter()
                .any(|category| profile.categories.contains(category))
        })
        .collect()
}

/// The feed a post came from, by the source name it carries.
pub(crate) fn source(name: &str) -> Option<&'static Feed> {
    catalog().feeds.iter().find(|feed| feed.name == name)
}

/// Reads the project's feeds that are due and keeps their recent posts. Returns how many posts
/// were new to this device; a feed that could not be read is reported once all were tried.
pub(crate) fn refresh(
    store: &Store,
    outside: &dyn Outside,
    profile: &Profile,
    clock: &Clock,
) -> Result<usize, String> {
    let since = clock.day_offset(-FRESH_DAYS);
    let mut added = 0;
    let mut failed = Vec::new();
    for feed in wanted(profile) {
        if store
            .feed_read(&feed.id)?
            .is_some_and(|at| clock.now - at < REFRESH)
        {
            continue;
        }
        // Marked either way: an unreachable feed is tried again in an hour, not every pass.
        store.mark_feed_read(&feed.id, clock.now)?;
        match outside.feed(&feed.url) {
            Ok(body) => {
                let recent: Vec<Work> = posts(&body, feed)
                    .into_iter()
                    .filter(|post| {
                        post.published
                            .as_deref()
                            .is_some_and(|day| day >= since.as_str())
                    })
                    .collect();
                added += store.add_works(&recent, clock.now)?;
            }
            Err(error) => failed.push(format!("{}：{error}", feed.name)),
        }
    }
    if failed.is_empty() {
        Ok(added)
    } else {
        Err(failed.join("；"))
    }
}

/// The posts of an RSS 2.0, RSS 1.0 or Atom document.
pub(crate) fn posts(body: &str, feed: &Feed) -> Vec<Work> {
    let body = body.trim_start_matches('\u{feff}').trim_start();
    let options = ParsingOptions {
        allow_dtd: true,
        ..ParsingOptions::default()
    };
    let Ok(document) = Document::parse_with_options(body, options) else {
        return Vec::new();
    };
    let categories = feed.categories();
    document
        .descendants()
        .filter(|node| node.is_element() && matches!(node.tag_name().name(), "item" | "entry"))
        .filter_map(|entry| {
            let title = squeeze(&text(child(entry, &["title"])?));
            let url = canonical(&link(entry)?);
            if title.is_empty() {
                return None;
            }
            let summary = ["description", "summary", "encoded", "content"]
                .iter()
                .filter_map(|&name| child(entry, &[name]))
                .map(|node| plain(&text(node)))
                .find(|summary| !summary.is_empty())
                .unwrap_or_default();
            let published = ["pubDate", "published", "updated", "date"]
                .iter()
                .filter_map(|&name| child(entry, &[name]))
                .find_map(|node| day(&text(node)));
            let authors = entry
                .children()
                .filter(|node| matches!(node.tag_name().name(), "author" | "creator"))
                .map(|node| squeeze(&child(node, &["name"]).map_or_else(|| text(node), text)))
                .filter(|name| !name.is_empty() && !name.contains('@'))
                .collect();
            Some(Work {
                id: format!("url:{url}"),
                title,
                authors,
                summary: summary.chars().take(SUMMARY_CHARS).collect(),
                published,
                venue: Some(feed.name.clone()),
                url,
                categories: categories.clone(),
                kind: feed.kind,
                ..Work::default()
            })
        })
        .collect()
}

/// The first child element with one of these local names (namespaces aside).
fn child<'a>(node: Node<'a, 'a>, names: &[&str]) -> Option<Node<'a, 'a>> {
    node.children()
        .find(|child| child.is_element() && names.contains(&child.tag_name().name()))
}

/// All the text inside a node, CDATA included.
fn text(node: Node) -> String {
    node.descendants()
        .filter(|node| node.is_text())
        .filter_map(|node| node.text())
        .collect()
}

/// An entry's page: Atom's alternate link, RSS's link, or a guid that is a web address.
fn link(entry: Node) -> Option<String> {
    let atom = entry
        .children()
        .filter(|node| node.is_element() && node.tag_name().name() == "link")
        .find(|node| node.attribute("rel").is_none_or(|rel| rel == "alternate"))
        .and_then(|node| node.attribute("href").map(str::to_string));
    let rss = child(entry, &["link"]).map(text);
    let guid = child(entry, &["guid", "id"]).map(text);
    [atom, rss, guid]
        .into_iter()
        .flatten()
        .map(|address| address.trim().to_string())
        .find(|address| address.starts_with("https://") || address.starts_with("http://"))
}

/// The same page under one address: without tracking parameters or a fragment.
fn canonical(address: &str) -> String {
    let Ok(mut url) = reqwest::Url::parse(address) else {
        return address.to_string();
    };
    url.set_fragment(None);
    let kept: Vec<(String, String)> = url
        .query_pairs()
        .filter(|(key, _)| !key.starts_with("utm_"))
        .map(|(key, value)| (key.into_owned(), value.into_owned()))
        .collect();
    if kept.is_empty() {
        url.set_query(None);
    } else {
        url.query_pairs_mut().clear().extend_pairs(kept);
    }
    url.to_string()
}

/// Text from a summary that may be HTML.
fn plain(html: &str) -> String {
    let fragment = scraper::Html::parse_fragment(html);
    squeeze(&fragment.root_element().text().collect::<Vec<_>>().join(" "))
}

fn squeeze(text: &str) -> String {
    text.split_whitespace().collect::<Vec<_>>().join(" ")
}

/// `YYYY-MM-DD` in local time, from the dates feeds use.
fn day(date: &str) -> Option<String> {
    let date = date.trim();
    let parsed = chrono::DateTime::parse_from_rfc2822(date)
        .or_else(|_| chrono::DateTime::parse_from_rfc3339(date))
        .ok();
    if let Some(time) = parsed {
        return Some(
            time.with_timezone(&chrono::Local)
                .format("%Y-%m-%d")
                .to_string(),
        );
    }
    let start = date.get(..10)?;
    chrono::NaiveDate::parse_from_str(start, "%Y-%m-%d")
        .ok()
        .map(|_| start.to_string())
}

#[cfg(test)]
mod tests {
    use super::super::tests::{clock, Fake};
    use super::*;

    fn feed(id: &str) -> &'static Feed {
        catalog().feeds.iter().find(|feed| feed.id == id).unwrap()
    }

    /// Every feed in the catalog, read for real: how many posts each gives, how many are
    /// recent. `cargo test -p capsio --lib radar::feeds::tests::real -- --ignored --nocapture`.
    #[test]
    #[ignore]
    fn real_feeds_parse() {
        let live = super::super::worker::Live::new(None);
        let since = (chrono::Local::now() - chrono::Duration::days(FRESH_DAYS))
            .format("%Y-%m-%d")
            .to_string();
        let mut silent = Vec::new();
        for feed in &catalog().feeds {
            match live.feed(&feed.url) {
                Ok(body) => {
                    let found = posts(&body, feed);
                    let recent = found
                        .iter()
                        .filter(|post| post.published.as_deref() >= Some(since.as_str()))
                        .count();
                    println!(
                        "{:<24} {:>4} posts, {:>3} recent",
                        feed.id,
                        found.len(),
                        recent
                    );
                    if found.is_empty() {
                        silent.push(feed.id.as_str());
                    }
                }
                Err(error) => println!("{:<24} unreachable: {error}", feed.id),
            }
        }
        assert!(silent.is_empty(), "feeds that give no posts: {silent:?}");
    }

    #[test]
    fn the_catalog_is_complete_and_every_feed_has_fields() {
        let mut ids = std::collections::HashSet::new();
        for feed in &catalog().feeds {
            assert!(ids.insert(&feed.id), "{} is listed twice", feed.id);
            assert!(feed.url.starts_with("https://"), "{}", feed.id);
            assert!((1..=3).contains(&feed.tier), "{}", feed.id);
            assert!(
                !feed.categories().is_empty(),
                "{} has no known field",
                feed.id
            );
            assert!(feed.kind != Kind::Paper, "{}", feed.id);
        }
    }

    #[test]
    fn a_project_follows_the_feeds_of_its_fields() {
        let nlp = Profile {
            categories: vec!["cs.CL".into()],
            ..Profile::default()
        };
        let followed: Vec<&str> = wanted(&nlp).iter().map(|feed| feed.id.as_str()).collect();
        assert!(followed.contains(&"openai") && followed.contains(&"qbitai"));
        assert!(!followed.contains(&"krebs"));
        let security = Profile {
            categories: vec!["cs.CR".into()],
            ..Profile::default()
        };
        let followed: Vec<&str> = wanted(&security)
            .iter()
            .map(|feed| feed.id.as_str())
            .collect();
        assert!(followed.contains(&"krebs") && !followed.contains(&"openai"));
        assert!(wanted(&Profile::default()).is_empty());
    }

    #[test]
    fn rss_items_become_posts() {
        let body = r#"<?xml version="1.0" encoding="UTF-8"?>
            <rss version="2.0" xmlns:dc="http://purl.org/dc/elements/1.1/"
                 xmlns:content="http://purl.org/rss/1.0/modules/content/"><channel><title>AI</title>
            <item><title><![CDATA[A new  model
              ships]]></title><link>https://example.com/a?utm_source=rss&amp;id=7#top</link>
            <dc:creator>Jane Doe</dc:creator><pubDate>Tue, 24 Nov 2026 13:00:00 GMT</pubDate>
            <description>&lt;p&gt;It is &lt;b&gt;fast&lt;/b&gt;.&lt;/p&gt;</description></item>
            <item><title>No link</title></item>
            </channel></rss>"#;
        let found = posts(body, feed("techcrunch"));
        assert_eq!(found.len(), 1);
        let post = &found[0];
        assert_eq!(post.title, "A new model ships");
        assert_eq!(post.url, "https://example.com/a?id=7");
        assert_eq!(post.id, "url:https://example.com/a?id=7");
        assert_eq!(post.summary, "It is fast .");
        assert_eq!(post.authors, ["Jane Doe"]);
        assert!(post
            .published
            .as_deref()
            .is_some_and(|day| day.starts_with("2026-11-2")));
        assert_eq!(post.venue.as_deref(), Some("TechCrunch"));
        assert_eq!(post.kind, Kind::News);
        assert!(post.categories.contains(&"cs.CL".to_string()));
    }

    #[test]
    fn atom_entries_become_posts() {
        let body = r#"<feed xmlns="http://www.w3.org/2005/Atom"><title>Blog</title>
            <entry><title type="html">Agents &amp; memory</title>
            <link rel="replies" href="https://example.com/a#comments"/>
            <link href="https://example.com/a"/><id>tag:example.com,2026:1</id>
            <published>2026-11-24T21:41:37+00:00</published><author><name>Simon</name></author>
            <content type="html">&lt;p&gt;Notes on memory.&lt;/p&gt;</content></entry></feed>"#;
        let found = posts(body, feed("simon-willison"));
        assert_eq!(found.len(), 1);
        assert_eq!(found[0].title, "Agents & memory");
        assert_eq!(found[0].url, "https://example.com/a");
        assert_eq!(found[0].summary, "Notes on memory.");
        assert_eq!(found[0].authors, ["Simon"]);
        assert_eq!(found[0].kind, Kind::Blog);
        assert!(posts("not xml", feed("simon-willison")).is_empty());
    }

    #[test]
    fn feeds_are_read_hourly_and_keep_only_recent_posts() {
        let dir = tempfile::tempdir().unwrap();
        let store = Store::open(&dir.path().join("radar.sqlite")).unwrap();
        let outside = Fake::default();
        let item = |title: &str, date: &str| {
            format!("<item><title>{title}</title><link>https://example.com/{title}</link><pubDate>{date}</pubDate></item>")
        };
        let body = format!(
            "<rss><channel>{}{}</channel></rss>",
            item("fresh", "Wed, 25 Nov 2026 01:00:00 GMT"),
            item("old", "Mon, 16 Nov 2026 01:00:00 GMT"),
        );
        outside
            .feeds
            .borrow_mut()
            .insert(feed("openai").url.clone(), body);
        let profile = Profile {
            categories: vec!["cs.CL".into()],
            ..Profile::default()
        };
        let today = clock("2026-11-25", 9);
        // Only OpenAI answers; the other feeds of the field are reported, and kept for an hour.
        let failed = refresh(&store, &outside, &profile, &today).unwrap_err();
        assert!(failed.contains("TechCrunch"));
        let kept = store.unconsidered("p", 0).unwrap();
        assert_eq!(kept.len(), 1);
        assert_eq!(kept[0].title, "fresh");
        let asked = outside.feeds_asked.borrow().len();
        assert_eq!(
            refresh(&store, &outside, &profile, &clock("2026-11-25", 9)),
            Ok(0)
        );
        assert_eq!(
            outside.feeds_asked.borrow().len(),
            asked,
            "nothing is asked again within the hour"
        );
    }
}
