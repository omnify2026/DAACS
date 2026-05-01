"""
DAACS OS — AgentSession
역할 1개 = 스트리밍 세션 1개 + 대화 히스토리 유지
"""
import asyncio
import logging
from typing import Any, Dict, List, Optional

from ...agents.base_roles import AgentRole
from ...skills.loader import SkillBundle, SkillLoader
from .adapters.base import LLMStreamAdapter, StreamEvent
from .stream_bridge import StreamBridge

logger = logging.getLogger("daacs.server.session")

# 역할당 최대 히스토리 유지 개수 (메모리 제한)
_MAX_HISTORY = 20


class AgentSession:
    """
    에이전트 1명의 스트리밍 실행 세션.

    - LLM CLI 프로세스를 asyncio subprocess로 실행
    - stdout을 라인별로 읽어 StreamBridge → WebSocket 전달
    - 대화 히스토리(list[dict])를 메모리에 유지 (에이전트 "기억")
    - SkillBundle을 시스템 프롬프트로 주입
    """

    def __init__(
        self,
        role: AgentRole,
        project_id: str,
        adapter: LLMStreamAdapter,
        ws_manager,
        cwd: str,
        skill_bundle: Optional[SkillBundle] = None,
    ):
        self.role = role
        self.project_id = project_id
        self.adapter = adapter
        self.cwd = cwd
        self._skill_bundle = skill_bundle
        self._bridge = StreamBridge(project_id, ws_manager)

        # 대화 히스토리 (기억)
        self._history: List[Dict[str, str]] = []
        self._active = False
        self._current_task: Optional[str] = None

    @property
    def is_active(self) -> bool:
        return self._active

    @property
    def history(self) -> List[Dict[str, str]]:
        return list(self._history)

    def load_skills(self, skills_root: Optional[str] = None) -> None:
        """스킬 번들 로드 (외부에서 이미 로드된 번들 주입 가능)"""
        if self._skill_bundle is None:
            loader = SkillLoader(skills_root=skills_root)
            self._skill_bundle = loader.load_bundle(self.role.value)
            logger.info(
                f"[{self.role.value}] Loaded skills: "
                f"{self._skill_bundle.get_skill_names()}"
            )

    def get_system_prompt(self, include_support: bool = True) -> str:
        """SkillBundle → 시스템 프롬프트 (기존 코드 재활용)"""
        if self._skill_bundle is None:
            return ""
        return self._skill_bundle.to_system_prompt(include_support=include_support)

    async def execute(
        self,
        instruction: str,
        context: Optional[Dict[str, Any]] = None,
        timeout: int = 300,
    ) -> str:
        """
        명령 실행 + 스트리밍 브로드캐스트 + 히스토리 누적.

        Args:
            instruction: 실행할 지시문
            context: 추가 컨텍스트 (workflow step, 전달자 등)
            timeout: LLM CLI 최대 실행 시간(초)

        Returns:
            전체 응답 텍스트 (히스토리에도 추가됨)
        """
        if self._active:
            logger.warning(f"[{self.role.value}] Already executing, queuing not supported yet")

        self._active = True
        self._current_task = instruction
        self._bridge.reset_log_count()

        # 컨텍스트 정보를 instruction에 포함
        prompt = self._build_prompt(instruction, context)
        system_prompt = self.get_system_prompt()

        full_response_parts: List[str] = []

        try:
            async for event in self.adapter.stream(
                prompt=prompt,
                system_prompt=system_prompt,
                history=self._history,
                cwd=self.cwd,
                timeout=timeout,
            ):
                # WebSocket 브로드캐스트
                await self._bridge.emit(event)

                # 응답 텍스트 누적 (chunk만)
                if event.type == "chunk" and event.content:
                    full_response_parts.append(event.content)

                # done 이벤트 → 루프 종료
                if event.type == "done":
                    break

                # 에러 → 중단
                if event.type == "error":
                    logger.error(f"[{self.role.value}] Stream error: {event.content}")
                    break

        except Exception as e:
            logger.exception(f"[{self.role.value}] execute() error: {e}")
            await self._bridge.emit(
                StreamEvent(type="error", content=str(e), agent=self.role.value)
            )
        finally:
            self._active = False
            self._current_task = None

        full_response = "\n".join(full_response_parts).strip()

        # 히스토리에 추가 (컨텍스트 제한)
        self._history.append({"role": "user", "content": instruction})
        if full_response:
            self._history.append({"role": "assistant", "content": full_response})

        # 히스토리 상한 유지
        if len(self._history) > _MAX_HISTORY * 2:
            self._history = self._history[-((_MAX_HISTORY * 2)):]

        return full_response

    async def send_to_agent(
        self,
        target_role: str,
        content: str,
        summary: Optional[str] = None,
    ) -> None:
        """
        다른 에이전트에게 메시지 전달 이벤트 발행.
        (오피스 씬 FileTransferEffect 트리거용)
        """
        msg_summary = summary or content[:100]
        await self._bridge.emit_message_sent(
            from_role=self.role.value,
            to_role=target_role,
            summary=msg_summary,
        )
        await self._bridge.emit_message_received(
            from_role=self.role.value,
            to_role=target_role,
            summary=msg_summary,
        )

    def clear_history(self) -> None:
        """대화 히스토리 초기화 (세션 리셋)"""
        self._history.clear()

    def _build_prompt(
        self, instruction: str, context: Optional[Dict[str, Any]]
    ) -> str:
        """컨텍스트 정보를 instruction에 포함"""
        if not context:
            return instruction
        ctx_parts = []
        if context.get("workflow"):
            ctx_parts.append(f"워크플로우: {context['workflow']}")
        if context.get("from_agent"):
            ctx_parts.append(f"요청자: {context['from_agent']}")
        if context.get("project_goal"):
            ctx_parts.append(f"프로젝트 목표: {context['project_goal']}")
        if context.get("additional"):
            ctx_parts.append(context["additional"])

        if ctx_parts:
            ctx_str = "\n".join(ctx_parts)
            return f"[컨텍스트]\n{ctx_str}\n\n[지시]\n{instruction}"
        return instruction
