"""PM Agent - planning and collaboration synthesis."""

from __future__ import annotations

import json
from typing import Any, Dict, List, Optional

from .base import BaseAgent
from .base_roles import AgentRole
from .protocol import AgentMessage, MessageType
from .structured_output import extract_json_object, normalize_lines, truncate

SYSTEM_PROMPT = (
    "You are a senior project manager and technical planner. "
    "You analyze requirements, break them into tasks, define API specs, "
    "and assign work to team members (developer, designer, devops, reviewer, verifier). "
    "Respond with: plan (task list), priorities, dependencies, timeline estimate."
)

COLLABORATION_SYNTHESIS_SYSTEM_PROMPT = (
    "You are a senior project manager consolidating multi-agent collaboration. "
    "Return strict JSON only with keys decision, refined_goal, acceptance_criteria, deliverables, "
    "project_fit_summary, artifact_type, open_questions, next_actions. "
    "Base the answer on the supplied contributions. Avoid placeholders and generic filler."
)

COLLABORATION_PLANNING_SYSTEM_PROMPT = (
    "You are a senior project manager preparing a high-quality execution brief for a multi-agent collaboration round. "
    "Return strict JSON only with keys refined_goal, plan_summary, acceptance_criteria, deliverables, "
    "review_focus, verification_focus, ops_focus, execution_card, primary_focus, done_for_this_round, do_not_expand. "
    "Be concrete, implementation-oriented, and avoid filler."
)


def _context_lines(value: Any) -> List[str]:
    if isinstance(value, str):
        return normalize_lines(value.splitlines())
    if isinstance(value, list):
        return normalize_lines([str(item) for item in value])
    return []

def _build_collaboration_prompt(instruction: str, context: Dict[str, Any]) -> str:
    shared_goal = str(context.get("shared_goal") or instruction).strip()
    prompt = str(context.get("prompt") or instruction).strip()
    contributions = context.get("contributions") or []
    guardrails = _context_lines(context.get("project_guardrails"))
    guardrails_block = (
        "Project guardrails:\n"
        + "\n".join(f"- {item}" for item in guardrails)
        + "\n\n"
        if guardrails
        else ""
    )
    return (
        f"Shared goal:\n{shared_goal}\n\n"
        f"User prompt:\n{prompt}\n\n"
        f"{guardrails_block}"
        "Team contributions JSON:\n"
        f"{json.dumps(contributions, ensure_ascii=False, indent=2)}\n\n"
        "Return strict JSON only:\n"
        "{\n"
        '  "decision": "single concise synthesis sentence",\n'
        '  "refined_goal": "best single-sentence goal for this round",\n'
        '  "acceptance_criteria": ["what must be true for this round to count as done"],\n'
        '  "deliverables": ["concrete output that should exist after this round"],\n'
        '  "project_fit_summary": "one sentence about whether the output shape matches the project direction",\n'
        '  "artifact_type": "short noun phrase like multi_agent_round or result_report",\n'
        '  "open_questions": ["blocking question if any"],\n'
        '  "next_actions": ["concrete next action"]\n'
        "}\n"
        "Rules:\n"
        "- Mention concrete blockers and deliverables from the contributions.\n"
        "- Keep decision under 240 characters.\n"
        "- Keep project_fit_summary under 180 characters.\n"
        "- Use empty arrays when there are no real blockers.\n"
        "- Do not invent work that does not appear in the contributions."
    )


def _build_collaboration_planning_prompt(instruction: str, context: Dict[str, Any]) -> str:
    shared_goal = str(context.get("shared_goal") or instruction).strip()
    prompt = str(context.get("prompt") or instruction).strip()
    guardrails = _context_lines(context.get("project_guardrails"))
    guardrails_block = (
        "Project guardrails:\n"
        + "\n".join(f"- {item}" for item in guardrails)
        + "\n\n"
        if guardrails
        else ""
    )
    return (
        f"Shared goal:\n{shared_goal}\n\n"
        f"User request:\n{prompt}\n\n"
        f"{guardrails_block}"
        "Return strict JSON only:\n"
        "{\n"
        '  "refined_goal": "sharpened execution goal",\n'
        '  "plan_summary": "brief execution framing sentence",\n'
        '  "acceptance_criteria": ["concrete outcomes that define done"],\n'
        '  "deliverables": ["deliverable or file/module level outcome"],\n'
        '  "review_focus": ["what reviewer must scrutinize"],\n'
        '  "verification_focus": ["what verifier must prove"],\n'
        '  "ops_focus": ["what operations/devops must prepare"],\n'
        '  "execution_card": "single short execution card for the next implementation turn",\n'
        '  "primary_focus": "the one thing the developer should center this turn on",\n'
        '  "done_for_this_round": "what must be true when this turn is done",\n'
        '  "do_not_expand": ["explicitly out-of-scope items for this turn"]\n'
        "}\n"
        "Rules:\n"
        "- Keep all arrays concise and concrete.\n"
        "- Prefer implementation-ready language over brainstorming.\n"
        "- Include at least 2 acceptance criteria when the request implies implementation work.\n"
        "- execution_card, primary_focus, and done_for_this_round must describe the smallest useful implementation slice for this round.\n"
        "- do_not_expand must protect speed by naming work that should wait for later instead of broadening this turn.\n"
        "- Do not wrap the JSON in markdown fences."
    )


class PMAgent(BaseAgent):
    def __init__(self, project_id: Optional[str] = None):
        super().__init__(AgentRole.PM, project_id)
        self.task_board: Dict[str, List[Dict]] = {
            "backlog": [],
            "in_progress": [],
            "review": [],
            "done": [],
        }

    async def process_message(self, message: AgentMessage):
        if message.type == MessageType.TASK:
            self.set_task("기획 분석 중")
            await self.execute(message.content)
            self.complete_task()

        elif message.type == MessageType.DONE:
            self._move_task_to_done(message.content)

        elif message.type == MessageType.COMMAND:
            self.set_task(f"명령 처리: {message.content}")
            await self.execute(message.content)
            self.complete_task()

    async def execute(self, instruction: str, context: Optional[Dict[str, Any]] = None) -> Dict[str, Any]:
        """PM logic: planning and collaboration synthesis."""
        self.logger.info("PM planning: %s", instruction)

        if context and str(context.get("mode") or "") == "collaboration_planning":
            llm_response = await self.execute_task(
                prompt=_build_collaboration_planning_prompt(instruction, context),
                system_prompt=COLLABORATION_PLANNING_SYSTEM_PROMPT,
                role_override="pm_collaboration",
                include_skill_prompt=False,
            )
            structured = extract_json_object(llm_response)
            return {
                "role": self.role.value,
                "action": "collaboration_planning",
                "instruction": instruction,
                "refined_goal": truncate(
                    structured.get("refined_goal") or context.get("shared_goal") or instruction,
                    240,
                ),
                "plan_summary": truncate(structured.get("plan_summary"), 240),
                "acceptance_criteria": normalize_lines(structured.get("acceptance_criteria")),
                "deliverables": normalize_lines(structured.get("deliverables")),
                "review_focus": normalize_lines(structured.get("review_focus")),
                "verification_focus": normalize_lines(structured.get("verification_focus")),
                "ops_focus": normalize_lines(structured.get("ops_focus")),
                "execution_card": truncate(structured.get("execution_card"), 220),
                "primary_focus": truncate(structured.get("primary_focus"), 180),
                "done_for_this_round": truncate(structured.get("done_for_this_round"), 180),
                "do_not_expand": normalize_lines(structured.get("do_not_expand")),
                "llm_response": llm_response,
                "status": "completed",
            }

        if context and str(context.get("mode") or "") == "collaboration_synthesis":
            llm_response = await self.execute_task(
                prompt=_build_collaboration_prompt(instruction, context),
                system_prompt=COLLABORATION_SYNTHESIS_SYSTEM_PROMPT,
                role_override="pm_collaboration",
                include_skill_prompt=False,
            )
            structured = extract_json_object(llm_response)
            return {
                "role": self.role.value,
                "action": "collaboration_synthesis",
                "instruction": instruction,
                "decision": truncate(structured.get("decision"), 240)
                or f"Synthesized round outcome for: {truncate(context.get('shared_goal') or instruction, 160)}",
                "refined_goal": truncate(
                    structured.get("refined_goal") or context.get("shared_goal") or instruction,
                    240,
                ),
                "acceptance_criteria": normalize_lines(structured.get("acceptance_criteria")),
                "deliverables": normalize_lines(structured.get("deliverables")),
                "project_fit_summary": truncate(structured.get("project_fit_summary"), 180),
                "artifact_type": truncate(structured.get("artifact_type"), 80) or "multi_agent_round",
                "open_questions": normalize_lines(structured.get("open_questions")),
                "next_actions": normalize_lines(structured.get("next_actions")),
                "llm_response": llm_response,
                "status": "completed",
            }

        llm_response = await self.execute_task(
            prompt=instruction,
            system_prompt=SYSTEM_PROMPT,
        )

        return {
            "role": self.role.value,
            "action": "planning",
            "instruction": instruction,
            "llm_response": llm_response,
            "task_board": self.task_board,
            "status": "completed",
        }

    def _move_task_to_done(self, content: Any):
        task_info = content if isinstance(content, dict) else {"description": str(content)}
        self.task_board["done"].append(task_info)
