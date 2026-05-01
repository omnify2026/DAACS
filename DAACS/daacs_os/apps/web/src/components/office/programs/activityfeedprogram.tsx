import type { AgentProgramComponentProps } from "../../../types/program";
import { SignalFeedProgram } from "./SignalFeedProgram";

export function ActivityFeedProgram(props: AgentProgramComponentProps) {
  return (
    <SignalFeedProgram
      {...props}
      rows={props.derived.latest_output_lines.map((line, index) => (
        <div key={`${props.program.id}-${index}`} className="rounded-lg bg-[#0b1220] p-3 text-xs text-gray-100">
          {line}
        </div>
      ))}
      emptyLabel={props.t("workspace.empty.logs")}
      actionLabel={props.t("workspace.action.activitySummary")}
      command={props.t("workspace.command.activitySummary")}
    />
  );
}
