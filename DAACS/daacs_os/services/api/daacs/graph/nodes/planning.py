"""
DAACS OS — Planning Node
PM + CEO가 프로젝트 목표를 분석하고 실행 계획 + API 스펙을 생성.

Source: DAACS_v2-dy/daacs/graph/orchestrator_planning.py
Adapted: DAACS_OS 8-role 매핑 (PM = 계획, CEO = 승인, CFO = 예산 검토)
"""
import json
import logging
from typing import Any, Dict, Optional

from ...agents.base_roles import AgentRole, AgentStatus

logger = logging.getLogger("daacs.graph.nodes.planning")

# ─── Planning Prompt Template ───

PLANNING_PROMPT = """You are an expert project planner for a software development team.

## Project Goal
{goal}

## Instructions
Analyze the project goal and create a detailed execution plan.
You MUST respond with a valid JSON object containing:

{{
    "plan": "Detailed step-by-step plan for the project",
    "needs_backend": true/false,
    "needs_frontend": true/false,
    "tech_stack": {{
        "backend": ["FastAPI", "SQLAlchemy", ...],
        "frontend": ["React", "Tailwind", ...]
    }},
    "api_spec": {{
        "endpoints": [
            {{"method": "GET", "path": "/api/health", "description": "Health check"}},
            {{"method": "GET", "path": "/api/items", "description": "List items"}},
            ...
        ]
    }},
    "tasks": [
        {{"title": "Task title", "assignee": "developer", "priority": "high"}},
        ...
    ],
    "qa_profile": "lite|standard|ui|strict",
    "acceptance_criteria": [
        "Concrete outcome that must be true before completion"
    ]
}}

IMPORTANT:
- Always include a /api/health endpoint
- Use FastAPI for backend, React with Tailwind for frontend
- Be specific about file structure and implementation details
- If the goal is simple, still create proper API endpoints
- Prefer task assignees from: pm, developer, designer, reviewer, verifier, devops
- Select the lightest qa_profile that still matches the task risk
"""


def _extract_json(response: str) -> Dict[str, Any]:
    """LLM 응답에서 JSON 추출."""
    # Try direct parse
    try:
        return json.loads(response)
    except json.JSONDecodeError:
        pass

    # Try extracting from code block
    for marker in ["```json", "```"]:
        if marker in response:
            start = response.index(marker) + len(marker)
            end = response.index("```", start) if "```" in response[start:] else len(response)
            try:
                return json.loads(response[start:end].strip())
            except (json.JSONDecodeError, ValueError):
                pass

    # Try finding first { ... last }
    first_brace = response.find("{")
    last_brace = response.rfind("}")
    if first_brace >= 0 and last_brace > first_brace:
        try:
            return json.loads(response[first_brace:last_brace + 1])
        except json.JSONDecodeError:
            pass

    logger.warning("[Planning] Failed to parse JSON from LLM response")
    return {}


def _validate_plan(data: Dict[str, Any]) -> Dict[str, Any]:
    """계획 데이터 유효성 검증 + 기본값 채우기."""
    if not data.get("plan"):
        data["plan"] = "Auto-generated plan based on the project goal."

    if "needs_backend" not in data:
        data["needs_backend"] = True
    if "needs_frontend" not in data:
        data["needs_frontend"] = True

    if not data.get("api_spec"):
        data["api_spec"] = {
            "endpoints": [
                {"method": "GET", "path": "/api/health", "description": "Health check"},
            ]
        }

    if not data.get("tech_stack"):
        data["tech_stack"] = {
            "backend": ["FastAPI", "uvicorn"],
            "frontend": ["React", "Tailwind CSS"],
        }

    if not isinstance(data.get("acceptance_criteria"), list):
        data["acceptance_criteria"] = []

    if not data.get("qa_profile"):
        needs_backend = bool(data.get("needs_backend", True))
        needs_frontend = bool(data.get("needs_frontend", True))
        data["qa_profile"] = "ui" if needs_backend and needs_frontend else "standard"

    return data


def _default_evidence_required(
    qa_profile: str,
    needs_backend: bool,
    needs_frontend: bool,
) -> list[str]:
    requirements: list[str] = []

    if needs_backend:
        requirements.append("backend_files")
    if needs_frontend:
        requirements.append("frontend_files")

    if qa_profile in {"standard", "ui", "strict"}:
        requirements.append("python_json_syntax")
    if needs_backend and qa_profile in {"standard", "ui", "strict"}:
        requirements.append("api_compliance")
    if needs_backend and qa_profile == "strict":
        requirements.append("cors_check")

    return requirements


def _derive_acceptance_criteria(data: Dict[str, Any]) -> list[str]:
    criteria = [
        str(item).strip()
        for item in data.get("acceptance_criteria", [])
        if str(item).strip()
    ]
    if criteria:
        return criteria

    derived: list[str] = []
    for endpoint in data.get("api_spec", {}).get("endpoints", []) or []:
        method = str(endpoint.get("method") or "GET").strip().upper()
        path = str(endpoint.get("path") or "").strip()
        if path:
            derived.append(f"{method} {path} is implemented")

    if data.get("needs_frontend", True):
        derived.append("Frontend deliverables are present and non-empty")

    return derived[:8]


def _derive_active_roles(data: Dict[str, Any]) -> list[str]:
    roles = {"pm"}

    if data.get("needs_backend", True) or data.get("needs_frontend", True):
        roles.add("developer")
        roles.add("reviewer")
        roles.add("verifier")

    if data.get("needs_frontend", True):
        roles.add("designer")

    task_roles = {
        str(task.get("assignee", "")).strip()
        for task in data.get("tasks", [])
        if isinstance(task, dict) and str(task.get("assignee", "")).strip()
    }
    roles.update(task_roles)

    ordered = ["pm", "developer", "designer", "reviewer", "verifier", "devops", "ceo", "cfo", "marketer"]
    return [role for role in ordered if role in roles]


def _build_orchestration_policy(data: Dict[str, Any], active_roles: list[str]) -> Dict[str, Any]:
    execution_handoffs: list[str] = []
    if data.get("needs_backend", True):
        execution_handoffs.append("execute_backend")
    if data.get("needs_frontend", True):
        execution_handoffs.append("execute_frontend")

    quality_handoffs: list[str] = []
    if "reviewer" in active_roles:
        quality_handoffs.append("review")
    if "verifier" in active_roles:
        quality_handoffs.append("verification")

    return {
        "execution_handoffs": execution_handoffs,
        "quality_handoffs": quality_handoffs,
        "replan_handoff": "replanning" if "pm" in active_roles else None,
        "allow_skip_review": "reviewer" not in active_roles,
        "allow_skip_verification": "verifier" not in active_roles,
    }


async def planning_node(
    state: Dict[str, Any],
    executor=None,
    manager=None,
) -> Dict[str, Any]:
    """
    Planning Node — PM이 프로젝트 계획을 수립.

    1. PM 에이전트 상태 → WORKING
    2. LLM으로 프로젝트 분석 + 계획 생성
    3. API 스펙, 기술 스택, 백/프론트 필요 여부 결정
    4. PM → IDLE

    Returns:
        orchestrator_plan, needs_backend, needs_frontend, api_spec, tech_stack
    """
    goal = state.get("current_goal", "")
    logger.info(f"[Planning] Goal: {goal}")

    # PM 에이전트 상태 업데이트
    if manager:
        pm = manager.get_agent(AgentRole.PM)
        if pm:
            pm.set_task("프로젝트 분석 및 계획 수립")

    # LLM 호출
    if executor:
        prompt = PLANNING_PROMPT.format(goal=goal)

        # PM의 스킬 프롬프트를 시스템 프롬프트로 주입
        system_prompt = ""
        if manager:
            pm = manager.get_agent(AgentRole.PM)
            if pm:
                system_prompt = pm.get_skill_prompt()

        response = await executor.execute(
            role="pm",
            prompt=prompt,
            system_prompt=system_prompt,
        )

        data = _extract_json(response)
        data = _validate_plan(data)
    else:
        # Executor 없으면 기본 계획
        data = _validate_plan({"plan": f"Default plan for: {goal}"})

    # PM 작업 완료
    if manager:
        pm = manager.get_agent(AgentRole.PM)
        if pm:
            pm.complete_task()

    logger.info(
        f"[Planning] Plan generated: backend={data.get('needs_backend')}, "
        f"frontend={data.get('needs_frontend')}, "
        f"endpoints={len(data.get('api_spec', {}).get('endpoints', []))}"
    )

    active_roles = _derive_active_roles(data)
    orchestration_policy = _build_orchestration_policy(data, active_roles)
    qa_profile = str(data.get("qa_profile") or "standard").strip().lower()
    evidence_required = _default_evidence_required(
        qa_profile=qa_profile,
        needs_backend=bool(data.get("needs_backend", True)),
        needs_frontend=bool(data.get("needs_frontend", True)),
    )
    acceptance_criteria = _derive_acceptance_criteria(data)

    return {
        "orchestrator_plan": data.get("plan", ""),
        "needs_backend": data.get("needs_backend", True),
        "needs_frontend": data.get("needs_frontend", True),
        "api_spec": data.get("api_spec", {}),
        "tech_stack": data.get("tech_stack", {}),
        "active_roles": active_roles,
        "orchestration_policy": orchestration_policy,
        "qa_profile": qa_profile,
        "acceptance_criteria": acceptance_criteria,
        "evidence_required": evidence_required,
        "pending_handoffs": orchestration_policy.get("execution_handoffs", []) + orchestration_policy.get("quality_handoffs", []),
        "logs": [f"planning: plan generated, {len(data.get('api_spec', {}).get('endpoints', []))} endpoints"],
    }
