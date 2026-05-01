import { readdir, readFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) {
    throw new Error(message);
  }
}

function createInvokeMock(): (command: string, args?: Record<string, unknown>) => Promise<unknown> {
  return async (command, args) => {
    switch (command) {
      case "prompting_sequencer_system_prompt_command":
        assert(args?.projectName === "local", "Delegation prompt should request the active project name");
        return "Prompting Sequencer Protocol";
      case "get_agent_prompt":
        return "Role prompt";
      default:
        throw new Error(`Unexpected Tauri invoke command: ${command}`);
    }
  };
}

function setWindowInvokeMock(
  invoke: (command: string, args?: Record<string, unknown>) => Promise<unknown>,
): void {
  Object.defineProperty(globalThis, "window", {
    configurable: true,
    value: {
      __TAURI__: {
        core: {
          invoke,
        },
      },
    },
  });
}

function setLocalStorageMock(
  values: Record<string, string> = {},
): void {
  const store = new Map(Object.entries(values));
  Object.defineProperty(globalThis, "localStorage", {
    configurable: true,
    value: {
      getItem(key: string) {
        return store.get(key) ?? null;
      },
      setItem(key: string, value: string) {
        store.set(key, String(value));
      },
      removeItem(key: string) {
        store.delete(key);
      },
    },
  });
}

async function collectSourceFiles(root: URL): Promise<URL[]> {
  const entries = await readdir(root, { withFileTypes: true });
  const files: URL[] = [];
  for (const entry of entries) {
    const entryUrl = new URL(`${entry.name}${entry.isDirectory() ? "/" : ""}`, root);
    if (entry.isDirectory()) {
      files.push(...await collectSourceFiles(entryUrl));
      continue;
    }
    if (
      (entry.name.endsWith(".ts") || entry.name.endsWith(".tsx")) &&
      !entry.name.endsWith(".test.ts") &&
      !entry.name.endsWith(".test.tsx")
    ) {
      files.push(entryUrl);
    }
  }
  return files;
}

export async function runTauriCliRegressionTests(): Promise<void> {
  setWindowInvokeMock(createInvokeMock());
  setLocalStorageMock();

  const {
    buildProjectCliSessionKey,
    buildRosterDelegationSystemPrompt,
    CLI_PROVIDER_STORAGE_KEY,
    CLI_WORKSPACE_STORAGE_KEY,
    getSavedLocalLlmPath,
    getAgentPrompt,
    getAgentPromptByPromptKey,
    getAgentPromptRoleForOfficeRole,
    listLocalLlmModels,
    openPathInFileManager,
    getSavedWorkspacePath,
    parsePmTaskLists,
    getPromptingSequencerRoleKeyByOfficeRole,
    runCliCommand,
    runBackendCliCommand,
    runFrontendCliCommand,
    resolveProjectWorkspacePath,
    setSavedLocalLlmPath,
    openLocalLlmDirectoryDialog,
    setSavedWorkspacePath,
  } = await import("./tauriCli");
  const { STORAGE_KEY_CLI_PROVIDER, STORAGE_KEY_CLI_WORKSPACE } = await import("../constants");
  const { DEFAULT_BUNDLED_PROMPT_TEXT_BY_KEY } = await import("../lib/defaultBundledAgentPromptTexts");
  const CLI_PROJECT_WORKSPACE_MAP_STORAGE_KEY = "daacs_cli_workspace_by_project";

  assert(
    CLI_PROVIDER_STORAGE_KEY === STORAGE_KEY_CLI_PROVIDER &&
      CLI_WORKSPACE_STORAGE_KEY === STORAGE_KEY_CLI_WORKSPACE,
    "tauriCli should keep its exported storage aliases synced with the shared constants module",
  );

  const prompt = await buildRosterDelegationSystemPrompt(
    "local",
    "frontend",
    '{"agents":[]}',
    { omitRoster: true },
  );

  assert(prompt != null && prompt.trim() !== "", "Expected a non-empty roster delegation system prompt");
  assert(
    prompt.includes("Prompting Sequencer Protocol") && prompt.includes("Role prompt"),
    "Delegation prompt should include both the sequencer system prompt and the agent role prompt",
  );
  assert(
    prompt.includes("## Agent roster (Resources/Agents/agents_metadata.json)\n(Omitted for this step)"),
    "Delegation prompt should preserve the roster omission contract when omitRoster=true",
  );
  assert(
    prompt.includes("Execute the assigned command in your reply (concrete work, files, or verification).") &&
      prompt.includes("When you must delegate to other roster agents, output exactly one [AGENT_COMMANDS] block after your main output.") &&
      !prompt.includes("[NEXT_WORKFLOW]") &&
      prompt.includes("Use only agent ids from the roster."),
    "Delegation prompt should preserve the default sequencer execution and delegation contract",
  );

  assert(
    getAgentPromptRoleForOfficeRole("developer_front") === "frontend" &&
      getAgentPromptRoleForOfficeRole("developer_back") === "backend" &&
      getAgentPromptRoleForOfficeRole("frontend") === "frontend" &&
      getAgentPromptRoleForOfficeRole("backend") === "backend",
    "tauriCli should route shipped frontend/backend implementation roles to their default agent prompts",
  );

  assert(
    (await getPromptingSequencerRoleKeyByOfficeRole("developer_front")) === "frontend" &&
      (await getPromptingSequencerRoleKeyByOfficeRole("developer_back")) === "backend" &&
      (await getPromptingSequencerRoleKeyByOfficeRole("frontend")) === "frontend" &&
      (await getPromptingSequencerRoleKeyByOfficeRole("backend")) === "backend",
    "tauriCli sequencer role-key lookup should include shipped frontend/backend implementation agents",
  );
  setWindowInvokeMock(async (command, args) => {
    if (command === "prompting_sequencer_system_prompt_command") {
      assert(args?.projectName === "local", "Default implementation wrappers should request the active project name");
      return "Prompting Sequencer Protocol";
    }
    if (command === "get_agent_prompt") return "Role prompt";
    if (command === "omni_cli_run_command") {
      return { stdout: "ok", stderr: "", exit_code: 0, provider: "mock_provider" };
    }
    throw new Error(`Unexpected Tauri invoke command: ${command}`);
  });
  const blockedFrontendRun = await runFrontendCliCommand("Build the UI.", { projectName: "local" });
  const blockedBackendRun = await runBackendCliCommand("Build the API.", { projectName: "local" });
  assert(
    blockedFrontendRun?.provider === "mock_provider" &&
      blockedBackendRun?.provider === "mock_provider",
    "frontend/backend CLI wrappers should run through the shipped implementation agents",
  );

  setWindowInvokeMock(async (command) => {
    if (command === "get_agent_prompt") {
      throw new Error("missing prompt asset");
    }
    throw new Error(`Unexpected Tauri invoke command: ${command}`);
  });

  const reviewerFallback = await getAgentPrompt("reviewer");
  assert(
    reviewerFallback.includes("[ReviewVerdict]") &&
      reviewerFallback.includes("Do NOT emit") &&
      reviewerFallback.includes("[AGENT_COMMANDS]"),
    "tauriCli should prefer the bundled role-aware reviewer prompt when the Tauri prompt lookup fails",
  );
  const developerFallback = await getAgentPrompt("backend");
  assert(
    developerFallback.includes("backend developer") ||
      developerFallback.includes("Backend Developer") ||
      developerFallback.includes("server-side"),
    "tauriCli should prefer the bundled backend prompt for the shipped backend agent",
  );
  const frontendFallback = await getAgentPrompt("frontend");
  assert(
    frontendFallback.includes("PM and Designer handoff contract") &&
      frontendFallback.includes("Designer DesignSpec") &&
      frontendFallback.includes("Frontend turns that PM/Designer contract into working code") &&
      frontendFallback.includes("ReferenceBoard") &&
      frontendFallback.includes("reference_archetype") &&
      frontendFallback.includes("reference_quality_bar") &&
      frontendFallback.includes("keep entered data when validation fails") &&
      frontendFallback.includes("reference pattern adaptation"),
    "tauriCli should include the bundled frontend PM/Designer handoff contract",
  );
  const pmFallback = await getAgentPrompt("pm");
  assert(
    pmFallback.includes("designer first when a designer agent exists") &&
      pmFallback.includes("ReferenceBoard plus DesignSpec") &&
      pmFallback.includes("one reference_archetype") &&
      pmFallback.includes("frontend implement that contract"),
    "tauriCli should include PM guidance to route design-heavy work through designer before frontend",
  );
  const designerFallback = await getAgentPromptByPromptKey("agent_designer");
  assert(
    designerFallback.includes("DesignSpec:") &&
      designerFallback.includes("ReferenceBoard:") &&
      designerFallback.includes("product_promise") &&
      designerFallback.includes("reference_archetype") &&
      designerFallback.includes("reference_quality_bar") &&
      designerFallback.includes("Reference archetype library") &&
      designerFallback.includes("Reference priority") &&
      designerFallback.includes("source_level") &&
      designerFallback.includes("Decision and form UX rules") &&
      designerFallback.includes("scanability") &&
      designerFallback.includes("references_consulted") &&
      designerFallback.includes("must_not") &&
      designerFallback.includes("Premium UI rules"),
    "tauriCli should include the bundled designer DesignSpec contract for premium UI work",
  );
  const bannedDemoDomainPhrases = [
    "league of legends",
    "champion select",
    "champion recommendation",
    "draft advisor",
    "pick recommender",
    "data dragon",
    "riot games",
    "롤 픽창",
    "챔피언 추천",
    "밴: 아리",
  ];
  for (const [promptKey, promptText] of Object.entries(DEFAULT_BUNDLED_PROMPT_TEXT_BY_KEY)) {
    const normalizedPromptText = promptText.toLowerCase();
    const leakedPhrase = bannedDemoDomainPhrases.find((phrase) =>
      normalizedPromptText.includes(phrase.toLowerCase()),
    );
    assert(
      leakedPhrase == null,
      `Bundled web prompt ${promptKey} should stay domain-agnostic, leaked ${leakedPhrase}`,
    );
  }

  setWindowInvokeMock(async (command) => {
    if (command === "parse_pm_task_lists_command") {
      throw new Error("parse failure");
    }
    throw new Error(`Unexpected Tauri invoke command: ${command}`);
  });

  const parsedUnstructured = await parsePmTaskLists("PM_SUMMARY:\n- only summary without task sections");
  assert(
    parsedUnstructured.summary === "only summary without task sections" &&
      parsedUnstructured.roleAssignmentNotes.length === 0 &&
      parsedUnstructured.frontend.length === 0 &&
      parsedUnstructured.backend.length === 0 &&
      parsedUnstructured.reviewer.length === 0 &&
      parsedUnstructured.verifier.length === 0 &&
      parsedUnstructured.unstructured.includes("only summary without task sections"),
    "tauriCli PM parsing should preserve unstructured output instead of copying the raw PM text into every role bucket",
  );

  const parsedStructured = await parsePmTaskLists(
    "PM_SUMMARY:\n- Build the MVP.\n\nROLE_ASSIGNMENT_NOTES:\n- Frontend owns UI flow.\n- Backend owns API.\n\nFRONTEND_TASKS:\n- Implement the draft input.\n\nBACKEND_TASKS:\n- Define the API contract.\n\nREVIEWER_TASKS:\n- Check recommendation quality.\n\nVERIFIER_TASKS:\n- Validate scenario coverage.",
  );
  assert(
    parsedStructured.summary === "Build the MVP." &&
      parsedStructured.roleAssignmentNotes[0] === "Frontend owns UI flow." &&
      parsedStructured.frontend[0] === "Implement the draft input." &&
      parsedStructured.backend[0] === "Define the API contract." &&
      parsedStructured.reviewer[0] === "Check recommendation quality." &&
      parsedStructured.verifier[0] === "Validate scenario coverage.",
    "tauriCli PM parsing should recover PM summary and role-assignment notes alongside the per-role task buckets",
  );

  setLocalStorageMock({
    [CLI_WORKSPACE_STORAGE_KEY]: "/repo/root",
  });
  const localWorkspace = await resolveProjectWorkspacePath("local");
  assert(
    localWorkspace === "/repo/root",
    "tauriCli should preserve the legacy global workspace for local execution",
  );

  setLocalStorageMock({
    [CLI_WORKSPACE_STORAGE_KEY]: "/repo/root",
  });
  const missingProjectWorkspace = await resolveProjectWorkspacePath("project-123");
  assert(
    missingProjectWorkspace == null,
    "tauriCli should not silently reuse the legacy global workspace for named projects without an explicit project binding",
  );

  setLocalStorageMock({
    [CLI_WORKSPACE_STORAGE_KEY]: "/repo/root",
    [CLI_PROJECT_WORKSPACE_MAP_STORAGE_KEY]: JSON.stringify({
      "project-123": "/repo/project-123",
    }),
  });
  const projectScopedWorkspace = await resolveProjectWorkspacePath("project-123");
  assert(
    projectScopedWorkspace === "/repo/project-123",
    "tauriCli should resolve named projects from the per-project workspace map before considering any legacy global selection",
  );

  setLocalStorageMock();
  setSavedWorkspacePath("/repo/project-456", "project-456");
  assert(
    getSavedWorkspacePath("project-456") === "/repo/project-456",
    "tauriCli should persist project-specific workspace selections through the shared storage helpers",
  );
  setSavedWorkspacePath("/repo/project-123", "project-123");
  setSavedLocalLlmPath("  /models/custom.gguf  ");
  assert(
    getSavedLocalLlmPath() === "/models/custom.gguf",
    "tauriCli should trim and persist the user-selected local model file path",
  );

  setWindowInvokeMock(async (command) => {
    if (command === "list_local_llm_models") {
      return [
        { path: "/models/a.gguf", name: "a.gguf", kind: "gguf", sizeBytes: 1_000_000 },
        { path: "/models/b", name: "b", kind: "mlx", sizeBytes: 2_000_000 },
      ];
    }
    throw new Error(`Unexpected Tauri invoke command: ${command}`);
  });
  const localCandidates = await listLocalLlmModels();
  assert(
    localCandidates.length === 2 &&
      localCandidates[0].path === "/models/a.gguf" &&
      localCandidates[1].kind === "mlx",
    "tauriCli should expose detected local model candidates for user selection",
  );

  setWindowInvokeMock(createInvokeMock());
  Object.defineProperty(globalThis, "window", {
    configurable: true,
    value: {
      __TAURI__: {
        core: {
          invoke: createInvokeMock(),
        },
        dialog: {
          async open(options?: { directory?: boolean; multiple?: boolean }) {
            assert(options?.directory === true, "Local LLM directory picker should request a directory");
            assert(options?.multiple === false, "Local LLM directory picker should select one model directory");
            return "/models/mlx-gemma";
          },
        },
      },
    },
  });
  const selectedModelDir = await openLocalLlmDirectoryDialog();
  assert(
    selectedModelDir === "/models/mlx-gemma",
    "tauriCli should allow selecting MLX/HuggingFace local model directories, not only GGUF files",
  );

  let openedPath: string | null = null;
  setWindowInvokeMock(async (command, args) => {
    if (command === "open_path_in_file_manager") {
      openedPath = typeof args?.path === "string" ? args.path : null;
      return null;
    }
    throw new Error(`Unexpected Tauri invoke command: ${command}`);
  });
  await openPathInFileManager("  /repo/artifact  ");
  assert(
    openedPath === "/repo/artifact",
    "tauriCli should open artifact paths through the desktop file manager command",
  );

  let capturedSessionKey: string | null = null;
  let capturedCwd: string | null = null;
  let capturedLocalLlmPath: string | null = null;
  let capturedLocalLlmBaseUrl: string | null = null;
  setWindowInvokeMock(async (command, args) => {
    if (command === "omni_cli_run_command") {
      capturedSessionKey =
        typeof args?.sessionKey === "string" ? args.sessionKey : null;
      capturedCwd = typeof args?.cwd === "string" ? args.cwd : null;
      capturedLocalLlmPath =
        typeof args?.localLlmPath === "string" ? args.localLlmPath : null;
      capturedLocalLlmBaseUrl =
        typeof args?.localLlmBaseUrl === "string" ? args.localLlmBaseUrl : null;
      return { stdout: "ok", stderr: "", exit_code: 0, provider: "codex" };
    }
    throw new Error(`Unexpected Tauri invoke command: ${command}`);
  });
  await runCliCommand("return ok", {
    provider: "codex",
    projectName: "project-123",
    localLlmBaseUrl: "http://127.0.0.1:11434",
    sessionKey: "sequencer:pm:plan",
  });
  assert(
    capturedSessionKey === "sequencer:pm:plan",
    "tauriCli should forward the optional sessionKey to the Tauri omni_cli_run_command bridge",
  );
  assert(
    capturedCwd === "/repo/project-123",
    "tauriCli should resolve the project-scoped workspace before invoking the Tauri omni_cli_run_command bridge",
  );
  assert(
    capturedLocalLlmBaseUrl === "http://127.0.0.1:11434",
    "tauriCli should forward the localLlmBaseUrl to the Tauri omni_cli_run_command bridge",
  );
  assert(
    capturedLocalLlmPath === "/models/custom.gguf",
    "tauriCli should forward the saved user-selected local model file path to the Tauri bridge",
  );

  assert(
    buildProjectCliSessionKey("Project Alpha", ["agent-command", "Reviewer"]) ===
      "project:project-alpha:agent-command:reviewer",
    "tauriCli should build stable project-scoped session keys for reusable Codex conversations",
  );

  const legacyInvokePattern =
    /\binvoke\(\s*["'](?:cli_run_command|cli_which|cli_workspace_path|prepare_project_workspace)["']/;
  const sourceFiles = await collectSourceFiles(new URL("../", import.meta.url));
  for (const sourceFile of sourceFiles) {
    const contents = await readFile(sourceFile, "utf8");
    assert(
      !legacyInvokePattern.test(contents),
      `web runtime should not directly invoke legacy Tauri commands: ${sourceFile.pathname}`,
    );
  }

  const tauriCliSource = await readFile(new URL("./tauriCli.ts", import.meta.url), "utf8");
  assert(
    tauriCliSource.includes('from "@tauri-apps/plugin-fs"') &&
      tauriCliSource.includes("prepareArtifactWorkspaceWithFsFallback") &&
      tauriCliSource.includes("prepareArtifactWorkspaceWithHostCommandFallback") &&
      tauriCliSource.includes("node -e \"const fs=require('fs');") &&
      tauriCliSource.includes("invokeTauriCore<string>(\"prepare_artifact_workspace\""),
    "tauriCli fresh artifact preparation should keep the Rust command path plus host and Tauri FS fallbacks",
  );

  console.log("tauriCli delegation prompt regression passed");
}

function isDirectRun(): boolean {
  const entry = process.argv[1];
  return entry != null && import.meta.url === pathToFileURL(entry).href;
}

if (isDirectRun()) {
  void runTauriCliRegressionTests().catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
}
