import { useMemo } from "react";
import { resolveAgentConnectorId } from "../../../lib/agentProgramUtils";
import { resolveProgramIcon } from "../../../lib/programIcons";
import type { AgentProgramComponentProps } from "../../../types/program";
import { ActionButton, EmptyState, IntentButton } from "./ProgramButtons";
import { ProgramShell } from "./ProgramShell";

const LOCAL_PREVIEW_URL_PATTERN = /\bhttps?:\/\/(?:127\.0\.0\.1|localhost):\d+[^\s)]*/gi;

function extractPreviewUrls(lines: string[]): string[] {
  const matches = lines.flatMap((line) => line.match(LOCAL_PREVIEW_URL_PATTERN) ?? []);
  return [...new Set(matches.map((value) => value.trim()))].slice(0, 3);
}

function PreviewPanel({
  previewUrls,
  t,
}: {
  previewUrls: string[];
  t: AgentProgramComponentProps["t"];
}) {
  const activeUrl = previewUrls[0] ?? null;
  if (activeUrl == null) {
    return (
      <div className="rounded-xl border border-white/5 bg-black/20 p-3">
        <div className="text-[11px] uppercase tracking-[0.18em] text-gray-400">
          {t("workspace.label.preview")}
        </div>
        <div className="mt-2 rounded-lg bg-[#0b1220] px-3 py-4 text-xs text-gray-400">
          {t("workspace.empty.preview")}
        </div>
      </div>
    );
  }

  return (
    <div className="rounded-xl border border-white/5 bg-black/20 p-3">
      <div className="flex items-center justify-between gap-2">
        <div className="text-[11px] uppercase tracking-[0.18em] text-gray-400">
          {t("workspace.label.preview")}
        </div>
        <a
          href={activeUrl}
          target="_blank"
          rel="noreferrer"
          className="text-[11px] text-cyan-300 hover:text-cyan-200"
        >
          {activeUrl}
        </a>
      </div>
      <div className="mt-3 overflow-hidden rounded-lg border border-[#1f2937] bg-[#020617]">
        <iframe
          title="workspace-preview"
          src={activeUrl}
          className="h-64 w-full bg-white"
          sandbox="allow-same-origin allow-scripts allow-forms allow-modals allow-popups"
        />
      </div>
    </div>
  );
}

export function CodeOutputProgram({
  agent,
  derived,
  program,
  t,
  onRunCommand,
  onCreateIntent,
}: AgentProgramComponentProps) {
  const Icon = resolveProgramIcon(program.id);
  const connectorId = (needle: string, fallback: string) =>
    resolveAgentConnectorId(agent, needle, fallback);
  const previewUrls = useMemo(
    () => extractPreviewUrls(derived.latest_output_lines),
    [derived.latest_output_lines],
  );

  return (
    <ProgramShell
      title={t(program.title_key)}
      description={t(program.description_key)}
      accentClass={program.accent_class}
      icon={Icon}
    >
      <div className="grid gap-3 xl:grid-cols-[1.25fr_0.75fr]">
        <div className="space-y-3">
          <div className="space-y-2">
            {derived.latest_output_lines.length === 0 ? (
              <EmptyState label={t("workspace.empty.outputs")} />
            ) : (
              derived.latest_output_lines.map((line, index) => (
                <div key={`${program.id}-${index}`} className="rounded-lg bg-[#0b1220] p-3 text-xs text-gray-100">
                  {line}
                </div>
              ))
            )}
          </div>
          <PreviewPanel previewUrls={previewUrls} t={t} />
        </div>
        <div className="rounded-xl border border-white/5 bg-black/20 p-3">
          <div className="text-[11px] uppercase tracking-[0.18em] text-gray-400">
            {t("workspace.label.files")}
          </div>
          <div className="mt-2 space-y-2">
            {derived.latest_files.length === 0 ? (
              <EmptyState label={t("workspace.empty.files")} />
            ) : (
              derived.latest_files.map((fileRef) => (
                <div key={fileRef} className="rounded-lg bg-[#0b1220] px-3 py-2 text-xs text-cyan-200">
                  {fileRef}
                </div>
              ))
            )}
          </div>
          <div className="mt-3 flex flex-wrap gap-2">
            <ActionButton
              label={t("workspace.action.continueBuild")}
              command={t("workspace.command.continueBuild")}
              onRunCommand={onRunCommand}
            />
            <ActionButton
              label={t("workspace.action.createPreview")}
              command={t("workspace.command.createPreview")}
              onRunCommand={onRunCommand}
            />
            {onCreateIntent ? (
              <IntentButton
                label={t("workspace.action.requestPullRequest")}
                onCreateIntent={async () => {
                  await onCreateIntent({
                    kind: "open_pull_request",
                    title: t("workspace.intent.pullRequest.title"),
                    description: t("workspace.intent.pullRequest.description"),
                    target: agent.currentTask ?? agent.name,
                    connector_id: connectorId("git", "git_connector"),
                    payload: {
                      agent_role: agent.role,
                      latest_files: derived.latest_files,
                    },
                  });
                }}
              />
            ) : null}
            {onCreateIntent ? (
              <IntentButton
                label={t("workspace.action.requestDeploy")}
                onCreateIntent={async () => {
                  await onCreateIntent({
                    kind: "deploy_release",
                    title: t("workspace.intent.deploy.title"),
                    description: t("workspace.intent.deploy.description"),
                    target: agent.currentTask ?? agent.name,
                    connector_id: connectorId("deploy", "deploy_connector"),
                    payload: {
                      agent_role: agent.role,
                      latest_files: derived.latest_files,
                    },
                  });
                }}
              />
            ) : null}
          </div>
        </div>
      </div>
    </ProgramShell>
  );
}
