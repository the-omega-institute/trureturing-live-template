//! Allowlisted native projections. Source payloads are never stored or exported.
use crate::{Error, Result, model::*, require};
use chrono::{DateTime, Utc};
use regex::Regex;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::{collections::BTreeMap, sync::LazyLock};

static EXPLICIT_REFERENCE: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r"https://github\.com/([A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+)/(?:issues|pull)/(\d+)|(?:^|[^\w/])([A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+)#(\d+)").unwrap()
});
static QUALIFIED_REFERENCE: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r"(?i)(?:\b(?:close[sd]?|fix(?:e[sd])?|resolve[sd]?|refs?|issue|research(?:\s+(?:issue|line|unit|and independent form evidence))?)\b|研究线|研究问题|课题)\s*[:：]?\s*#(\d+)").unwrap()
});

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct GithubObservation {
    pub source: String,
    pub observed_at: DateTime<Utc>,
    pub repository: RepositoryVisibility,
    pub complete: bool,
    pub items: Vec<Value>,
}
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct RepositoryVisibility {
    pub full_name: String,
    pub private: bool,
    pub visibility: String,
}

fn string<'a>(row: &'a Value, field: &str) -> Result<&'a str> {
    row[field]
        .as_str()
        .filter(|v| !v.is_empty())
        .ok_or_else(|| Error::Contract(format!("native source missing {field}")))
}
fn integer(row: &Value, field: &str) -> Result<u64> {
    row[field]
        .as_u64()
        .filter(|n| *n > 0)
        .ok_or_else(|| Error::Contract(format!("native source missing positive {field}")))
}
fn date(row: &Value, field: &str) -> Result<DateTime<Utc>> {
    string(row, field)?
        .parse()
        .map_err(|_| Error::Contract(format!("invalid source time {field}")))
}
fn account(row: &Value) -> Option<Actor> {
    row["login"].as_str().map(|login| Actor {
        id: login.into(),
        label: login.into(),
        kind: ActorKind::Account,
        tool: None,
    })
}

pub fn references(body: &str, config: &Config, local: &str) -> Vec<Reference> {
    if body.is_empty() {
        return vec![];
    }
    let allowed: Vec<_> = config
        .sources
        .iter()
        .filter_map(|s| s.repository.as_deref())
        .collect();
    let mut refs = BTreeMap::new();
    for m in EXPLICIT_REFERENCE.captures_iter(body) {
        let repo = m.get(1).or_else(|| m.get(3)).unwrap().as_str();
        let number = m
            .get(2)
            .or_else(|| m.get(4))
            .unwrap()
            .as_str()
            .parse::<u64>()
            .unwrap_or(0);
        if allowed.contains(&repo) && number > 0 {
            refs.insert(
                (repo.to_string(), number),
                Reference {
                    repository: repo.into(),
                    number,
                },
            );
        }
    }
    for m in QUALIFIED_REFERENCE.captures_iter(body) {
        let number = m[1].parse::<u64>().unwrap_or(0);
        if allowed.contains(&local) && number > 0 {
            refs.insert(
                (local.to_string(), number),
                Reference {
                    repository: local.into(),
                    number,
                },
            );
        }
    }
    refs.into_values().take(30).collect()
}

pub fn github(config: &Config, input: GithubObservation) -> Result<Batch> {
    let source = config
        .sources
        .iter()
        .find(|s| s.id == input.source)
        .ok_or_else(|| Error::Contract("unknown GitHub adapter source".into()))?;
    require(
        !input.repository.private
            && input.repository.visibility == "public"
            && source.repository.as_deref() == Some(&input.repository.full_name),
        "repository is not the registered public source",
    )?;
    require(
        source.runtime.is_none() && input.items.len() <= 1000,
        "invalid GitHub observation",
    )?;
    let repo = &input.repository.full_name;
    let mut events = Vec::new();
    for row in input.items {
        let mut event = Event {
            schema: EVENT_SCHEMA.into(),
            id: String::new(),
            source: source.id.clone(),
            subject: String::new(),
            generation: 0,
            sequence: 0,
            at: date(&row, "updated_at")?,
            kind: ActivityKind::Task,
            status: Status::Unknown,
            label: String::new(),
            actor: None,
            url: Some(string(&row, "html_url")?.into()),
            task: None,
            references: references(row["body"].as_str().unwrap_or(""), config, repo),
        };
        let rank;
        match source.kind {
            SourceKind::GithubActions => {
                let path = string(&row, "path")?.split('@').next().unwrap();
                if !source.workflow_paths.is_empty()
                    && !source.workflow_paths.iter().any(|p| p == path)
                {
                    continue;
                }
                let id = integer(&row, "id")?;
                event.subject = format!("run/{id}");
                event.generation = integer(&row, "run_attempt")?;
                event.kind = ActivityKind::Automation;
                event.label = source.label.clone();
                event.actor = account(&row["actor"]);
                (event.status, rank) = match string(&row, "status")? {
                    "in_progress" => (Status::Working, 3),
                    "queued" | "waiting" | "pending" | "requested" => (Status::Waiting, 2),
                    "completed" => (
                        match row["conclusion"].as_str() {
                            Some("success") => Status::Succeeded,
                            Some(
                                "failure" | "timed_out" | "startup_failure" | "action_required",
                            ) => Status::Failed,
                            Some("cancelled" | "stale") => Status::Cancelled,
                            Some("neutral" | "skipped") => Status::Closed,
                            _ => Status::Unknown,
                        },
                        4,
                    ),
                    _ => (Status::Unknown, 1),
                };
                if let Some(prs) = row["pull_requests"].as_array() {
                    for pr in prs {
                        if let Some(number) = pr["number"].as_u64().filter(|n| *n > 0) {
                            event.references.push(Reference {
                                repository: repo.clone(),
                                number,
                            });
                        }
                    }
                    event.task = event.references.first().cloned();
                }
            }
            SourceKind::GithubIssues | SourceKind::GithubPulls => {
                if source.kind == SourceKind::GithubIssues && row.get("pull_request").is_some() {
                    continue;
                }
                let number = integer(&row, "number")?;
                event.subject = format!("task/{number}");
                event.task = Some(Reference {
                    repository: repo.clone(),
                    number,
                });
                event.kind = if source.kind == SourceKind::GithubPulls {
                    ActivityKind::Contribution
                } else {
                    ActivityKind::Task
                };
                event.label = string(&row, "title")?.chars().take(400).collect();
                event.status = if row["merged_at"].is_string() {
                    Status::Merged
                } else if string(&row, "state")? == "closed" {
                    Status::Closed
                } else if row["assignees"].as_array().is_some_and(|a| !a.is_empty()) {
                    Status::Claimed
                } else {
                    Status::Open
                };
                event.actor = if event.status == Status::Claimed {
                    account(&row["assignees"][0])
                } else {
                    account(&row["user"])
                };
                rank = if event.status.is_terminal() { 4 } else { 1 };
            }
            SourceKind::GithubComments | SourceKind::GithubReviews => {
                let id = integer(&row, "id")?;
                event.subject = format!("comment/{id}");
                event.kind = if source.kind == SourceKind::GithubReviews {
                    ActivityKind::Review
                } else {
                    ActivityKind::Discussion
                };
                event.status = if source.kind == SourceKind::GithubReviews {
                    Status::Reviewing
                } else {
                    Status::Open
                };
                // The event says a public contribution occurred. It does not
                // summarize a private transcript or promote prose to a result.
                event.label = source.label.clone();
                event.actor = account(&row["user"]);
                let thread = row["issue_url"]
                    .as_str()
                    .or_else(|| row["pull_request_url"].as_str())
                    .ok_or_else(|| Error::Contract("comment missing thread".into()))?;
                let expected = format!("https://api.github.com/repos/{repo}/");
                require(
                    thread.starts_with(&expected),
                    "comment belongs to another repository",
                )?;
                let number = thread
                    .rsplit('/')
                    .next()
                    .unwrap_or("")
                    .parse()
                    .map_err(|_| Error::Contract("invalid comment thread".into()))?;
                event.task = Some(Reference {
                    repository: repo.clone(),
                    number,
                });
                rank = 1;
            }
            _ => {
                return Err(Error::Contract(
                    "runtime source passed to GitHub adapter".into(),
                ));
            }
        }
        let timestamp = u64::try_from(event.at.timestamp_millis())
            .map_err(|_| Error::Contract("source time precedes epoch".into()))?;
        event.sequence = timestamp
            .checked_mul(16)
            .and_then(|n| n.checked_add(rank))
            .ok_or_else(|| Error::Contract("source timestamp overflow".into()))?;
        event.id = format!("{}:{}:{}", event.subject, event.generation, event.sequence);
        event
            .references
            .sort_by(|a, b| (&a.repository, a.number).cmp(&(&b.repository, b.number)));
        event.references.dedup();
        event.references.truncate(30);
        events.push(event);
    }
    Ok(Batch {
        source: source.id.clone(),
        observed_at: input.observed_at,
        cursor: None,
        complete: input.complete,
        events,
    })
}

#[derive(Debug, Clone, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct CmaPage {
    pub source: String,
    pub observed_at: DateTime<Utc>,
    pub after: u64,
    pub items: Vec<CmaItem>,
}
#[derive(Debug, Clone, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct CmaItem {
    pub agent_id: String,
    pub seq: u64,
    pub appended_at: DateTime<Utc>,
    pub kind: Value,
}

pub fn cma(config: &Config, page: CmaPage, previous: Option<&Checkpoint>) -> Result<Batch> {
    let source = config
        .sources
        .iter()
        .find(|s| s.id == page.source && s.kind == SourceKind::Cma)
        .ok_or_else(|| Error::Contract("CMA source not registered".into()))?;
    let binding = source
        .runtime
        .as_ref()
        .ok_or_else(|| Error::Contract("CMA source lacks owner binding".into()))?;
    require(
        binding.publish && page.items.len() <= 1000,
        "CMA public import not enabled or exceeds page bound",
    )?;
    let mut through = page.after;
    let mut generation = previous
        .and_then(|p| {
            p.heads
                .get(&format!("{}:{}", source.id, binding.resource_id))
        })
        .map_or(0, |h| h.event.generation);
    let mut events = Vec::new();
    for item in page.items {
        require(
            item.agent_id == binding.resource_id
                && item.seq
                    == through
                        .checked_add(1)
                        .ok_or_else(|| Error::Contract("CMA cursor overflow".into()))?,
            "CMA page has a gap or foreign resource",
        )?;
        through = item.seq;
        let status = match string(&item.kind, "type")? {
            "turn_started" => {
                let next = integer(&item.kind, "turn_sequence")?;
                require(next > generation, "CMA turn generation did not increase")?;
                generation = next;
                Some(Status::Working)
            }
            "turn_completed" | "turn_failed" | "turn_interrupted" => {
                require(
                    integer(&item.kind, "turn_sequence")? == generation,
                    "CMA terminal event belongs to another turn",
                )?;
                Some(match item.kind["type"].as_str().unwrap() {
                    "turn_completed" => Status::Succeeded,
                    "turn_failed" => Status::Failed,
                    _ => Status::Cancelled,
                })
            }
            "approval_requested" | "authentication_required" => Some(Status::Waiting),
            "stopped" | "deleted" => Some(Status::Cancelled),
            "status_changed" => Some(match string(&item.kind, "to")? {
                "working" => Status::Working,
                "waiting_approval" => Status::Waiting,
                "starting" | "provisioning" | "paused" => Status::Waiting,
                "ready" => Status::Ready,
                "failed" => Status::Failed,
                "stopped" | "deleted" => Status::Cancelled,
                _ => Status::Unknown,
            }),
            // Read every durable sequence, but discard text, arguments, model
            // configuration, credentials, output and other non-status content.
            _ => None,
        };
        if let Some(status) = status {
            events.push(Event {
                schema: EVENT_SCHEMA.into(),
                id: format!("{}:{}", binding.resource_id, item.seq),
                source: source.id.clone(),
                subject: binding.resource_id.clone(),
                generation,
                sequence: item.seq,
                at: item.appended_at,
                kind: ActivityKind::Session,
                status,
                label: binding.public_label.clone(),
                actor: Some(binding.actor.clone()),
                url: None,
                task: None,
                references: vec![],
            });
        }
    }
    Ok(Batch {
        source: source.id.clone(),
        observed_at: page.observed_at,
        cursor: Some(Cursor {
            after: page.after,
            through,
        }),
        complete: true,
        events,
    })
}

#[derive(Debug, Clone, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct NyxidDelivery {
    pub source: String,
    pub observed_at: DateTime<Utc>,
    pub conversation_id: String,
    pub event_id: String,
    pub event_timestamp: DateTime<Utc>,
    pub forwarded_at: DateTime<Utc>,
    pub outcome: String,
}

pub fn nyxid(config: &Config, input: NyxidDelivery) -> Result<Batch> {
    let source = config
        .sources
        .iter()
        .find(|s| s.id == input.source && s.kind == SourceKind::Nyxid)
        .ok_or_else(|| Error::Contract("NyxID source not registered".into()))?;
    let binding = source
        .runtime
        .as_ref()
        .ok_or_else(|| Error::Contract("NyxID source lacks owner binding".into()))?;
    require(
        binding.publish
            && input.conversation_id == binding.resource_id
            && !input.event_id.is_empty(),
        "NyxID receipt belongs to another bound channel",
    )?;
    require(
        input.event_timestamp <= input.forwarded_at && input.forwarded_at <= input.observed_at,
        "invalid delivery clock",
    )?;
    let status = match input.outcome.as_str() {
        "delivered" | "deduped" => Status::Succeeded,
        "callback_failed" => Status::Failed,
        "rate_limited" => Status::Waiting,
        _ => return Err(Error::Contract("unknown NyxID delivery outcome".into())),
    };
    let sequence = u64::try_from(input.forwarded_at.timestamp_millis())
        .map_err(|_| Error::Contract("invalid delivery time".into()))?;
    let event = Event {
        schema: EVENT_SCHEMA.into(),
        id: format!("{}:{}:{}", input.event_id, sequence, input.outcome),
        source: source.id.clone(),
        subject: input.event_id,
        generation: 0,
        sequence,
        at: input.forwarded_at,
        kind: ActivityKind::Delivery,
        status,
        label: binding.public_label.clone(),
        actor: Some(binding.actor.clone()),
        url: None,
        task: None,
        references: vec![],
    };
    Ok(Batch {
        source: source.id.clone(),
        observed_at: input.observed_at,
        cursor: None,
        complete: true,
        events: vec![event],
    })
}
