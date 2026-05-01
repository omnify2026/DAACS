"""Verifier Agent — 테스트, 빌드, 린트, 실행 검증 증거 수집."""
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
    "You are a senior verification engineer. "
    "Validate implementation quality with concrete checks and evidence. "
    "Focus on tests, lint/build status, acceptance criteria coverage, regression risk, "
    "and deployment readiness. "
    "Provide: verdict (pass/fail), checks (list), evidence (list), blockers, and follow_up."
)

COLLABORATION_SYSTEM_PROMPT = (
    "You are the verification lead in a collaboration round. "
    "Return strict JSON only with keys summary, blockers, open_questions, next_actions, checks, evidence, verdict. "
    "Focus on acceptance criteria coverage, user-perspective flow evidence, missing evidence, regression risk, "
    "and release readiness."
)


def _normalize_collaboration_verification(
    structured: Dict[str, Any],
) -> tuple[list[str], list[str], list[str], list[str], list[str], str]:
    blockers = normalize_lines(structured.get("blockers"))
    open_questions = dedupe_lines(
        blockers + normalize_lines(structured.get("open_questions"))
    )
    next_actions = normalize_lines(structured.get("next_actions"))
    checks = normalize_lines(structured.get("checks"))
    evidence = normalize_lines(structured.get("evidence"))
    verdict = clean_text(structured.get("verdict")).lower()
    invalid_pass_with_blockers = verdict == "pass" and bool(blockers)
    invalid_pass_without_checks = verdict == "pass" and not checks
    invalid_pass_without_evidence = verdict == "pass" and not evidence

    if verdict not in {"pass", "fail"}:
        blockers = dedupe_lines([*blockers, "Verification verdict was missing or invalid."])
        verdict = "fail"

    if invalid_pass_with_blockers:
        verdict = "fail"

    if invalid_pass_without_checks:
        blockers = dedupe_lines([*blockers, "Verification pass is invalid without executed checks."])
        verdict = "fail"

    if invalid_pass_without_evidence:
        blockers = dedupe_lines([*blockers, "Verification pass is invalid without concrete evidence."])
        verdict = "fail"

    if verdict == "fail":
        open_questions = dedupe_lines(blockers + open_questions)
        if not checks:
            next_actions = dedupe_lines([*next_actions, "Run the missing verification checks."])
        if not evidence:
            next_actions = dedupe_lines([*next_actions, "Attach concrete verification evidence before release."])

    return blockers, open_questions, next_actions, checks, evidence, verdict


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
        '  "summary": "verification conclusion with concrete scope",\n'
        '  "blockers": ["release blocking gap"],\n'
        '  "open_questions": ["clarification needed"],\n'
        '  "next_actions": ["specific verification step"],\n'
        '  "checks": ["test/build/lint check"],\n'
        '  "evidence": ["concrete evidence or missing evidence"],\n'
        '  "verdict": "pass|fail"\n'
        "}\n"
        "Rules:\n"
        "- Call out missing evidence explicitly.\n"
        "- If any acceptance criterion or user-visible requirement is unverified, verdict must be fail.\n"
        "- For UI/web artifacts, build/lint alone is not enough; prefer a user-flow, local preview, or smoke check when possible.\n"
        "- Prefer blocker language only for real release blockers.\n"
        "- Do not wrap the JSON in markdown fences."
    )


class VerifierAgent(BaseAgent):
    def __init__(self, project_id: Optional[str] = None):
        super().__init__(AgentRole.VERIFIER, project_id)
        self.verification_history: list = []

    async def process_message(self, message: AgentMessage):
        if message.type == MessageType.REQUEST:
            content = message.content if isinstance(message.content, dict) else {}
            target_name = (
                content.get("target")
                or content.get("feature")
                or content.get("file")
                or "workspace"
            )
            self.set_task(f"검증 중: {target_name}")
            self.update_status(AgentStatus.MEETING, f"검증 수행: {target_name}")
            await self.execute(f"Verify {target_name}", context=content)
            self.complete_task()

        elif message.type == MessageType.COMMAND:
            self.set_task(f"명령 처리: {message.content}")
            await self.execute(str(message.content))
            self.complete_task()

    async def execute(
        self,
        instruction: str,
        context: Optional[Dict[str, Any]] = None,
    ) -> Dict[str, Any]:
        """Verifier 핵심 로직: LLM 기반 검증 계획 + 증거 요약."""
        self.logger.info(f"Verifier validating: {instruction}")

        if context and str(context.get("mode") or "") == "collaboration_round":
            llm_response = await self.execute_task(
                prompt=_build_collaboration_prompt(instruction, context, self.role),
                system_prompt=COLLABORATION_SYSTEM_PROMPT,
                role_override="verifier_collaboration",
                include_skill_prompt=False,
            )
            structured = safe_extract_json_object(llm_response)
            blockers, open_questions, next_actions, checks, evidence, verdict = _normalize_collaboration_verification(
                structured
            )
            return {
                "role": self.role.value,
                "action": "collaboration_verification",
                "instruction": instruction,
                "summary": first_text(
                    [
                        structured.get("summary"),
                        llm_response,
                        instruction,
                    ]
                ),
                "blockers": blockers,
                "open_questions": open_questions,
                "next_actions": next_actions,
                "checks": checks,
                "evidence": evidence,
                "verdict": verdict,
                "llm_response": llm_response,
                "status": "completed",
            }

        prompt = instruction
        if context and "acceptance_criteria" in context:
            prompt += f"\n\n## Acceptance Criteria\n{context['acceptance_criteria']}"
        if context and "artifacts" in context:
            prompt += f"\n\n## Available Artifacts\n{context['artifacts']}"
        if context and "code" in context:
            prompt += f"\n\n## Code / Diff Context\n```\n{context['code']}\n```"

        llm_response = await self.execute_task(
            prompt=prompt,
            system_prompt=SYSTEM_PROMPT,
        )

        verification_result = {
            "role": self.role.value,
            "action": "verification",
            "instruction": instruction,
            "llm_response": llm_response,
            "status": "completed",
        }
        self.verification_history.append(verification_result)
        return verification_result
