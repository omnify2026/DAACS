import type { AgentRole } from "../../types/agent";
import type { SkillBundleSummary, SkillMeta } from "../../types/runtime";
import type { BlueprintSuggestion } from "../../lib/agentDesignAssistant";
import type {
  FactoryBlueprintDraft,
  FactoryTemplate,
} from "../../lib/runtimeBuilder";
import type { TranslateFn } from "./agentFactoryShared";
import { AgentFactoryLivePreview } from "./AgentFactoryLivePreview";
import { AgentFactoryProfileForm } from "./AgentFactoryProfileForm";
import { AgentFactorySkillPicker } from "./AgentFactorySkillPicker";

type SelectedSkill = {
  id: string;
  meta: SkillMeta | undefined;
};

interface Props {
  t: TranslateFn;
  aiSuggestion: BlueprintSuggestion | null;
  aiDesigning: boolean;
  canUseAiAssist: boolean;
  onAiDesign: () => void;
  selectedTemplate: FactoryTemplate;
  draft: FactoryBlueprintDraft;
  previewRole: AgentRole;
  characterFilename: string | null;
  onCharacterCustomize: () => void;
  canUseCharacterCustomize: boolean;
  name: string;
  roleLabel: string;
  capabilities: string;
  prompt: string;
  skillBrowserOpen: boolean;
  skillSearch: string;
  filteredSkills: SkillMeta[];
  selectedSkills: SelectedSkill[];
  selectedBundleInfo: SkillBundleSummary[string] | undefined;
  onNameChange: (value: string) => void;
  onRoleLabelChange: (value: string) => void;
  onCapabilitiesChange: (value: string) => void;
  onPromptChange: (value: string) => void;
  onSkillBrowserToggle: () => void;
  onSkillSearchChange: (value: string) => void;
  onToggleSkillSelection: (skillId: string) => void;
}

export function AgentFactoryEditStep({
  t,
  aiSuggestion,
  aiDesigning,
  canUseAiAssist,
  onAiDesign,
  selectedTemplate,
  draft,
  previewRole,
  characterFilename,
  onCharacterCustomize,
  canUseCharacterCustomize,
  name,
  roleLabel,
  capabilities,
  prompt,
  skillBrowserOpen,
  skillSearch,
  filteredSkills,
  selectedSkills,
  selectedBundleInfo,
  onNameChange,
  onRoleLabelChange,
  onCapabilitiesChange,
  onPromptChange,
  onSkillBrowserToggle,
  onSkillSearchChange,
  onToggleSkillSelection,
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

        <AgentFactoryProfileForm
          t={t}
          selectedTemplate={selectedTemplate}
          name={name}
          roleLabel={roleLabel}
          capabilities={capabilities}
          onNameChange={onNameChange}
          onRoleLabelChange={onRoleLabelChange}
          onCapabilitiesChange={onCapabilitiesChange}
        />

        <label className="block">
          <div className="mb-1 flex items-center justify-between gap-3">
            <span className="text-xs text-gray-400">{t("factory.field.promptDescriptionContent")}</span>
            <button
              type="button"
              onClick={onAiDesign}
              disabled={!canUseAiAssist}
              className="rounded-lg border border-violet-500/40 bg-violet-500/10 px-3 py-1 text-[11px] font-medium text-violet-200 disabled:opacity-40"
            >
              {aiDesigning ? t("factory.aiDesigning") : t("factory.aiRefresh")}
            </button>
          </div>
          <textarea
            value={prompt}
            onChange={(event) => onPromptChange(event.target.value)}
            className="h-36 w-full rounded-lg border border-[#374151] bg-[#0b1220] p-3"
            placeholder={t("factory.placeholder")}
          />
        </label>

        <AgentFactorySkillPicker
          t={t}
          skillBrowserOpen={skillBrowserOpen}
          skillSearch={skillSearch}
          filteredSkills={filteredSkills}
          selectedSkills={selectedSkills}
          selectedBundleInfo={selectedBundleInfo}
          onSkillBrowserToggle={onSkillBrowserToggle}
          onSkillSearchChange={onSkillSearchChange}
          onToggleSkillSelection={onToggleSkillSelection}
        />
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
