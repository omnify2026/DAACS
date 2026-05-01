"""
DAACS OS — Execution Nodes
Developer + Designer 에이전트가 실제 코드를 생성하는 노드.

Source: DAACS_v2-dy/daacs/graph/subgraph_builder.py, backend_subgraph.py, frontend_subgraph.py
Adapted: 8-role 매핑 (Developer=코드, Designer=UI, DevOps=인프라)
"""
import json
import logging
from typing import Any, Dict

from ...agents.base_roles import AgentRole
from ..subgraph import parse_file_output

logger = logging.getLogger("daacs.graph.nodes.execution")

# ─── Backend Prompt ───

BACKEND_PROMPT = """You are an expert backend developer. Generate the backend code for this project.

## Project Goal
{goal}

## Plan
{plan}

## API Specification
{api_spec}

## Tech Stack
{tech_stack}

## Instructions
Generate all backend files needed. For each file, use this EXACT format:

FILE: backend/main.py
```python
# your code here
```

FILE: backend/requirements.txt
```
fastapi
uvicorn
```

REQUIREMENTS:
1. Use FastAPI with proper CORS middleware (allow all origins for development)
2. Implement ALL endpoints from the API spec above
3. Include proper error handling and type hints
4. Create a requirements.txt with all dependencies
5. Include a health check endpoint at GET /api/health
6. Use Pydantic V2 models for request/response schemas

{rework_guidance}
"""

# ─── Frontend Prompt ───

FRONTEND_PROMPT = """You are an expert frontend developer. Generate the frontend code for this project.

## Project Goal
{goal}

## Plan
{plan}

## API Specification (Backend endpoints to call)
{api_spec}

## Tech Stack
{tech_stack}

## Instructions
Generate all frontend files needed. For each file, use this EXACT format:

FILE: frontend/package.json
```json
{{ ... }}
```

FILE: frontend/src/App.tsx
```tsx
// your code here
```

REQUIREMENTS:
1. Use React with TypeScript
2. Use Tailwind CSS for styling
3. Create API client functions that call the backend endpoints listed above
4. Include proper loading states and error handling
5. Create a clean, responsive UI
6. Use Vite as the build tool

{rework_guidance}
"""


def _format_api_spec(api_spec: Dict[str, Any]) -> str:
    """API 스펙을 읽기 좋은 문자열로 변환."""
    endpoints = api_spec.get("endpoints", [])
    if not endpoints:
        return "No API endpoints defined."
    lines = []
    for ep in endpoints:
        method = ep.get("method", "GET")
        path = ep.get("path", "/")
        desc = ep.get("description", "")
        lines.append(f"  {method} {path} — {desc}")
    return "\n".join(lines)


async def backend_execution_node(
    state: Dict[str, Any],
    executor=None,
    manager=None,
) -> Dict[str, Any]:
    """
    Backend Execution Node — Developer 에이전트가 백엔드 코드를 생성.

    1. Developer 상태 → WORKING
    2. LLM으로 백엔드 코드 생성
    3. 응답에서 파일 파싱 → backend_files에 저장
    4. Developer → IDLE
    """
    goal = state.get("current_goal", "")
    plan = state.get("orchestrator_plan", "")
    api_spec = state.get("api_spec", {})
    tech_stack = state.get("tech_stack", {})
    iteration = state.get("backend_iteration", 0)
    rework_guidance = state.get("replan_guidance", "")

    logger.info(f"[Backend] Iteration {iteration + 1}, goal: {goal[:80]}")

    # Developer 에이전트 상태 업데이트
    if manager:
        dev = manager.get_agent(AgentRole.DEVELOPER)
        if dev:
            dev.set_task(f"백엔드 구현 (iter {iteration + 1})")

    backend_files: Dict[str, str] = dict(state.get("backend_files", {}))

    if executor:
        rework_section = ""
        if rework_guidance and iteration > 0:
            rework_section = f"\n## REWORK GUIDANCE (Fix these issues)\n{rework_guidance}\n"
            # Include existing files for context
            existing = "\n".join(
                f"FILE: {path}\n```\n{code[:500]}...\n```" if len(code) > 500
                else f"FILE: {path}\n```\n{code}\n```"
                for path, code in backend_files.items()
            )
            if existing:
                rework_section += f"\n## Existing Files (modify as needed)\n{existing}\n"

        prompt = BACKEND_PROMPT.format(
            goal=goal,
            plan=plan,
            api_spec=_format_api_spec(api_spec),
            tech_stack=json.dumps(tech_stack.get("backend", ["FastAPI"]), ensure_ascii=False),
            rework_guidance=rework_section,
        )

        system_prompt = ""
        if manager:
            dev = manager.get_agent(AgentRole.DEVELOPER)
            if dev:
                system_prompt = dev.get_skill_prompt()

        response = await executor.execute(
            role="developer",
            prompt=prompt,
            system_prompt=system_prompt,
        )

        parsed = parse_file_output(response)
        if parsed:
            backend_files.update(parsed)
            logger.info(f"[Backend] Generated {len(parsed)} files: {list(parsed.keys())}")
        else:
            logger.warning("[Backend] No files parsed from LLM response")

    # Developer 완료
    if manager:
        dev = manager.get_agent(AgentRole.DEVELOPER)
        if dev:
            dev.complete_task()

    return {
        "backend_files": backend_files,
        "backend_status": "completed" if backend_files else "failed",
        "backend_iteration": iteration + 1,
    }


async def frontend_execution_node(
    state: Dict[str, Any],
    executor=None,
    manager=None,
) -> Dict[str, Any]:
    """
    Frontend Execution Node — Developer + Designer 에이전트가 프론트엔드 코드를 생성.

    1. Designer 상태 → WORKING (UI 설계)
    2. Developer 상태 → WORKING (코드 구현)
    3. LLM으로 프론트엔드 코드 생성
    4. 응답에서 파일 파싱 → frontend_files에 저장
    """
    goal = state.get("current_goal", "")
    plan = state.get("orchestrator_plan", "")
    api_spec = state.get("api_spec", {})
    tech_stack = state.get("tech_stack", {})
    iteration = state.get("frontend_iteration", 0)
    rework_guidance = state.get("replan_guidance", "")

    logger.info(f"[Frontend] Iteration {iteration + 1}, goal: {goal[:80]}")

    # Designer + Developer 상태
    if manager:
        designer = manager.get_agent(AgentRole.DESIGNER)
        if designer:
            designer.set_task(f"UI 디자인 (iter {iteration + 1})")
        dev = manager.get_agent(AgentRole.DEVELOPER)
        if dev:
            dev.set_task(f"프론트엔드 구현 (iter {iteration + 1})")

    frontend_files: Dict[str, str] = dict(state.get("frontend_files", {}))

    if executor:
        rework_section = ""
        if rework_guidance and iteration > 0:
            rework_section = f"\n## REWORK GUIDANCE (Fix these issues)\n{rework_guidance}\n"
            existing = "\n".join(
                f"FILE: {path}\n```\n{code[:500]}...\n```" if len(code) > 500
                else f"FILE: {path}\n```\n{code}\n```"
                for path, code in frontend_files.items()
            )
            if existing:
                rework_section += f"\n## Existing Files (modify as needed)\n{existing}\n"

        prompt = FRONTEND_PROMPT.format(
            goal=goal,
            plan=plan,
            api_spec=_format_api_spec(api_spec),
            tech_stack=json.dumps(tech_stack.get("frontend", ["React", "Tailwind"]), ensure_ascii=False),
            rework_guidance=rework_section,
        )

        # Designer 역할의 모델을 사용하여 UI 품질 향상
        system_prompt = ""
        if manager:
            designer = manager.get_agent(AgentRole.DESIGNER)
            if designer:
                system_prompt = designer.get_skill_prompt()

        response = await executor.execute(
            role="developer",
            prompt=prompt,
            system_prompt=system_prompt,
        )

        parsed = parse_file_output(response)
        if parsed:
            frontend_files.update(parsed)
            logger.info(f"[Frontend] Generated {len(parsed)} files: {list(parsed.keys())}")
        else:
            logger.warning("[Frontend] No files parsed from LLM response")

    # Designer + Developer 완료
    if manager:
        designer = manager.get_agent(AgentRole.DESIGNER)
        if designer:
            designer.complete_task()
        dev = manager.get_agent(AgentRole.DEVELOPER)
        if dev:
            dev.complete_task()

    return {
        "frontend_files": frontend_files,
        "frontend_status": "completed" if frontend_files else "failed",
        "frontend_iteration": iteration + 1,
    }
