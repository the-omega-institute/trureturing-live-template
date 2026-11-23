use live_harness::{model::*, store};
use serde_json::json;
use std::process::Command;

#[test]
fn cli_reports_survive_process_restarts_without_exposing_private_session_ids() {
    let dir = tempfile::tempdir().unwrap();
    let config_path = dir.path().join("organization.json");
    let state = dir.path().join("state.json");
    let output = dir.path().join("public.json");
    let mut config: serde_json::Value = serde_json::from_slice(
        &std::fs::read(concat!(
            env!("CARGO_MANIFEST_DIR"),
            "/examples/organization.json"
        ))
        .unwrap(),
    )
    .unwrap();
    config["sources"].as_array_mut().unwrap().push(json!({"id":"codex-research","kind":"session","department":"research","label":"Research seat","runtime":{"resource_id":"not-a-public-session-id","actor":{"id":"research-seat-a","label":"Researcher A","kind":"agent","tool":"Codex"},"public_label":"Exploring the current problem","publish":true}}));
    store::atomic_json(&config_path, &config).unwrap();
    let invoke = |status: &str, generation: &str| {
        Command::new(env!("CARGO_BIN_EXE_live-harness"))
            .args(["report", "--config"])
            .arg(&config_path)
            .args([
                "--source",
                "codex-research",
                "--generation",
                generation,
                "--status",
                status,
                "--task",
                "YOUR-ORG/YOUR-RESEARCH-REPO#42",
                "--state",
            ])
            .arg(&state)
            .arg("--output")
            .arg(&output)
            .output()
            .unwrap()
    };
    assert!(invoke("working", "1").status.success());
    assert_eq!(
        store::read_json::<View>(&output).unwrap().departments[0].running_sessions,
        1
    );
    assert!(invoke("succeeded", "1").status.success());
    let before = std::fs::read(&output).unwrap();
    assert!(!invoke("working", "1").status.success());
    assert_eq!(before, std::fs::read(&output).unwrap());
    assert!(invoke("working", "2").status.success());
    let view = store::read_json::<View>(&output).unwrap();
    assert_eq!(view.departments[0].running_sessions, 1);
    let public = std::fs::read_to_string(output).unwrap();
    assert!(!public.contains("not-a-public-session-id"));
    assert!(public.contains("Codex"));
}
