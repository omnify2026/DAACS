import { resolveProgramIcon } from "../../../lib/programIcons";
import type { AgentProgramComponentProps } from "../../../types/program";
import { ActionButton, EmptyState } from "./ProgramButtons";
import { ProgramShell } from "./ProgramShell";

export function ApprovalQueueProgram({
  derived,
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
      {derived.approval_items.length === 0 &&
      derived.pending_intents.length === 0 &&
      derived.recent_intent_runs.length === 0 ? (
        <EmptyState label={t("workspace.empty.approvals")} />
      ) : (
        <div className="space-y-3">
          {derived.pending_intents.length > 0 ? (
            <div className="space-y-2">
              {derived.pending_intents.slice(0, 4).map((intent) => (
                <div key={intent.intent_id} className="rounded-lg bg-[#0b1220] p-3 text-xs">
                  <div className="flex items-center justify-between gap-2 text-white">
                    <span>{intent.title}</span>
                    <span className="text-amber-300">{t("workspace.label.pendingIntent")}</span>
                  </div>
                  <div className="mt-1 text-gray-300">{intent.description}</div>
                  <div className="mt-2 text-[11px] text-gray-400">
                    {intent.kind} / {intent.connector_id}
                  </div>
                </div>
              ))}
            </div>
          ) : null}
          {derived.approval_items.slice(0, 5).map((item) => (
            <div key={item.step_id} className="rounded-lg bg-[#0b1220] p-3 text-xs">
              <div className="flex items-center justify-between gap-2 text-white">
                <span>{item.label}</span>
                <span className="text-gray-400">{item.priority}</span>
              </div>
              <div className="mt-1 text-gray-300">{item.description}</div>
            </div>
          ))}
          {derived.recent_intent_runs.length > 0 ? (
            <div className="space-y-2">
              <div className="text-[11px] uppercase tracking-[0.18em] text-gray-400">
                {t("workspace.label.recentExecution")}
              </div>
              {derived.recent_intent_runs.slice(0, 4).map((intent) => (
                <div key={intent.intent_id} className="rounded-lg bg-[#0b1220] p-3 text-xs">
                  <div className="flex items-center justify-between gap-2 text-white">
                    <span>{intent.title}</span>
                    <span className="text-gray-400">{t(`workspace.intentStatus.${intent.status}`)}</span>
                  </div>
                  <div className="mt-1 text-gray-300">
                    {intent.result_summary ?? intent.description}
                  </div>
                </div>
              ))}
            </div>
          ) : null}
        </div>
      )}
      <div className="mt-3">
        <ActionButton
          label={t("workspace.action.approvalReview")}
          command={t("workspace.command.approvalReview")}
          onRunCommand={onRunCommand}
        />
      </div>
    </ProgramShell>
  );
}
