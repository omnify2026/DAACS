mod cli;
#[allow(non_snake_case)]
mod httpApi;
pub mod local_llm;
mod parse;
mod planner;
mod prompt_loader;
mod prompting_sequencer;
mod prompts;
mod recovery;
mod reviewer;
mod rfi;
mod supervisor;
mod verifier;
mod workflow_judgment;
mod workflow_planning;
mod workflow_types;
mod workflow_verification;

pub use local_llm::{
    generate_response, generate_response_stream, get_llama_cli, list_local_model_candidates,
    LocalModelCandidate,
};
pub use parse::{parse_pm_task_lists, PmTaskLists};
pub use planner::planner_system_prompt;
pub use prompt_loader::load_prompt_content;
pub use prompting_sequencer::{
    delete_project_cache, delete_todo_list, extract_command_lines,
    ingest_files_created_from_step_output, load_artifact_manifest, load_todo_list, mark_item_done,
    project_cache_root, prompting_sequencer_system_prompt, save_todo_list,
    sync_artifact_manifest_with_workspace, SequencerArtifactManifest, SequencerItem,
    SequencerMetadata, SequencerMetadataEntry, SequencerStatus, SequencerTodoList,
};
pub use prompts::{
    backend_agent_skills, frontend_agent_skills, pm_skill_planning, system_prompt_for_role,
    AgentRole,
};
pub use recovery::recover_json;
pub use reviewer::reviewer_system_prompt;
pub use rfi::{
    build_rfi_user_prompt, fallback_rfi_outcome, parse_rfi_outcome, rfi_system_prompt,
    RfiExecutionContract, RfiKnownAnswer, RfiOutcome, RfiQuestion, RfiQuestionLevel, RfiRequest,
    RfiStatus, RfiTopic,
};
pub use supervisor::{parse_supervisor_decision, SupervisorDecision};
pub use verifier::verifier_system_prompt;
pub use workflow_judgment::{build_judgment_review_prompt, evaluate_judgment};
pub use workflow_planning::{default_evidence_required, evaluate_planning};
pub use workflow_types::{
    ApiEndpoint, ApiSpec, FileMap, JudgmentRequest, JudgmentResult, OrchestrationPolicy,
    PlanningEvaluationInput, PlanningResult, PlanningTask, ReviewData, ReviewIssue, TechStack,
    VerificationCommandResult, VerificationDetail, VerificationEvidence, VerificationRequest,
    VerificationResult,
};
pub use workflow_verification::run_verification;

pub use cli::{
    cli_which_json, cli_workspace_path, initialize_local_cli, local_cli_which,
    run_local_cli_command, OmniCliRunResult, OmniCliWhich,
};
