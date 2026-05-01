import type { DispatchRow } from "./types";
import type { AgentRegistry } from "./AgentRegistry";

export type SequencerChannelMap = {
  pm: string;
  byRoleKey: Record<string, string>;
};

export class TodoChannelRouter {
  private readonly channels: SequencerChannelMap;
  private readonly registry: AgentRegistry;

  constructor(InChannels: SequencerChannelMap, InRegistry: AgentRegistry) {
    this.channels = InChannels;
    this.registry = InRegistry;
  }

  public ResolveByCliRole(InCliRole: DispatchRow["cliRole"]): string {
    const key = this.registry.MapCliRoleToSequencerRoleKey(InCliRole);
    return this.ResolveBySequencerRoleKey(key);
  }

  public ResolveByDispatchRow(InRow: DispatchRow): string {
    return this.ResolveByCliRole(InRow.cliRole);
  }

  public ResolveBySequencerRoleKey(InSequencerRoleKey: string): string {
    const key = (InSequencerRoleKey ?? "").trim().toLowerCase();
    if (key === "pm") return this.channels.pm;
    return this.channels.byRoleKey[key] ?? this.channels.pm;
  }
}
