use crate::{
    Error, Result,
    adapters::{self, GithubObservation, RepositoryVisibility},
    model::*,
};
use chrono::Utc;
use reqwest::blocking::Client;
use serde::Serialize;
use serde_json::Value;
use std::{collections::BTreeMap, io::Read, time::Duration};

#[derive(Debug, Serialize)]
pub struct SourceFailure {
    pub source: String,
    pub reason: String,
}
#[derive(Debug, Serialize)]
pub struct Collection {
    pub ingest: Ingest,
    pub failures: Vec<SourceFailure>,
    pub requests: usize,
}

struct Reader {
    client: Client,
    token: String,
    requests: usize,
}
impl Reader {
    fn get(&mut self, path: &str, query: &[(&str, &str)]) -> Result<(Value, bool)> {
        if self.requests >= 80 {
            return Err(Error::Source("collection request budget reached".into()));
        }
        self.requests += 1;
        let mut request = self
            .client
            .get(format!("https://api.github.com{path}"))
            .query(query)
            .header("Accept", "application/vnd.github+json")
            .header("X-GitHub-Api-Version", "2022-11-28");
        if !self.token.is_empty() {
            request = request.bearer_auth(&self.token);
        }
        let response = request
            .send()
            .map_err(|_| Error::Source("GitHub transport unavailable".into()))?;
        if !response.status().is_success() {
            return Err(Error::Source(format!(
                "GitHub HTTP {}",
                response.status().as_u16()
            )));
        }
        let complete = !response
            .headers()
            .get("link")
            .and_then(|h| h.to_str().ok())
            .is_some_and(|v| v.contains("rel=\"next\""));
        let mut bytes = Vec::new();
        response.take(8 * 1024 * 1024 + 1).read_to_end(&mut bytes)?;
        if bytes.len() > 8 * 1024 * 1024 {
            return Err(Error::Source("GitHub response exceeds byte bound".into()));
        }
        Ok((serde_json::from_slice(&bytes)?, complete))
    }

    fn observe(
        &mut self,
        source: &Source,
        metadata: &mut BTreeMap<String, RepositoryVisibility>,
    ) -> Result<GithubObservation> {
        let repo = source.repository.as_ref().ok_or_else(|| {
            Error::Contract("runtime sources are imported locally, not polled".into())
        })?;
        if !metadata.contains_key(repo) {
            let (row, _) = self.get(&format!("/repos/{repo}"), &[])?;
            let visibility = RepositoryVisibility {
                full_name: row["full_name"].as_str().unwrap_or("").into(),
                private: row["private"].as_bool().unwrap_or(true),
                visibility: row["visibility"].as_str().unwrap_or("unknown").into(),
            };
            if visibility.private
                || visibility.visibility != "public"
                || &visibility.full_name != repo
            {
                return Err(Error::Source("registered repository is not public".into()));
            }
            metadata.insert(repo.clone(), visibility);
        }
        let mut complete = true;
        let mut items = Vec::new();
        if source.kind == SourceKind::GithubActions {
            // Read the selected workflow itself: a busy unrelated workflow must
            // not hide the outreach coordinator in a repository-wide sample.
            let paths: Vec<_> = if source.workflow_paths.is_empty() {
                vec![format!("/repos/{repo}/actions/runs")]
            } else {
                source
                    .workflow_paths
                    .iter()
                    .map(|p| {
                        format!(
                            "/repos/{repo}/actions/workflows/{}/runs",
                            p.rsplit('/').next().unwrap()
                        )
                    })
                    .collect()
            };
            for path in paths {
                for status in ["", "in_progress", "queued", "waiting"] {
                    let mut query = vec![("per_page", "100")];
                    if !status.is_empty() {
                        query.push(("status", status));
                    }
                    let (row, page_complete) = self.get(&path, &query)?;
                    complete &= page_complete;
                    let runs = row["workflow_runs"].as_array().ok_or_else(|| {
                        Error::Source("GitHub workflow response missing runs".into())
                    })?;
                    items.extend(runs.iter().cloned());
                }
            }
            // Multiple reads may see the same run at different revisions. Keep
            // all distinct revisions; the reducer supplies ordering and fencing.
            items.sort_by_key(|r| {
                (
                    r["id"].as_u64(),
                    r["run_attempt"].as_u64(),
                    r["updated_at"].as_str().unwrap_or("").to_string(),
                    r["status"].as_str().unwrap_or("").to_string(),
                )
            });
            items.dedup();
        } else {
            let endpoint = match source.kind {
                SourceKind::GithubIssues => "issues",
                SourceKind::GithubPulls => "pulls",
                SourceKind::GithubComments => "issues/comments",
                SourceKind::GithubReviews => "pulls/comments",
                _ => unreachable!(),
            };
            let mut query = vec![
                ("per_page", "100"),
                ("sort", "updated"),
                ("direction", "desc"),
            ];
            if matches!(
                source.kind,
                SourceKind::GithubIssues | SourceKind::GithubPulls
            ) {
                query.push(("state", "all"));
            }
            let (row, page_complete) = self.get(&format!("/repos/{repo}/{endpoint}"), &query)?;
            complete = page_complete;
            items = row
                .as_array()
                .ok_or_else(|| Error::Source("GitHub response missing list".into()))?
                .clone();
        }
        Ok(GithubObservation {
            source: source.id.clone(),
            observed_at: Utc::now(),
            repository: metadata[repo].clone(),
            complete,
            items,
        })
    }
}

pub fn collect(config: &Config, token: String) -> Result<Collection> {
    crate::validate_config(config)?;
    let client = Client::builder()
        .timeout(Duration::from_secs(15))
        .redirect(reqwest::redirect::Policy::none())
        .user_agent("ai-org-live-harness/0.1")
        .build()
        .map_err(|_| Error::Source("HTTP client initialization failed".into()))?;
    let mut reader = Reader {
        client,
        token,
        requests: 0,
    };
    let mut metadata = BTreeMap::new();
    let mut batches = Vec::new();
    let mut failures = Vec::new();
    for source in &config.sources {
        if source.runtime.is_some() {
            continue;
        }
        match reader
            .observe(source, &mut metadata)
            .and_then(|input| adapters::github(config, input))
        {
            Ok(batch) => batches.push(batch),
            Err(error) => failures.push(SourceFailure {
                source: source.id.clone(),
                reason: error.to_string(),
            }),
        }
    }
    if batches.is_empty() {
        return Err(Error::Source(
            "no current source readings; existing checkpoint retained".into(),
        ));
    }
    Ok(Collection {
        ingest: Ingest {
            as_of: Utc::now(),
            batches,
        },
        failures,
        requests: reader.requests,
    })
}
