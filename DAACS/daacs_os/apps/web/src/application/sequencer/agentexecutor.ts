import type { GoalPhase } from "./types";
import type { AgentRegistry } from "./AgentRegistry";

export class AgentExecutorFactory {
  private registry: AgentRegistry;

  constructor(InRegistry: AgentRegistry) {
    this.registry = InRegistry;
  }

  public SetRegistry(InRegistry: AgentRegistry): void {
    this.registry = InRegistry;
  }

  public ResolvePhaseForPromptRole(InPromptRole: string): GoalPhase {
    return this.registry.ResolvePhaseForPromptRole(InPromptRole);
  }
}
