//! TUI State - Single Source of Truth
//! 
//! This module holds the entire state of the dashboard application.
//! It is updated only via `apply_event` to ensure consistency.

use std::collections::HashMap;
use crate::tui::dashboard::events::{AgentEvent, VoteType};

#[derive(Debug, Clone)]
pub struct DashboardState {
    // Crew Status
    pub agents: HashMap<String, AgentStatus>,
    
    // HUD Stats
    pub phase: String,
    pub token_usage: u32,
    pub estimated_cost: f64,
    
    // Council State
    pub council_active: bool,
    pub council_topic: String,
    pub council_votes: HashMap<String, VoteType>,
    
    // Logs
    pub logs: Vec<LogEntry>,
    
    // Input
    pub input_buffer: String,
    pub input_mode: InputMode,
    // New fields for Main Workspace
    pub main_content: String,       // Content for the main viewport (Code, Plan, etc.)
    pub workflow_step: WorkflowStep,// Current step in the pipeline
    pub current_screen: Screen,     // Active TUI screen
}

#[derive(Debug, Clone, PartialEq)]
pub enum Screen {
    Home,      // REPL
    Dashboard, // Command Center
}

#[derive(Debug, Clone, PartialEq)]
pub enum WorkflowStep {
    Idle,
    Architecting, // Planning
    Council,      // Voting
    Coding,       // Dev
    Reviewing,    // QA
    Deploying,    // Git/Push
}

impl Default for WorkflowStep {
    fn default() -> Self {
        Self::Idle
    }
}

#[derive(Debug, Clone)]
pub struct AgentStatus {
    pub name: String,
    pub status: String,
    pub is_active: bool,
}

#[derive(Debug, Clone)]
pub struct LogEntry {
    pub timestamp: String,
    pub level: String,
    pub message: String,
}

#[derive(Debug, Clone, PartialEq)]
pub enum InputMode {
    Normal,
    Editing,
}

impl Default for DashboardState {
    fn default() -> Self {
        Self {
            agents: HashMap::new(),
            phase: "Ready".to_string(),
            token_usage: 0,
            estimated_cost: 0.0,
            council_active: false,
            council_topic: String::new(),
            council_votes: HashMap::new(),
            logs: Vec::new(),
            input_buffer: String::new(),
            input_mode: InputMode::Normal, // Start in Normal mode (not capturing keystrokes for raw input yet)
            main_content: String::new(),
            workflow_step: WorkflowStep::Idle,
            current_screen: Screen::Home, // Default to Home (REPL)
        }
    }
}

impl DashboardState {
    pub fn new() -> Self {
        let mut state = Self::default();
        // Initialize default agents
        state.register_agent("Architect");
        state.register_agent("Developer");
        state.register_agent("Reviewer");
        state.register_agent("DevOps");
        state.register_agent("Council");
        state
    }

    pub fn register_agent(&mut self, name: &str) {
        self.agents.insert(name.to_string(), AgentStatus {
            name: name.to_string(),
            status: "Idle".to_string(),
            is_active: false,
        });
    }

    /// Apply an event to update the state
    pub fn apply_event(&mut self, event: AgentEvent) {
        match event {
            AgentEvent::StatusChange { agent, status, is_active } => {
                if let Some(agent_state) = self.agents.get_mut(&agent) {
                    agent_state.status = status;
                    agent_state.is_active = is_active;
                } else {
                    // Auto-register if new agent appears
                    self.agents.insert(agent.clone(), AgentStatus {
                        name: agent,
                        status,
                        is_active,
                    });
                }
            },
            AgentEvent::LogMessage { level, message } => {
                let timestamp = chrono::Local::now().format("%H:%M:%S").to_string();
                self.logs.push(LogEntry { timestamp, level, message });
                // Keep log size manageable
                if self.logs.len() > 100 {
                    self.logs.remove(0);
                }
            },
            AgentEvent::CouncilVote { voter, vote, .. } => {
                self.council_active = true;
                self.council_votes.insert(voter, vote);
            },
            AgentEvent::ViewportUpdate { content, overwrite } => {
                if overwrite {
                    self.main_content = content;
                } else {
                    self.main_content.push_str(&content);
                }
            },
            AgentEvent::WorkflowStepChange { step } => {
                self.workflow_step = match step.as_str() {
                    "Architecting" => WorkflowStep::Architecting,
                    "Council" => WorkflowStep::Council,
                    "Coding" => WorkflowStep::Coding,
                    "Reviewing" => WorkflowStep::Reviewing,
                    "Deploying" => WorkflowStep::Deploying,
                    _ => WorkflowStep::Idle,
                };
            },
            AgentEvent::ScreenChange { screen } => {
                self.current_screen = match screen.as_str() {
                    "Dashboard" => Screen::Dashboard,
                    _ => Screen::Home,
                };
            },
            AgentEvent::UserMessage { message } => {
                self.logs.push(LogEntry {
                    timestamp: chrono::Local::now().format("%H:%M:%S").to_string(),
                    level: "USER".to_string(),
                    message,
                });
            },
            AgentEvent::TokenUsage { session_total, estimated_cost } => {
                self.token_usage = session_total;
                self.estimated_cost = estimated_cost;
            },
            AgentEvent::Progress { phase, percentage: _ } => {
                self.phase = phase;
            }
        }
    }
}
