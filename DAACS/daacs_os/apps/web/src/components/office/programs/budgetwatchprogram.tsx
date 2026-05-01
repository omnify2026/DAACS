import { resolveAgentConnectorId } from "../../../lib/agentProgramUtils";
import type { AgentProgramComponentProps } from "../../../types/program";
import { SignalFeedProgram } from "./SignalFeedProgram";

export function BudgetWatchProgram(props: AgentProgramComponentProps) {
  const { agent, derived, onCreateIntent, t } = props;

  return (
    <SignalFeedProgram
      {...props}
      rows={derived.latest_output_lines.map((line, index) => (
        <div key={`${props.program.id}-${index}`} className="rounded-lg bg-[#0b1220] p-3 text-xs text-gray-100">
          {line}
        </div>
      ))}
      emptyLabel={t("workspace.empty.logs")}
      actionLabel={t("workspace.action.costSummary")}
      command={t("workspace.command.costSummary")}
      intentButtons={
        onCreateIntent
          ? [
              {
                label: t("workspace.action.requestBudgetChange"),
                onCreate: async () => {
                  await onCreateIntent({
                    kind: "submit_budget_update",
                    title: t("workspace.intent.budget.title"),
                    description: t("workspace.intent.budget.description"),
                    target: agent.currentTask ?? agent.name,
                    connector_id: resolveAgentConnectorId(agent, "finance", "finance_connector"),
                    payload: {
                      agent_role: agent.role,
                    },
                  });
                },
              },
            ]
          : undefined
      }
    />
  );
}
