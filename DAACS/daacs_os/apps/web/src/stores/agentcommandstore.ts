import { create } from "zustand";

import type { AgentRole, Command, Notification } from "../types/agent";
import * as api from "../services/agentApi";
import {
  buildProjectCliSessionKey,
  isTauri,
  runCliCommand,
  buildRosterDelegationSystemPrompt,
  getAgentPrompt,
  getAgentPromptRoleForOfficeRole,
  getAgentsMetadataJson,
  resolveProjectWorkspacePath,
} from "../services/tauriCli";
import { useCliLogStore } from "./cliLogStore";
import { useSequencerDeferredCommandsStore } from "./sequencerDeferredCommandsStore";

type RosterMetaLite = {
  id?: string;
  office_role?: string;
  skill_bundle_role?: string;
  skill_bundle_refs?: string[];
};

function normalizeKey(value: string | null | undefined): string {
  return String(value ?? "")
    .trim()
    .toLowerCase()
    .replace(/[\s-]+/g, "_");
}

function resolveRosterMeta(
  inAgentsJson: string,
  inPromptRole: string,
  inOfficeRole: AgentRole,
  inAgentId: string | null,
): RosterMetaLite | null {
  try {
    const root = JSON.parse(inAgentsJson) as { agents?: unknown };
    if (!Array.isArray(root.agents)) return null;
    const agents = root.agents as RosterMetaLite[];
    const agentId = normalizeKey(inAgentId);
    if (agentId !== "") {
      const byAgentId = agents.find((a) => normalizeKey(a?.id) === agentId);
      if (byAgentId != null) return byAgentId;
    }
    const promptRole = normalizeKey(inPromptRole);
    if (promptRole !== "") {
      const byPromptRole = agents.find((a) => normalizeKey(a?.id) === promptRole);
      if (byPromptRole != null) return byPromptRole;
    }
    const officeRole = normalizeKey(inOfficeRole);
    if (officeRole !== "") {
      const byOfficeRole = agents.find((a) => normalizeKey(a?.office_role) === officeRole);
      if (byOfficeRole != null) return byOfficeRole;
    }
    return null;
  } catch {
    return null;
  }
}

interface AgentCommandState {
  commandHistory: Command[];
  reset: () => void;
  sendCommand: (
    projectId: string,
    role: AgentRole,
    agentId: string | null,
    message: string,
    notify?: (n: Omit<Notification, "id" | "timestamp">) => void,
    options?: { promptKey?: string | null; forceExecute?: boolean },
  ) => Promise<void>;
}

export const useAgentCommandStore = create<AgentCommandState>((set) => ({
  commandHistory: [],

  reset: () => set({ commandHistory: [] }),

  sendCommand: async (projectId, role, agentId, message, notify, options) => {
    const force = options?.forceExecute === true;
    if (
      isTauri() &&
      !force &&
      useSequencerDeferredCommandsStore.getState().IsSequencerPipelineActive()
    ) {
      const pid = (projectId ?? "").trim();
      if (pid !== "") {
        const pk = (options?.promptKey ?? "").trim();
        useSequencerDeferredCommandsStore.getState().PushDeferredAgentCommand({
          projectId: pid,
          officeRole: role,
          agentId: agentId ?? null,
          message,
          promptKey: pk !== "" ? pk : null,
        });
        notify?.({
          type: "info",
          message: "Command queued until the sequencer advances or finishes.",
        });
      }
      return;
    }

    const cmd: Command = {
      id: `cmd-${Date.now()}`,
      agentRole: role,
      agentId: agentId ?? undefined,
      message,
      timestamp: Date.now(),
      status: "processing",
    };

    set((s) => ({ commandHistory: [...s.commandHistory, cmd] }));

    if (isTauri()) {
      const promptRole = getAgentPromptRoleForOfficeRole(role);
      const agentsJson = await getAgentsMetadataJson();
      const rosterMeta = resolveRosterMeta(agentsJson, promptRole, role, agentId);
      const pk = (options?.promptKey ?? "").trim();
      const combined =
        projectId != null && projectId.trim() !== ""
          ? await buildRosterDelegationSystemPrompt(projectId.trim(), promptRole, agentsJson, {
              promptKey: pk !== "" ? pk : null,
              skillBundleRole:
                rosterMeta?.skill_bundle_role != null && String(rosterMeta.skill_bundle_role).trim() !== ""
                  ? String(rosterMeta.skill_bundle_role).trim()
                  : null,
              skillBundleRefs: Array.isArray(rosterMeta?.skill_bundle_refs)
                ? rosterMeta!.skill_bundle_refs!
                : [],
            })
          : null;
      const systemPrompt = combined ?? (await getAgentPrompt(promptRole));
      const normalizedProjectId = projectId.trim();
      const resolvedWorkspace =
        normalizedProjectId !== "" ? await resolveProjectWorkspacePath(normalizedProjectId) : null;
      const stableAgentKey = agentId ?? rosterMeta?.id ?? promptRole ?? role;
      const cliResult = await runCliCommand(message, {
        systemPrompt,
        projectName: normalizedProjectId !== "" ? normalizedProjectId : null,
        cwd: resolvedWorkspace,
        sessionKey: buildProjectCliSessionKey(normalizedProjectId || "local", [
          "agent-command",
          stableAgentKey,
        ]),
      });
      if (cliResult != null) {
        useCliLogStore.getState().addEntry({
          stdin: message,
          stdout: cliResult.stdout,
          stderr: cliResult.stderr,
          exit_code: cliResult.exit_code,
          provider: cliResult.provider,
          label: `Agent: ${role}`,
          officeAgentRole: role,
          officeAgentId: agentId,
        });
        const out = [cliResult.stdout, cliResult.stderr].filter(Boolean).join("\n").trim() || `(exit ${cliResult.exit_code})`;
        set((s) => ({
          commandHistory: s.commandHistory.map((c) =>
            c.id === cmd.id ? { ...c, status: cliResult.exit_code === 0 ? "completed" : "failed", response: out } : c,
          ),
        }));
        if (cliResult.exit_code !== 0) {
          notify?.({ type: "error", message: `Command exit ${cliResult.exit_code}` });
        }
      } else {
        set((s) => ({
          commandHistory: s.commandHistory.map((c) =>
            c.id === cmd.id ? { ...c, status: "failed", response: "CLI unavailable" } : c,
          ),
        }));
        notify?.({ type: "error", message: `Command failed for ${role}` });
      }
      return;
    }

    try {
      const res = await api.sendCommand(projectId, role, message);
      set((s) => ({
        commandHistory: s.commandHistory.map((c) =>
          c.id === cmd.id ? { ...c, status: "completed", response: res?.message ?? "" } : c,
        ),
      }));
    } catch (err) {
      const text = err instanceof Error ? err.message : "Failed";
      set((s) => ({
        commandHistory: s.commandHistory.map((c) =>
          c.id === cmd.id ? { ...c, status: "failed", response: text } : c,
        ),
      }));
      notify?.({ type: "error", message: `Command failed for ${role}` });
    }
  },
}));
