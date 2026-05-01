import { resolveAgentConnectorId } from "../../../lib/agentProgramUtils";
import type { AgentProgramComponentProps } from "../../../types/program";
import { SignalFeedProgram } from "./SignalFeedProgram";

export function OpsStatusProgram(props: AgentProgramComponentProps) {
  const { agent, data, onCreateIntent, t } = props;

  return (
    <SignalFeedProgram
      {...props}
      rows={data.merged_logs.slice(0, 4).map((row, index) => (
        <div key={`${props.program.id}-${index}`} className="rounded-lg bg-[#0b1220] p-3 text-xs">
          <div className="text-gray-400">{new Date(row.at).toLocaleString()}</div>
          <div className="mt-1 text-gray-100">
            {row.kind === "cli"
              ? row.cli.stdout || row.cli.stderr || row.cli.stdin || "CLI"
              : row.stream.content}
          </div>
        </div>
      ))}
      emptyLabel={t("workspace.empty.logs")}
      actionLabel={t("workspace.action.opsSummary")}
      command={t("workspace.command.opsSummary")}
      intentButtons={
        onCreateIntent
          ? [
              {
                label: t("workspace.action.requestOpsRun"),
                onCreate: async () => {
                  await onCreateIntent({
                    kind: "run_ops_action",
                    title: t("workspace.intent.ops.title"),
                    description: t("workspace.intent.ops.description"),
                    target: agent.currentTask ?? agent.name,
                    connector_id: resolveAgentConnectorId(agent, "runtime", "runtime_ops_connector"),
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
