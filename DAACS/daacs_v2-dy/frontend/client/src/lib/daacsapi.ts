/**
 * DAACS API Client
 * Nova-Canvas에서 DAACS API 서버를 호출하기 위한 클라이언트
 * API/WS 설정은 clientConfig에서 관리됨
 */

import { logError } from "./logger";
import { clientConfig } from "./clientConfig";
import { createReconnectingWebSocket } from "./ws-reconnect";

const API_TIMEOUT = clientConfig.apiTimeoutMs;

function buildApiUrl(path: string): string {
    const base = clientConfig.apiBaseUrl.replace(/\/$/, "");
    if (path.startsWith("http://") || path.startsWith("https://")) {
        return path;
    }
    const normalizedPath = path.startsWith("/") ? path : `/${path}`;
    if (base === "") {
        return normalizedPath;
    }
    return `${base}${normalizedPath}`;
}

function buildWsUrl(path: string): string {
    const base = clientConfig.wsBaseUrl.replace(/\/$/, "");
    if (base.startsWith("ws://") || base.startsWith("wss://")) {
        const normalizedPath = path.startsWith("/") ? path : `/${path}`;
        return `${base}${normalizedPath}`;
    }
    const wsProtocol = window.location.protocol === "https:" ? "wss:" : "ws:";
    const normalizedBase = base.startsWith("/") ? base : `/${base}`;
    const normalizedPath = path.startsWith("/") ? path : `/${path}`;
    return `${wsProtocol}//${window.location.host}${normalizedBase}${normalizedPath}`;
}

/**
 * Fetch with timeout wrapper
 */
async function fetchWithTimeout(
    url: string,
    options: RequestInit = {},
    timeout: number = API_TIMEOUT
): Promise<Response> {
    const controller = new AbortController();
    const id = setTimeout(() => controller.abort(), timeout);

    try {
        const response = await fetch(url, {
            ...options,
            signal: controller.signal
        });
        return response;
    } finally {
        clearTimeout(id);
    }
}

async function parseErrorDetail(response: Response, fallback: string): Promise<string> {
    try {
        const error = await response.json();
        if (error && typeof error.detail === "string") {
            return error.detail;
        }
    } catch {
        // ignore JSON parsing issues
    }
    return fallback;
}

export interface Project {
    id: string;
    goal: string;
    status: "created" | "planning" | "running" | "completed" | "completed_with_warnings" | "failed" | "stopped";
    final_status?: string | null;
    stop_reason?: string | null;
    quality?: ProjectQuality | null;
    code_review_score?: number | null;
    code_review_passed?: boolean | null;
    code_review_critical_issues?: number | string[] | null;
    code_review_goal_aligned?: boolean | null;
    overall_score?: number | null;
    release_gate?: ReleaseGateResult | null;
    api_spec?: Record<string, unknown> | null;
    created_at: string;
    iteration: number;
    needs_backend: boolean;
    needs_frontend: boolean;
    plan: string;
    rfp?: any;
    rfp_data?: {
        goal?: string;
        specs?: Array<{ id: string; type: string; title: string; description: string }>;
        blueprint?: { mermaid_script: string; components: string[] };
    } | null;
    workflow_state?: Record<string, any>;
}

export interface ProjectQuality {
    code_review_score?: number | null;
    code_review_passed?: boolean | null;
    critical_issues?: number | string[] | null;
    goal_aligned?: boolean | null;
    summary?: string | null;
}

export interface ReleaseGateResult {
    status: "pass" | "conditional" | "partial" | "fail";
    auto_ok: boolean;
    fullstack_required: boolean;
    manual_gates: string[];
    results: Record<string, unknown>;
    checked_at?: string;
}

export interface Message {
    id: number | string;
    projectId: string;  // Changed from number to string for consistency
    role: string;
    content: string;
    createdAt: string | null;
}

export interface LogEntry {
    timestamp: string;
    node: string;
    message: string;
    level: string;
}

// Phase 1.5: TechContext types
export interface TechContext {
    facts: string[];
    sources: string[];
    constraints: string[];
    fetched_at?: string;
}

export interface DecisionTrace {
    used_facts: string[];
    ignored_facts: string[];
    assumptions: string[];
    tech_context?: TechContext;
}

// Phase 1.5: Assumptions types
export type Environment = "web" | "desktop" | "mobile";
export type PrimaryFocus = "mvp" | "design" | "stability";

export interface Assumptions {
    environment: Environment;
    primary_focus: PrimaryFocus;
    options: Record<string, boolean>;
}

export interface AssumptionDelta {
    removed: string[];
    added: string[];
    modified: Array<[string, string]>;
}

export interface ProjectFiles {
    backend_files: string[];
    frontend_files: string[];
}

export interface ProjectConfig {
    mode?: "test" | "prod";
    verification_lane?: "fast" | "full";
    parallel_execution?: boolean;
    force_backend?: boolean;
    orchestrator_model?: string;
    backend_model?: string;
    frontend_model?: string;
    max_iterations?: number;
    max_failures?: number;  // 연속 실패 최대 횟수
    max_no_progress?: number;
    code_review_min_score?: number;
    allow_low_quality_delivery?: boolean;
    plateau_max_retries?: number;
    enable_quality_gates?: boolean;  // 🆕 Quality Gates (ruff/mypy/bandit 등) 활성화
    enable_release_gate?: boolean;  // 🆕 Release Gate (post-build checks) toggle
}

export interface CreateProjectOptions {
    goal: string;
    config?: ProjectConfig;
    source_path?: string;  // 기존 폴더 경로
    source_git?: string;   // Git 레포 URL
}

export interface ProjectSyncRequest {
    source_path?: string;
    source_git?: string;
    goal?: string;
    run_enhance?: boolean;
}

export interface ProjectEnhanceRequest {
    goal?: string;
    patch_only?: boolean;
    patch_targets?: string[];
    use_current_output?: boolean;
}

export async function runReleaseGate(projectId: string, scaffoldE2E = false): Promise<ReleaseGateResult> {
    const query = scaffoldE2E ? "?scaffold_e2e=true" : "";
    const response = await fetchWithTimeout(buildApiUrl(`/projects/${projectId}/release-gate${query}`), {
        method: "POST",
    });

    if (!response.ok) {
        const detail = await parseErrorDetail(response, "Failed to run release gate");
        throw new Error(detail);
    }

    return response.json();
}

// 프로젝트 생성
export async function createProject(
    goal: string,
    config?: ProjectConfig,
    source_path?: string,
    source_git?: string
): Promise<Project> {
    const response = await fetchWithTimeout(buildApiUrl("/projects"), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ goal, config, source_path, source_git }),
    });

    if (!response.ok) {
        const detail = await parseErrorDetail(response, "Failed to create project");
        throw new Error(detail);
    }

    return response.json();
}

// 프로젝트 소스 동기화
export async function syncProject(projectId: string, req: ProjectSyncRequest): Promise<{ status: string; enhance?: string }> {
    const response = await fetchWithTimeout(buildApiUrl(`/projects/${projectId}/sync`), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(req),
    });
    if (!response.ok) {
        const detail = await parseErrorDetail(response, "Failed to sync project");
        throw new Error(detail);
    }
    return response.json();
}

// 프로젝트 고도화 실행
export async function enhanceProject(projectId: string, req?: ProjectEnhanceRequest): Promise<{ status: string }> {
    const response = await fetchWithTimeout(buildApiUrl(`/projects/${projectId}/enhance`), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(req || {}),
    });
    if (!response.ok) {
        const detail = await parseErrorDetail(response, "Failed to enhance project");
        throw new Error(detail);
    }
    return response.json();
}

// 프로젝트 목록 조회
export async function listProjects(): Promise<Project[]> {
    const response = await fetchWithTimeout(buildApiUrl("/projects"));
    if (!response.ok) {
        const detail = await parseErrorDetail(response, "Failed to fetch projects");
        throw new Error(detail);
    }
    return response.json();
}

// 지원되는 모델 목록 조회
export async function listModels(): Promise<Record<string, any>> {
    const response = await fetchWithTimeout(buildApiUrl("/models"));
    if (!response.ok) {
        const detail = await parseErrorDetail(response, "Failed to fetch models");
        throw new Error(detail);
    }
    return response.json();
}

// 프로젝트 상태 조회
export async function getProject(projectId: string): Promise<Project> {
    const response = await fetchWithTimeout(buildApiUrl(`/projects/${projectId}`));
    if (!response.ok) {
        const detail = await parseErrorDetail(response, "Failed to fetch project");
        throw new Error(detail);
    }
    return response.json();
}

// 프로젝트 메시지 조회
export async function getProjectMessages(projectId: string): Promise<Message[]> {
    const response = await fetchWithTimeout(buildApiUrl(`/projects/${projectId}/messages`));
    if (!response.ok) {
        const detail = await parseErrorDetail(response, "Failed to fetch messages");
        throw new Error(detail);
    }
    return response.json();
}

// 사용자 입력 전송 (DAACS 입력 큐로 전달)
export async function sendProjectInput(projectId: string, text: string): Promise<void> {
    const response = await fetchWithTimeout(buildApiUrl(`/projects/${projectId}/input`), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ text }),
    });
    if (!response.ok) {
        const detail = await parseErrorDetail(response, "Failed to send input");
        throw new Error(detail);
    }
}

// 프로젝트 로그 조회
export async function getProjectLogs(projectId: string): Promise<LogEntry[]> {
    const response = await fetchWithTimeout(buildApiUrl(`/projects/${projectId}/logs`));
    if (!response.ok) {
        const detail = await parseErrorDetail(response, "Failed to fetch logs");
        throw new Error(detail);
    }
    return response.json();
}

// 프로젝트 파일 목록 조회
export async function getProjectFiles(projectId: string): Promise<ProjectFiles> {
    const response = await fetchWithTimeout(buildApiUrl(`/projects/${projectId}/files`));
    if (!response.ok) {
        const detail = await parseErrorDetail(response, "Failed to fetch files");
        throw new Error(detail);
    }
    return response.json();
}

// 파일 내용 조회
export async function getFileContent(projectId: string, file: string, type: "backend" | "frontend"): Promise<string> {
    const response = await fetchWithTimeout(buildApiUrl(`/projects/${projectId}/files/content?file=${encodeURIComponent(file)}&type=${type}`));
    if (!response.ok) {
        const detail = await parseErrorDetail(response, "Failed to fetch file content");
        throw new Error(detail);
    }
    const data = await response.json();
    return data.content;
}

// 프로젝트 중지
export async function stopProject(projectId: string): Promise<void> {
    const response = await fetchWithTimeout(buildApiUrl(`/projects/${projectId}/stop`), {
        method: "POST",
    });
    if (!response.ok) {
        const detail = await parseErrorDetail(response, "Failed to stop project");
        throw new Error(detail);
    }
}

// 프로젝트 삭제
export async function deleteProject(projectId: string): Promise<void> {
    const response = await fetchWithTimeout(buildApiUrl(`/projects/${projectId}`), {
        method: "DELETE",
    });
    if (!response.ok) {
        const detail = await parseErrorDetail(response, "Failed to delete project");
        throw new Error(detail);
    }
}

// ==================== 프로젝트 실행 API ====================

export interface RunStatus {
    backend: { running: boolean; port: number | null };
    frontend: { running: boolean; port: number | null; entry?: string };
}

export interface RunResult {
    backend_port: number | null;
    frontend_port: number | null;
    frontend_entry?: string;
    status: string;
}

// 프로젝트 실행
export async function runProject(projectId: string): Promise<RunResult> {
    const response = await fetchWithTimeout(buildApiUrl(`/projects/${projectId}/run`), {
        method: "POST",
    });
    if (!response.ok) {
        const detail = await parseErrorDetail(response, "Failed to run project");
        throw new Error(detail);
    }
    return response.json();
}

// 프로젝트 실행 상태 조회
export async function getRunStatus(projectId: string): Promise<RunStatus> {
    const response = await fetchWithTimeout(buildApiUrl(`/projects/${projectId}/run/status`));
    if (!response.ok) {
        const detail = await parseErrorDetail(response, "Failed to get run status");
        throw new Error(detail);
    }
    return response.json();
}

// 프로젝트 실행 중지
export async function stopRun(projectId: string): Promise<void> {
    const response = await fetchWithTimeout(buildApiUrl(`/projects/${projectId}/run/stop`), {
        method: "POST",
    });
    if (!response.ok) {
        const detail = await parseErrorDetail(response, "Failed to stop run");
        throw new Error(detail);
    }
}

// 🆕 피드백 제출 (빌드 완료 후)
export interface FeedbackResult {
    action: "refine" | "complete";
    new_goal?: string;
    message?: string;
}

export async function submitFeedback(projectId: string, feedback: string): Promise<FeedbackResult> {
    const response = await fetchWithTimeout(buildApiUrl(`/projects/${projectId}/feedback`), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ feedback }),
    });
    if (!response.ok) {
        const detail = await parseErrorDetail(response, "Failed to submit feedback");
        throw new Error(detail);
    }
    return response.json();
}

// WebSocket 로그 스트리밍 연결 (with auto-reconnection)
export function connectToLogs(
    projectId: string,
    onLog: (log: LogEntry) => void,
    onError?: (error: Event) => void,
    onReconnect?: () => void
): { ws: WebSocket; disconnect: () => void } {
    const url = buildWsUrl(`/projects/${projectId}/logs`);

    let ws: WebSocket;
    let reconnectAttempts = 0;
    let reconnectTimeout: ReturnType<typeof setTimeout> | null = null;
    let shouldReconnect = true;
    const maxReconnectAttempts = 10;
    const baseDelay = 1000; // 1 second

    function connect() {
        ws = new WebSocket(url);

        ws.onopen = () => {
            reconnectAttempts = 0; // Reset on successful connection
            if (onReconnect && reconnectAttempts > 0) {
                onReconnect();
            }
        };

        ws.onmessage = (event) => {
            try {
                const log = JSON.parse(event.data);
                onLog(log);
            } catch (e) {
                logError("Failed to parse log:", e);
            }
        };

        ws.onerror = (error) => {
            logError("WebSocket error:", error);
            if (onError) onError(error);
        };

        ws.onclose = () => {
            if (shouldReconnect && reconnectAttempts < maxReconnectAttempts) {
                const delay = Math.min(baseDelay * Math.pow(2, reconnectAttempts), 30000);
                reconnectAttempts++;
                console.log(`[WebSocket] Reconnecting in ${delay}ms (attempt ${reconnectAttempts}/${maxReconnectAttempts})...`);
                reconnectTimeout = setTimeout(connect, delay);
            }
        };
    }

    connect();

    return {
        get ws() { return ws; },
        disconnect: () => {
            shouldReconnect = false;
            if (reconnectTimeout) clearTimeout(reconnectTimeout);
            ws.close();
        }
    };
}

// 파일 내용 업데이트 (저장)
export async function updateFileContent(
    projectId: string,
    file: string,
    type: "backend" | "frontend",
    content: string
): Promise<void> {
    const response = await fetchWithTimeout(buildApiUrl(`/projects/${projectId}/files?file=${encodeURIComponent(file)}&type=${type}`), {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ content }),
    });
    if (!response.ok) {
        const detail = await parseErrorDetail(response, "Failed to update file");
        throw new Error(detail);
    }
}

// 프로젝트 다운로드 (ZIP)
export async function downloadProject(projectId: string): Promise<void> {
    const response = await fetchWithTimeout(buildApiUrl(`/projects/${projectId}/download`));
    if (!response.ok) {
        const detail = await parseErrorDetail(response, "Failed to download project");
        throw new Error(detail);
    }

    // Blob으로 다운로드
    const blob = await response.blob();
    const url = window.URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `project_${projectId}.zip`;
    document.body.appendChild(a);
    a.click();
    window.URL.revokeObjectURL(url);
    document.body.removeChild(a);
}

// Phase 1.5: Apply assumption changes and trigger re-plan
export async function applyAssumptions(projectId: string, delta: AssumptionDelta): Promise<{ status: string }> {
    const response = await fetchWithTimeout(buildApiUrl(`/projects/${projectId}/apply_assumptions`), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(delta),
    });
    if (!response.ok) {
        const detail = await parseErrorDetail(response, "Failed to apply assumptions");
        throw new Error(detail);
    }
    return response.json();
}


// ==================== Plan API (Nova-Canvas 통합) ====================

export interface RequirementsPlan {
    project_overview?: {
        title?: string;
        summary?: string;
        target_users?: string;
        core_value?: string;
        design_direction?: string;
    };
    functional_requirements?: Array<{
        id: string;
        category: string;
        title: string;
        description: string;
        priority: string;
    }>;
    technical_requirements?: {
        frontend?: string[];
        backend?: string[];
        database?: string;
        external_apis?: string[];
    };
    tech_context?: {
        facts: string[];
        sources: string[];
        constraints: string[];
    };
    assumptions?: {
        environment: string;
        primary_focus: string;
        options: Record<string, boolean>;
    };
    architecture?: {
        diagram_mermaid?: string;
        description?: string;
    };
    dependency_graph?: {
        nodes: Array<{ id: string; label: string; type: string }>;
        edges: Array<{ source: string; target: string }>;
    };
    api_specification?: Array<{
        id: string;
        method: string;
        path: string;
        description: string;
        request_body?: Record<string, string>;
        response_body?: Record<string, string>;
        related_fr?: string;
    }>;
    constraints?: string[];
    acceptance_criteria?: string[];
    // Fallback fields for unstructured response
    plan?: string;
    response?: string;
    analysis?: string;
}

export interface ClarificationQuestion {
    id: string;
    category: string;
    question: string;
    options: string[];
    default?: string;
}

export interface PlanResponse {
    requirements_plan: RequirementsPlan;
    plan_status: string;
    needs_clarification: boolean;
    clarification_questions: ClarificationQuestion[];
    clarification_answers: Record<string, string>;
}

// 계획서 조회
export async function getProjectPlan(projectId: string): Promise<PlanResponse> {
    const response = await fetchWithTimeout(buildApiUrl(`/projects/${projectId}/plan`));
    if (!response.ok) {
        const detail = await parseErrorDetail(response, "Failed to fetch plan");
        throw new Error(detail);
    }
    return response.json();
}

// 계획 확정 또는 수정 요청
export async function confirmPlan(
    projectId: string,
    confirmed: boolean,
    feedback?: string,
    assumptions?: { environment: string; primary_focus: string; options: Record<string, boolean> }
): Promise<{ status: string; message: string }> {
    const response = await fetchWithTimeout(buildApiUrl(`/projects/${projectId}/confirm_plan`), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ confirmed, feedback, assumptions }),
    });
    if (!response.ok) {
        const detail = await parseErrorDetail(response, "Failed to confirm plan");
        throw new Error(detail);
    }
    return response.json();
}

// Clarification 답변 제출
export async function submitClarification(projectId: string, answers: Record<string, string>): Promise<{ status: string; message: string }> {
    const response = await fetchWithTimeout(buildApiUrl(`/projects/${projectId}/clarify`), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ answers }),
    });
    if (!response.ok) {
        const detail = await parseErrorDetail(response, "Failed to submit clarification");
        throw new Error(detail);
    }
    return response.json();
}


// ==================== Chat History API ====================

export interface ChatHistoryResponse {
    ui_messages: Array<{ role: "user" | "pm"; content: string }>;
    tech_messages: Array<{ role: "user" | "pm"; content: string }>;
}

export async function getChatHistory(projectId: string): Promise<ChatHistoryResponse> {
    const response = await fetchWithTimeout(buildApiUrl(`/projects/${projectId}/chat-history`));
    if (!response.ok) {
        // 히스토리가 없으면 빈 객체 반환
        if (response.status === 404) {
            return { ui_messages: [], tech_messages: [] };
        }
        const detail = await parseErrorDetail(response, "Failed to get chat history");
        throw new Error(detail);
    }
    return response.json();
}


// ==================== RFI WebSocket API ====================

export interface RfiMessage {
    type: "gemini" | "status" | "rfp_complete" | "suggest_proceed" | "error";
    content: string | Record<string, unknown>;
}

export function connectToRfi(
    projectId: string,
    onMessage: (msg: RfiMessage) => void
): WebSocket {
    const url = buildWsUrl(`/projects/${projectId}/rfi`);
    const ws = new WebSocket(url);

    ws.onmessage = (event) => {
        try {
            const data = JSON.parse(event.data);
            onMessage(data);
        } catch {
            onMessage({ type: "error", content: event.data });
        }
    };

    ws.onerror = (error) => {
        logError("RFI WebSocket error:", error);
    };

    return ws;
}

// RFI 메시지 전송
export function sendRfiMessage(ws: WebSocket, message: string): void {
    ws.send(JSON.stringify({ message }));
}

// RFI 완료 후 계획 생성 요청
export async function completeRfi(projectId: string): Promise<{ status: string; message: string }> {
    const response = await fetchWithTimeout(buildApiUrl(`/projects/${projectId}/rfi/complete`), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
    });
    if (!response.ok) {
        const detail = await parseErrorDetail(response, "Failed to complete RFI");
        throw new Error(detail);
    }
    return response.json();
}


// ==================== 듀얼 PM RFI API (Dual PM Chat) ====================

export interface DualRfiMessage {
    type: "pm" | "sufficiency" | "error";
    role: "ui" | "tech";
    content?: string;
    sufficient?: boolean;
    reason?: string;
}

export interface DualRfiStatus {
    active: boolean;
    ui_connected: boolean;
    tech_connected: boolean;
    ui_sufficient: boolean;
    tech_sufficient: boolean;
    ui_message_count?: number;
    tech_message_count?: number;
}

export interface MergeRfiResult {
    status: "success" | "insufficient";
    rfp?: Record<string, unknown>;
    message: string;
    ui_sufficient?: boolean;
    tech_sufficient?: boolean;
}

/**
 * 🎨 UI PM WebSocket 연결 with automatic reconnection
 */
export function connectToUiRfi(
    projectId: string,
    onMessage: (msg: DualRfiMessage) => void
): { ws: WebSocket; disconnect: () => void } {
    const url = buildWsUrl(`/projects/${projectId}/rfi/ui`);
    return createReconnectingWebSocket(url, onMessage);
}

/**
 * ⚙️ Tech Lead WebSocket 연결 with automatic reconnection
 */
export function connectToTechRfi(
    projectId: string,
    onMessage: (msg: DualRfiMessage) => void
): { ws: WebSocket; disconnect: () => void } {
    const url = buildWsUrl(`/projects/${projectId}/rfi/tech`);
    return createReconnectingWebSocket(url, onMessage);
}

/**
 * 듀얼 RFI 세션 상태 조회
 */
export async function getDualRfiStatus(projectId: string): Promise<DualRfiStatus> {
    const response = await fetchWithTimeout(buildApiUrl(`/projects/${projectId}/rfi/status`));
    if (!response.ok) {
        const detail = await parseErrorDetail(response, "Failed to get dual RFI status");
        throw new Error(detail);
    }
    return response.json();
}

/**
 * 두 PM 대화 통합하여 RFP 생성
 * @param force true면 충분성 체크 무시 (강제 진행)
 */
export async function mergeDualRfi(projectId: string, force: boolean = false): Promise<MergeRfiResult> {
    const response = await fetchWithTimeout(buildApiUrl(`/projects/${projectId}/rfi/merge?force=${force}`), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
    });
    if (!response.ok) {
        const detail = await parseErrorDetail(response, "Failed to merge dual RFI");
        throw new Error(detail);
    }
    return response.json();
}


// ==================== Analysis API ====================

export async function analyzeProject(projectId: string): Promise<Record<string, unknown>> {
    const response = await fetchWithTimeout(buildApiUrl(`/projects/${projectId}/analyze`), {
        method: "POST",
    });
    if (!response.ok) {
        const detail = await parseErrorDetail(response, "Failed to analyze project");
        throw new Error(detail);
    }
    return response.json();
}

export async function suggestImprovements(projectId: string): Promise<Record<string, unknown>> {
    const response = await fetchWithTimeout(buildApiUrl(`/projects/${projectId}/suggest-improvements`));
    if (!response.ok) {
        const detail = await parseErrorDetail(response, "Failed to suggest improvements");
        throw new Error(detail);
    }
    return response.json();
}

export async function semanticCheck(projectId: string): Promise<Record<string, unknown>> {
    const response = await fetchWithTimeout(buildApiUrl(`/projects/${projectId}/semantic-check`), {
        method: "POST",
    });
    if (!response.ok) {
        const detail = await parseErrorDetail(response, "Failed to run semantic check");
        throw new Error(detail);
    }
    return response.json();
}

export async function runtimeTest(projectId: string, testType: "backend" | "frontend" = "backend"): Promise<Record<string, unknown>> {
    const response = await fetchWithTimeout(buildApiUrl(`/projects/${projectId}/runtime-test?test_type=${testType}`), {
        method: "POST",
    });
    if (!response.ok) {
        const detail = await parseErrorDetail(response, "Failed to run runtime test");
        throw new Error(detail);
    }
    return response.json();
}

export async function performanceBaseline(projectId: string): Promise<Record<string, unknown>> {
    const response = await fetchWithTimeout(buildApiUrl(`/projects/${projectId}/performance-baseline`));
    if (!response.ok) {
        const detail = await parseErrorDetail(response, "Failed to fetch performance baseline");
        throw new Error(detail);
    }
    return response.json();
}


// ==================== Git API ====================

export async function gitAnalyze(projectId: string): Promise<Record<string, unknown>> {
    const response = await fetchWithTimeout(buildApiUrl(`/projects/${projectId}/git/analyze`));
    if (!response.ok) {
        const detail = await parseErrorDetail(response, "Failed to analyze git repository");
        throw new Error(detail);
    }
    return response.json();
}

export async function gitBranches(projectId: string): Promise<Record<string, unknown>> {
    const response = await fetchWithTimeout(buildApiUrl(`/projects/${projectId}/git/branches`));
    if (!response.ok) {
        const detail = await parseErrorDetail(response, "Failed to fetch git branches");
        throw new Error(detail);
    }
    return response.json();
}

export async function gitCreateBranch(projectId: string, name: string, baseBranch?: string): Promise<Record<string, unknown>> {
    const response = await fetchWithTimeout(buildApiUrl(`/projects/${projectId}/git/branches`), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name, base_branch: baseBranch }),
    });
    if (!response.ok) {
        const detail = await parseErrorDetail(response, "Failed to create git branch");
        throw new Error(detail);
    }
    return response.json();
}

export async function gitChanges(projectId: string, staged: boolean = false): Promise<Record<string, unknown>> {
    const response = await fetchWithTimeout(buildApiUrl(`/projects/${projectId}/git/changes?staged=${staged}`));
    if (!response.ok) {
        const detail = await parseErrorDetail(response, "Failed to fetch git changes");
        throw new Error(detail);
    }
    return response.json();
}

export async function gitCommit(
    projectId: string,
    message?: string,
    autoMessage: boolean = true,
    push: boolean = false
): Promise<Record<string, unknown>> {
    const response = await fetchWithTimeout(buildApiUrl(`/projects/${projectId}/git/commit`), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ message, auto_message: autoMessage, push }),
    });
    if (!response.ok) {
        const detail = await parseErrorDetail(response, "Failed to create git commit");
        throw new Error(detail);
    }
    return response.json();
}

export async function gitPush(projectId: string): Promise<Record<string, unknown>> {
    const response = await fetchWithTimeout(buildApiUrl(`/projects/${projectId}/git/push`), {
        method: "POST",
    });
    if (!response.ok) {
        const detail = await parseErrorDetail(response, "Failed to push git branch");
        throw new Error(detail);
    }
    return response.json();
}

export async function gitPrDraft(projectId: string): Promise<Record<string, unknown>> {
    const response = await fetchWithTimeout(buildApiUrl(`/projects/${projectId}/git/pr-draft`));
    if (!response.ok) {
        const detail = await parseErrorDetail(response, "Failed to generate PR draft");
        throw new Error(detail);
    }
    return response.json();
}

export async function gitQuickCommit(projectId: string, message?: string): Promise<Record<string, unknown>> {
    const response = await fetchWithTimeout(buildApiUrl(`/projects/${projectId}/git/quick-commit${message ? `?message=${encodeURIComponent(message)}` : ""}`), {
        method: "POST",
    });
    if (!response.ok) {
        const detail = await parseErrorDetail(response, "Failed to run quick commit");
        throw new Error(detail);
    }
    return response.json();
}
