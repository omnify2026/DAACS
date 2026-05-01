import { resolveProgramIcon } from "../../../lib/programIcons";
import type { AgentProgramComponentProps } from "../../../types/program";
import { EmptyState } from "./ProgramButtons";
import { ProgramShell } from "./ProgramShell";

export function HandoffFeedProgram({
  data,
  program,
  t,
}: AgentProgramComponentProps) {
  const Icon = resolveProgramIcon(program.id);

  return (
    <ProgramShell
      title={t(program.title_key)}
      description={t(program.description_key)}
      accentClass={program.accent_class}
      icon={Icon}
    >
      {data.messages.length === 0 ? (
        <EmptyState label={t("workspace.empty.handoffs")} />
      ) : (
        <div className="space-y-2">
          {data.messages.slice(0, 5).map((message) => (
            <div key={message.id} className="rounded-lg bg-[#0b1220] p-3 text-xs">
              <div className="flex items-center justify-between gap-2 text-gray-300">
                <span>
                  {message.from} -&gt; {message.to}
                </span>
                <span>{new Date(message.timestamp).toLocaleTimeString()}</span>
              </div>
              <div className="mt-1 text-gray-100">{message.content}</div>
            </div>
          ))}
        </div>
      )}
    </ProgramShell>
  );
}
