use crate::{
    Error, Result,
    adapters::{self, GithubObservation, RepositoryVisibility},
    model::*,
};
use chrono::{DateTime, Utc};
use reqwest::blocking::Client;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::{
    collections::{BTreeMap, VecDeque},
    io::Read,
    sync::{
        Arc, Mutex,
        atomic::{AtomicUsize, Ordering},
    },
    time::Duration,
};

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
    pub charged_requests: usize,
    #[serde(skip)]
    pub cache: ReaderCache,
}

pub type ReaderCache = BTreeMap<String, CachedResponse>;
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct CachedResponse {
    etag: String,
    value: Value,
    complete: bool,
}

fn source_poll_key(id: &str) -> String {
    serde_json::to_string(&("__source_poll", id)).expect("string tuple serialization")
}

/// Cadence uses the previous collection start; freshness still uses the actual
/// successful observation time. Allow 500 ms of scheduler/launch jitter.
pub fn poll_due(
    source: &Source,
    cache: &ReaderCache,
    previous: Option<&Checkpoint>,
    at: DateTime<Utc>,
) -> bool {
    if source.runtime.is_some() {
        return false;
    }
    let started = cache
        .get(&source_poll_key(&source.id))
        .and_then(|entry| serde_json::from_value::<DateTime<Utc>>(entry.value.clone()).ok())
        .filter(|started| *started <= at);
    let last = started.or_else(|| {
        previous
            .and_then(|p| p.sources.get(&source.id))
            .map(|s| s.observed_at)
    });
    last.is_none_or(|last| {
        at.signed_duration_since(last).num_milliseconds()
            >= i64::from(source.poll_seconds) * 1000 - 500
    })
}

struct Reader {
    client: Client,
    token: String,
    requests: usize,
    charged_requests: usize,
    cache: ReaderCache,
    budget: Arc<AtomicUsize>,
}
impl Reader {
    fn get(&mut self, path: &str, query: &[(&str, &str)]) -> Result<(Value, bool)> {
        let mut reserved = self.budget.load(Ordering::Relaxed);
        loop {
            if reserved >= 80 {
                return Err(Error::Source("collection request budget reached".into()));
            }
            match self.budget.compare_exchange_weak(
                reserved,
                reserved + 1,
                Ordering::Relaxed,
                Ordering::Relaxed,
            ) {
                Ok(_) => break,
                Err(current) => reserved = current,
            }
        }
        self.requests += 1;
        let cache_key = serde_json::to_string(&(path, query))?;
        let mut request = self
            .client
            .get(format!("https://api.github.com{path}"))
            .query(query)
            .header("Accept", "application/vnd.github+json")
            .header("X-GitHub-Api-Version", "2022-11-28");
        if !self.token.is_empty() {
            request = request.bearer_auth(&self.token);
        }
        if let Some(cached) = self.cache.get(&cache_key) {
            request = request.header("If-None-Match", &cached.etag);
        }
        let response = request
            .send()
            .map_err(|_| Error::Source("GitHub transport unavailable".into()))?;
        if response.status() == reqwest::StatusCode::NOT_MODIFIED {
            let cached = self
                .cache
                .get(&cache_key)
                .ok_or_else(|| Error::Source("unbound conditional response".into()))?;
            return Ok((cached.value.clone(), cached.complete));
        }
        self.charged_requests += 1;
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
        let etag = response
            .headers()
            .get("etag")
            .and_then(|h| h.to_str().ok())
            .map(str::to_owned);
        let mut bytes = Vec::new();
        response.take(8 * 1024 * 1024 + 1).read_to_end(&mut bytes)?;
        if bytes.len() > 8 * 1024 * 1024 {
            return Err(Error::Source("GitHub response exceeds byte bound".into()));
        }
        let value: Value = serde_json::from_slice(&bytes)?;
        if let Some(etag) = etag {
            self.cache.insert(
                cache_key,
                CachedResponse {
                    etag,
                    value: value.clone(),
                    complete,
                },
            );
        } else {
            self.cache.remove(&cache_key);
        }
        Ok((value, complete))
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

pub fn collect(
    config: &Config,
    token: String,
    cache: ReaderCache,
    previous: Option<&Checkpoint>,
) -> Result<Collection> {
    crate::validate_config(config)?;
    let client = Client::builder()
        .timeout(Duration::from_secs(15))
        .redirect(reqwest::redirect::Policy::none())
        .user_agent("ai-org-live-harness/0.1")
        .build()
        .map_err(|_| Error::Source("HTTP client initialization failed".into()))?;
    let mut groups: BTreeMap<&str, Vec<&Source>> = BTreeMap::new();
    let started_at = Utc::now();
    for source in &config.sources {
        if !poll_due(source, &cache, previous, started_at) {
            continue;
        }
        groups
            .entry(source.repository.as_deref().unwrap())
            .or_default()
            .push(source);
    }
    let attempted = groups.values().map(Vec::len).sum::<usize>();
    let queue = Mutex::new(VecDeque::from_iter(groups));
    let budget = Arc::new(AtomicUsize::new(0));
    let results = std::thread::scope(|scope| {
        let mut workers = Vec::new();
        for _ in 0..4 {
            workers.push(scope.spawn(|| {
                let mut results = Vec::new();
                loop {
                    let group = queue.lock().unwrap().pop_front();
                    let Some((repo, sources)) = group else {
                        break;
                    };
                    let prefix = format!("/repos/{repo}/");
                    let mut reader = Reader {
                        client: client.clone(),
                        token: token.clone(),
                        requests: 0,
                        charged_requests: 0,
                        cache: cache
                            .iter()
                            .filter(|(key, _)| {
                                serde_json::from_str::<(String, Value)>(key).is_ok_and(
                                    |(path, _)| {
                                        path == format!("/repos/{repo}")
                                            || path.starts_with(&prefix)
                                    },
                                )
                            })
                            .map(|(key, value)| (key.clone(), value.clone()))
                            .collect(),
                        budget: budget.clone(),
                    };
                    let mut metadata = BTreeMap::new();
                    let mut batches = Vec::new();
                    let mut failures = Vec::new();
                    let mut repository_failure: Option<String> = None;
                    for source in sources {
                        if let Some(reason) = &repository_failure {
                            failures.push(SourceFailure {
                                source: source.id.clone(),
                                reason: reason.clone(),
                            });
                            continue;
                        }
                        match reader
                            .observe(source, &mut metadata)
                            .and_then(|input| adapters::github(config, input))
                        {
                            Ok(batch) => batches.push(batch),
                            Err(error) => {
                                let reason = error.to_string();
                                if metadata.is_empty() {
                                    repository_failure = Some(reason.clone());
                                }
                                failures.push(SourceFailure {
                                    source: source.id.clone(),
                                    reason,
                                });
                            }
                        }
                    }
                    results.push((
                        batches,
                        failures,
                        reader.requests,
                        reader.charged_requests,
                        reader.cache,
                    ));
                }
                results
            }));
        }
        workers
            .into_iter()
            .map(|worker| {
                worker
                    .join()
                    .map_err(|_| Error::Source("source reader worker failed".into()))
            })
            .collect::<Result<Vec<_>>>()
    })?;
    let mut batches = Vec::new();
    let mut failures = Vec::new();
    let mut requests = 0;
    let mut charged_requests = 0;
    let mut cache = cache;
    for (mut read_batches, mut read_failures, read_requests, charged, entries) in
        results.into_iter().flatten()
    {
        batches.append(&mut read_batches);
        failures.append(&mut read_failures);
        requests += read_requests;
        charged_requests += charged;
        cache.extend(entries);
    }
    batches.sort_by(|a, b| a.source.cmp(&b.source));
    failures.sort_by(|a, b| a.source.cmp(&b.source));
    for batch in &batches {
        cache.insert(
            source_poll_key(&batch.source),
            CachedResponse {
                etag: String::new(),
                value: serde_json::to_value(started_at)?,
                complete: true,
            },
        );
    }
    if attempted > 0 && batches.is_empty() {
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
        requests,
        charged_requests,
        cache,
    })
}
