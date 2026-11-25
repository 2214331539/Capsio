//! The model's part: screen what recall kept loosely, score the rest on five measures and
//! write each one's Chinese title, summary and reason, then score the borderline ones again.
//! The screening and the five measures follow AIHOT's selection (MIT, github.com/KKKKhazix/
//! AIHOT), with its audience-wide "resonance" replaced by closeness to this project. Papers,
//! news and blog posts are weighed differently; the model is told what each is, never its
//! source, so a name does not sway the score.

use super::library::Seed;
use super::profile::Profile;
use super::store::{Pick, Stage, Store};
use super::Outside;
use crate::scholar::Kind;
use serde::de::DeserializeOwned;
use serde::Deserialize;
use serde_json::json;

const SCREEN: &str = include_str!("prompts/screen.md");
const SCORE: &str = include_str!("prompts/score.md");
const SCREEN_BATCH: usize = 20;
const SCORE_BATCH: usize = 8;
/// Room for the answers, and for the thoughts of models that think before answering,
/// which would otherwise use up a tight limit and leave the answer empty.
const SCREEN_TOKENS: u32 = 8192;
const SCORE_TOKENS: u32 = 8192;
/// What a work must score (of 100) to be recommended: a little more for news and blog posts,
/// which are many and quickly dated (AIHOT's thresholds start at 60 and 65).
pub(crate) fn threshold(kind: Kind) -> i64 {
    match kind {
        Kind::Paper => 60,
        Kind::News | Kind::Blog => 65,
    }
}
/// Scores this close to the threshold are checked with a second, independent scoring.
const REVIEW_BAND: i64 = 8;
/// What a project's model calls may use per day, in tokens as the provider counts them.
/// A full first pass takes about 27k with a thinking model.
pub(crate) const DAILY_TOKENS: i64 = 50_000;
/// The error a call over the day's budget fails with: not a fault, just enough for today.
pub(crate) const SPENT: &str = "今天的推荐额度已用完。";

/// The model calls one project may still make today; each call is counted as it is made.
pub(crate) struct Budget<'a> {
    store: &'a Store,
    project: &'a str,
    day: &'a str,
    left: i64,
}

impl<'a> Budget<'a> {
    pub fn today(store: &'a Store, project: &'a str, day: &'a str) -> Result<Self, String> {
        let left = DAILY_TOKENS - store.tokens(day, project)?;
        Ok(Self {
            store,
            project,
            day,
            left,
        })
    }

    pub fn ask(
        &mut self,
        outside: &dyn Outside,
        system: &str,
        user: &str,
        max_tokens: u32,
    ) -> Result<String, String> {
        // Asked while what is sent still fits today; what the call used, as the service
        // reports it (thinking included) or else as estimated, is counted after.
        let sent = tokens(system) + tokens(user);
        if self.left < sent {
            return Err(SPENT.into());
        }
        let answer = outside.ask(system, user, max_tokens)?;
        let spent = answer.tokens.unwrap_or_else(|| sent + tokens(&answer.text));
        self.left -= spent;
        self.store.spend(self.day, self.project, spent)?;
        Ok(answer.text)
    }
}

/// Roughly: English runs about four characters to a token, Chinese one or two.
fn tokens(text: &str) -> i64 {
    (text.chars().count() as i64 + 2) / 3
}

/// The first JSON value in a model's answer, ignoring code fences and chatter around it.
pub(crate) fn json_in<T: DeserializeOwned>(answer: &str) -> Option<T> {
    let start = answer.find(['[', '{'])?;
    let close = if answer[start..].starts_with('[') {
        ']'
    } else {
        '}'
    };
    let end = answer.rfind(close)?;
    serde_json::from_str(answer.get(start..=end)?).ok()
}

/// What the model is told about the project: its topics and a few of its papers, which
/// reasons may point to.
fn context(profile: &Profile, seeds: &[Seed]) -> String {
    let topics = profile
        .topics
        .iter()
        .map(|topic| format!("- {}（{}）", topic.name, topic.keywords.join("、")))
        .collect::<Vec<_>>()
        .join("\n");
    let mut newest: Vec<&Seed> = seeds.iter().collect();
    newest.sort_by_key(|seed| std::cmp::Reverse(seed.added));
    let papers = newest
        .iter()
        .take(15)
        .map(|seed| format!("- {}", seed.title))
        .collect::<Vec<_>>()
        .join("\n");
    format!("这个项目在研究：\n{topics}\n\n项目文献库里的部分论文：\n{papers}")
}

fn items(picks: &[Pick], summary_chars: usize) -> String {
    let list: Vec<_> = picks
        .iter()
        .enumerate()
        .map(|(id, pick)| {
            json!({
                "id": id,
                "type": match pick.work.kind {
                    Kind::Paper => "论文",
                    Kind::News => "新闻",
                    Kind::Blog => "博客",
                },
                "title": pick.work.title,
                "abstract": pick.work.summary.chars().take(summary_chars).collect::<String>(),
            })
        })
        .collect();
    serde_json::to_string_pretty(&list).unwrap_or_default()
}

/// What waits at a stage, news and blog posts first: they are stale in two days, while papers
/// keep for a week, so on a day the budget runs short it is papers that wait for tomorrow.
fn queue(store: &Store, project: &str, stage: Stage) -> Result<Vec<Pick>, String> {
    let mut waiting = store.picks(project, stage)?;
    waiting.sort_by_key(|pick| pick.work.kind == Kind::Paper);
    Ok(waiting)
}

/// Screens, then scores, what the project has waiting. Stops quietly at the day's budget.
pub(crate) fn run(
    store: &Store,
    outside: &dyn Outside,
    budget: &mut Budget,
    project: &str,
    profile: &Profile,
    seeds: &[Seed],
) -> Result<(), String> {
    let context = context(profile, seeds);
    let outcome = screen(store, outside, budget, project, &context)
        .and_then(|()| score(store, outside, budget, project, &context));
    match outcome {
        Err(error) if error == SPENT => Ok(()),
        other => other,
    }
}

#[derive(Deserialize)]
struct Verdict {
    id: usize,
    verdict: String,
}

/// Lets through anything plausibly related, as AIHOT's prefilter does: only clearly unrelated
/// work is blocked; whatever the answer leaves out goes on, and so does a batch that got no
/// answer at all, so one failed call neither stops the pass nor costs the same call next pass.
fn screen(
    store: &Store,
    outside: &dyn Outside,
    budget: &mut Budget,
    project: &str,
    context: &str,
) -> Result<(), String> {
    let waiting = queue(store, project, Stage::Recalled)?;
    for batch in waiting.chunks(SCREEN_BATCH) {
        let answer = match budget.ask(
            outside,
            SCREEN,
            &format!("{context}\n\n候选内容：\n{}", items(batch, 500)),
            SCREEN_TOKENS,
        ) {
            Ok(answer) => answer,
            Err(error) if error == SPENT => return Err(error),
            Err(_) => String::new(),
        };
        let blocked: Vec<usize> = json_in::<Vec<Verdict>>(&answer)
            .unwrap_or_default()
            .into_iter()
            .filter(|verdict| verdict.verdict == "block")
            .map(|verdict| verdict.id)
            .collect();
        for (id, pick) in batch.iter().enumerate() {
            let stage = if blocked.contains(&id) {
                Stage::Blocked
            } else {
                Stage::Passed
            };
            store.set_stage(project, &pick.work.id, stage)?;
        }
    }
    Ok(())
}

#[derive(Clone, Deserialize)]
struct Grade {
    id: usize,
    #[serde(default)]
    rel: f64,
    #[serde(default)]
    sig: f64,
    #[serde(default)]
    nov: f64,
    #[serde(default)]
    cred: f64,
    #[serde(default, rename = "use")]
    usable: f64,
    #[serde(default)]
    title: String,
    #[serde(default)]
    summary: String,
    #[serde(default)]
    reason: String,
}

impl Grade {
    /// 0–100. Papers: closeness 4, substance 3, novelty 2, evidence 1. News and blog posts:
    /// closeness 4, substance 2, novelty 2, evidence 1, of use right away 1. (AIHOT weighs
    /// papers 5/3/1/0/1; here closeness to the project takes the lead.)
    fn score(&self, kind: Kind) -> i64 {
        let measure = |value: f64| value.clamp(0.0, 10.0);
        let weights = match kind {
            Kind::Paper => [4.0, 3.0, 2.0, 1.0, 0.0],
            Kind::News | Kind::Blog => [4.0, 2.0, 2.0, 1.0, 1.0],
        };
        [self.rel, self.sig, self.nov, self.cred, self.usable]
            .into_iter()
            .zip(weights)
            .map(|(value, weight)| weight * measure(value))
            .sum::<f64>()
            .round() as i64
    }
}

fn grades(
    outside: &dyn Outside,
    budget: &mut Budget,
    batch: &[Pick],
    context: &str,
) -> Result<Vec<Option<Grade>>, String> {
    let answer = budget.ask(
        outside,
        SCORE,
        &format!("{context}\n\n新内容：\n{}", items(batch, 1200)),
        SCORE_TOKENS,
    )?;
    let mut graded: Vec<Option<Grade>> = vec![None; batch.len()];
    for grade in json_in::<Vec<Grade>>(&answer).unwrap_or_default() {
        if let Some(slot) = graded.get_mut(grade.id) {
            *slot = Some(grade);
        }
    }
    Ok(graded)
}

/// Scores what passed screening; those near their threshold are scored once more and the two
/// scores averaged, so one lenient or harsh reading does not decide them.
fn score(
    store: &Store,
    outside: &dyn Outside,
    budget: &mut Budget,
    project: &str,
    context: &str,
) -> Result<(), String> {
    let waiting = queue(store, project, Stage::Passed)?;
    for batch in waiting.chunks(SCORE_BATCH) {
        let first = grades(outside, budget, batch, context)?;
        let borderline: Vec<Pick> = batch
            .iter()
            .zip(&first)
            .filter(|(pick, grade)| {
                let kind = pick.work.kind;
                grade
                    .as_ref()
                    .is_some_and(|grade| (grade.score(kind) - threshold(kind)).abs() <= REVIEW_BAND)
            })
            .map(|(pick, _)| pick.clone())
            .collect();
        let second = if borderline.is_empty() {
            Vec::new()
        } else {
            grades(outside, budget, &borderline, context)?
        };
        for (pick, grade) in batch.iter().zip(first) {
            // Left out of the answer: tried again next pass.
            let Some(grade) = grade else { continue };
            let again = borderline
                .iter()
                .position(|other| other.work.id == pick.work.id)
                .and_then(|index| second.get(index).cloned().flatten());
            let kind = pick.work.kind;
            let score = again.map_or(grade.score(kind), |again| {
                (grade.score(kind) + again.score(kind)) / 2
            });
            let title = if grade.title.trim().is_empty() {
                pick.work.title.clone()
            } else {
                grade.title.trim().to_string()
            };
            store.set_scored(
                project,
                &pick.work.id,
                score,
                &title,
                grade.summary.trim(),
                grade.reason.trim(),
            )?;
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::super::tests::{project_store, Fake};
    use super::*;

    #[test]
    fn json_is_found_in_fenced_or_chatty_answers() {
        let fenced = "好的：\n```json\n[{\"id\":0,\"verdict\":\"pass\"}]\n```";
        let verdicts: Vec<Verdict> = json_in(fenced).unwrap();
        assert_eq!((verdicts[0].id, verdicts[0].verdict.as_str()), (0, "pass"));
        assert!(json_in::<Vec<Verdict>>("没有 JSON").is_none());
        let profile: Profile = json_in("{\"topics\":[],\"categories\":[\"cs.CL\"]} 以上").unwrap();
        assert_eq!(profile.categories, ["cs.CL"]);
    }

    #[test]
    fn grades_weigh_closeness_most() {
        let grade = |rel: f64| Grade {
            id: 0,
            rel,
            sig: 6.0,
            nov: 6.0,
            cred: 6.0,
            usable: 10.0,
            title: String::new(),
            summary: String::new(),
            reason: String::new(),
        };
        assert_eq!(grade(9.0).score(Kind::Paper), 36 + 18 + 12 + 6);
        assert!(grade(9.0).score(Kind::Paper) - grade(3.0).score(Kind::Paper) >= 20);
        assert_eq!(
            grade(30.0).score(Kind::Paper),
            grade(10.0).score(Kind::Paper),
            "measures are capped at 10"
        );
        // A post weighs substance less and counts whether it can be used right away.
        assert_eq!(grade(9.0).score(Kind::News), 36 + 12 + 12 + 6 + 10);
        assert!(threshold(Kind::Blog) > threshold(Kind::Paper));
    }

    #[test]
    fn screening_blocks_the_unrelated_and_borderline_papers_are_scored_twice() {
        let (_dir, store) = project_store(&["near", "far", "edge"]);
        let outside = Fake::default();
        outside.answers.borrow_mut().extend([
            r#"[{"id":0,"verdict":"pass"},{"id":1,"verdict":"block"}]"#.to_string(),
            r#"[{"id":0,"rel":9,"sig":8,"nov":8,"cred":8,"title":"近","summary":"做了 A","reason":"和记忆相关"},
               {"id":1,"rel":6,"sig":6,"nov":6,"cred":6,"title":"边","summary":"做了 B","reason":"沾边"}]"#
                .to_string(),
            r#"[{"id":0,"rel":7,"sig":7,"nov":7,"cred":7,"title":"边","summary":"做了 B","reason":"沾边"}]"#.to_string(),
        ]);
        let mut budget = Budget::today(&store, "p", "2026-11-25").unwrap();
        run(&store, &outside, &mut budget, "p", &Profile::default(), &[]).unwrap();
        let scored = store.picks("p", Stage::Scored).unwrap();
        let score_of = |id: &str| {
            scored
                .iter()
                .find(|pick| pick.work.id == id)
                .and_then(|pick| pick.score)
        };
        assert_eq!(score_of("near"), Some(84));
        assert_eq!(
            score_of("edge"),
            Some((60 + 70) / 2),
            "the second reading is averaged in"
        );
        assert_eq!(store.picks("p", Stage::Blocked).unwrap()[0].work.id, "far");
        assert!(
            store.tokens("2026-11-25", "p").unwrap() > 0,
            "calls are counted"
        );
    }

    #[test]
    fn a_screening_call_without_an_answer_lets_its_batch_through() {
        let (_dir, store) = project_store(&["a", "b"]);
        // The model has nothing to say to the screening; scoring then fails too.
        let outside = Fake::default();
        let mut budget = Budget::today(&store, "p", "2026-11-25").unwrap();
        let outcome = run(&store, &outside, &mut budget, "p", &Profile::default(), &[]);
        assert!(outcome.is_err(), "scoring still needs an answer");
        assert_eq!(store.picks("p", Stage::Passed).unwrap().len(), 2);
    }

    #[test]
    fn news_and_blog_posts_are_judged_before_papers() {
        let (_dir, store) = project_store(&["paper", "post"]);
        store
            .add_works(
                &[crate::scholar::Work {
                    id: "news".into(),
                    kind: Kind::News,
                    ..Default::default()
                }],
                0,
            )
            .unwrap();
        store
            .add_pick("p", "news", 0.01, Stage::Recalled, 0)
            .unwrap();
        let order: Vec<String> = queue(&store, "p", Stage::Recalled)
            .unwrap()
            .into_iter()
            .map(|pick| pick.work.id)
            .collect();
        assert_eq!(
            order,
            ["news", "paper", "post"],
            "papers keep their order after it"
        );
    }

    #[test]
    fn the_daily_budget_stops_calls_quietly() {
        let (_dir, store) = project_store(&["a"]);
        store.spend("2026-11-25", "p", DAILY_TOKENS).unwrap();
        let outside = Fake::default();
        let mut budget = Budget::today(&store, "p", "2026-11-25").unwrap();
        run(&store, &outside, &mut budget, "p", &Profile::default(), &[]).unwrap();
        assert!(outside.questions.borrow().is_empty());
        assert_eq!(
            store.picks("p", Stage::Recalled).unwrap().len(),
            1,
            "waits for tomorrow"
        );
    }
}
