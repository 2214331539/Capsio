//! The background work: a thread that runs a pass over the followed projects every half
//! hour, the real sources and model it runs with, and the folder it keeps its data in.

use super::library::{Hint, Paper};
use super::sources::{Query, Source};
use super::store::Store;
use super::{account, highlights, run_project, Clock, Outside, State, NO_MODEL};
use crate::ai::TextModel;
use crate::library::LibraryState;
use crate::scholar::Work;
use crate::AppState;
use serde_json::json;
use std::path::PathBuf;
use std::sync::{mpsc, Mutex};
use std::time::{Duration, Instant};
use tauri::{Emitter, Manager};

/// The first pass waits for the app to settle; a project being opened brings it forward.
const FIRST: Duration = Duration::from_secs(90);
const PASS: Duration = Duration::from_secs(30 * 60);
/// Passes are at least this far apart, however often projects are opened.
const GAP: Duration = Duration::from_secs(2 * 60);
/// Projects opened within this many days are followed.
const ACTIVE_DAYS: i64 = 7;

/// arXiv asks for at most one request every three seconds.
const ARXIV_SPACING: Duration = Duration::from_secs(3);
/// Feeds are small; anything larger is not one.
const FEED_LIMIT: usize = 8 * 1024 * 1024;
/// Some sites turn away clients that do not look like a browser or a feed reader.
const FEED_AGENT: &str = "Mozilla/5.0 (compatible; Capsio/1.0; +https://capsio.cloud)";
/// A model call that fails for a passing reason is tried again after each of these waits,
/// so one dropped connection does not end the pass.
const MODEL_RETRIES: [Duration; 2] = [Duration::from_secs(5), Duration::from_secs(20)];

pub(super) struct Live {
    model: Option<TextModel>,
    last_arxiv: Mutex<Option<Instant>>,
    /// The official-model token the server refused during this pass.
    refused: Mutex<Option<String>>,
}

impl Live {
    pub(super) fn new(model: Option<TextModel>) -> Self {
        Self {
            model,
            last_arxiv: Mutex::new(None),
            refused: Mutex::new(None),
        }
    }

    fn arxiv_turn(&self) {
        let mut last = self
            .last_arxiv
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        if let Some(wait) = last.and_then(|at| ARXIV_SPACING.checked_sub(at.elapsed())) {
            std::thread::sleep(wait);
        }
        *last = Some(Instant::now());
    }
}

impl Outside for Live {
    fn search(&self, query: &Query) -> Result<Vec<Work>, String> {
        match query.source {
            Source::Arxiv => {
                self.arxiv_turn();
                tauri::async_runtime::block_on(crate::scholar::arxiv_newest(&query.text, 50))
            }
            Source::OpenAlex => tauri::async_runtime::block_on(crate::scholar::openalex_search(
                &query.text,
                Some(&query.since),
                25,
            )),
        }
    }

    fn identify(&self, hint: &Hint) -> Result<Option<Work>, String> {
        if let Some(id) = &hint.arxiv {
            self.arxiv_turn();
            return tauri::async_runtime::block_on(crate::scholar::arxiv_ids(&[id]))
                .map(|works| works.into_iter().next());
        }
        if let Some(doi) = &hint.doi {
            if let Some(work) = tauri::async_runtime::block_on(crate::scholar::openalex_doi(doi))? {
                return Ok(Some(work));
            }
        }
        if hint.title.is_empty() {
            return Ok(None);
        }
        tauri::async_runtime::block_on(crate::scholar::openalex_title(&hint.title))
    }

    fn has_model(&self) -> bool {
        self.model.is_some()
    }

    fn ask(&self, system: &str, user: &str, max_tokens: u32) -> Result<crate::ai::Answer, String> {
        let model = self.model.as_ref().ok_or(NO_MODEL)?;
        let mut waits = MODEL_RETRIES.iter();
        let answer = loop {
            let answer =
                tauri::async_runtime::block_on(crate::ai::ask(model, system, user, max_tokens));
            match (&answer, waits.next()) {
                (Err(error), Some(wait)) if crate::ai::transient(error) => {
                    std::thread::sleep(*wait)
                }
                _ => break answer,
            }
        };
        if model.official && answer.as_ref().is_err_and(|error| error.contains("401")) {
            *self
                .refused
                .lock()
                .unwrap_or_else(|poisoned| poisoned.into_inner()) = Some(model.api_key.clone());
        }
        answer
    }

    fn feed(&self, url: &str) -> Result<String, String> {
        tauri::async_runtime::block_on(read_feed(url))
    }
}

async fn read_feed(url: &str) -> Result<String, String> {
    let response = reqwest::Client::builder()
        .user_agent(FEED_AGENT)
        .connect_timeout(Duration::from_secs(8))
        // Some feed servers are slow: one takes 25 seconds for 400 KB.
        .timeout(Duration::from_secs(45))
        .build()
        .map_err(|e| e.to_string())?
        .get(url)
        .send()
        .await
        .map_err(|e| e.to_string())?;
    if !response.status().is_success() {
        return Err(format!("HTTP {}", response.status().as_u16()));
    }
    if response
        .content_length()
        .is_some_and(|size| size as usize > FEED_LIMIT)
    {
        return Err("文件过大".into());
    }
    let bytes = response.bytes().await.map_err(|e| e.to_string())?;
    if bytes.len() > FEED_LIMIT {
        return Err("文件过大".into());
    }
    Ok(String::from_utf8_lossy(&bytes).into_owned())
}

#[derive(Default)]
pub struct RadarState {
    wake: Mutex<Option<mpsc::Sender<()>>>,
    /// Held by a pass; clearing the data waits for it.
    running: Mutex<()>,
    stale: Mutex<Option<String>>,
}

pub(super) fn folder<R: tauri::Runtime>(app: &tauri::AppHandle<R>) -> PathBuf {
    app.state::<crate::data_location::DataLocation>()
        .container
        .join("radar")
}

pub(super) fn open<R: tauri::Runtime>(app: &tauri::AppHandle<R>) -> Result<Store, String> {
    Store::open(&folder(app).join("radar.sqlite"))
}

/// Why passes went wrong, kept for diagnosis; nobody is shown it.
fn log<R: tauri::Runtime>(app: &tauri::AppHandle<R>, line: &str) {
    use std::io::Write;
    let path = folder(app).join("radar.log");
    if std::fs::metadata(&path).is_ok_and(|meta| meta.len() > 256 * 1024) {
        let _ = std::fs::remove_file(&path);
    }
    let _ = std::fs::create_dir_all(folder(app));
    if let Ok(mut file) = std::fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(&path)
    {
        let _ = writeln!(
            file,
            "{} {line}",
            chrono::Local::now().format("%Y-%m-%d %H:%M:%S")
        );
    }
}

/// Recommendations are on unless the user turned them off in Settings.
pub(super) fn enabled<R: tauri::Runtime>(app: &tauri::AppHandle<R>) -> bool {
    app.state::<AppState>()
        .storage
        .load()
        .ok()
        .flatten()
        .is_some_and(|data| data["settings"]["recommendations"] != false)
}

pub(super) fn wake<R: tauri::Runtime>(app: &tauri::AppHandle<R>) {
    if let Some(sender) = app
        .state::<RadarState>()
        .wake
        .lock()
        .ok()
        .and_then(|wake| wake.clone())
    {
        let _ = sender.send(());
    }
}

/// Deletes everything kept on this device, once any pass running has finished.
pub(super) fn clear<R: tauri::Runtime>(app: &tauri::AppHandle<R>) -> Result<(), String> {
    let radar = app.state::<RadarState>();
    let _running = radar.running.lock().map_err(|e| e.to_string())?;
    match std::fs::remove_dir_all(folder(app)) {
        Err(error) if error.kind() != std::io::ErrorKind::NotFound => Err(error.to_string()),
        _ => Ok(()),
    }
}

pub fn start<R: tauri::Runtime>(app: &tauri::AppHandle<R>) {
    let (sender, receiver) = mpsc::channel();
    if let Ok(mut wake) = app.state::<RadarState>().wake.lock() {
        *wake = Some(sender);
    }
    let app = app.clone();
    std::thread::spawn(move || {
        let _ = receiver.recv_timeout(FIRST);
        loop {
            let started = Instant::now();
            if let Err(error) = pass(&app) {
                log(&app, &error);
            }
            let _ = receiver.recv_timeout(PASS);
            while receiver.try_recv().is_ok() {}
            if let Some(rest) = GAP.checked_sub(started.elapsed()) {
                std::thread::sleep(rest);
            }
        }
    });
}

fn pass<R: tauri::Runtime>(app: &tauri::AppHandle<R>) -> Result<(), String> {
    let radar = app.state::<RadarState>();
    let _running = radar.running.lock().map_err(|e| e.to_string())?;
    if !enabled(app) {
        return Ok(());
    }
    let clock = Clock::local();
    let store = open(app)?;
    store.prune(clock.now)?;
    let stale = radar.stale.lock().map_err(|e| e.to_string())?.take();
    let live = Live::new(crate::ai::background_model(app, stale.as_deref()).ok());
    let workspace = app.state::<AppState>().storage.load()?.unwrap_or_default();
    // What the account profile says about the user, as the screening and scoring read it.
    let about = account::saved(&store)?
        .map(|account| account.summary(600))
        .unwrap_or_default();
    for project in store.visited_since(clock.now - ACTIVE_DAYS * 86_400)? {
        let open_project = workspace["projects"]
            .as_array()
            .into_iter()
            .flatten()
            .any(|item| item["id"] == project.as_str() && item["archived"] != true);
        if !open_project {
            continue;
        }
        let papers = match app
            .state::<LibraryState>()
            .service
            .papers_for_reading(&project)
        {
            Ok(Some(papers)) => papers,
            Ok(None) => {
                store.set_status(&project, State::NeedsPapers.name(), clock.now)?;
                continue;
            }
            Err(error) => {
                log(app, &format!("{project}: {error}"));
                continue;
            }
        };
        let papers: Vec<Paper> = papers.into_iter().map(Paper::from).collect();
        match run_project(&store, &live, &project, &papers, &about, &clock) {
            Ok(outcome) => {
                if let Some(warning) = outcome.warning {
                    log(app, &format!("{project}: {warning}"));
                }
                if let Some(count) = outcome.brief {
                    let _ = app.emit(
                        "radar-brief",
                        json!({"projectId": project, "day": clock.day, "count": count}),
                    );
                }
            }
            Err(error) => log(app, &format!("{project}: {error}")),
        }
    }
    // The account profile learns from what the projects found, then the day's highlights.
    if live.has_model() {
        match account::refresh(&store, &live, &clock) {
            Ok(Some(account)) => {
                if let Err(error) = highlights::make(&store, &live, &account, &clock) {
                    log(app, &format!("highlights: {error}"));
                }
            }
            Ok(None) => {}
            Err(error) => log(app, &format!("account: {error}")),
        }
    }
    if let Some(token) = live.refused.into_inner().unwrap_or_default() {
        *radar.stale.lock().map_err(|e| e.to_string())? = Some(token);
    }
    Ok(())
}
