import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { pathToFileURL } from "node:url";

import { I18nProvider } from "../../i18n";
import type { CollaborationArtifact } from "../../types/agent";
import { SharedBoardPanelView } from "./SharedBoardPanel";
void React;

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) {
    throw new Error(message);
  }
}

function installBrowserGlobals() {
  const memory = new Map<string, string>();
  if (!("localStorage" in globalThis)) {
    Object.defineProperty(globalThis, "localStorage", {
      configurable: true,
      value: {
        getItem: (key: string) => memory.get(key) ?? null,
        setItem: (key: string, value: string) => memory.set(key, String(value)),
        removeItem: (key: string) => memory.delete(key),
      },
    });
  }
  if (!("navigator" in globalThis)) {
    Object.defineProperty(globalThis, "navigator", {
      configurable: true,
      value: { language: "en" },
    });
  }
}

export async function runSharedBoardPanelRegressionTests(): Promise<void> {
  installBrowserGlobals();
  const artifact: CollaborationArtifact = {
    session_id: "session-1",
    round_id: "round-1",
    status: "incomplete",
    artifact_type: "execution_brief",
    decision: "Proceed after reviewer fixes",
    refined_goal: "Validated user-facing artifact",
    acceptance_criteria: ["Trace is captured", "Artifact quality is visible"],
    deliverables: ["Trace summary", "Quality verdict"],
    project_fit_summary: "Fits the collaboration board workflow",
    open_questions: ["Need owner approval?"],
    next_actions: ["Run focused verifier"],
    contributions: [
      {
        team: "pm",
        agent_role: "pm",
        status: "completed",
        summary: "PM brief complete",
        open_questions: ["PM question"],
        next_actions: ["PM next action"],
        details: {
          files: ["apps/web/src/components/office/SharedBoardPanel.tsx"],
          refined_goal: "PM refined goal",
          acceptance_criteria: ["PM acceptance"],
          deliverables: ["PM deliverable"],
          assumptions: ["PM assumption"],
          role_assignment_notes: ["Reviewer checks the contract"],
          discovery_checklist: [
            {
              target: "runtime",
              path: "apps/web/src/application/sequencer/SequencerCoordinator.ts",
              symbol: "RunAgentCommandCascade",
              evidence: "trace log",
            },
          ],
        },
      },
      {
        team: "qa",
        agent_role: "verifier",
        status: "completed",
        summary: "Verifier evidence complete",
        details: {
          verdict: "pass",
          score: "16/16",
          checks: ["regression passed"],
          evidence: ["host feedback pass"],
        },
      },
    ],
  };
  const html = renderToStaticMarkup(
    React.createElement(
      I18nProvider,
      null,
      React.createElement(SharedBoardPanelView, {
        artifacts: [artifact],
        sharedGoal: "Run the full E2E flow",
      }),
    ),
  );

  for (const expected of [
    "Run the full E2E flow",
    "Validated user-facing artifact",
    "Trace is captured",
    "Trace summary",
    "Fits the collaboration board workflow",
    "Proceed after reviewer fixes",
    "PM brief complete",
    "apps/web/src/application/sequencer/SequencerCoordinator.ts",
    "RunAgentCommandCascade",
    "Reviewer checks the contract",
    "Verifier evidence complete",
    "Quality Summary",
    "Needs follow-up",
    "Not enough final evidence yet.",
    "16/16",
    "host feedback pass",
  ]) {
    assert(html.includes(expected), `SharedBoardPanel rendered output should include ${expected}`);
  }

  const readyArtifact: CollaborationArtifact = {
    ...artifact,
    round_id: "round-ready",
    status: "completed",
    decision: "Ready for user testing",
    open_questions: [],
    next_actions: ["Open the artifact and run the smoke path"],
    contributions: [
      {
        team: "qa",
        agent_role: "verifier",
        status: "completed",
        summary: "Build and smoke evidence passed",
        details: {
          verdict: "pass",
          score: "95/100",
          checks: ["npm run build passed", "npm run smoke passed"],
          evidence: ["artifact rendered and interaction smoke passed"],
        },
      },
    ],
  };
  const readyHtml = renderToStaticMarkup(
    React.createElement(
      I18nProvider,
      null,
      React.createElement(SharedBoardPanelView, {
        artifacts: [readyArtifact],
        sharedGoal: "Ship the dashboard artifact",
      }),
    ),
  );
  assert(readyHtml.includes("Ready to use"), "Completed artifact with strong evidence should be ready");
  assert(readyHtml.includes("95/100"), "Ready artifact score should stay visible");

  const weakCompletedArtifact: CollaborationArtifact = {
    ...artifact,
    round_id: "round-weak",
    status: "completed",
    decision: "Verifier blocked release after provider timeout",
    open_questions: [],
    next_actions: ["Repair the missing UI states"],
    contributions: [
      {
        team: "qa",
        agent_role: "verifier",
        status: "completed",
        summary: "Build passed, but final artifact quality failed",
        details: {
          verdict: "fail",
          score: "70/100",
          checks: ["npm run build passed"],
          evidence: ["provider timeout left partial UI evidence"],
        },
      },
    ],
  };
  const weakHtml = renderToStaticMarkup(
    React.createElement(
      I18nProvider,
      null,
      React.createElement(SharedBoardPanelView, {
        artifacts: [weakCompletedArtifact],
        sharedGoal: "Ship the dashboard artifact",
      }),
    ),
  );
  assert(
    weakHtml.includes("Needs follow-up"),
    "Completed artifact with failing verifier evidence should not be ready",
  );
  assert(!weakHtml.includes("Ready to use"), "Failing quality signal must block ready state");
  assert(weakHtml.includes("70/100"), "Weak artifact score should stay visible");

  console.log("SharedBoardPanel contribution visibility regression passed");
}

function isDirectRun(): boolean {
  const entry = process.argv[1];
  return entry != null && import.meta.url === pathToFileURL(entry).href;
}

if (isDirectRun()) {
  void runSharedBoardPanelRegressionTests().catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
}
