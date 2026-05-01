import { resolveAgentConnectorId } from "../../../lib/agentProgramUtils";
import type { AgentProgramComponentProps } from "../../../types/program";
import { SignalFeedProgram } from "./SignalFeedProgram";

export function AssetRefsProgram(props: AgentProgramComponentProps) {
  const { agent, data, derived, onCreateIntent, t } = props;
  const rows = [...new Set([...derived.latest_files, ...data.file_changes.map((change) => change.filePath)])]
    .slice(0, 6)
    .map((value) => (
      <div key={value} className="rounded-lg bg-[#0b1220] px-3 py-2 text-xs text-gray-100">
        {value}
      </div>
    ));

  return (
    <SignalFeedProgram
      {...props}
      rows={rows}
      emptyLabel={t("workspace.empty.logs")}
      actionLabel={t("workspace.action.assetReview")}
      command={t("workspace.command.assetReview")}
      intentButtons={
        onCreateIntent
          ? [
              {
                label: t("workspace.action.requestAssetPublish"),
                onCreate: async () => {
                  await onCreateIntent({
                    kind: "publish_asset",
                    title: t("workspace.intent.asset.title"),
                    description: t("workspace.intent.asset.description"),
                    target: agent.currentTask ?? agent.name,
                    connector_id: resolveAgentConnectorId(agent, "design", "design_assets_connector"),
                    payload: {
                      agent_role: agent.role,
                      files: derived.latest_files,
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
