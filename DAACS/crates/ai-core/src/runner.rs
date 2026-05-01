use infra_error::AppResult;
use tracing::info;

pub struct AgentRunner {}

pub struct AgentRunRequest {
    pub role: String,
    pub step_label: String,
    pub prompt: String,
}

pub struct AgentRunResult {
    pub trace_id: String,
    pub prompt_preview: String,
}

impl AgentRunner {
    pub fn new() -> Self {
        Self {}
    }

    pub async fn run(&self) -> AppResult<()> {
        info!("AI task started");
        Ok(())
    }

    pub async fn run_step(&self, request: &AgentRunRequest) -> AppResult<AgentRunResult> {
        let prompt_preview = request.prompt.chars().take(160).collect::<String>();
        let trace_id = format!(
            "trace-{}",
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .map(|duration| duration.as_millis())
                .unwrap_or_default()
        );
        info!(
            "agent run trace_id={} role={} step_label={} prompt_preview={}",
            trace_id, request.role, request.step_label, prompt_preview
        );
        Ok(AgentRunResult {
            trace_id,
            prompt_preview,
        })
    }
}
