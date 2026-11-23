use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;

pub const CONFIG_SCHEMA: &str = "ai-org.config.v1";
pub const EVENT_SCHEMA: &str = "ai-org.event.v1";
pub const STATE_SCHEMA: &str = "ai-org.checkpoint.v1";
pub const VIEW_SCHEMA: &str = "ai-org.live.v1";

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct Config {
    pub schema: String,
    pub organization: Organization,
    pub departments: Vec<Department>,
    pub sources: Vec<Source>,
    #[serde(default)]
    pub routes: Vec<Route>,
    pub freshness_seconds: u32,
    pub retention_seconds: u32,
    pub max_entities: usize,
    pub max_recent_events: usize,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct Organization {
    pub id: String,
    pub label: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct Department {
    pub id: String,
    pub label: String,
    pub responsibility: String,
    pub execution: Execution,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum Execution {
    Sessions,
    Actions,
    Mixed,
    Human,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct Route {
    pub from: String,
    pub to: String,
    pub label: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct Source {
    pub id: String,
    pub kind: SourceKind,
    pub department: String,
    pub label: String,
    pub repository: Option<String>,
    #[serde(default)]
    pub workflow_paths: Vec<String>,
    // Runtime sources are local imports only. This binding must be deliberately
    // configured by the owner; a wire event cannot choose its public identity.
    pub runtime: Option<RuntimeBinding>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct RuntimeBinding {
    pub resource_id: String,
    pub actor: Actor,
    pub public_label: String,
    pub publish: bool,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum SourceKind {
    GithubActions,
    GithubIssues,
    GithubPulls,
    GithubComments,
    GithubReviews,
    Cma,
    Nyxid,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct Actor {
    pub id: String,
    pub label: String,
    pub kind: ActorKind,
    pub tool: Option<String>,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum ActorKind {
    Account,
    Agent,
    Automation,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum ActivityKind {
    Task,
    Contribution,
    Discussion,
    Review,
    Automation,
    Session,
    Delivery,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum Status {
    Open,
    Claimed,
    Working,
    Waiting,
    Reviewing,
    ChangesRequested,
    Ready,
    Succeeded,
    Failed,
    Cancelled,
    Closed,
    Merged,
    Unknown,
}

impl Status {
    pub fn is_active(self) -> bool {
        matches!(self, Self::Working | Self::Waiting | Self::Reviewing)
    }
    pub fn is_terminal(self) -> bool {
        matches!(
            self,
            Self::Succeeded | Self::Failed | Self::Cancelled | Self::Closed | Self::Merged
        )
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct Reference {
    pub repository: String,
    pub number: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct Event {
    pub schema: String,
    pub id: String,
    pub source: String,
    pub subject: String,
    pub generation: u64,
    pub sequence: u64,
    pub at: DateTime<Utc>,
    pub kind: ActivityKind,
    pub status: Status,
    pub label: String,
    pub actor: Option<Actor>,
    pub url: Option<String>,
    pub task: Option<Reference>,
    #[serde(default)]
    pub references: Vec<Reference>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct Cursor {
    pub after: u64,
    pub through: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct Batch {
    pub source: String,
    pub observed_at: DateTime<Utc>,
    pub cursor: Option<Cursor>,
    pub complete: bool,
    pub events: Vec<Event>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct Ingest {
    pub as_of: DateTime<Utc>,
    pub batches: Vec<Batch>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct Head {
    pub event: Event,
    pub confirmed_at: DateTime<Utc>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct Checkpoint {
    pub schema: String,
    pub organization: String,
    pub as_of: DateTime<Utc>,
    pub bindings: BTreeMap<String, String>,
    pub heads: BTreeMap<String, Head>,
    pub sources: BTreeMap<String, SourceCheckpoint>,
    pub recent: Vec<Event>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct SourceCheckpoint {
    pub observed_at: DateTime<Utc>,
    pub cursor: u64,
    pub complete: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct View {
    pub schema: String,
    pub organization: Organization,
    pub observed_at: DateTime<Utc>,
    pub departments: Vec<DepartmentView>,
    pub routes: Vec<Route>,
    pub handoffs: Vec<Handoff>,
    pub recent: Vec<Activity>,
    pub sources: Vec<SourceView>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct DepartmentView {
    #[serde(flatten)]
    pub department: Department,
    pub running_automations: usize,
    pub running_sessions: usize,
    pub participants: Vec<Actor>,
    pub activities: Vec<Activity>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct Activity {
    pub id: String,
    pub source: String,
    pub department: String,
    pub kind: ActivityKind,
    pub status: Status,
    pub label: String,
    pub actor: Option<Actor>,
    pub at: DateTime<Utc>,
    pub url: Option<String>,
    pub task: Option<Reference>,
    pub references: Vec<Reference>,
    pub fresh: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct SourceView {
    pub id: String,
    pub label: String,
    pub kind: SourceKind,
    pub observed_at: Option<DateTime<Utc>>,
    pub fresh: bool,
    pub complete: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct Handoff {
    pub from: String,
    pub to: String,
    pub activity: String,
    pub reference: Reference,
    pub url: Option<String>,
}
