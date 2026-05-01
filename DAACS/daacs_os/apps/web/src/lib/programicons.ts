import type { LucideIcon } from "lucide-react";
import {
  Activity,
  BadgeDollarSign,
  BriefcaseBusiness,
  CheckSquare,
  ClipboardList,
  FileCode2,
  Files,
  FolderGit2,
  MessagesSquare,
  PenTool,
  Search,
  ServerCog,
} from "lucide-react";

import type { AgentProgramId } from "../types/program";

const PROGRAM_ICON_MAP: Record<AgentProgramId, LucideIcon> = {
  task_brief: BriefcaseBusiness,
  plan_progress: ClipboardList,
  approval_queue: CheckSquare,
  handoff_feed: MessagesSquare,
  code_output: FileCode2,
  file_changes: FolderGit2,
  research_actions: Search,
  content_pipeline: Activity,
  asset_refs: PenTool,
  ops_status: ServerCog,
  budget_watch: BadgeDollarSign,
  activity_feed: Files,
};

export function resolveProgramIcon(programId: AgentProgramId): LucideIcon {
  return PROGRAM_ICON_MAP[programId];
}
