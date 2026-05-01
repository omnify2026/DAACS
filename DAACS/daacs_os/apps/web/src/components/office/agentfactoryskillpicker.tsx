import type { SkillBundleSummary, SkillMeta } from "../../types/runtime";
import type { TranslateFn } from "./agentFactoryShared";

type SelectedSkill = {
  id: string;
  meta: SkillMeta | undefined;
};

interface Props {
  t: TranslateFn;
  skillBrowserOpen: boolean;
  skillSearch: string;
  filteredSkills: SkillMeta[];
  selectedSkills: SelectedSkill[];
  selectedBundleInfo: SkillBundleSummary[string] | undefined;
  onSkillBrowserToggle: () => void;
  onSkillSearchChange: (value: string) => void;
  onToggleSkillSelection: (skillId: string) => void;
}

export function AgentFactorySkillPicker({
  t,
  skillBrowserOpen,
  skillSearch,
  filteredSkills,
  selectedSkills,
  selectedBundleInfo,
  onSkillBrowserToggle,
  onSkillSearchChange,
  onToggleSkillSelection,
}: Props) {
  return (
    <div className="rounded-xl border border-[#374151] bg-[#0b1220] p-4">
      <div className="flex items-center justify-between gap-3">
        <div>
          <div className="text-sm font-semibold text-cyan-300">
            {t("factory.edit.skillsTitle")}
          </div>
          <div className="mt-1 text-xs text-gray-400">
            {t("factory.edit.skillsDescription")}
          </div>
        </div>
        <button
          type="button"
          onClick={onSkillBrowserToggle}
          className="rounded-lg border border-[#374151] px-3 py-1 text-xs"
        >
          {skillBrowserOpen ? t("factory.skillBrowser.close") : t("factory.skillBrowser.open")}
        </button>
      </div>

      {skillBrowserOpen ? (
        <div className="mt-3 space-y-3">
          <input
            value={skillSearch}
            onChange={(event) => onSkillSearchChange(event.target.value)}
            className="w-full rounded-lg border border-[#374151] bg-[#111827] px-3 py-2 text-sm"
            placeholder={t("factory.field.skillSearch")}
          />
          <div className="grid max-h-64 gap-2 overflow-y-auto rounded-lg border border-[#1f2937] bg-[#111827] p-3">
            {filteredSkills.map((skill) => {
              const checked = selectedSkills.some((selected) => selected.id === skill.id);
              return (
                <label
                  key={skill.id}
                  className={`rounded-lg border p-3 text-left ${
                    checked ? "border-cyan-400 bg-cyan-500/10" : "border-[#374151]"
                  }`}
                >
                  <div className="flex items-start gap-2">
                    <input
                      type="checkbox"
                      checked={checked}
                      onChange={() => onToggleSkillSelection(skill.id)}
                      className="mt-1"
                    />
                    <div>
                      <div className="text-sm font-medium text-white">
                        {skill.displayName?.trim() && skill.displayName.trim() !== skill.id
                          ? skill.displayName.trim()
                          : skill.id}
                      </div>
                      {skill.displayName?.trim() && skill.displayName.trim() !== skill.id ? (
                        <div className="text-[11px] font-mono text-gray-500">{skill.id}</div>
                      ) : null}
                      <div className="mt-1 text-xs text-gray-400">{skill.description}</div>
                    </div>
                  </div>
                </label>
              );
            })}
          </div>
        </div>
      ) : null}

      <div className="mt-3 flex flex-wrap gap-2">
        {selectedSkills.length > 0 ? (
          selectedSkills.map(({ id, meta }) => (
            <button
              key={id}
              type="button"
              onClick={() => onToggleSkillSelection(id)}
              className="rounded-full border border-cyan-500/30 bg-cyan-500/10 px-3 py-1 text-left text-[11px] text-cyan-100"
            >
              <span className="font-semibold">
                {meta?.displayName?.trim() && meta.displayName.trim() !== id
                  ? meta.displayName.trim()
                  : id}
              </span>
              {meta?.description ? (
                <span className="ml-2 text-cyan-200/80">{meta.description}</span>
              ) : null}
            </button>
          ))
        ) : (
          <div className="text-xs text-gray-500">{t("factory.edit.noSkills")}</div>
        )}
      </div>

      {selectedBundleInfo ? (
        <div className="mt-4 rounded-lg border border-[#1f2937] bg-[#111827] p-3 text-xs text-gray-300">
          <div className="font-semibold text-cyan-200">{selectedSkills[0]?.id}</div>
          <div className="mt-1 text-gray-400">{selectedBundleInfo.description}</div>
          <div className="mt-2">
            {t("factory.edit.skillCore")}:{" "}
            {selectedBundleInfo.core_skills.join(", ") || t("factory.none")}
          </div>
        </div>
      ) : null}
    </div>
  );
}
