// src/types/agent.ts
var AGENT_ROLES = [
  "ceo",
  "pm",
  "developer",
  "developer_front",
  "developer_back",
  "reviewer",
  "verifier",
  "devops",
  "marketer",
  "designer",
  "cfo"
];
var AGENT_META = {
  ceo: { name: "CEO", title: "CEO", color: "#8B5CF6", icon: "Crown" },
  pm: { name: "PM", title: "\uD504\uB85C\uC81D\uD2B8 \uB9E4\uB2C8\uC800", color: "#6366F1", icon: "ClipboardList" },
  developer: { name: "\uAC1C\uBC1C\uC790", title: "Developer", color: "#3B82F6", icon: "Code" },
  developer_front: { name: "\uAC1C\uBC1C\uC790 Front", title: "\uD504\uB860\uD2B8\uC5D4\uB4DC \uAC1C\uBC1C\uC790", color: "#3B82F6", icon: "Code" },
  developer_back: { name: "\uAC1C\uBC1C\uC790 Back", title: "\uBC31\uC5D4\uB4DC \uAC1C\uBC1C\uC790", color: "#EF4444", icon: "Search" },
  reviewer: { name: "\uB9AC\uBDF0\uC5B4", title: "Reviewer", color: "#EF4444", icon: "Search" },
  verifier: { name: "\uAC80\uC99D\uAD00", title: "Verifier", color: "#14B8A6", icon: "ShieldCheck" },
  devops: { name: "\uB370\uBE0C\uC635\uC2A4", title: "\uB370\uBE0C\uC635\uC2A4 \uC5D4\uC9C0\uB2C8\uC5B4", color: "#10B981", icon: "Terminal" },
  marketer: { name: "\uB9C8\uCF00\uD130", title: "\uB9C8\uCF00\uD130", color: "#EC4899", icon: "Megaphone" },
  designer: { name: "\uB514\uC790\uC774\uB108", title: "UI/UX \uB514\uC790\uC774\uB108", color: "#F97316", icon: "Palette" },
  cfo: { name: "CFO", title: "\uC7AC\uBB34", color: "#EAB308", icon: "Calculator" }
};
function isBuiltinAgentRole(value) {
  return typeof value === "string" && AGENT_ROLES.includes(value);
}
function humanizeRoleLabel(role) {
  return role.split(/[_-]+/g).filter(Boolean).map((part) => part.charAt(0).toUpperCase() + part.slice(1)).join(" ");
}
function getAgentMeta(role, overrides) {
  const fallback = AGENT_META[isBuiltinAgentRole(role) ? role : "developer_front"];
  const inferredName = humanizeRoleLabel(role);
  return {
    name: overrides?.name?.trim() || (isBuiltinAgentRole(role) ? fallback.name : inferredName),
    title: overrides?.title?.trim() || (isBuiltinAgentRole(role) ? fallback.title : inferredName),
    color: overrides?.color?.trim() || fallback.color,
    icon: overrides?.icon?.trim() || fallback.icon
  };
}

// src/lib/sharedAgentReferences.ts
function cloneJson(value) {
  return JSON.parse(JSON.stringify(value));
}
function buildSharedReference(sharedAgent2, current) {
  return {
    global_agent_id: sharedAgent2.global_agent_id,
    source_project_id: sharedAgent2.source_project_id ?? null,
    sync_mode: current?.sync_mode === "detached" ? "detached" : "linked",
    imported_at: current?.imported_at ?? (/* @__PURE__ */ new Date()).toISOString()
  };
}
function applySharedAgentProfileToAgent(agent, sharedAgent2) {
  const nextUiProfile = cloneJson(sharedAgent2.ui_profile ?? {});
  return {
    ...agent,
    role: sharedAgent2.role_label,
    name: sharedAgent2.name,
    capabilities: [...sharedAgent2.capabilities],
    skillBundleRefs: [...sharedAgent2.skill_bundle_refs],
    uiProfile: {
      ...nextUiProfile,
      home_zone: agent.uiProfile?.home_zone ?? nextUiProfile.home_zone,
      team_affinity: agent.uiProfile?.team_affinity ?? nextUiProfile.team_affinity
    },
    operatingProfile: cloneJson(sharedAgent2.operating_profile),
    meta: getAgentMeta(sharedAgent2.role_label, {
      name: sharedAgent2.name,
      title: typeof nextUiProfile.title === "string" && nextUiProfile.title.trim().length > 0 ? nextUiProfile.title : sharedAgent2.name,
      color: typeof nextUiProfile.accent_color === "string" && nextUiProfile.accent_color.trim().length > 0 ? nextUiProfile.accent_color : void 0,
      icon: typeof nextUiProfile.icon === "string" && nextUiProfile.icon.trim().length > 0 ? nextUiProfile.icon : void 0
    }),
    sharedAgentRef: buildSharedReference(sharedAgent2, agent.sharedAgentRef)
  };
}
function syncAgentsFromSharedReferences(agents, sharedAgents) {
  if (agents.length === 0) return agents;
  const byId = new Map(sharedAgents.map((agent) => [agent.global_agent_id, agent]));
  return agents.map((agent) => {
    const reference = agent.sharedAgentRef;
    if (!reference?.global_agent_id) return agent;
    const sharedAgent2 = byId.get(reference.global_agent_id);
    if (!sharedAgent2) {
      return {
        ...agent,
        sharedAgentRef: {
          ...reference,
          sync_mode: "detached"
        }
      };
    }
    if (reference.sync_mode === "detached") {
      return agent;
    }
    return applySharedAgentProfileToAgent(agent, sharedAgent2);
  });
}

// src/lib/sharedAgentReferences.test.ts
function assert(condition, message) {
  if (!condition) {
    throw new Error(message);
  }
}
var sharedAgent = {
  global_agent_id: "global-dev-1",
  source_agent_id: "agent-dev-1",
  source_project_id: "project-a",
  name: "Shared Developer",
  role_label: "developer",
  prompt: "Implement features",
  summary: "Writes code",
  capabilities: ["typescript", "react"],
  skill_bundle_refs: ["skill://frontend"],
  ui_profile: {
    title: "Frontend Developer",
    accent_color: "#22D3EE",
    home_zone: "rd_lab"
  },
  operating_profile: {
    workspace_mode: "builder",
    tool_connectors: ["internal_workbench", "git"],
    allowed_tools: ["edit", "run"],
    approval_mode: "owner_required",
    external_actions_require_approval: true,
    default_approver: "owner",
    interaction_style: {
      movement_mode: "walk",
      speech_mode: "bubble",
      return_mode: "return_to_origin"
    }
  },
  shared_at: "2026-04-07T00:00:00.000Z",
  updated_at: "2026-04-07T00:00:00.000Z"
};
var linkedAgent = {
  id: "custom-dev-1",
  role: "developer",
  name: "Old Developer",
  position: { x: 0, y: 0 },
  path: [],
  status: "idle",
  uiProfile: {
    home_zone: "rd_lab"
  },
  sharedAgentRef: {
    global_agent_id: "global-dev-1",
    source_project_id: "project-a",
    sync_mode: "linked",
    imported_at: "2026-04-07T00:00:00.000Z"
  }
};
var synced = syncAgentsFromSharedReferences([linkedAgent], [sharedAgent]);
assert(synced[0].name === "Shared Developer", "linked shared agent should sync source name");
assert(synced[0].sharedAgentRef?.sync_mode === "linked", "linked shared agent should stay linked");
var detached = syncAgentsFromSharedReferences([linkedAgent], []);
assert(detached[0].sharedAgentRef?.sync_mode === "detached", "missing shared source should detach the linked agent");
console.log("sharedAgentReferences tests passed");
