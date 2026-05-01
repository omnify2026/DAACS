use async_trait::async_trait;
use serde_json::json;

use infra_error::AppResult;

use crate::domain::execution::{ExecutionIntent, ExecutionIntentStatus};

#[derive(Debug, Clone)]
pub struct ConnectorExecutionOutcome {
    pub status: ExecutionIntentStatus,
    pub result_summary: String,
    pub result_payload: serde_json::Value,
}

#[async_trait]
pub trait ConnectorExecutor: Send + Sync {
    async fn execute(&self, intent: &ExecutionIntent) -> AppResult<ConnectorExecutionOutcome>;
}

#[derive(Debug, Default, Clone)]
pub struct ServerConnectorExecutor;

#[async_trait]
impl ConnectorExecutor for ServerConnectorExecutor {
    async fn execute(&self, intent: &ExecutionIntent) -> AppResult<ConnectorExecutionOutcome> {
        let (status, result_summary) = match intent.connector_id.as_str() {
            "internal_workbench" => (
                ExecutionIntentStatus::Completed,
                format!("Internal workbench action recorded for '{}'.", intent.title),
            ),
            connector_id => (
                ExecutionIntentStatus::Failed,
                format!(
                    "Server connector '{}' is not configured for execution in this environment.",
                    connector_id
                ),
            ),
        };

        Ok(ConnectorExecutionOutcome {
            status: status.clone(),
            result_summary: result_summary.clone(),
            result_payload: json!({
                "connector_id": intent.connector_id,
                "kind": intent.kind,
                "status": status,
                "mode": "server",
                "message": result_summary,
            }),
        })
    }
}
