import {
  FACTORY_TEMPLATES,
  buildFactoryBlueprintDraft,
  inferTemplateFromSignals,
} from "./runtimeBuilder";

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) {
    throw new Error(message);
  }
}

const builderTemplate = FACTORY_TEMPLATES.find((template) => template.id === "builder");
assert(builderTemplate, "builder template should exist");

const draft = buildFactoryBlueprintDraft(builderTemplate, {
  name: "Strategy Scout",
  prompt: "Turn the quarterly launch brief into a runnable execution plan.",
  roleLabel: "strategy_scout",
  capabilities: ["research", "planning", "approval"],
  skillBundleRefs: ["pm"],
  toolAllowlist: ["workspace.read", "terminal.exec"],
  permissionMode: "owner_required",
  memoryMode: "session_scoped",
  accentColor: "#14B8A6",
  homeZone: "strategy_hub",
  teamAffinity: "strategy_team",
  authorityLevel: 42,
  focusMode: "strategy",
  meetingBehavior: "briefing",
  primaryWidgets: ["timeline", "execution_graph"],
  secondaryWidgets: ["approval_queue", "logs"],
});

assert(draft.blueprint.name === "Strategy Scout", "builder draft should preserve the chosen blueprint name");
assert(draft.blueprint.role_label === "strategy_scout", "builder draft should normalize the chosen role label");
assert(draft.blueprint.capabilities?.includes("approval"), "builder draft should persist custom capabilities");
assert(draft.blueprint.skill_bundle_refs?.[0] === "pm", "builder draft should persist explicit skill bundle refs");
assert(draft.blueprint.ui_profile?.home_zone === "strategy_hub", "builder draft should preserve selected home zone");
assert(draft.blueprint.ui_profile?.team_affinity === "strategy_team", "builder draft should preserve selected team affinity");
assert(draft.blueprint.ui_profile?.primary_widgets?.includes("execution_graph"), "builder draft should allow runtime execution widgets");
assert(draft.previewAgent.uiProfile?.meeting_behavior === "briefing", "preview agent should mirror builder meeting behavior");
assert(
  Array.isArray((draft.blueprint.tool_policy as { allowed_tools?: string[] }).allowed_tools),
  "builder draft should persist tool policy allowlist",
);
assert(
  Array.isArray((draft.blueprint.tool_policy as { connectors?: string[] }).connectors) &&
    ((draft.blueprint.tool_policy as { connectors?: string[] }).connectors ?? []).length > 0,
  "builder draft should persist operating-profile connector hints",
);
assert(
  (draft.blueprint.collaboration_policy as { workspace_mode?: string }).workspace_mode ===
    "orchestration_workspace",
  "builder draft should persist workspace mode via collaboration policy",
);
assert(
  (draft.blueprint.approval_policy as { external_actions_require_approval?: boolean })
    .external_actions_require_approval === true,
  "builder draft should require approval for external actions by default",
);
assert(
  draft.previewAgent.operatingProfile?.interaction_style.movement_mode === "walk_to_desk",
  "preview agent should expose the default interaction choreography",
);
assert(
  (draft.blueprint.permission_policy as { mode?: string }).mode === "owner_required",
  "builder draft should persist permission mode",
);

const defaultDraft = buildFactoryBlueprintDraft(builderTemplate, {
  name: "Builder Default",
  prompt: "Ship the backlog.",
});
assert(
  defaultDraft.blueprint.skill_bundle_refs?.[0] === "developer",
  "builder template should default to the developer bundle",
);
assert(
  defaultDraft.previewAgent.operatingProfile?.tool_connectors.includes("git_connector"),
  "builder template should derive builder connectors for preview agents",
);

const inferredBuilder = inferTemplateFromSignals(
  ["code_generation", "execution"],
  ["developer"],
  "frontend_builder",
);
assert(
  inferredBuilder.id === "builder",
  "inferTemplateFromSignals should classify implementation-heavy roles as builder",
);

const inferredResearcher = inferTemplateFromSignals(
  ["research", "analysis"],
  ["pm"],
  "strategy_researcher",
);
assert(
  inferredResearcher.id === "researcher",
  "inferTemplateFromSignals should classify research-oriented roles as researcher",
);

const inferredCreative = inferTemplateFromSignals(
  ["design", "assets"],
  ["designer"],
  "visual_designer",
);
assert(
  inferredCreative.id === "creative",
  "inferTemplateFromSignals should classify design-oriented roles as creative",
);

console.log("runtimeBuilder tests passed");
