import { pathToFileURL } from "node:url";

import { DEFAULT_BUNDLED_AGENTS_METADATA_JSON } from "../../lib/defaultBundledAgentsMetadata";
import { AgentRegistry } from "./AgentRegistry";
import type { RosterAgentMeta } from "./types";

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) {
    throw new Error(message);
  }
}

function buildRegistry(): AgentRegistry {
  const parsed = JSON.parse(DEFAULT_BUNDLED_AGENTS_METADATA_JSON) as { agents?: RosterAgentMeta[] };
  return new AgentRegistry(parsed.agents ?? []);
}

function buildImplementationRegistry(): AgentRegistry {
  return new AgentRegistry([
    { id: "pm", prompt_key: "agent_pm", office_role: "pm" } as RosterAgentMeta,
    { id: "ui_builder", prompt_key: "agent_frontend", office_role: "developer_front" } as RosterAgentMeta,
    { id: "rust_builder", prompt_key: "agent_backend", office_role: "developer_back" } as RosterAgentMeta,
    { id: "reviewer", prompt_key: "agent_reviewer", office_role: "reviewer" } as RosterAgentMeta,
    { id: "verifier", prompt_key: "agent_verifier", office_role: "verifier" } as RosterAgentMeta,
  ]);
}

export async function runAgentRegistryRegressionTests(): Promise<void> {
  const registry = buildRegistry();

  const neutralPmRow = registry.BuildDispatchRow({
    stepNumber: 1,
    task: "Fix apps/web/src/services/httpClient.ts auth propagation and BYOK entry routing",
    routedAgentId: null,
  });
  assert(
    neutralPmRow.agentId === "pm",
    `Context-routed auth/BYOK implementation rows should remain PM-owned until later routing, got ${neutralPmRow.agentId}`,
  );
  assert(
    neutralPmRow.officeRole === "pm",
    `Neutral auth/BYOK implementation rows should keep the PM office role before context routing, got ${neutralPmRow.officeRole}`,
  );

  assert(
    registry.FindAgentIdByOfficeRole("developer_front") === "frontend" &&
      registry.FindAgentIdByOfficeRole("developer_back") === "backend",
    "Bundled metadata should provide the default frontend/backend implementation agents",
  );

  const implementationRegistry = buildImplementationRegistry();

  const explicitFrontendArrow = implementationRegistry.BuildDispatchRow({
    stepNumber: 2,
    task: "ui_builder -> Restore apps/web/src/App.tsx authenticated BYOK entry flow",
    routedAgentId: null,
  });
  assert(
    explicitFrontendArrow.agentId === "ui_builder",
    `Explicit user-created implementation routing should resolve the roster owner, got ${explicitFrontendArrow.agentId}`,
  );

  const explicitFrontendPrefix = implementationRegistry.BuildDispatchRow({
    stepNumber: 3,
    task: "ui_builder: tighten auth modal reset handling for account-scoped BYOK state",
    routedAgentId: null,
  });
  assert(
    explicitFrontendPrefix.agentId === "ui_builder",
    `Explicit user-created implementation prefix should resolve the roster owner, got ${explicitFrontendPrefix.agentId}`,
  );

  assert(
    implementationRegistry.FindAgentIdByOfficeRole("developer_front") === "ui_builder",
    "developer_front office-role normalization should prefer the active roster implementation metadata",
  );
  assert(
    implementationRegistry.FindAgentIdByOfficeRole("developer_back") === "rust_builder",
    "developer_back office-role normalization should prefer the active roster implementation metadata",
  );
  assert(
    implementationRegistry.NormalizeAgentId("백엔드") === "rust_builder" &&
      implementationRegistry.NormalizeAgentId("프론트엔드") === "ui_builder" &&
      registry.NormalizeAgentId("검증자") === "verifier",
    "Korean agent aliases should resolve for natural-language AGENT_COMMANDS handoffs",
  );

  console.log("AgentRegistry auth/BYOK owner-resolution regressions passed");
}

function isDirectRun(): boolean {
  const entry = process.argv[1];
  return entry != null && import.meta.url === pathToFileURL(entry).href;
}

if (isDirectRun()) {
  void runAgentRegistryRegressionTests().catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
}
