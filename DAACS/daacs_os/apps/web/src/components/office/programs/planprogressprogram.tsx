import { resolveProgramIcon } from "../../../lib/programIcons";
import type { AgentProgramComponentProps } from "../../../types/program";
import { ActionButton } from "./ProgramButtons";
import { ProgramShell } from "./ProgramShell";

export function PlanProgressProgram({
  data,
  program,
  t,
  onRunCommand,
}: AgentProgramComponentProps) {
  const Icon = resolveProgramIcon(program.id);
  const plan = data.plan_view?.activePlan ?? null;
  const steps = plan?.steps ?? [];
  const completed = steps.filter((step) => step.status === "completed").length;
  const total = steps.length;

  return (
    <ProgramShell
      title={t(program.title_key)}
      description={t(program.description_key)}
      accentClass={program.accent_class}
      icon={Icon}
    >
      <div className="rounded-xl border border-white/5 bg-black/20 p-3">
        <div className="flex items-center justify-between text-sm text-white">
          <span>{plan?.goal ?? t("workspace.empty.plan")}</span>
          <span className="text-xs text-gray-400">{total > 0 ? `${completed}/${total}` : "0/0"}</span>
        </div>
        <div className="mt-3 h-2 rounded-full bg-white/10">
          <div
            className="h-2 rounded-full bg-violet-400"
            style={{ width: `${total > 0 ? (completed / total) * 100 : 0}%` }}
          />
        </div>
        <div className="mt-3 flex flex-wrap gap-2">
          <ActionButton
            label={t("workspace.action.planSummary")}
            command={t("workspace.command.planSummary")}
            onRunCommand={onRunCommand}
          />
        </div>
      </div>
    </ProgramShell>
  );
}
