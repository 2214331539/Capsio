//! Web search, page reading and paper search for the Agent over plain HTTP:
//! no browser tab, no API key and nothing charged. Search goes to Bing,
//! papers to OpenAlex and arXiv. Everything returned is untrusted material,
//! like the pages the embedded browser reads.

use base64::Engine;
use scraper::{node::Node, ElementRef, Html, Selector};
use serde::Deserialize;
use serde_json::{json, Value};
use std::time::Duration;

const AGENT: &str = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36";
const PAGE_LIMIT: usize = 20_000;
const BODY_LIMIT: usize = 8 * 1024 * 1024;

pub fn handles(tool: &str) -> bool {
    matches!(
        tool,
        "capsio_web_search" | "capsio_web_fetch" | "capsio_search_papers"
    )
}

pub fn specifications() -> Vec<Value> {
    [
        ("capsio_web_search", "Search the web (Bing) without opening a browser tab. Returns result titles, URLs and snippets. Fast; use it first for current facts, news, documentation and anything to cite. Read a result with capsio_web_fetch before relying on details.", json!({"query":{"type":"string"},"count":{"type":"integer","minimum":1,"maximum":10}}), vec!["query"]),
        ("capsio_web_fetch", "Fetch an HTTP/HTTPS page without a browser tab and return its title and main text (navigation and ads removed), plus links in the content. For pages that need JavaScript or a login, use capsio_browser_open instead.", json!({"url":{"type":"string"},"maxChars":{"type":"integer","minimum":1000,"maximum":60000}}), vec!["url"]),
        ("capsio_search_papers", "Search scholarly papers by keywords, title, author or DOI (OpenAlex), or arXiv (source=arxiv, also arXiv ids). Returns title, authors, year, venue, citation count, DOI, landing URL, open PDF URL and abstract.", json!({"query":{"type":"string"},"source":{"type":"string","enum":["openalex","arxiv"]},"limit":{"type":"integer","minimum":1,"maximum":20}}), vec!["query"]),
    ]
    .into_iter()
    .map(|(name, description, properties, required)| json!({"type":"function","name":name,"description":description,"inputSchema":{"type":"object","properties":properties,"required":required,"additionalProperties":false}}))
    .collect()
}

pub fn operate(tool: &str, args: &Value) -> Result<Value, String> {
    tauri::async_runtime::block_on(async {
        match tool {
            "capsio_web_search" => {
                let input: Search =
                    serde_json::from_value(args.clone()).map_err(|e| e.to_string())?;
                search(&input.query, input.count.unwrap_or(8).clamp(1, 10)).await
            }
            "capsio_web_fetch" => {
                let input: Fetch =
                    serde_json::from_value(args.clone()).map_err(|e| e.to_string())?;
                fetch(
                    &input.url,
                    input.max_chars.unwrap_or(PAGE_LIMIT).clamp(1000, 60_000),
                )
                .await
            }
            _ => {
                let input: Papers =
                    serde_json::from_value(args.clone()).map_err(|e| e.to_string())?;
                let limit = input.limit.unwrap_or(8).clamp(1, 20);
                papers(&input.query, input.source.as_deref(), limit).await
            }
        }
    })
}

#[derive(Deserialize)]
struct Search {
    query: String,
    count: Option<usize>,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Fetch {
    url: String,
    max_chars: Option<usize>,
}
#[derive(Deserialize)]
struct Papers {
    query: String,
    source: Option<String>,
    limit: Option<usize>,
}

pub(crate) fn client() -> Result<reqwest::Client, String> {
    crate::network::client(reqwest::Client::builder())
        .user_agent(AGENT)
        .connect_timeout(Duration::from_secs(10))
        .timeout(Duration::from_secs(25))
        .build()
        .map_err(|e| e.to_string())
}

pub(crate) async fn get(url: &str) -> Result<(String, String, String), String> {
    let response = client()?
        .get(url)
        .header("accept-language", "zh-CN,zh;q=0.9,en;q=0.8")
        .send()
        .await
        .map_err(|e| format!("网络请求失败：{e}"))?;
    let status = response.status();
    let final_url = response.url().to_string();
    let kind = response
        .headers()
        .get("content-type")
        .and_then(|value| value.to_str().ok())
        .unwrap_or_default()
        .to_ascii_lowercase();
    if !status.is_success() {
        return Err(format!("网页返回 HTTP {}。", status.as_u16()));
    }
    if response
        .content_length()
        .is_some_and(|size| size as usize > BODY_LIMIT)
    {
        return Err("网页太大（超过 8 MB），没有读取。".into());
    }
    let bytes = response.bytes().await.map_err(|e| e.to_string())?;
    if bytes.len() > BODY_LIMIT {
        return Err("网页太大（超过 8 MB），没有读取。".into());
    }
    Ok((
        final_url,
        kind,
        String::from_utf8_lossy(&bytes).into_owned(),
    ))
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

async fn search(query: &str, count: usize) -> Result<Value, String> {
    let query = query.trim();
    if query.is_empty() || query.chars().count() > 500 {
        return Err("搜索词为空或过长。".into());
    }
    let mut url = tauri::Url::parse("https://cn.bing.com/search").map_err(|e| e.to_string())?;
    url.query_pairs_mut()
        .append_pair("q", query)
        .append_pair("count", "10");
    let (_, _, html) = get(url.as_str()).await?;
    let results = bing_results(&html, count);
    if results.is_empty() {
        return Err("必应没有返回结果（可能要求验证）。可以换个说法再搜，或用 capsio_browser_search 在浏览器里搜索。".into());
    }
    Ok(json!({"query":query,"engine":"bing","results":results,"source":"untrusted-web-search"}))
}

pub(crate) fn bing_results(html: &str, count: usize) -> Vec<Value> {
    let document = Html::parse_document(html);
    let (item, link, caption, paragraph) = (
        selector("li.b_algo"),
        selector("h2 a"),
        selector(
            ".b_caption p, .b_caption .b_paractl, .b_lineclamp2, .b_lineclamp3, .b_lineclamp4",
        ),
        selector("p"),
    );
    let mut results = Vec::new();
    for result in document.select(&item) {
        let Some(anchor) = result.select(&link).next() else {
            continue;
        };
        let Some(href) = anchor.value().attr("href").and_then(bing_target) else {
            continue;
        };
        let title = text_of(anchor);
        if title.is_empty() {
            continue;
        }
        let snippet = result
            .select(&caption)
            .next()
            .or_else(|| result.select(&paragraph).next())
            .map(text_of)
            .unwrap_or_default();
        results.push(json!({"title":title,"url":href,"snippet":snippet}));
        if results.len() == count {
            break;
        }
    }
    results
}

/// The page a Bing result points at; its click-tracking links carry it base64-encoded in `u`.
fn bing_target(href: &str) -> Option<String> {
    let url = tauri::Url::parse(href).ok()?;
    if url
        .host_str()
        .is_some_and(|host| host.ends_with("bing.com"))
        && url.path() == "/ck/a"
    {
        let encoded = url.query_pairs().find(|(key, _)| key == "u")?.1.to_string();
        let encoded = encoded.strip_prefix("a1").unwrap_or(&encoded);
        let bytes = base64::engine::general_purpose::URL_SAFE_NO_PAD
            .decode(encoded.trim_end_matches('='))
            .ok()?;
        return String::from_utf8(bytes)
            .ok()
            .filter(|target| target.starts_with("http"));
    }
    matches!(url.scheme(), "http" | "https").then(|| href.to_string())
}

async fn fetch(address: &str, limit: usize) -> Result<Value, String> {
    let url = tauri::Url::parse(address.trim()).map_err(|_| "请提供完整的 HTTP 或 HTTPS 链接。")?;
    if !crate::browser::allowed(&url) {
        return Err("不允许读取这个地址。".into());
    }
    let (final_url, kind, body) = get(url.as_str()).await?;
    if kind.contains("pdf") || body.starts_with("%PDF") {
        return Ok(
            json!({"url":final_url,"contentType":"application/pdf","text":"","note":"这是 PDF 文件，没有直接读取。可以用 capsio_browser_open 打开，或下载到项目后再读。","source":"untrusted-web-page"}),
        );
    }
    if !kind.is_empty()
        && !kind.contains("html")
        && !kind.starts_with("text/")
        && !kind.contains("json")
        && !kind.contains("xml")
    {
        return Err(format!("不是网页或文本（{kind}），没有读取。"));
    }
    if !kind.is_empty() && !kind.contains("html") {
        let (text, truncated) = clip(body.trim(), limit);
        return Ok(
            json!({"url":final_url,"contentType":kind,"text":text,"truncated":truncated,"source":"untrusted-web-page"}),
        );
    }
    let page = readable(&body, &final_url);
    let (text, truncated) = clip(&page.text, limit);
    Ok(
        json!({"url":final_url,"title":page.title,"description":page.description,"text":text,"truncated":truncated,"links":page.links,"source":"untrusted-web-page"}),
    )
}

fn clip(text: &str, limit: usize) -> (String, bool) {
    if text.chars().count() <= limit {
        return (text.to_string(), false);
    }
    (text.chars().take(limit).collect(), true)
}

pub(crate) struct Page {
    pub title: String,
    pub description: String,
    pub text: String,
    pub links: Vec<Value>,
}

const SKIP: &[&str] = &[
    "script", "style", "noscript", "svg", "nav", "header", "footer", "aside", "form", "iframe",
    "button", "select", "template", "canvas", "dialog",
];
const BLOCK: &[&str] = &[
    "p",
    "div",
    "section",
    "article",
    "main",
    "br",
    "li",
    "ul",
    "ol",
    "tr",
    "table",
    "pre",
    "blockquote",
    "h1",
    "h2",
    "h3",
    "h4",
    "h5",
    "h6",
    "figure",
    "figcaption",
    "dd",
    "dt",
    "hr",
];

/// The page's main text: the article or main element when there is one, without
/// navigation, scripts and forms; headings marked as in Markdown.
pub(crate) fn readable(html: &str, base: &str) -> Page {
    let document = Html::parse_document(html);
    let first = |css: &str| document.select(&selector(css)).next();
    let title = first("title").map(text_of).unwrap_or_default();
    let description = first("meta[name=description], meta[property='og:description']")
        .and_then(|meta| meta.value().attr("content"))
        .unwrap_or_default()
        .trim()
        .to_string();
    let root = first("article")
        .or_else(|| first("main"))
        .or_else(|| first("[role=main]"))
        .or_else(|| first("body"))
        .unwrap_or_else(|| document.root_element());
    let mut out = String::new();
    let mut links = Vec::new();
    let base = tauri::Url::parse(base).ok();
    walk(root, &mut out, &mut links, base.as_ref(), 0);
    let mut lines: Vec<String> = Vec::new();
    for line in out.lines() {
        let line = line.split_whitespace().collect::<Vec<_>>().join(" ");
        if line.is_empty() || lines.last() == Some(&line) {
            continue;
        }
        lines.push(line);
    }
    Page {
        title,
        description,
        text: lines.join("\n"),
        links,
    }
}

/// Pages nested deeper than this keep their text but lose structure, so a hostile
/// page cannot overflow the stack.
const MAX_DEPTH: usize = 256;

fn walk(
    element: ElementRef,
    out: &mut String,
    links: &mut Vec<Value>,
    base: Option<&tauri::Url>,
    depth: usize,
) {
    let name = element.value().name();
    if SKIP.contains(&name) || element.value().attr("aria-hidden") == Some("true") {
        return;
    }
    if depth >= MAX_DEPTH {
        out.extend(element.text());
        return;
    }
    let block = BLOCK.contains(&name);
    if block {
        out.push('\n');
    }
    if let Some(level) = name
        .strip_prefix('h')
        .and_then(|n| n.parse::<usize>().ok())
        .filter(|n| (1..=6).contains(n))
    {
        out.push_str(&"#".repeat(level));
        out.push(' ');
    }
    if name == "li" {
        out.push_str("- ");
    }
    if name == "a" && links.len() < 40 {
        if let Some(href) = element.value().attr("href") {
            let target = base.and_then(|base| base.join(href).ok());
            let text = text_of(element);
            if let Some(target) = target.filter(|t| matches!(t.scheme(), "http" | "https")) {
                if !text.is_empty() {
                    links.push(json!({"text":text,"url":target.as_str()}));
                }
            }
        }
    }
    for child in element.children() {
        match child.value() {
            Node::Text(text) => out.push_str(text),
            Node::Element(_) => {
                if let Some(child) = ElementRef::wrap(child) {
                    walk(child, out, links, base, depth + 1);
                }
            }
            _ => {}
        }
    }
    if block {
        out.push('\n');
    }
}

async fn papers(query: &str, source: Option<&str>, limit: usize) -> Result<Value, String> {
    let query = query.trim();
    if query.is_empty() || query.chars().count() > 500 {
        return Err("检索词为空或过长。".into());
    }
    let by_id = crate::scholar::arxiv_id(query).filter(|_| !query.contains(' '));
    let doi = query
        .trim_start_matches("https://doi.org/")
        .trim_start_matches("doi:")
        .trim();
    let from_arxiv = source == Some("arxiv") || by_id.is_some();
    let works = match (&by_id, from_arxiv) {
        (Some(id), _) => crate::scholar::arxiv_ids(&[id]).await?,
        (None, true) => crate::scholar::arxiv_search(&format!("all:{query}"), limit).await?,
        (None, false) if doi.starts_with("10.") && doi.contains('/') => {
            crate::scholar::OpenAlex::direct()
                .doi(doi)
                .await?
                .into_iter()
                .collect()
        }
        (None, false) => {
            crate::scholar::OpenAlex::direct()
                .search(query, None, limit)
                .await?
        }
    };
    let results: Vec<Value> = works.iter().map(paper_view).collect();
    Ok(json!({"query":query,"source":if from_arxiv {"arxiv"} else {"openalex"},"results":results}))
}

/// What the Agent is shown of a paper.
fn paper_view(work: &crate::scholar::Work) -> Value {
    json!({
        "title": work.title,
        "authors": work.authors.iter().take(8).collect::<Vec<_>>(),
        "year": work.published.as_deref().and_then(|date| date.get(..4)),
        "venue": work.venue,
        "citations": work.citations,
        "doi": work.doi.as_ref().map(|doi| format!("https://doi.org/{doi}")),
        "url": work.url,
        "pdfUrl": work.pdf_url,
        "abstract": clip(&work.summary, 1500).0,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn bing_results_keep_titles_targets_and_snippets() {
        let html = r#"<ol><li class="b_algo"><div class="b_tpcn"><a class="tilk" href="https://example.com/a">example.com</a></div>
            <h2><a href="https://example.com/a">An <strong>Example</strong> page</a></h2>
            <div class="b_caption"><p class="b_lineclamp2">First snippet &#0183; more</p></div></li>
            <li class="b_algo"><h2><a href="https://www.bing.com/ck/a?!&&p=1&u=a1aHR0cHM6Ly9leGFtcGxlLm9yZy9i&ntb=1">Tracked</a></h2><p>Second</p></li></ol>"#;
        let results = bing_results(html, 8);
        assert_eq!(results.len(), 2);
        assert_eq!(results[0]["title"], "An Example page");
        assert_eq!(results[0]["url"], "https://example.com/a");
        assert!(results[0]["snippet"]
            .as_str()
            .unwrap()
            .starts_with("First snippet"));
        assert_eq!(results[1]["url"], "https://example.org/b");
        assert_eq!(bing_results(html, 1).len(), 1);
    }

    #[test]
    fn readable_text_keeps_the_article_and_drops_the_chrome() {
        let html = r#"<html><head><title>Paper notes</title><meta name="description" content="About it"></head>
            <body><nav>Home Login</nav><article><h1>Results</h1><p>Accuracy rose to <b>91%</b>.</p>
            <script>track()</script><ul><li>One</li><li><a href="/more">More</a></li></ul></article><footer>Copyright</footer></body></html>"#;
        let page = readable(html, "https://example.com/post");
        assert_eq!(page.title, "Paper notes");
        assert_eq!(page.description, "About it");
        assert_eq!(page.text, "# Results\nAccuracy rose to 91%.\n- One\n- More");
        assert_eq!(page.links[0]["url"], "https://example.com/more");
    }

    #[test]
    fn papers_show_the_agent_who_when_where_and_a_bounded_abstract() {
        let work = crate::scholar::Work {
            title: "Attention Is All You Need".into(),
            authors: (0..10).map(|i| format!("Author {i}")).collect(),
            summary: "x".repeat(2000),
            published: Some("2017-06-12".into()),
            venue: Some("NeurIPS".into()),
            doi: Some("10.1/x".into()),
            url: "https://papers.example/1".into(),
            pdf_url: Some("https://papers.example/1.pdf".into()),
            ..Default::default()
        };
        let paper = paper_view(&work);
        assert_eq!(paper["year"], "2017");
        assert_eq!(paper["authors"].as_array().unwrap().len(), 8);
        assert_eq!(paper["doi"], "https://doi.org/10.1/x");
        assert_eq!(paper["pdfUrl"], "https://papers.example/1.pdf");
        assert_eq!(paper["abstract"].as_str().unwrap().len(), 1500);
    }
}

#[cfg(test)]
mod live {
    use super::*;

    /// Reaches Bing, OpenAlex, arXiv and a real page: `cargo test -p capsio --lib web::live -- --ignored`.
    #[test]
    #[ignore]
    fn the_real_services_answer() {
        let search = operate(
            "capsio_web_search",
            &json!({"query":"Attention Is All You Need"}),
        )
        .unwrap();
        assert!(search["results"].as_array().unwrap().len() >= 3, "{search}");
        let page = operate(
            "capsio_web_fetch",
            &json!({"url":"https://www.rust-lang.org/"}),
        )
        .unwrap();
        assert!(page["text"].as_str().unwrap().contains("Rust"), "{page}");
        let papers = operate(
            "capsio_search_papers",
            &json!({"query":"attention is all you need","limit":3}),
        )
        .unwrap();
        assert!(
            !papers["results"].as_array().unwrap().is_empty(),
            "{papers}"
        );
        let arxiv = operate("capsio_search_papers", &json!({"query":"1706.03762"})).unwrap();
        assert_eq!(
            arxiv["results"][0]["title"], "Attention Is All You Need",
            "{arxiv}"
        );
        println!(
            "{}",
            serde_json::to_string_pretty(&search["results"][0]).unwrap()
        );
        println!(
            "{}",
            serde_json::to_string_pretty(&papers["results"][0]["title"]).unwrap()
        );
    }
}
