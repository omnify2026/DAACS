"""
DAACS OS — LLM Provider Abstraction
CLI 기반 (codex/claude/gemini) + Plugin (API SDK) 프로바이더.

Source: DAACS_v2-dy/daacs/llm/providers.py, cli_executor.py
Adapted for DAACS_OS 8-agent architecture + Windows compatibility.
"""
import asyncio
import logging
import os
import subprocess
import sys
import time
from abc import ABC, abstractmethod
from pathlib import Path
from typing import Any, Dict, Optional

from .cli_env import build_cli_subprocess_env

logger = logging.getLogger("daacs.llm.providers")


# ─── Cost Estimation (per 1K tokens, approximate) ───

MODEL_COSTS = {
    # Flash tier
    "gemini-2.0-flash": {"input": 0.00015, "output": 0.0006},
    "gpt-4o-mini": {"input": 0.00015, "output": 0.0006},
    # Standard tier
    "gemini-2.0-pro": {"input": 0.00125, "output": 0.005},
    "gpt-4o": {"input": 0.0025, "output": 0.01},
    # High tier
    "claude-sonnet-4-5": {"input": 0.003, "output": 0.015},
    "gpt-5.3-codex": {"input": 0.003, "output": 0.015},
    # Max tier
    "claude-opus-4-6": {"input": 0.015, "output": 0.075},
    "o3": {"input": 0.01, "output": 0.04},
}

DEFAULT_COST = {"input": 0.001, "output": 0.004}


def estimate_cost(model: str, input_tokens: int, output_tokens: int) -> float:
    """Estimate cost in USD for a given model and token counts."""
    costs = MODEL_COSTS.get(model, DEFAULT_COST)
    return (input_tokens / 1000 * costs["input"]) + (output_tokens / 1000 * costs["output"])


def estimate_tokens(text: str) -> int:
    """Rough token estimate: ~4 chars per token for English, ~2 for Korean."""
    return max(1, len(text) // 3)


# ─── Provider ABC ───

class LLMProvider(ABC):
    """LLM 호출 추상 인터페이스."""

    @abstractmethod
    async def invoke(self, prompt: str, system_prompt: str = "") -> str:
        """프롬프트를 LLM에 전송하고 응답 텍스트를 반환."""
        ...

    @abstractmethod
    def get_model_name(self) -> str:
        """현재 사용 중인 모델 이름 반환."""
        ...


# ─── CLI Provider (codex / claude / gemini) ───

class CLIProvider(LLMProvider):
    """
    CLI 도구를 래핑하는 LLM 프로바이더.

    지원하는 CLI:
      - codex: `codex exec -m {model} -C {cwd} -`
      - claude: `claude --dangerously-skip-permissions -p -`
      - gemini: `gemini -s`

    Windows/Unix 양쪽 호환.
    """

    # CLI 타입별 명령어 빌더
    CLI_COMMANDS = {
        "codex": lambda model, cwd: ["codex", "exec", "--ephemeral", "-m", model, "-C", str(cwd), "-"],
        "claude": lambda model, cwd: ["claude", "--dangerously-skip-permissions", "-p", "-"],
        "gemini": lambda model, cwd: ["gemini", "-s"],
    }

    def __init__(
        self,
        cli_type: str,
        model_name: str = "",
        cwd: Optional[str] = None,
        timeout_sec: int = 120,
    ):
        if cli_type not in self.CLI_COMMANDS:
            raise ValueError(f"Unknown CLI type: {cli_type}. Supported: {list(self.CLI_COMMANDS.keys())}")

        self.cli_type = cli_type
        self.model_name = model_name
        self.cwd = cwd or os.getcwd()
        self.timeout_sec = timeout_sec

        # Resolve actual executable path (especially for gemini on Windows).
        self._executable = self._resolve_executable(cli_type)

    @staticmethod
    def _resolve_executable(cli_type: str) -> str:
        """Return executable path or name for the CLI tool.

        For gemini, respect DAACS_GEMINI_CLI_PATH and common npm global locations.
        Fallback to the bare cli_type so PATH resolution can still work.
        """
        if cli_type != "gemini":
            return cli_type

        configured = (os.getenv("DAACS_GEMINI_CLI_PATH", "") or "").strip()
        if configured:
            p = Path(configured)
            if p.is_file():
                return str(p)

        # Try PATH resolution first.
        from shutil import which

        for name in ("gemini", "gemini.cmd", "gemini.exe"):
            found = which(name)
            if found:
                return found

        # Fallback to common npm global locations on Windows.
        appdata = (os.getenv("APPDATA", "") or "").strip()
        if appdata:
            candidate = Path(appdata) / "npm" / "gemini.cmd"
            if candidate.is_file():
                return str(candidate)

        local_appdata = (os.getenv("LOCALAPPDATA", "") or "").strip()
        if local_appdata:
            candidate = Path(local_appdata) / "npm" / "gemini.cmd"
            if candidate.is_file():
                return str(candidate)

        # Last resort: return logical name so FileNotFoundError surfaces.
        return cli_type

    async def invoke(self, prompt: str, system_prompt: str = "") -> str:
        """CLI 도구를 통해 LLM 호출."""
        full_prompt = prompt
        if system_prompt:
            full_prompt = f"{system_prompt}\n\n---\n\n{prompt}"

        cmd = self.CLI_COMMANDS[self.cli_type](self.model_name, self.cwd)
        if cmd:
            cmd[0] = self._executable
        logger.info(f"[CLIProvider] {self.cli_type} invoke (model={self.model_name}, prompt_len={len(full_prompt)})")

        try:
            # Run in thread pool to avoid blocking event loop
            result = await asyncio.get_event_loop().run_in_executor(
                None,
                lambda: subprocess.run(
                    cmd,
                    input=full_prompt,
                    capture_output=True,
                    text=True,
                    encoding="utf-8",
                    errors="replace",
                    timeout=self.timeout_sec,
                    cwd=self.cwd,
                    env=build_cli_subprocess_env(),
                    # Windows: hide console window
                    creationflags=subprocess.CREATE_NO_WINDOW if sys.platform == "win32" else 0,
                ),
            )
        except subprocess.TimeoutExpired:
            logger.error(f"[CLIProvider] {self.cli_type} timed out ({self.timeout_sec}s)")
            raise TimeoutError(f"CLI {self.cli_type} timed out after {self.timeout_sec}s")
        except FileNotFoundError:
            logger.error(f"[CLIProvider] CLI tool '{self.cli_type}' not found. Is it installed?")
            raise RuntimeError(f"CLI tool '{self.cli_type}' not found in PATH")

        if result.returncode != 0:
            stderr = (result.stderr or "").strip()[:500]
            logger.warning(f"[CLIProvider] {self.cli_type} exit code {result.returncode}: {stderr}")
            # Still return stdout if available (some CLIs exit non-zero but produce output)
            if (result.stdout or "").strip():
                return (result.stdout or "").strip()
            raise RuntimeError(f"CLI {self.cli_type} failed (exit {result.returncode}): {stderr}")

        response = result.stdout.strip()
        logger.info(f"[CLIProvider] {self.cli_type} response length: {len(response)}")
        return response

    def get_model_name(self) -> str:
        return self.model_name or self.cli_type


# ─── Plugin Provider (Direct API SDK) ───

class PluginProvider(LLMProvider):
    """
    API SDK를 직접 사용하는 LLM 프로바이더.

    환경변수에서 API 키를 읽고 해당 SDK를 호출한다.
    현재 지원: gemini (google-genai), claude (anthropic), openai
    """

    def __init__(self, provider: str, model_name: str, api_key: Optional[str] = None):
        self.provider = provider
        self.model_name = model_name
        self.api_key = api_key or self._get_api_key(provider)

    @staticmethod
    def _get_api_key(provider: str) -> str:
        env_map = {
            "gemini": "GOOGLE_API_KEY",
            "claude": "ANTHROPIC_API_KEY",
            "openai": "OPENAI_API_KEY",
            "codex": "OPENAI_API_KEY",
        }
        env_var = env_map.get(provider, f"{provider.upper()}_API_KEY")
        key = os.getenv(env_var, "")
        if not key:
            logger.warning(f"[PluginProvider] API key not found: ${env_var}")
        return key

    async def invoke(self, prompt: str, system_prompt: str = "") -> str:
        """SDK를 통해 LLM 호출."""
        if self.provider in ("claude", "anthropic"):
            return await self._invoke_anthropic(prompt, system_prompt)
        elif self.provider in ("gemini", "google"):
            return await self._invoke_gemini(prompt, system_prompt)
        elif self.provider in ("openai", "codex"):
            return await self._invoke_openai(prompt, system_prompt)
        else:
            raise ValueError(f"Unsupported plugin provider: {self.provider}")

    async def _invoke_anthropic(self, prompt: str, system_prompt: str) -> str:
        try:
            import anthropic
        except ImportError:
            raise RuntimeError("anthropic package not installed. Run: pip install anthropic")

        client = anthropic.Anthropic(api_key=self.api_key)
        messages = [{"role": "user", "content": prompt}]
        kwargs: Dict[str, Any] = {
            "model": self.model_name,
            "max_tokens": 4096,
            "messages": messages,
        }
        if system_prompt:
            kwargs["system"] = system_prompt

        response = await asyncio.get_event_loop().run_in_executor(
            None, lambda: client.messages.create(**kwargs)
        )
        return response.content[0].text

    async def _invoke_gemini(self, prompt: str, system_prompt: str) -> str:
        try:
            import google.generativeai as genai
        except ImportError:
            raise RuntimeError("google-generativeai package not installed. Run: pip install google-generativeai")

        genai.configure(api_key=self.api_key)
        model = genai.GenerativeModel(self.model_name)
        full_prompt = f"{system_prompt}\n\n{prompt}" if system_prompt else prompt
        response = await asyncio.get_event_loop().run_in_executor(
            None, lambda: model.generate_content(full_prompt)
        )
        return response.text

    async def _invoke_openai(self, prompt: str, system_prompt: str) -> str:
        try:
            import openai
        except ImportError:
            raise RuntimeError("openai package not installed. Run: pip install openai")

        client = openai.OpenAI(api_key=self.api_key)
        messages = []
        if system_prompt:
            messages.append({"role": "system", "content": system_prompt})
        messages.append({"role": "user", "content": prompt})

        response = await asyncio.get_event_loop().run_in_executor(
            None,
            lambda: client.chat.completions.create(
                model=self.model_name,
                messages=messages,
                max_tokens=4096,
            ),
        )
        return response.choices[0].message.content or ""

    def get_model_name(self) -> str:
        return self.model_name


# ─── Provider Factory ───

def create_provider(
    cli_type: str,
    model_name: str = "",
    cwd: Optional[str] = None,
    use_plugin: bool = False,
) -> LLMProvider:
    """
    daacs_config.yaml의 roles.{role}.cli 값으로 프로바이더 생성.

    Args:
        cli_type: "codex" | "claude" | "gemini"
        model_name: specific model name (optional for CLI mode)
        cwd: working directory for CLI execution
        use_plugin: True면 API SDK 사용, False면 CLI 래핑
    """
    if use_plugin and model_name:
        provider_map = {
            "codex": "openai",
            "claude": "claude",
            "gemini": "gemini",
        }
        provider = provider_map.get(cli_type, cli_type)
        return PluginProvider(provider=provider, model_name=model_name)

    return CLIProvider(cli_type=cli_type, model_name=model_name, cwd=cwd)
