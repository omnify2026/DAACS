"""
DAACS OS — Workflow State Definition
LangGraph StateGraph에서 사용하는 공유 상태.

Source: DAACS_v2-dy/daacs/models/daacs_state.py (100+ fields → 핵심만 추출)
"""
import operator
from typing import Annotated, Any, Dict, List, Optional, TypedDict


def _merge_lists(a: List, b: List) -> List:
    """리스트 병합 (최대 200줄 유지)."""
    merged = (a or []) + (b or [])
    if len(merged) > 200:
        return merged[-200:]
    return merged


class WorkflowState(TypedDict, total=False):
    """
    워크플로우 실행 중 공유되는 전체 상태.

    LangGraph StateGraph의 state_schema로 사용됨.
    각 노드는 이 상태의 일부를 읽고 업데이트한다.
    """

    # ─── Core ───
    project_id: str
    current_goal: str
    project_dir: str
    workflow_name: str

    # ─── Planning ───
    orchestrator_plan: str
    needs_backend: bool
    needs_frontend: bool
    api_spec: Dict[str, Any]
    tech_stack: Dict[str, Any]
    active_roles: Annotated[List[str], _merge_lists]
    orchestration_policy: Dict[str, Any]
    qa_profile: str
    acceptance_criteria: List[str]
    evidence_required: List[str]

    # ─── Execution ───
    backend_files: Dict[str, str]   # path → code content
    frontend_files: Dict[str, str]
    backend_status: str             # pending | in_progress | completed | failed
    frontend_status: str
    backend_iteration: int
    frontend_iteration: int

    # ─── Review ───
    code_review: Dict[str, Any]
    code_review_score: int
    code_review_passed: bool
    consistency_passed: bool
    consistency_issues: Annotated[List[str], _merge_lists]

    # ─── Quality Gate ───
    quality_score: int
    quality_gate_failed: bool

    # ─── Judgment ───
    needs_rework: bool
    failure_summary: Annotated[List[str], _merge_lists]
    stop_reason: Optional[str]
    final_status: Optional[str]     # completed | stopped | needs_rework

    # ─── Replanning ───
    replan_guidance: str
    patch_targets: List[str]
    failure_type: str
    consecutive_failures: int
    last_failure_signature: str
    failure_repeat_count: int

    # ─── Verification ───
    verification_passed: bool
    verification_details: Annotated[List[Dict[str, Any]], _merge_lists]
    verification_failures: Annotated[List[str], _merge_lists]
    verification_evidence: List[Dict[str, Any]]
    verification_gaps: List[str]
    verification_confidence: int

    # ─── Control ───
    iteration: int
    max_iterations: int
    code_fingerprint: str
    overnight_mode: bool
    run_id: str
    gate_results: Annotated[List[Dict[str, Any]], _merge_lists]
    gate_retry_by_gate: Dict[str, int]
    gate_retry_total: int
    spent_usd: float

    # ─── Logging ───
    logs: Annotated[List[str], _merge_lists]
    pending_handoffs: Annotated[List[str], _merge_lists]
    completed_handoffs: Annotated[List[str], _merge_lists]
    handoff_history: Annotated[List[Dict[str, Any]], _merge_lists]
    rework_source: Optional[str]


def create_initial_state(
    project_id: str,
    goal: str,
    project_dir: str,
    workflow_name: str = "feature_development",
    max_iterations: int = 10,
) -> WorkflowState:
    """초기 워크플로우 상태 생성."""
    return WorkflowState(
        project_id=project_id,
        current_goal=goal,
        project_dir=project_dir,
        workflow_name=workflow_name,
        orchestrator_plan="",
        needs_backend=True,
        needs_frontend=True,
        api_spec={},
        tech_stack={},
        active_roles=[],
        orchestration_policy={},
        qa_profile="standard",
        acceptance_criteria=[],
        evidence_required=[],
        backend_files={},
        frontend_files={},
        backend_status="pending",
        frontend_status="pending",
        backend_iteration=0,
        frontend_iteration=0,
        code_review={},
        code_review_score=0,
        code_review_passed=False,
        consistency_passed=True,
        consistency_issues=[],
        quality_score=0,
        quality_gate_failed=False,
        needs_rework=False,
        failure_summary=[],
        stop_reason=None,
        final_status=None,
        replan_guidance="",
        patch_targets=[],
        failure_type="",
        consecutive_failures=0,
        last_failure_signature="",
        failure_repeat_count=0,
        verification_passed=False,
        verification_details=[],
        verification_failures=[],
        verification_evidence=[],
        verification_gaps=[],
        verification_confidence=0,
        iteration=0,
        max_iterations=max_iterations,
        code_fingerprint="",
        overnight_mode=False,
        run_id="",
        gate_results=[],
        gate_retry_by_gate={},
        gate_retry_total=0,
        spent_usd=0.0,
        logs=[],
        pending_handoffs=[],
        completed_handoffs=[],
        handoff_history=[],
        rework_source=None,
    )
