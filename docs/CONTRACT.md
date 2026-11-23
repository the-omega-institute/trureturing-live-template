# Event and projection contract v1

The public product is `ai-org.live.v1`. The input registry is `ai-org.config.v1`,
normalized events are `ai-org.event.v1`, and the private recovery document is
`ai-org.checkpoint.v1`. Rust's serde models reject unknown fields at these owned
boundaries. Native GitHub/CMA input is reduced through explicit allowlists.

## Identity and authority

An organization owns departments and source registrations. A source has one kind,
one repository or runtime resource binding, and one receiving department. Authority
bindings are fingerprinted in the checkpoint and cannot change silently. A GitHub
account remains an account even if it submitted an agent-generated contribution.
A runtime agent's public name and tool come from the owner's registration, never
from an untrusted event's self-description. CMA is a runtime platform; Codex is a
model/tool provider. A workflow runner is neither a model nor a human employee.

GitHub repository metadata must explicitly say `private: false` and
`visibility: public`. Every outgoing record has a source identity. GitHub URLs are
HTTPS links to the registered repository. Runtime view identifiers are one-way
public keys; raw resource identifiers and private runtime content stay in the local
input/checkpoint. Source and actor labels in runtime imports are owner-approved.

## Event ordering and replay

Events have a source-scoped `id`, entity `subject`, `generation`, positive
`sequence`, occurrence time, kind, state and bounded public metadata. Repeated
identical events are idempotent. Reusing an id or entity revision for a different
payload is rejected. Different sources have no shared sequence or implied causal
order.

GitHub run generation is `run_attempt`. Its sequence is the API `updated_at` in
milliseconds, multiplied by 16, plus the workflow lifecycle rank. Native durable
CMA `seq` supplies its sequence; `turn_sequence` fences successive turns. A
terminal workflow/turn state dominates an active state in that same generation,
regardless of delivery order. A newer generation can work again. Ordinary task
observations can reopen; code completion is not a mathematical truth status.

The pure reducer uses explicit `as_of` and never reads the clock or network. Source
observations cannot move backward; occurrence times later than `as_of` are rejected.
A source batch is one transaction. Cursor advancement and accepted observations
are committed together, and CMA page sequences must be contiguous including
content events discarded by its adapter. A concurrent/stale page cannot advance
the same cursor twice. Responsibility routes are static configuration; observed
handoffs require source references to known tasks in different departments.

## Presence, retention and gaps

Fresh Actions snapshots confirm running/waiting workflow states. A runtime
session's occurrence time governs its lease: an empty poll or replayed old event
cannot keep it online. Session state becomes `unknown` after the configured
freshness threshold. A continued working session must supply a genuine fresh
lifecycle/status event or a future, explicitly defined heartbeat adapter; this
version does not invent one. An unavailable source retains its previous timestamp.
Reading a different source cannot renew it.

The checkpoint retains the current entity heads within the configured retention
window, plus a bounded recent feed. It does not keep transcripts or an unbounded
event archive. Events older than the retention cutoff cannot recreate expired
entities. Deduplication conflict detection covers retained heads and recent events;
it is not an eternal global event-id registry. A configured entity-limit overflow
fails the whole transaction. Source pages are bounded and report coverage; an
incomplete sample is never a complete organization census.

The disk store uses an OS file lock, owner-only Unix files, write/fsync/rename and
parent-directory fsync. The checkpoint is authoritative; the public view is a
rebuildable projection. The two file renames are not a cross-file transaction. An
interruption between them is recovered by regenerating the view from the committed
checkpoint. Local locking does not coordinate different machines: the deployment
must provide one writer, or an external compare-and-swap store.

## Runtime wire adapters and validation scope

CMA import consumes a local wrapper containing `source`, `observed_at`, `after`
and `items`; each native item has `agent_id`, `seq`, `appended_at`, `kind`. The
adapter permits only the configured resource. Recognized lifecycle records include
turn start/complete/fail/interruption, status changes, approval requests and
stop/deletion. Other event content is discarded while advancing the page cursor.
Wire changes require an adapter update; fixture compatibility does not establish
live deployment access.

NyxID import consumes a reduced, owner-supplied delivery receipt: `source`,
`observed_at`, `conversation_id`, `event_id`, `event_timestamp`, `forwarded_at`,
`outcome`. Outcomes are `delivered`, `deduped`, `callback_failed`, `rate_limited`.
It does not accept payloads, metadata maps, message bodies or arbitrary upstream
URLs. A delivered/deduped gateway event has kind `delivery`; it never increments
working-session or working-automation counts and never asserts task completion.
This reduced import is intentionally distinct from NyxID's write-only device-event
envelope, which would cause a real downstream action if posted.

## Design references inspected

- [CMA durable agent events](https://github.com/ChronoAIProject/cma/blob/9981ff70eb8d6a047a3d671096db85cea1da0deb/api/crates/layer2-core/src/sandbox/event.rs): resource identity, sequence, durable lifecycle and turn fencing.
- [CMA AG-UI replay](https://github.com/ChronoAIProject/cma/blob/9981ff70eb8d6a047a3d671096db85cea1da0deb/api/crates/layer1-public/src/agui/replay.rs): cursor-based bounded replay and live following.
- [NyxID channel gateway](https://github.com/ChronoAIProject/NyxID/blob/3fae30d944829528b460775daf53aef0fa16fafc/backend/src/services/channel_event_service.rs): identity binding, scoped deduplication and delivery semantics.
- [NyxID metadata-only delivery log](https://github.com/ChronoAIProject/NyxID/blob/3fae30d944829528b460775daf53aef0fa16fafc/backend/src/models/channel_event_log.rs): transport metadata separated from conversation content.
- [Chrono Harness component entry](https://github.com/chrono-harness/chrono-harness-main): independent Rust components, explicit registries and pinned downstream adoption.
- [Chrono Harness template](https://github.com/chrono-harness/chrono-harness-template): organization-owned configuration and versioned mechanisms.
- [Books template ownership model](https://github.com/the-omega-institute/trureturing-books-template/blob/main/template.toml): separate reusable machinery from downstream content.

These are design and compatibility references. This repository does not modify,
fork, deploy or claim to implement the upstream services' authentication, task
execution or development-governance systems.
