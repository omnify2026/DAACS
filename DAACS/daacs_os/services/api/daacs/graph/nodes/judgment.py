"""
DAACS OS — Judgment Node
Reviewer + CEO 에이전트가 생성된 코드를 평가하고 합격/재작업 판정.

Source: DAACS_v2-dy/daacs/graph/orchestrator_judgment.py
Adapted: 7개 검증 기준 → DAACS_OS 5개 핵심 기준, Reviewer/CEO 역할 매핑.
"""
import json
import logging
from typing import Any, Dict, List, Optional, Tuple

from ...agents.base_roles import AgentRole
from .planning import _extract_json

logger = logging.getLogger("daacs.graph.nodes.judgment")

# ─── Review Prompt ───

REVIEW_PROMPT = """You are an expert code reviewer. Review the following code and provide a quality assessment.

## Project Goal
{goal}

## API Specification
{api_spec}

## Backend Files
{backend_files}

## Frontend Files
{frontend_files}

## Instructions
Analyze the code and respond with a JSON object:

{{
    "score": 0-10,
    "passed": true/false,
    "issues": [
        {{"severity": "critical|warning|info", "file": "path", "description": "issue", "suggestion": "fix"}}
    ],
    "goal_achieved": true/false,
    "goal_reason": "Why goal is/isn't achieved",
    "missing_features": ["feature1", "feature2"],
    "compatibility_issues": ["issue1"]
}}

Scoring Guide:
- 9-10: Production quality, all features implemented
- 7-8: Good quality, minor issues
- 5-6: Functional but needs improvement
- 3-4: Significant issues, core features missing
- 1-2: Major problems, doesn't meet requirements

Be strict but fair. Check:
1. All API endpoints from the spec are implemented
2. Frontend calls the correct backend endpoints
3. Error handling is present
4. Code follows best practices
5. The goal is actually achieved
"""


def _format_files_for_review(files: Dict[str, str], max_chars: int = 8000) -> str:
    """파일을 리뷰용 문자열로 변환 (크기 제한)."""
    if not files:
        return "(no files)"
    parts = []
    total = 0
    for path, code in sorted(files.items()):
        entry = f"--- {path} ---\n{code}\n"
        if total + len(entry) > max_chars:
            parts.append(f"... ({len(files) - len(parts)} more files truncated)")
            break
        parts.append(entry)
        total += len(entry)
    return "\n".join(parts)


def _check_api_spec_compliance(
    api_spec: Dict[str, Any],
    backend_files: Dict[str, str],
    frontend_files: Dict[str, str],
) -> Tuple[bool, List[str]]:
    """API 스펙 대비 코드 검증 (정적 분석)."""
    issues = []
    endpoints = api_spec.get("endpoints", [])

    if not endpoints:
        return True, []

    # Check backend has the endpoints
    all_backend_code = "\n".join(backend_files.values()).lower()
    for ep in endpoints:
        path = ep.get("path", "")
        method = ep.get("method", "GET").lower()
        if path and path.lower() not in all_backend_code:
            issues.append(f"Missing backend endpoint: {method.upper()} {path}")

    # Check frontend calls backend
    all_frontend_code = "\n".join(frontend_files.values()).lower()
    if frontend_files and backend_files:
        has_api_call = any(
            keyword in all_frontend_code
            for keyword in ["fetch(", "axios", "api.", "/api/", "usequery", "usemutation"]
        )
        if not has_api_call:
            issues.append("Frontend doesn't appear to call any backend API endpoints")

    return len(issues) == 0, issues


def _check_file_basics(files: Dict[str, str], role: str) -> List[str]:
    """기본 파일 품질 검증."""
    issues = []
    if not files:
        issues.append(f"No {role} files generated")
        return issues

    for path, code in files.items():
        if not code.strip():
            issues.append(f"Empty file: {path}")
        if len(code) < 20:
            issues.append(f"Suspiciously short file ({len(code)} chars): {path}")

    return issues


async def judgment_node(
    state: Dict[str, Any],
    executor=None,
    manager=None,
) -> Dict[str, Any]:
    """
    Judgment Node — Reviewer가 코드를 평가, CEO가 최종 판정.

    1. Reviewer 상태 → WORKING
    2. 정적 검증 (API 스펙 준수, 파일 기본 품질)
    3. LLM 기반 코드 리뷰
    4. CEO 판정: pass/fail
    5. Reviewer → IDLE

    Returns:
        needs_rework, code_review, code_review_score, code_review_passed,
        failure_summary, consistency_passed
    """
    goal = state.get("current_goal", "")
    api_spec = state.get("api_spec", {})
    backend_files = state.get("backend_files", {})
    frontend_files = state.get("frontend_files", {})
    needs_backend = state.get("needs_backend", True)
    needs_frontend = state.get("needs_frontend", True)
    iteration = state.get("iteration", 1)

    logger.info(f"[Judgment] Iteration {iteration}, backend={len(backend_files)} files, frontend={len(frontend_files)} files")

    # Reviewer 상태
    if manager:
        reviewer = manager.get_agent(AgentRole.REVIEWER)
        if reviewer:
            reviewer.set_task("코드 리뷰 및 품질 평가")

    failure_summary: List[str] = []

    # ─── 1. Static checks ───
    if needs_backend:
        backend_issues = _check_file_basics(backend_files, "backend")
        failure_summary.extend(backend_issues)

    if needs_frontend:
        frontend_issues = _check_file_basics(frontend_files, "frontend")
        failure_summary.extend(frontend_issues)

    # ─── 2. API spec compliance ───
    spec_ok, spec_issues = _check_api_spec_compliance(api_spec, backend_files, frontend_files)
    if not spec_ok:
        failure_summary.extend(spec_issues)

    # ─── 3. LLM-based review ───
    review_data: Dict[str, Any] = {}
    score = 0

    if executor and (backend_files or frontend_files):
        api_spec_str = json.dumps(api_spec, indent=2, ensure_ascii=False) if api_spec else "N/A"
        prompt = REVIEW_PROMPT.format(
            goal=goal,
            api_spec=api_spec_str,
            backend_files=_format_files_for_review(backend_files),
            frontend_files=_format_files_for_review(frontend_files),
        )

        system_prompt = ""
        if manager:
            reviewer = manager.get_agent(AgentRole.REVIEWER)
            if reviewer:
                system_prompt = reviewer.get_skill_prompt()

        try:
            response = await executor.execute(
                role="reviewer",
                prompt=prompt,
                system_prompt=system_prompt,
            )

            # Parse review JSON
            review_data = _extract_json(response)
            score = review_data.get("score", 5)

            # Add LLM-detected issues to failure summary
            if not review_data.get("goal_achieved", True):
                failure_summary.append(f"Goal not achieved: {review_data.get('goal_reason', 'unknown')}")
            for issue in review_data.get("issues", []):
                if isinstance(issue, dict) and issue.get("severity") == "critical":
                    failure_summary.append(f"Critical: {issue.get('description', '')}")
            for missing in review_data.get("missing_features", []):
                failure_summary.append(f"Missing feature: {missing}")
            for compat in review_data.get("compatibility_issues", []):
                failure_summary.append(f"Compatibility: {compat}")

        except Exception as e:
            logger.warning(f"[Judgment] LLM review failed: {e}")
            score = 5  # Default to middling score on review failure
    elif not backend_files and not frontend_files:
        score = 0
        failure_summary.append("No files generated at all")

    # ─── 4. Final Decision ───
    min_score = 7  # Minimum passing score
    passed = score >= min_score and not any("Critical" in s for s in failure_summary)
    needs_rework = not passed

    # CEO 최종 판정
    if manager:
        ceo = manager.get_agent(AgentRole.CEO)
        if ceo:
            verdict = "합격" if passed else "재작업 필요"
            ceo.set_task(f"최종 판정: {verdict} (점수: {score}/10)")
            ceo.complete_task()

    # Reviewer 완료
    if manager:
        reviewer = manager.get_agent(AgentRole.REVIEWER)
        if reviewer:
            reviewer.complete_task()

    logger.info(f"[Judgment] Score={score}/10, passed={passed}, issues={len(failure_summary)}")

    return {
        "needs_rework": needs_rework,
        "code_review": review_data,
        "code_review_score": score,
        "code_review_passed": passed,
        "consistency_passed": spec_ok,
        "consistency_issues": spec_issues if not spec_ok else [],
        "failure_summary": failure_summary,
        "rework_source": "reviewer" if needs_rework else None,
    }
