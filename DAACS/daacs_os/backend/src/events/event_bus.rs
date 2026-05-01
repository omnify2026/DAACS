use infra_error::AppResult;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use tokio::sync::broadcast;
use uuid::Uuid;

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum EventType {
    PlanCreated,
    StepStatusChanged,
    ApprovalRequested,
    ApprovalGranted,
    PlanStarted,
    PlanCompleted,
    PlanFailed,
    ExecutionIntentCreated,
    ExecutionIntentStatusChanged,
    ConnectorExecutionStarted,
    ConnectorExecutionCompleted,
    ConnectorExecutionFailed,
    AgentStatusChanged,
    RuntimeUpdated,
    // ── 에이전트 활동 전용 이벤트 (Step 3-4) ──
    // AgentStatusChanged는 하위 호환 유지. 아래 4개가 세분화된 전용 타입.
    AgentWorking,   // step 시작 → 에이전트가 작업 중
    AgentIdle,      // step 완료 후 다음 작업 없음
    AgentHandoff,   // step 완료 → 다음 step 에이전트로 컨텍스트 전달
    AgentReviewing, // reviewer에게 리뷰 요청 전환
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct RuntimeEvent {
    pub event_id: String,
    pub event_type: EventType,
    pub payload: Value,
    pub project_id: String,
    #[serde(default)]
    pub runtime_id: Option<String>,
    #[serde(default)]
    pub plan_id: Option<String>,
    #[serde(default)]
    pub step_id: Option<String>,
    #[serde(default)]
    pub actor_id: Option<String>,
    #[serde(default)]
    pub sequence_no: i64,
    pub timestamp: u64,
    #[serde(default)]
    pub created_at: String,
}

#[derive(Clone)]
pub struct EventBus {
    sender: broadcast::Sender<RuntimeEvent>,
}

impl EventBus {
    pub fn new(capacity: usize) -> Self {
        let (sender, _) = broadcast::channel(capacity);
        Self { sender }
    }

    pub fn subscribe(&self) -> broadcast::Receiver<RuntimeEvent> {
        self.sender.subscribe()
    }

    pub fn emit(&self, event: RuntimeEvent) -> AppResult<()> {
        let _ = self.sender.send(event);
        Ok(())
    }

    pub fn emit_type(
        &self,
        project_id: &str,
        event_type: EventType,
        payload: Value,
    ) -> AppResult<RuntimeEvent> {
        let event = RuntimeEvent {
            event_id: Uuid::new_v4().to_string(),
            event_type,
            payload,
            project_id: project_id.to_string(),
            runtime_id: None,
            plan_id: None,
            step_id: None,
            actor_id: None,
            sequence_no: 0,
            timestamp: now_epoch_ms(),
            created_at: String::new(),
        };
        self.emit(event.clone())?;
        Ok(event)
    }
}

fn now_epoch_ms() -> u64 {
    let now = std::time::SystemTime::now();
    now.duration_since(std::time::UNIX_EPOCH)
        .map(|duration| duration.as_millis() as u64)
        .unwrap_or(0)
}
