import type { AgentRole } from "../../types/agent";
import type { runCliCommand } from "../../services/tauriCli";

export type GoalPhase = string | null;

export type CliAgentRole = string;

export type RosterAgentMeta = {
  id?: string;
  prompt_key?: string;
  display_name?: string;
  summary?: string;
  prompt_file?: string;
  skill_bundle_role?: string;
  skill_bundle_refs?: string[];
  office_role?: AgentRole;
};

export type DispatchRow = {
  agentId: string;
  command: string;
  stepNumber: number;
  cliRole: CliAgentRole;
  officeRole: AgentRole;
};

export type ParsedPlanStep = {
  stepNumber: number;
  task: string;
  routedAgentId: string | null;
};

export type SequencerStepRunRecord = {
  row: DispatchRow;
  stepResult: Awaited<ReturnType<typeof runCliCommand>> | null;
};
