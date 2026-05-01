use ai_core::runner::{AgentRunRequest, AgentRunner};
use infra_error::AppResult;
use omni_ai_core::prompting_sequencer_system_prompt;
use serde_json::json;

use crate::domain::{blueprint::AgentBlueprint, execution::ExecutionStep, instance::AgentInstance};
use crate::llm::create_executor;
use crate::planner::runtime::parse_step_result;

use super::{
    context::ContextSnapshot,
    llm_router::{LlmConfig, LlmRouter},
};

#[derive(Debug, Clone)]
pub struct StepOutput {
    pub payload: serde_json::Value,
    pub input_tokens: u32,
    pub output_tokens: u32,
    pub live_metrics: serde_json::Value,
}

pub struct AgentExecutor {
    router: LlmRouter,
}

impl AgentExecutor {
    pub fn new() -> Self {
        Self {
            router: LlmRouter::new(),
        }
    }

    pub async fn execute(
        &self,
        instance: &AgentInstance,
        blueprint: &AgentBlueprint,
        step: &ExecutionStep,
        context: &ContextSnapshot,
    ) -> AppResult<StepOutput> {
        let llm_config = self.router.resolve(blueprint);
        let prompt = build_prompt(instance, blueprint, step, context, &llm_config);

        let runner = AgentRunner::new();
        let trace = runner
            .run_step(&AgentRunRequest {
                role: blueprint.role_label.clone(),
                step_label: step.label.clone(),
                prompt: prompt.clone(),
            })
            .await?;

        let executor = create_executor()?;
        let raw_output: String = executor.complete(&prompt, &blueprint.role_label).await?;

        let input_tokens = estimate_tokens(&prompt);
        let output_tokens = estimate_tokens(&raw_output);
        let provider = llm_config.provider.clone();
        let model = llm_config.model.clone();
        let tools = llm_config
            .tools
            .iter()
            .map(|tool| tool.name.clone())
            .collect::<Vec<_>>();
        let parsed = parse_step_result(&raw_output)?;
        let summary = parsed
            .as_ref()
            .map(|result| result.body_markdown.trim())
            .filter(|summary| !summary.is_empty())
            .unwrap_or(raw_output.trim());

        let sequencer_payload = parsed.as_ref().map(|result| {
            json!({
                "step_number": result.step_number,
                "body_markdown": result.body_markdown,
                "files_created": result.files_created,
                "commands": result.commands,
                "task_completed": result.task_completed,
            })
        });

        Ok(StepOutput {
            payload: json!({
                "summary": summary,
                "stdout": raw_output,
                "sequencer": sequencer_payload,
                "trace_id": trace.trace_id,
                "prompt_preview": trace.prompt_preview,
                "provider": provider,
                "model": model,
                "tools": tools,
                "instance_id": instance.instance_id,
                "step_id": step.step_id,
            }),
            input_tokens,
            output_tokens,
            live_metrics: json!({
                "last_model": llm_config.model,
                "last_provider": llm_config.provider,
                "last_prompt_tokens": input_tokens,
                "last_completion_tokens": output_tokens,
            }),
        })
    }
}

fn build_prompt(
    instance: &AgentInstance,
    blueprint: &AgentBlueprint,
    step: &ExecutionStep,
    context: &ContextSnapshot,
    llm_config: &LlmConfig,
) -> String {
    let sequencer_prompt = prompting_sequencer_system_prompt("local", step.step_id.as_str());
    format!(
        "{sequencer_prompt}\n\n[System Instruction: Detect the language of the 'Input' field. You MUST use that exact same language (e.g. Korean or English) for all thoughts and final outputs.]\n\nRole: {}\nInstance: {}\nModel: {}/{}\n\n## Active Sequencer Plan\n1. {}\n\n## Current Step (Step 1 of 1)\n{}\n\n## Input\n{}\n\n## Prior Step Outputs\n{}\n\n## Shared Artifacts\n{}\n\n## Runtime Constraints\n- TokenBudgetRemaining: {}\n- You are executing a single runtime step. Return only a sequencer step result for this step.\n\nPrompting_Sequencer_1",
        blueprint.role_label,
        instance.instance_id,
        llm_config.provider,
        llm_config.model,
        step.label,
        step.description,
        step.input,
        serde_json::Value::Array(context.recent_outputs.clone()),
        serde_json::Value::Array(context.shared_artifacts.clone()),
        context.token_budget_remaining,
    )
}

fn estimate_tokens(text: &str) -> u32 {
    let rough = text.chars().count() / 4;
    u32::try_from(rough.max(1)).unwrap_or(u32::MAX)
}
