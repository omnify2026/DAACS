import { buildExecutionConnectorInstruction, summarizeConnectorOutput } from "./executionConnectors";
import type { ExecutionIntent } from "../types/runtime";

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) {
    throw new Error(message);
  }
}

const publishIntent: ExecutionIntent = {
  intent_id: "intent-publish",
  project_id: "proj-1",
  agent_id: "agent-marketing",
  agent_role: "brand_marketer",
  kind: "publish_content",
  title: "Request Publish",
  description: "Publish the launch teaser copy.",
  target: "Launch teaser",
  connector_id: "social_publish_connector",
  payload: {
    channel: "linkedin",
    summary: "Launch teaser copy",
  },
  status: "approved",
  requires_approval: true,
  created_at: "2026-04-02T00:00:00.000Z",
  approved_at: "2026-04-02T00:01:00.000Z",
  resolved_at: null,
  note: null,
  result_summary: null,
};

const deployIntent: ExecutionIntent = {
  ...publishIntent,
  intent_id: "intent-deploy",
  agent_id: "agent-devops",
  agent_role: "devops",
  kind: "deploy_release",
  title: "Request Deploy",
  description: "Deploy the approved web release.",
  target: "web-release",
  connector_id: "deploy_connector",
  payload: {
    environment: "production",
    release: "web@1.2.0",
  },
};

const publishInstruction = buildExecutionConnectorInstruction(publishIntent);
assert(
  publishInstruction.includes("social_publish_connector"),
  "publish instructions should include the connector id",
);
assert(
  publishInstruction.includes("Do not fabricate successful publication."),
  "publish instructions should guard against fake success",
);
assert(
  publishInstruction.includes("\"channel\": \"linkedin\""),
  "publish instructions should include payload details",
);

const deployInstruction = buildExecutionConnectorInstruction(deployIntent);
assert(
  deployInstruction.includes("Run the minimum safe prechecks first"),
  "deploy instructions should enforce prechecks",
);
assert(
  deployInstruction.includes("production"),
  "deploy instructions should include target payload details",
);

const summary = summarizeConnectorOutput(
  "Deployment succeeded and health checks passed for all services.",
  "",
  0,
);
assert(
  summary.includes("Deployment succeeded"),
  "connector summaries should use stdout when available",
);

console.log("executionConnectors tests passed");
