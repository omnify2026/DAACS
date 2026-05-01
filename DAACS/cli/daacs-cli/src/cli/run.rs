//! Workflow execution entry points.

use anyhow::Result;
use std::path::PathBuf;

use crate::graph::nodes::{
    ConfirmNode, DesignNode, DocumentNode,
    DocumentationNode, InterviewNode, OrchestratorNode,
    RefactorNode, RetryNode,
};
use crate::graph::state::{CLIState, Phase};
use crate::graph::workflow::WorkflowGraph;

pub async fn start_new_project(goal: String, project_path: PathBuf, auto_mode: bool) -> Result<()> {
    crate::logger::phase_start("DAACS CLI start");
    crate::logger::status_update(&format!("Project path: {}", project_path.display()));
    crate::logger::status_update(&format!("Goal: {}", goal));

    let mut state = CLIState::new(&goal, project_path);
    state.auto_mode = auto_mode;
    let workflow = create_workflow();
    workflow.run(&mut state).await?;

    if state.current_phase == Phase::Complete {
        crate::logger::phase_start("Project complete");
        crate::logger::status_update(&format!("Path: {}", state.project_path.display()));

        if let Some(daacs_path) = state.daacs_path {
            crate::logger::status_update(&format!("DAACS.md: {}", daacs_path.display()));
        }
        if let Some(plan_path) = state.plan_path {
            crate::logger::status_update(&format!("plan.md: {}", plan_path.display()));
        }

        crate::logger::task_complete("All steps completed.");
    } else {
        crate::logger::log_error("Workflow did not complete.");
        if let Some(error) = &state.error {
            crate::logger::log_error(&format!("Error: {}", error));
        }
    }

    Ok(())
}

pub async fn resume_session(session_id: Option<String>, auto_mode: bool) -> Result<()> {
    crate::logger::phase_start("Resume session");

    let mut state = if let Some(id) = session_id {
        if id == "latest" {
            crate::logger::status_update("Loading latest checkpoint...");
            crate::session::load_latest_checkpoint().await?
        } else {
            crate::logger::status_update(&format!("Loading checkpoint {}", id));
            crate::session::load_checkpoint(&id).await?
        }
    } else {
        crate::logger::status_update("Loading latest checkpoint...");
        crate::session::load_latest_checkpoint().await?
    };
    state.auto_mode = auto_mode;

    crate::logger::status_update(&format!("Goal: {}", state.goal));
    crate::logger::status_update(&format!("Phase: {:?}", state.current_phase));
    crate::logger::status_update(&format!("Path: {}", state.project_path.display()));

    let completed_count = state
        .tasks
        .iter()
        .filter(|t| matches!(t.status, crate::graph::state::TaskStatus::Completed))
        .count();
    crate::logger::status_update(&format!(
        "Progress: {}/{} tasks complete",
        completed_count,
        state.tasks.len()
    ));

    // Failed 상태인 경우 Orchestration 단계부터 재시도
    if state.current_phase == Phase::Failed {
        crate::logger::status_update("⚠️  Failed state detected. Resuming from Orchestration phase...");
        state.current_phase = Phase::Orchestration;
        state.error = None;
    }

    let workflow = create_workflow();
    workflow.run(&mut state).await?;

    if state.current_phase == Phase::Complete {
        crate::logger::phase_start("Project complete");
        crate::logger::status_update(&format!("Path: {}", state.project_path.display()));
    } else {
        crate::logger::log_error("Workflow did not complete.");
        if let Some(error) = &state.error {
            crate::logger::log_error(&format!("Error: {}", error));
        }
    }

    Ok(())
}

fn create_workflow() -> WorkflowGraph {
    let mut workflow = WorkflowGraph::new();

    workflow
        .graph
        .add_node(Phase::Interview, Box::new(InterviewNode));
    workflow
        .graph
        .add_node(Phase::DocumentGeneration, Box::new(DocumentNode));
    workflow
        .graph
        .add_node(Phase::UserConfirmation, Box::new(ConfirmNode));
    workflow
        .graph
        .add_node(Phase::Orchestration, Box::new(OrchestratorNode));
    workflow
        .graph
        .add_node(Phase::Refactoring, Box::new(RefactorNode));
    // Simplified Workflow: Internal Orchestration loop handles Rework and QA.
    workflow.graph.add_node(Phase::Retry, Box::new(RetryNode));
    workflow.graph.add_node(Phase::Design, Box::new(DesignNode));
    workflow.graph.add_node(Phase::Documentation, Box::new(DocumentationNode));

    workflow
}
