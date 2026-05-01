//! TUI Events - Decoupling Agents from UI logic
//! 
//! This module defines the events that drive the TUI updates.
//! Agents emit these events, and the TUI consumes them to update its state.

use serde::{Serialize, Deserialize};

#[derive(Debug, Clone, Serialize, Deserialize)]
pub enum AgentEvent {
    /// Agent status change (e.g., "Thinking", "Idle")
    StatusChange {
        agent: String, // "Architect", "Developer", etc.
        status: String, // "Thinking...", "Writing code..."
        is_active: bool,
    },
    /// Log message to be displayed in the system logs panel
    LogMessage {
        level: String, // "INFO", "WARN", "ERROR"
        message: String,
    },
    /// Council voting update
    CouncilVote {
        voter: String, // "Architect", "Tech Leade", etc.
        vote: VoteType,
        reason: String,
    },
    /// Token usage update for the HUD
    TokenUsage {
        session_total: u32,
        estimated_cost: f64,
    },
    /// Progress update
    Progress {
        phase: String,
        percentage: u8,
    },
    // New Events
    ViewportUpdate {
        content: String,
        overwrite: bool, // If true, clear previous content
    },
    WorkflowStepChange {
        step: String, // "Architecting", "Coding", etc.
    },
    ScreenChange {
        screen: String, // "Home", "Dashboard"
    },
    UserMessage {
        message: String,
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub enum VoteType {
    Approve,
    Reject,
    Abstain,
    Pending,
}
