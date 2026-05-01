"""
DAACS OS — LLM Stream Adapters
"""
from .base import LLMStreamAdapter, StreamEvent
from .codex import CodexAdapter
from .claude import ClaudeAdapter
from .gemini import GeminiAdapter

__all__ = [
    "LLMStreamAdapter",
    "StreamEvent",
    "CodexAdapter",
    "ClaudeAdapter",
    "GeminiAdapter",
]


def create_adapter(provider: str, model: str = None, agent_role: str = "developer") -> LLMStreamAdapter:
    """
    provider 문자열로 어댑터 인스턴스 생성 (팩토리).
    daacs_config.yaml의 roles.[role].cli 값을 넘긴다.
    """
    p = provider.lower()
    if p == "codex":
        return CodexAdapter(model=model, agent_role=agent_role)
    elif p == "claude":
        return ClaudeAdapter(model=model, agent_role=agent_role)
    elif p == "gemini":
        return GeminiAdapter(model=model, agent_role=agent_role)
    else:
        raise ValueError(f"Unknown LLM provider: {provider!r}. Use 'codex', 'claude', or 'gemini'.")
