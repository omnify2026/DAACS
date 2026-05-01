import { buildAgentProgramSpecs } from "./programRegistry";
import type { Agent } from "../types/agent";

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) {
    throw new Error(message);
  }
}

const builderAgent: Agent = {
  id: "agent-builder",
  role: "custom_builder",
  name: "Builder",
  position: { x: 0, y: 0 },
  path: [],
  status: "idle",
  capabilities: ["code_generation", "execution"],
  skillBundleRefs: ["developer"],
  operatingProfile: {
    workspace_mode: "builder_workspace",
    tool_connectors: ["git_connector"],
    allowed_tools: [],
    approval_mode: "always_owner",
    external_actions_require_approval: true,
    default_approver: "owner_ops",
    interaction_style: {
      movement_mode: "walk_to_desk",
      speech_mode: "short_bubble",
      return_mode: "return_to_origin",
    },
  },
  uiProfile: {
    primary_widgets: ["code", "git"],
    secondary_widgets: ["timeline"],
  },
};

const marketingAgent: Agent = {
  id: "agent-marketing",
  role: "brand_marketer",
  name: "Marketing",
  position: { x: 0, y: 0 },
  path: [],
  status: "idle",
  capabilities: ["content", "campaign"],
  skillBundleRefs: ["marketer"],
  operatingProfile: {
    workspace_mode: "campaign_workspace",
    tool_connectors: ["social_publish_connector", "ads_connector"],
    allowed_tools: [],
    approval_mode: "always_owner",
    external_actions_require_approval: true,
    default_approver: "owner_ops",
    interaction_style: {
      movement_mode: "walk_to_desk",
      speech_mode: "short_bubble",
      return_mode: "return_to_origin",
    },
  },
  uiProfile: {
    primary_widgets: ["content"],
    secondary_widgets: ["timeline"],
  },
};

const builderPrograms = buildAgentProgramSpecs(builderAgent);
assert(
  builderPrograms.some((program) => program.id === "code_output"),
  "builder agents should receive code output workspace programs",
);
assert(
  builderPrograms.some((program) => program.id === "file_changes"),
  "builder agents should receive file change programs",
);

const marketingPrograms = buildAgentProgramSpecs(marketingAgent);
assert(
  marketingPrograms.some((program) => program.id === "content_pipeline"),
  "marketing agents should receive content pipeline programs",
);
assert(
  marketingPrograms.some((program) => program.id === "handoff_feed"),
  "marketing agents should receive handoff feed programs",
);

console.log("programRegistry tests passed");
