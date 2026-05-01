import type { ProjectConfig } from "@/lib/daacsApi";

export const defaultProjectConfig: ProjectConfig = {
    mode: "prod",
    verification_lane: "full",
    parallel_execution: true,
    force_backend: false,
    orchestrator_model: "gpt-5.1-codex-mini",
    backend_model: "gpt-5.1-codex-max",
    frontend_model: "gpt-5.1-codex-max",
    max_iterations: 10,
    max_failures: 10,
    max_no_progress: 2,
    code_review_min_score: 9,
    allow_low_quality_delivery: false,
    plateau_max_retries: 3,
    enable_release_gate: false,
};
