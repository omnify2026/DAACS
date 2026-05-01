from typing import TypedDict, List, Dict, Any, Optional, Annotated
from operator import add

from ..config import MAX_STATE_LOG_LINES

def merge_lists(a: List[str], b: List[str]) -> List[str]:
    """리스트 병합 (None 처리 포함)"""
    merged = (a or []) + (b or [])
    if MAX_STATE_LOG_LINES > 0 and len(merged) > MAX_STATE_LOG_LINES:
        return merged[-MAX_STATE_LOG_LINES:]
    return merged

class DAACSState(TypedDict, total=False):
    """DAACS 워크플로우 상태"""
    
    # === Core ===
    current_goal: str
    project_dir: str
    project_id: str
    code_fingerprint: str
    last_code_fingerprint: str
    backend_code_fingerprint: str
    frontend_code_fingerprint: str
    verification_lane: str
    
    # === RFI & Context (From DAACSOrchestrator) ===
    tech_context: Dict[str, Any]  # RFI로 수집된 기술 스택 정보
    assumptions: Dict[str, Any]   # 사용자 가정 및 제약조건
    
    # === LLM Sources ===
    llm_sources: Dict[str, str]  # {"orchestrator": "gemini", "backend": "codex", ...}
    
    # === Models ===
    orchestrator_model: str
    backend_model: str
    frontend_model: str
    code_review_model: str
    delivery_model: str
    
    # === Orchestrator Planning ===
    orchestrator_plan: str
    api_spec: Dict[str, Any]
    api_spec_valid: bool
    api_spec_issues: List[str]
    api_spec_required: bool
    required_features: List[Dict]
    success_criteria: List[str]
    quality_requirements: Dict[str, List[str]]
    backend_instructions: str
    frontend_instructions: str
    auto_spec: Dict[str, Any]
    needs_backend: bool
    needs_frontend: bool
    force_backend: bool
    
    # === Backend ===
    backend_files: Dict[str, str]
    backend_status: str  # "working", "completed", "failed"
    backend_needs_rework: bool
    backend_logs: Annotated[List[str], merge_lists]
    backend_verification_details: List[Dict]
    backend_subgraph_iterations: int
    backend_cli_continuing: bool
    backend_no_progress_count: int
    backend_file_hashes: Dict[str, str]
    
    # === Frontend ===
    frontend_files: Dict[str, str]
    frontend_status: str
    frontend_needs_rework: bool
    frontend_logs: Annotated[List[str], merge_lists]
    frontend_verification_details: List[Dict]
    frontend_subgraph_iterations: int
    frontend_cli_continuing: bool
    frontend_entrypoint_missing: bool
    frontend_smoke_failed: bool
    frontend_verification_ok: bool
    frontend_no_progress_count: int
    frontend_file_hashes: Dict[str, str]
    
    # === Runtime Verification ===
    runtime_verification_passed: bool
    runtime_issues: List[str]
    
    # === Judgment ===
    orchestrator_judgment: str
    compatibility_verified: bool
    compatibility_issues: List[str]
    endpoint_analysis: Dict[str, Any]
    recommendations: List[str]

    # === Quality Gates ===
    code_review: Dict[str, Any]
    code_review_ready: bool
    code_review_passed: bool
    code_review_score: int
    code_review_min_score: int
    quality_gate_failed: bool
    consistency_passed: bool
    allow_low_quality_delivery: bool
    plateau_max_retries: int
    best_effort_delivery: bool
    hard_failure: bool
    last_failure_signature: str
    failure_repeat_count: int
    replan_guidance: str
    prefer_patch: bool
    patch_targets: List[str]
    generation_stage: Optional[str]
    is_recovery_mode: bool
    
    # === Rework ===
    needs_rework: bool
    failure_type: Optional[str]
    failure_summary: List[str]
    consecutive_failures: int
    main_cycle_count: int
    stop_reason: Optional[str]
    final_status: Optional[str]
    
    # === Config ===
    max_iterations: int
    max_subgraph_iterations: int
    max_failures: int
    current_phase: str
