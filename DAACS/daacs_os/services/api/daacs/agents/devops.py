"""DevOps Agent — 배포, 모니터링, 컨테이너 관리"""
from typing import Any, Dict, Optional

from .base import BaseAgent
from .base_roles import AgentRole
from .protocol import AgentMessage, MessageType
from .structured_output import (
    dedupe_lines,
    first_text,
    normalize_lines,
    render_context_sections,
    safe_extract_json_object,
)

SYSTEM_PROMPT = (
    "You are a senior DevOps engineer. "
    "You handle deployment, CI/CD, Docker, infrastructure, and monitoring. "
    "When writing configs, use the FILE: format. "
    "Provide: deployment_plan, health_checks, container_config, monitoring_setup."
)

COLLABORATION_SYSTEM_PROMPT = (
    "You are the operations lead in a collaboration round. "
    "Return strict JSON only with keys summary, open_questions, next_actions, deployment_plan, health_checks, monitoring_setup. "
    "Focus on rollout safety, observability, runtime reliability, and operational risk."
)


def _build_collaboration_prompt(instruction: str, context: Dict[str, Any], role: AgentRole) -> str:
    member_instructions = context.get("member_instructions") or {}
    role_objective = str(member_instructions.get(role.value) or "").strip()
    prompt = (
        render_context_sections(
            [
                ("Shared Goal", context.get("shared_goal") or context.get("goal") or instruction),
                ("User Request", context.get("prompt") or instruction),
                ("Role Objective", role_objective),
                ("Acceptance Criteria", context.get("acceptance_criteria")),
                ("Prior Artifacts", context.get("artifacts")),
                ("Code / Diff Context", context.get("code")),
            ]
        )
        or instruction
    )
    return (
        f"{prompt}\n\n"
        "Return strict JSON only:\n"
        "{\n"
        '  "summary": "operations conclusion with concrete rollout scope",\n'
        '  "open_questions": ["operational dependency or gap"],\n'
        '  "next_actions": ["highest priority operational action"],\n'
        '  "deployment_plan": ["rollout step"],\n'
        '  "health_checks": ["runtime or canary check"],\n'
        '  "monitoring_setup": ["alert, metric, or dashboard action"]\n'
        "}\n"
        "Rules:\n"
        "- Prefer concrete rollout and monitoring actions.\n"
        "- Use empty arrays when there is no real gap.\n"
        "- Do not wrap the JSON in markdown fences."
    )


class DevOpsAgent(BaseAgent):
    def __init__(self, project_id: Optional[str] = None):
        super().__init__(AgentRole.DEVOPS, project_id)
        self.deployment_log: list = []

    async def process_message(self, message: AgentMessage):
        if message.type == MessageType.TASK:
            self.set_task("배포 준비 중")
            result = await self.execute(str(message.content))
            self.complete_task()

        elif message.type == MessageType.COMMAND:
            self.set_task(f"명령 처리: {message.content}")
            result = await self.execute(str(message.content))
            self.complete_task()

    async def execute(self, instruction: str, context: Optional[Dict[str, Any]] = None) -> Dict[str, Any]:
        """DevOps 핵심 로직: LLM 기반 배포 + 인프라 관리"""
        self.logger.info(f"DevOps executing: {instruction}")

        if context and str(context.get("mode") or "") == "collaboration_round":
            llm_response = await self.execute_task(
                prompt=_build_collaboration_prompt(instruction, context, self.role),
                system_prompt=COLLABORATION_SYSTEM_PROMPT,
                include_skill_prompt=False,
            )
            structured = safe_extract_json_object(llm_response)
            deployment_plan = normalize_lines(structured.get("deployment_plan"))
            health_checks = normalize_lines(structured.get("health_checks"))
            monitoring_setup = normalize_lines(structured.get("monitoring_setup"))
            next_actions = dedupe_lines(
                normalize_lines(structured.get("next_actions"))
                + deployment_plan
                + health_checks
                + monitoring_setup
            )
            result = {
                "role": self.role.value,
                "action": "collaboration_operations",
                "instruction": instruction,
                "summary": first_text(
                    [
                        structured.get("summary"),
                        llm_response,
                        instruction,
                    ]
                ),
                "open_questions": normalize_lines(structured.get("open_questions")),
                "next_actions": next_actions,
                "deployment_plan": deployment_plan,
                "health_checks": health_checks,
                "monitoring_setup": monitoring_setup,
                "llm_response": llm_response,
                "status": "completed",
            }
            self.deployment_log.append(result)
            return result

        llm_response = await self.execute_task(
            prompt=instruction,
            system_prompt=SYSTEM_PROMPT,
        )

        result = {
            "role": self.role.value,
            "action": "deployment",
            "instruction": instruction,
            "llm_response": llm_response,
            "status": "completed",
        }
        self.deployment_log.append(result)
        return result
