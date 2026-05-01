import { resolveAgentConnectorId } from "../../../lib/agentProgramUtils";
import type { AgentProgramComponentProps } from "../../../types/program";
import { SignalFeedProgram } from "./SignalFeedProgram";

export function ContentPipelineProgram(props: AgentProgramComponentProps) {
  const { agent, derived, onCreateIntent, t } = props;
  const summary = derived.latest_output_lines.join("\n");

  return (
    <SignalFeedProgram
      {...props}
      rows={derived.latest_output_lines.map((line, index) => (
        <div key={`${props.program.id}-${index}`} className="rounded-lg bg-[#0b1220] p-3 text-xs text-gray-100">
          {line}
        </div>
      ))}
      emptyLabel={t("workspace.empty.logs")}
      actionLabel={t("workspace.action.contentDraft")}
      command={t("workspace.command.contentDraft")}
      intentButtons={
        onCreateIntent
          ? [
              {
                label: t("workspace.action.requestPublish"),
                onCreate: async () => {
                  await onCreateIntent({
                    kind: "publish_content",
                    title: t("workspace.intent.publish.title"),
                    description: t("workspace.intent.publish.description"),
                    target: agent.currentTask ?? agent.name,
                    connector_id: resolveAgentConnectorId(agent, "social", "social_publish_connector"),
                    payload: {
                      agent_role: agent.role,
                      summary,
                    },
                  });
                },
              },
              {
                label: t("workspace.action.requestCampaignLaunch"),
                onCreate: async () => {
                  await onCreateIntent({
                    kind: "launch_campaign",
                    title: t("workspace.intent.campaign.title"),
                    description: t("workspace.intent.campaign.description"),
                    target: agent.currentTask ?? agent.name,
                    connector_id: resolveAgentConnectorId(agent, "ads", "ads_connector"),
                    payload: {
                      agent_role: agent.role,
                      summary,
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
