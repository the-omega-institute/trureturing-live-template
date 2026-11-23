use chrono::{DateTime, TimeDelta, Utc};
use live_harness::{
    adapters::{self, GithubObservation, RepositoryVisibility},
    model::*,
    project, reduce, store,
};
use serde_json::json;

const REPO: &str = "example-org/research";
fn at() -> DateTime<Utc> {
    "2026-11-23T12:00:00Z".parse().unwrap()
}
fn config() -> Config {
    serde_json::from_value(json!({
        "schema":CONFIG_SCHEMA,"organization":{"id":"test-org","label":"Research organization"},
        "departments":[{"id":"research","label":"Research","responsibility":"Explore questions","execution":"sessions"},{"id":"books","label":"Books","responsibility":"Write results","execution":"mixed"}],
        "sources":[{"id":"ci","kind":"github_actions","department":"research","label":"Formal checks","repository":REPO,"workflow_paths":[".github/workflows/ci.yml"]},{"id":"issues","kind":"github_issues","department":"research","label":"Questions","repository":REPO},{"id":"books","kind":"github_pulls","department":"books","label":"Book contributions","repository":"example-org/books"}],
        "routes":[{"from":"research","to":"books","label":"Write results"}],
        "freshness_seconds":180,"retention_seconds":86400,"max_entities":1000,"max_recent_events":100
    })).unwrap()
}
fn event(sequence: u64, status: Status) -> Event {
    Event {
        schema: EVENT_SCHEMA.into(),
        id: format!("run-1-{sequence}"),
        source: "ci".into(),
        subject: "run/1".into(),
        generation: 1,
        sequence,
        at: at(),
        kind: ActivityKind::Automation,
        status,
        label: "Formal checks".into(),
        actor: Some(Actor {
            id: "account".into(),
            label: "account".into(),
            kind: ActorKind::Account,
            tool: None,
        }),
        url: Some(format!("https://github.com/{REPO}/actions/runs/1")),
        task: None,
        references: vec![],
    }
}
fn ingest(events: Vec<Event>) -> Ingest {
    Ingest {
        as_of: at(),
        batches: vec![Batch {
            source: "ci".into(),
            observed_at: at(),
            cursor: None,
            complete: false,
            events,
        }],
    }
}
fn runtime_config() -> Config {
    let mut c = config();
    c.sources.push(serde_json::from_value(json!({"id":"cma","kind":"cma","department":"research","label":"Formalization agent","runtime":{"resource_id":"private-resource","actor":{"id":"public-agent-a","label":"Researcher A","kind":"agent","tool":"Codex"},"public_label":"Developing the proof","publish":true}})).unwrap());
    c.sources.push(serde_json::from_value(json!({"id":"gateway","kind":"nyxid","department":"books","label":"Delivery","runtime":{"resource_id":"private-conversation","actor":{"id":"public-gateway","label":"Delivery engine","kind":"automation"},"public_label":"Delivering a work item","publish":true}})).unwrap());
    c
}

#[test]
fn registry_rejects_unknown_fields_duplicate_ids_and_unbound_sources() {
    let mut raw = serde_json::to_value(config()).unwrap();
    raw["invented"] = json!(true);
    assert!(serde_json::from_value::<Config>(raw).is_err());
    let mut c = config();
    c.sources.push(c.sources[0].clone());
    assert!(live_harness::validate_config(&c).is_err());
    let mut c = config();
    c.sources[0].department = "missing".into();
    assert!(live_harness::validate_config(&c).is_err());
    let mut c = config();
    c.sources[0].repository = Some("org/../../private".into());
    assert!(live_harness::validate_config(&c).is_err());
    let mut c = runtime_config();
    c.sources[3].runtime.as_mut().unwrap().publish = false;
    assert!(live_harness::validate_config(&c).is_err());
}

#[test]
fn replay_is_permutation_invariant_and_duplicates_are_idempotent() {
    let c = config();
    let active = event(10, Status::Working);
    let settled = event(20, Status::Succeeded);
    let a = reduce(
        &c,
        None,
        &ingest(vec![active.clone(), settled.clone(), active.clone()]),
    )
    .unwrap();
    let b = reduce(&c, None, &ingest(vec![settled.clone(), active.clone()])).unwrap();
    assert_eq!(a, b);
    let replay = reduce(&c, Some(&a), &ingest(vec![settled, active])).unwrap();
    assert_eq!(a, replay);
    assert_eq!(
        project(&c, &a).unwrap().departments[0].running_automations,
        0
    );
}

#[test]
fn settled_attempt_fences_delayed_work_but_a_new_attempt_can_run() {
    let c = config();
    let terminal = event(10, Status::Succeeded);
    let later = event(20, Status::Working);
    let a = reduce(&c, None, &ingest(vec![terminal.clone(), later.clone()])).unwrap();
    let b = reduce(&c, None, &ingest(vec![later, terminal])).unwrap();
    assert_eq!(a, b);
    assert_eq!(a.heads["ci:run/1"].event.status, Status::Succeeded);
    let mut rerun = event(30, Status::Working);
    rerun.generation = 2;
    let next = reduce(&c, Some(&a), &ingest(vec![rerun])).unwrap();
    let view = project(&c, &next).unwrap();
    assert_eq!(view.departments[0].running_automations, 1);
    assert_eq!(view.departments[0].running_sessions, 0);
}

#[test]
fn conflict_and_poisoned_batch_cannot_change_stored_bytes() {
    let c = config();
    let dir = tempfile::tempdir().unwrap();
    let state = dir.path().join("state.json");
    let view = dir.path().join("view.json");
    store::transaction(&c, &state, &view, |_| {
        Ok(ingest(vec![event(10, Status::Working)]))
    })
    .unwrap();
    let before = (
        std::fs::read(&state).unwrap(),
        std::fs::read(&view).unwrap(),
    );
    let mut conflict = event(10, Status::Working);
    conflict.label = "different payload".into();
    assert!(
        store::transaction(&c, &state, &view, |_| Ok(ingest(vec![
            event(20, Status::Succeeded),
            conflict
        ])))
        .is_err()
    );
    assert_eq!(
        before,
        (
            std::fs::read(&state).unwrap(),
            std::fs::read(&view).unwrap()
        )
    );
    let mut spoof = event(30, Status::Working);
    spoof.actor.as_mut().unwrap().kind = ActorKind::Agent;
    assert!(reduce(&c, None, &ingest(vec![spoof])).is_err());
    assert!(reduce(&c, None, &ingest(vec![event(30, Status::Merged)])).is_err());
}

#[test]
fn a_view_write_interruption_is_repaired_from_the_authoritative_checkpoint() {
    let c = config();
    let dir = tempfile::tempdir().unwrap();
    let state = dir.path().join("state.json");
    let blocked_output = dir.path().join("directory-not-a-file");
    std::fs::create_dir(&blocked_output).unwrap();
    assert!(
        store::transaction(&c, &state, &blocked_output, |_| Ok(ingest(vec![event(
            10,
            Status::Working
        )])))
        .is_err()
    );
    let committed: Checkpoint = store::read_json(&state).unwrap();
    assert_eq!(committed.heads["ci:run/1"].event.status, Status::Working);
    let output = dir.path().join("recovered-view.json");
    store::atomic_json(&output, &project(&c, &committed).unwrap()).unwrap();
    assert_eq!(
        store::read_json::<View>(&output).unwrap(),
        project(&c, &committed).unwrap()
    );
}

#[test]
fn source_failures_and_old_runtime_reads_cannot_renew_liveness() {
    let c = config();
    let state = reduce(&c, None, &ingest(vec![event(10, Status::Working)])).unwrap();
    let future = reduce(
        &c,
        Some(&state),
        &Ingest {
            as_of: at() + TimeDelta::seconds(181),
            batches: vec![],
        },
    )
    .unwrap();
    let view = project(&c, &future).unwrap();
    assert!(!view.sources[0].fresh);
    assert_eq!(view.departments[0].running_automations, 0);
    assert_eq!(view.departments[0].activities[0].status, Status::Unknown);
    let c = runtime_config();
    let raw = json!({"source":"cma","observed_at":at(),"after":0,"items":[{"agent_id":"private-resource","seq":1,"appended_at":at(),"kind":{"type":"turn_started","turn_sequence":1}}]});
    let batch = adapters::cma(&c, serde_json::from_value(raw).unwrap(), None).unwrap();
    let state = reduce(
        &c,
        None,
        &Ingest {
            as_of: at(),
            batches: vec![batch],
        },
    )
    .unwrap();
    let batch = Batch {
        source: "cma".into(),
        observed_at: at() + TimeDelta::seconds(181),
        cursor: Some(Cursor {
            after: 1,
            through: 1,
        }),
        complete: true,
        events: vec![],
    };
    let next = reduce(
        &c,
        Some(&state),
        &Ingest {
            as_of: at() + TimeDelta::seconds(181),
            batches: vec![batch],
        },
    )
    .unwrap();
    assert!(project(&c, &next).unwrap().sources[3].fresh);
    assert_eq!(
        project(&c, &next).unwrap().departments[0].running_sessions,
        0
    );
}

#[test]
fn clocks_authority_changes_and_corrupt_checkpoints_are_rejected() {
    let c = config();
    let state = reduce(&c, None, &ingest(vec![event(10, Status::Working)])).unwrap();
    let mut future = event(20, Status::Succeeded);
    future.at = at() + TimeDelta::seconds(1);
    assert!(reduce(&c, Some(&state), &ingest(vec![future])).is_err());
    let mut changed = c.clone();
    changed.sources[0].repository = Some("other/repo".into());
    assert!(reduce(&changed, Some(&state), &ingest(vec![])).is_err());
    let mut corrupt = state.clone();
    corrupt.heads.get_mut("ci:run/1").unwrap().event.url = Some("javascript:alert(1)".into());
    assert!(reduce(&c, Some(&corrupt), &ingest(vec![])).is_err());
    let mut backwards = ingest(vec![]);
    backwards.as_of = at() - TimeDelta::seconds(1);
    assert!(reduce(&c, Some(&state), &backwards).is_err());
}

#[test]
fn native_github_projection_preserves_execution_meaning_and_discards_bodies() {
    let c = config();
    let raw = json!({"id":12,"path":".github/workflows/ci.yml","run_attempt":2,"status":"completed","conclusion":"success","updated_at":at(),"html_url":format!("https://github.com/{REPO}/actions/runs/12"),"actor":{"login":"human-account"},"head_sha":"a".repeat(40),"logs_url":"private","pull_requests":[{"number":42}]});
    let input = GithubObservation {
        source: "ci".into(),
        observed_at: at(),
        repository: RepositoryVisibility {
            full_name: REPO.into(),
            private: false,
            visibility: "public".into(),
        },
        complete: false,
        items: vec![raw.clone()],
    };
    let batch = adapters::github(&c, input.clone()).unwrap();
    assert_eq!(batch.events[0].generation, 2);
    assert_eq!(batch.events[0].task.as_ref().unwrap().number, 42);
    let state = reduce(
        &c,
        None,
        &Ingest {
            as_of: at(),
            batches: vec![batch],
        },
    )
    .unwrap();
    let view = project(&c, &state).unwrap();
    let output = serde_json::to_string(&view).unwrap();
    assert!(!output.contains("head_sha"));
    assert!(!output.contains("logs_url"));
    assert!(!output.contains(&"a".repeat(40)));
    assert_eq!(view.departments[0].running_sessions, 0);
    assert_eq!(view.departments[0].activities[0].status, Status::Succeeded);
    let mut private = input;
    private.repository.private = true;
    assert!(adapters::github(&c, private).is_err());
    let mut wrong = raw;
    wrong["path"] = json!(".github/workflows/unrelated.yml");
    let mut input = GithubObservation {
        source: "ci".into(),
        observed_at: at(),
        repository: RepositoryVisibility {
            full_name: REPO.into(),
            private: false,
            visibility: "public".into(),
        },
        complete: true,
        items: vec![wrong],
    };
    assert!(
        adapters::github(&c, input.clone())
            .unwrap()
            .events
            .is_empty()
    );
    input.repository.visibility = "internal".into();
    assert!(adapters::github(&c, input).is_err());
}

#[test]
fn handoffs_need_explicit_references_and_bare_problem_numbers_do_not_link() {
    let c = config();
    let refs = adapters::references(
        "Erdős #985. Research issue #42. example-org/books#8. https://github.com/other/repo/issues/3",
        &c,
        REPO,
    );
    assert_eq!(refs.len(), 2);
    assert!(!refs.iter().any(|r| r.number == 985));
    let mut question = event(10, Status::Open);
    question.source = "issues".into();
    question.subject = "task/42".into();
    question.kind = ActivityKind::Task;
    question.task = Some(Reference {
        repository: REPO.into(),
        number: 42,
    });
    question.url = Some(format!("https://github.com/{REPO}/issues/42"));
    let mut book = question.clone();
    book.source = "books".into();
    book.subject = "task/8".into();
    book.kind = ActivityKind::Contribution;
    book.url = Some("https://github.com/example-org/books/pull/8".into());
    book.task = Some(Reference {
        repository: "example-org/books".into(),
        number: 8,
    });
    let input = |book: Event| Ingest {
        as_of: at(),
        batches: vec![
            Batch {
                source: "issues".into(),
                observed_at: at(),
                cursor: None,
                complete: false,
                events: vec![question.clone()],
            },
            Batch {
                source: "books".into(),
                observed_at: at(),
                cursor: None,
                complete: false,
                events: vec![book],
            },
        ],
    };
    assert!(
        project(&c, &reduce(&c, None, &input(book.clone())).unwrap())
            .unwrap()
            .handoffs
            .is_empty()
    );
    book.references.push(Reference {
        repository: REPO.into(),
        number: 42,
    });
    let view = project(&c, &reduce(&c, None, &input(book)).unwrap()).unwrap();
    assert_eq!(view.handoffs.len(), 1);
    assert_eq!(view.handoffs[0].from, "research");
    assert_eq!(view.handoffs[0].to, "books");
}

#[test]
fn cma_cursor_covers_discarded_content_and_restart_recovers_without_transcripts() {
    let c = runtime_config();
    let raw = json!({"source":"cma","observed_at":at(),"after":0,"items":[{"agent_id":"private-resource","seq":1,"appended_at":at(),"kind":{"type":"turn_started","turn_sequence":1,"model":"private-model-config"}},{"agent_id":"private-resource","seq":2,"appended_at":at(),"kind":{"type":"owner_message","content":"secret prompt /Users/private sk-credential"}},{"agent_id":"private-resource","seq":3,"appended_at":at(),"kind":{"type":"turn_completed","turn_sequence":1}}]});
    let batch = adapters::cma(&c, serde_json::from_value(raw).unwrap(), None).unwrap();
    assert_eq!(batch.events.len(), 2);
    assert_eq!(batch.cursor.as_ref().unwrap().through, 3);
    let state = reduce(
        &c,
        None,
        &Ingest {
            as_of: at(),
            batches: vec![batch],
        },
    )
    .unwrap();
    let restored: Checkpoint =
        serde_json::from_slice(&serde_json::to_vec(&state).unwrap()).unwrap();
    let page = json!({"source":"cma","observed_at":at(),"after":3,"items":[{"agent_id":"private-resource","seq":4,"appended_at":at(),"kind":{"type":"turn_started","turn_sequence":2}}]});
    let batch = adapters::cma(&c, serde_json::from_value(page).unwrap(), Some(&restored)).unwrap();
    let next = reduce(
        &c,
        Some(&restored),
        &Ingest {
            as_of: at(),
            batches: vec![batch],
        },
    )
    .unwrap();
    let view = project(&c, &next).unwrap();
    assert_eq!(view.departments[0].running_sessions, 1);
    let output = serde_json::to_string(&view).unwrap();
    for private in [
        "secret prompt",
        "private-resource",
        "private-model-config",
        "sk-credential",
    ] {
        assert!(!output.contains(private));
    }
    let page = json!({"source":"cma","observed_at":at(),"after":0,"items":[{"agent_id":"private-resource","seq":2,"appended_at":at(),"kind":{"type":"owner_message","content":"ignored"}}]});
    assert!(adapters::cma(&c, serde_json::from_value(page).unwrap(), None).is_err());
}

#[test]
fn gateway_delivery_never_becomes_agent_completion_or_presence() {
    let c = runtime_config();
    let input = json!({"source":"gateway","observed_at":at(),"conversation_id":"private-conversation","event_id":"event-1","event_timestamp":at(),"forwarded_at":at(),"outcome":"delivered"});
    let batch = adapters::nyxid(&c, serde_json::from_value(input).unwrap()).unwrap();
    let view = project(
        &c,
        &reduce(
            &c,
            None,
            &Ingest {
                as_of: at(),
                batches: vec![batch],
            },
        )
        .unwrap(),
    )
    .unwrap();
    assert_eq!(
        view.departments[1].activities[0].kind,
        ActivityKind::Delivery
    );
    assert_eq!(view.departments[1].running_sessions, 0);
    assert_eq!(view.departments[1].running_automations, 0);
    assert!(
        !serde_json::to_string(&view)
            .unwrap()
            .contains("private-conversation")
    );
}

#[test]
fn bounded_state_expires_without_resurrecting_old_observations() {
    let mut c = config();
    c.max_entities = 1;
    let first = event(10, Status::Succeeded);
    let mut second = event(20, Status::Working);
    second.subject = "run/2".into();
    assert!(reduce(&c, None, &ingest(vec![first.clone(), second])).is_err());
    let state = reduce(&c, None, &ingest(vec![first.clone()])).unwrap();
    let mut old = ingest(vec![first]);
    old.as_of = at() + TimeDelta::seconds(86401);
    old.batches[0].observed_at = old.as_of;
    let next = reduce(&c, Some(&state), &old).unwrap();
    assert!(next.heads.is_empty());
    assert!(next.recent.is_empty());
}

#[test]
fn concurrent_runtime_replayers_cannot_both_advance_the_same_cursor() {
    let c = runtime_config();
    let dir = tempfile::tempdir().unwrap();
    let state = dir.path().join("state.json");
    let output = dir.path().join("view.json");
    let workers:Vec<_>=(0..2).map(|_|{let c=c.clone();let state=state.clone();let output=output.clone();std::thread::spawn(move||{
        store::transaction(&c,&state,&output,|prior|{
            let raw=json!({"source":"cma","observed_at":at(),"after":0,"items":[{"agent_id":"private-resource","seq":1,"appended_at":at(),"kind":{"type":"turn_started","turn_sequence":1}}]});
            Ok(Ingest{as_of:at(),batches:vec![adapters::cma(&c,serde_json::from_value(raw).unwrap(),prior)?]})
        }).is_ok()
    })}).collect();
    assert_eq!(
        workers
            .into_iter()
            .filter_map(|w| w.join().ok())
            .filter(|ok| *ok)
            .count(),
        1
    );
    let saved: Checkpoint = store::read_json(&state).unwrap();
    assert_eq!(saved.sources["cma"].cursor, 1);
    assert_eq!(
        project(&c, &saved).unwrap(),
        store::read_json::<View>(&output).unwrap()
    );
}
