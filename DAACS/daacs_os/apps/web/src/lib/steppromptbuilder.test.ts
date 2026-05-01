import { buildStepCliRequest } from "./stepPromptBuilder";
import type { RuntimeBundleResponse } from "../types/runtime";

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) {
    throw new Error(message);
  }
}

Object.assign(globalThis, {
  window: {
    __TAURI__: {
      core: {
        invoke: async (command: string) => {
          const commandMap: Record<string, string> = {
            get_agents_metadata_json: JSON.stringify({
              schema_version: 1,
              agents: [{ id: "frontend" }],
            }),
            get_agent_prompt: "Base frontend system prompt",
            get_skill_prompt_for_role:
              "## Agent Skills (developer)\n\n### Core Skills\n#### clean-code\nWrite maintainable code.",
            get_skill_prompt_for_custom:
              "## Agent Skills (developer_3d)\n\n### Core Skills\n#### 3d-web-experience\nBuild immersive 3D interfaces.",
          };
          return commandMap[command] ?? "";
        },
      },
    },
  },
});

const runtimeBundle: RuntimeBundleResponse = {
  runtime: {
    runtime_id: "runtime-1",
    project_id: "project-1",
    company_name: "DAACS Labs",
    org_graph: {},
    agent_instance_ids: ["inst-front"],
    meeting_protocol: {},
    approval_graph: {},
    shared_boards: {},
    execution_mode: "assisted",
    owner_ops_state: {},
    created_at: "2026-03-26T00:00:00.000Z",
    updated_at: "2026-03-26T00:00:00.000Z",
  },
  instances: [
    {
      instance_id: "inst-front",
      blueprint_id: "bp-front",
      project_id: "project-1",
      runtime_status: "idle",
      assigned_team: "development_team",
      current_tasks: [],
      context_window_state: {},
      memory_bindings: {},
      live_metrics: {},
      created_at: "2026-03-26T00:00:00.000Z",
      updated_at: "2026-03-26T00:00:00.000Z",
    },
  ],
  blueprints: [
    {
      id: "bp-front",
      name: "Frontend Developer",
      role_label: "developer_front",
      capabilities: ["design", "ui"],
      prompt_bundle_ref: "agent_front",
      skill_bundle_refs: [],
      tool_policy: { shell: true },
      permission_policy: { mode: "standard" },
      memory_policy: { mode: "shared" },
      collaboration_policy: {},
      approval_policy: {},
      ui_profile: {
        display_name: "Frontend Developer",
        title: "Frontend",
        avatar_style: "pixel",
        accent_color: "#3B82F6",
        icon: "Code",
        home_zone: "studio",
        team_affinity: "development_team",
        authority_level: 5,
        capability_tags: ["ui"],
        primary_widgets: ["delivery"],
        secondary_widgets: ["logs"],
        focus_mode: "default",
        meeting_behavior: "standard",
      },
      is_builtin: true,
      owner_user_id: "system",
      created_at: "2026-03-26T00:00:00.000Z",
      updated_at: "2026-03-26T00:00:00.000Z",
    },
  ],
};

const plan = {
  plan_id: "plan-1",
  runtime_id: "runtime-1",
  goal: "Ship the landing page",
  created_by: "pm",
  planner_version: "pm_planner_v1",
  planning_mode: "sequential",
  plan_rationale: "Design first, then implementation.",
  revision: 1,
  status: "active" as const,
  created_at: "2026-03-26T00:00:00.000Z",
  updated_at: "2026-03-26T00:00:00.000Z",
  steps: [],
};

const step = {
  step_id: "step-1",
  label: "Design the hero section",
  description: "Create the hero layout and visual direction.",
  assigned_to: "inst-front",
  depends_on: [],
  approval_required_by: null,
  status: "pending" as const,
  required_capabilities: ["design", "ui"],
  selection_reason: "Frontend role owns the hero implementation.",
  approval_reason: null,
  planner_notes: "Keep the visual system consistent with the runtime palette.",
  parallel_group: null,
  input: { goal: "Ship the landing page" },
  output: {},
  started_at: null,
  completed_at: null,
};

const request = await buildStepCliRequest(runtimeBundle, plan, step);
assert(request.cliRole === "frontend", "frontend blueprints should resolve to the frontend CLI role");
assert(request.officeAgentRole === "developer_front", "office role should mirror the blueprint role label");
assert(request.systemPrompt.includes("Frontend Developer"), "system prompt should include the assigned blueprint");
assert(request.systemPrompt.includes("## Agent Skills (developer)"), "system prompt should include the injected skill prompt");
assert(request.instruction.includes("Ship the landing page"), "instruction should include the plan goal");

const customRuntimeBundle: RuntimeBundleResponse = {
  ...runtimeBundle,
  blueprints: [
    {
      ...runtimeBundle.blueprints[0],
      role_label: "developer_3d",
      skill_bundle_refs: ["react-best-practices", "3d-web-experience"],
    },
  ],
};

const customRequest = await buildStepCliRequest(customRuntimeBundle, plan, step);
assert(
  customRequest.systemPrompt.includes("## Agent Skills (developer_3d)"),
  "custom skill refs should load the custom skill prompt path",
);

console.log("stepPromptBuilder tests passed");
