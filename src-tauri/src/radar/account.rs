//! Who the user is across projects, never shown to them. The shape follows Memobase's profiles
//! (Apache-2.0, ideas only, github.com/memodb-io/memobase): fixed topics and items, each fact
//! with how sure it is and how much supports it. Built from every followed project's research
//! profile, the questions put to the assistant and what the user did with recommendations;
//! rebuilt at most once a day, and only when there is something new. The screening and scoring,
//! the field highlights and the assistant read its summary.

use super::judge::{json_in, Budget, SPENT};
use super::profile::Profile;
use super::store::Store;
use super::{Clock, Outside};
use serde::{Deserialize, Serialize};

const PROMPT: &str = include_str!("prompts/account.md");
const ANSWER_TOKENS: u32 = 8192;
/// The account's model calls are counted on their own, apart from every project's.
pub(crate) const BUDGET_KEY: &str = "~account";
/// The profile is rebuilt at most this often.
const EVERY: i64 = 86_400;
/// Questions and actions read per rebuild, newest first.
const QUESTIONS: usize = 40;
const ACTIONS: usize = 40;
/// Facts kept per item: the most certain.
const PER_ITEM: usize = 3;
/// Facts less certain than this stay out of the summaries.
const SURE: f64 = 0.4;

/// The topics and their items, in the order summaries list them.
const TOPICS: &[(&str, &[&str])] = &[
    ("研究", &["长期方向", "方法", "工具"]),
    ("基本", &["身份阶段", "学科"]),
    ("关注", &["作者", "机构", "会议期刊"]),
    ("投稿", &["目标会议"]),
    ("阅读偏好", &["语言", "内容类型"]),
    ("不想看", &["主题", "来源"]),
];

#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
pub(crate) struct Account {
    #[serde(default)]
    pub facts: Vec<Fact>,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub(crate) struct Fact {
    pub topic: String,
    pub item: String,
    pub value: String,
    #[serde(default)]
    pub confidence: f64,
    /// How many questions, papers or actions support it.
    #[serde(default)]
    pub evidence: u32,
}

impl Account {
    /// Only known topics and items, short values, at most a few per item, most certain first.
    fn checked(self) -> Self {
        let mut facts: Vec<Fact> = Vec::new();
        for mut fact in self.facts {
            fact.value = fact.value.trim().chars().take(40).collect();
            fact.confidence = fact.confidence.clamp(0.0, 1.0);
            let known = TOPICS
                .iter()
                .any(|(topic, items)| *topic == fact.topic && items.contains(&fact.item.as_str()));
            let repeated = facts.iter().any(|other| {
                other.topic == fact.topic && other.item == fact.item && other.value == fact.value
            });
            if known && !fact.value.is_empty() && !repeated {
                facts.push(fact);
            }
        }
        facts.sort_by(|a, b| b.confidence.total_cmp(&a.confidence));
        let mut kept: Vec<Fact> = Vec::new();
        for fact in facts {
            let same = kept
                .iter()
                .filter(|other| other.topic == fact.topic && other.item == fact.item)
                .count();
            if same < PER_ITEM {
                kept.push(fact);
            }
        }
        Self { facts: kept }
    }

    /// The authors the user follows, by name as papers list them.
    pub fn followed(&self) -> Vec<String> {
        self.facts
            .iter()
            .filter(|f| f.topic == "关注" && f.item == "作者" && f.confidence >= SURE)
            .map(|f| f.value.clone())
            .collect()
    }

    /// One line per topic, its items and their surest values, cut to `limit` characters at a
    /// line's end.
    pub fn summary(&self, limit: usize) -> String {
        let mut lines = Vec::new();
        for (topic, items) in TOPICS {
            let parts: Vec<String> = items
                .iter()
                .filter_map(|item| {
                    let values: Vec<&str> = self
                        .facts
                        .iter()
                        .filter(|f| f.topic == *topic && f.item == *item && f.confidence >= SURE)
                        .map(|f| f.value.as_str())
                        .collect();
                    (!values.is_empty()).then(|| format!("{item}：{}", values.join("、")))
                })
                .collect();
            if !parts.is_empty() {
                lines.push(format!("{topic}——{}", parts.join("；")));
            }
        }
        let mut summary = String::new();
        for line in lines {
            if summary.chars().count() + line.chars().count() + 1 > limit {
                break;
            }
            if !summary.is_empty() {
                summary.push('\n');
            }
            summary.push_str(&line);
        }
        summary
    }
}

/// The saved profile, as last built.
pub(crate) fn saved(store: &Store) -> Result<Option<Account>, String> {
    Ok(store
        .account()?
        .and_then(|(json, _)| serde_json::from_str::<Account>(&json).ok())
        .map(Account::checked))
}

/// Rebuilds the profile when a day has passed and there is new evidence; otherwise, or when
/// the day's budget is spent, the saved one stands.
pub(crate) fn refresh(
    store: &Store,
    outside: &dyn Outside,
    clock: &Clock,
) -> Result<Option<Account>, String> {
    let stored = store.account()?;
    let current = saved(store)?;
    let since = stored.as_ref().map_or(0, |(_, built)| *built);
    if stored.is_some() && clock.now - since < EVERY {
        return Ok(current);
    }
    let questions = store.signals_since("question", since, QUESTIONS)?;
    let actions = store.feedback_since(since, ACTIONS)?;
    let projects: Vec<Profile> = store
        .all_profiles()?
        .iter()
        .filter_map(|json| serde_json::from_str(json).ok())
        .collect();
    if projects.is_empty() || (current.is_some() && questions.is_empty() && actions.is_empty()) {
        return Ok(current);
    }
    let mut budget = Budget::today(store, BUDGET_KEY, &clock.day)?;
    let request = request(current.as_ref(), &projects, &questions, &actions);
    let answer = match budget.ask(outside, PROMPT, &request, ANSWER_TOKENS) {
        Ok(answer) => answer,
        Err(error) if error == SPENT => return Ok(current),
        Err(error) => return Err(error),
    };
    // An answer that is not a profile keeps the old one until tomorrow, rather than asking
    // again every pass.
    let next = json_in::<Account>(&answer)
        .map(Account::checked)
        .or(current)
        .unwrap_or_default();
    store.put_account(
        &serde_json::to_string(&next).map_err(|e| e.to_string())?,
        clock.now,
    )?;
    Ok(Some(next))
}

fn request(
    current: Option<&Account>,
    projects: &[Profile],
    questions: &[String],
    actions: &[(String, Option<String>, String)],
) -> String {
    let profile = current
        .map(|account| serde_json::to_string(account).unwrap_or_default())
        .unwrap_or_else(|| "（还没有）".into());
    let projects = projects
        .iter()
        .enumerate()
        .map(|(n, profile)| {
            let topics: Vec<String> = profile
                .topics
                .iter()
                .map(|topic| format!("{}（{}）", topic.name, topic.keywords.join("、")))
                .collect();
            format!("- 项目 {}：{}", n + 1, topics.join("；"))
        })
        .collect::<Vec<_>>()
        .join("\n");
    let list = |lines: Vec<String>| {
        if lines.is_empty() {
            "（没有）".to_string()
        } else {
            lines.join("\n")
        }
    };
    let questions = list(questions.iter().map(|q| format!("- {q}")).collect());
    let actions = list(
        actions
            .iter()
            .map(|(action, reason, title)| {
                let what = match action.as_str() {
                    "saved" => "加入文献库".to_string(),
                    "later" => "稍后读".to_string(),
                    _ => format!(
                        "不感兴趣{}",
                        match reason.as_deref() {
                            Some("unrelated") => "（不相关）",
                            Some("weak") => "（质量一般）",
                            Some("seen") => "（看过了）",
                            _ => "",
                        }
                    ),
                };
                format!("- {what}：{title}")
            })
            .collect(),
    );
    format!(
        "现在的画像（JSON）：\n{profile}\n\n各项目的研究方向：\n{projects}\n\n\
         最近向 AI 助手提的问题（只有用户的话）：\n{questions}\n\n最近对推荐的操作：\n{actions}"
    )
}

#[cfg(test)]
mod tests {
    use super::super::profile::Topic;
    use super::super::tests::{clock, Fake};
    use super::*;

    fn fact(topic: &str, item: &str, value: &str, confidence: f64) -> Fact {
        Fact {
            topic: topic.into(),
            item: item.into(),
            value: value.into(),
            confidence,
            evidence: 1,
        }
    }

    #[test]
    fn a_profile_keeps_known_items_and_the_surest_values() {
        let account = Account {
            facts: vec![
                fact("研究", "长期方向", "智能体记忆", 0.9),
                fact("研究", "长期方向", "长上下文", 0.7),
                fact("研究", "长期方向", "检索增强", 0.6),
                fact("研究", "长期方向", "多模态", 0.5),
                fact("研究", "长期方向", "智能体记忆", 0.8),
                fact("研究", "爱好", "登山", 0.9),
                fact("不想看", "主题", "加密货币", 0.8),
                fact("关注", "作者", "某作者", 0.2),
            ],
        }
        .checked();
        assert_eq!(
            account.facts.len(),
            5,
            "three directions, one avoided topic, one unsure author"
        );
        assert_eq!(
            account.summary(200),
            "研究——长期方向：智能体记忆、长上下文、检索增强\n不想看——主题：加密货币"
        );
        assert_eq!(account.summary(20), "", "nothing fits");
    }

    #[test]
    fn the_profile_is_rebuilt_once_a_day_from_new_evidence() {
        let dir = tempfile::tempdir().unwrap();
        let store = Store::open(&dir.path().join("radar.sqlite")).unwrap();
        let outside = Fake::default();
        let today = clock("2026-11-25", 9);
        assert_eq!(
            refresh(&store, &outside, &today).unwrap(),
            None,
            "no project yet"
        );
        let profile = Profile {
            topics: vec![Topic {
                name: "智能体记忆".into(),
                keywords: vec!["agent memory".into()],
                weight: 1.0,
            }],
            categories: vec!["cs.CL".into()],
        };
        store
            .put_profile("p", &serde_json::to_string(&profile).unwrap(), 3, 0)
            .unwrap();
        store
            .note("question", Some("p"), "怎么评测长期记忆？", today.now)
            .unwrap();
        outside.answers.borrow_mut().push_back(
            r#"{"facts":[{"topic":"研究","item":"长期方向","value":"智能体记忆","confidence":0.9,"evidence":4}]}"#
                .into(),
        );
        let built = refresh(&store, &outside, &today).unwrap().unwrap();
        assert_eq!(built.summary(100), "研究——长期方向：智能体记忆");
        assert!(outside.questions.borrow()[0].contains("怎么评测长期记忆？"));
        // The same day, nothing is asked again.
        let later = Clock {
            now: today.now + 3600,
            ..today.clone()
        };
        assert_eq!(
            refresh(&store, &outside, &later).unwrap(),
            Some(built.clone())
        );
        assert_eq!(outside.questions.borrow().len(), 1);
        // The next day, without new evidence, neither.
        assert_eq!(
            refresh(&store, &outside, &clock("2026-11-26", 9)).unwrap(),
            Some(built)
        );
        assert_eq!(outside.questions.borrow().len(), 1);
    }
}
