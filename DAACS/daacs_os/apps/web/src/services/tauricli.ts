import { mkdir, stat } from "@tauri-apps/plugin-fs";
import {
  STORAGE_KEY_CLI_WORKSPACE,
  STORAGE_KEY_CLI_PROVIDER,
  STORAGE_KEY_LOCAL_LLM_BASE_URL,
} from "../constants";
import type { AgentRole } from "../types/agent";
import type { SkillBundleSummary, SkillMeta } from "../types/runtime";
import { DEFAULT_BUNDLED_PROMPT_TEXT_BY_KEY } from "../lib/defaultBundledAgentPromptTexts";
import {
  findAgentMetadataByIdSync,
  loadAgentsMetadataDocument,
  resolveAgentIdForOfficeRoleSync,
} from "../lib/agentsMetadata";

export const CLI_WORKSPACE_STORAGE_KEY = STORAGE_KEY_CLI_WORKSPACE;
export const CLI_PROVIDER_STORAGE_KEY = STORAGE_KEY_CLI_PROVIDER;
export const LOCAL_LLM_PATH_STORAGE_KEY = "daacs_local_llm_path";
export const LOCAL_LLM_BASE_URL_STORAGE_KEY = STORAGE_KEY_LOCAL_LLM_BASE_URL;
const CLI_PROJECT_WORKSPACE_STORAGE_KEY = "daacs_cli_workspace_by_project";
export const DEFAULT_CLI_PROVIDER: CliProvider = "codex";

export type CliProvider = "gemini" | "codex" | "claude" | "local_llm";

export interface CliRunResult {
  stdout: string;
  stderr: string;
  exit_code: number;
  provider: string;
}

export interface CliWhichResult {
  preferred: string;
  codex: string | null;
  gemini: string | null;
  claude: string | null;
  local_llm: string | null;
}

export interface LocalLlmCandidate {
  path: string;
  name: string;
  kind: string;
  sizeBytes: number;
}

declare global {
  interface Window {
    __TAURI__?: {
      core?: { invoke: (cmd: string, args?: Record<string, unknown>) => Promise<unknown> };
      dialog?: { open: (options?: { directory?: boolean; multiple?: boolean; filters?: { name: string, extensions: string[] }[] }) => Promise<string | string[] | null> };
    };
  }
}

function normalizeWorkspaceProjectKey(InProjectId?: string | null): string | null {
  const value = String(InProjectId ?? "").trim();
  return value !== "" ? value : null;
}

function readSavedProjectWorkspaceMap(): Record<string, string> {
  if (typeof localStorage === "undefined") return {};
  try {
    const raw = localStorage.getItem(CLI_PROJECT_WORKSPACE_STORAGE_KEY)?.trim();
    if (!raw) return {};
    const parsed = JSON.parse(raw) as unknown;
    if (parsed == null || typeof parsed !== "object" || Array.isArray(parsed)) {
      return {};
    }
    return Object.fromEntries(
      Object.entries(parsed)
        .map(([key, value]) => [String(key).trim(), typeof value === "string" ? value.trim() : ""])
        .filter(([key, value]) => key !== "" && value !== ""),
    );
  } catch {
    return {};
  }
}

function writeSavedProjectWorkspaceMap(InMap: Record<string, string>): void {
  if (typeof localStorage === "undefined") return;
  const normalized = Object.fromEntries(
    Object.entries(InMap)
      .map(([key, value]) => [String(key).trim(), String(value ?? "").trim()])
      .filter(([key, value]) => key !== "" && value !== ""),
  );
  try {
    if (Object.keys(normalized).length === 0) {
      localStorage.removeItem(CLI_PROJECT_WORKSPACE_STORAGE_KEY);
      return;
    }
    localStorage.setItem(CLI_PROJECT_WORKSPACE_STORAGE_KEY, JSON.stringify(normalized));
  } catch {
    /**/
  }
}

export function getSavedProjectWorkspacePath(InProjectId?: string | null): string | null {
  const projectKey = normalizeWorkspaceProjectKey(InProjectId);
  if (projectKey == null) return null;
  const workspaceMap = readSavedProjectWorkspaceMap();
  const value = workspaceMap[projectKey]?.trim();
  return value && value.length > 0 ? value : null;
}

export function getExecutionWorkspacePath(InProjectId?: string | null): string | null {
  const normalizedProjectId = normalizeWorkspaceProjectKey(InProjectId)?.toLowerCase() ?? "";
  if (normalizedProjectId === "" || normalizedProjectId === "local") {
    if (typeof localStorage === "undefined") return null;
    try {
      const v = localStorage.getItem(CLI_WORKSPACE_STORAGE_KEY)?.trim();
      return v && v.length > 0 ? v : null;
    } catch {
      return null;
    }
  }
  return getSavedProjectWorkspacePath(InProjectId);
}

export function getSavedWorkspacePath(InProjectId?: string | null): string | null {
  const projectScoped = getSavedProjectWorkspacePath(InProjectId);
  if (projectScoped != null) return projectScoped;
  if (typeof localStorage === "undefined") return null;
  try {
    const v = localStorage.getItem(CLI_WORKSPACE_STORAGE_KEY)?.trim();
    return v && v.length > 0 ? v : null;
  } catch {
    return null;
  }
}

export function setSavedWorkspacePath(InPath: string | null, InProjectId?: string | null): void {
  try {
    const trimmedPath = InPath?.trim() ?? "";
    if (trimmedPath === "") localStorage.removeItem(CLI_WORKSPACE_STORAGE_KEY);
    else localStorage.setItem(CLI_WORKSPACE_STORAGE_KEY, trimmedPath);

    const projectKey = normalizeWorkspaceProjectKey(InProjectId);
    if (projectKey != null) {
      const workspaceMap = readSavedProjectWorkspaceMap();
      if (trimmedPath === "") delete workspaceMap[projectKey];
      else workspaceMap[projectKey] = trimmedPath;
      writeSavedProjectWorkspaceMap(workspaceMap);
    }
  } catch {
    /**/
  }
}

export async function openWorkspaceDialog(): Promise<string | null> {
  if (!isTauri()) return null;
  try {
    const invoked = await window.__TAURI__?.core?.invoke("open_workspace_directory_dialog");
    if (typeof invoked === "string" && invoked.trim() !== "") return invoked;
    if (invoked == null) return null;
  } catch {
    // Older desktop bundles may not have the Rust dialog command yet.
  }
  if (!window.__TAURI__?.dialog) return null;
  try {
    const result = await window.__TAURI__!.dialog!.open({ directory: true, multiple: false });
    if (result == null) return null;
    return typeof result === "string" ? result : result[0] ?? null;
  } catch {
    return null;
  }
}

export async function openPathInFileManager(path: string): Promise<void> {
  if (!isTauri() || !window.__TAURI__?.core) {
    throw new Error("tauri_unavailable:open_path_in_file_manager");
  }
  const trimmedPath = path.trim();
  if (trimmedPath === "") {
    throw new Error("path_empty");
  }
  await window.__TAURI__!.core!.invoke("open_path_in_file_manager", {
    path: trimmedPath,
  });
}

export async function openLocalLlmDialog(): Promise<string | null> {
  if (!isTauri() || !window.__TAURI__?.dialog) return null;
  try {
    const result = await window.__TAURI__!.dialog!.open({
      directory: false,
      multiple: false,
      filters: [
        { name: "Local LLM model files", extensions: ["gguf", "bin", "safetensors"] },
        { name: "All files", extensions: ["*"] },
      ],
    });
    if (result == null) return null;
    return typeof result === "string" ? result : result[0] ?? null;
  } catch {
    return null;
  }
}

export async function openLocalLlmDirectoryDialog(): Promise<string | null> {
  if (!isTauri() || !window.__TAURI__?.dialog) return null;
  try {
    const result = await window.__TAURI__!.dialog!.open({
      directory: true,
      multiple: false,
    });
    if (result == null) return null;
    return typeof result === "string" ? result : result[0] ?? null;
  } catch {
    return null;
  }
}

export function getSavedLocalLlmPath(): string | null {
  if (typeof localStorage === "undefined") return null;
  try {
    const value = localStorage.getItem(LOCAL_LLM_PATH_STORAGE_KEY)?.trim();
    return value && value.length > 0 ? value : null;
  } catch {
    return null;
  }
}

export function setSavedLocalLlmPath(path: string | null): void {
  if (typeof localStorage === "undefined") return;
  try {
    const value = path?.trim() ?? "";
    if (value !== "") {
      localStorage.setItem(LOCAL_LLM_PATH_STORAGE_KEY, value);
    } else {
      localStorage.removeItem(LOCAL_LLM_PATH_STORAGE_KEY);
    }
  } catch {
    /**/
  }
}

export function isTauri(): boolean {
  return typeof window !== "undefined" && !!window.__TAURI__?.core;
}

export async function getAgentsMetadataJson(): Promise<string> {
  if (isTauri() && window.__TAURI__?.core) {
    try {
      const s = (await window.__TAURI__!.core!.invoke("get_agents_metadata_json")) as string;
      if (typeof s === "string" && s.trim().length > 0) {
        return s;
      }
    } catch (InError) {
      const errorText =
        InError instanceof Error ? InError.message : String(InError ?? "unknown_tauri_error");
      throw new Error(`agents_metadata_load_failed_tauri_localappdata:${errorText}`);
    }
    throw new Error("agents_metadata_load_failed_tauri_localappdata:empty_response");
  }
  const fallbackDoc = await loadAgentsMetadataDocument();
  if (fallbackDoc.agents.length > 0) {
    return JSON.stringify(fallbackDoc);
  }
  throw new Error("agents_metadata_load_failed");
}

export async function readAgentsMetadataBundled(): Promise<string> {
  if (!isTauri() || !window.__TAURI__?.core) {
    throw new Error("tauri_unavailable:read_agents_metadata_bundled");
  }
  const s = (await window.__TAURI__!.core!.invoke("read_agents_metadata_bundled")) as string;
  if (typeof s !== "string") {
    throw new Error("agents_metadata_bundled_invalid");
  }
  return s;
}

export async function saveAgentsMetadataBundled(content: string): Promise<void> {
  if (!isTauri() || !window.__TAURI__?.core) {
    throw new Error("tauri_unavailable:save_agents_metadata_bundled");
  }
  await window.__TAURI__!.core!.invoke("save_agents_metadata_bundled", { content });
}

export async function removeAgentUserArtifacts(InParams: {
  agentId: string;
  promptKey: string;
  characterFilename?: string | null;
}): Promise<void> {
  if (!isTauri() || !window.__TAURI__?.core) {
    throw new Error("tauri_unavailable:remove_agent_user_artifacts");
  }
  const characterFilename =
    InParams.characterFilename != null && String(InParams.characterFilename).trim() !== ""
      ? String(InParams.characterFilename).trim()
      : null;
  await window.__TAURI__!.core!.invoke("remove_agent_user_artifacts", {
    agentId: InParams.agentId,
    promptKey: InParams.promptKey,
    characterFilename,
  });
}

export async function getAgentsMetadataUserPath(): Promise<string> {
  if (!isTauri() || !window.__TAURI__?.core) {
    throw new Error("tauri_unavailable:get_agents_metadata_user_path");
  }
  const s = (await window.__TAURI__!.core!.invoke("get_agents_metadata_user_path")) as string;
  if (typeof s !== "string" || s.trim() === "") {
    throw new Error("agents_metadata_user_path_invalid");
  }
  return s.trim();
}

export async function getPromptsUserDir(): Promise<string> {
  if (!isTauri() || !window.__TAURI__?.core) {
    throw new Error("tauri_unavailable:get_prompts_user_dir");
  }
  const s = (await window.__TAURI__!.core!.invoke("get_prompts_user_dir")) as string;
  if (typeof s !== "string" || s.trim() === "") {
    throw new Error("prompts_user_dir_invalid");
  }
  return s.trim();
}

export async function readPromptFileByKey(promptKey: string): Promise<string> {
  const key = promptKey.trim();
  if (key === "") throw new Error("prompt_key_empty");
  const bundled = getBundledPromptTextByKeySync(key).trim();
  const bundledDocJson =
    bundled !== ""
      ? JSON.stringify(
          {
            description: "",
            content: bundled.split("\n"),
          },
          null,
          2,
        )
      : "";
  if (!isTauri() || !window.__TAURI__?.core) {
    if (bundledDocJson !== "") return bundledDocJson;
    throw new Error("tauri_unavailable:read_prompt_file_by_key");
  }
  try {
    const s = (await window.__TAURI__!.core!.invoke("read_prompt_file_by_key", { promptKey: key })) as string;
    if (typeof s === "string" && s.trim() !== "") return s;
  } catch {
    /**/
  }
  if (bundledDocJson !== "") return bundledDocJson;
  throw new Error(`prompt_file_missing:${key}`);
}

export async function savePromptFileByKey(promptKey: string, content: string): Promise<void> {
  if (!isTauri() || !window.__TAURI__?.core) {
    throw new Error("tauri_unavailable:save_prompt_file_by_key");
  }
  const key = promptKey.trim();
  if (key === "") throw new Error("prompt_key_empty");
  await window.__TAURI__!.core!.invoke("save_prompt_file_by_key", { promptKey: key, content });
}

export async function listPromptKeys(): Promise<string[]> {
  if (!isTauri() || !window.__TAURI__?.core) {
    throw new Error("tauri_unavailable:list_prompt_keys");
  }
  const raw = (await window.__TAURI__!.core!.invoke("list_prompt_keys")) as string;
  if (typeof raw !== "string" || raw.trim() === "") return [];
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((x): x is string => typeof x === "string");
  } catch {
    return [];
  }
}

export async function readAgentCharacterFile(filename: string): Promise<string> {
  if (!isTauri() || !window.__TAURI__?.core) {
    throw new Error("tauri_unavailable:read_agent_character_file");
  }
  const trimmed = filename.trim();
  if (trimmed === "") throw new Error("agent_character_filename_empty");
  const s = (await window.__TAURI__!.core!.invoke("read_agent_character_file", {
    filename: trimmed,
  })) as string;
  if (typeof s !== "string" || s.trim() === "") throw new Error("agent_character_empty");
  return s;
}

export async function getAgentCharactersUserDir(): Promise<string> {
  if (!isTauri() || !window.__TAURI__?.core) {
    throw new Error("tauri_unavailable:get_agent_characters_user_dir");
  }
  const s = (await window.__TAURI__!.core!.invoke("get_agent_characters_user_dir")) as string;
  if (typeof s !== "string" || s.trim() === "") throw new Error("agent_characters_dir_invalid");
  return s;
}

export async function saveAgentCharacterFile(filename: string, content: string): Promise<void> {
  if (!isTauri() || !window.__TAURI__?.core) {
    throw new Error("tauri_unavailable:save_agent_character_file");
  }
  const trimmed = filename.trim();
  if (trimmed === "") throw new Error("agent_character_filename_empty");
  await window.__TAURI__!.core!.invoke("save_agent_character_file", {
    filename: trimmed,
    content,
  });
}

export interface RunCliCommandOptions {
  systemPrompt?: string | null;
  cwd?: string | null;
  provider?: CliProvider | null;
  projectName?: string | null;
  localLlmPath?: string | null;
  localLlmBaseUrl?: string | null;
  sessionKey?: string | null;
}

function normalizeCliSessionKeySegment(InValue: string | number | null | undefined): string {
  return String(InValue ?? "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "");
}

export function buildProjectCliSessionKey(
  InProjectName: string | null | undefined,
  InSegments: Array<string | number | null | undefined>,
): string | null {
  const projectSegment = normalizeCliSessionKeySegment(InProjectName);
  const segmentParts = InSegments
    .map((value) => normalizeCliSessionKeySegment(value))
    .filter((value) => value !== "");
  const parts = ["project", projectSegment, ...segmentParts].filter((value) => value !== "");
  if (parts.length <= 1) return null;
  return parts.join(":");
}

async function resolveCliCommandCwd(
  InOptions?: RunCliCommandOptions | null,
): Promise<string | null> {
  const explicitCwd = String(InOptions?.cwd ?? "").trim();
  if (explicitCwd !== "") return explicitCwd;
  const projectName = normalizeWorkspaceProjectKey(InOptions?.projectName);
  if (projectName == null) return null;
  return resolveProjectWorkspacePath(projectName);
}

export async function invokeTauriCore<T>(
  InCommand: string,
  InArgs?: Record<string, unknown>,
): Promise<T> {
  if (!isTauri() || !window.__TAURI__?.core) {
    throw new Error(`tauri_unavailable:${InCommand}`);
  }
  try {
    return await (window.__TAURI__!.core!.invoke(InCommand, InArgs) as Promise<T>);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error ?? "unknown_tauri_error");
    throw new Error(`tauri_invoke_failed:${InCommand}:${message}`);
  }
}

export function getSavedCliProvider(): CliProvider | null {
  if (typeof localStorage === "undefined") return DEFAULT_CLI_PROVIDER;
  try {
    const v = localStorage.getItem(CLI_PROVIDER_STORAGE_KEY)?.toLowerCase();
    if (v === "gemini" || v === "codex" || v === "claude" || v === "local_llm") return v as CliProvider;
    return DEFAULT_CLI_PROVIDER;
  } catch {
    return DEFAULT_CLI_PROVIDER;
  }
}

export function setSavedCliProvider(provider: CliProvider): void {
  try {
    localStorage.setItem(CLI_PROVIDER_STORAGE_KEY, provider);
  } catch {
    /**/
  }
}

export function getSavedLocalLlmBaseUrl(): string | null {
  if (typeof localStorage === "undefined") return null;
  try {
    const v = localStorage.getItem(LOCAL_LLM_BASE_URL_STORAGE_KEY)?.trim();
    return v && v.length > 0 ? v : null;
  } catch {
    return null;
  }
}

export function setSavedLocalLlmBaseUrl(InBaseUrl: string | null): void {
  try {
    if (InBaseUrl == null || InBaseUrl.trim() === "") {
      localStorage.removeItem(LOCAL_LLM_BASE_URL_STORAGE_KEY);
      return;
    }
    localStorage.setItem(LOCAL_LLM_BASE_URL_STORAGE_KEY, InBaseUrl.trim());
  } catch {
    /**/
  }
}

export async function runCliCommand(
  instruction: string,
  options?: RunCliCommandOptions | null,
  label?: string,
): Promise<CliRunResult | null> {
  void label;
  if (!isTauri() || !instruction.trim()) return null;
  const provider = options?.provider ?? getSavedCliProvider() ?? DEFAULT_CLI_PROVIDER;
  const localLlmPath = options?.localLlmPath ?? getSavedLocalLlmPath();
  const localLlmBaseUrl = options?.localLlmBaseUrl ?? getSavedLocalLlmBaseUrl();
  const resolvedCwd = await resolveCliCommandCwd(options);
  
  try {
    const out = await invokeTauriCore<CliRunResult>("omni_cli_run_command", {
      instruction: instruction.trim(),
      cwd: resolvedCwd,
      systemPrompt: options?.systemPrompt ?? null,
      providerOverride: provider ?? null,
      localLlmPath: localLlmPath ?? null,
      localLlmBaseUrl: localLlmBaseUrl ?? null,
      sessionKey: options?.sessionKey ?? null,
    });
    return out as CliRunResult;
  } catch (e) {
    const message =
      e instanceof Error ? e.message : typeof e === "string" ? e : "CLI invoke failed";
    return {
      stdout: "",
      stderr: message,
      exit_code: -1,
      provider: provider ?? "unknown",
    };
  }
}

const WORKSPACE_COMMAND_TIMEOUT_MS = 120_000; // 120 seconds

export async function runWorkspaceCommand(
  InCommand: string,
  InCwd?: string | null,
): Promise<CliRunResult | null> {
  if (!isTauri() || !InCommand.trim()) return null;
  try {
    const invokePromise = window.__TAURI__!.core!.invoke("run_workspace_command", {
      inCommand: InCommand.trim(),
      inCwd: InCwd ?? null,
    });
    const timeoutPromise = new Promise<never>((_, reject) =>
      setTimeout(() => reject(new Error(`Workspace command timed out after ${WORKSPACE_COMMAND_TIMEOUT_MS / 1000}s: ${InCommand.trim().slice(0, 80)}`)), WORKSPACE_COMMAND_TIMEOUT_MS),
    );
    const out = await Promise.race([invokePromise, timeoutPromise]);
    return out as CliRunResult;
  } catch (e) {
    const message =
      e instanceof Error ? e.message : typeof e === "string" ? e : "Workspace command invoke failed";
    return {
      stdout: "",
      stderr: message,
      exit_code: -1,
      provider: "workspace_cmd",
    };
  }
}

export async function getCliWhich(): Promise<CliWhichResult | null> {
  if (!isTauri()) return null;
  try {
    return await invokeTauriCore<CliWhichResult>("omni_cli_which");
  } catch {
    return null;
  }
}

export async function listLocalLlmModels(): Promise<LocalLlmCandidate[]> {
  if (!isTauri()) return [];
  const out = await invokeTauriCore<unknown>("list_local_llm_models");
  if (!Array.isArray(out)) {
    throw new Error("Local LLM discovery returned an unexpected response.");
  }
  return out
    .map((item): LocalLlmCandidate | null => {
      if (item == null || typeof item !== "object") return null;
      const value = item as Record<string, unknown>;
      const path = typeof value.path === "string" ? value.path.trim() : "";
      const name = typeof value.name === "string" ? value.name.trim() : "";
      const kind = typeof value.kind === "string" ? value.kind.trim() : "";
      const sizeBytes = typeof value.sizeBytes === "number" ? value.sizeBytes : 0;
      if (path === "" || name === "") return null;
      return { path, name, kind: kind || "model", sizeBytes };
    })
    .filter((item): item is LocalLlmCandidate => item != null);
}

export async function localPathExists(InPath: string | null | undefined): Promise<boolean> {
  if (!isTauri()) return false;
  const path = String(InPath ?? "").trim();
  if (path === "") return false;
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

export async function getWorkspacePath(InProjectId: string | null): Promise<string | null> {
  if (!isTauri()) return null;
  try {
    return await invokeTauriCore<string>("omni_cli_workspace_path", {
      projectId: InProjectId ?? null,
    });
  } catch {
    return null;
  }
}

export async function resolveProjectWorkspacePath(
  InProjectId: string | null,
): Promise<string | null> {
  return getExecutionWorkspacePath(InProjectId);
}

function sanitizeArtifactWorkspaceSlug(InGoalText: string): string {
  const cleaned = String(InGoalText ?? "")
    .replace(/\s+/g, "_")
    .replace(/[\\/:*?"<>|]+/g, "_")
    .replace(/\p{Cc}+/gu, "_")
    .replace(/\.+/g, "_")
    .replace(/_+/g, "_")
    .replace(/^_+|_+$/g, "");
  return (cleaned || "artifact").slice(0, 32);
}

function joinWorkspacePath(InRootPath: string, InChildName: string): string {
  return `${InRootPath.replace(/[\\/]+$/g, "")}/${InChildName}`;
}

function buildArtifactWorkspacePath(InRootPath: string, InGoalText: string): string {
  return joinWorkspacePath(
    InRootPath,
    `daacs-artifact-${Date.now()}-${sanitizeArtifactWorkspaceSlug(InGoalText)}`,
  );
}

function encodeUtf8Base64(InText: string): string {
  return btoa(unescape(encodeURIComponent(InText)));
}

async function prepareArtifactWorkspaceWithHostCommandFallback(
  InRootPath: string,
  InGoalText: string,
): Promise<string | null> {
  const childPath = buildArtifactWorkspacePath(InRootPath, InGoalText);
  const encodedChildPath = encodeUtf8Base64(childPath);
  const command =
    `node -e "const fs=require('fs');` +
    `const p=Buffer.from('${encodedChildPath}','base64').toString('utf8');` +
    `fs.mkdirSync(p,{recursive:true});process.stdout.write(p);"`;
  const result = await runWorkspaceCommand(command, InRootPath);
  if (result == null) return null;
  if (result.exit_code !== 0) return null;
  return childPath;
}

async function prepareArtifactWorkspaceWithFsFallback(
  InRootPath: string,
  InGoalText: string,
): Promise<string | null> {
  const info = await stat(InRootPath);
  if (!info.isDirectory) return null;
  const childPath = buildArtifactWorkspacePath(InRootPath, InGoalText);
  await mkdir(childPath, { recursive: true });
  return childPath;
}

export async function prepareArtifactWorkspace(
  InRootPath: string,
  InGoalText: string,
): Promise<string | null> {
  if (!isTauri() || !window.__TAURI__?.core) return null;
  const rootPath = InRootPath.trim();
  if (rootPath === "") return null;
  let primaryError: unknown = null;
  try {
    const result = await invokeTauriCore<string>("prepare_artifact_workspace", {
      rootPath,
      goalText: InGoalText,
    });
    return typeof result === "string" && result.trim() !== "" ? result : null;
  } catch (error) {
    primaryError = error;
  }
  let hostCommandError: unknown = null;
  try {
    return await prepareArtifactWorkspaceWithHostCommandFallback(rootPath, InGoalText);
  } catch (error) {
    hostCommandError = error;
  }
  try {
    return await prepareArtifactWorkspaceWithFsFallback(rootPath, InGoalText);
  } catch (fsFallbackError) {
    console.warn("prepareArtifactWorkspace failed", {
      primaryError,
      hostCommandError,
      fsFallbackError,
    });
    return null;
  }
}

export async function prepareAgentWorkspaces(
  InRootPath: string,
  InAgentIds: string[],
): Promise<Record<string, string> | null> {
  if (!isTauri() || !window.__TAURI__?.core) return null;
  const rootPath = InRootPath.trim();
  if (rootPath === "") return null;
  const agentIds = InAgentIds
    .map((value) => String(value ?? "").trim().toLowerCase())
    .filter((value, index, array) => value !== "" && array.indexOf(value) === index);
  if (agentIds.length === 0) return {};
  try {
    const result = await invokeTauriCore<Record<string, string>>("prepare_agent_workspaces", {
      rootPath,
      agentIds,
    });
    if (!result || typeof result !== "object") return null;
    return result;
  } catch {
    return null;
  }
}

export async function stopActiveCliCommands(): Promise<Record<string, unknown> | null> {
  if (!isTauri() || !window.__TAURI__?.core) return null;
  try {
    const result = await invokeTauriCore<Record<string, unknown>>("stop_active_cli_commands");
    if (!result || typeof result !== "object") return null;
    return result;
  } catch {
    return null;
  }
}

export async function saveLocalOfficeState(
  projectId: string,
  snapshot: unknown,
): Promise<boolean> {
  if (!isTauri() || !window.__TAURI__?.core) return false;
  try {
    await window.__TAURI__!.core!.invoke("save_local_office_state", {
      projectId: projectId.trim(),
      snapshotJson: JSON.stringify(snapshot),
    });
    return true;
  } catch {
    return false;
  }
}

export async function loadLocalOfficeState<T>(projectId: string): Promise<T | null> {
  if (!isTauri() || !window.__TAURI__?.core) return null;
  try {
    const out = await window.__TAURI__!.core!.invoke("load_local_office_state", {
      projectId: projectId.trim(),
    });
    if (typeof out !== "string" || out.trim().length === 0) return null;
    return JSON.parse(out) as T;
  } catch {
    return null;
  }
}

export async function clearLocalOfficeState(projectId: string): Promise<boolean> {
  if (!isTauri() || !window.__TAURI__?.core) return false;
  try {
    await window.__TAURI__!.core!.invoke("clear_local_office_state", {
      projectId: projectId.trim(),
    });
    return true;
  } catch {
    return false;
  }
}

export async function saveGlobalOfficeState(snapshot: unknown): Promise<boolean> {
  if (!isTauri() || !window.__TAURI__?.core) return false;
  try {
    await window.__TAURI__!.core!.invoke("save_global_office_state", {
      snapshotJson: JSON.stringify(snapshot),
    });
    return true;
  } catch {
    return false;
  }
}

export async function loadGlobalOfficeState<T>(): Promise<T | null> {
  if (!isTauri() || !window.__TAURI__?.core) return null;
  try {
    const out = await window.__TAURI__!.core!.invoke("load_global_office_state");
    if (typeof out !== "string" || out.trim().length === 0) return null;
    return JSON.parse(out) as T;
  } catch {
    return null;
  }
}

let omniCliPrewarmPromise: Promise<void> | null = null;

export async function prewarmOmniCli(): Promise<void> {
  if (!isTauri()) return;
  if (omniCliPrewarmPromise) return omniCliPrewarmPromise;
  omniCliPrewarmPromise = (async () => {
    try {
      await window.__TAURI__!.core!.invoke("omni_cli_initialize_local");
    } catch {
      /**/
    }
  })();
  return omniCliPrewarmPromise;
}

const FALLBACK_SYSTEM_PROMPT =
  "You are an expert assistant. Execute the user's instruction precisely.";

function normalizePromptFallbackRole(InRole: AgentPromptRole): string {
  const normalized = (InRole ?? "").trim().toLowerCase();
  if (normalized === "developer_front") return "frontend";
  if (normalized === "developer_back") return "backend";
  return normalized === "" ? "agent" : normalized;
}

function getBundledPromptFallbackKeyForRole(InRole: AgentPromptRole): string {
  const normalized = normalizePromptFallbackRole(InRole);
  const metadataRole =
    resolveAgentIdForOfficeRoleSync(normalized)?.trim() ||
    findAgentMetadataByIdSync(normalized)?.id?.trim() ||
    normalized;
  const metadataEntry =
    findAgentMetadataByIdSync(metadataRole) ?? findAgentMetadataByIdSync(normalized);
  const metadataPromptKey = metadataEntry?.prompt_key?.trim() ?? "";
  if (metadataPromptKey !== "") return metadataPromptKey;
  switch (metadataRole) {
    case "pm":
      return "agent_pm";
    case "frontend":
      return "agent_frontend";
    case "backend":
      return "agent_backend";
    case "reviewer":
      return "agent_reviewer";
    case "verifier":
      return "agent_verifier";
    default:
      return "";
  }
}

function getBundledPromptFallbackForRole(InRole: AgentPromptRole): string {
  const promptKey = getBundledPromptFallbackKeyForRole(InRole);
  if (promptKey !== "") {
    const bundled = getBundledPromptTextByKeySync(promptKey);
    if (bundled.trim() !== "") return bundled;
  }
  return FALLBACK_SYSTEM_PROMPT;
}

export function getBundledPromptTextByKeySync(InPromptKey: string): string {
  const k = (InPromptKey ?? "").trim();
  if (k === "") return "";
  return DEFAULT_BUNDLED_PROMPT_TEXT_BY_KEY[k] ?? "";
}

export type AgentPromptRole = string;

export function getSequencerRoleKeyForAgentPromptRole(InRole: AgentPromptRole): string {
  const normalized = (InRole ?? "").trim().toLowerCase();
  return normalized === "" ? "agent" : normalized;
}

export function mapTauriCliRoleKeyToAgentPromptRole(InCliRoleKey: string): AgentPromptRole {
  const k = (InCliRoleKey ?? "").trim().toLowerCase();
  return (k === "" ? "agent" : k) as AgentPromptRole;
}

export function getAgentPromptRoleForOfficeRole(InRole: AgentRole): AgentPromptRole {
  const fromMetadata = resolveAgentIdForOfficeRoleSync(InRole);
  if (fromMetadata != null && fromMetadata.trim() !== "") {
    return fromMetadata as AgentPromptRole;
  }
  switch (InRole) {
    case "pm":
      return "pm";
    case "frontend":
    case "developer_front":
      return "frontend";
    case "backend":
    case "developer_back":
      return "backend";
    case "reviewer":
      return "reviewer";
    case "verifier":
      return "verifier";
    default:
      return "agent";
  }
}

export async function getAgentPrompt(InRole: AgentPromptRole): Promise<string> {
  if (!isTauri() || !window.__TAURI__?.core) {
    return getBundledPromptFallbackForRole(InRole);
  }
  try {
    const out = await window.__TAURI__!.core!.invoke("get_agent_prompt", {
      inRole: InRole,
    });
    return typeof out === "string" && out.trim().length > 0
      ? out
      : getBundledPromptFallbackForRole(InRole);
  } catch {
    return getBundledPromptFallbackForRole(InRole);
  }
}

export async function getSkillPromptForRole(role: string): Promise<string> {
  if (!isTauri() || !window.__TAURI__?.core) return "";
  try {
    const out = await window.__TAURI__!.core!.invoke("get_skill_prompt_for_role", {
      role: role.trim(),
    });
    return typeof out === "string" ? out : "";
  } catch {
    return "";
  }
}

export async function getSkillPromptForCustom(
  role: string,
  skillIds: string[],
): Promise<string> {
  if (!isTauri() || !window.__TAURI__?.core) return "";
  try {
    const out = await window.__TAURI__!.core!.invoke("get_skill_prompt_for_custom", {
      role: role.trim(),
      skillIds,
    });
    return typeof out === "string" ? out : "";
  } catch {
    return "";
  }
}

export async function getSkillBundleSummary(): Promise<SkillBundleSummary> {
  if (!isTauri() || !window.__TAURI__?.core) return {};
  try {
    const out = await window.__TAURI__!.core!.invoke("get_skill_bundle_summary");
    return typeof out === "string" ? (JSON.parse(out) as SkillBundleSummary) : {};
  } catch {
    return {};
  }
}

export async function getSkillCatalog(): Promise<SkillMeta[]> {
  if (!isTauri() || !window.__TAURI__?.core) return [];
  try {
    const out = await window.__TAURI__!.core!.invoke("get_skill_catalog");
    return typeof out === "string" ? (JSON.parse(out) as SkillMeta[]) : [];
  } catch {
    return [];
  }
}

export async function getAvailableSkillIds(): Promise<string[]> {
  if (!isTauri() || !window.__TAURI__?.core) return [];
  try {
    const out = await window.__TAURI__!.core!.invoke("get_available_skill_ids");
    return typeof out === "string" ? (JSON.parse(out) as string[]) : [];
  } catch {
    return [];
  }
}

export type SequencerStatus = "pending" | "in_progress" | "done";

export interface SequencerItem {
  number: number;
  title: string;
  description: string;
  status: SequencerStatus;
}

export interface SequencerTodoList {
  main_task_name: string;
  project_name: string;
  channel_id: string;
  items: SequencerItem[];
}

export async function getPromptingSequencerSystemPrompt(
  InProjectName: string,
  InChannelId: string,
): Promise<string> {
  if (!isTauri() || !window.__TAURI__?.core) return "";
  try {
    const out = await window.__TAURI__!.core!.invoke("prompting_sequencer_system_prompt_command", {
      projectName: InProjectName,
      channelId: InChannelId,
    });
    return typeof out === "string" ? out : "";
  } catch {
    return "";
  }
}

function HashFnv1aHex(InValue: string): string {
  const v = InValue ?? "";
  let hash = 0x811c9dc5;
  for (let i = 0; i < v.length; i++) {
    hash ^= v.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash.toString(16);
}

export function getPromptingSequencerChannelId(InRoleKey: string): string {
  const key = (InRoleKey ?? "").trim().toLowerCase();
  if (!key) return HashFnv1aHex("unknown");
  return HashFnv1aHex(key);
}

function DefaultSequencerRoleKeyForOfficeRole(InOfficeRole: AgentRole): string | null {
  const role = String(InOfficeRole ?? "").trim().toLowerCase();
  if (role === "pm") return "pm";
  if (role === "frontend" || role === "developer_front") return "frontend";
  if (role === "backend" || role === "developer_back") return "backend";
  if (role === "reviewer") return "reviewer";
  if (role === "verifier") return "verifier";
  return null;
}

export async function getPromptingSequencerRoleKeyByOfficeRole(
  InOfficeRole: AgentRole,
): Promise<string | null> {
  const role = String(InOfficeRole ?? "").trim().toLowerCase();
  if (role === "") return null;
  const document = await loadAgentsMetadataDocument();
  const metadataRoleKey =
    document.agents.find((entry) => entry.office_role === role)?.id ?? null;
  if (metadataRoleKey != null && metadataRoleKey.trim() !== "") return metadataRoleKey;
  return DefaultSequencerRoleKeyForOfficeRole(InOfficeRole);
}

export async function getPromptingSequencerChannelIdByOfficeRole(
  InOfficeRole: AgentRole,
): Promise<string | null> {
  const roleKey = await getPromptingSequencerRoleKeyByOfficeRole(InOfficeRole);
  if (roleKey == null || roleKey.trim() === "") return null;
  return getPromptingSequencerChannelId(roleKey);
}

export async function getAgentPromptByPromptKey(InPromptKey: string): Promise<string> {
  const key = (InPromptKey ?? "").trim();
  if (key === "") return "";
  if (!isTauri() || !window.__TAURI__?.core) {
    return getBundledPromptTextByKeySync(key);
  }
  try {
    const out = await window.__TAURI__!.core!.invoke("get_agent_prompt_by_prompt_key", {
      promptKey: key,
    });
    if (typeof out === "string" && out.trim().length > 0) return out;
    return getBundledPromptTextByKeySync(key);
  } catch {
    return getBundledPromptTextByKeySync(key);
  }
}

export async function saveFactoryAgentToResources(InPayload: {
  agentId: string;
  displayName: string;
  summary: string;
  promptText: string;
  skillBundleRefs: string[];
  officeRole?: string | null;
  skillBundleRole?: string | null;
  characterFilename?: string | null;
}): Promise<{ ok: boolean; promptKey?: string; agentId?: string }> {
  if (!isTauri() || !window.__TAURI__?.core) return { ok: false };
  try {
    const out = (await window.__TAURI__!.core!.invoke("save_factory_agent", {
      agentId: InPayload.agentId,
      displayName: InPayload.displayName,
      summary: InPayload.summary,
      promptText: InPayload.promptText,
      skillBundleRefs: InPayload.skillBundleRefs,
      officeRole: InPayload.officeRole ?? null,
      skillBundleRole: InPayload.skillBundleRole ?? null,
      character: InPayload.characterFilename ?? null,
    })) as Record<string, unknown> | null;
    if (out == null || out.ok !== true) return { ok: false };
    const promptKey = typeof out.promptKey === "string" ? out.promptKey : undefined;
    const agentId = typeof out.agentId === "string" ? out.agentId : undefined;
    return { ok: true, promptKey, agentId };
  } catch {
    return { ok: false };
  }
}

export async function buildRosterDelegationSystemPrompt(
  InProjectName: string,
  InPromptRole: AgentPromptRole,
  InAgentsMetadataJson: string,
  InOptions?: {
    sequencerStepSuffix?: string | null;
    promptKey?: string | null;
    skillBundleRole?: string | null;
    skillBundleRefs?: string[] | null;
    injectRequestedSkillRefs?: string[] | null;
    omitRoster?: boolean;
  } | null,
): Promise<string | null> {
  const project = (InProjectName ?? "").trim();
  if (project === "") return null;
  const channelId = getPromptingSequencerChannelId(getSequencerRoleKeyForAgentPromptRole(InPromptRole));
  const stepSeq = await getPromptingSequencerSystemPrompt(project, channelId);
  if (stepSeq == null || stepSeq.trim() === "") return null;
  const pk =
    InOptions?.promptKey != null && String(InOptions.promptKey).trim() !== ""
      ? String(InOptions.promptKey).trim()
      : "";
  let agentPrompt = "";
  if (pk !== "") {
    agentPrompt = (await getAgentPromptByPromptKey(pk)).trim();
  }
  if (agentPrompt === "") {
    agentPrompt = await getAgentPrompt(InPromptRole);
  }
  const skillRefs = (InOptions?.skillBundleRefs ?? [])
    .map((v) => String(v ?? "").trim())
    .filter((v) => v !== "");
  const requestedRefs = (InOptions?.injectRequestedSkillRefs ?? [])
    .map((v) => String(v ?? "").trim())
    .filter((v) => v !== "");
  const allowedRefSet = new Set(skillRefs);
  const filteredRequestedRefs = [...new Set(requestedRefs.filter((v) => allowedRefSet.has(v)))];
  let skillPrompt = "";
  if (filteredRequestedRefs.length > 0) {
    skillPrompt = (await getSkillPromptForCustom(InPromptRole, filteredRequestedRefs)).trim();
  }
  const roster = (InAgentsMetadataJson ?? "").trim();
  const rosterBlock = InOptions?.omitRoster === true 
    ? "## Agent roster (Resources/Agents/agents_metadata.json)\n(Omitted for this step)" 
    : `## Agent roster (Resources/Agents/agents_metadata.json)\n${roster}`;
    
  const delegation =
    InOptions?.sequencerStepSuffix != null && String(InOptions.sequencerStepSuffix).trim() !== ""
      ? String(InOptions.sequencerStepSuffix).trim()
      : "Execute the assigned command in your reply (concrete work, files, or verification). Do not reply with only [SEQUENCER_PLAN]. When you must delegate to other roster agents, output exactly one [AGENT_COMMANDS] block after your main output. Use only agent ids from the roster.";
  const skillGuide =
    skillRefs.length > 0
      ? `## Available skills\n${skillRefs.map((v, i) => `${i + 1}. ${v}`).join("\n")}\n\nIf you need skill details, request with [SKILL_REQUEST]skillA,skillB[/SKILL_REQUEST]. You may request again in later steps when needed, but do not re-request already injected skills.`
      : "## Available skills\n(no mapped skills)";
  let skillInjectionNote = "";
  if (requestedRefs.length > 0) {
    if (filteredRequestedRefs.length > 0) {
      skillInjectionNote = `\n\n## Skills injected this turn\n${filteredRequestedRefs.map((v, i) => `${i + 1}. ${v}`).join("\n")}`;
    } else {
      skillInjectionNote = `\n\n## Skill request not applied\nRequested: ${requestedRefs.join(", ")} — none match this agent's Available skills list; use only ids listed above or update agents metadata.`;
    }
  }
  const skillBlock = skillPrompt !== "" ? `\n\n---\n\n${skillPrompt}` : "";
  return `${stepSeq}\n\n${agentPrompt}\n\n---\n\n${skillGuide}${skillInjectionNote}${skillBlock}\n\n---\n\n${rosterBlock}\n\n---\n\n${delegation}`;
}

export function parseSkillRequest(InText: string): string[] {
  const text = String(InText ?? "");
  if (text.trim() === "") return [];
  const match = text.match(/\[SKILL_REQUEST\]([\s\S]*?)\[\/SKILL_REQUEST\]/i);
  if (match?.[1] == null) return [];
  return match[1]
    .split(",")
    .map((v) => v.trim())
    .filter((v) => v !== "");
}

export function PartitionSkillRequestByBundle(
  InBundleRefs: string[] | null | undefined,
  InRequested: string[],
): { injected: string[]; dropped: string[] } {
  const allowed = new Set(
    (InBundleRefs ?? [])
      .map((v) => String(v ?? "").trim())
      .filter((v) => v !== ""),
  );
  const injected: string[] = [];
  const dropped: string[] = [];
  for (const raw of InRequested) {
    const key = String(raw ?? "").trim();
    if (key === "") continue;
    if (allowed.has(key)) injected.push(key);
    else dropped.push(key);
  }
  return { injected, dropped };
}

export async function savePromptingSequencerTodo(
  InProjectName: string,
  InTodo: SequencerTodoList,
): Promise<boolean> {
  if (!isTauri() || !window.__TAURI__?.core) return false;
  try {
    await window.__TAURI__!.core!.invoke("prompting_sequencer_save_todo_command", {
      projectName: InProjectName,
      todoJson: JSON.stringify(InTodo),
    });
    return true;
  } catch {
    return false;
  }
}

export async function loadPromptingSequencerTodo(
  InProjectName: string,
  InChannelId: string,
): Promise<SequencerTodoList | null> {
  if (!isTauri() || !window.__TAURI__?.core) return null;
  try {
    const out = await window.__TAURI__!.core!.invoke("prompting_sequencer_load_todo_command", {
      projectName: InProjectName,
      channelId: InChannelId,
    });
    if (!out) return null;
    return out as SequencerTodoList;
  } catch {
    return null;
  }
}

export async function clearPromptingSequencerChannel(
  InProjectName: string,
  InChannelId: string,
): Promise<boolean> {
  if (!isTauri() || !window.__TAURI__?.core) return false;
  try {
    await window.__TAURI__!.core!.invoke("prompting_sequencer_clear_channel_command", {
      projectName: InProjectName,
      channelId: InChannelId,
    });
    return true;
  } catch {
    return false;
  }
}

export async function markPromptingSequencerItemDone(
  InProjectName: string,
  InChannelId: string,
  InNumber: number,
): Promise<SequencerTodoList | null> {
  if (!isTauri() || !window.__TAURI__?.core) return null;
  try {
    const out = await window.__TAURI__!.core!.invoke("prompting_sequencer_mark_done_command", {
      projectName: InProjectName,
      channelId: InChannelId,
      itemNumber: InNumber,
    });
    if (!out) return null;
    return out as SequencerTodoList;
  } catch {
    return null;
  }
}

export async function extractPromptingSequencerCommands(InStdout: string): Promise<string[]> {
  if (!isTauri() || !window.__TAURI__?.core) return [];
  const raw = (InStdout ?? "").trim();
  if (raw === "") return [];
  try {
    const out = await window.__TAURI__!.core!.invoke("prompting_sequencer_extract_commands_command", {
      inStdout: raw,
    });
    if (!Array.isArray(out)) return [];
    const list: string[] = [];
    for (const v of out) {
      if (typeof v !== "string") continue;
      const item = v.trim();
      if (item === "") continue;
      list.push(item);
    }
    return list;
  } catch {
    return [];
  }
}

export async function runPmCliCommand(
  InInstruction: string,
  InOptions?: RunCliCommandOptions | null,
): Promise<CliRunResult | null> {
  let systemPrompt = InOptions?.systemPrompt ?? null;
  if (systemPrompt == null && InOptions?.projectName != null) {
    const channelId = getPromptingSequencerChannelId("pm");
    const seq = await getPromptingSequencerSystemPrompt(InOptions.projectName, channelId);
    if (seq) systemPrompt = seq;
  }
  if (systemPrompt == null) systemPrompt = await getAgentPrompt("pm");
  return runCliCommand(InInstruction, {
    ...InOptions,
    systemPrompt,
  });
}

function buildMissingImplementationAgentResult(InOfficeRole: AgentRole): CliRunResult {
  const officeRole = String(InOfficeRole ?? "").trim() || "implementation";
  return {
    stdout: "",
    stderr: `no user-created implementation agent for office role "${officeRole}". Create a roster agent for this role before running implementation work.`,
    exit_code: 1,
    provider: "daacs",
  };
}

export async function runFrontendCliCommand(
  InInstruction: string,
  InOptions?: RunCliCommandOptions | null,
): Promise<CliRunResult | null> {
  const roleKey = await getPromptingSequencerRoleKeyByOfficeRole("frontend");
  if (roleKey == null || roleKey.trim() === "") {
    return buildMissingImplementationAgentResult("frontend");
  }
  let systemPrompt: string | null = InOptions?.systemPrompt ?? null;
  if (systemPrompt == null && InOptions?.projectName != null) {
    const channelId = getPromptingSequencerChannelId(roleKey);
    const seq = await getPromptingSequencerSystemPrompt(InOptions.projectName, channelId);
    if (seq) systemPrompt = seq;
  }
  if (systemPrompt == null) systemPrompt = await getAgentPrompt(roleKey);
  return runCliCommand(InInstruction, {
    ...InOptions,
    systemPrompt,
  });
}

export async function runBackendCliCommand(
  InInstruction: string,
  InOptions?: RunCliCommandOptions | null,
): Promise<CliRunResult | null> {
  const roleKey = await getPromptingSequencerRoleKeyByOfficeRole("backend");
  if (roleKey == null || roleKey.trim() === "") {
    return buildMissingImplementationAgentResult("backend");
  }
  let systemPrompt: string | null = InOptions?.systemPrompt ?? null;
  if (InOptions?.projectName != null) {
    const channelId = getPromptingSequencerChannelId(roleKey);
    const seq = await getPromptingSequencerSystemPrompt(InOptions.projectName, channelId);
    if (seq) systemPrompt = seq;
  }
  if (systemPrompt == null) systemPrompt = await getAgentPrompt(roleKey);
  return runCliCommand(InInstruction, {
    ...InOptions,
    systemPrompt,
  });
}

export interface PmTaskLists {
  summary: string;
  roleAssignmentNotes: string[];
  frontend: string[];
  backend: string[];
  reviewer: string[];
  verifier: string[];
  unstructured: string;
}

function normalizePmTaskListField(InValue: unknown): string[] {
  if (!Array.isArray(InValue)) return [];
  return InValue
    .map((item) => String(item ?? "").trim())
    .filter((item) => item !== "" && !/^\(none\)$/i.test(item));
}

function normalizePmTaskLists(InValue: unknown): PmTaskLists {
  const value =
    InValue != null && typeof InValue === "object" && !Array.isArray(InValue)
      ? (InValue as Record<string, unknown>)
      : {};
  const unstructuredRaw = value.unstructured;
  return {
    summary: typeof value.summary === "string" ? value.summary.trim() : "",
    roleAssignmentNotes: normalizePmTaskListField(value.roleAssignmentNotes),
    frontend: normalizePmTaskListField(value.frontend),
    backend: normalizePmTaskListField(value.backend),
    reviewer: normalizePmTaskListField(value.reviewer),
    verifier: normalizePmTaskListField(value.verifier),
    unstructured: typeof unstructuredRaw === "string" ? unstructuredRaw.trim() : "",
  };
}

function parsePmTaskListsLocal(InStdout: string): PmTaskLists {
  const text = (InStdout ?? "").trim();
  const takeList = (marker: string): string[] => {
    const out: string[] = [];
    const idx = text.indexOf(marker);
    if (idx === -1) return out;
    const after = text.slice(idx + marker.length);
    const end = after.search(/\n[A-Z_]+:/);
    const block = end === -1 ? after : after.slice(0, end);
    for (const line of block.split(/\n/)) {
      const m = line.trim().match(/^[-*]\s*(.+)$/);
      if (m && m[1] && !/^\(none\)$/i.test(m[1].trim())) out.push(m[1].trim());
    }
    return out;
  };
  const summary = takeList("PM_SUMMARY:").join(" ").trim();
  const roleAssignmentNotes = takeList("ROLE_ASSIGNMENT_NOTES:");
  const frontend = takeList("FRONTEND_TASKS:");
  const backend = takeList("BACKEND_TASKS:");
  const reviewer = takeList("REVIEWER_TASKS:");
  const verifier = takeList("VERIFIER_TASKS:");
  const hasStructuredTasks =
    frontend.length > 0 || backend.length > 0 || reviewer.length > 0 || verifier.length > 0;
  return {
    summary,
    roleAssignmentNotes,
    frontend,
    backend,
    reviewer,
    verifier,
    unstructured: hasStructuredTasks ? "" : text,
  };
}

export async function parsePmTaskLists(InStdout: string): Promise<PmTaskLists> {
  const fallbackLocal = parsePmTaskListsLocal(InStdout);
  if (isTauri() && window.__TAURI__?.core) {
    try {
      const out = await window.__TAURI__!.core!.invoke("parse_pm_task_lists_command", {
        inStdout: InStdout ?? "",
      });
      const normalized = normalizePmTaskLists(out);
      const hasParsedContent =
        normalized.summary !== "" ||
        normalized.roleAssignmentNotes.length > 0 ||
        normalized.frontend.length > 0 ||
        normalized.backend.length > 0 ||
        normalized.reviewer.length > 0 ||
        normalized.verifier.length > 0 ||
        normalized.unstructured !== "";
      if (!hasParsedContent) {
        return fallbackLocal;
      }
      return {
        ...normalized,
        summary: normalized.summary || fallbackLocal.summary,
        roleAssignmentNotes:
          normalized.roleAssignmentNotes.length > 0
            ? normalized.roleAssignmentNotes
            : fallbackLocal.roleAssignmentNotes,
        unstructured: normalized.unstructured || fallbackLocal.unstructured,
      };
    } catch {
      return fallbackLocal;
    }
  }
  return fallbackLocal;
}

export type RfiStatus = "needs_clarification" | "ready_to_plan";

export interface RfiQuestion {
  topic: string;
  question: string;
}

export interface RfiKnownAnswer {
  topic: string;
  value: string;
}

export interface RfiOutcome {
  status: RfiStatus;
  summary: string;
  questions: RfiQuestion[];
  assumptions: string[];
  refined_goal: string;
}

export async function getRfiSystemPrompt(): Promise<string> {
  if (!isTauri() || !window.__TAURI__?.core) return "";
  try {
    const out = await window.__TAURI__!.core!.invoke("rfi_system_prompt_command");
    return typeof out === "string" ? out : "";
  } catch {
    return "";
  }
}

export async function buildRfiUserPrompt(goal: string, knownAnswers: RfiKnownAnswer[]): Promise<string> {
  if (!isTauri() || !window.__TAURI__?.core) return "";
  try {
    const out = await window.__TAURI__!.core!.invoke("build_rfi_user_prompt_command", {
      goal,
      knownAnswers,
    });
    return typeof out === "string" ? out : "";
  } catch {
    return "";
  }
}

export async function parseRfiOutcome(goal: string, raw: string): Promise<RfiOutcome | null> {
  if (!isTauri() || !window.__TAURI__?.core) return null;
  try {
    const out = await window.__TAURI__!.core!.invoke("parse_rfi_outcome_command", {
      goal,
      raw,
    });
    return out as RfiOutcome;
  } catch {
    return null;
  }
}
