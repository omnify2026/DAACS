"""Reviewer Agent — 코드 리뷰, 품질 검사, PR 관리 (기존 ReviewerAgent 계승)"""
from typing import Any, Dict, Optional

from .base import BaseAgent
from .base_roles import AgentRole, AgentStatus
from .protocol import AgentMessage, MessageType
from .structured_output import (
    clean_text,
    dedupe_lines,
    first_text,
    normalize_lines,
    render_context_sections,
    safe_extract_json_object,
)

SYSTEM_PROMPT = (
    "You are a senior code reviewer. "
    "Analyze code for quality, security, performance, and best practices. "
    "Provide: score (0-10), issues (list), suggestions, and an overall verdict (pass/fail)."
)

COLLABORATION_SYSTEM_PROMPT = (
    "You are a principal reviewer in a collaboration round. "
    "Return strict JSON only with keys summary, issues, open_questions, next_actions, score, verdict. "
    "Focus on concrete regressions, missing tests, release blockers, user-visible requirement coverage, "
    "and code quality risks. Treat transient generated artifacts as evidence unless the user explicitly "
    "asked to keep them."
)


def _normalize_collaboration_review(
    structured: Dict[str, Any],
) -> tuple[list[str], list[str], list[str], str]:
    issues = normalize_lines(structured.get("issues"))
    open_questions = normalize_lines(structured.get("open_questions"))
    next_actions = normalize_lines(structured.get("next_actions"))
    verdict = clean_text(structured.get("verdict")).lower()
    invalid_pass_with_issues = verdict == "pass" and bool(issues)
    invalid_pass_with_questions = verdict == "pass" and bool(open_questions)

    if verdict not in {"pass", "fail"}:
        open_questions = dedupe_lines([*open_questions, "Reviewer verdict was missing or invalid."])
        next_actions = dedupe_lines([*next_actions, "Return an explicit pass/fail verdict backed by concrete findings."])
        verdict = "fail"

    if invalid_pass_with_issues:
        next_actions = dedupe_lines([*next_actions, "Resolve the outstanding review issues before treating this work as passing."])
        verdict = "fail"

    if invalid_pass_with_questions:
        next_actions = dedupe_lines([*next_actions, "Close the unresolved review questions before treating this work as passing."])
        verdict = "fail"

    return issues, open_questions, next_actions, verdict


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
        '  "summary": "top review conclusion with concrete scope",\n'
        '  "issues": ["defect or regression"],\n'
        '  "open_questions": ["blocking clarification"],\n'
        '  "next_actions": ["highest priority fix"],\n'
        '  "score": 0,\n'
        '  "verdict": "pass|fail"\n'
        "}\n"
        "Rules:\n"
        "- Prefer concrete defects over generic caution.\n"
        "- If any acceptance criterion or user-visible requirement is missing, verdict must be fail.\n"
        "- Do not approve transient generated artifacts as permanent project scope unless the user explicitly asked to keep them.\n"
        "- Use empty arrays when there are no real issues.\n"
        "- Do not wrap the JSON in markdown fences."
    )


class ReviewerAgent(BaseAgent):
    def __init__(self, project_id: Optional[str] = None):
        super().__init__(AgentRole.REVIEWER, project_id)
        self.review_history: list = []

    async def process_message(self, message: AgentMessage):
        if message.type == MessageType.REQUEST:
            content = message.content if isinstance(message.content, dict) else {}
            file_name = content.get("file", "unknown")
            self.set_task(f"리뷰 중: {file_name}")
            self.update_status(AgentStatus.MEETING, f"코드 리뷰: {file_name}")
            result = await self.execute(f"Review {file_name}", context=content)
            self.complete_task()

        elif message.type == MessageType.COMMAND:
            self.set_task(f"명령 처리: {message.content}")
            result = await self.execute(str(message.content))
            self.complete_task()

    async def execute(self, instruction: str, context: Optional[Dict[str, Any]] = None) -> Dict[str, Any]:
        """Reviewer 핵심 로직: LLM 기반 코드 리뷰 + 품질 점수"""
        self.logger.info(f"Reviewer reviewing: {instruction}")

        if context and str(context.get("mode") or "") == "collaboration_round":
            llm_response = await self.execute_task(
                prompt=_build_collaboration_prompt(instruction, context, self.role),
                system_prompt=COLLABORATION_SYSTEM_PROMPT,
                role_override="reviewer_collaboration",
                include_skill_prompt=False,
            )
            structured = safe_extract_json_object(llm_response)
            issues, open_questions, next_actions, verdict = _normalize_collaboration_review(structured)
            return {
                "role": self.role.value,
                "action": "collaboration_review",
                "instruction": instruction,
                "summary": first_text(
                    [
                        structured.get("summary"),
                        llm_response,
                        instruction,
                    ]
                ),
                "issues": issues,
                "open_questions": open_questions,
                "next_actions": next_actions,
                "score": structured.get("score"),
                "verdict": verdict,
                "llm_response": llm_response,
                "status": "completed",
            }

        prompt = instruction
        if context and "code" in context:
            prompt += f"\n\n## Code to review:\n```\n{context['code']}\n```"

        llm_response = await self.execute_task(
            prompt=prompt,
            system_prompt=SYSTEM_PROMPT,
        )

        review_result = {
            "role": self.role.value,
            "action": "code_review",
            "instruction": instruction,
            "llm_response": llm_response,
            "status": "completed",
        }
        self.review_history.append(review_result)
        return review_result
