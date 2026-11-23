# AI organization live harness

Map an organization's existing GitHub activity into departments, responsibilities,
tasks, participants and actual cross-repository handoffs. The Rust library and CLI
produce a stable, human-interface-ready JSON view. **This template contains no UI.**

The source adapters, reducer and persistence layer are independent of trureturing.
Organizations own their configuration, credentials, storage, publishing and UI.
Nothing here assigns work, launches agents, changes observed repositories or sends
messages. The trureturing deployment is maintained in
[trureturing-live](https://github.com/the-omega-institute/trureturing-live).

## Start with GitHub

1. Use this template, or install the CLI from a pinned release. The pinned Rust 1.95.0
   builds the locked source with `cargo build --release --locked`.
2. Copy `examples/organization.json` to `organization.json`. Replace the repository
   placeholders and workflow paths; edit department names, responsibilities and
   routes. Repository paths and routing are explicit, not guessed from titles.
3. Validate and collect. `GH_TOKEN` is optional for public reads, but authenticated
   collection is strongly preferable for a continuously running observer.

```sh
live-harness check --config organization.json
live-harness collect --config organization.json \
  --state .live-state/checkpoint.json --output public/organization.json
```

Run the same collection command approximately once a minute from your existing
worker, scheduler or GitHub Action. Keep one writer per checkpoint; the local store
also uses an OS file lock. Persist `.live-state/` on durable storage between workers.
Publish **only** the output view, never the checkpoint or raw adapter input. The
checkpoint contains source identifiers needed for recovery and is created with
owner-only permissions on Unix.

The GitHub collector reads public repository metadata before activity. It reads
bounded issues, PRs, discussion and inline review comments. Actions sources can
select exact workflow files. Recent runs and separately sampled active/waiting
runs are combined, so a long-running coordinator is not hidden by newer CI runs.
Pagination limits remain explicit; counts describe observed activities.

The process prints source-level read failures to stderr without credentials or
response bodies. Successful sources update independently. A failed source retains
its last observation and becomes stale; a total outage exits nonzero and preserves
both published files. The caller should retry with normal backoff, retaining the
original process/job handle while a job remains active.

Each source can set `poll_seconds` (default 60) and `freshness_seconds` (otherwise
the organization default). Busy research and coordinator sources can update every
minute while infrequently changing tools are checked every five minutes. A private
HTTP cache beside the checkpoint keeps ETags and bounded native responses. Requests
still reach GitHub; authenticated 304 responses avoid primary API quota charges.
This cache is an optimization, never the public view. Do not publish it. Collection
statistics separate total requests from responses that were not 304.
Cadence is measured from the previous collection's start, with 500 ms of launch
jitter tolerance. Request latency does not double a one-minute worker's interval;
data freshness continues to use each source's actual successful observation time.

## Meaning of the view

- GitHub accounts are participants, not independently identified AI sessions.
- `running_automations` counts fresh workflow runs with `in_progress` status.
- `running_sessions` requires an explicitly enabled runtime source and a fresh
  lifecycle event. Polling an old event does not renew a session's presence.
- A successful workflow is successful execution. A merged PR is a merged
  contribution. Neither is promoted to a proven mathematical result or sent email.
- Configured `routes` describe responsibilities. Entries in `handoffs` currently
  carry `kind: reference`: an explicit source link to a task observed in another
  department. They establish a research connection, not a private dispatch, direct
  message or transfer of responsibility.

## Runtime imports

Independent Codex / Claude / AGY / heca sessions can use `report` without running
inside CMA. Add a source such as the following to your organization's `sources`:

```json
{"id":"researcher-a","kind":"session","department":"research","label":"Research seat A",
 "runtime":{"resource_id":"your-private-session-binding",
 "actor":{"id":"researcher-a","label":"Researcher A","kind":"agent","tool":"Codex"},
 "public_label":"Developing the current proof","publish":true}}
```

The session's own integration reports the state it actually knows. `report`
generates the next cursor under the checkpoint lock, so separate command
invocations recover consistently. While work continues, emit a fresh `working`
report before the configured lease expires; emit `waiting`, `succeeded`, `failed`
or `cancelled` when that phase changes. A settled generation cannot work again;
start a new generation for a new turn/run. The command does not inspect a process
or infer that an open terminal is doing research.

```sh
live-harness report --config organization.json --source researcher-a \
  --generation 1 --status working --task YOUR-ORG/YOUR-RESEARCH-REPO#42 \
  --state .live-state/checkpoint.json --output public/organization.json
```

Private bindings stay in the local checkpoint. Only the owner-approved public
role, tool, status and registered public task appear in the output. Connect the
output through your deployment's authorized transport; this command does not send
it to GitHub, a public server or any other person.

Runtime imports operate on **owner-supplied local files**. The harness does not
discover sessions, request CMA/NyxID credentials, connect to private endpoints or
publish transcripts. Explicitly register a `cma` or `nyxid` source with its resource
binding, public actor, public label and `publish: true` before importing.

`import-cma` accepts a contiguous page of CMA's durable `AgentLogEntry` records
(`agent_id`, `seq`, `appended_at`, `kind`) plus an `after` cursor. It projects only
lifecycle statuses and advances through discarded content events without storing
their text. It fences turns with `turn_sequence` and rejects gaps or foreign agents.
`import-nyxid` accepts an explicitly reduced gateway **delivery receipt**, never an
event payload or conversation. It reports delivery status, not agent completion.
Current wire shapes and source references are in [the contract](docs/CONTRACT.md).
These adapters are tested against representative wire fixtures; deployment access
and compatibility with a specific live service must be separately established.

```sh
live-harness import-cma --config organization.json --input authorized-page.json \
  --at 2026-11-23T12:00:00Z --state .live-state/checkpoint.json \
  --output public/organization.json
```

## Reproduce and recover

`ingest` accepts the strict normalized `Ingest` contract. `import-github` accepts
allowlisted native observations from another existing reader. `replay` accepts an
array of normalized transactions, ordered by explicit `as_of` timestamps, and
builds the view offline from an empty state. No wall clock or network participates
in reduction or projection.

```sh
live-harness replay --config organization.json --input transactions.json \
  --output replay.json
live-harness project --config organization.json --state .live-state/checkpoint.json \
  --at 2026-11-23T12:05:00Z --output public/organization.json
```

The checkpoint is authoritative. If a crash happens after its atomic rename but
before the view rename, `project` regenerates the view. Invalid input cannot
partially update the checkpoint. New sources can be added; presentation labels and
department assignments can change. Changing an existing source's authority
(repository, runtime binding or workflow selection) is rejected: register a new
source identity rather than silently relabeling old observations.

## Validate changes

```sh
cargo fmt --all --check
cargo clippy --locked --all-targets -- -D warnings
cargo test --locked
```

Tests cover reordered events, idempotency, conflicting duplicates, stale presence,
new attempts, poisoned transactions, crash recovery, concurrent replay, native
adapter boundaries, content exclusion and bounded retention. The implementation's
current limits and the upstream designs it draws on are documented in the contract.

Code: MIT. Original source records retain their authorship and repository identity.
