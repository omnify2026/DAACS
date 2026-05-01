import type { AgentRole } from "../../types/agent";
import type { CliAgentRole, DispatchRow, GoalPhase, ParsedPlanStep, RosterAgentMeta } from "./types";
import type { SequencerChannelMap } from "./TodoChannelRouter";

export class AgentRegistry {
  private readonly rosterAgents: RosterAgentMeta[];
  private readonly byId = new Map<string, RosterAgentMeta>();
  private readonly aliasToId = new Map<string, string>();
  private readonly byOfficeRole = new Map<string, string>();

  constructor(InRosterAgents: RosterAgentMeta[]) {
    this.rosterAgents = InRosterAgents;
    this.ValidateAndIndex();
  }

  public GetRosterAgents(): RosterAgentMeta[] {
    return this.rosterAgents;
  }

  public NormalizeAgentId(InAgentId: string): string {
    const id = (InAgentId ?? "").trim().toLowerCase();
    if (id === "") return "";
    const direct = this.byId.get(id);
    if (direct != null) return String(direct.id ?? "").trim().toLowerCase();
    const alias = this.aliasToId.get(id);
    if (alias != null && alias.trim() !== "") return alias;
    throw new Error(`unknown_agent_id:${id}`);
  }

  public MapTauriCliRoleKeyToCliRole(InKey: string): CliAgentRole {
    return this.NormalizeAgentId(InKey);
  }

  public MapCliRoleToSequencerRoleKey(InCliRole: CliAgentRole): string {
    const key = (InCliRole ?? "").trim().toLowerCase();
    const matched = this.byId.get(key);
    if (matched == null) {
      throw new Error(`unknown_cli_role:${key}`);
    }
    return this.MapAgentIdToSequencerRoleKey(key);
  }

  public ResolvePhaseForPromptRole(InPromptRole: string): GoalPhase {
    const key = (InPromptRole ?? "").trim().toLowerCase();
    const meta = this.byId.get(key);
    if (meta == null) throw new Error(`unknown_prompt_role:${key}`);
    return this.ResolvePhaseByAgentId(String(meta.id ?? ""));
  }

  public GetPromptKeyByAgentId(InAgentId: string): string {
    const id = this.NormalizeAgentId(InAgentId);
    const meta = this.byId.get(id);
    const promptKey = String(meta?.prompt_key ?? "").trim();
    if (promptKey === "") {
      throw new Error(`missing_prompt_key_for_agent:${id}`);
    }
    return promptKey;
  }

  public GetTauriRoleKeyByAgentId(InAgentId: string): string {
    return this.NormalizeAgentId(InAgentId);
  }

  public BuildSequencerChannelMap(InGetChannelId: (InRoleKey: string) => string): SequencerChannelMap {
    const roleChannelMap = new Map<string, string>();
    for (const meta of this.rosterAgents) {
      const sequencerRoleKey = this.MapAgentIdToSequencerRoleKey(String(meta.id ?? ""));
      const roleKey = sequencerRoleKey;
      if (roleKey === "") continue;
      const channelId = InGetChannelId(roleKey);
      if (!roleChannelMap.has(roleKey)) {
        roleChannelMap.set(roleKey, channelId);
      }
    }
    const pmChannel = roleChannelMap.get("pm");
    if (!pmChannel) {
      throw new Error("agents_metadata_invalid:sequencer_channel_map_missing_pm");
    }
    const byRoleKey: Record<string, string> = {};
    for (const [roleKey, channelId] of roleChannelMap.entries()) {
      byRoleKey[roleKey] = channelId;
    }
    return {
      pm: pmChannel,
      byRoleKey,
    };
  }

  public MapAgentIdToSequencerRoleKey(InAgentId: string): string {
    const id = this.NormalizeAgentId(InAgentId);
    return id;
  }

  public MapAgentIdToOfficeRole(InAgentId: string): AgentRole {
    const id = this.NormalizeAgentId(InAgentId);
    const meta = this.byId.get(id);
    return this.ResolveOfficeRoleByMetadata(id, meta);
  }

  public FindAgentIdByOfficeRole(InOfficeRole: string): string | null {
    const officeRole = this.NormalizeOfficeRoleKey(InOfficeRole);
    if (officeRole === "") return null;
    return this.byOfficeRole.get(officeRole) ?? null;
  }

  public BuildDispatchRow(InStep: ParsedPlanStep): DispatchRow {
    const raw = (InStep.routedAgentId ?? "").trim();
    const inferred = this.InferAgentIdFromTaskText(InStep.task);
    let routedId = this.GetPmAgentId();
    if (raw !== "") {
      try {
        routedId = this.NormalizeAgentId(raw);
      } catch {
        routedId = inferred ?? this.GetPmAgentId();
      }
    } else {
      routedId = inferred ?? this.GetPmAgentId();
    }
    const cliRoleKey = this.GetTauriRoleKeyByAgentId(routedId);
    return {
      agentId: routedId,
      command: InStep.task,
      stepNumber: InStep.stepNumber,
      cliRole: this.MapTauriCliRoleKeyToCliRole(cliRoleKey),
      officeRole: this.MapAgentIdToOfficeRole(routedId),
    };
  }

  private GetPmAgentId(): string {
    const id = this.byId.has("pm") ? "pm" : "";
    if (id === "") {
      throw new Error("missing_pm_agent");
    }
    return id;
  }

  private ValidateAndIndex(): void {
    this.byId.clear();
    this.aliasToId.clear();
    this.byOfficeRole.clear();
    for (const entry of this.rosterAgents) {
      const id = String(entry.id ?? "").trim().toLowerCase();
      const promptKey = String(entry.prompt_key ?? "").trim();
      const officeRole = this.NormalizeOfficeRoleKey(String(entry.office_role ?? ""));
      if (id === "") throw new Error("agents_metadata_invalid:id_required");
      if (promptKey === "") throw new Error(`agents_metadata_invalid:prompt_key_required:${id}`);
      if (officeRole === "") throw new Error(`agents_metadata_invalid:office_role_required:${id}`);
      if (this.byId.has(id)) throw new Error(`agents_metadata_invalid:duplicate_id:${id}`);
      this.byId.set(id, entry);
      if (!this.byOfficeRole.has(officeRole)) {
        this.byOfficeRole.set(officeRole, id);
      }
      this.RegisterAliases(id, officeRole);
    }
  }

  private RegisterAliases(InCanonicalId: string, InOfficeRole: string): void {
    const canonical = (InCanonicalId ?? "").trim().toLowerCase();
    if (canonical === "") return;
    const officeRole = (InOfficeRole ?? "").trim().toLowerCase();
    const add = (alias: string) => {
      const k = (alias ?? "").trim().toLowerCase();
      if (k === "" || k === canonical) return;
      if (!this.byId.has(k)) this.aliasToId.set(k, canonical);
    };
    const registerFrom = (raw: string, InAllowTerminalToken: boolean) => {
      const src = (raw ?? "").trim().toLowerCase();
      if (src === "") return;
      add(src);
      add(src.replace(/[\s_-]+/g, ""));
      add(src.replace(/[\s_-]+/g, "_"));
      add(src.replace(/[\s_-]+/g, "-"));
      add(src.replace(/[_-]/g, " "));
      const tokens = src.split(/[^a-z0-9]+/g).filter((v) => v.length > 0);
      if (tokens.length === 0) return;
      add(tokens.join(""));
      add(tokens.join("_"));
      add(tokens.join("-"));
      if (InAllowTerminalToken) {
        add(tokens[tokens.length - 1] ?? "");
      }
    };
    registerFrom(canonical, true);
    registerFrom(officeRole, false);
    switch (officeRole) {
      case "pm":
        add("피엠");
        add("기획");
        add("기획자");
        break;
      case "frontend":
        add("front");
        add("front-end");
        add("프론트");
        add("프론트엔드");
        add("화면");
        break;
      case "backend":
        add("back");
        add("back-end");
        add("백엔드");
        add("서버");
        break;
      case "developer":
        add("개발자");
        add("구현자");
        break;
      case "designer":
        add("디자이너");
        add("디자인");
        break;
      case "devops":
        add("배포");
        add("인프라");
        add("운영");
        break;
      case "reviewer":
        add("리뷰어");
        add("검토자");
        add("리뷰");
        break;
      case "verifier":
        add("검증자");
        add("검수자");
        add("검증");
        add("검수");
        break;
      default:
        break;
    }
  }

  private NormalizeOfficeRoleKey(InOfficeRole: string): AgentRole {
    const officeRole = String(InOfficeRole ?? "").trim().toLowerCase();
    switch (officeRole) {
      case "developer_front":
      case "developer-front":
      case "developer front":
        return "frontend";
      case "developer_back":
      case "developer-back":
      case "developer back":
        return "backend";
      default:
        return officeRole;
    }
  }

  private ResolvePhaseByAgentId(InAgentId: string): GoalPhase {
    const id = this.NormalizeAgentId(InAgentId);
    return id;
  }

  private ResolveOfficeRoleByMetadata(InAgentId: string, InMeta: RosterAgentMeta | undefined): AgentRole {
    const id = (InAgentId ?? "").trim().toLowerCase();
    if (id === "") throw new Error("unknown_office_role_for_agent:");
    const officeRole = this.NormalizeOfficeRoleKey(String(InMeta?.office_role ?? ""));
    if (officeRole === "") throw new Error(`unknown_office_role_for_agent:${id}`);
    return officeRole;
  }

  private InferAgentIdFromTaskText(InTask: string): string | null {
    const text = (InTask ?? "").trim().toLowerCase();
    if (text === "") return null;
    const normalized = text.replace(/[[\]()]/g, " ").trim();
    const candidates: string[] = [];
    const separators = ["->", ":", "-", "|"];
    for (const sep of separators) {
      const idx = normalized.indexOf(sep);
      if (idx > 0) {
        candidates.push(normalized.slice(0, idx).trim());
      }
    }
    const firstToken = normalized.split(/\s+/g).filter(Boolean)[0] ?? "";
    if (firstToken !== "") candidates.push(firstToken);
    for (const cand of candidates) {
      try {
        return this.NormalizeAgentId(cand);
      } catch {
        // Ignore malformed leading fragments and keep the row neutral.
      }
    }

    return null;
  }
}
