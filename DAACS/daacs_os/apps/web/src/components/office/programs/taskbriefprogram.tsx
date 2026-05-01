import { resolveProgramIcon } from "../../../lib/programIcons";
import type { AgentProgramComponentProps } from "../../../types/program";
import { ActionButton } from "./ProgramButtons";
import { ProgramShell } from "./ProgramShell";

export function TaskBriefProgram({
  agent,
  program,
  t,
  onRunCommand,
}: AgentProgramComponentProps) {
  const Icon = resolveProgramIcon(program.id);

  return (
    <ProgramShell
      title={t(program.title_key)}
      description={t(program.description_key)}
      accentClass={program.accent_class}
      icon={Icon}
    >
      <div className="grid gap-3 lg:grid-cols-[1.4fr_0.6fr]">
        <div className="rounded-xl border border-white/5 bg-black/20 p-3">
          <div className="text-[11px] uppercase tracking-[0.18em] text-gray-400">
            {t("workspace.label.currentTask")}
          </div>
          <div className="mt-2 text-sm text-white">
            {agent.currentTask ?? t("focus.noTask")}
          </div>
          <div className="mt-4 flex flex-wrap gap-2">
            <ActionButton
              label={t("workspace.action.status")}
              command={t("focus.quick.status")}
              onRunCommand={onRunCommand}
            />
            <ActionButton
              label={t("workspace.action.blockers")}
              command={t("focus.quick.blockers")}
              onRunCommand={onRunCommand}
            />
          </div>
        </div>
        <div className="space-y-3">
          <div className="rounded-xl border border-white/5 bg-black/20 p-3">
            <div className="text-[11px] uppercase tracking-[0.18em] text-gray-400">
              {t("workspace.label.workspaceMode")}
            </div>
            <div className="mt-2 text-sm text-white">
              {agent.operatingProfile?.workspace_mode ?? "adaptive_workspace"}
            </div>
          </div>
          <div className="rounded-xl border border-white/5 bg-black/20 p-3">
            <div className="text-[11px] uppercase tracking-[0.18em] text-gray-400">
              {t("workspace.label.connectors")}
            </div>
            <div className="mt-2 flex flex-wrap gap-2">
              {(agent.operatingProfile?.tool_connectors ?? []).map((connector) => (
                <span
                  key={`${program.id}-${connector}`}
                  className="rounded-full border border-white/10 px-2 py-1 text-[11px] text-gray-200"
                >
                  {connector}
                </span>
              ))}
            </div>
          </div>
        </div>
      </div>
    </ProgramShell>
  );
}
