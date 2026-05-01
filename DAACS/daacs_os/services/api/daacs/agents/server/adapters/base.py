"""
DAACS OS — LLM Stream Adapter (Abstract Base)
모든 CLI 어댑터의 추상 인터페이스
"""
import time
from abc import ABC, abstractmethod
from dataclasses import dataclass, field
from typing import AsyncGenerator, Dict, List, Optional


@dataclass
class StreamEvent:
    """어댑터에서 발행하는 원시 스트리밍 이벤트"""
    type: str      # "chunk" | "tool_call" | "tool_result" | "message" | "done" | "error"
    content: str
    agent: str     # AgentRole.value
    timestamp: float = field(default_factory=time.time)
    metadata: Dict = field(default_factory=dict)


class LLMStreamAdapter(ABC):
    """
    프로바이더 무관 스트리밍 LLM 인터페이스.

    각 구현체(codex/claude/gemini)는:
    - asyncio.create_subprocess_exec()로 CLI를 실행
    - stdout을 라인별로 읽어 StreamEvent를 yield
    - 프로세스 종료/timeout을 책임짐
    """

    provider: str  # "codex" | "claude" | "gemini"

    @abstractmethod
    async def stream(
        self,
        prompt: str,
        system_prompt: str,
        history: List[Dict],
        cwd: str,
        timeout: int = 300,
    ) -> AsyncGenerator[StreamEvent, None]:
        """
        LLM CLI를 실행하고 stdout 라인별로 StreamEvent를 yield.

        Args:
            prompt: 사용자/오케스트레이터 지시문
            system_prompt: 스킬 번들로 생성된 시스템 프롬프트
            history: [{"role": "user"|"assistant", "content": str}, ...]
            cwd: 작업 디렉터리
            timeout: 프로세스 최대 실행 시간(초)
        """
        ...

    @abstractmethod
    def is_available(self) -> bool:
        """CLI 도구가 설치되어 있는지 확인"""
        ...
