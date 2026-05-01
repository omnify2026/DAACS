import { X } from "lucide-react";
import { useEffect, useMemo, useState } from "react";

import { designCompany, type AgentSpec, type CompanyBuildPlan } from "../../lib/companyBuilder";
import { loadSkillCatalog } from "../../lib/skillCatalog";
import {
  buildFactoryBlueprintDraft,
  inferTemplateFromSignals,
} from "../../lib/runtimeBuilder";
import * as runtimeApi from "../../services/runtimeApi";
import { isTauri } from "../../services/tauriCli";
import { useOfficeStore } from "../../stores/officeStore";
import type { SkillMeta } from "../../types/runtime";

interface Props {
  open: boolean;
  onClose: () => void;
}

function splitCsv(value: string): string[] {
  return [...new Set(value.split(",").map((item) => item.trim()).filter(Boolean))];
}

function normalizeSkillIds(value: string[], skillCatalog: SkillMeta[]): string[] {
  const available = new Set(skillCatalog.map((skill) => skill.id));
  return [...new Set(value.filter((skillId) => available.has(skillId)).slice(0, 12))];
}

function draftFromSpec(spec: AgentSpec, skillCatalog: SkillMeta[]) {
  const template = inferTemplateFromSignals(
    spec.selected_skills.includes("design") ? ["design"] : ["execution"],
    spec.selected_skills,
    spec.role_label,
  );
  const selectedSkills = normalizeSkillIds(spec.selected_skills, skillCatalog);
  return buildFactoryBlueprintDraft(template, {
    name: spec.name,
    prompt: spec.responsibilities,
    roleLabel: spec.role_label,
    skillBundleRefs: selectedSkills,
  });
}

export function CompanyBuilderModal({ open, onClose }: Props) {
  const {
    projectId,
    addNotification,
    buildCompanyAgentsLocal,
    clockIn,
  } = useOfficeStore();
  const [goal, setGoal] = useState("");
  const [industry, setIndustry] = useState("");
  const [teamSize, setTeamSize] = useState("5");
  const [skillCatalog, setSkillCatalog] = useState<SkillMeta[]>([]);
  const [plan, setPlan] = useState<CompanyBuildPlan | null>(null);
  const [designing, setDesigning] = useState(false);
  const [creating, setCreating] = useState(false);

  const catalogHint = useMemo(
    () => skillCatalog.slice(0, 20).map((skill) => skill.id).join(", "),
    [skillCatalog],
  );

  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    void loadSkillCatalog()
      .then((nextCatalog) => {
        if (!cancelled) {
          setSkillCatalog(nextCatalog);
        }
      })
      .catch(() => {
        if (!cancelled) {
          setSkillCatalog([]);
        }
      });
    return () => {
      cancelled = true;
    };
  }, [open]);

  if (!open) return null;

  const updateAgent = (index: number, next: Partial<AgentSpec>) => {
    setPlan((current) => {
      if (!current) return current;
      return {
        ...current,
        agents: current.agents.map((agent, agentIndex) =>
          agentIndex === index ? { ...agent, ...next } : agent,
        ),
      };
    });
  };

  const removeAgent = (index: number) => {
    setPlan((current) => {
      if (!current) return current;
      return {
        ...current,
        agents: current.agents.filter((_, agentIndex) => agentIndex !== index),
      };
    });
  };

  const addAgent = () => {
    setPlan((current) => ({
      company_name: current?.company_name || "Generated Company",
      rationale: current?.rationale || "",
      agents: [
        ...(current?.agents ?? []),
        {
          name: "",
          role_label: "custom_agent",
          selected_skills: [],
          responsibilities: "",
        },
      ],
    }));
  };

  const handleDesign = async () => {
    if (designing || !goal.trim() || skillCatalog.length === 0) return;
    setDesigning(true);
    try {
      const nextPlan = await designCompany(
        {
          goal,
          industry,
          teamSize: Number.parseInt(teamSize, 10) || undefined,
        },
        skillCatalog,
        projectId,
      );
      if (!nextPlan) {
        addNotification({
          type: "warning",
          message: "Company Builder가 유효한 팀 설계를 만들지 못했습니다.",
        });
        return;
      }
      setPlan(nextPlan);
      addNotification({
        type: "success",
        message: `팀 설계 완료: ${nextPlan.agents.length} agents`,
      });
    } finally {
      setDesigning(false);
    }
  };

  const handleCreate = async () => {
    if (creating || !plan || plan.agents.length === 0) return;
    if (!projectId && !isTauri()) return;

    const normalizedAgents = plan.agents
      .map((agent) => ({
        ...agent,
        name: agent.name.trim(),
        role_label: agent.role_label.trim(),
        responsibilities: agent.responsibilities.trim(),
        selected_skills: normalizeSkillIds(agent.selected_skills, skillCatalog),
      }))
      .filter(
        (agent) =>
          agent.name &&
          agent.role_label &&
          agent.responsibilities &&
          agent.selected_skills.length > 0,
      );

    if (normalizedAgents.length === 0) {
      addNotification({
        type: "warning",
        message: "생성 가능한 agent spec이 없습니다.",
      });
      return;
    }

    setCreating(true);
    try {
      if (isTauri()) {
        const result = await buildCompanyAgentsLocal(
          normalizedAgents.map((agent) => {
            const draft = draftFromSpec(agent, skillCatalog);
            return {
              name: draft.blueprint.name,
              roleLabel: draft.blueprint.role_label,
              prompt: agent.responsibilities,
              capabilities: draft.blueprint.capabilities ?? [],
              skillBundleRefs: agent.selected_skills,
              uiProfile: draft.previewAgent.uiProfile,
            };
          }),
        );
        addNotification({
          type: result.skipped > 0 ? "warning" : "success",
          message: `회사 생성 완료: ${result.created} created / ${result.skipped} skipped`,
        });
        onClose();
        return;
      }

      await runtimeApi.bootstrapRuntime(projectId!, {});
      for (const agent of normalizedAgents) {
        const draft = draftFromSpec(agent, skillCatalog);
        const blueprint = await runtimeApi.createBlueprint(draft.blueprint);
        await runtimeApi.createInstance(projectId!, {
          blueprint_id: blueprint.id,
          assigned_team: draft.blueprint.ui_profile?.team_affinity,
        });
      }
      await clockIn();
      addNotification({
        type: "success",
        message: `회사 생성 완료: ${normalizedAgents.length} agents`,
      });
      onClose();
    } catch (error) {
      addNotification({
        type: "error",
        message: error instanceof Error ? error.message : "회사 생성에 실패했습니다.",
      });
    } finally {
      setCreating(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-3 sm:p-4 lg:p-6">
      <div className="relative flex max-h-[calc(100vh-1.5rem)] w-full max-w-6xl flex-col overflow-hidden rounded-2xl border border-[#374151] bg-[#111827] text-white shadow-2xl">
        <button
          type="button"
          onClick={onClose}
          aria-label="Close"
          className="absolute right-4 top-4 z-10 rounded-lg border border-[#374151] bg-[#111827]/90 p-2 text-gray-300 transition-colors hover:bg-white/5 hover:text-white"
        >
          <X className="h-4 w-4" />
        </button>
        <div className="flex shrink-0 items-start justify-between gap-3 border-b border-[#374151] px-4 py-4 sm:px-5">
          <div>
            <h3 className="text-lg font-bold">Company Builder</h3>
            <p className="mt-1 text-sm text-gray-400">
              회사 목표를 넣으면 AI가 필요한 agent 조직을 설계하고 한 번에 생성합니다.
            </p>
          </div>
          <button onClick={onClose} className="rounded-lg border border-[#374151] px-3 py-2 text-sm">
            닫기
          </button>
        </div>

        <div className="min-h-0 flex-1 overflow-y-auto px-4 py-4 sm:px-5">
          <div className="grid gap-6 xl:grid-cols-[0.9fr_1.1fr]">
          <div className="space-y-4">
            <label className="block">
              <div className="mb-1 text-xs text-gray-400">회사 목표</div>
              <textarea
                value={goal}
                onChange={(event) => setGoal(event.target.value)}
                className="h-40 w-full rounded-lg border border-[#374151] bg-[#0b1220] p-3"
                placeholder="예: 핀테크 SaaS 스타트업 팀을 만들어서 결제 API, 대시보드, 마케팅까지 굴릴 수 있게 해줘"
              />
            </label>

            <div className="grid gap-4 md:grid-cols-2">
              <label className="block">
                <div className="mb-1 text-xs text-gray-400">산업</div>
                <input
                  value={industry}
                  onChange={(event) => setIndustry(event.target.value)}
                  className="w-full rounded-lg border border-[#374151] bg-[#0b1220] px-3 py-2"
                  placeholder="핀테크, SaaS, 이커머스"
                />
              </label>
              <label className="block">
                <div className="mb-1 text-xs text-gray-400">희망 팀 크기</div>
                <input
                  value={teamSize}
                  onChange={(event) => setTeamSize(event.target.value)}
                  className="w-full rounded-lg border border-[#374151] bg-[#0b1220] px-3 py-2"
                  placeholder="5"
                />
              </label>
            </div>

            <div className="rounded-xl border border-[#374151] bg-[#0b1220] p-4 text-xs text-gray-300">
              <div className="font-semibold text-cyan-300">Skill Catalog</div>
              <div className="mt-2">{skillCatalog.length} skills loaded</div>
              <div className="mt-2 text-gray-400">{catalogHint || "No catalog loaded."}</div>
            </div>

            <div className="flex gap-2">
              <button
                type="button"
                onClick={() => void handleDesign()}
                disabled={designing || !goal.trim() || skillCatalog.length === 0 || !isTauri()}
                className="rounded-lg bg-violet-600 px-4 py-2 text-sm disabled:opacity-40"
              >
                {designing ? "설계 중..." : "AI로 팀 설계"}
              </button>
              <button
                type="button"
                onClick={addAgent}
                className="rounded-lg border border-[#374151] px-4 py-2 text-sm"
              >
                Agent 추가
              </button>
            </div>

            {!isTauri() ? (
              <div className="rounded-lg border border-amber-500/30 bg-amber-500/10 p-3 text-xs text-amber-100">
                Company Builder의 AI 설계 단계는 현재 Tauri Local CLI에서만 동작합니다.
              </div>
            ) : null}
          </div>

          <div className="space-y-4">
            <div className="rounded-xl border border-[#374151] bg-[#0b1220] p-4">
              <div className="flex items-center justify-between gap-3">
                <div>
                  <div className="text-sm font-semibold text-cyan-300">
                    {plan?.company_name || "Generated Team Preview"}
                  </div>
                  <div className="mt-1 text-xs text-gray-400">
                    {plan?.rationale || "아직 생성된 팀 설계가 없습니다."}
                  </div>
                </div>
                <button
                  type="button"
                  onClick={() => void handleCreate()}
                  disabled={creating || !plan || plan.agents.length === 0}
                  className="rounded-lg bg-cyan-600 px-4 py-2 text-sm disabled:opacity-40"
                >
                  {creating ? "생성 중..." : "회사 생성"}
                </button>
              </div>
            </div>

            <div className="max-h-[560px] space-y-3 overflow-y-auto pr-1">
              {(plan?.agents ?? []).map((agent, index) => (
                <div
                  key={`${agent.role_label}-${index}`}
                  className="rounded-xl border border-[#374151] bg-[#0b1220] p-4"
                >
                  <div className="mb-3 flex items-center justify-between gap-3">
                    <div className="text-sm font-semibold text-white">Agent {index + 1}</div>
                    <button
                      type="button"
                      onClick={() => removeAgent(index)}
                      className="rounded-lg border border-red-500/30 px-3 py-1 text-xs text-red-200"
                    >
                      제거
                    </button>
                  </div>

                  <div className="grid gap-4 md:grid-cols-2">
                    <label className="block">
                      <div className="mb-1 text-xs text-gray-400">이름</div>
                      <input
                        value={agent.name}
                        onChange={(event) => updateAgent(index, { name: event.target.value })}
                        className="w-full rounded-lg border border-[#374151] bg-[#111827] px-3 py-2"
                      />
                    </label>
                    <label className="block">
                      <div className="mb-1 text-xs text-gray-400">Role label</div>
                      <input
                        value={agent.role_label}
                        onChange={(event) => updateAgent(index, { role_label: event.target.value })}
                        className="w-full rounded-lg border border-[#374151] bg-[#111827] px-3 py-2"
                      />
                    </label>
                  </div>

                  <label className="mt-3 block">
                    <div className="mb-1 text-xs text-gray-400">Responsibilities</div>
                    <textarea
                      value={agent.responsibilities}
                      onChange={(event) =>
                        updateAgent(index, { responsibilities: event.target.value })
                      }
                      className="h-24 w-full rounded-lg border border-[#374151] bg-[#111827] p-3"
                    />
                  </label>

                  <label className="mt-3 block">
                    <div className="mb-1 text-xs text-gray-400">Selected skills (CSV)</div>
                    <textarea
                      value={agent.selected_skills.join(", ")}
                      onChange={(event) =>
                        updateAgent(index, {
                          selected_skills: normalizeSkillIds(splitCsv(event.target.value), skillCatalog),
                        })
                      }
                      className="h-24 w-full rounded-lg border border-[#374151] bg-[#111827] p-3"
                    />
                  </label>

                  <div className="mt-3 flex flex-wrap gap-2">
                    {agent.selected_skills.map((skillId) => (
                      <span
                        key={`${skillId}-${index}`}
                        className="rounded-full border border-cyan-500/30 bg-cyan-500/10 px-2 py-1 text-[11px] text-cyan-100"
                      >
                        {skillId}
                      </span>
                    ))}
                  </div>
                </div>
              ))}
            </div>
          </div>
          </div>
        </div>
      </div>
    </div>
  );
}
