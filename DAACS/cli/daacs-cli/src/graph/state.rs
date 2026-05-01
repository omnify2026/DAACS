//! CLI state and core workflow enums.

use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::path::PathBuf;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CLIState {
    // Interview context
    pub goal: String,
    pub interview_history: Vec<InterviewTurn>,
    pub interview_context: HashMap<String, String>,
    pub tech_stack: HashMap<String, String>,
    pub features: Vec<String>,

    // Documents
    pub daacs_content: Option<String>,
    pub plan_content: Option<String>,
    pub daacs_path: Option<PathBuf>,
    pub plan_path: Option<PathBuf>,

    // Paths
    pub project_path: PathBuf,
    pub backend_path: PathBuf,
    pub frontend_path: PathBuf,

    // Execution state
    pub current_phase: Phase,
    pub tasks: Vec<Task>,
    pub completed_tasks: Vec<String>,
    pub failed_tasks: Vec<String>,

    // Confirmation
    pub user_confirmed: bool,
    pub confirmation_message: Option<String>,

    // Release gate
    #[serde(default)]
    pub release_gate_status: Option<String>,
    pub auto_fix_changes: Vec<String>,

    // Retry
    pub retry_count: u32,
    pub max_retries: u32,
    pub auto_mode: bool, // [Phase 6] Auto-Pilot Mode

    // Result
    pub is_complete: bool,
    pub error: Option<String>,
}

impl Default for CLIState {
    fn default() -> Self {
        Self {
            goal: String::new(),
            interview_history: Vec::new(),
            interview_context: HashMap::new(),
            tech_stack: HashMap::new(),
            features: Vec::new(),
            daacs_content: None,
            plan_content: None,
            daacs_path: None,
            plan_path: None,
            project_path: PathBuf::from("."),
            backend_path: PathBuf::from("./backend"),
            frontend_path: PathBuf::from("./frontend"),
            current_phase: Phase::Interview,
            tasks: Vec::new(),
            completed_tasks: Vec::new(),
            failed_tasks: Vec::new(),
            user_confirmed: false,
            confirmation_message: None,
            release_gate_status: None,
            auto_fix_changes: Vec::new(),
            retry_count: 0,
            max_retries: 3,
            auto_mode: false,
            is_complete: false,
            error: None,
        }
    }
}

impl CLIState {
    pub fn new(goal: &str, project_path: PathBuf) -> Self {
        let backend_path = project_path.join("backend");
        let frontend_path = project_path.join("frontend");
        Self {
            goal: goal.to_string(),
            project_path,
            backend_path,
            frontend_path,
            ..Default::default()
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct InterviewTurn {
    pub role: String, // "user" | "assistant"
    pub content: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[derive(Default)]
pub enum Phase {
    #[default]
    Interview,
    DocumentGeneration,
    UserConfirmation,
    Orchestration,
    RuntimeVerification,
    VisualVerification,
    E2EVerification,
    PerformanceVerification,
    StabilityVerification,
    ConsistencyCheck,
    Verification,
    SecurityScan,
    ReleaseGate,
    AutoFix,
    Retry,
    Refactoring,
    Design,
    DesignPolish,
    Documentation,
    Complete,
    Failed,
}


#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Task {
    pub id: String,
    pub name: String,
    pub description: String,
    pub agent: AgentType,
    pub status: TaskStatus,
    pub phase_num: u32,
    pub output: Option<String>,
    #[serde(default)]
    pub dependencies: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub enum TaskStatus {
    Pending,
    InProgress,
    Completed,
    Failed,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub enum AgentType {
    Architect,
    BackendDeveloper,
    FrontendDeveloper,
    DevOps,
    Reviewer,
    Refactorer,
    Designer,
    DocWriter,
    QA,
}
