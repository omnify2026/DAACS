from typing import Any, Dict, List, Optional, Tuple, TypedDict

from ..models.daacs_state import DAACSState
from ..config import MIN_CODE_REVIEW_SCORE
from .verification import run_verification
from ..utils import setup_logger
from .orchestrator_helpers import (
    _collect_backend_files,
    _collect_frontend_files,
    _analyze_endpoint_compatibility,
    _validate_goal_achievement,
)

logger = setup_logger("OrchestratorJudgment")

class JudgmentResult(TypedDict, total=False):
    needs_rework: bool
    compatibility_issues: List[str]
    endpoint_analysis: Dict[str, Any]
    goal_validation: Dict[str, Any]
    api_spec_valid: bool
    api_spec_issues: List[str]
    api_spec_required: bool
    quality_gate_failed: bool
    consistency_passed: bool
    frontend_verification_ok: bool
    frontend_entrypoint_missing: bool
    frontend_smoke_failed: bool
    hard_failure: bool
    failure_summary: List[str]
    stop_reason: Optional[str]
    final_status: str


def _get_files(project_dir: str) -> Tuple[List[str], List[str]]:
    """Collect all relevant files"""
    try:
        backend_files = _collect_backend_files(project_dir)
        frontend_files = _collect_frontend_files(project_dir)
        return backend_files, frontend_files
    except Exception as e:
        logger.warning("[Judgment] Error scanning files: %s", e)
        return [], []


def _validate_api_spec(state: DAACSState, fullstack_required: bool) -> Tuple[bool, List[str]]:
    from .enhanced_nodes import api_spec_validation_node
    api_spec_validation = api_spec_validation_node(state)
    valid = api_spec_validation.get("api_spec_valid", True)
    issues = api_spec_validation.get("api_spec_issues", []) or []
    
    if fullstack_required and not valid:
        return False, issues
    return True, issues


def _check_backend_verification(
    state: DAACSState, needs_backend: bool, backend_files: List[str], 
    api_spec: Dict, fullstack_required: bool
) -> Tuple[bool, bool]:
    """Returns (ok, no_progress)"""
    if not needs_backend:
        return True, False

    details = state.get("backend_verification_details", []) or []
    
    if details:
        ok = all(v.get("ok", True) for v in details)
        no_progress = any(
            v.get("template") == "no_progress_guard" and not v.get("ok", True)
            for v in details
        )
        return ok, no_progress

    # Fallback to run_verification if details missing (rare case)
    verification = run_verification(
        action_type="backend",
        files=backend_files,
        api_spec=api_spec,
        fullstack_required=fullstack_required,
    )
    return verification.get("ok", True), False


def _check_frontend_verification(state: DAACSState, needs_frontend: bool) -> Tuple[bool, bool, bool, bool]:
    """Returns (ok, no_progress, entrypoint_missing, smoke_failed)"""
    if not needs_frontend:
        return True, False, False, False

    status = state.get("frontend_status", "completed")
    details = state.get("frontend_verification_details", []) or []
    
    ok = status in {"completed", "skipped"}
    no_progress = False
    
    if details:
        ok = all(v.get("ok", True) for v in details)
        no_progress = any(
            v.get("template") == "no_progress_guard" and not v.get("ok", True)
            for v in details
        )

    # Specific checks
    entrypoint_verdict = next(
        (v for v in details if v.get("template") == "frontend_entrypoint_exists"),
        None
    )
    smoke_verdict = next(
        (v for v in details if v.get("template") == "frontend_smoke_test"),
        None
    )

    entrypoint_missing = bool(entrypoint_verdict and not entrypoint_verdict.get("ok", True))
    smoke_failed = bool(smoke_verdict and not smoke_verdict.get("ok", True))

    return ok, no_progress, entrypoint_missing, smoke_failed


def _check_quality_gate(state: DAACSState, min_score: int) -> Tuple[bool, int, int, bool]:
    """Returns (failed, score, critical_count, aligned)"""
    passed = state.get("code_review_passed", True)
    score = state.get("code_review_score", 0)
    review = state.get("code_review", {}) if isinstance(state.get("code_review"), dict) else {}
    
    critical = [
        i for i in review.get("issues", [])
        if isinstance(i, dict) and i.get("severity") == "critical"
    ]
    critical_count = len(critical)
    aligned = review.get("goal_alignment", {}).get("aligned", True)

    failed = (
        not passed
        or score < min_score
        or critical_count > 0
        or not aligned
    )
    return failed, score, critical_count, aligned


def _build_failure_summary(
    compatibility_issues: List[str],
    backend_ok: bool, backend_stalled: bool,
    frontend_ok: bool, frontend_stalled: bool,
    entry_missing: bool, smoke_failed: bool, smoke_verdict: Optional[Dict],
    goal_achieved: bool, goal_reason: str,
    quality_failed: bool, score: int, min_score: int, critical_count: int, aligned: bool,
    consistency_passed: bool,
    api_spec_valid: bool, api_spec_issues: List[str], api_spec_required: bool,
    backend_details: Optional[List[Dict]] = None,  # 🆕
    frontend_details: Optional[List[Dict]] = None   # 🆕
) -> List[str]:
    summary = []
    if compatibility_issues:
        summary.extend([f"compatibility_issue: {i}" for i in compatibility_issues])
    
    # 🆕 Include verification detail reasons
    if not backend_ok:
        summary.append("backend_verification_failed")
        if backend_details:
            for v in backend_details:
                if not v.get("ok") and v.get("reason"):
                    summary.append(f"backend: {v.get('reason')}")
                    
    if backend_stalled:
        summary.append("backend_no_progress")
        
    if not frontend_ok:
        summary.append("frontend_verification_failed")
        if frontend_details:
            for v in frontend_details:
                if not v.get("ok") and v.get("reason"):
                    summary.append(f"frontend: {v.get('reason')}")
                    
    if frontend_stalled:
        summary.append("frontend_no_progress")
    if entry_missing:
        summary.append("frontend_entrypoint_missing")
    if smoke_failed:
        reason = ""
        if isinstance(smoke_verdict, dict):
            reason = str(smoke_verdict.get("reason") or "").strip()
        summary.append(f"frontend_smoke_failed: {reason}" if reason else "frontend_smoke_failed")
    if not goal_achieved:
        summary.append(f"goal_validation_failed: {goal_reason}")
    if quality_failed:
         # Detailed quality reason
        if score < min_score:
            summary.append(f"code_review_failed: score {score}/{min_score}")
        if critical_count > 0:
            summary.append(f"code_review_critical_issues: {critical_count}")
        if not aligned:
            summary.append("code_review_goal_misalignment")
    if not consistency_passed:
        summary.append("consistency_check_failed")
    if api_spec_required and not api_spec_valid:
        msg = f"api_spec_invalid: {api_spec_issues[0]}" if api_spec_issues else "api_spec_invalid_or_missing"
        summary.append(msg)
        
    return summary


def orchestrator_judgment_node(state: DAACSState, llm_type: str = "gemini") -> JudgmentResult:
    """최종 결과 판단 노드 - Endpoint Matching 포함"""
    project_dir = state.get("project_dir", ".")
    api_spec = state.get("api_spec", {})
    
    logger.info(
        "[Judgment] Triggered. Backend: %s, Frontend: %s",
        state.get("backend_status"), state.get("frontend_status")
    )

    # 1. Barrier Check
    needs_backend = state.get("needs_backend", True)
    needs_frontend = state.get("needs_frontend", True)
    fullstack_required = bool(needs_backend and needs_frontend)

    backend_done = not needs_backend or state.get("backend_status") in ["completed", "failed"]
    frontend_done = not needs_frontend or state.get("frontend_status") in ["completed", "failed"]

    if not (backend_done and frontend_done):
        logger.info("[Judgment] Waiting for components...")
        return {}

    # 2. Collect Data
    backend_files, frontend_files = _get_files(project_dir)
    
    # 3. Validations
    api_spec_valid, api_spec_issues = _validate_api_spec(state, fullstack_required)
    backend_ok, backend_stalled = _check_backend_verification(state, needs_backend, backend_files, api_spec, fullstack_required)
    frontend_ok, frontend_stalled, entry_missing, smoke_failed = _check_frontend_verification(state, needs_frontend)
    
    hard_failure = entry_missing or smoke_failed
    
    # 🆕 Allow retries on hard failures in early cycles
    iteration = state.get("iteration", 0)
    if hard_failure and iteration < 2:
        logger.warning("[Judgment] Hard failure detected but allowing retry (iteration %s/2)", iteration)
        hard_failure = False  # Demote to soft failure for retry

    # 4. Analysis
    endpoint_result = _analyze_endpoint_compatibility(backend_files, frontend_files)
    compatibility_issues = endpoint_result.get("compatibility_issues", [])
    
    goal_validation = _validate_goal_achievement(state.get("current_goal", ""), backend_files + frontend_files, project_dir)
    logger.info("[Judgment] Goal: %s (%s)", goal_validation.get("achieved"), goal_validation.get("reason"))
    
    # 5. Quality Gate
    min_score = state.get("code_review_min_score")
    if min_score is None or min_score < MIN_CODE_REVIEW_SCORE:
        min_score = MIN_CODE_REVIEW_SCORE
        
    quality_failed, score, critical_count, aligned = _check_quality_gate(state, min_score)
    consistency_passed = state.get("consistency_passed", True)
    
    # 🆕 Force retry on quality failure in early iterations (min 3 attempts)
    MIN_QUALITY_RETRIES = 3
    if quality_failed and iteration < MIN_QUALITY_RETRIES:
        logger.warning("[Judgment] Quality failed (score=%s/%s) but allowing retry (iteration %s/%s)", 
                      score, min_score, iteration + 1, MIN_QUALITY_RETRIES)
        # Don't mark as completed yet - force rework

    # 6. Final Decision
    needs_rework = (
        bool(compatibility_issues)
        or not backend_ok
        or not frontend_ok
        or not goal_validation.get("achieved", False)
        or quality_failed
        or not consistency_passed
        or (fullstack_required and not api_spec_valid)
    )

    # 7. Summary
    smoke_verdict = next(
        (v for v in state.get("frontend_verification_details", []) if v.get("template") == "frontend_smoke_test"), 
        None
    )
    
    failure_summary = _build_failure_summary(
        compatibility_issues, 
        backend_ok, backend_stalled, 
        frontend_ok, frontend_stalled, 
        entry_missing, smoke_failed, smoke_verdict,
        goal_validation.get("achieved", False), goal_validation.get("reason", ""),
        quality_failed, score, min_score, critical_count, aligned,
        consistency_passed,
        api_spec_valid, api_spec_issues, fullstack_required,
        backend_details=state.get("backend_verification_details"),  # 🆕
        frontend_details=state.get("frontend_verification_details")  # 🆕
    )

    logger.info("[Judgment] Final Decision: needs_rework=%s", needs_rework)

    final_status = "completed" if not needs_rework else "needs_rework"
    stop_reason = None
    
    if hard_failure:
        reasons = []
        if entry_missing: reasons.append("frontend_entrypoint_missing")
        if smoke_failed: reasons.append("frontend_smoke_failed")
        stop_reason = f"hard_failure: {', '.join(reasons)}"
        final_status = "stopped"

    return {
        "needs_rework": needs_rework,
        "compatibility_issues": compatibility_issues,
        "endpoint_analysis": endpoint_result.get("endpoint_analysis", {}),
        "goal_validation": goal_validation,
        "api_spec_valid": api_spec_valid,
        "api_spec_issues": api_spec_issues,
        "api_spec_required": fullstack_required,
        "quality_gate_failed": quality_failed,
        "consistency_passed": consistency_passed,
        "frontend_verification_ok": frontend_ok,
        "frontend_entrypoint_missing": entry_missing,
        "frontend_smoke_failed": smoke_failed,
        "hard_failure": hard_failure,
        "failure_summary": failure_summary,
        "stop_reason": stop_reason,
        "final_status": final_status,
    }
