//! Everything the recommendations keep, in one SQLite file on this device. Nothing here
//! syncs; clearing the recommendation data deletes the file.

use crate::scholar::Work;
use rusqlite::{params, Connection, OptionalExtension};
use std::path::Path;

const SCHEMA: &str = "
CREATE TABLE IF NOT EXISTS seeds (
    fingerprint TEXT PRIMARY KEY,
    title TEXT NOT NULL,
    summary TEXT NOT NULL,
    checked INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS profiles (
    project TEXT PRIMARY KEY,
    profile TEXT NOT NULL,
    papers INTEGER NOT NULL,
    built INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS works (
    id TEXT PRIMARY KEY,
    work TEXT NOT NULL,
    seen INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS picks (
    project TEXT NOT NULL,
    work TEXT NOT NULL,
    recall REAL NOT NULL,
    stage TEXT NOT NULL,
    score INTEGER,
    title TEXT,
    summary TEXT,
    reason TEXT,
    considered INTEGER NOT NULL,
    PRIMARY KEY (project, work)
);
CREATE TABLE IF NOT EXISTS briefs (
    project TEXT NOT NULL,
    day TEXT NOT NULL,
    items TEXT NOT NULL,
    made INTEGER NOT NULL,
    PRIMARY KEY (project, day)
);
CREATE TABLE IF NOT EXISTS feedback (
    project TEXT NOT NULL,
    work TEXT NOT NULL,
    action TEXT NOT NULL,
    reason TEXT,
    at INTEGER NOT NULL,
    PRIMARY KEY (project, work, action)
);
CREATE TABLE IF NOT EXISTS visits (
    project TEXT PRIMARY KEY,
    at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS fetched (
    project TEXT PRIMARY KEY,
    at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS usage (
    day TEXT NOT NULL,
    project TEXT NOT NULL,
    tokens INTEGER NOT NULL,
    PRIMARY KEY (day, project)
);
CREATE TABLE IF NOT EXISTS status (
    project TEXT PRIMARY KEY,
    state TEXT NOT NULL,
    at INTEGER NOT NULL
);
";

/// How far a paper got for a project.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum Stage {
    /// Too far from the project by text to show the model.
    Dropped,
    /// Close to the project by text; the model has not seen it.
    Recalled,
    /// The model's screening let it through.
    Passed,
    /// The model's screening found it unrelated.
    Blocked,
    /// The model scored it and wrote its title, summary and reason.
    Scored,
}

impl Stage {
    fn name(self) -> &'static str {
        match self {
            Stage::Dropped => "dropped",
            Stage::Recalled => "recalled",
            Stage::Passed => "passed",
            Stage::Blocked => "blocked",
            Stage::Scored => "scored",
        }
    }
}

/// What the user did with a recommended paper.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum Action {
    Opened,
    Later,
    Dismissed,
    Saved,
}

impl Action {
    pub fn parse(name: &str) -> Option<Self> {
        Some(match name {
            "opened" => Action::Opened,
            "later" => Action::Later,
            "dismissed" => Action::Dismissed,
            "saved" => Action::Saved,
            _ => return None,
        })
    }
    pub fn name(self) -> &'static str {
        match self {
            Action::Opened => "opened",
            Action::Later => "later",
            Action::Dismissed => "dismissed",
            Action::Saved => "saved",
        }
    }
}

/// What a library file was found to be.
#[derive(Clone, Debug, PartialEq)]
pub(crate) struct SeedRow {
    pub fingerprint: String,
    pub title: String,
    pub summary: String,
    /// When it was last looked up, in seconds since 1970.
    pub checked: i64,
}

/// A paper considered for a project, with the model's view of it once scored.
#[derive(Clone, Debug)]
pub(crate) struct Pick {
    pub work: Work,
    pub score: Option<i64>,
    pub title: Option<String>,
    pub summary: Option<String>,
    pub reason: Option<String>,
}

pub(crate) struct Store {
    db: Connection,
}

fn err(error: rusqlite::Error) -> String {
    format!("推荐数据读写失败：{error}")
}

impl Store {
    pub fn open(path: &Path) -> Result<Self, String> {
        if let Some(folder) = path.parent() {
            std::fs::create_dir_all(folder).map_err(|e| e.to_string())?;
        }
        let db = Connection::open(path).map_err(err)?;
        // The page reads while the background pass writes.
        db.busy_timeout(std::time::Duration::from_secs(5))
            .map_err(err)?;
        db.execute_batch("PRAGMA journal_mode = WAL;")
            .map_err(err)?;
        db.execute_batch(SCHEMA).map_err(err)?;
        Ok(Self { db })
    }

    // ---------- library ----------

    pub fn seed(&self, fingerprint: &str) -> Result<Option<SeedRow>, String> {
        self.db
            .query_row(
                "SELECT title, summary, checked FROM seeds WHERE fingerprint = ?1",
                [fingerprint],
                |row| {
                    Ok(SeedRow {
                        fingerprint: fingerprint.to_string(),
                        title: row.get(0)?,
                        summary: row.get(1)?,
                        checked: row.get(2)?,
                    })
                },
            )
            .optional()
            .map_err(err)
    }

    pub fn put_seed(&self, seed: &SeedRow) -> Result<(), String> {
        self.db
            .execute(
                "INSERT OR REPLACE INTO seeds (fingerprint, title, summary, checked) VALUES (?1, ?2, ?3, ?4)",
                params![seed.fingerprint, seed.title, seed.summary, seed.checked],
            )
            .map(drop)
            .map_err(err)
    }

    // ---------- research profiles ----------

    /// The profile as saved (JSON), how many library papers it was built from, and when.
    pub fn profile(&self, project: &str) -> Result<Option<(String, usize, i64)>, String> {
        self.db
            .query_row(
                "SELECT profile, papers, built FROM profiles WHERE project = ?1",
                [project],
                |row| Ok((row.get(0)?, row.get::<_, i64>(1)? as usize, row.get(2)?)),
            )
            .optional()
            .map_err(err)
    }

    pub fn put_profile(
        &self,
        project: &str,
        profile: &str,
        papers: usize,
        built: i64,
    ) -> Result<(), String> {
        self.db
            .execute(
                "INSERT OR REPLACE INTO profiles (project, profile, papers, built) VALUES (?1, ?2, ?3, ?4)",
                params![project, profile, papers as i64, built],
            )
            .map(drop)
            .map_err(err)
    }

    // ---------- papers from the sources ----------

    /// Keeps works not seen before; returns how many were new.
    pub fn add_works(&self, works: &[Work], now: i64) -> Result<usize, String> {
        let mut added = 0;
        for work in works {
            let json = serde_json::to_string(work).map_err(|e| e.to_string())?;
            added += self
                .db
                .execute(
                    "INSERT OR IGNORE INTO works (id, work, seen) VALUES (?1, ?2, ?3)",
                    params![work.id, json, now],
                )
                .map_err(err)?;
        }
        Ok(added)
    }

    /// Works first seen at or after `since` that the project has not considered yet.
    pub fn unconsidered(&self, project: &str, since: i64) -> Result<Vec<Work>, String> {
        let mut statement = self
            .db
            .prepare(
                "SELECT work FROM works WHERE seen >= ?2
                 AND id NOT IN (SELECT work FROM picks WHERE project = ?1)",
            )
            .map_err(err)?;
        let rows = statement
            .query_map(params![project, since], |row| row.get::<_, String>(0))
            .map_err(err)?;
        Ok(rows
            .filter_map(Result::ok)
            .filter_map(|json| serde_json::from_str(&json).ok())
            .collect())
    }

    /// The works with these ids that are still kept, in no particular order.
    pub fn works(&self, ids: &[String]) -> Result<Vec<Work>, String> {
        let mut statement = self
            .db
            .prepare("SELECT work FROM works WHERE id = ?1")
            .map_err(err)?;
        let mut works = Vec::new();
        for id in ids {
            let json: Option<String> = statement
                .query_row([id], |row| row.get(0))
                .optional()
                .map_err(err)?;
            works.extend(json.and_then(|json| serde_json::from_str(&json).ok()));
        }
        Ok(works)
    }

    pub fn fetched(&self, project: &str) -> Result<Option<i64>, String> {
        self.db
            .query_row(
                "SELECT at FROM fetched WHERE project = ?1",
                [project],
                |row| row.get(0),
            )
            .optional()
            .map_err(err)
    }

    pub fn mark_fetched(&self, project: &str, at: i64) -> Result<(), String> {
        self.db
            .execute(
                "INSERT OR REPLACE INTO fetched (project, at) VALUES (?1, ?2)",
                params![project, at],
            )
            .map(drop)
            .map_err(err)
    }

    // ---------- picks ----------

    pub fn add_pick(
        &self,
        project: &str,
        work: &str,
        recall: f64,
        stage: Stage,
        now: i64,
    ) -> Result<(), String> {
        self.db
            .execute(
                "INSERT OR IGNORE INTO picks (project, work, recall, stage, considered) VALUES (?1, ?2, ?3, ?4, ?5)",
                params![project, work, recall, stage.name(), now],
            )
            .map(drop)
            .map_err(err)
    }

    /// A project's picks at a stage, best first.
    pub fn picks(&self, project: &str, stage: Stage) -> Result<Vec<Pick>, String> {
        self.query_picks(
            "p.project = ?1 AND p.stage = ?2 ORDER BY COALESCE(p.score, 0) DESC, p.recall DESC",
            params![project, stage.name()],
        )
    }

    /// One scored pick, for the page and for saving it to the library.
    pub fn pick(&self, project: &str, work: &str) -> Result<Option<Pick>, String> {
        Ok(self
            .query_picks(
                "p.project = ?1 AND p.work = ?2 AND p.stage = 'scored'",
                params![project, work],
            )?
            .pop())
    }

    fn query_picks(
        &self,
        filter: &str,
        args: &[&dyn rusqlite::ToSql],
    ) -> Result<Vec<Pick>, String> {
        let mut statement = self
            .db
            .prepare(&format!(
                "SELECT w.work, p.score, p.title, p.summary, p.reason
                 FROM picks p JOIN works w ON w.id = p.work WHERE {filter}"
            ))
            .map_err(err)?;
        let rows = statement
            .query_map(args, |row| {
                Ok((
                    row.get::<_, String>(0)?,
                    row.get::<_, Option<i64>>(1)?,
                    row.get::<_, Option<String>>(2)?,
                    row.get::<_, Option<String>>(3)?,
                    row.get::<_, Option<String>>(4)?,
                ))
            })
            .map_err(err)?;
        Ok(rows
            .filter_map(Result::ok)
            .filter_map(|(json, score, title, summary, reason)| {
                Some(Pick {
                    work: serde_json::from_str(&json).ok()?,
                    score,
                    title,
                    summary,
                    reason,
                })
            })
            .collect())
    }

    pub fn set_stage(&self, project: &str, work: &str, stage: Stage) -> Result<(), String> {
        self.db
            .execute(
                "UPDATE picks SET stage = ?3 WHERE project = ?1 AND work = ?2",
                params![project, work, stage.name()],
            )
            .map(drop)
            .map_err(err)
    }

    pub fn set_scored(
        &self,
        project: &str,
        work: &str,
        score: i64,
        title: &str,
        summary: &str,
        reason: &str,
    ) -> Result<(), String> {
        self.db
            .execute(
                "UPDATE picks SET stage = 'scored', score = ?3, title = ?4, summary = ?5, reason = ?6
                 WHERE project = ?1 AND work = ?2",
                params![project, work, score, title, summary, reason],
            )
            .map(drop)
            .map_err(err)
    }

    // ---------- briefs ----------

    pub fn brief(&self, project: &str, day: &str) -> Result<Option<Vec<String>>, String> {
        let items: Option<String> = self
            .db
            .query_row(
                "SELECT items FROM briefs WHERE project = ?1 AND day = ?2",
                params![project, day],
                |row| row.get(0),
            )
            .optional()
            .map_err(err)?;
        Ok(items.and_then(|json| serde_json::from_str(&json).ok()))
    }

    /// The latest brief: its day and its works in order.
    pub fn latest_brief(&self, project: &str) -> Result<Option<(String, Vec<String>)>, String> {
        let row: Option<(String, String)> = self
            .db
            .query_row(
                "SELECT day, items FROM briefs WHERE project = ?1 ORDER BY day DESC LIMIT 1",
                [project],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )
            .optional()
            .map_err(err)?;
        Ok(row.and_then(|(day, json)| Some((day, serde_json::from_str(&json).ok()?))))
    }

    /// Works in a project's briefs from `since` (a day, `YYYY-MM-DD`) on.
    pub fn briefed_since(&self, project: &str, since: &str) -> Result<Vec<String>, String> {
        let mut statement = self
            .db
            .prepare("SELECT items FROM briefs WHERE project = ?1 AND day >= ?2")
            .map_err(err)?;
        let rows = statement
            .query_map(params![project, since], |row| row.get::<_, String>(0))
            .map_err(err)?;
        Ok(rows
            .filter_map(Result::ok)
            .filter_map(|json| serde_json::from_str::<Vec<String>>(&json).ok())
            .flatten()
            .collect())
    }

    pub fn put_brief(
        &self,
        project: &str,
        day: &str,
        items: &[String],
        now: i64,
    ) -> Result<(), String> {
        let json = serde_json::to_string(items).map_err(|e| e.to_string())?;
        self.db
            .execute(
                "INSERT OR REPLACE INTO briefs (project, day, items, made) VALUES (?1, ?2, ?3, ?4)",
                params![project, day, json, now],
            )
            .map(drop)
            .map_err(err)
    }

    // ---------- feedback ----------

    pub fn record(
        &self,
        project: &str,
        work: &str,
        action: Action,
        reason: Option<&str>,
        now: i64,
    ) -> Result<(), String> {
        self.db
            .execute(
                "INSERT OR REPLACE INTO feedback (project, work, action, reason, at) VALUES (?1, ?2, ?3, ?4, ?5)",
                params![project, work, action.name(), reason, now],
            )
            .map(drop)
            .map_err(err)
    }

    pub fn forget(&self, project: &str, work: &str, action: Action) -> Result<(), String> {
        self.db
            .execute(
                "DELETE FROM feedback WHERE project = ?1 AND work = ?2 AND action = ?3",
                params![project, work, action.name()],
            )
            .map(drop)
            .map_err(err)
    }

    /// Works given this action in a project.
    pub fn with_action(&self, project: &str, action: Action) -> Result<Vec<String>, String> {
        let mut statement = self
            .db
            .prepare(
                "SELECT work FROM feedback WHERE project = ?1 AND action = ?2 ORDER BY at DESC",
            )
            .map_err(err)?;
        let rows = statement
            .query_map(params![project, action.name()], |row| {
                row.get::<_, String>(0)
            })
            .map_err(err)?;
        Ok(rows.filter_map(Result::ok).collect())
    }

    // ---------- activity, usage and status ----------

    pub fn visit(&self, project: &str, now: i64) -> Result<(), String> {
        self.db
            .execute(
                "INSERT OR REPLACE INTO visits (project, at) VALUES (?1, ?2)",
                params![project, now],
            )
            .map(drop)
            .map_err(err)
    }

    /// Projects opened at or after `since`, most recent first.
    pub fn visited_since(&self, since: i64) -> Result<Vec<String>, String> {
        let mut statement = self
            .db
            .prepare("SELECT project FROM visits WHERE at >= ?1 ORDER BY at DESC")
            .map_err(err)?;
        let rows = statement
            .query_map([since], |row| row.get::<_, String>(0))
            .map_err(err)?;
        Ok(rows.filter_map(Result::ok).collect())
    }

    pub fn tokens(&self, day: &str, project: &str) -> Result<i64, String> {
        self.db
            .query_row(
                "SELECT tokens FROM usage WHERE day = ?1 AND project = ?2",
                params![day, project],
                |row| row.get(0),
            )
            .optional()
            .map(|tokens| tokens.unwrap_or(0))
            .map_err(err)
    }

    pub fn spend(&self, day: &str, project: &str, tokens: i64) -> Result<(), String> {
        self.db
            .execute(
                "INSERT INTO usage (day, project, tokens) VALUES (?1, ?2, ?3)
                 ON CONFLICT (day, project) DO UPDATE SET tokens = tokens + ?3",
                params![day, project, tokens],
            )
            .map(drop)
            .map_err(err)
    }

    pub fn status(&self, project: &str) -> Result<Option<String>, String> {
        self.db
            .query_row(
                "SELECT state FROM status WHERE project = ?1",
                [project],
                |row| row.get(0),
            )
            .optional()
            .map_err(err)
    }

    pub fn set_status(&self, project: &str, state: &str, now: i64) -> Result<(), String> {
        self.db
            .execute(
                "INSERT OR REPLACE INTO status (project, state, at) VALUES (?1, ?2, ?3)",
                params![project, state, now],
            )
            .map(drop)
            .map_err(err)
    }

    /// Drops what has aged out: unconsidered works after a month, usage after a quarter.
    pub fn prune(&self, now: i64) -> Result<(), String> {
        let month = now - 30 * 86_400;
        self.db
            .execute(
                "DELETE FROM works WHERE seen < ?1 AND id NOT IN (SELECT work FROM picks WHERE stage = 'scored')",
                [month],
            )
            .map_err(err)?;
        self.db
            .execute(
                "DELETE FROM picks WHERE considered < ?1 AND stage != 'scored'",
                [month],
            )
            .map_err(err)?;
        let quarter = chrono::DateTime::from_timestamp(now - 90 * 86_400, 0)
            .map(|time| time.format("%Y-%m-%d").to_string())
            .unwrap_or_default();
        self.db
            .execute("DELETE FROM usage WHERE day < ?1", [quarter])
            .map(drop)
            .map_err(err)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn work(id: &str) -> Work {
        Work {
            id: id.into(),
            title: format!("Title {id}"),
            ..Work::default()
        }
    }

    #[test]
    fn works_flow_from_recalled_to_scored_and_briefs_remember_them() {
        let dir = tempfile::tempdir().unwrap();
        let store = Store::open(&dir.path().join("radar.sqlite")).unwrap();
        assert_eq!(store.add_works(&[work("a"), work("b")], 100).unwrap(), 2);
        assert_eq!(store.add_works(&[work("a")], 200).unwrap(), 0, "seen once");
        assert_eq!(store.unconsidered("p", 0).unwrap().len(), 2);
        store.add_pick("p", "a", 0.4, Stage::Recalled, 100).unwrap();
        store.add_pick("p", "b", 0.7, Stage::Recalled, 100).unwrap();
        assert!(store.unconsidered("p", 0).unwrap().is_empty());
        assert_eq!(store.unconsidered("q", 0).unwrap().len(), 2, "per project");
        let recalled = store.picks("p", Stage::Recalled).unwrap();
        assert_eq!(recalled[0].work.id, "b", "closest first");
        store
            .set_scored("p", "a", 72, "标题", "一句话", "理由")
            .unwrap();
        store.set_stage("p", "b", Stage::Blocked).unwrap();
        let pick = store.pick("p", "a").unwrap().unwrap();
        assert_eq!(
            (pick.score, pick.title.as_deref()),
            (Some(72), Some("标题"))
        );
        store
            .put_brief("p", "2026-11-25", &["a".into()], 300)
            .unwrap();
        assert_eq!(store.latest_brief("p").unwrap().unwrap().1, ["a"]);
        assert_eq!(store.briefed_since("p", "2026-11-20").unwrap(), ["a"]);
        assert!(store.briefed_since("p", "2026-11-26").unwrap().is_empty());
    }

    #[test]
    fn feedback_usage_and_visits_are_kept_per_project() {
        let dir = tempfile::tempdir().unwrap();
        let store = Store::open(&dir.path().join("radar.sqlite")).unwrap();
        store
            .record("p", "a", Action::Dismissed, Some("unrelated"), 1)
            .unwrap();
        store.record("p", "b", Action::Later, None, 2).unwrap();
        assert_eq!(store.with_action("p", Action::Dismissed).unwrap(), ["a"]);
        store.forget("p", "a", Action::Dismissed).unwrap();
        assert!(store
            .with_action("p", Action::Dismissed)
            .unwrap()
            .is_empty());
        store.spend("2026-11-25", "p", 100).unwrap();
        store.spend("2026-11-25", "p", 50).unwrap();
        assert_eq!(store.tokens("2026-11-25", "p").unwrap(), 150);
        assert_eq!(store.tokens("2026-11-25", "q").unwrap(), 0);
        store.visit("old", 10).unwrap();
        store.visit("new", 20).unwrap();
        assert_eq!(store.visited_since(15).unwrap(), ["new"]);
        assert_eq!(store.visited_since(0).unwrap(), ["new", "old"]);
    }
}
