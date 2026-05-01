//! Workflow graph implementation.

use std::collections::HashMap;

use anyhow::Result;

use crate::graph::edge::{ConditionalEdge, Transition};
use crate::graph::state::{CLIState, Phase};

/// 프론트엔드 프로젝트 여부 감지
/// DAACS.md 내용이나 interview_context에서 프론트엔드 관련 키워드를 검사
fn has_frontend_project(state: &CLIState) -> bool {
    // 1. interview_context에서 확인
    if let Some(has_frontend) = state.interview_context.get("has_frontend") {
        if has_frontend == "true" || has_frontend == "yes" {
            return true;
        }
    }
    
    // 2. tech_stack에서 프론트엔드 키 확인
    if state.tech_stack.contains_key("frontend") {
        return true;
    }
    
    // 3. DAACS.md 내용에서 프론트엔드 키워드 검사
    if let Some(daacs) = &state.daacs_content {
        let lower = daacs.to_lowercase();
        let frontend_keywords = [
            "react", "vue", "angular", "svelte", "next.js", "nextjs",
            "frontend", "프론트엔드", "ui", "tailwind", "css", "html",
            "typescript", "javascript", "vite", "webpack"
        ];
        for keyword in frontend_keywords {
            if lower.contains(keyword) {
                return true;
            }
        }
    }
    
    // 4. features에서 확인
    for feature in &state.features {
        let lower = feature.to_lowercase();
        if lower.contains("frontend") || lower.contains("ui") || lower.contains("프론트") {
            return true;
        }
    }
    
    false
}


#[async_trait::async_trait]
pub trait Node: Send + Sync {
    async fn execute(&self, state: &mut CLIState) -> Result<NodeResult>;
    fn name(&self) -> &str;
}

#[derive(Debug, Clone)]
pub enum NodeResult {
    Success,
    Failure(String),
    NeedsModification,
}

pub struct StateGraph {
    nodes: HashMap<Phase, Box<dyn Node>>,
    edges: HashMap<Phase, Phase>,
    conditional_edges: HashMap<Phase, ConditionalEdge>,
}

impl StateGraph {
    pub fn new() -> Self {
        Self {
            nodes: HashMap::new(),
            edges: HashMap::new(),
            conditional_edges: HashMap::new(),
        }
    }

    pub fn add_node(&mut self, phase: Phase, node: Box<dyn Node>) {
        self.nodes.insert(phase, node);
    }

    pub fn add_edge(&mut self, from: Phase, to: Phase) {
        self.edges.insert(from, to);
    }

    pub fn add_conditional_edge(&mut self, from: Phase, edge: ConditionalEdge) {
        self.conditional_edges.insert(from, edge);
    }

    pub async fn run(&self, state: &mut CLIState) -> Result<()> {
        let session_id = uuid::Uuid::new_v4().to_string();

        loop {
            let current_phase = state.current_phase.clone();

            if current_phase == Phase::Complete || current_phase == Phase::Failed {
                break;
            }

            if let Some(node) = self.nodes.get(&current_phase) {
                crate::logger::phase_start(node.name());

                match node.execute(state).await {
                    Ok(_result) => {
                        crate::logger::task_complete(node.name());
                        state.current_phase = self.get_next_phase(&current_phase, state);

                        if let Err(e) = crate::session::save_checkpoint(state, &session_id).await {
                            crate::logger::log_warning(&format!(
                                "Checkpoint save failed: {}",
                                e
                            ));
                        }
                    }
                    Err(e) => {
                        crate::logger::log_error(&e.to_string());
                        state.error = Some(e.to_string());
                        state.current_phase = Phase::Failed;
                        if let Err(e) = crate::session::save_checkpoint(state, &session_id).await {
                            crate::logger::log_warning(&format!(
                                "Checkpoint save failed: {}",
                                e
                            ));
                        }
                    }
                }
            } else {
                state.current_phase = self.get_next_phase(&current_phase, state);
            }
        }

        Ok(())
    }

    fn get_next_phase(&self, current: &Phase, state: &CLIState) -> Phase {
        if let Some(conditional) = self.conditional_edges.get(current) {
            return conditional.evaluate(state);
        }
        if let Some(next) = self.edges.get(current) {
            return next.clone();
        }
        Phase::Complete
    }
}

impl Default for StateGraph {
    fn default() -> Self {
        Self::new()
    }
}

pub struct WorkflowGraph {
    pub graph: StateGraph,
}

impl WorkflowGraph {
    pub fn new() -> Self {
        let mut graph = StateGraph::new();

        graph.add_edge(Phase::Interview, Phase::DocumentGeneration);
        graph.add_edge(Phase::DocumentGeneration, Phase::UserConfirmation);

        // UserConfirmation → Design (프론트엔드 있을 때) 또는 Orchestration으로 분기
        graph.add_conditional_edge(
            Phase::UserConfirmation,
            ConditionalEdge::new(|state: &CLIState| {
                if state.user_confirmed {
                    // 프론트엔드가 있으면 Design 먼저, 아니면 바로 Orchestration
                    if has_frontend_project(state) {
                        Transition::To(Phase::Design)
                    } else {
                        Transition::To(Phase::Orchestration)
                    }
                } else if state.confirmation_message.is_some() {
                    Transition::To(Phase::DocumentGeneration)
                } else {
                    Transition::To(Phase::Failed)
                }
            }),
        );

        // Design -> Orchestration (디자인 완료 후 개발 시작)
        graph.add_edge(Phase::Design, Phase::Orchestration);

        // Simplified Autonomous Workflow
        // 1. Orchestration (Includes Dev, QA, Rework Loop)
        // 2. Refactoring (Optimization only, if passed)
        // 3. Documentation
        
        graph.add_edge(Phase::Orchestration, Phase::Refactoring);
        
        // Old External Validation Loop Removed
        // graph.add_edge(Phase::RuntimeVerification, Phase::Verification);
        // ... omitted ...
        
        graph.add_edge(Phase::Refactoring, Phase::Documentation);
        
        // Refactoring -> DesignPolish -> Documentation (Double Design Workflow)
        // Refactoring -> Documentation (DesignPolish is integrated into Orchestrator plan)
        graph.add_edge(Phase::Refactoring, Phase::Documentation);
        graph.add_edge(Phase::Documentation, Phase::Complete);

        Self { graph }
    }

    pub async fn run(&self, state: &mut CLIState) -> Result<()> {
        self.graph.run(state).await
    }
}

impl Default for WorkflowGraph {
    fn default() -> Self {
        Self::new()
    }
}
