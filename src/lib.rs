pub mod adapters;
pub mod github;
pub mod model;
pub mod store;

use chrono::{DateTime, TimeDelta, Utc};
use model::*;
use sha2::{Digest, Sha256};
use std::collections::{BTreeMap, BTreeSet};

#[derive(Debug, thiserror::Error)]
pub enum Error {
    #[error("contract violation: {0}")]
    Contract(String),
    #[error("JSON: {0}")]
    Json(#[from] serde_json::Error),
    #[error("storage: {0}")]
    Io(#[from] std::io::Error),
    #[error("source read failed: {0}")]
    Source(String),
}
pub type Result<T> = std::result::Result<T, Error>;
pub fn require(condition: bool, message: &str) -> Result<()> {
    if condition {
        Ok(())
    } else {
        Err(Error::Contract(message.into()))
    }
}
fn identifier(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= 128
        && value
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b"._-".contains(&b))
}
fn text(value: &str, limit: usize) -> bool {
    !value.trim().is_empty() && value.len() <= limit && !value.chars().any(char::is_control)
}
pub fn repository(value: &str) -> bool {
    let parts: Vec<_> = value.split('/').collect();
    parts.len() == 2
        && parts
            .iter()
            .all(|p| identifier(p) && *p != "." && *p != "..")
}

pub fn validate_config(config: &Config) -> Result<()> {
    require(
        config.schema == CONFIG_SCHEMA,
        "unsupported configuration schema",
    )?;
    require(
        identifier(&config.organization.id) && text(&config.organization.label, 256),
        "invalid organization",
    )?;
    require(
        (15..=3600).contains(&config.freshness_seconds),
        "freshness must be 15–3600 seconds",
    )?;
    require(
        (3600..=2_592_000).contains(&config.retention_seconds),
        "retention must be 1 hour–30 days",
    )?;
    require(
        (1..=100_000).contains(&config.max_entities)
            && (1..=1000).contains(&config.max_recent_events),
        "invalid storage bounds",
    )?;
    require(
        !config.departments.is_empty()
            && config.departments.len() <= 100
            && !config.sources.is_empty()
            && config.sources.len() <= 200,
        "invalid registry size",
    )?;
    let mut departments = BTreeSet::new();
    for d in &config.departments {
        require(
            identifier(&d.id)
                && departments.insert(&d.id)
                && text(&d.label, 256)
                && text(&d.responsibility, 2000),
            "invalid or duplicate department",
        )?;
    }
    let mut sources = BTreeSet::new();
    for s in &config.sources {
        require(
            (15..=3600).contains(&s.poll_seconds)
                && s.freshness_seconds
                    .is_none_or(|n| (15..=7200).contains(&n) && n >= s.poll_seconds),
            "invalid source cadence or freshness",
        )?;
        require(
            identifier(&s.id)
                && sources.insert(&s.id)
                && departments.contains(&s.department)
                && text(&s.label, 256),
            "invalid source registration",
        )?;
        if matches!(s.kind, SourceKind::Cma | SourceKind::Nyxid) {
            let runtime = s
                .runtime
                .as_ref()
                .ok_or_else(|| Error::Contract("runtime needs an explicit owner binding".into()))?;
            require(
                runtime.publish
                    && text(&runtime.resource_id, 256)
                    && text(&runtime.public_label, 500),
                "runtime public projection must be explicitly enabled",
            )?;
            validate_actor(&runtime.actor)?;
            require(
                runtime.actor.kind
                    == if s.kind == SourceKind::Cma {
                        ActorKind::Agent
                    } else {
                        ActorKind::Automation
                    },
                "runtime actor kind mismatch",
            )?;
            require(
                s.repository.is_none() && s.workflow_paths.is_empty(),
                "runtime cannot impersonate a GitHub source",
            )?;
        } else {
            require(
                s.repository.as_deref().is_some_and(repository) && s.runtime.is_none(),
                "GitHub source needs a repository, without runtime identity",
            )?;
            require(
                s.workflow_paths.is_empty() || s.kind == SourceKind::GithubActions,
                "workflow selectors apply only to Actions",
            )?;
            for path in &s.workflow_paths {
                require(
                    path.starts_with(".github/workflows/")
                        && !path.contains("..")
                        && (path.ends_with(".yml") || path.ends_with(".yaml")),
                    "invalid workflow selector",
                )?;
            }
        }
    }
    let mut routes = BTreeSet::new();
    for r in &config.routes {
        require(
            departments.contains(&r.from)
                && departments.contains(&r.to)
                && r.from != r.to
                && text(&r.label, 256)
                && routes.insert((&r.from, &r.to)),
            "invalid responsibility route",
        )?;
    }
    Ok(())
}

fn validate_actor(actor: &Actor) -> Result<()> {
    require(
        text(&actor.id, 256)
            && text(&actor.label, 256)
            && actor.tool.as_deref().is_none_or(|t| text(t, 128)),
        "invalid actor",
    )
}

fn binding(source: &Source) -> Result<String> {
    // Department labels and presentation can change; a source's authority cannot.
    let value = serde_json::to_vec(&(
        source.kind,
        &source.repository,
        &source.runtime,
        &source.workflow_paths,
    ))?;
    Ok(format!("{:x}", Sha256::digest(value)))
}

fn revision(event: &Event) -> (u64, u8, u64) {
    // A settled run cannot become active in the same attempt/turn, even if a
    // delayed observer saw a later timestamp. A new generation can start work.
    let terminal = u8::from(
        matches!(event.kind, ActivityKind::Automation | ActivityKind::Session)
            && event.status.is_terminal(),
    );
    (event.generation, terminal, event.sequence)
}

fn validate_event(
    event: &Event,
    batch: &Batch,
    source: &Source,
    config: &Config,
    as_of: DateTime<Utc>,
) -> Result<()> {
    require(
        event.schema == EVENT_SCHEMA && event.source == source.id && batch.source == source.id,
        "unbound event source",
    )?;
    require(
        text(&event.id, 512)
            && text(&event.subject, 512)
            && event.sequence > 0
            && text(&event.label, 1000),
        "invalid event identity or label",
    )?;
    require(
        event.at <= as_of && event.at <= batch.observed_at + TimeDelta::seconds(300),
        "event is in the future",
    )?;
    if let Some(actor) = &event.actor {
        validate_actor(actor)?;
    }
    let expected = match source.kind {
        SourceKind::GithubActions => ActivityKind::Automation,
        SourceKind::GithubIssues => ActivityKind::Task,
        SourceKind::GithubPulls => ActivityKind::Contribution,
        SourceKind::GithubComments => ActivityKind::Discussion,
        SourceKind::GithubReviews => ActivityKind::Review,
        SourceKind::Cma => ActivityKind::Session,
        SourceKind::Nyxid => ActivityKind::Delivery,
    };
    require(
        event.kind == expected,
        "event kind does not match registered source",
    )?;
    let valid_status = match event.kind {
        ActivityKind::Automation => matches!(
            event.status,
            Status::Working
                | Status::Waiting
                | Status::Succeeded
                | Status::Failed
                | Status::Cancelled
                | Status::Closed
                | Status::Unknown
        ),
        ActivityKind::Session => matches!(
            event.status,
            Status::Working
                | Status::Waiting
                | Status::Ready
                | Status::Succeeded
                | Status::Failed
                | Status::Cancelled
                | Status::Unknown
        ),
        ActivityKind::Task => matches!(
            event.status,
            Status::Open | Status::Claimed | Status::Closed | Status::Unknown
        ),
        ActivityKind::Contribution => matches!(
            event.status,
            Status::Open | Status::Claimed | Status::Merged | Status::Closed | Status::Unknown
        ),
        ActivityKind::Discussion => matches!(event.status, Status::Open | Status::Unknown),
        ActivityKind::Review => matches!(
            event.status,
            Status::Reviewing
                | Status::ChangesRequested
                | Status::Ready
                | Status::Closed
                | Status::Unknown
        ),
        ActivityKind::Delivery => matches!(
            event.status,
            Status::Succeeded | Status::Failed | Status::Waiting
        ),
    };
    require(valid_status, "state is not valid for this activity kind")?;
    if let Some(runtime) = &source.runtime {
        require(
            event.actor.as_ref() == Some(&runtime.actor) && event.label == runtime.public_label,
            "runtime identity or label differs from owner binding",
        )?;
        require(
            event.url.is_none() && event.task.is_none() && event.references.is_empty(),
            "runtime wire content is not public metadata",
        )?;
        if source.kind == SourceKind::Cma {
            require(
                event.subject == runtime.resource_id,
                "foreign runtime resource",
            )?;
        }
    } else {
        require(
            event
                .actor
                .as_ref()
                .is_none_or(|a| a.kind == ActorKind::Account && a.tool.is_none()),
            "GitHub accounts cannot establish an agent or model identity",
        )?;
        let prefix = format!(
            "https://github.com/{}/",
            source.repository.as_deref().unwrap()
        );
        require(
            event.url.as_deref().is_some_and(|url| {
                url.starts_with(&prefix) && !url.contains('?') && !url.chars().any(char::is_control)
            }),
            "source link is outside registered public repository",
        )?;
        require(
            event
                .task
                .as_ref()
                .is_none_or(|r| Some(&r.repository) == source.repository.as_ref() && r.number > 0),
            "foreign task identity",
        )?;
    }
    let allowed: BTreeSet<_> = config
        .sources
        .iter()
        .filter_map(|s| s.repository.as_ref())
        .collect();
    require(
        event.references.len() <= 30
            && event
                .references
                .iter()
                .all(|r| r.number > 0 && allowed.contains(&r.repository)),
        "unregistered reference target",
    )?;
    if source.kind == SourceKind::Nyxid {
        require(
            matches!(
                event.status,
                Status::Succeeded | Status::Failed | Status::Waiting
            ),
            "gateway delivery is not agent work",
        )?;
    }
    Ok(())
}

/// All validation and reduction happen on an owned copy. A rejected batch never
/// advances a caller's checkpoint or partially changes a published state.
pub fn reduce(
    config: &Config,
    previous: Option<&Checkpoint>,
    input: &Ingest,
) -> Result<Checkpoint> {
    validate_config(config)?;
    let mut state = previous.cloned().unwrap_or_else(|| Checkpoint {
        schema: STATE_SCHEMA.into(),
        organization: config.organization.id.clone(),
        as_of: input.as_of,
        bindings: BTreeMap::new(),
        heads: BTreeMap::new(),
        sources: BTreeMap::new(),
        recent: vec![],
    });
    require(
        state.schema == STATE_SCHEMA
            && state.organization == config.organization.id
            && input.as_of >= state.as_of,
        "checkpoint identity or time rollback",
    )?;
    let registry: BTreeMap<_, _> = config.sources.iter().map(|s| (s.id.as_str(), s)).collect();
    require(
        state.heads.len() <= config.max_entities && state.recent.len() <= config.max_recent_events,
        "checkpoint exceeds configured bounds",
    )?;
    for source in &config.sources {
        let fingerprint = binding(source)?;
        require(
            state
                .bindings
                .get(&source.id)
                .is_none_or(|old| old == &fingerprint),
            "source authority changed; explicit checkpoint migration required",
        )?;
        state.bindings.insert(source.id.clone(), fingerprint);
    }
    require(
        state
            .heads
            .values()
            .all(|h| registry.contains_key(h.event.source.as_str())),
        "checkpoint contains a removed source; explicit migration required",
    )?;
    for (key, head) in &state.heads {
        let source = registry[head.event.source.as_str()];
        require(
            key == &format!("{}:{}", head.event.source, head.event.subject)
                && head.confirmed_at <= state.as_of,
            "corrupt checkpoint head",
        )?;
        let batch = Batch {
            source: source.id.clone(),
            observed_at: head.confirmed_at,
            cursor: None,
            complete: false,
            events: vec![],
        };
        validate_event(&head.event, &batch, source, config, state.as_of)?;
    }
    require(
        state
            .sources
            .iter()
            .all(|(id, s)| registry.contains_key(id.as_str()) && s.observed_at <= state.as_of),
        "corrupt checkpoint source",
    )?;
    let cutoff = input.as_of - TimeDelta::seconds(config.retention_seconds.into());
    state.heads.retain(|_, h| h.confirmed_at >= cutoff);
    state.recent.retain(|e| e.at >= cutoff);
    let mut observed_sources = BTreeSet::new();
    for batch in &input.batches {
        let source = registry
            .get(batch.source.as_str())
            .ok_or_else(|| Error::Contract("batch source not registered".into()))?;
        require(
            observed_sources.insert(&batch.source),
            "one source batch per transaction",
        )?;
        require(
            batch.observed_at <= input.as_of
                && state
                    .sources
                    .get(&batch.source)
                    .is_none_or(|c| batch.observed_at >= c.observed_at),
            "source observation time rollback",
        )?;
        require(batch.events.len() <= 10_000, "batch exceeds event bound")?;
        let cursor = state.sources.get(&batch.source).map_or(0, |c| c.cursor);
        if let Some(c) = &batch.cursor {
            require(
                c.after == cursor && c.through >= c.after,
                "cursor gap, rollback or concurrent writer",
            )?;
        }
        require(
            source.kind != SourceKind::Cma || batch.cursor.is_some(),
            "CMA needs a durable replay cursor",
        )?;
        for event in &batch.events {
            validate_event(event, batch, source, config, input.as_of)?;
            if let Some(c) = &batch.cursor {
                require(
                    event.sequence > c.after && event.sequence <= c.through,
                    "event outside cursor interval",
                )?;
            }
            if event.at < cutoff {
                continue;
            }
            if let Some(known) = state
                .recent
                .iter()
                .find(|e| e.source == event.source && e.id == event.id)
            {
                require(known == event, "conflicting duplicate event")?;
            } else {
                state.recent.push(event.clone());
            }
            let key = format!("{}:{}", event.source, event.subject);
            if let Some(old) = state.heads.get_mut(&key) {
                let incoming = revision(event);
                let prior = revision(&old.event);
                if event.id == old.event.id {
                    require(event == &old.event, "conflicting entity event")?;
                }
                if incoming == prior {
                    require(event == &old.event, "conflicting entity revision")?;
                }
                if incoming > prior {
                    *old = Head {
                        event: event.clone(),
                        confirmed_at: batch.observed_at,
                    };
                } else if event == &old.event {
                    old.confirmed_at = batch.observed_at;
                }
            } else {
                state.heads.insert(
                    key,
                    Head {
                        event: event.clone(),
                        confirmed_at: batch.observed_at,
                    },
                );
            }
        }
        state.sources.insert(
            batch.source.clone(),
            SourceCheckpoint {
                observed_at: batch.observed_at,
                cursor: batch.cursor.as_ref().map_or(cursor, |c| c.through),
                complete: batch.complete,
            },
        );
    }
    require(
        state.heads.len() <= config.max_entities,
        "entity limit reached; no checkpoint committed",
    )?;
    state
        .recent
        .sort_by(|a, b| (&b.at, &b.source, &b.id).cmp(&(&a.at, &a.source, &a.id)));
    state
        .recent
        .dedup_by(|a, b| a.source == b.source && a.id == b.id);
    state.recent.truncate(config.max_recent_events);
    state.as_of = input.as_of;
    Ok(state)
}

pub fn project(config: &Config, state: &Checkpoint) -> Result<View> {
    validate_config(config)?;
    require(
        state.schema == STATE_SCHEMA && state.organization == config.organization.id,
        "invalid projection checkpoint",
    )?;
    let registry: BTreeMap<_, _> = config.sources.iter().map(|s| (s.id.as_str(), s)).collect();
    let activity = |event: &Event, confirmed_at: DateTime<Utc>| -> Result<Activity> {
        let source = registry
            .get(event.source.as_str())
            .ok_or_else(|| Error::Contract("unregistered checkpoint event".into()))?;
        let fresh_at = state.as_of
            - TimeDelta::seconds(
                source
                    .freshness_seconds
                    .unwrap_or(config.freshness_seconds)
                    .into(),
            );
        let clock = if event.kind == ActivityKind::Session {
            event.at
        } else {
            confirmed_at
        };
        let fresh = clock >= fresh_at
            && state
                .sources
                .get(&event.source)
                .is_some_and(|s| s.observed_at >= fresh_at);
        let public_id = format!(
            "{:x}",
            Sha256::digest(format!("{}:{}", event.source, event.subject).as_bytes())
        );
        Ok(Activity {
            id: public_id[..24].into(),
            source: event.source.clone(),
            department: source.department.clone(),
            kind: event.kind,
            status: if event.status.is_active() && !fresh {
                Status::Unknown
            } else {
                event.status
            },
            label: event.label.clone(),
            actor: event.actor.clone(),
            at: event.at,
            url: event.url.clone(),
            task: event.task.clone(),
            references: event.references.clone(),
            fresh,
        })
    };
    let mut activities = state
        .heads
        .values()
        .map(|h| activity(&h.event, h.confirmed_at))
        .collect::<Result<Vec<_>>>()?;
    activities.sort_by(|a, b| (&b.at, &b.id).cmp(&(&a.at, &a.id)));
    let mut task_departments: BTreeMap<(&str, u64), BTreeSet<&str>> = BTreeMap::new();
    for a in &activities {
        if let Some(task) = &a.task {
            task_departments
                .entry((&task.repository, task.number))
                .or_default()
                .insert(&a.department);
        }
    }
    let mut handoffs = Vec::new();
    let mut seen_handoffs = BTreeSet::new();
    for a in &activities {
        for reference in &a.references {
            for department in task_departments
                .get(&(reference.repository.as_str(), reference.number))
                .into_iter()
                .flatten()
                .filter(|department| **department != a.department)
            {
                let h = Handoff {
                    kind: RelationKind::Reference,
                    from: (*department).to_string(),
                    to: a.department.clone(),
                    activity: a.id.clone(),
                    reference: reference.clone(),
                    url: a.url.clone(),
                };
                if seen_handoffs.insert((
                    h.from.clone(),
                    h.to.clone(),
                    h.activity.clone(),
                    reference.repository.clone(),
                    reference.number,
                )) {
                    handoffs.push(h);
                }
            }
        }
    }
    let departments = config
        .departments
        .iter()
        .map(|d| {
            let mut items: Vec<_> = activities
                .iter()
                .filter(|a| a.department == d.id)
                .cloned()
                .collect();
            items.sort_by_key(|a| {
                !matches!(a.kind, ActivityKind::Automation | ActivityKind::Session)
                    || !a.fresh
                    || !a.status.is_active()
            });
            let mut participants = BTreeMap::new();
            for item in &items {
                if let Some(actor) = &item.actor {
                    participants
                        .entry((format!("{:?}", actor.kind), actor.id.clone()))
                        .or_insert_with(|| actor.clone());
                }
            }
            DepartmentView {
                department: d.clone(),
                running_automations: items
                    .iter()
                    .filter(|a| {
                        a.kind == ActivityKind::Automation && a.fresh && a.status == Status::Working
                    })
                    .count(),
                running_sessions: items
                    .iter()
                    .filter(|a| {
                        a.kind == ActivityKind::Session && a.fresh && a.status == Status::Working
                    })
                    .count(),
                observed_activities: items.len(),
                activities_truncated: items.len() > 100,
                participants: participants.into_values().take(32).collect(),
                activities: items.into_iter().take(100).collect(),
            }
        })
        .collect();
    let recent = state
        .recent
        .iter()
        .map(|e| activity(e, e.at))
        .collect::<Result<Vec<_>>>()?;
    let sources = config
        .sources
        .iter()
        .map(|s| {
            let checkpoint = state.sources.get(&s.id);
            let fresh_at = state.as_of
                - TimeDelta::seconds(
                    s.freshness_seconds
                        .unwrap_or(config.freshness_seconds)
                        .into(),
                );
            SourceView {
                id: s.id.clone(),
                label: s.label.clone(),
                kind: s.kind,
                observed_at: checkpoint.map(|c| c.observed_at),
                fresh: checkpoint.is_some_and(|c| c.observed_at >= fresh_at),
                complete: checkpoint.is_some_and(|c| c.complete),
            }
        })
        .collect();
    let handoffs_truncated = handoffs.len() > 500;
    handoffs.truncate(500);
    Ok(View {
        schema: VIEW_SCHEMA.into(),
        organization: config.organization.clone(),
        observed_at: state.as_of,
        departments,
        routes: config.routes.clone(),
        handoffs,
        handoffs_truncated,
        recent,
        sources,
    })
}
