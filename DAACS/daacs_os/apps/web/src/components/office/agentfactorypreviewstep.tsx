import type { AgentRole } from "../../types/agent";
import type { SkillMeta } from "../../types/runtime";
import type { BlueprintSuggestion } from "../../lib/agentDesignAssistant";
import type { FactoryBlueprintDraft } from "../../lib/runtimeBuilder";
import type { TranslateFn } from "./agentFactoryShared";
import { AgentFactoryLivePreview } from "./AgentFactoryLivePreview";

type SelectedSkill = {
  id: string;
  meta: SkillMeta | undefined;
};

interface Props {
  t: TranslateFn;
  draft: FactoryBlueprintDraft;
  previewRole: AgentRole;
  characterFilename: string | null;
  selectedSkills: SelectedSkill[];
  aiSuggestion: BlueprintSuggestion | null;
  name: string;
  roleLabel: string;
  capabilities: string;
  prompt: string;
  onCharacterCustomize: () => void;
  canUseCharacterCustomize: boolean;
}

export function AgentFactoryPreviewStep({
  t,
  draft,
  previewRole,
  characterFilename,
  selectedSkills,
  aiSuggestion,
  name,
  roleLabel,
  capabilities,
  prompt,
  onCharacterCustomize,
  canUseCharacterCustomize,
}: Props) {
  return (
    <div className="grid gap-6 xl:grid-cols-[1.05fr_0.95fr]">
      <div className="space-y-4">
        {aiSuggestion?.explanation ? (
          <div className="rounded-xl border border-violet-500/30 bg-violet-500/10 p-4">
            <div className="text-xs uppercase tracking-[0.18em] text-violet-200">
              {t("factory.edit.aiReason")}
            </div>
            <div className="mt-2 text-sm text-violet-50">{aiSuggestion.explanation}</div>
          </div>
        ) : null}

        <div className="grid gap-4 md:grid-cols-2">
          <label className="block">
            <div className="mb-1 text-xs text-gray-400">{t("factory.field.name")}</div>
            <input
              readOnly
              value={name}
              className="w-full cursor-default rounded-lg border border-[#374151] bg-[#111827] px-3 py-2 text-gray-200"
            />
          </label>
          <label className="block">
            <div className="mb-1 text-xs text-gray-400">{t("factory.field.agentId")}</div>
            <input
              readOnly
              value={roleLabel}
              className="w-full cursor-default rounded-lg border border-[#374151] bg-[#111827] px-3 py-2 text-gray-200"
            />
          </label>
          <label className="block md:col-span-2">
            <div className="mb-1 text-xs text-gray-400">{t("factory.field.capabilities")}</div>
            <input
              readOnly
              value={capabilities}
              className="w-full cursor-default rounded-lg border border-[#374151] bg-[#111827] px-3 py-2 text-gray-200"
            />
          </label>
        </div>

        <label className="block">
          <div className="mb-1 text-xs text-gray-400">{t("factory.field.promptDescriptionContent")}</div>
          <textarea
            readOnly
            value={prompt}
            className="h-36 w-full cursor-default resize-none rounded-lg border border-[#374151] bg-[#111827] p-3 text-gray-200"
          />
        </label>

        <div className="rounded-xl border border-[#374151] bg-[#0b1220] p-4">
          <div className="text-sm font-semibold text-cyan-300">{t("factory.edit.skillsTitle")}</div>
          <div className="mt-1 text-xs text-gray-400">{t("factory.edit.skillsDescription")}</div>
          <div className="mt-3">
            {selectedSkills.length === 0 ? (
              <p className="text-xs text-gray-500">{t("factory.edit.noSkills")}</p>
            ) : (
              <ul className="flex flex-col gap-2">
                {selectedSkills.map((s) => (
                  <li
                    key={s.id}
                    className="rounded-lg border border-[#2A2A4A] bg-[#111827] px-3 py-2 text-xs text-gray-200"
                  >
                    <span className="font-mono text-cyan-200/90">{s.id}</span>
                    {s.meta?.description != null && s.meta.description.trim() !== "" ? (
                      <span className="mt-0.5 block text-[11px] text-gray-500">{s.meta.description}</span>
                    ) : null}
                  </li>
                ))}
              </ul>
            )}
          </div>
        </div>
      </div>

      <div className="space-y-4">
        <AgentFactoryLivePreview
          t={t}
          draft={draft}
          previewRole={previewRole}
          characterFilename={characterFilename}
          selectedSkills={selectedSkills}
          onCharacterCustomize={onCharacterCustomize}
          canUseCharacterCustomize={canUseCharacterCustomize}
        />
      </div>
    </div>
  );
}
