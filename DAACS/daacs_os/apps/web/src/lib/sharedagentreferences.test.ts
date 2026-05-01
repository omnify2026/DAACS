import type { Agent } from "../types/agent";
import type { SharedAgentProfileDocument } from "../types/office";
import { syncAgentsFromSharedReferences } from "./sharedAgentReferences";

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) {
    throw new Error(message);
  }
}

const sharedAgent: SharedAgentProfileDocument = {
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
    home_zone: "rd_lab",
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
      return_mode: "return_to_origin",
    },
  },
  shared_at: "2026-04-07T00:00:00.000Z",
  updated_at: "2026-04-07T00:00:00.000Z",
};

const linkedAgent: Agent = {
  id: "custom-dev-1",
  role: "developer",
  name: "Old Developer",
  position: { x: 0, y: 0 },
  path: [],
  status: "idle",
  uiProfile: {
    home_zone: "rd_lab",
  },
  sharedAgentRef: {
    global_agent_id: "global-dev-1",
    source_project_id: "project-a",
    sync_mode: "linked",
    imported_at: "2026-04-07T00:00:00.000Z",
  },
};

const synced = syncAgentsFromSharedReferences([linkedAgent], [sharedAgent]);
assert(synced[0].name === "Shared Developer", "linked shared agent should sync source name");
assert(synced[0].sharedAgentRef?.sync_mode === "linked", "linked shared agent should stay linked");

const detached = syncAgentsFromSharedReferences([linkedAgent], []);
assert(detached[0].sharedAgentRef?.sync_mode === "detached", "missing shared source should detach the linked agent");

console.log("sharedAgentReferences tests passed");
