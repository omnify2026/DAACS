"""
DAACS OS — Replanning Node
실패 분석 → 수정 가이던스 생성 → 재실행 판단.

Source: DAACS_v2-dy/daacs/graph/orchestrator_replanning.py
Adapted: 실패 유형 감지, 정체(plateau) 감지, 패치 타겟 결정.
"""
import logging
from typing import Any, Dict, List, Optional

from ...agents.base_roles import AgentRole

logger = logging.getLogger("daacs.graph.nodes.replanning")


# ─── Failure Type Detection ───

def _detect_failure_type(failure_summary: List[str]) -> str:
    """실패 요약에서 실패 유형을 감지."""
    summary_text = " ".join(str(s) for s in failure_summary).lower()

    if "no files" in summary_text or "no backend" in summary_text or "no frontend" in summary_text:
        return "no_output"
    if "missing endpoint" in summary_text or "missing backend endpoint" in summary_text:
        return "missing_endpoints"
    if "goal not achieved" in summary_text:
        return "goal_miss"
    if "compatibility" in summary_text or "doesn't appear to call" in summary_text:
        return "compatibility_issue"
    if "critical" in summary_text:
        return "quality_issue"
    if "empty file" in summary_text or "suspiciously short" in summary_text:
        return "incomplete_output"
    if "no_progress" in summary_text:
        return "stalled"

    return "general_failure"


def _build_failure_signature(failure_type: str, score: int, issues_count: int) -> str:
    """실패 시그니처 생성 (plateau 감지용)."""
    return f"type:{failure_type}|score:{score}|issues:{issues_count}"


def _get_patch_targets(state: Dict[str, Any], failure_summary: List[str]) -> List[str]:
    """패치 대상 파일 결정."""
    targets: List[str] = []
    summary_text = " ".join(str(s) for s in failure_summary).lower()

    # 리뷰 이슈 기반
    review = state.get("code_review", {})
    if isinstance(review, dict):
        for issue in review.get("issues", []):
            if isinstance(issue, dict):
                file = (issue.get("file") or "").strip()
                if file:
                    targets.append(file)

    # 백엔드 문제
    if "missing backend" in summary_text or "missing endpoint" in summary_text:
        targets.append("backend/main.py")

    # 프론트엔드 문제
    if "frontend" in summary_text:
        targets.extend(["frontend/src/App.tsx", "frontend/package.json"])

    # 호환성 문제
    if "compatibility" in summary_text:
        targets.extend(["backend/main.py", "frontend/src/App.tsx"])

    return sorted(set(t for t in targets if t))


def _build_replan_guidance(
    state: Dict[str, Any],
    failure_type: str,
    failure_summary: List[str],
) -> str:
    """재작업 가이던스 생성."""
    parts: List[str] = []

    # 실패 유형별 힌트
    hints = {
        "no_output": (
            "=== NO OUTPUT ===\n"
            "The previous attempt generated no files.\n"
            "You MUST output files using the FILE: format.\n"
            "Example:\nFILE: main.py\n```python\nfrom fastapi import FastAPI\napp = FastAPI()\n```"
        ),
        "missing_endpoints": (
            "=== MISSING ENDPOINTS ===\n"
            "Some API endpoints from the spec were not implemented.\n"
            "Check the API spec and ensure ALL endpoints exist in backend/main.py."
        ),
        "goal_miss": (
            "=== GOAL NOT ACHIEVED ===\n"
            "The code doesn't fully meet the project goal.\n"
            "Re-read the goal carefully and implement all required functionality."
        ),
        "compatibility_issue": (
            "=== FRONTEND-BACKEND MISMATCH ===\n"
            "Frontend API calls don't match backend endpoints.\n"
            "1. Check backend endpoint paths\n"
            "2. Ensure frontend fetch() calls use matching URLs\n"
            "3. Add CORS middleware to backend"
        ),
        "quality_issue": (
            "=== QUALITY ISSUES ===\n"
            "Code has critical quality issues.\n"
            "Fix the issues listed below before proceeding."
        ),
        "incomplete_output": (
            "=== INCOMPLETE OUTPUT ===\n"
            "Some files are empty or too short.\n"
            "Ensure every file has complete, working code."
        ),
        "stalled": (
            "=== STALLED — NO PROGRESS ===\n"
            "The previous iteration made no changes.\n"
            "You MUST make tangible changes. Try a different approach."
        ),
    }
    hint = hints.get(failure_type, "Fix the issues listed below and try again.")
    parts.append(hint)

    # 구체적 실패 내용
    if failure_summary:
        parts.append("\n=== SPECIFIC ISSUES ===")
        for i, issue in enumerate(failure_summary[:10], 1):
            parts.append(f"{i}. {issue}")

    # 코드 리뷰 이슈
    review = state.get("code_review", {})
    if isinstance(review, dict):
        critical_issues = [
            i for i in review.get("issues", [])
            if isinstance(i, dict) and i.get("severity") == "critical"
        ]
        if critical_issues:
            parts.append("\n=== CRITICAL FIXES REQUIRED ===")
            for issue in critical_issues[:5]:
                desc = issue.get("description", "")
                suggestion = issue.get("suggestion", "")
                file = issue.get("file", "")
                parts.append(f"- [{file}] {desc}")
                if suggestion:
                    parts.append(f"  → Fix: {suggestion}")

    return "\n".join(parts)


async def replanning_node(
    state: Dict[str, Any],
    executor=None,
    manager=None,
) -> Dict[str, Any]:
    """
    Replanning Node — 실패를 분석하고 재작업 가이던스 생성.

    1. 실패 유형 감지
    2. Plateau 감지 (같은 실패 반복)
    3. 패치 타겟 결정
    4. 재작업 가이던스 생성
    5. 최대 실패 횟수 초과 시 중단

    Returns:
        replan_guidance, patch_targets, failure_type, consecutive_failures,
        stop_reason, needs_rework
    """
    failure_summary = state.get("failure_summary", [])
    verification_failures = state.get("verification_failures", [])
    consecutive_failures = state.get("consecutive_failures", 0) + 1
    max_iterations = state.get("max_iterations", 10)
    score = state.get("code_review_score", 0)

    # PM 에이전트가 재계획
    if manager:
        pm = manager.get_agent(AgentRole.PM)
        if pm:
            pm.set_task(f"재계획 수립 (실패 {consecutive_failures}회)")

    combined_failures = list(failure_summary) + [
        item for item in verification_failures
        if item not in failure_summary
    ]

    # 1. 실패 유형 감지
    failure_type = _detect_failure_type(combined_failures)

    # 2. Plateau 감지
    failure_signature = _build_failure_signature(failure_type, score, len(failure_summary))
    last_signature = state.get("last_failure_signature", "")
    failure_repeat_count = state.get("failure_repeat_count", 0)

    if failure_signature == last_signature:
        failure_repeat_count += 1
    else:
        failure_repeat_count = 1

    # 3. 정지 조건 확인
    stop_reason = None
    plateau_max = 3

    if failure_repeat_count >= plateau_max:
        stop_reason = f"plateau_detected ({failure_repeat_count}/{plateau_max} same failure)"
        logger.warning(f"[Replan] {stop_reason}")
    elif consecutive_failures >= max_iterations:
        stop_reason = f"max_failures_reached ({consecutive_failures}/{max_iterations})"
        logger.warning(f"[Replan] {stop_reason}")

    if stop_reason:
        if manager:
            pm = manager.get_agent(AgentRole.PM)
            if pm:
                pm.complete_task()
        return {
            "needs_rework": False,
            "stop_reason": stop_reason,
            "final_status": "stopped",
            "consecutive_failures": consecutive_failures,
            "last_failure_signature": failure_signature,
            "failure_repeat_count": failure_repeat_count,
        }

    # 4. 패치 타겟 + 가이던스 생성
    patch_targets = _get_patch_targets(state, combined_failures)
    replan_guidance = _build_replan_guidance(state, failure_type, combined_failures)

    logger.info(
        f"[Replan] type={failure_type}, failures={consecutive_failures}, "
        f"repeat={failure_repeat_count}, targets={patch_targets}"
    )

    # PM 완료
    if manager:
        pm = manager.get_agent(AgentRole.PM)
        if pm:
            pm.complete_task()

    return {
        "needs_rework": True,
        "replan_guidance": replan_guidance,
        "patch_targets": patch_targets,
        "failure_type": failure_type,
        "consecutive_failures": consecutive_failures,
        "last_failure_signature": failure_signature,
        "failure_repeat_count": failure_repeat_count,
        "stop_reason": None,
        "pending_handoffs": [],
    }
