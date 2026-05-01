import type { ReactNode } from "react";

import { resolveProgramIcon } from "../../../lib/programIcons";
import type { AgentProgramComponentProps } from "../../../types/program";
import { ActionButton, EmptyState, IntentButton } from "./ProgramButtons";
import { ProgramShell } from "./ProgramShell";

export function SignalFeedProgram({
  program,
  t,
  onRunCommand,
  rows,
  emptyLabel,
  actionLabel,
  command,
  intentButtons,
}: AgentProgramComponentProps & {
  rows: ReactNode[];
  emptyLabel: string;
  actionLabel: string;
  command: string;
  intentButtons?: Array<{
    label: string;
    onCreate: () => Promise<void>;
  }>;
}) {
  const Icon = resolveProgramIcon(program.id);

  return (
    <ProgramShell
      title={t(program.title_key)}
      description={t(program.description_key)}
      accentClass={program.accent_class}
      icon={Icon}
    >
      {rows.length === 0 ? <EmptyState label={emptyLabel} /> : <div className="space-y-2">{rows}</div>}
      <div className="mt-3 flex flex-wrap gap-2">
        <ActionButton label={actionLabel} command={command} onRunCommand={onRunCommand} />
        {(intentButtons ?? []).map((button) => (
          <IntentButton
            key={button.label}
            label={button.label}
            onCreateIntent={button.onCreate}
          />
        ))}
      </div>
    </ProgramShell>
  );
}
