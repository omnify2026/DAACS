"""Collaboration session and round endpoints."""

from __future__ import annotations

import asyncio
import logging
import uuid
from pathlib import Path
from typing import Any, Dict, List, Sequence

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, Field

from ..agents.teams import AgentTeam
from ..application.collaboration_service import create_session, start_round
from ..application.persistence_service import (
    load_collaboration_session_from_db,
    persist_collaboration_round,
    persist_collaboration_session,
)
from ..application.workflow_service import (
    ensure_parallel_runtime,
    get_manager,
    local_manager_exists,
    manager_action,
    sanitize_project_cwd,
    submit_parallel_team_primitives,
)
from ..core.deps import get_current_user, require_project_access
from ..db.models import User
from ..orchestration.collaboration_orchestrator import (
    build_contribution_record,
    build_deterministic_artifact,
    enrich_collaboration_artifact,
)
from .agents_ws import ws_manager

router = APIRouter(prefix="/api/collaboration", tags=["collaboration"])
logger = logging.getLogger(__name__)
COLLAB_RESULT_TIMEOUT_SECONDS = 120.0
COLLAB_PM_RESULT_TIMEOUT_SECONDS = 45.0
COLLAB_RESULT_POLL_INTERVAL_SECONDS = 0.5
TERMINAL_TASK_STATUSES = frozenset({"completed", "failed"})
DISCOVERY_ONLY_HINTS = (
    "identify",
    "locate",
    "find",
    "trace",
    "name",
    "where",
    "which file",
    "document",
    "inspect",
    "confirm",
    "map",
    "previous result",
    "existing result",
    "also name",
    "also naming",
    "which component",
    "which file",
    "점검",
    "확인",
    "추적",
    "분석",
    "정리",
    "재현 경로",
    "의심 파일",
    "검증 방법",
    "체크리스트",
    "어디",
    "어느 파일",
    "어느 컴포넌트",
    "기존 결과",
    "이전 결과",
)
READ_ONLY_DISCOVERY_HINTS = (
    "read-only",
    "read only",
    "keep this read-only",
    "keep it read-only",
    "readonly",
    "validate only",
    "validation only",
    "only validate",
    "읽기 전용",
    "검증만",
    "검수만",
    "확인만",
    "고치지 말고",
    "수정하지 말고",
    "수정 없이",
    "변경하지 말고",
)
REVISION_DISCOVERY_HINTS = (
    "revision request",
    "revise",
    "rewrite",
    "rework the result",
    "compact checklist",
    "checklist",
    "수정 요청",
    "다시 정리",
    "체크리스트로",
)
IMPLEMENTATION_HINTS = (
    "implement",
    "fix",
    "update",
    "change",
    "add",
    "remove",
    "refactor",
    "write",
    "create",
    "build",
    "ship",
    "deploy",
    "rollout",
    "test",
    "구현",
    "수정",
    "변경",
    "추가",
    "삭제",
    "리팩터링",
    "작성",
    "배포",
    "테스트",
)
VALIDATION_DISCOVERY_HINTS = (
    "validate",
    "validation",
    "verify",
    "verification",
    "검증",
    "확인",
    "점검",
)
IMPLEMENTATION_CLEANUP_HINTS = (
    "cleanup",
    "clean up",
    "clean-up",
    "remove dead code",
    "delete unused",
    "unused code",
    "불필요한 코드",
    "죽은 코드",
    "미사용 코드",
    "정리하고",
    "정리한 뒤",
    "정리해서",
    "정리해",
    "정리해줘",
)
IMPLEMENTATION_CLEANUP_SCOPE_HINTS = (
    "code",
    "source",
    "file",
    "test",
    "implementation",
    "코드",
    "파일",
    "테스트",
    "구현",
    "삭제",
    "수정",
    "변경",
)
IMPLEMENTATION_ACTION_SCOPE_HINTS = (
    "bug",
    "code",
    "source",
    "test",
    "implementation",
    "regression",
    "버그",
    "코드",
    "테스트",
    "회귀",
    "잘못된 부분",
    "관련 테스트",
    "변경 테스트",
)
DISCOVERY_RESULT_HINTS = (
    "previous result",
    "existing result",
    "finding",
    "answer",
    "result",
    "이전 결과",
    "기존 결과",
    "발견사항",
    "결과",
    "산출물",
)
DISCOVERY_FILE_HINTS = (
    "name",
    "naming",
    "where",
    "which",
    "file",
    "component",
    "render",
    "status",
    "session",
    "path",
    "파일",
    "경로",
    "컴포넌트",
    "렌더",
    "상태",
    "세션",
)
WEB_DISCOVERY_HINTS = (
    "web",
    "ui",
    "frontend",
    "tsx",
    "react",
    "goal meeting",
    "shared board",
    "board",
    "panel",
    "workspace",
    "collaboration",
    "웹",
    "프론트",
    "보드",
    "패널",
    "공유 보드",
    "컴포넌트",
    "렌더",
)
API_DISCOVERY_HINTS = (
    "api",
    "backend",
    "server",
    "route",
    "python",
    "fastapi",
    "endpoint",
    "daacs",
    "백엔드",
    "서버",
    "라우트",
    "엔드포인트",
    "함수",
    "타임아웃",
    "판별",
)
PROJECT_GUARDRAILS = (
    "Keep DAACS OS aligned with a dynamic agent operating system, not a rigid fixed script.",
    "Prefer concrete deliverables and done criteria over vague meeting-style summaries.",
    "Protect output quality, execution stability, and user experience together.",
    "Preserve user-visible requirement coverage from the original request through implementation, review, and verification.",
    "Treat transient generated artifacts as evidence unless the user explicitly asks to keep them as project scope.",
)
RUST_DISCOVERY_HINTS = (
    "rust",
    "tauri",
    "axum",
    "desktop",
)


def _planning_lines(value: Any) -> List[str]:
    return _normalize_lines(value)


def _extract_user_requirement_checklist(prompt: str, shared_goal: str = "") -> List[str]:
    seen: set[str] = set()
    items: List[str] = []
    for raw_line in str(prompt or "").splitlines():
        item = raw_line.strip().lstrip("-*•0123456789.) ").strip("\"'“”")
        if not item or len(item) > 180:
            continue
        lowered = item.lower()
        if lowered in {
            "riot games",
            "+1",
            "주요 단계 및 규칙",
            "밴(ban) 단계 (금지)",
            "픽(pick) 단계 (선택)",
        }:
            continue
        if lowered in seen:
            continue
        seen.add(lowered)
        items.append(item)
        if len(items) >= 8:
            break
    if items:
        return items
    fallback = " ".join(str(shared_goal or prompt or "").split())
    return [fallback[:180]] if fallback else []


def _fallback_planning_brief(prompt: str, shared_goal: str) -> Dict[str, Any]:
    refined_goal = (shared_goal or prompt).strip()
    user_requirements = _extract_user_requirement_checklist(prompt, shared_goal)
    acceptance_criteria = _planning_lines(
        [
            refined_goal,
            *[f"사용자 요구사항을 빠뜨리지 않는다: {item}" for item in user_requirements],
            f"사용자 요청에 바로 답하는 구체적인 결과를 만든다: {prompt}",
            "구현 범위, 리뷰 위험, 검증 증거, 배포 때 볼 점을 함께 보여준다.",
        ]
    )
    return {
        "refined_goal": refined_goal,
        "plan_summary": f"이번 라운드는 이 목표에 맞춘다: {refined_goal[:180]}",
        "acceptance_criteria": acceptance_criteria,
        "deliverables": _planning_lines(
            [
                "바뀐 파일이나 모듈이 보이는 구체적인 구현 결과",
                "진짜 막는 문제나 회귀 위험이 있는 리뷰 결과",
                "검증한 증거와 아직 비어 있는 확인 거리",
                "배포 순서, 상태 확인, 감시 계획",
            ]
        ),
        "review_focus": _planning_lines(
            [
                "동작이 맞는지와 다른 곳이 망가질 위험",
                "빠졌거나 약한 테스트",
                "구현 범위 안에 숨어 있는 출시 차단 문제",
            ]
        ),
        "verification_focus": _planning_lines(
            [
                "확인 기준을 실제로 만족했는지",
                "출시 전에 더 필요한 증거",
                "완료했다고 말한 것과 실제 증거 사이의 빈틈",
            ]
        ),
        "ops_focus": _planning_lines(
            [
                "배포 순서와 되돌리기 안전장치",
                "상태 확인과 알림",
                "문제가 다시 생겼을 때 빨리 찾는 감시",
            ]
        ),
        "execution_card": "가장 값진 작은 구현부터 끝내고, 이번 턴 범위를 작게 지킨다.",
        "primary_focus": "파일이나 모듈 이름이 보이는 구체적인 구현 하나를 끝낸다.",
        "done_for_this_round": "구현 결과 하나와 리뷰, 검증까지 이어지면 이번 턴은 끝난다.",
        "do_not_expand": _planning_lines(
            [
                "이번 턴에서 관계없는 산출물로 넓히지 않는다.",
                "작은 구현 하나로 충분하면 전체 재작성으로 키우지 않는다.",
            ]
        ),
    }


class CreateSessionRequest(BaseModel):
    shared_goal: str = Field(..., min_length=3, max_length=2000)
    participants: List[str] = Field(default_factory=list)


class StartRoundRequest(BaseModel):
    prompt: str = Field(..., min_length=1, max_length=2000)
    teams: List[str] = Field(default_factory=lambda: ["development_team", "review_team"])
    project_cwd: str | None = Field(default=None, max_length=4096)


def _normalize_lines(value: Any) -> List[str]:
    if value is None:
        return []
    if isinstance(value, str):
        parts = [segment.strip(" -*\t") for segment in value.splitlines()]
        return [part for part in parts if part]
    if isinstance(value, (list, tuple, set)):
        lines: List[str] = []
        for item in value:
            lines.extend(_normalize_lines(item))
        seen: set[str] = set()
        deduped: List[str] = []
        for item in lines:
            if item not in seen:
                seen.add(item)
                deduped.append(item)
        return deduped
    return []


def _dedupe_lines(items: Sequence[str]) -> List[str]:
    seen: set[str] = set()
    ordered: List[str] = []
    for item in items:
        value = str(item or "").strip()
        if not value or value in seen:
            continue
        seen.add(value)
        ordered.append(value)
    return ordered


def _truncate_text(value: Any, limit: int = 240) -> str:
    text = " ".join(str(value or "").split()).strip()
    if not text or limit <= 0:
        return ""
    if len(text) <= limit:
        return text
    return text[: max(1, limit - 1)].rstrip() + "…"


def _planning_text(value: Any, limit: int = 220) -> str:
    return _truncate_text(value, limit)


def _planning_scope_lines(value: Any) -> List[str]:
    return _planning_lines(value)


def _build_execution_card_lines(planning_brief: Dict[str, Any]) -> List[str]:
    lines: List[str] = []
    execution_card = _planning_text(planning_brief.get("execution_card"))
    primary_focus = _planning_text(planning_brief.get("primary_focus"), 180)
    done_for_this_round = _planning_text(planning_brief.get("done_for_this_round"), 180)
    do_not_expand = _planning_scope_lines(planning_brief.get("do_not_expand"))

    if execution_card:
        lines.append(f"Execution card: {execution_card}")
    if primary_focus:
        lines.append(f"Primary focus: {primary_focus}")
    if done_for_this_round:
        lines.append(f"Done for this round: {done_for_this_round}")
    for item in do_not_expand[:3]:
        lines.append(f"Do not expand into: {item}")
    return lines


def _summarize_prior_contributions(contributions: Sequence[Dict[str, Any]], limit: int = 6) -> str:
    lines: List[str] = []
    selected = list(contributions)[-limit:]
    for index, item in enumerate(selected, start=1):
        team = str(item.get("team") or "team").strip()
        role = str(item.get("agent_role") or "agent").strip()
        status = str(item.get("status") or "pending").strip()
        summary = _truncate_text(item.get("summary"), 220)
        if not summary:
            continue
        lines.append(f"{index}. [{team}/{role}/{status}] {summary}")
        for question in _normalize_lines(item.get("open_questions"))[:1]:
            lines.append(f"   blocker: {_truncate_text(question, 140)}")
        for action in _normalize_lines(item.get("next_actions"))[:1]:
            lines.append(f"   next: {_truncate_text(action, 140)}")
    return "\n".join(lines).strip()


def _build_code_context(contributions: Sequence[Dict[str, Any]], limit: int = 4) -> str:
    blocks: List[str] = []
    for item in contributions:
        details = item.get("details")
        if not isinstance(details, dict):
            continue
        excerpt = _truncate_text(details.get("llm_response_excerpt") or item.get("summary"), 240)
        if not excerpt:
            continue
        role = str(item.get("agent_role") or "agent").strip()
        blocks.append(f"[{role}] {excerpt}")
        if len(blocks) >= limit:
            break
    return "\n\n".join(blocks)


def _candidate_discovery_search_roots(prompt: str) -> List[str]:
    text = str(prompt or "").lower()
    candidates: List[str] = []
    if any(token in text for token in WEB_DISCOVERY_HINTS):
        candidates.extend(
            [
                "apps/web/src/components/office",
                "apps/web/src/services",
                "apps/web/src/stores",
                "apps/web/src",
            ]
        )
    if any(token in text for token in API_DISCOVERY_HINTS):
        candidates.extend(
            [
                "services/api/daacs/routes",
                "services/api/daacs/agents",
                "services/api/tests",
                "services/api/daacs",
            ]
        )
    if any(token in text for token in RUST_DISCOVERY_HINTS):
        candidates.extend(
            [
                "backend/src/routes",
                "backend/src",
                "src-tauri/src",
                "src-tauri",
            ]
        )
    if not candidates:
        candidates.extend(
            [
                "apps/web/src",
                "services/api/daacs",
                "backend/src",
            ]
        )
    return _dedupe_lines(candidates)


def _build_discovery_search_roots(prompt: str, project_cwd: str | None) -> List[str]:
    def _iter_workspace_bases(root: Path, max_depth: int = 2) -> List[Path]:
        bases: List[Path] = [root]
        frontier: List[Path] = [root]
        ignored = {"node_modules", ".git", ".hg", ".svn", "dist", "build", "target", "test-results"}
        for _ in range(max_depth):
            next_frontier: List[Path] = []
            for base in frontier:
                try:
                    children = sorted(
                        child
                        for child in base.iterdir()
                        if child.is_dir() and child.name not in ignored and not child.name.startswith(".")
                    )
                except OSError:
                    continue
                bases.extend(children)
                next_frontier.extend(children)
            frontier = next_frontier
        return bases

    def _resolve_candidate(root: Path, bases: Sequence[Path], relative: str) -> str | None:
        for base in bases:
            candidate = base / relative
            if not candidate.exists():
                continue
            try:
                return str(candidate.relative_to(root))
            except ValueError:
                continue
        return None

    def _drop_parent_roots(items: Sequence[str]) -> List[str]:
        normalized = _dedupe_lines(items)
        kept: List[str] = []
        for item in normalized:
            prefix = item.rstrip("/") + "/"
            if any(other != item and other.startswith(prefix) for other in normalized):
                continue
            kept.append(item)
        return kept

    candidates = _candidate_discovery_search_roots(prompt)
    if not project_cwd:
        return _drop_parent_roots(candidates)[:4]

    root = Path(project_cwd).expanduser()
    workspace_bases = _iter_workspace_bases(root)
    existing = [resolved for item in candidates if (resolved := _resolve_candidate(root, workspace_bases, item))]
    selected = existing or candidates
    return _drop_parent_roots(selected)[:4]


def _contribution_label(item: Dict[str, Any]) -> str:
    role = str(item.get("agent_role") or "agent").strip()
    team = str(item.get("team") or "").strip()
    return f"{team}/{role}" if team else role


def _is_discovery_only_request(prompt: str, planning_brief: Dict[str, Any]) -> bool:
    text = " ".join(
        [
            str(prompt or ""),
            str(planning_brief.get("refined_goal") or ""),
            str(planning_brief.get("plan_summary") or ""),
        ]
    ).lower()
    if any(token in text for token in READ_ONLY_DISCOVERY_HINTS) and (
        any(token in text for token in REVISION_DISCOVERY_HINTS)
        or any(token in text for token in DISCOVERY_RESULT_HINTS)
        or any(token in text for token in DISCOVERY_FILE_HINTS)
        or any(token in text for token in VALIDATION_DISCOVERY_HINTS)
    ):
        return True
    if any(token in text for token in IMPLEMENTATION_HINTS) and any(
        token in text for token in IMPLEMENTATION_ACTION_SCOPE_HINTS
    ):
        return False
    if (
        any(token in text for token in REVISION_DISCOVERY_HINTS)
        and any(token in text for token in DISCOVERY_RESULT_HINTS)
        and any(token in text for token in DISCOVERY_FILE_HINTS)
    ):
        return True
    if (
        any(token in text for token in VALIDATION_DISCOVERY_HINTS)
        and any(token in text for token in DISCOVERY_FILE_HINTS)
        and any(token in text for token in DISCOVERY_ONLY_HINTS)
    ):
        return True
    if any(token in text for token in IMPLEMENTATION_CLEANUP_HINTS) and any(
        token in text for token in IMPLEMENTATION_CLEANUP_SCOPE_HINTS
    ):
        return False
    if any(token in text for token in IMPLEMENTATION_HINTS):
        return False
    if (
        any(token in text for token in DISCOVERY_RESULT_HINTS)
        and any(token in text for token in DISCOVERY_FILE_HINTS)
    ):
        return True
    return any(token in text for token in DISCOVERY_ONLY_HINTS)


def _project_guardrails() -> List[str]:
    return list(PROJECT_GUARDRAILS)


def _determine_round_status(
    contributions: Sequence[Dict[str, Any]],
) -> tuple[str, List[str], List[str], List[str]]:
    pending_roles: List[str] = []
    failed_roles: List[str] = []
    blocked_roles: List[str] = []
    for item in contributions:
        status = str(item.get("status") or "pending").strip()
        label = _contribution_label(item)
        if status == "failed":
            failed_roles.append(label)
        elif status not in TERMINAL_TASK_STATUSES:
            pending_roles.append(label)
        else:
            blocker = _semantic_quality_blocker(item)
            if blocker:
                blocked_roles.append(f"{label}: {blocker}")
    if failed_roles:
        return "failed", _dedupe_lines(pending_roles), _dedupe_lines(failed_roles), _dedupe_lines(blocked_roles)
    if blocked_roles:
        return "incomplete", _dedupe_lines(pending_roles), [], _dedupe_lines(blocked_roles)
    if pending_roles:
        return "incomplete", _dedupe_lines(pending_roles), [], []
    return "completed", [], [], []


def _semantic_quality_blocker(item: Dict[str, Any]) -> str:
    role = str(item.get("agent_role") or "").strip().lower()
    details = item.get("details")
    detail_map = details if isinstance(details, dict) else {}
    verdict = str(detail_map.get("verdict") or "").strip().lower()
    open_questions = _normalize_lines(item.get("open_questions"))

    if role == "reviewer":
        if verdict != "pass":
            return f"review verdict is {verdict or 'missing'}"
        if open_questions:
            return "unresolved review findings remain"
        return ""

    if role == "verifier":
        checks = _normalize_lines(detail_map.get("checks"))
        evidence = _normalize_lines(detail_map.get("evidence"))
        if verdict != "pass":
            return f"verification verdict is {verdict or 'missing'}"
        if open_questions:
            return "verification still has unresolved blockers or open questions"
        if not checks:
            return "verification is missing executed checks"
        if not evidence:
            return "verification is missing concrete evidence"
        return ""

    return ""


def _annotate_artifact_with_round_status(
    artifact: Dict[str, Any],
    *,
    round_status: str,
    pending_roles: Sequence[str],
    failed_roles: Sequence[str],
    blocked_roles: Sequence[str],
) -> Dict[str, Any]:
    if round_status == "completed":
        return artifact

    open_questions = list(artifact.get("open_questions") or [])
    next_actions = list(artifact.get("next_actions") or [])

    if pending_roles:
        open_questions.insert(
            0,
            "Timed out before all agent tasks finished: " + ", ".join(pending_roles),
        )
        next_actions.insert(
            0,
            "Retry the round after narrowing the goal or increasing the timeout.",
        )
        next_actions.insert(
            1,
            "Review only the completed contributions before acting on this artifact.",
        )

    if failed_roles:
        open_questions.insert(
            0,
            "One or more agent tasks failed: " + ", ".join(failed_roles),
        )
        next_actions.insert(
            0,
            "Inspect the failed agent tasks and rerun the round.",
        )

    if blocked_roles:
        open_questions.insert(
            0,
            "Quality gate blocked by: " + ", ".join(blocked_roles),
        )
        next_actions.insert(
            0,
            "Address the review or verification blockers, then rerun the round.",
        )
        next_actions.insert(
            1,
            "Do not treat this round as release-ready until reviewer and verifier both return evidence-backed passes.",
        )

    decision = str(artifact.get("decision") or "").strip()
    if blocked_roles:
        decision = f"Quality gate blocked: {decision}" if decision else "Quality gate blocked."
    elif round_status == "incomplete":
        decision = f"Incomplete round: {decision}" if decision else "Incomplete round."
    elif round_status == "failed":
        decision = f"Failed round: {decision}" if decision else "Failed round."

    return {
        **artifact,
        "decision": decision,
        "open_questions": _dedupe_lines(open_questions),
        "next_actions": _dedupe_lines(next_actions),
    }


async def _stop_parallel_best_effort(project_id: str, *, reason: str) -> None:
    try:
        await manager_action(project_id, "stop_parallel", {}, timeout_seconds=20.0)
    except (KeyError, TimeoutError, RuntimeError) as exc:
        logger.warning(
            "collaboration stop_parallel best-effort fallback project=%s reason=%s: %s",
            project_id,
            reason,
            exc,
        )


def _build_team_instruction(
    team: AgentTeam,
    *,
    prompt: str,
    shared_goal: str,
    prior_contributions: Sequence[Dict[str, Any]],
    planning_brief: Dict[str, Any],
    project_cwd: str | None = None,
    discovery_only: bool = False,
) -> str:
    goal = str(planning_brief.get("refined_goal") or shared_goal or prompt).strip()
    prior_digest = _summarize_prior_contributions(prior_contributions)
    acceptance_criteria = _planning_lines(planning_brief.get("acceptance_criteria"))
    deliverables = _planning_lines(planning_brief.get("deliverables"))
    review_focus = _planning_lines(planning_brief.get("review_focus"))
    verification_focus = _planning_lines(planning_brief.get("verification_focus"))
    ops_focus = _planning_lines(planning_brief.get("ops_focus"))
    plan_summary = str(planning_brief.get("plan_summary") or "").strip()
    execution_card_lines = _build_execution_card_lines(planning_brief)
    criteria_block = (
        "\nAcceptance criteria:\n" + "\n".join(f"- {item}" for item in acceptance_criteria[:6])
        if acceptance_criteria
        else ""
    )
    deliverables_block = (
        "\nExpected deliverables:\n" + "\n".join(f"- {item}" for item in deliverables[:6])
        if deliverables
        else ""
    )
    execution_card_block = (
        "\nExecution card:\n" + "\n".join(f"- {item}" for item in execution_card_lines)
        if execution_card_lines
        else ""
    )
    search_roots = _build_discovery_search_roots(prompt, project_cwd)
    search_roots_block = (
        "\nSearch only inside these roots:\n" + "\n".join(f"- {item}" for item in search_roots[:6])
        if discovery_only and search_roots
        else ""
    )
    if team == AgentTeam.DEVELOPMENT_TEAM:
        if discovery_only:
            return (
                f"Question: {prompt}\n"
                f"Goal: {goal}\n\n"
                "Do a read-only repository investigation. Do not propose or implement code changes. "
                "Identify exact file paths, function/component names, and the shortest evidence-backed trace "
                "needed to answer the question."
                f"{search_roots_block}\n"
                "Do at most 3 narrow searches. Do not run broad repo-wide searches or search placeholder roots "
                "such as app, src, backend, or web unless they are explicitly listed above."
            )
        return (
            f"Goal: {goal}\n"
            f"Primary request: {prompt}\n\n"
            f"{plan_summary}\n"
            f"{execution_card_block}\n"
            "Produce concrete implementation output. Be specific about deliverables, file-level changes, "
            "risks, and immediate next steps."
            f"{criteria_block}"
            f"{deliverables_block}"
        )
    if team == AgentTeam.REVIEW_TEAM:
        review_focus_block = (
            "Review focus:\n" + "\n".join(f"- {item}" for item in review_focus[:5]) + "\n"
            if review_focus
            else ""
        )
        verification_focus_block = (
            "Verification focus:\n" + "\n".join(f"- {item}" for item in verification_focus[:5]) + "\n"
            if verification_focus
            else ""
        )
        return (
            f"Goal: {goal}\n"
            f"Review request: {prompt}\n\n"
            "Evaluate the development outputs below. Focus on defects, missing tests, regressions, and "
            "release blockers. Compare the output against every acceptance criterion before approving.\n"
            f"{criteria_block}"
            f"{review_focus_block}"
            f"{verification_focus_block}"
            f"{prior_digest or 'No prior development outputs were supplied.'}"
        )
    if team == AgentTeam.OPERATIONS_TEAM:
        ops_focus_block = (
            "Operations focus:\n" + "\n".join(f"- {item}" for item in ops_focus[:5]) + "\n"
            if ops_focus
            else ""
        )
        return (
            f"Goal: {goal}\n"
            f"Operations request: {prompt}\n\n"
            "Assess rollout, monitoring, runtime reliability, and operating cost using the prior outputs below.\n"
            f"{ops_focus_block}"
            f"{prior_digest or 'No prior implementation outputs were supplied.'}"
        )
    return (
        f"Goal: {goal}\n"
        f"Task: {prompt}\n\n"
        "Respond with concrete deliverables, blockers, and next actions."
    )


def _build_member_instructions(
    team: AgentTeam,
    planning_brief: Dict[str, Any],
    *,
    discovery_only: bool = False,
) -> Dict[str, str]:
    acceptance_criteria = _planning_lines(planning_brief.get("acceptance_criteria"))
    deliverables = _planning_lines(planning_brief.get("deliverables"))
    review_focus = _planning_lines(planning_brief.get("review_focus"))
    verification_focus = _planning_lines(planning_brief.get("verification_focus"))
    ops_focus = _planning_lines(planning_brief.get("ops_focus"))
    criteria_hint = (
        " Required user checklist: " + "; ".join(acceptance_criteria[:4]) + "."
        if acceptance_criteria
        else ""
    )
    if team == AgentTeam.DEVELOPMENT_TEAM:
        if discovery_only:
            return {
                "developer": (
                    "Investigate the repository in read-only mode. Return exact file paths, symbols, and "
                    "control-flow evidence that answer the question. Do not propose implementation work. "
                    "Use only the listed search roots, prefer filename/path searches before content searches, "
                    "and stop after you have the minimal evidence needed to answer."
                ),
            }
        return {
            "developer": (
                "Implement the requested outcome concretely. Name the key files, modules, or interfaces that "
                "must change and surface the most important dependency or blocker if any."
                + (
                    " Prioritize these deliverables: " + "; ".join(deliverables[:4]) + "."
                    if deliverables
                    else ""
                )
            ),
        }
    if team == AgentTeam.REVIEW_TEAM:
        return {
            "reviewer": (
                "Review the development output for correctness, regression risk, missing tests, and release "
                "blockers. Compare the deliverable against every acceptance criterion and fail missing "
                "user-visible requirement coverage. Treat transient generated artifacts as evidence unless "
                "the user explicitly asked to keep them. Prefer concrete findings over stylistic commentary."
                + criteria_hint
                + (
                    " Scrutinize: " + "; ".join(review_focus[:4]) + "."
                    if review_focus
                    else ""
                )
            ),
            "verifier": (
                "Verify whether acceptance criteria are actually covered with concrete evidence. For UI/web "
                "artifacts, prefer a user-flow, local preview, or smoke check in addition to build/lint. "
                "Call out missing evidence, missing checks, and what still needs to be run or proven before release."
                + criteria_hint
                + (
                    " Prove or disprove: " + "; ".join(verification_focus[:4]) + "."
                    if verification_focus
                    else ""
                )
            ),
        }
    if team == AgentTeam.OPERATIONS_TEAM:
        return {
            "devops": (
                "Turn the implementation into a safe rollout plan. Focus on deployment sequencing, health "
                "checks, alerts, dashboards, rollback safety, and runtime dependencies."
                + (
                    " Cover these operational priorities: " + "; ".join(ops_focus[:4]) + "."
                    if ops_focus
                    else ""
                )
            ),
        }
    return {}


def _build_team_context(
    team: AgentTeam,
    *,
    prompt: str,
    shared_goal: str,
    prior_contributions: Sequence[Dict[str, Any]],
    planning_brief: Dict[str, Any],
    project_cwd: str | None = None,
    discovery_only: bool = False,
) -> Dict[str, Any]:
    goal = str(planning_brief.get("refined_goal") or shared_goal or prompt).strip()
    artifact_digest = _summarize_prior_contributions(prior_contributions, limit=8)
    acceptance_criteria = _planning_lines(planning_brief.get("acceptance_criteria"))
    context: Dict[str, Any] = {
        "mode": "collaboration_round",
        "team": team.value,
        "prompt": prompt,
        "shared_goal": goal,
        "goal": goal,
        "project_guardrails": _project_guardrails(),
        "project_cwd": project_cwd,
        "acceptance_criteria": "\n".join(acceptance_criteria) if acceptance_criteria else f"{goal}\n\nOriginal request:\n{prompt}",
        "artifacts": artifact_digest or "No prior artifacts captured yet.",
        "prior_contributions": list(prior_contributions)[-8:],
        "planning_brief": planning_brief,
        "execution_card": "\n".join(_build_execution_card_lines(planning_brief)),
        "member_instructions": _build_member_instructions(
            team,
            planning_brief,
            discovery_only=discovery_only,
        ),
        "discovery_only": discovery_only,
    }
    if team in {AgentTeam.REVIEW_TEAM, AgentTeam.OPERATIONS_TEAM}:
        code_context = _build_code_context(prior_contributions)
        if code_context:
            context["code"] = code_context
    if discovery_only:
        search_roots = _build_discovery_search_roots(prompt, project_cwd)
        if search_roots:
            context["search_roots"] = search_roots
            context["repo_layout"] = (
                "Use only the listed Search Roots for repository lookups. "
                "Do not search placeholder top-level folders unless they appear exactly in Search Roots."
            )
    return context


async def _plan_round_with_pm(
    *,
    project_id: str,
    prompt: str,
    shared_goal: str,
) -> Dict[str, Any]:
    fallback = _fallback_planning_brief(prompt, shared_goal)
    if _is_discovery_only_request(prompt, fallback):
        return fallback
    try:
        task_payload = await manager_action(
            project_id,
            "submit_task",
            {
                "role": "pm",
                "instruction": prompt or shared_goal,
                "context": {
                    "mode": "collaboration_planning",
                    "prompt": prompt,
                    "shared_goal": shared_goal,
                    "project_guardrails": _project_guardrails(),
                },
            },
            timeout_seconds=20.0,
        )
    except (KeyError, TimeoutError, RuntimeError) as exc:
        logger.warning("pm planning unavailable project=%s: %s", project_id, exc)
        return fallback

    task_id = str((task_payload or {}).get("task_id") or "").strip()
    if not task_id:
        return fallback

    pm_results = await _wait_for_multi_results(
        project_id,
        {"pm": task_id},
        timeout_seconds=COLLAB_PM_RESULT_TIMEOUT_SECONDS,
    )
    pm_payload = pm_results.get("pm") or {}
    result = pm_payload.get("result")
    if str(pm_payload.get("status") or "pending") != "completed" or not isinstance(result, dict):
        return fallback

    brief = {
        "refined_goal": str(result.get("refined_goal") or fallback["refined_goal"]).strip() or fallback["refined_goal"],
        "plan_summary": str(result.get("plan_summary") or fallback["plan_summary"]).strip() or fallback["plan_summary"],
        "acceptance_criteria": _planning_lines(result.get("acceptance_criteria")) or fallback["acceptance_criteria"],
        "deliverables": _planning_lines(result.get("deliverables")) or fallback["deliverables"],
        "review_focus": _planning_lines(result.get("review_focus")) or fallback["review_focus"],
        "verification_focus": _planning_lines(result.get("verification_focus")) or fallback["verification_focus"],
        "ops_focus": _planning_lines(result.get("ops_focus")) or fallback["ops_focus"],
        "execution_card": _planning_text(result.get("execution_card")) or fallback["execution_card"],
        "primary_focus": _planning_text(result.get("primary_focus"), 180) or fallback["primary_focus"],
        "done_for_this_round": _planning_text(result.get("done_for_this_round"), 180) or fallback["done_for_this_round"],
        "do_not_expand": _planning_lines(result.get("do_not_expand")) or fallback["do_not_expand"],
    }
    return brief


async def _get_multi_results(project_id: str, task_ids: Dict[str, str]) -> Dict[str, Dict[str, Any]]:
    try:
        return await manager_action(
            project_id,
            "get_multi_agent_results",
            {"task_ids": task_ids},
            timeout_seconds=15.0,
        )
    except KeyError as exc:
        raise HTTPException(
            status_code=404,
            detail=f"Project {project_id} not found. POST /api/projects/{project_id}/clock-in first.",
        ) from exc
    except TimeoutError as exc:
        raise HTTPException(status_code=503, detail=f"Runtime timeout for project {project_id}") from exc
    except RuntimeError as exc:
        raise HTTPException(status_code=503, detail=f"Runtime unavailable: {exc}") from exc


async def _wait_for_multi_results(
    project_id: str,
    task_ids: Dict[str, str],
    timeout_seconds: float = COLLAB_RESULT_TIMEOUT_SECONDS,
    poll_interval_seconds: float = COLLAB_RESULT_POLL_INTERVAL_SECONDS,
) -> Dict[str, Dict[str, Any]]:
    if not task_ids:
        return {}

    loop = asyncio.get_running_loop()
    deadline = loop.time() + timeout_seconds
    latest: Dict[str, Dict[str, Any]] = {}

    while True:
        latest = await _get_multi_results(project_id, task_ids)
        if latest and all(
            str(payload.get("status") or "pending") in TERMINAL_TASK_STATUSES
            for payload in latest.values()
        ):
            return latest
        if loop.time() >= deadline:
            logger.warning(
                "collaboration round timed out waiting for tasks project=%s pending=%s",
                project_id,
                sorted(
                    role
                    for role, payload in latest.items()
                    if str(payload.get("status") or "pending") not in TERMINAL_TASK_STATUSES
                ),
            )
            return latest
        await asyncio.sleep(poll_interval_seconds)


async def _run_team_stage(
    *,
    project_id: str,
    teams: Sequence[AgentTeam],
    prompt: str,
    shared_goal: str,
    prior_contributions: Sequence[Dict[str, Any]],
    project_cwd: str | None,
    planning_brief: Dict[str, Any],
    discovery_only: bool = False,
) -> List[Dict[str, Any]]:
    if not teams:
        return []

    try:
        submitted = await submit_parallel_team_primitives(
            project_id=project_id,
            team_items=[
                {
                    "team": team,
                    "instruction": _build_team_instruction(
                        team,
                        prompt=prompt,
                        shared_goal=shared_goal,
                        prior_contributions=prior_contributions,
                        planning_brief=planning_brief,
                        project_cwd=project_cwd,
                        discovery_only=discovery_only,
                    ),
                    "context": _build_team_context(
                        team,
                        prompt=prompt,
                        shared_goal=shared_goal,
                        prior_contributions=prior_contributions,
                        planning_brief=planning_brief,
                        project_cwd=project_cwd,
                        discovery_only=discovery_only,
                    ),
                }
                for team in teams
            ],
            project_cwd=project_cwd,
        )
    except KeyError as exc:
        raise HTTPException(
            status_code=404,
            detail=f"Project {project_id} not found. POST /api/projects/{project_id}/clock-in first.",
        ) from exc
    except TimeoutError as exc:
        raise HTTPException(status_code=503, detail=f"Runtime timeout for project {project_id}") from exc
    except RuntimeError as exc:
        raise HTTPException(status_code=503, detail=f"Runtime unavailable: {exc}") from exc

    contributions: List[Dict[str, Any]] = []
    for team in teams:
        task_results = await _wait_for_multi_results(project_id, submitted.get(team.value) or {})
        for role, payload in sorted(task_results.items()):
            contributions.append(build_contribution_record(team.value, role, payload))
    return contributions


async def _run_single_role_stage(
    *,
    project_id: str,
    team: AgentTeam,
    role: str,
    prompt: str,
    shared_goal: str,
    prior_contributions: Sequence[Dict[str, Any]],
    project_cwd: str | None,
    planning_brief: Dict[str, Any],
    discovery_only: bool = False,
) -> Dict[str, Any]:
    instruction = _build_team_instruction(
        team,
        prompt=prompt,
        shared_goal=shared_goal,
        prior_contributions=prior_contributions,
        planning_brief=planning_brief,
        project_cwd=project_cwd,
        discovery_only=discovery_only,
    )
    context = _build_team_context(
        team,
        prompt=prompt,
        shared_goal=shared_goal,
        prior_contributions=prior_contributions,
        planning_brief=planning_brief,
        project_cwd=project_cwd,
        discovery_only=discovery_only,
    )

    try:
        task_payload = await manager_action(
            project_id,
            "submit_task",
            {
                "role": role,
                "instruction": instruction,
                "context": context,
            },
            timeout_seconds=20.0,
        )
    except KeyError as exc:
        raise HTTPException(
            status_code=404,
            detail=f"Project {project_id} not found. POST /api/projects/{project_id}/clock-in first.",
        ) from exc
    except TimeoutError as exc:
        raise HTTPException(status_code=503, detail=f"Runtime timeout for project {project_id}") from exc
    except RuntimeError as exc:
        raise HTTPException(status_code=503, detail=f"Runtime unavailable: {exc}") from exc

    task_id = str((task_payload or {}).get("task_id") or "").strip()
    if not task_id:
        return build_contribution_record(
            team.value,
            role,
            {
                "task_id": None,
                "status": "failed",
                "error": f"{role} submission returned no task id",
                "result": {"instruction": instruction},
            },
        )

    task_results = await _wait_for_multi_results(project_id, {role: task_id})
    payload = task_results.get(role) or {
        "task_id": task_id,
        "status": "failed",
        "error": f"{role} returned no result payload",
        "result": {"instruction": instruction},
    }
    return build_contribution_record(team.value, role, payload)


async def _run_review_team_stage(
    *,
    project_id: str,
    prompt: str,
    shared_goal: str,
    prior_contributions: Sequence[Dict[str, Any]],
    project_cwd: str | None,
    planning_brief: Dict[str, Any],
) -> List[Dict[str, Any]]:
    reviewer_contribution = await _run_single_role_stage(
        project_id=project_id,
        team=AgentTeam.REVIEW_TEAM,
        role="reviewer",
        prompt=prompt,
        shared_goal=shared_goal,
        prior_contributions=prior_contributions,
        project_cwd=project_cwd,
        planning_brief=planning_brief,
        discovery_only=False,
    )
    contributions = [reviewer_contribution]
    reviewer_status, _, _, _ = _determine_round_status([*prior_contributions, reviewer_contribution])
    if reviewer_status != "completed":
        return contributions

    verifier_contribution = await _run_single_role_stage(
        project_id=project_id,
        team=AgentTeam.REVIEW_TEAM,
        role="verifier",
        prompt=prompt,
        shared_goal=shared_goal,
        prior_contributions=[*prior_contributions, reviewer_contribution],
        project_cwd=project_cwd,
        planning_brief=planning_brief,
        discovery_only=False,
    )
    contributions.append(verifier_contribution)
    return contributions


async def _ensure_parallel_runtime_for_collaboration(
    *,
    project_id: str,
    project_cwd: str | None,
) -> None:
    try:
        if local_manager_exists(project_id):
            await ensure_parallel_runtime(project_id, get_manager(project_id), project_cwd)
            return

        await manager_action(
            project_id,
            "start_parallel",
            {"project_cwd": project_cwd},
            timeout_seconds=20.0,
        )
    except KeyError as exc:
        raise HTTPException(
            status_code=404,
            detail=f"Project {project_id} not found. POST /api/projects/{project_id}/clock-in first.",
        ) from exc
    except TimeoutError as exc:
        raise HTTPException(status_code=503, detail=f"Runtime timeout for project {project_id}") from exc
    except RuntimeError as exc:
        raise HTTPException(status_code=503, detail=f"Runtime unavailable: {exc}") from exc


async def _synthesize_artifact_with_pm(
    *,
    project_id: str,
    session_id: str,
    round_id: str,
    prompt: str,
    shared_goal: str,
    contributions: List[Dict[str, Any]],
) -> Dict[str, Any]:
    fallback = build_deterministic_artifact(
        session_id=session_id,
        round_id=round_id,
        shared_goal=prompt or shared_goal,
        contributions=contributions,
    )
    if _is_discovery_only_request(prompt, _fallback_planning_brief(prompt, shared_goal)):
        return fallback
    try:
        task_payload = await manager_action(
            project_id,
            "submit_task",
            {
                "role": "pm",
                "instruction": prompt or shared_goal,
                "context": {
                    "mode": "collaboration_synthesis",
                    "prompt": prompt,
                    "shared_goal": shared_goal,
                    "project_guardrails": _project_guardrails(),
                    "contributions": contributions,
                },
            },
            timeout_seconds=20.0,
        )
    except (KeyError, TimeoutError, RuntimeError) as exc:
        logger.warning("pm synthesis unavailable project=%s: %s", project_id, exc)
        return fallback

    task_id = str((task_payload or {}).get("task_id") or "").strip()
    if not task_id:
        return fallback

    pm_results = await _wait_for_multi_results(
        project_id,
        {"pm": task_id},
        timeout_seconds=COLLAB_PM_RESULT_TIMEOUT_SECONDS,
    )
    pm_payload = pm_results.get("pm") or {}
    result = pm_payload.get("result")
    if str(pm_payload.get("status") or "pending") != "completed" or not isinstance(result, dict):
        return fallback

    decision = str(result.get("decision") or "").strip()
    open_questions = _normalize_lines(result.get("open_questions"))
    next_actions = _normalize_lines(result.get("next_actions"))

    return enrich_collaboration_artifact(
        {
            **fallback,
            "decision": decision or fallback["decision"],
            "refined_goal": str(result.get("refined_goal") or fallback.get("refined_goal") or "").strip(),
            "acceptance_criteria": _planning_lines(result.get("acceptance_criteria"))
            or fallback.get("acceptance_criteria", []),
            "deliverables": _planning_lines(result.get("deliverables"))
            or fallback.get("deliverables", []),
            "project_fit_summary": str(result.get("project_fit_summary") or "").strip(),
            "artifact_type": str(result.get("artifact_type") or fallback.get("artifact_type") or "").strip(),
            "open_questions": open_questions or fallback["open_questions"],
            "next_actions": next_actions or fallback["next_actions"],
        },
        shared_goal=prompt or shared_goal,
    )


@router.post("/{project_id}/sessions")
async def create_collaboration_session(
    project_id: str,
    req: CreateSessionRequest,
    _project: uuid.UUID = Depends(require_project_access),
    user: User = Depends(get_current_user),
) -> Dict[str, Any]:
    participants = req.participants or ["pm", "developer", "reviewer", "verifier"]
    session = create_session(
        project_id=project_id,
        owner_user_id=str(user.id),
        shared_goal=req.shared_goal,
        participants=participants,
    )
    await persist_collaboration_session(session)
    return {
        "status": "created",
        "session_id": session["session_id"],
        "shared_goal": session["shared_goal"],
        "participants": session["participants"],
    }


@router.get("/{project_id}/sessions/{session_id}")
async def get_collaboration_session(
    project_id: str,
    session_id: str,
    _project: uuid.UUID = Depends(require_project_access),
) -> Dict[str, Any]:
    session = await load_collaboration_session_from_db(project_id, session_id)
    if session is None:
        raise HTTPException(status_code=404, detail="Session not found")
    if session["project_id"] != project_id:
        raise HTTPException(status_code=403, detail="Forbidden: wrong tenant")
    return session


@router.post("/{project_id}/sessions/{session_id}/stop")
async def stop_collaboration_session(
    project_id: str,
    session_id: str,
    _project: uuid.UUID = Depends(require_project_access),
) -> Dict[str, Any]:
    session = await load_collaboration_session_from_db(project_id, session_id)
    if session is None:
        raise HTTPException(status_code=404, detail="Session not found")
    if session["project_id"] != project_id:
        raise HTTPException(status_code=403, detail="Forbidden: wrong tenant")

    try:
        await manager_action(project_id, "stop_parallel", {}, timeout_seconds=20.0)
    except (KeyError, TimeoutError, RuntimeError) as exc:
        logger.warning(
            "collaboration stop best-effort fallback project=%s session=%s: %s",
            project_id,
            session_id,
            exc,
        )

    return {
        "status": "stopped",
        "session_id": session_id,
        "stopped": True,
        "stop_reason": "user_requested",
    }


@router.post("/{project_id}/sessions/{session_id}/rounds")
async def start_collaboration_round(
    project_id: str,
    session_id: str,
    req: StartRoundRequest,
    _project: uuid.UUID = Depends(require_project_access),
) -> Dict[str, Any]:
    session = await load_collaboration_session_from_db(project_id, session_id)
    if session is None:
        raise HTTPException(status_code=404, detail="Session not found")
    if session["project_id"] != project_id:
        raise HTTPException(status_code=403, detail="Forbidden: wrong tenant")

    parsed_teams: List[AgentTeam] = []
    for item in req.teams:
        try:
            parsed_teams.append(AgentTeam(item))
        except ValueError:
            continue
    if not parsed_teams:
        parsed_teams = [AgentTeam.DEVELOPMENT_TEAM]

    safe_project_cwd = sanitize_project_cwd(req.project_cwd)
    shared_goal = str(session.get("shared_goal", "") or req.prompt)
    round_id = str(uuid.uuid4())
    await _ensure_parallel_runtime_for_collaboration(
        project_id=project_id,
        project_cwd=safe_project_cwd,
    )
    planning_brief = await _plan_round_with_pm(
        project_id=project_id,
        prompt=req.prompt,
        shared_goal=shared_goal,
    )
    discovery_only = _is_discovery_only_request(req.prompt, planning_brief)

    stage_one = [team for team in parsed_teams if team == AgentTeam.DEVELOPMENT_TEAM]
    review_requested = AgentTeam.REVIEW_TEAM in parsed_teams
    downstream_teams = [
        team
        for team in parsed_teams
        if team not in {AgentTeam.DEVELOPMENT_TEAM, AgentTeam.REVIEW_TEAM}
    ]
    if (review_requested or downstream_teams) and discovery_only:
        logger.info(
            "collaboration round using discovery-only fast path project=%s teams=%s prompt=%s",
            project_id,
            [team.value for team in parsed_teams],
            _truncate_text(req.prompt, 160),
        )
        review_requested = False
        downstream_teams = []

    contributions: List[Dict[str, Any]] = []
    contributions.append(
        {
            "team": "planning_team",
            "agent_role": "pm",
            "task_id": f"{round_id}:pm-plan",
            "status": "completed",
            "summary": str(planning_brief.get("plan_summary") or planning_brief.get("refined_goal") or req.prompt),
            "open_questions": [],
            "next_actions": _planning_lines(planning_brief.get("deliverables"))[:4],
            "details": {
                "refined_goal": planning_brief.get("refined_goal"),
                "acceptance_criteria": _planning_lines(planning_brief.get("acceptance_criteria")),
                "deliverables": _planning_lines(planning_brief.get("deliverables")),
                "review_focus": _planning_lines(planning_brief.get("review_focus")),
                "verification_focus": _planning_lines(planning_brief.get("verification_focus")),
                "ops_focus": _planning_lines(planning_brief.get("ops_focus")),
                "execution_card": planning_brief.get("execution_card"),
                "primary_focus": planning_brief.get("primary_focus"),
                "done_for_this_round": planning_brief.get("done_for_this_round"),
                "do_not_expand": _planning_lines(planning_brief.get("do_not_expand")),
            },
        }
    )
    contributions.extend(
        await _run_team_stage(
            project_id=project_id,
            teams=stage_one,
            prompt=req.prompt,
            shared_goal=str(planning_brief.get("refined_goal") or shared_goal),
            prior_contributions=contributions,
            project_cwd=safe_project_cwd,
            planning_brief=planning_brief,
            discovery_only=discovery_only,
        )
    )
    downstream_stages_skipped = False
    current_status, _, _, _ = _determine_round_status(contributions)
    if current_status == "completed" and review_requested:
        contributions.extend(
            await _run_review_team_stage(
                project_id=project_id,
                prompt=req.prompt,
                shared_goal=str(planning_brief.get("refined_goal") or shared_goal),
                prior_contributions=contributions,
                project_cwd=safe_project_cwd,
                planning_brief=planning_brief,
            )
        )
        current_status, _, _, _ = _determine_round_status(contributions)
    elif review_requested:
        downstream_stages_skipped = True

    if current_status == "completed" and downstream_teams:
        contributions.extend(
            await _run_team_stage(
                project_id=project_id,
                teams=downstream_teams,
                prompt=req.prompt,
                shared_goal=str(planning_brief.get("refined_goal") or shared_goal),
                prior_contributions=contributions,
                project_cwd=safe_project_cwd,
                planning_brief=planning_brief,
                discovery_only=False,
            )
        )
    elif downstream_teams:
        downstream_stages_skipped = True

    round_status, pending_roles, failed_roles, blocked_roles = _determine_round_status(contributions)

    if round_status == "completed":
        artifact = await _synthesize_artifact_with_pm(
            project_id=project_id,
            session_id=session_id,
            round_id=round_id,
            prompt=req.prompt,
            shared_goal=shared_goal,
            contributions=contributions,
        )
    else:
        artifact = build_deterministic_artifact(
            session_id=session_id,
            round_id=round_id,
            shared_goal=req.prompt or shared_goal,
            contributions=contributions,
        )
        if pending_roles:
            await _stop_parallel_best_effort(project_id, reason=round_status)

    artifact = _annotate_artifact_with_round_status(
        artifact,
        round_status=round_status,
        pending_roles=pending_roles,
        failed_roles=failed_roles,
        blocked_roles=blocked_roles,
    )
    if downstream_stages_skipped:
        artifact = {
            **artifact,
            "open_questions": _dedupe_lines(
                [
                    "One or more downstream stages were skipped because an earlier stage did not complete cleanly.",
                    *list(artifact.get("open_questions") or []),
                ]
            ),
            "next_actions": _dedupe_lines(
                [
                    "Rerun the round after the upstream stage reaches an evidence-backed pass.",
                    *list(artifact.get("next_actions") or []),
                ]
            ),
        }

    merged = start_round(
        session_id=session_id,
        prompt=req.prompt,
        contributions=contributions,
        shared_goal=shared_goal,
        round_id=round_id,
        artifact=artifact,
        status=round_status,
    )
    artifact = merged["artifact"]
    round_payload = merged["round"]
    await persist_collaboration_round(
        session_id=session_id,
        round_payload=round_payload,
        artifact=artifact,
    )

    await ws_manager.broadcast_to_project(
        project_id,
        type("Obj", (), {"model_dump": lambda self: {
            "type": "COLLAB_ROUND_STARTED",
            "agent_role": "pm",
            "data": {"session_id": session_id, "round_id": round_payload["round_id"]},
            "timestamp": round_payload["created_at"],
        }})(),
    )
    if round_status == "completed":
        await ws_manager.broadcast_to_project(
            project_id,
            type("Obj", (), {"model_dump": lambda self: {
                "type": "COLLAB_ROUND_COMPLETED",
                "agent_role": "pm",
                "data": {"session_id": session_id, "round_id": round_payload["round_id"]},
                "timestamp": round_payload["created_at"],
            }})(),
        )
    await ws_manager.broadcast_to_project(
        project_id,
        type("Obj", (), {"model_dump": lambda self: {
            "type": "COLLAB_ARTIFACT_UPDATED",
            "agent_role": "pm",
            "data": artifact,
            "timestamp": round_payload["created_at"],
        }})(),
    )

    return {
        "status": round_payload["status"],
        "session_id": session_id,
        "round": round_payload,
        "artifact": artifact,
    }
