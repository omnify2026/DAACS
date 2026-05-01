import type { CliLogEntry } from "../stores/cliLogStore";
import type {
  Agent,
  AgentErrorRecord,
  AgentMessageRecord,
  FileChangeRecord,
  TaskRecord,
  WorkLogEntry,
} from "./agent";
import type { HandoffMessage } from "../lib/agentHandoff";
import type { RuntimePlanView } from "../lib/runtimePlan";
import type { CreateExecutionIntentInput, ExecutionIntent } from "./runtime";

export type AgentProgramId =
  | "task_brief"
  | "plan_progress"
  | "approval_queue"
  | "handoff_feed"
  | "code_output"
  | "file_changes"
  | "research_actions"
  | "content_pipeline"
  | "asset_refs"
  | "ops_status"
  | "budget_watch"
  | "activity_feed";

export type AgentProgramSize = "half" | "full";

export interface AgentProgramSignals {
  workspace_mode: string;
  capabilities: string[];
  skill_bundle_refs: string[];
  widget_ids: string[];
  role_tokens: string[];
}

export interface AgentProgramSpec {
  id: AgentProgramId;
  title_key: string;
  description_key: string;
  size: AgentProgramSize;
  accent_class: string;
}

export type WorkspaceLogRow =
  | { kind: "cli"; at: number; cli: CliLogEntry }
  | { kind: "stream"; at: number; stream: WorkLogEntry };

export interface AgentWorkspaceData {
  tasks: TaskRecord[];
  file_changes: FileChangeRecord[];
  errors: AgentErrorRecord[];
  messages: AgentMessageRecord[];
  tool_logs: WorkLogEntry[];
  merged_logs: WorkspaceLogRow[];
  plan_view: RuntimePlanView | null;
  handoffs: HandoffMessage[];
  execution_intents: ExecutionIntent[];
}

export interface AgentProgramProps {
  agent: Agent;
  data: AgentWorkspaceData;
  t: (key: string, vars?: Record<string, string | number>) => string;
  onRunCommand: (text: string) => Promise<void>;
  onCreateIntent?: (intent: CreateExecutionIntentInput) => Promise<void>;
}

export interface AgentProgramDerivedData {
  latest_output_lines: string[];
  latest_files: string[];
  pending_intents: ExecutionIntent[];
  recent_intent_runs: ExecutionIntent[];
  approval_items: RuntimePlanView["approvalQueue"];
}

export interface AgentProgramComponentProps extends AgentProgramProps {
  program: AgentProgramSpec;
  derived: AgentProgramDerivedData;
}
