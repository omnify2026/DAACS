import { STORAGE_KEY_CLI_WORKSPACE, STORAGE_KEY_CLI_PROVIDER, } from "../constants";
export const CLI_WORKSPACE_STORAGE_KEY = STORAGE_KEY_CLI_WORKSPACE;
export const CLI_PROVIDER_STORAGE_KEY = STORAGE_KEY_CLI_PROVIDER;
export function getSavedWorkspacePath() {
    if (typeof localStorage === "undefined")
        return null;
    try {
        const v = localStorage.getItem(CLI_WORKSPACE_STORAGE_KEY)?.trim();
        return v && v.length > 0 ? v : null;
    }
    catch {
        return null;
    }
}
export function setSavedWorkspacePath(InPath) {
    try {
        if (InPath == null || InPath.trim() === "")
            localStorage.removeItem(CLI_WORKSPACE_STORAGE_KEY);
        else
            localStorage.setItem(CLI_WORKSPACE_STORAGE_KEY, InPath.trim());
    }
    catch {
        /**/
    }
}
export async function openWorkspaceDialog() {
    if (!isTauri() || !window.__TAURI__?.dialog)
        return null;
    try {
        const result = await window.__TAURI__.dialog.open({ directory: true, multiple: false });
        if (result == null)
            return null;
        return typeof result === "string" ? result : result[0] ?? null;
    }
    catch {
        return null;
    }
}
export function isTauri() {
    return typeof window !== "undefined" && !!window.__TAURI__?.core;
}
const FALLBACK_AGENTS_METADATA_JSON = '{"schema_version":1,"agents":[{"id":"pm","tauri_cli_role_key":"pm"},{"id":"frontend_developer","tauri_cli_role_key":"frontend"},{"id":"backend_developer","tauri_cli_role_key":"backend"}]}';
export async function getAgentsMetadataJson() {
    if (!isTauri() || !window.__TAURI__?.core)
        return FALLBACK_AGENTS_METADATA_JSON;
    try {
        const s = (await window.__TAURI__.core.invoke("get_agents_metadata_json"));
        if (typeof s === "string" && s.trim().length > 0)
            return s;
    }
    catch {
        /**/
    }
    return FALLBACK_AGENTS_METADATA_JSON;
}
export function getSavedCliProvider() {
    if (typeof localStorage === "undefined")
        return null;
    try {
        const v = localStorage.getItem(CLI_PROVIDER_STORAGE_KEY)?.toLowerCase();
        if (v === "gemini" || v === "codex")
            return v;
        return null;
    }
    catch {
        return null;
    }
}
export function setSavedCliProvider(provider) {
    try {
        localStorage.setItem(CLI_PROVIDER_STORAGE_KEY, provider);
    }
    catch {
        /**/
    }
}
export async function runCliCommand(instruction, options) {
    if (!isTauri() || !instruction.trim())
        return null;
    const provider = options?.provider ?? getSavedCliProvider();
    try {
        const out = await window.__TAURI__.core.invoke("omni_cli_run_command", {
            instruction: instruction.trim(),
            cwd: options?.cwd ?? null,
            systemPrompt: options?.systemPrompt ?? null,
            providerOverride: provider ?? null,
        });
        return out;
    }
    catch (e) {
        const message = e instanceof Error ? e.message : typeof e === "string" ? e : "CLI invoke failed";
        return {
            stdout: "",
            stderr: message,
            exit_code: -1,
            provider: provider ?? "unknown",
        };
    }
}
export async function getCliWhich() {
    if (!isTauri())
        return null;
    try {
        const result = await window.__TAURI__.core.invoke("omni_cli_which");
        return result;
    }
    catch {
        return null;
    }
}
export async function getWorkspacePath(InProjectId) {
    if (!isTauri())
        return null;
    try {
        const path = await window.__TAURI__.core.invoke("omni_cli_workspace_path", {
            projectId: InProjectId ?? null,
        });
        return path;
    }
    catch {
        return null;
    }
}
let omniCliPrewarmPromise = null;
export async function prewarmOmniCli() {
    if (!isTauri())
        return;
    if (omniCliPrewarmPromise)
        return omniCliPrewarmPromise;
    omniCliPrewarmPromise = (async () => {
        try {
            await window.__TAURI__.core.invoke("omni_cli_initialize_local");
        }
        catch {
            /**/
        }
    })();
    return omniCliPrewarmPromise;
}
const FALLBACK_SYSTEM_PROMPT = "You are an expert assistant. Execute the user's instruction precisely.";
export async function getAgentPrompt(InRole) {
    if (!isTauri() || !window.__TAURI__?.core)
        return FALLBACK_SYSTEM_PROMPT;
    try {
        const out = await window.__TAURI__.core.invoke("get_agent_prompt", {
            inRole: InRole,
        });
        return typeof out === "string" && out.trim().length > 0 ? out : FALLBACK_SYSTEM_PROMPT;
    }
    catch {
        return FALLBACK_SYSTEM_PROMPT;
    }
}
export async function getSkillPromptForRole(role) {
    if (!isTauri() || !window.__TAURI__?.core)
        return "";
    try {
        const out = await window.__TAURI__.core.invoke("get_skill_prompt_for_role", {
            role: role.trim(),
        });
        return typeof out === "string" ? out : "";
    }
    catch {
        return "";
    }
}
export async function getSkillPromptForCustom(role, skillIds) {
    if (!isTauri() || !window.__TAURI__?.core)
        return "";
    try {
        const out = await window.__TAURI__.core.invoke("get_skill_prompt_for_custom", {
            role: role.trim(),
            skillIds,
        });
        return typeof out === "string" ? out : "";
    }
    catch {
        return "";
    }
}
export async function getSkillBundleSummary() {
    if (!isTauri() || !window.__TAURI__?.core)
        return {};
    try {
        const out = await window.__TAURI__.core.invoke("get_skill_bundle_summary");
        return typeof out === "string" ? JSON.parse(out) : {};
    }
    catch {
        return {};
    }
}
export async function getSkillCatalog() {
    if (!isTauri() || !window.__TAURI__?.core)
        return [];
    try {
        const out = await window.__TAURI__.core.invoke("get_skill_catalog");
        return typeof out === "string" ? JSON.parse(out) : [];
    }
    catch {
        return [];
    }
}
export async function getAvailableSkillIds() {
    if (!isTauri() || !window.__TAURI__?.core)
        return [];
    try {
        const out = await window.__TAURI__.core.invoke("get_available_skill_ids");
        return typeof out === "string" ? JSON.parse(out) : [];
    }
    catch {
        return [];
    }
}
export async function getPromptingSequencerSystemPrompt(InProjectName, InChannelId) {
    if (!isTauri() || !window.__TAURI__?.core)
        return "";
    try {
        const out = await window.__TAURI__.core.invoke("prompting_sequencer_system_prompt_command", {
            projectName: InProjectName,
            channelId: InChannelId,
        });
        return typeof out === "string" ? out : "";
    }
    catch {
        return "";
    }
}
function HashFnv1aHex(InValue) {
    const v = InValue ?? "";
    let hash = 0x811c9dc5;
    for (let i = 0; i < v.length; i++) {
        hash ^= v.charCodeAt(i);
        hash = Math.imul(hash, 0x01000193) >>> 0;
    }
    return hash.toString(16);
}
export function getPromptingSequencerChannelId(InRoleKey) {
    const key = (InRoleKey ?? "").trim().toLowerCase();
    if (!key)
        return HashFnv1aHex("unknown");
    return HashFnv1aHex(key);
}
export async function savePromptingSequencerTodo(InProjectName, InTodo) {
    if (!isTauri() || !window.__TAURI__?.core)
        return false;
    try {
        await window.__TAURI__.core.invoke("prompting_sequencer_save_todo_command", {
            projectName: InProjectName,
            todoJson: JSON.stringify(InTodo),
        });
        return true;
    }
    catch {
        return false;
    }
}
export async function loadPromptingSequencerTodo(InProjectName, InChannelId) {
    if (!isTauri() || !window.__TAURI__?.core)
        return null;
    try {
        const out = await window.__TAURI__.core.invoke("prompting_sequencer_load_todo_command", {
            projectName: InProjectName,
            channelId: InChannelId,
        });
        if (!out)
            return null;
        return out;
    }
    catch {
        return null;
    }
}
export async function markPromptingSequencerItemDone(InProjectName, InChannelId, InNumber) {
    if (!isTauri() || !window.__TAURI__?.core)
        return null;
    try {
        const out = await window.__TAURI__.core.invoke("prompting_sequencer_mark_done_command", {
            projectName: InProjectName,
            channelId: InChannelId,
            itemNumber: InNumber,
        });
        if (!out)
            return null;
        return out;
    }
    catch {
        return null;
    }
}
export async function runPmCliCommand(InInstruction, InOptions) {
    let systemPrompt = InOptions?.systemPrompt ?? null;
    if (systemPrompt == null && InOptions?.projectName != null) {
        const channelId = getPromptingSequencerChannelId("pm");
        const seq = await getPromptingSequencerSystemPrompt(InOptions.projectName, channelId);
        if (seq)
            systemPrompt = seq;
    }
    if (systemPrompt == null)
        systemPrompt = await getAgentPrompt("pm");
    return runCliCommand(InInstruction, {
        ...InOptions,
        systemPrompt,
    });
}
export async function runFrontendCliCommand(InInstruction, InOptions) {
    let systemPrompt = null;
    if (systemPrompt == null && InOptions?.projectName != null) {
        const channelId = getPromptingSequencerChannelId("front");
        const seq = await getPromptingSequencerSystemPrompt(InOptions.projectName, channelId);
        if (seq)
            systemPrompt = seq;
    }
    if (systemPrompt == null)
        systemPrompt = await getAgentPrompt("frontend");
    return runCliCommand(InInstruction, {
        ...InOptions,
        systemPrompt,
    });
}
export async function runBackendCliCommand(InInstruction, InOptions) {
    let systemPrompt = null;
    if (InOptions?.projectName != null) {
        const channelId = getPromptingSequencerChannelId("back");
        const seq = await getPromptingSequencerSystemPrompt(InOptions.projectName, channelId);
        if (seq)
            systemPrompt = seq;
    }
    if (systemPrompt == null)
        systemPrompt = await getAgentPrompt("backend");
    return runCliCommand(InInstruction, {
        ...InOptions,
        systemPrompt,
    });
}
function parsePmTaskListsLocal(InStdout) {
    const text = (InStdout ?? "").trim();
    const takeList = (marker) => {
        const out = [];
        const idx = text.indexOf(marker);
        if (idx === -1)
            return out;
        const after = text.slice(idx + marker.length);
        const end = after.search(/\n[A-Z_]+:/);
        const block = end === -1 ? after : after.slice(0, end);
        for (const line of block.split(/\n/)) {
            const m = line.trim().match(/^[-*]\s*(.+)$/);
            if (m && m[1] && !/^\(none\)$/i.test(m[1].trim()))
                out.push(m[1].trim());
        }
        return out;
    };
    const frontend = takeList("FRONTEND_TASKS:");
    const backend = takeList("BACKEND_TASKS:");
    return {
        frontend: frontend.length ? frontend : [text || "(no tasks)"],
        backend: backend.length ? backend : [text || "(no tasks)"],
    };
}
export async function parsePmTaskLists(InStdout) {
    if (isTauri() && window.__TAURI__?.core) {
        try {
            const out = await window.__TAURI__.core.invoke("parse_pm_task_lists_command", {
                inStdout: InStdout ?? "",
            });
            return out;
        }
        catch {
            return parsePmTaskListsLocal(InStdout);
        }
    }
    return parsePmTaskListsLocal(InStdout);
}
