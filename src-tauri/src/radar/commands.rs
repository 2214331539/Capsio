//! What the recommendations page asks for.

use super::store::{Action, Store};
use super::worker::{self, enabled, folder, open, wake};
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

/// A recommended paper as the page shows it.
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Item {
    pub id: String,
    /// The model's Chinese title.
    pub title: String,
    pub original_title: String,
    pub summary: String,
    pub reason: String,
    pub authors: Vec<String>,
    pub venue: Option<String>,
    pub published: Option<String>,
    pub url: String,
    pub pdf_url: Option<String>,
    /// `saved`, `dismissed` or `later`, when the user did something with it.
    pub state: Option<&'static str>,
}

/// A project's recommendations: the latest brief and what was kept for later.
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct View {
    /// `off`, `needsPapers`, `noModel`, `preparing` or `ready`.
    pub state: &'static str,
    pub day: Option<String>,
    pub items: Vec<Item>,
    pub later: Vec<Item>,
}

pub(super) fn view(store: &Store, project: &str) -> Result<View, String> {
    let marked = |action: Action| store.with_action(project, action);
    let (saved, dismissed, later) = (
        marked(Action::Saved)?,
        marked(Action::Dismissed)?,
        marked(Action::Later)?,
    );
    let item = |id: &str| -> Result<Option<Item>, String> {
        let Some(pick) = store.pick(project, id)? else {
            return Ok(None);
        };
        let state = [
            (Action::Saved, &saved),
            (Action::Dismissed, &dismissed),
            (Action::Later, &later),
        ]
        .into_iter()
        .find(|(_, ids)| ids.iter().any(|other| other == id))
        .map(|(action, _)| action.name());
        let work = pick.work;
        Ok(Some(Item {
            id: work.id,
            title: pick.title.unwrap_or_else(|| work.title.clone()),
            original_title: work.title,
            summary: pick.summary.unwrap_or_default(),
            reason: pick.reason.unwrap_or_default(),
            authors: work.authors.into_iter().take(6).collect(),
            venue: work.venue,
            published: work.published,
            url: work.url,
            pdf_url: work.pdf_url,
            state,
        }))
    };
    let Some((day, ids)) = store.latest_brief(project)? else {
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
        });
    };
    let mut items = Vec::new();
    for id in &ids {
        items.extend(item(id)?);
    }
    let mut kept = Vec::new();
    for id in later
        .iter()
        .filter(|id| !ids.contains(id) && !saved.contains(id) && !dismissed.contains(id))
    {
        kept.extend(item(id)?);
    }
    Ok(View {
        state: "ready",
        day: Some(day),
        items,
        later: kept,
    })
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
    let response = reqwest::Client::builder()
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
    fn titles_become_file_names_the_library_accepts() {
        assert_eq!(
            file_name("A-MEM: Agentic Memory / LLM?"),
            "A-MEM Agentic Memory LLM.pdf"
        );
        assert_eq!(file_name("  "), "paper.pdf");
    }
}
