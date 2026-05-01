import { buildRuntimeAgents } from "./runtimeUi";
import { buildRuntimePlanView } from "./runtimePlan";
import { buildDashboardSections, mergeRuntimeDashboardTabs } from "./runtimeDashboard";
import type { ExecutionPlan, RuntimeBundleResponse } from "../types/runtime";

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) {
    throw new Error(message);
  }
}

const bundle: RuntimeBundleResponse = {
  runtime: {
    runtime_id: "runtime-dashboard",
    project_id: "project-dashboard",
    company_name: "Dashboard Runtime",
    org_graph: {},
    meeting_protocol: { default_roles: ["pm"], include_assigned_agents: true, include_approvers: true },
    approval_graph: {},
    shared_boards: {},
    execution_mode: "assisted",
    owner_ops_state: {},
    agent_instance_ids: ["inst-pm", "inst-dev"],
    created_at: "",
    updated_at: "",
  },
  blueprints: [
    {
      id: "bp-pm",
      name: "PM",
      role_label: "pm",
      capabilities: ["planning"],
      prompt_bundle_ref: null,
      skill_bundle_refs: [],
      tool_policy: {},
      permission_policy: {},
      memory_policy: {},
      collaboration_policy: {},
      approval_policy: {},
      ui_profile: {
        display_name: "PM",
        title: "PM",
        avatar_style: "pixel",
        accent_color: "#6366F1",
        icon: "ClipboardList",
        home_zone: "meeting_room",
        team_affinity: "executive_team",
        authority_level: 8,
        capability_tags: ["planning"],
        primary_widgets: ["kanban", "timeline"],
        secondary_widgets: ["logs"],
        focus_mode: "coordination",
        meeting_behavior: "facilitate",
      },
      is_builtin: true,
      owner_user_id: "system",
      created_at: "",
      updated_at: "",
    },
    {
      id: "bp-dev",
      name: "Frontend",
      role_label: "developer_front",
      capabilities: ["code_generation", "frontend"],
      prompt_bundle_ref: null,
      skill_bundle_refs: [],
      tool_policy: {},
      permission_policy: {},
      memory_policy: {},
      collaboration_policy: {},
      approval_policy: {},
      ui_profile: {
        display_name: "Frontend",
        title: "Frontend",
        avatar_style: "pixel",
        accent_color: "#3B82F6",
        icon: "Code",
        home_zone: "rd_lab",
        team_affinity: "development_team",
        authority_level: 6,
        capability_tags: ["frontend"],
        primary_widgets: ["code", "git"],
        secondary_widgets: ["timeline"],
        focus_mode: "build",
        meeting_behavior: "report",
      },
      is_builtin: true,
      owner_user_id: "system",
      created_at: "",
      updated_at: "",
    },
  ],
  instances: [
    {
      instance_id: "inst-pm",
      blueprint_id: "bp-pm",
      project_id: "project-dashboard",
      runtime_status: "working",
      assigned_team: "executive_team",
      current_tasks: ["Coordinate"],
      context_window_state: {},
      memory_bindings: {},
      live_metrics: {},
      created_at: "",
      updated_at: "",
    },
    {
      instance_id: "inst-dev",
      blueprint_id: "bp-dev",
      project_id: "project-dashboard",
      runtime_status: "waiting_approval",
      assigned_team: "development_team",
      current_tasks: ["Implement"],
      context_window_state: {},
      memory_bindings: {},
      live_metrics: {},
      created_at: "",
      updated_at: "",
    },
  ],
};

const plan: ExecutionPlan = {
  plan_id: "plan-dashboard",
  runtime_id: "runtime-dashboard",
  goal: "Finish adaptive dashboard",
  created_by: "inst-pm",
  status: "paused",
  created_at: "",
  updated_at: "",
  steps: [
    {
      step_id: "step-dashboard",
      label: "Implement adaptive dashboard",
      description: "Add runtime-aware widget sections",
      assigned_to: "inst-dev",
      depends_on: [],
      approval_required_by: "inst-pm",
      status: "awaiting_approval",
      input: {},
      output: {},
      started_at: null,
      completed_at: null,
    },
  ],
};

const agents = buildRuntimeAgents(bundle);
const developer = agents.find((agent) => agent.id === "inst-dev");
assert(developer, "developer agent should exist");

const planView = buildRuntimePlanView(bundle, [plan]);
const tabs = mergeRuntimeDashboardTabs([], developer, planView);
const sections = buildDashboardSections(tabs, developer, planView);

assert(tabs.some((tab) => tab.id === "execution_graph"), "runtime dashboard should inject execution graph widget");
assert(tabs.some((tab) => tab.id === "approval_queue"), "runtime dashboard should inject approval queue widget");
assert(sections[0]?.id === "priority", "priority runtime widgets should render in the first section");
assert(sections[0]?.widget_ids.includes("approval_queue"), "priority section should expose pending approvals");
assert(sections[0]?.widget_ids.includes("execution_graph"), "priority section should expose active execution graph");
assert(sections.some((section) => section.id === "primary" && section.widget_ids.includes("code")), "primary section should preserve code widget from ui profile");
assert(sections.some((section) => section.id === "secondary" && section.widget_ids.includes("timeline")), "secondary section should preserve secondary widgets");

console.log("runtimeDashboard tests passed");
