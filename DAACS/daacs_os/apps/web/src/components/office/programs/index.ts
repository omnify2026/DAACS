import type { ComponentType } from "react";

import type { AgentProgramComponentProps, AgentProgramId } from "../../../types/program";
import { ActivityFeedProgram } from "./ActivityFeedProgram";
import { ApprovalQueueProgram } from "./ApprovalQueueProgram";
import { AssetRefsProgram } from "./AssetRefsProgram";
import { BudgetWatchProgram } from "./BudgetWatchProgram";
import { CodeOutputProgram } from "./CodeOutputProgram";
import { ContentPipelineProgram } from "./ContentPipelineProgram";
import { FileChangesProgram } from "./FileChangesProgram";
import { HandoffFeedProgram } from "./HandoffFeedProgram";
import { OpsStatusProgram } from "./OpsStatusProgram";
import { PlanProgressProgram } from "./PlanProgressProgram";
import { ResearchActionsProgram } from "./ResearchActionsProgram";
import { TaskBriefProgram } from "./TaskBriefProgram";

export const PROGRAM_COMPONENTS: Record<
  AgentProgramId,
  ComponentType<AgentProgramComponentProps>
> = {
  task_brief: TaskBriefProgram,
  plan_progress: PlanProgressProgram,
  approval_queue: ApprovalQueueProgram,
  handoff_feed: HandoffFeedProgram,
  code_output: CodeOutputProgram,
  file_changes: FileChangesProgram,
  research_actions: ResearchActionsProgram,
  content_pipeline: ContentPipelineProgram,
  asset_refs: AssetRefsProgram,
  ops_status: OpsStatusProgram,
  budget_watch: BudgetWatchProgram,
  activity_feed: ActivityFeedProgram,
};
