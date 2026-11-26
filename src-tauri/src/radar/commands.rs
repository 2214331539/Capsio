//! What the recommendations page asks for, and what the assistant is told about the user.

use super::profile::Profile;
use super::store::{Action, Entry, Store};
use super::worker::{self, enabled, folder, open, wake};
use super::{account, highlights};
use super::{Clock, State};
use crate::library::{trusted, LibraryState};
use crate::scholar::Work;
use crate::AppState;
use serde::Serialize;
use std::time::Duration;
use tauri::Manager;

/// Runs work that touches files off the async runtime.
async fn blocking<T: Send + 'static>(
    work: impl FnOnce() -> Result<T, String> + Send + 'static,
) -> Result<T, String> {
    tauri::async_runtime::spawn_blocking(work)
        .await
        .map_err(|e| e.to_string())?
}

fn valid_project(project: &str) -> Result<(), String> {
    if capsio_core::workspace::valid_id(project) {
        Ok(())
    } else {
        Err("项目标识无效。".into())
    }
}

/// A recommendation as the page shows it.
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Item {
    pub id: String,
    /// `paper`, `news` or `blog`.
    pub kind: &'static str,
    /// The model's Chinese title.
    pub title: String,
    pub original_title: String,
    pub summary: String,
    pub reason: String,
    pub authors: Vec<String>,
    /// The journal or conference of a paper; the site of a post.
    pub venue: Option<String>,
    pub published: Option<String>,
    pub url: String,
    pub pdf_url: Option<String>,
    /// `saved`, `dismissed` or `later`, when the user did something with it.
    pub state: Option<&'static str>,
    /// Other sources that reported the same event.
    pub also: Vec<Report>,
}

/// Another source's report of an event.
#[derive(Serialize)]
pub struct Report {
    pub source: String,
    pub url: String,
}

/// A project's recommendations: the latest brief, what was kept for later, and the day's
/// field highlights, which every project shows.
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct View {
    /// `off`, `needsPapers`, `noModel`, `preparing` or `ready`.
    pub state: &'static str,
    pub day: Option<String>,
    pub items: Vec<Item>,
    pub later: Vec<Item>,
    pub highlights: Vec<Item>,
}

/// What the model wrote about a work.
struct Written {
    title: Option<String>,
    summary: Option<String>,
    reason: Option<String>,
}

pub(super) fn view(store: &Store, project: &str) -> Result<View, String> {
    let marked = |action: Action| store.with_action(project, action);
    let (saved, dismissed, later) = (
        marked(Action::Saved)?,
        marked(Action::Dismissed)?,
        marked(Action::Later)?,
    );
    let item = |work: Work, written: Written, also: &[String]| -> Result<Item, String> {
        let also = store
            .works(also)?
            .into_iter()
            .map(|work| Report {
                source: work.venue.unwrap_or_default(),
                url: work.url,
            })
            .collect();
        let state = [
            (Action::Saved, &saved),
            (Action::Dismissed, &dismissed),
            (Action::Later, &later),
        ]
        .into_iter()
        .find(|(_, ids)| ids.contains(&work.id))
        .map(|(action, _)| action.name());
        Ok(Item {
            kind: work.kind.name(),
            title: written.title.unwrap_or_else(|| work.title.clone()),
            original_title: work.title,
            summary: written.summary.unwrap_or_default(),
            reason: written.reason.unwrap_or_default(),
            authors: work.authors.into_iter().take(6).collect(),
            venue: work.venue,
            published: work.published,
            url: work.url,
            pdf_url: work.pdf_url,
            id: work.id,
            state,
            also,
        })
    };
    let picked = |entry: &Entry| -> Result<Option<Item>, String> {
        let Some(pick) = store.pick(project, &entry.id)? else {
            return Ok(None);
        };
        let written = Written {
            title: pick.title,
            summary: pick.summary,
            reason: pick.reason,
        };
        item(pick.work, written, &entry.also).map(Some)
    };
    let mut highlights = Vec::new();
    for highlight in highlights::latest(store, &Clock::local())? {
        let Some(work) = store.works(std::slice::from_ref(&highlight.id))?.pop() else {
            continue;
        };
        let written = Written {
            title: Some(highlight.title),
            summary: Some(highlight.summary),
            reason: Some(highlight.reason),
        };
        highlights.push(item(work, written, &highlight.also)?);
    }
    let Some((day, entries)) = store.latest_brief(project)? else {
        let state = match store.status(project)?.as_deref() {
            Some("needsPapers") => State::NeedsPapers,
            Some("noModel") => State::NoModel,
            _ => State::Preparing,
        };
        return Ok(View {
            state: state.name(),
            day: None,
            items: Vec::new(),
            later: Vec::new(),
            highlights,
        });
    };
    let mut items = Vec::new();
    for entry in &entries {
        items.extend(picked(entry)?);
    }
    let in_brief = |id: &String| entries.iter().any(|entry| entry.id == *id);
    let mut kept = Vec::new();
    for id in later
        .iter()
        .filter(|id| !in_brief(id) && !saved.contains(id) && !dismissed.contains(id))
    {
        kept.extend(picked(&Entry::from(id.as_str()))?);
    }
    Ok(View {
        state: "ready",
        day: Some(day),
        items,
        later: kept,
        highlights,
    })
}

/// What the assistant is told about the user and the project while recommendations are on:
/// the account profile's summary and the project's research topics. Empty otherwise, and on
/// any failure: the assistant works the same without it.
pub(crate) fn assistant_context<R: tauri::Runtime>(
    app: &tauri::AppHandle<R>,
    project: &str,
) -> String {
    if !enabled(app) {
        return String::new();
    }
    open(app).map_or_else(|_| String::new(), |store| background(&store, project))
}

/// The profile summary (at most 600 characters) and the project's topics (at most 400).
pub(super) fn background(store: &Store, project: &str) -> String {
    let mut parts = Vec::new();
    let summary = account::saved(store)
        .ok()
        .flatten()
        .map(|account| account.summary(600))
        .unwrap_or_default();
    if !summary.is_empty() {
        parts.push(format!(
            "<capsio-user>\nCapsio 根据用户的文献库和使用情况整理的背景，供参考：据此把握回答的深度和例子，不必复述；和用户的自定义指令冲突时以指令为准。\n{summary}\n</capsio-user>"
        ));
    }
    let topics = store
        .profile(project)
        .ok()
        .flatten()
        .and_then(|(json, ..)| serde_json::from_str::<Profile>(&json).ok())
        .map(|profile| {
            profile
                .topics
                .iter()
                .map(|topic| {
                    let keywords: Vec<&str> =
                        topic.keywords.iter().take(3).map(String::as_str).collect();
                    format!("{}（{}）", topic.name, keywords.join("、"))
                })
                .collect::<Vec<_>>()
                .join("；")
                .chars()
                .take(400)
                .collect::<String>()
        })
        .unwrap_or_default();
    if !topics.is_empty() {
        parts.push(format!(
            "<capsio-research>\n这个项目在研究：{topics}\n</capsio-research>"
        ));
    }
    parts.join("\n\n")
}

/// The longest question kept as a signal; its gist is in the first few sentences.
const QUESTION_CHARS: usize = 300;

/// Notes a question the user put to the assistant (only their words) for the account profile,
/// while recommendations are on.
#[tauri::command]
pub async fn radar_note<R: tauri::Runtime>(
    app: tauri::AppHandle<R>,
    view: tauri::Webview<R>,
    project_id: Option<String>,
    text: String,
) -> Result<(), String> {
    trusted(&view)?;
    let project = project_id.filter(|id| capsio_core::workspace::valid_id(id));
    let text: String = text.trim().chars().take(QUESTION_CHARS).collect();
    if text.is_empty() || !enabled(&app) {
        return Ok(());
    }
    blocking(move || open(&app)?.note("question", project.as_deref(), &text, Clock::local().now))
        .await
}

/// The background the quick chat adds to its instructions; see `assistant_context`.
#[tauri::command]
pub async fn radar_context<R: tauri::Runtime>(
    app: tauri::AppHandle<R>,
    view: tauri::Webview<R>,
    project_id: String,
) -> Result<String, String> {
    trusted(&view)?;
    blocking(move || Ok(assistant_context(&app, &project_id))).await
}

/// The project is open: follow it, and look for its recommendations soon.
#[tauri::command]
pub async fn radar_visit<R: tauri::Runtime>(
    app: tauri::AppHandle<R>,
    view: tauri::Webview<R>,
    project_id: String,
) -> Result<(), String> {
    trusted(&view)?;
    valid_project(&project_id)?;
    let handle = app.clone();
    blocking(move || open(&handle)?.visit(&project_id, Clock::local().now)).await?;
    wake(&app);
    Ok(())
}

#[tauri::command]
pub async fn radar_view<R: tauri::Runtime>(
    app: tauri::AppHandle<R>,
    view: tauri::Webview<R>,
    project_id: String,
) -> Result<View, String> {
    trusted(&view)?;
    valid_project(&project_id)?;
    if !enabled(&app) {
        return Ok(View {
            state: "off",
            day: None,
            items: Vec::new(),
            later: Vec::new(),
            highlights: Vec::new(),
        });
    }
    blocking(move || self::view(&open(&app)?, &project_id)).await
}

/// Records what the user did with a recommendation, or takes it back with `undo`.
#[tauri::command]
pub async fn radar_feedback<R: tauri::Runtime>(
    app: tauri::AppHandle<R>,
    view: tauri::Webview<R>,
    project_id: String,
    work_id: String,
    action: String,
    reason: Option<String>,
    undo: Option<bool>,
) -> Result<(), String> {
    trusted(&view)?;
    valid_project(&project_id)?;
    let action = Action::parse(&action).ok_or("操作无效。")?;
    let reason = reason.map(|reason| reason.chars().take(40).collect::<String>());
    blocking(move || {
        let store = open(&app)?;
        if undo == Some(true) {
            store.forget(&project_id, &work_id, action)
        } else {
            store.record(
                &project_id,
                &work_id,
                action,
                reason.as_deref(),
                Clock::local().now,
            )
        }
    })
    .await
}

/// What saving a recommendation did.
#[derive(Serialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum Saved {
    /// Downloaded into the literature folder.
    Added {
        #[serde(rename = "paperId")]
        paper_id: String,
    },
    /// No open PDF to download: the page to get it from.
    Link { url: String },
}

const PDF_LIMIT: u64 = 150 * 1024 * 1024;

/// Downloads a recommended paper into the project's literature folder, with its details.
#[tauri::command]
pub async fn radar_save<R: tauri::Runtime>(
    app: tauri::AppHandle<R>,
    view: tauri::Webview<R>,
    project_id: String,
    work_id: String,
) -> Result<Saved, String> {
    trusted(&view)?;
    valid_project(&project_id)?;
    crate::collaboration::permissions::require_write(
        &app.state::<AppState>().storage,
        &project_id,
        "library",
    )?;
    let (handle, project, work) = (app.clone(), project_id.clone(), work_id.clone());
    let pick = blocking(move || open(&handle)?.pick(&project, &work))
        .await?
        .ok_or("这条推荐已经不在了。")?;
    let Some(pdf_url) = pick.work.pdf_url.clone() else {
        return Ok(Saved::Link { url: pick.work.url });
    };
    let bytes = download_pdf(&pdf_url).await?;
    blocking(move || {
        let temporary = folder(&app).join(format!("{}.pdf", uuid::Uuid::new_v4()));
        std::fs::write(&temporary, &bytes).map_err(|e| e.to_string())?;
        let service = app.state::<LibraryState>().service.clone();
        let added = service.add_pdf(
            &project_id,
            "",
            &temporary,
            &file_name(&pick.work.title),
            None,
        );
        let _ = std::fs::remove_file(&temporary);
        let (binding, _) = added?;
        service.merge_record(
            &project_id,
            &binding.fingerprint,
            &reference(&pick.work),
            &[],
        )?;
        open(&app)?.record(
            &project_id,
            &work_id,
            Action::Saved,
            None,
            Clock::local().now,
        )?;
        Ok(Saved::Added {
            paper_id: binding.id,
        })
    })
    .await
}

async fn download_pdf(url: &str) -> Result<Vec<u8>, String> {
    let response = crate::network::client(reqwest::Client::builder())
        .connect_timeout(Duration::from_secs(15))
        .timeout(Duration::from_secs(120))
        .build()
        .map_err(|e| e.to_string())?
        .get(url)
        .send()
        .await
        .map_err(|e| format!("下载论文失败：{e}"))?;
    if !response.status().is_success() {
        return Err(format!(
            "下载论文失败（HTTP {}）。",
            response.status().as_u16()
        ));
    }
    if response
        .content_length()
        .is_some_and(|size| size > PDF_LIMIT)
    {
        return Err("论文文件超过 150 MB。".into());
    }
    let bytes = response
        .bytes()
        .await
        .map_err(|e| format!("下载论文失败：{e}"))?;
    if !bytes.starts_with(b"%PDF") {
        return Err("下载到的不是 PDF，可以打开原文页面手动下载。".into());
    }
    Ok(bytes.to_vec())
}

/// A file name from a title: what file systems refuse becomes a space.
fn file_name(title: &str) -> String {
    let clean: String = title
        .chars()
        .map(|c| {
            if "\\/:*?\"<>|".contains(c) || c.is_control() {
                ' '
            } else {
                c
            }
        })
        .collect();
    let clean = clean.split_whitespace().collect::<Vec<_>>().join(" ");
    let clean: String = clean.chars().take(120).collect();
    format!(
        "{}.pdf",
        if clean.is_empty() {
            "paper"
        } else {
            clean.trim_end_matches('.')
        }
    )
}

fn reference(work: &Work) -> capsio_core::references::Reference {
    capsio_core::references::Reference {
        kind: if work.arxiv.is_some() {
            "misc".into()
        } else {
            "article".into()
        },
        title: work.title.clone(),
        authors: work.authors.clone(),
        year: work
            .published
            .as_deref()
            .and_then(|day| day.get(..4))
            .map(str::to_string),
        venue: work.venue.clone(),
        doi: work.doi.clone(),
        url: Some(work.url.clone()),
        abstract_text: Some(work.summary.clone()).filter(|summary| !summary.is_empty()),
        ..Default::default()
    }
}

/// Deletes everything the recommendations kept on this device.
#[tauri::command]
pub async fn radar_clear<R: tauri::Runtime>(
    app: tauri::AppHandle<R>,
    view: tauri::Webview<R>,
) -> Result<(), String> {
    trusted(&view)?;
    blocking(move || worker::clear(&app)).await
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_assistant_hears_the_profile_and_the_project_s_topics() {
        let dir = tempfile::tempdir().unwrap();
        let store = Store::open(&dir.path().join("radar.sqlite")).unwrap();
        assert_eq!(background(&store, "p"), "", "nothing known yet");
        store
            .put_account(
                r#"{"facts":[{"topic":"研究","item":"长期方向","value":"智能体记忆","confidence":0.9,"evidence":3}]}"#,
                0,
            )
            .unwrap();
        store
            .put_profile(
                "p",
                r#"{"topics":[{"name":"长期记忆","keywords":["memory","agents","benchmark","retrieval"],"weight":1}],"categories":["cs.CL"]}"#,
                3,
                0,
            )
            .unwrap();
        let told = background(&store, "p");
        assert!(told.contains("<capsio-user>") && told.contains("研究——长期方向：智能体记忆"));
        assert!(told.contains("这个项目在研究：长期记忆（memory、agents、benchmark）"));
        assert!(!background(&store, "other").contains("<capsio-research>"));
    }

    #[test]
    fn titles_become_file_names_the_library_accepts() {
        assert_eq!(
            file_name("A-MEM: Agentic Memory / LLM?"),
            "A-MEM Agentic Memory LLM.pdf"
        );
        assert_eq!(file_name("  "), "paper.pdf");
    }
}
