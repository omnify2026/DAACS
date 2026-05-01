"""Deterministic collaboration helpers for team rounds."""

from __future__ import annotations

from typing import Any, Dict, Iterable, List, Sequence


_PATH_SUFFIXES = (".tsx", ".jsx", ".ts", ".js", ".py", ".rs", ".go", ".json", ".md")


def _clean_text(value: Any) -> str:
    return str(value or "").strip()


def _truncate(value: Any, limit: int = 320) -> str:
    text = " ".join(_clean_text(value).split())
    if len(text) <= limit:
        return text
    return f"{text[: max(limit - 3, 0)].rstrip()}..."


def _normalize_lines(items: Iterable[Any]) -> List[str]:
    cleaned: List[str] = []
    for item in items:
        if not isinstance(item, str):
            continue
        value = item.strip()
        if value:
            cleaned.append(value)
    return cleaned


def _dedupe_lines(items: Sequence[str]) -> List[str]:
    seen: set[str] = set()
    ordered: List[str] = []
    for item in items:
        value = item.strip()
        if not value or value in seen:
            continue
        seen.add(value)
        ordered.append(value)
    return ordered


def _coerce_lines(value: Any) -> List[str]:
    if value is None:
        return []
    if isinstance(value, str):
        parts = [segment.strip(" -*\t") for segment in value.splitlines()]
        return _normalize_lines(parts or [value])
    if isinstance(value, (list, tuple, set)):
        lines: List[str] = []
        for item in value:
            lines.extend(_coerce_lines(item))
        return lines
    return []


def _looks_like_path(value: str) -> bool:
    normalized = value.strip()
    if not normalized or any(char.isspace() for char in normalized):
        return False
    if normalized.endswith(_PATH_SUFFIXES):
        return "/" in normalized or normalized in {"AGENTS.md", "README.md"}
    return "/" in normalized and "." in normalized.rsplit("/", 1)[-1]


def _derive_discovery_checklist_paths(
    shared_goal: str,
    contributions: Sequence[Dict[str, Any]],
) -> List[str]:
    lowered_goal = _clean_text(shared_goal).lower()
    discovery_tokens = (
        "checklist",
        "exact file path",
        "exact file paths",
        "체크리스트",
        "경로",
    )
    if not any(token in lowered_goal for token in discovery_tokens):
        return []

    collected: List[str] = []
    for item in contributions:
        details = item.get("details")
        if not isinstance(details, dict):
            continue
        for key in ("new_files", "files"):
            for path in _coerce_lines(details.get(key)):
                if _looks_like_path(path):
                    collected.append(path)
        checklist = details.get("discovery_checklist")
        if isinstance(checklist, list):
            for checklist_item in checklist:
                if not isinstance(checklist_item, dict):
                    continue
                path = _clean_text(checklist_item.get("path"))
                if _looks_like_path(path):
                    collected.append(path)
    return _dedupe_lines(collected)


def _first_text(values: Sequence[Any], *, limit: int = 320) -> str:
    for value in values:
        text = _truncate(value, limit)
        if text:
            return text
    return ""


def _planning_details(contributions: Sequence[Dict[str, Any]]) -> Dict[str, Any]:
    for item in contributions:
        if str(item.get("team", "")).strip() != "planning_team":
            continue
        details = item.get("details")
        if isinstance(details, dict):
            return details
    return {}


def _default_project_fit_summary(
    refined_goal: str,
    deliverables: Sequence[str],
    acceptance_criteria: Sequence[str],
    shared_goal: str,
) -> str:
    if refined_goal and deliverables and acceptance_criteria:
        return _truncate(
            f"추천 이유: '{refined_goal}' 목표에 맞춰 결과물 {len(deliverables)}개와 "
            f"확인 기준 {len(acceptance_criteria)}개가 함께 정리되어 있습니다.",
            220,
        )
    if refined_goal and deliverables:
        return _truncate(
            f"추천 이유: '{refined_goal}' 목표에 맞는 결과물 {len(deliverables)}개가 정리되어 있습니다. "
            "다만 확인 기준은 더 채우면 좋습니다.",
            220,
        )
    goal = refined_goal or _truncate(shared_goal, 120)
    if goal:
        return _truncate(
            f"추천 이유: '{goal}' 방향은 잡혀 있습니다. 아직 결과물과 확인 기준은 더 또렷하게 만들 필요가 있습니다.",
            220,
        )
    return "추천 이유: 여러 의견은 합쳐졌지만, 결과물과 확인 기준은 더 쉽게 정리해야 합니다."


def _has_hangul(value: str) -> bool:
    return any("\uac00" <= char <= "\ud7a3" for char in value)


def _normalize_project_fit_summary(
    value: Any,
    refined_goal: str,
    deliverables: Sequence[str],
    acceptance_criteria: Sequence[str],
    shared_goal: str,
) -> str:
    summary = _truncate(value, 220)
    if summary and _has_hangul(summary):
        return summary
    return _default_project_fit_summary(
        refined_goal,
        deliverables,
        acceptance_criteria,
        shared_goal,
    )


def enrich_collaboration_artifact(
    artifact: Dict[str, Any],
    *,
    shared_goal: str = "",
) -> Dict[str, Any]:
    contributions = artifact.get("contributions")
    team_order = {
        "planning_team": 0,
        "development_team": 1,
        "review_team": 2,
        "operations_team": 3,
    }
    ordered = sorted(
        list(contributions) if isinstance(contributions, list) else [],
        key=lambda x: (
            team_order.get(str(x.get("team", "")), 99),
            str(x.get("team", "")),
            str(x.get("agent_role", "")),
            str(x.get("task_id", "")),
        ),
    )
    planning_details = _planning_details(ordered)
    refined_goal = _truncate(
        artifact.get("refined_goal") or planning_details.get("refined_goal") or shared_goal,
        240,
    )
    artifact_type = _clean_text(artifact.get("artifact_type")) or "multi_agent_round"
    if artifact_type == "discovery_checklist":
        acceptance_criteria = _dedupe_lines(
            [
                *_coerce_lines(planning_details.get("acceptance_criteria")),
                *_coerce_lines(artifact.get("acceptance_criteria")),
            ]
        )
        deliverables = _dedupe_lines(_coerce_lines(artifact.get("deliverables")))
    else:
        acceptance_criteria = _dedupe_lines(
            [
                *_coerce_lines(planning_details.get("acceptance_criteria")),
                *_coerce_lines(artifact.get("acceptance_criteria")),
            ]
        )
        deliverables = _dedupe_lines(
            [
                *_coerce_lines(planning_details.get("deliverables")),
                *_coerce_lines(artifact.get("deliverables")),
            ]
        )
    project_fit_summary = _normalize_project_fit_summary(
        artifact.get("project_fit_summary"),
        refined_goal,
        deliverables,
        acceptance_criteria,
        shared_goal,
    )
    return {
        **artifact,
        "artifact_type": artifact_type,
        "refined_goal": refined_goal,
        "acceptance_criteria": acceptance_criteria,
        "deliverables": deliverables,
        "project_fit_summary": project_fit_summary,
        "contributions": ordered,
    }


def _detail_snapshot(result_payload: Dict[str, Any], error: str) -> Dict[str, Any]:
    details: Dict[str, Any] = {}
    action = _clean_text(result_payload.get("action"))
    instruction = _truncate(result_payload.get("instruction"), 240)
    llm_response = _truncate(result_payload.get("llm_response"), 600)

    if action:
        details["action"] = action
    if instruction:
        details["instruction"] = instruction
    if llm_response:
        details["llm_response_excerpt"] = llm_response

    new_files = result_payload.get("new_files")
    if isinstance(new_files, list) and new_files:
        details["new_files"] = [str(item) for item in new_files if str(item).strip()]

    discovery_checklist = result_payload.get("discovery_checklist")
    if isinstance(discovery_checklist, list):
        normalized_checklist: List[Dict[str, str]] = []
        for item in discovery_checklist:
            if not isinstance(item, dict):
                continue
            path = _clean_text(item.get("path"))
            target = _clean_text(item.get("target"))
            if not path or not target:
                continue
            normalized_item = {
                "target": target,
                "path": path,
            }
            symbol = _clean_text(item.get("symbol"))
            evidence_text = _truncate(item.get("evidence"), 240)
            if symbol:
                normalized_item["symbol"] = symbol
            if evidence_text:
                normalized_item["evidence"] = evidence_text
            normalized_checklist.append(normalized_item)
        if normalized_checklist:
            details["discovery_checklist"] = normalized_checklist

    files = result_payload.get("files")
    if isinstance(files, dict) and files:
        details["files"] = [str(path) for path in files.keys() if str(path).strip()]
    elif isinstance(files, list) and files:
        details["files"] = [str(path) for path in files if str(path).strip()]

    verdict = _clean_text(result_payload.get("verdict"))
    if verdict:
        details["verdict"] = verdict

    score = result_payload.get("score")
    if isinstance(score, (int, float, str)) and _clean_text(score):
        details["score"] = score

    for key in ("checks", "evidence", "deployment_plan", "health_checks", "monitoring_setup"):
        value = _coerce_lines(result_payload.get(key))
        if value:
            details[key] = value

    if error:
        details["error"] = error

    return details


def build_contribution_record(
    team_name: str,
    agent_role: str,
    payload: Dict[str, Any],
) -> Dict[str, Any]:
    result_payload = payload.get("result")
    normalized_result = result_payload if isinstance(result_payload, dict) else {}
    status = _clean_text(payload.get("status")) or "pending"
    error = _truncate(
        payload.get("error") or normalized_result.get("error"),
        240,
    )
    summary_limit = 800 if _clean_text(normalized_result.get("action")) == "collaboration_discovery" else 320

    summary = _first_text(
        [
            normalized_result.get("summary"),
            normalized_result.get("llm_response"),
            normalized_result.get("output"),
            error,
            normalized_result.get("instruction"),
            status,
        ],
        limit=summary_limit,
    )

    open_questions = _dedupe_lines(
        _coerce_lines(normalized_result.get("open_questions"))
        + _coerce_lines(normalized_result.get("questions"))
        + _coerce_lines(normalized_result.get("blockers"))
        + _coerce_lines(normalized_result.get("issues"))
    )

    next_actions = _dedupe_lines(
        _coerce_lines(normalized_result.get("next_actions"))
        + _coerce_lines(normalized_result.get("follow_up"))
        + _coerce_lines(normalized_result.get("suggestions"))
    )

    if not next_actions:
        new_files = normalized_result.get("new_files")
        if isinstance(new_files, list) and new_files:
            joined = ", ".join(str(item) for item in new_files if str(item).strip())
            if joined:
                next_actions.append(f"Inspect generated files: {joined}")

    if status == "failed" and error:
        open_questions = _dedupe_lines([*open_questions, f"{agent_role} failed: {error}"])
        next_actions = _dedupe_lines([*next_actions, f"Resolve {agent_role} failure and rerun the round."])

    contribution = {
        "team": team_name,
        "agent_role": agent_role,
        "task_id": payload.get("task_id"),
        "status": status,
        "summary": summary or f"{agent_role} reported {status}.",
        "open_questions": open_questions,
        "next_actions": next_actions,
    }

    details = _detail_snapshot(normalized_result, error)
    if details:
        contribution["details"] = details

    return contribution


def build_deterministic_artifact(
    session_id: str,
    round_id: str,
    shared_goal: str,
    contributions: List[Dict[str, Any]],
) -> Dict[str, Any]:
    team_order = {
        "planning_team": 0,
        "development_team": 1,
        "review_team": 2,
        "operations_team": 3,
    }
    ordered = sorted(
        contributions,
        key=lambda x: (
            team_order.get(str(x.get("team", "")), 99),
            str(x.get("team", "")),
            str(x.get("agent_role", "")),
            str(x.get("task_id", "")),
        ),
    )

    open_questions: List[str] = []
    next_actions: List[str] = []
    decision_candidates: List[tuple[int, int, str]] = []
    for item in ordered:
        team = str(item.get("team", ""))
        role = _clean_text(item.get("agent_role")) or "agent"
        status = _clean_text(item.get("status")) or "pending"
        summary = _truncate(item.get("summary"), 120)
        if summary:
            team_priority = {
                "development_team": 0,
                "review_team": 1,
                "operations_team": 2,
                "planning_team": 3,
            }.get(team, 99)
            status_priority = 0 if status == "completed" else 1
            decision_candidates.append((status_priority, team_priority, summary))
        open_questions.extend(_coerce_lines(item.get("open_questions")))
        next_actions.extend(_coerce_lines(item.get("next_actions")))

    open_questions = _dedupe_lines(open_questions)
    next_actions = _dedupe_lines(next_actions)
    discovery_checklist_paths = _derive_discovery_checklist_paths(shared_goal, ordered)

    if decision_candidates:
        ordered_summaries = sorted(decision_candidates, key=lambda item: (item[0], item[1], item[2]))
        non_planning_summaries = [summary for _, team_priority, summary in ordered_summaries if team_priority < 3]
        preferred_summaries = non_planning_summaries or [
            summary
            for _, _, summary in ordered_summaries
        ]
        lead = "; ".join(preferred_summaries[:2])
        remainder = len(preferred_summaries) - 2
        suffix = f" (+{remainder} more)" if remainder > 0 else ""
        decision = _truncate(f"{lead}{suffix}", 280)
    else:
        decision = f"Round {round_id} completed for goal: {_truncate(shared_goal, 180)}"

    return enrich_collaboration_artifact(
        {
            "session_id": session_id,
            "round_id": round_id,
            "artifact_type": "discovery_checklist" if discovery_checklist_paths else "multi_agent_round",
            "decision": decision,
            "acceptance_criteria": [],
            "deliverables": discovery_checklist_paths,
            "open_questions": open_questions,
            "next_actions": next_actions,
            "contributions": ordered,
        },
        shared_goal=shared_goal,
    )
