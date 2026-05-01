import { expect, test, type Page, type Route } from "@playwright/test";
import { readFileSync } from "node:fs";

import { enterOfficeFromProjectSelection } from "./helpers";

async function fulfillJson(route: Route, body: unknown, status = 200): Promise<void> {
  await route.fulfill({
    status,
    contentType: "application/json",
    body: JSON.stringify(body),
  });
}

async function startRound(page: Page): Promise<void> {
  await page.getByTestId("goal-round-actions-primary").getByRole("button", { name: "Start Round" }).click();
}

function completedWebArtifact(InParams: {
  sessionId: string;
  roundId: string;
  decision: string;
  workspace: string;
  summary: string;
  reviewFocus: string;
  verifierEvidence: string;
}): unknown {
  return {
    session_id: InParams.sessionId,
    round_id: InParams.roundId,
    status: "completed",
    decision: InParams.decision,
    acceptance_criteria: [InParams.reviewFocus],
    deliverables: ["Runnable web artifact", "Executable smoke evidence"],
    open_questions: [],
    next_actions: [`Artifact: ${InParams.workspace}`, "npm run smoke passed"],
    contributions: [
      {
        team: "development_team",
        agent_role: "frontend",
        status: "completed",
        summary: InParams.summary,
        next_actions: [`Artifact: ${InParams.workspace}`],
        details: {
          files: ["package.json", "src/App.tsx"],
          workspace: InParams.workspace,
        },
      },
      {
        team: "review_team",
        agent_role: "reviewer",
        status: "completed",
        summary: "Reviewed requested behavior without domain-specific assumptions.",
        details: {
          review_focus: [InParams.reviewFocus],
        },
      },
      {
        team: "review_team",
        agent_role: "verifier",
        status: "completed",
        summary: "Verified executable user flow.",
        details: {
          commands: ["npm run smoke"],
          evidence: [
            "npm run smoke passed",
            InParams.verifierEvidence,
            "Responsive mobile layout, empty state, validation error state, button interaction, and visual polish checked.",
          ],
        },
      },
    ],
  };
}

const domainSmokeScenarios = [
  {
    name: "game",
    prompt: "Build a playable browser mini game with score, restart, keyboard, and touch controls.",
    sessionId: "game-session",
    roundId: "game-round",
    workspace: "/tmp/daacs-game-artifact",
    decision: "Playable web game artifact completed with score, restart, keyboard controls, and touch controls.",
    summary: "Implemented a playable game loop and controls.",
    reviewFocus: "score, restart, keyboard, touch, empty/game-over state",
    verifierEvidence: "Browser smoke covered keyboard input, touch button input, score change, game over, and restart.",
  },
  {
    name: "booking",
    prompt: "Build a meeting room booking website with room filters, availability, and reservation states.",
    sessionId: "booking-session",
    roundId: "booking-round",
    workspace: "/tmp/daacs-booking-artifact",
    decision: "Meeting room booking artifact completed with filters, availability, and reservation states.",
    summary: "Implemented booking filters and room availability cards.",
    reviewFocus: "filters, unavailable rooms, reservation state, negative availability case",
    verifierEvidence: "Browser smoke covered room filters, unavailable room rejection, reservation button states, and empty results.",
  },
  {
    name: "dashboard",
    prompt: "Build an operations dashboard with KPI cards, data filters, empty state, and alert status.",
    sessionId: "dashboard-session",
    roundId: "dashboard-round",
    workspace: "/tmp/daacs-dashboard-artifact",
    decision: "Operations dashboard artifact completed with KPI cards, filters, empty state, and alert status.",
    summary: "Implemented KPI dashboard cards, filtering, and alert status UI.",
    reviewFocus: "KPI cards, filters, alert state, empty data state",
    verifierEvidence: "Browser smoke covered filter changes, alert status, empty data state, KPI rendering, and responsive dashboard layout.",
  },
];

test.describe("Collaboration round smoke", () => {
  test("starts an office round from a saved workspace and surfaces completion evidence", async ({ page }) => {
    let sessionCreated = false;
    let roundStarted = false;
    let roundProjectCwd: string | undefined;

    await page.addInitScript(() => {
      Object.defineProperty(window.navigator, "clipboard", {
        configurable: true,
        value: {
          writeText: async (text: string) => {
            (window as Window & { __daacsCopiedLiveEvidence?: string }).__daacsCopiedLiveEvidence = text;
          },
        },
      });
    });

    await enterOfficeFromProjectSelection(page);

    await page.route("**/api/collaboration/**", async (route) => {
      const request = route.request();
      const url = new URL(request.url());
      const path = url.pathname;
      const method = request.method().toUpperCase();

      if (method === "POST" && path === "/api/collaboration/project-alpha/sessions") {
        sessionCreated = true;
        await fulfillJson(route, {
          status: "ok",
          session_id: "smoke-session",
          shared_goal: "Build a smoke-tested todo artifact",
          participants: ["pm", "developer", "reviewer", "verifier"],
        });
        return;
      }

      if (
        method === "POST" &&
        path === "/api/collaboration/project-alpha/sessions/smoke-session/rounds"
      ) {
        roundStarted = true;
        const payload = request.postDataJSON() as { project_cwd?: string };
        roundProjectCwd = payload.project_cwd;
        await fulfillJson(route, {
          status: "completed",
          session_id: "smoke-session",
          round: {
            round_id: "smoke-round",
            status: "completed",
            created_at: Date.now(),
          },
          artifact: {
            session_id: "smoke-session",
            round_id: "smoke-round",
            status: "completed",
            decision: "Todo artifact completed with add, toggle, delete, filters, localStorage, and smoke evidence.",
            acceptance_criteria: ["add todo", "complete toggle", "delete todo", "all/active/completed filters", "localStorage persistence"],
            deliverables: ["Runnable todo web artifact", "npm run smoke evidence"],
            open_questions: [],
            next_actions: ["Artifact: /tmp/daacs-smoke-artifact", "npm run smoke passed"],
            contributions: [
              {
                team: "development_team",
                agent_role: "frontend",
                status: "completed",
                summary: "Implemented visible todo interactions.",
                next_actions: ["Artifact: /tmp/daacs-smoke-artifact"],
                details: {
                  files: ["package.json", "src/App.tsx"],
                  workspace: "/tmp/daacs-smoke-artifact",
                  started_at: "10:00:00",
                  completed_at: "10:00:12",
                  duration_ms: 12_000,
                },
              },
              {
                team: "review_team",
                agent_role: "reviewer",
                status: "completed",
                summary: "Reviewed requested todo behavior.",
                details: {
                  review_focus: ["add, toggle, delete, filters, localStorage"],
                  started_at: "10:00:12",
                  completed_at: "10:00:18",
                  duration_ms: 6_000,
                },
              },
              {
                team: "review_team",
                agent_role: "verifier",
                status: "completed",
                summary: "Verified executable user flow.",
                details: {
                  commands: ["npm run smoke"],
                  evidence: [
                    "npm run smoke passed and covered delete/filter/localStorage",
                    "Responsive mobile layout, empty state, validation error state, button disabled/hover states, and visual polish checked.",
                  ],
                  started_at: "10:00:18",
                  completed_at: "10:00:27",
                  duration_ms: 9_000,
                },
              },
            ],
          },
        });
        return;
      }

      await fulfillJson(route, { detail: `Unhandled collaboration route: ${method} ${path}` }, 500);
    });

    await page.getByTestId("hud-open-agent-workspace-button").click();
    await expect(page.getByRole("dialog", { name: "Agents" })).toBeVisible();
    await expect(page.getByText("Shared Goal Meeting")).toBeVisible();

    await page.getByPlaceholder("/absolute/path/to/project").fill("/tmp/daacs-smoke-root");
    await page.getByRole("button", { name: "Save path" }).click();
    await expect(page.getByText("/tmp/daacs-smoke-root")).toBeVisible();

    await page.getByPlaceholder("Enter shared objective for multi-agent round").fill(
      "Build a todo web artifact with add, complete toggle, delete, all/active/completed filters, localStorage, and smoke evidence.",
    );
    await startRound(page);

    await expect(page.getByTestId("goal-outcome-banner")).toContainText("Completed", { timeout: 15_000 });
    await expect(page.getByTestId("goal-quality-gate")).toContainText("Ready");
    await expect(page.getByTestId("goal-quality-gate")).toContainText("Artifact/files");
    await expect(page.getByTestId("goal-quality-gate")).toContainText("Requirement coverage");
    await expect(page.getByTestId("goal-quality-gate")).toContainText("Review evidence");
    await expect(page.getByTestId("goal-quality-gate")).toContainText("Execution verification");
    await expect(page.getByTestId("goal-quality-gate")).toContainText("UI/UX states");
    await expect(page.getByTestId("goal-quality-score")).toContainText("100/100");
    await expect(page.getByTestId("goal-quality-score")).toContainText("Strong");
    await expect(page.getByTestId("goal-release-readiness")).toContainText("Ready to use");
    await expect(page.getByTestId("goal-release-readiness")).toContainText("Artifact location: /tmp/daacs-smoke-artifact");
    await expect(
      page.getByTestId("notification-toast").filter({ hasText: /Ready to use.*\/tmp\/daacs-smoke-artifact/ }),
    ).toBeVisible();
    await expect(page.getByTestId("goal-release-run-hints")).toContainText("Run from artifact folder");
    await expect(page.getByTestId("goal-release-run-hints")).toContainText(
      "cd /tmp/daacs-smoke-artifact && npm run smoke",
    );
    await expect(page.getByTestId("goal-live-evidence-panel")).toContainText("Live provider evidence");
    await expect(page.getByTestId("goal-live-evidence-candidate-status")).toContainText(
      "More evidence is needed before third-phase candidate",
    );
    await expect(page.getByTestId("goal-live-evidence-candidate-status")).toContainText("Domains: 1/2");
    await page.getByTestId("goal-live-evidence-copy-button").click();
    const copiedEvidence = await page.evaluate(
      () => (window as Window & { __daacsCopiedLiveEvidence?: string }).__daacsCopiedLiveEvidence ?? "",
    );
    const parsedEvidence = JSON.parse(copiedEvidence) as {
      workspace_path: string;
      domains: Array<{
        artifact_path: string;
        quality_score: number;
        commands: string[];
        evidence: string[];
        trace: Array<{ role: string }>;
      }>;
    };
    expect(parsedEvidence.workspace_path).toBe("/tmp/daacs-smoke-root");
    expect(parsedEvidence.domains[0]?.artifact_path).toBe("/tmp/daacs-smoke-artifact");
    expect(parsedEvidence.domains[0]?.quality_score).toBe(100);
    expect(parsedEvidence.domains[0]?.commands.join("\n")).toContain("npm run smoke");
    expect(parsedEvidence.domains[0]?.evidence.join("\n")).toContain("npm run smoke passed");
    expect(JSON.stringify(parsedEvidence.domains[0]?.trace)).toContain("verifier");
    const downloadPromise = page.waitForEvent("download");
    await page.getByTestId("goal-live-evidence-download-button").click();
    const download = await downloadPromise;
    expect(download.suggestedFilename()).toMatch(/^daacs-live-provider-evidence-.*\.json$/);
    const downloadedPath = await download.path();
    expect(downloadedPath).toBeTruthy();
    const downloadedEvidence = JSON.parse(readFileSync(downloadedPath!, "utf8")) as typeof parsedEvidence;
    expect(downloadedEvidence.workspace_path).toBe("/tmp/daacs-smoke-root");
    expect(downloadedEvidence.domains[0]?.artifact_path).toBe("/tmp/daacs-smoke-artifact");
    await expect(page.getByTestId("goal-artifact-trace")).toContainText("Artifact trace");
    await expect(page.getByTestId("goal-artifact-trace")).toContainText("frontend");
    await expect(page.getByTestId("goal-artifact-trace")).toContainText("reviewer");
    await expect(page.getByTestId("goal-artifact-trace")).toContainText("verifier");
    await expect(page.getByTestId("goal-artifact-trace")).toContainText("npm run smoke");
    await expect(page.getByTestId("goal-artifact-trace")).toContainText("Timing");
    await expect(page.getByTestId("goal-artifact-trace")).toContainText("Duration: 12s");
    await expect(page.getByTestId("goal-round-progress")).toContainText("Finalizing result");
    await expect(page.getByTestId("goal-round-progress")).toContainText(/<1s|\d+s|\d+m/);
    await expect(page.getByTestId("goal-outcome-banner")).toContainText(
      "Todo artifact completed with add, toggle, delete, filters",
    );
    await expect(page.getByText("Artifact location: /tmp/daacs-smoke-artifact").first()).toBeVisible();

    expect(sessionCreated).toBe(true);
    expect(roundStarted).toBe(true);
    expect(roundProjectCwd).toBe("/tmp/daacs-smoke-root");
  });

  test("marks provider timeout artifacts as recoverable instead of silently done", async ({ page }) => {
    await enterOfficeFromProjectSelection(page);
    let roundCallCount = 0;
    let continuePrompt = "";
    let continueProjectCwd = "";

    await page.route("**/api/collaboration/**", async (route) => {
      const request = route.request();
      const url = new URL(request.url());
      const path = url.pathname;
      const method = request.method().toUpperCase();

      if (method === "POST" && path === "/api/collaboration/project-alpha/sessions") {
        await fulfillJson(route, {
          status: "ok",
          session_id: "timeout-session",
          shared_goal: "Build a timeout-resilient artifact",
          participants: ["pm", "developer", "reviewer", "verifier"],
        });
        return;
      }

      if (
        method === "POST" &&
        path === "/api/collaboration/project-alpha/sessions/timeout-session/rounds"
      ) {
        roundCallCount += 1;
        const payload = request.postDataJSON() as { prompt?: string; project_cwd?: string };
        if (roundCallCount === 2) {
          continuePrompt = payload.prompt ?? "";
          continueProjectCwd = payload.project_cwd ?? "";
          await fulfillJson(route, {
            status: "completed",
            session_id: "timeout-session",
            round: {
              round_id: "timeout-repair-round",
              status: "completed",
              created_at: Date.now(),
            },
            artifact: {
              session_id: "timeout-session",
              round_id: "timeout-repair-round",
              status: "completed",
              decision: "Recovered the same artifact after provider timeout and verified the user flow.",
              acceptance_criteria: ["continue existing artifact", "preserve repair scope", "verified recovered user flow"],
              deliverables: ["Recovered runnable web artifact", "npm run smoke evidence"],
              open_questions: [],
              next_actions: ["Artifact: /tmp/daacs-timeout-artifact", "npm run smoke passed"],
              contributions: [
                {
                  team: "development_team",
                  agent_role: "frontend",
                  status: "completed",
                  summary: "Continued existing files instead of fresh scaffold.",
                  details: {
                    files: ["package.json", "src/App.tsx"],
                    workspace: "/tmp/daacs-timeout-artifact",
                  },
                },
                {
                  team: "review_team",
                  agent_role: "reviewer",
                  status: "completed",
                  summary: "Reviewed recovered artifact.",
                  details: {
                    review_focus: ["existing artifact repair scope preserved"],
                  },
                },
                {
                  team: "review_team",
                  agent_role: "verifier",
                  status: "completed",
                  summary: "Verified recovered artifact.",
                  details: {
                    evidence: [
                      "npm run smoke passed",
                      "Responsive mobile layout, empty state, validation error state, button interaction, and visual polish checked.",
                    ],
                    commands: ["npm run smoke"],
                  },
                },
              ],
            },
          });
          return;
        }
        await fulfillJson(route, {
          status: "incomplete",
          session_id: "timeout-session",
          round: {
            round_id: "timeout-round",
            status: "incomplete",
            created_at: Date.now(),
          },
          artifact: {
            session_id: "timeout-session",
            round_id: "timeout-round",
            status: "incomplete",
            decision: "Provider timeout after partial implementation. Continue from the existing artifact.",
            acceptance_criteria: ["continue existing artifact after timeout"],
            deliverables: ["Partial web artifact files"],
            open_questions: [],
            next_actions: ["Artifact: /tmp/daacs-timeout-artifact", "Retry verifier after provider timeout"],
            contributions: [
              {
                team: "development_team",
                agent_role: "frontend",
                status: "completed",
                summary: "Partial files were created before provider timeout.",
                details: {
                  files: ["package.json", "src/App.tsx"],
                  workspace: "/tmp/daacs-timeout-artifact",
                  evidence: ["provider timeout before smoke evidence"],
                },
              },
            ],
          },
        });
        return;
      }

      await fulfillJson(route, { detail: `Unhandled collaboration route: ${method} ${path}` }, 500);
    });

    await page.getByTestId("hud-open-agent-workspace-button").click();
    await page.getByPlaceholder("/absolute/path/to/project").fill("/tmp/daacs-smoke-root");
    await page.getByRole("button", { name: "Save path" }).click();
    await page.getByPlaceholder("Enter shared objective for multi-agent round").fill(
      "Build a todo web artifact and recover gracefully if the provider times out.",
    );
    await startRound(page);

    await expect(page.getByTestId("goal-outcome-banner")).toContainText("Needs changes", { timeout: 15_000 });
    await expect(page.getByTestId("goal-quality-score")).toContainText("Needs changes");
    await expect(page.getByTestId("goal-quality-score")).toContainText("Missing evidence");
    await expect(page.getByTestId("goal-release-readiness")).toContainText("Not ready yet");
    await expect(page.getByTestId("goal-recovery-panel")).toContainText("Continue repair available");
    await expect(page.getByTestId("goal-recovery-panel")).toContainText("provider delay or timeout");
    await expect(page.getByTestId("goal-retry-latest-button")).toBeVisible();
    await page.getByTestId("goal-retry-latest-button").click();
    await expect(page.getByTestId("goal-outcome-banner")).toContainText("Completed", { timeout: 15_000 });
    await expect(page.getByTestId("goal-quality-score")).toContainText("Strong");
    expect(continuePrompt).toContain("## CONTINUE LATEST ARTIFACT");
    expect(continuePrompt).toContain("Previous quality and verification context:");
    expect(continuePrompt).toContain("MISSING goal.qualityGate.review");
    expect(continuePrompt).toContain("MISSING goal.qualityGate.verify");
    expect(continuePrompt).toContain("Previous requirement coverage:");
    expect(continuePrompt).toContain("continue existing artifact after timeout");
    expect(continuePrompt).toContain("Previous verifier/reviewer evidence:");
    expect(continuePrompt).toContain("provider timeout before smoke evidence");
    expect(continuePrompt).toContain("Previous next actions:");
    expect(continuePrompt).toContain("Retry verifier after provider timeout");
    expect(continueProjectCwd).toBe("/tmp/daacs-timeout-artifact");
  });

  test("caps completed web artifacts below strong quality when UI/UX evidence is missing", async ({ page }) => {
    await enterOfficeFromProjectSelection(page);
    let roundCallCount = 0;
    let qualityRepairPrompt = "";
    let qualityRepairProjectCwd = "";

    await page.route("**/api/collaboration/**", async (route) => {
      const request = route.request();
      const url = new URL(request.url());
      const path = url.pathname;
      const method = request.method().toUpperCase();

      if (method === "POST" && path === "/api/collaboration/project-alpha/sessions") {
        await fulfillJson(route, {
          status: "ok",
          session_id: "weak-ux-session",
          shared_goal: "Build a web artifact with insufficient UX evidence",
          participants: ["pm", "developer", "reviewer", "verifier"],
        });
        return;
      }

      if (
        method === "POST" &&
        path === "/api/collaboration/project-alpha/sessions/weak-ux-session/rounds"
      ) {
        roundCallCount += 1;
        const payload = request.postDataJSON() as { prompt?: string; project_cwd?: string };
        if (roundCallCount === 2) {
          qualityRepairPrompt = payload.prompt ?? "";
          qualityRepairProjectCwd = payload.project_cwd ?? "";
          await fulfillJson(route, {
            status: "completed",
            session_id: "weak-ux-session",
            round: { round_id: "weak-ux-repair-round", status: "completed", created_at: Date.now() },
            artifact: completedWebArtifact({
              sessionId: "weak-ux-session",
              roundId: "weak-ux-repair-round",
              workspace: "/tmp/daacs-weak-ux-artifact",
              decision: "Same artifact repaired with complete UI/UX evidence and executable verification.",
              summary: "Repaired the existing web artifact without starting a fresh scaffold.",
              reviewFocus: "same artifact repair, mobile state, empty state, validation, button interaction, visual polish",
              verifierEvidence: "Browser smoke covered mobile layout, empty state, validation error, button interaction, visual polish, and preserved artifact scope.",
            }),
          });
          return;
        }
        await fulfillJson(route, {
          status: "completed",
          session_id: "weak-ux-session",
          round: { round_id: "weak-ux-round", status: "completed", created_at: Date.now() },
          artifact: {
            session_id: "weak-ux-session",
            round_id: "weak-ux-round",
            status: "completed",
            decision: "Web artifact builds, but UI/UX evidence is incomplete.",
            acceptance_criteria: ["create runnable web artifact", "show requested primary UI"],
            deliverables: ["Web artifact scaffold", "Main UI implementation"],
            open_questions: [],
            next_actions: ["Artifact: /tmp/daacs-weak-ux-artifact", "npm run build passed"],
            contributions: [
              {
                team: "development_team",
                agent_role: "frontend",
                status: "completed",
                summary: "Created a web artifact scaffold and main UI.",
                next_actions: ["Artifact: /tmp/daacs-weak-ux-artifact"],
                details: {
                  files: ["package.json", "src/App.tsx"],
                  workspace: "/tmp/daacs-weak-ux-artifact",
                },
              },
              {
                team: "review_team",
                agent_role: "reviewer",
                status: "completed",
                summary: "Reviewed file structure only.",
                details: {
                  review_focus: ["file structure"],
                },
              },
              {
                team: "review_team",
                agent_role: "verifier",
                status: "completed",
                summary: "Verified build command only.",
                details: {
                  commands: ["npm run build"],
                  evidence: ["npm run build passed"],
                },
              },
            ],
          },
        });
        return;
      }

      await fulfillJson(route, { detail: `Unhandled collaboration route: ${method} ${path}` }, 500);
    });

    await page.getByTestId("hud-open-agent-workspace-button").click();
    await page.getByPlaceholder("/absolute/path/to/project").fill("/tmp/daacs-smoke-root");
    await page.getByRole("button", { name: "Save path" }).click();
    await page.getByPlaceholder("Enter shared objective for multi-agent round").fill(
      "Build a web artifact with insufficient UX evidence.",
    );
    await startRound(page);

    await expect(page.getByTestId("goal-outcome-banner")).toContainText("Completed", { timeout: 15_000 });
    await expect(page.getByTestId("goal-quality-gate")).toContainText("UI/UX states");
    await expect(page.getByTestId("goal-quality-gate")).toContainText("Needs review");
    await expect(page.getByTestId("goal-quality-score")).toContainText("Medium");
    await expect(page.getByTestId("goal-quality-score")).toContainText("Missing evidence: UI/UX states");
    await expect(page.getByTestId("goal-quality-score")).not.toContainText("Strong");
    await expect(page.getByTestId("goal-release-readiness")).toContainText("Not ready yet");
    await expect(page.getByTestId("goal-release-readiness")).toContainText("Missing evidence: UI/UX states");
    await expect(
      page.getByTestId("notification-toast").filter({
        hasText: /Completion candidate, quality repair needed: UI\/UX states.*\/tmp\/daacs-weak-ux-artifact/,
      }),
    ).toBeVisible();
    await expect(page.getByTestId("goal-quality-repair-button")).toContainText("Repair missing evidence");
    await page.getByTestId("goal-quality-repair-button").click();
    await expect(page.getByTestId("goal-outcome-banner")).toContainText("Same artifact repaired", {
      timeout: 15_000,
    });
    await expect(page.getByTestId("goal-quality-score")).toContainText("Strong");

    expect(qualityRepairPrompt).toContain("## REPAIR LATEST ARTIFACT QUALITY");
    expect(qualityRepairPrompt).toContain("Do not edit generated files manually outside this repair flow.");
    expect(qualityRepairPrompt).toContain("Missing quality gates:");
    expect(qualityRepairPrompt).toContain("goal.qualityGate.ux");
    expect(qualityRepairPrompt).toContain("Previous quality and verification context:");
    expect(qualityRepairPrompt).toContain("MISSING goal.qualityGate.ux");
    expect(qualityRepairPrompt).toContain("Previous verifier/reviewer evidence:");
    expect(qualityRepairPrompt).toContain("npm run build passed");
    expect(qualityRepairProjectCwd).toBe("/tmp/daacs-weak-ux-artifact");
  });

  test("blocks premium web artifacts when reference-grade evidence is only claimed loosely", async ({ page }) => {
    await enterOfficeFromProjectSelection(page);

    await page.route("**/api/collaboration/**", async (route) => {
      const request = route.request();
      const url = new URL(request.url());
      const path = url.pathname;
      const method = request.method().toUpperCase();

      if (method === "POST" && path === "/api/collaboration/project-alpha/sessions") {
        await fulfillJson(route, {
          status: "ok",
          session_id: "premium-weak-session",
          shared_goal: "Build a premium web artifact with product-grade UI.",
          participants: ["pm", "frontend", "reviewer", "verifier"],
        });
        return;
      }

      if (
        method === "POST" &&
        path === "/api/collaboration/project-alpha/sessions/premium-weak-session/rounds"
      ) {
        await fulfillJson(route, {
          status: "completed",
          session_id: "premium-weak-session",
          round: { round_id: "premium-weak-round", status: "completed", created_at: Date.now() },
          artifact: {
            session_id: "premium-weak-session",
            round_id: "premium-weak-round",
            status: "completed",
            decision: "Premium web artifact completed with a polished interface, but no reference-grade evidence.",
            refined_goal: "Build a premium product-grade web artifact.",
            acceptance_criteria: [
              "create runnable web artifact",
              "show requested primary UI",
              "premium product-grade UI",
            ],
            deliverables: ["Runnable web artifact", "Executable build evidence"],
            open_questions: [],
            next_actions: ["Artifact: /tmp/daacs-premium-weak-artifact", "npm run build passed"],
            contributions: [
              {
                team: "development_team",
                agent_role: "frontend",
                status: "completed",
                summary: "Created a polished web artifact with responsive cards and primary actions.",
                next_actions: ["Artifact: /tmp/daacs-premium-weak-artifact"],
                details: {
                  files: ["package.json", "src/App.tsx"],
                  workspace: "/tmp/daacs-premium-weak-artifact",
                },
              },
              {
                team: "review_team",
                agent_role: "reviewer",
                status: "completed",
                summary: "Reviewed requested behavior and responsive UI evidence.",
                details: {
                  review_focus: [
                    "primary task flow, empty state, validation state, mobile layout, button interaction, visual polish",
                  ],
                },
              },
              {
                team: "review_team",
                agent_role: "verifier",
                status: "completed",
                summary: "Verified executable user flow.",
                details: {
                  commands: ["npm run build"],
                  evidence: [
                    "npm run build passed",
                    "Browser smoke covered primary task flow, empty state, validation error, button interaction, mobile responsive behavior, no clipped primary actions, accessibility labels, and visual polish.",
                  ],
                },
              },
            ],
          },
        });
        return;
      }

      await fulfillJson(route, { detail: `Unhandled collaboration route: ${method} ${path}` }, 500);
    });

    await page.getByTestId("hud-open-agent-workspace-button").click();
    await page.getByPlaceholder("/absolute/path/to/project").fill("/tmp/daacs-smoke-root");
    await page.getByRole("button", { name: "Save path" }).click();
    await page.getByPlaceholder("Enter shared objective for multi-agent round").fill(
      "Build a premium web artifact with product-grade UI.",
    );
    await startRound(page);

    await expect(page.getByTestId("goal-outcome-banner")).toContainText("Completed", { timeout: 15_000 });
    await expect(page.getByTestId("goal-quality-gate")).toContainText("Premium evidence");
    await expect(page.getByTestId("goal-quality-gate")).toContainText("Needs review");
    await expect(page.getByTestId("goal-quality-score")).toContainText("Missing evidence:");
    await expect(page.getByTestId("goal-quality-score")).toContainText("Premium evidence");
    await expect(page.getByTestId("goal-quality-score")).not.toContainText("Strong");
    await expect(page.getByTestId("goal-premium-readiness")).toContainText("Premium product evidence");
    await expect(page.getByTestId("goal-premium-readiness")).toContainText("Reference archetype");
    await expect(page.getByTestId("goal-release-readiness")).toContainText("Not ready yet");
  });

  test("blocks ready verdict when web artifact verifier has no executable evidence", async ({ page }) => {
    await enterOfficeFromProjectSelection(page);

    await page.route("**/api/collaboration/**", async (route) => {
      const request = route.request();
      const url = new URL(request.url());
      const path = url.pathname;
      const method = request.method().toUpperCase();

      if (method === "POST" && path === "/api/collaboration/project-alpha/sessions") {
        await fulfillJson(route, {
          status: "ok",
          session_id: "no-exec-evidence-session",
          shared_goal: "Build a web artifact with UX notes but no executable verifier evidence",
          participants: ["pm", "developer", "reviewer", "verifier"],
        });
        return;
      }

      if (
        method === "POST" &&
        path === "/api/collaboration/project-alpha/sessions/no-exec-evidence-session/rounds"
      ) {
        await fulfillJson(route, {
          status: "completed",
          session_id: "no-exec-evidence-session",
          round: { round_id: "no-exec-evidence-round", status: "completed", created_at: Date.now() },
          artifact: {
            session_id: "no-exec-evidence-session",
            round_id: "no-exec-evidence-round",
            status: "completed",
            decision: "Web artifact completed, but verifier did not provide executable evidence.",
            acceptance_criteria: ["create interactive web UI", "cover visible UX states"],
            deliverables: ["Interactive web artifact"],
            open_questions: [],
            next_actions: ["Artifact: /tmp/daacs-no-exec-evidence-artifact"],
            contributions: [
              {
                team: "development_team",
                agent_role: "frontend",
                status: "completed",
                summary: "Created a web artifact with interactive UI.",
                details: {
                  files: ["package.json", "src/App.tsx"],
                  workspace: "/tmp/daacs-no-exec-evidence-artifact",
                },
              },
              {
                team: "review_team",
                agent_role: "reviewer",
                status: "completed",
                summary: "Reviewed visible UX states.",
                details: {
                  review_focus: [
                    "input form, empty state, mobile layout, validation error, button interaction, and visual polish",
                  ],
                },
              },
              {
                team: "review_team",
                agent_role: "verifier",
                status: "completed",
                summary: "Looked through the files but did not run the artifact.",
                details: {
                  verification_focus: ["file inspection only"],
                },
              },
            ],
          },
        });
        return;
      }

      await fulfillJson(route, { detail: `Unhandled collaboration route: ${method} ${path}` }, 500);
    });

    await page.getByTestId("hud-open-agent-workspace-button").click();
    await page.getByPlaceholder("/absolute/path/to/project").fill("/tmp/daacs-smoke-root");
    await page.getByRole("button", { name: "Save path" }).click();
    await page.getByPlaceholder("Enter shared objective for multi-agent round").fill(
      "Build a web artifact with UX notes but no executable verifier evidence.",
    );
    await startRound(page);

    await expect(page.getByTestId("goal-outcome-banner")).toContainText("Completed", { timeout: 15_000 });
    await expect(page.getByTestId("goal-quality-gate")).toContainText("Execution verification");
    await expect(page.getByTestId("goal-quality-gate")).toContainText("Needs review");
    await expect(page.getByTestId("goal-quality-score")).not.toContainText("Strong");
    await expect(page.getByTestId("goal-quality-score")).toContainText("Missing evidence: Execution verification");
    await expect(page.getByTestId("goal-release-readiness")).toContainText("Not ready yet");
  });

  test("blocks ready verdict when web artifact has no requirement coverage evidence", async ({ page }) => {
    await enterOfficeFromProjectSelection(page);

    await page.route("**/api/collaboration/**", async (route) => {
      const request = route.request();
      const url = new URL(request.url());
      const path = url.pathname;
      const method = request.method().toUpperCase();

      if (method === "POST" && path === "/api/collaboration/project-alpha/sessions") {
        await fulfillJson(route, {
          status: "ok",
          session_id: "no-requirement-evidence-session",
          shared_goal: "Build a web artifact that looks done but does not report requested feature coverage",
          participants: ["pm", "developer", "reviewer", "verifier"],
        });
        return;
      }

      if (
        method === "POST" &&
        path === "/api/collaboration/project-alpha/sessions/no-requirement-evidence-session/rounds"
      ) {
        await fulfillJson(route, {
          status: "completed",
          session_id: "no-requirement-evidence-session",
          round: { round_id: "no-requirement-evidence-round", status: "completed", created_at: Date.now() },
          artifact: {
            session_id: "no-requirement-evidence-session",
            round_id: "no-requirement-evidence-round",
            status: "completed",
            decision: "Web artifact completed with build and UX evidence, but no structured requirement coverage.",
            open_questions: [],
            next_actions: ["Artifact: /tmp/daacs-no-requirement-evidence-artifact", "npm run smoke passed"],
            contributions: [
              {
                team: "development_team",
                agent_role: "frontend",
                status: "completed",
                summary: "Created a web artifact with interactive UI.",
                details: {
                  files: ["package.json", "src/App.tsx"],
                  workspace: "/tmp/daacs-no-requirement-evidence-artifact",
                },
              },
              {
                team: "review_team",
                agent_role: "reviewer",
                status: "completed",
                summary: "Reviewed UI and file structure, but did not map requested requirements.",
                details: {
                  review_focus: ["file structure and visible UI states"],
                },
              },
              {
                team: "review_team",
                agent_role: "verifier",
                status: "completed",
                summary: "Verified executable user flow.",
                details: {
                  commands: ["npm run smoke"],
                  evidence: [
                    "npm run smoke passed",
                    "Responsive mobile layout, empty state, validation error state, button interaction, and visual polish checked.",
                  ],
                },
              },
            ],
          },
        });
        return;
      }

      await fulfillJson(route, { detail: `Unhandled collaboration route: ${method} ${path}` }, 500);
    });

    await page.getByTestId("hud-open-agent-workspace-button").click();
    await page.getByPlaceholder("/absolute/path/to/project").fill("/tmp/daacs-smoke-root");
    await page.getByRole("button", { name: "Save path" }).click();
    await page.getByPlaceholder("Enter shared objective for multi-agent round").fill(
      "Build a web artifact that looks done but does not report requested feature coverage.",
    );
    await startRound(page);

    await expect(page.getByTestId("goal-outcome-banner")).toContainText("Completed", { timeout: 15_000 });
    await expect(page.getByTestId("goal-quality-gate")).toContainText("Requirement coverage");
    await expect(page.getByTestId("goal-quality-gate")).toContainText("Needs review");
    await expect(page.getByTestId("goal-quality-score")).not.toContainText("Strong");
    await expect(page.getByTestId("goal-quality-score")).toContainText("Missing evidence: Requirement coverage");
    await expect(page.getByTestId("goal-release-readiness")).toContainText("Not ready yet");
    await expect(page.getByTestId("goal-release-readiness")).toContainText("Missing evidence: Requirement coverage");
  });

  test("runs a modification request against the latest artifact instead of a fresh scaffold", async ({ page }) => {
    await enterOfficeFromProjectSelection(page);
    let roundCallCount = 0;
    let modifyPrompt = "";
    let modifyProjectCwd = "";
    let qaRepairPrompt = "";
    let qaRepairProjectCwd = "";

    await page.route("**/api/collaboration/**", async (route) => {
      const request = route.request();
      const url = new URL(request.url());
      const path = url.pathname;
      const method = request.method().toUpperCase();

      if (method === "POST" && path === "/api/collaboration/project-alpha/sessions") {
        await fulfillJson(route, {
          status: "ok",
          session_id: "modify-session",
          shared_goal: "Build a meeting room booking website",
          participants: ["pm", "developer", "reviewer", "verifier"],
        });
        return;
      }

      if (
        method === "POST" &&
        path === "/api/collaboration/project-alpha/sessions/modify-session/rounds"
      ) {
        roundCallCount += 1;
        const payload = request.postDataJSON() as { prompt?: string; project_cwd?: string };
        if (roundCallCount === 2) {
          modifyPrompt = payload.prompt ?? "";
          modifyProjectCwd = payload.project_cwd ?? "";
          await fulfillJson(route, {
            status: "completed",
            session_id: "modify-session",
            round: { round_id: "modify-round-2", status: "completed", created_at: Date.now() },
            artifact: completedWebArtifact({
              sessionId: "modify-session",
              roundId: "modify-round-2",
              workspace: "/tmp/daacs-booking-artifact",
              decision: "Existing booking artifact modified with a capacity filter and preserved prior room cards.",
              summary: "Modified the existing booking artifact in place.",
              reviewFocus: "existing artifact scope, capacity filter, prior behavior preservation",
              verifierEvidence: "Browser smoke covered capacity filter, preserved room cards, empty state, and responsive layout.",
            }),
          });
          return;
        }
        if (roundCallCount === 3) {
          qaRepairPrompt = payload.prompt ?? "";
          qaRepairProjectCwd = payload.project_cwd ?? "";
          await fulfillJson(route, {
            status: "completed",
            session_id: "modify-session",
            round: { round_id: "modify-round-3", status: "completed", created_at: Date.now() },
            artifact: completedWebArtifact({
              sessionId: "modify-session",
              roundId: "modify-round-3",
              workspace: "/tmp/daacs-booking-artifact",
              decision: "Existing booking artifact repaired from QA feedback without a fresh scaffold.",
              summary: "Applied user QA feedback to the existing booking artifact.",
              reviewFocus: "manual QA feedback, mobile card overlap, previous capacity filter preservation",
              verifierEvidence: "Browser smoke covered mobile card layout, preserved capacity filter, empty state, and responsive layout.",
            }),
          });
          return;
        }
        await fulfillJson(route, {
          status: "completed",
          session_id: "modify-session",
          round: { round_id: "modify-round-1", status: "completed", created_at: Date.now() },
          artifact: completedWebArtifact({
            sessionId: "modify-session",
            roundId: "modify-round-1",
            workspace: "/tmp/daacs-booking-artifact",
            decision: "Meeting room booking artifact completed.",
            summary: "Implemented the initial booking artifact.",
            reviewFocus: "room filters, unavailable room state, reservation button state",
            verifierEvidence: "Browser smoke covered filters, unavailable room rejection, reservation buttons, and mobile layout.",
          }),
        });
        return;
      }

      await fulfillJson(route, { detail: `Unhandled collaboration route: ${method} ${path}` }, 500);
    });

    await page.getByTestId("hud-open-agent-workspace-button").click();
    await page.getByPlaceholder("/absolute/path/to/project").fill("/tmp/daacs-smoke-root");
    await page.getByRole("button", { name: "Save path" }).click();
    await page.getByPlaceholder("Enter shared objective for multi-agent round").fill(
      "Build a meeting room booking website with room filters and unavailable room states.",
    );
    await startRound(page);
    await expect(page.getByTestId("goal-outcome-banner")).toContainText("Completed", { timeout: 15_000 });

    await page.getByPlaceholder("Enter shared objective for multi-agent round").fill("Add a capacity filter to the one you just made.");
    await page.getByRole("button", { name: "Run as modification" }).click();
    await expect(page.getByTestId("goal-outcome-banner")).toContainText("Existing booking artifact modified", {
      timeout: 15_000,
    });

    expect(modifyPrompt).toContain("## MODIFY EXISTING ARTIFACT");
    expect(modifyPrompt).toContain("Add a capacity filter");
    expect(modifyPrompt).toContain("Previous artifact workspace: /tmp/daacs-booking-artifact");
    expect(modifyPrompt).toContain("Previous quality and verification context:");
    expect(modifyPrompt).toContain("PASS goal.qualityGate.requirements");
    expect(modifyPrompt).toContain("Previous requirement coverage:");
    expect(modifyPrompt).toContain("room filters, unavailable room state, reservation button state");
    expect(modifyPrompt).toContain("Previous verifier/reviewer evidence:");
    expect(modifyPrompt).toContain("npm run smoke passed");
    expect(modifyProjectCwd).toBe("/tmp/daacs-booking-artifact");

    await page.getByTestId("goal-artifact-qa-feedback").fill("On mobile, the room cards overlap after the capacity filter is applied.");
    await page.getByTestId("goal-artifact-qa-repair-button").click();
    await expect(page.getByTestId("goal-outcome-banner")).toContainText("repaired from QA feedback", {
      timeout: 15_000,
    });
    expect(qaRepairPrompt).toContain("## REPAIR LATEST ARTIFACT FROM QA FEEDBACK");
    expect(qaRepairPrompt).toContain("## User QA feedback");
    expect(qaRepairPrompt).toContain("room cards overlap");
    expect(qaRepairPrompt).toContain("Previous artifact workspace: /tmp/daacs-booking-artifact");
    expect(qaRepairPrompt).toContain("Previous quality and verification context:");
    expect(qaRepairPrompt).toContain("Previous verifier/reviewer evidence:");
    expect(qaRepairPrompt).toContain("Do not edit generated files manually outside this repair flow.");
    expect(qaRepairProjectCwd).toBe("/tmp/daacs-booking-artifact");
  });

  for (const scenario of domainSmokeScenarios) {
    test(`keeps completion quality domain-neutral for ${scenario.name} artifacts`, async ({ page }) => {
      await enterOfficeFromProjectSelection(page);
      let roundProjectCwd = "";

      await page.route("**/api/collaboration/**", async (route) => {
        const request = route.request();
        const url = new URL(request.url());
        const path = url.pathname;
        const method = request.method().toUpperCase();

        if (method === "POST" && path === "/api/collaboration/project-alpha/sessions") {
          await fulfillJson(route, {
            status: "ok",
            session_id: scenario.sessionId,
            shared_goal: scenario.prompt,
            participants: ["pm", "developer", "reviewer", "verifier"],
          });
          return;
        }

        if (
          method === "POST" &&
          path === `/api/collaboration/project-alpha/sessions/${scenario.sessionId}/rounds`
        ) {
          const payload = request.postDataJSON() as { project_cwd?: string };
          roundProjectCwd = payload.project_cwd ?? "";
          await fulfillJson(route, {
            status: "completed",
            session_id: scenario.sessionId,
            round: { round_id: scenario.roundId, status: "completed", created_at: Date.now() },
            artifact: completedWebArtifact(scenario),
          });
          return;
        }

        await fulfillJson(route, { detail: `Unhandled collaboration route: ${method} ${path}` }, 500);
      });

      await page.getByTestId("hud-open-agent-workspace-button").click();
      await page.getByPlaceholder("/absolute/path/to/project").fill("/tmp/daacs-smoke-root");
      await page.getByRole("button", { name: "Save path" }).click();
      await page.getByPlaceholder("Enter shared objective for multi-agent round").fill(scenario.prompt);
      await startRound(page);

      await expect(page.getByTestId("goal-outcome-banner")).toContainText("Completed", { timeout: 15_000 });
      await expect(page.getByTestId("goal-outcome-banner")).toContainText(scenario.decision);
      await expect(page.getByTestId("goal-quality-gate")).toContainText("UI/UX states");
      await expect(page.getByTestId("goal-quality-score")).toContainText("Strong");
      await expect(page.getByTestId("goal-release-readiness")).toContainText("Ready to use");
      await expect(page.getByText(`Artifact location: ${scenario.workspace}`).first()).toBeVisible();
      expect(roundProjectCwd).toBe("/tmp/daacs-smoke-root");
    });
  }
});
