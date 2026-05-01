import json
import os
import subprocess
import time
from typing import Optional

from .config import DEFAULT_LLM_TIMEOUT_SEC, PLANNER_MODEL, SUPPORTED_MODELS
from .monitoring.token_tracker import TokenTracker
from .utils import setup_logger

logger = setup_logger("CodexClient")

_ALLOWED_REASONING_EFFORTS = {"low", "medium", "high", "xhigh"}


def _normalize_reasoning_effort(value: Optional[str]) -> Optional[str]:
    if not value:
        return None
    effort = value.strip().lower()
    if effort not in _ALLOWED_REASONING_EFFORTS:
        logger.warning("Ignoring unsupported reasoning.effort=%s", effort)
        return None
    return effort


class CodexClient:
    """
    Provider-flexible LLM runner.
    CLI 로그인 기반 프로바이더만 지원 (API 키 불필요):
    - codex: Codex CLI (codex exec)
    - claude: Claude CLI (claude exec) 
    - local: 커스텀 로컬 명령어
    """

    def __init__(
        self,
        cwd: str = ".",
        timeout_sec: int = DEFAULT_LLM_TIMEOUT_SEC,
        retries: int = 2,
        sandbox_permissions=None,
        client_name: str = "frontend",
        model_name: Optional[str] = None,
        provider: Optional[str] = None,
    ):
        env_cwd = os.getenv("DAACS_WORKDIR")
        default_cwd = "project" if os.path.exists("project") else "."
        self.cwd = env_cwd or cwd or default_cwd
        if self.cwd and not os.path.exists(self.cwd):
            os.makedirs(self.cwd, exist_ok=True)

        self.timeout_sec = timeout_sec
        self.retries = retries
        self.client_name = client_name

        env_model = os.getenv(f"DAACS_{client_name.upper()}_MODEL")
        # NOTE: model_name is the user-facing model id (e.g. "gemini-3-pro-high").
        # Some providers need a different underlying model name (e.g. "gemini-3-pro").
        self.model_name = model_name or env_model or PLANNER_MODEL
        self.model_config = SUPPORTED_MODELS.get(self.model_name, SUPPORTED_MODELS.get(PLANNER_MODEL) or {})
        self.effective_model_name = (
            (self.model_config or {}).get("model_name") or self.model_name
        )

        env_provider = os.getenv(f"DAACS_{client_name.upper()}_PROVIDER") or os.getenv("DAACS_PROVIDER")
        config_provider = self.model_config.get("provider") if self.model_config else None
        self.provider = (provider or env_provider or config_provider or "codex").lower()

        # Codex 기본 권한 설정: rollout recorder 및 확장 프로그램을 위한 모든 권한 부여
        self.sandbox_permissions = sandbox_permissions or [
            "disk-full-access",
            "extension-full-access",
            "network-full-access"
        ]
        self.extension_permissions = ["*"]
        # 로컬/커스텀 실행기 명령어
        self.local_command = os.getenv("DAACS_LOCAL_LLM_CMD", "")

    def _build_cmd(self, prompt: str) -> Optional[list[str]]:
        """프로바이더별 CLI 실행 명령 생성. 모두 로그인 기반 (API 키 불필요)."""
        if self.provider == "codex":
            reasoning_effort = _normalize_reasoning_effort(
                os.getenv("DAACS_REASONING_EFFORT") or os.getenv("DAACS_CODEX_REASONING_EFFORT")
            )
            if not reasoning_effort and self.model_name and "mini" in self.model_name.lower():
                reasoning_effort = "high"
            return [
                "codex", "exec", 
                "--sandbox", "danger-full-access",
                "-c", f"sandbox_permissions={json.dumps(self.sandbox_permissions)}",
                "-c", f"extension_permissions={json.dumps(self.extension_permissions)}",
                *(
                    ["-c", f"model_reasoning_effort=\"{reasoning_effort}\""]
                    if reasoning_effort
                    else []
                ),
                *(
                    ["-m", self.effective_model_name]
                    if self.effective_model_name
                    else []
                ),
                "--skip-git-repo-check",
                "--color", "never",
                "-",
            ]

        if self.provider == "gemini":
            # Gemini CLI: use default model (don't specify -m, API doesn't support custom model names)
            # Using -s for sandbox mode and stdin input
            base_cmd = ["gemini", "-s"]
            # NOTE: -m flag removed because Gemini API returns "entity not found" for custom model names
            return base_cmd

        if self.provider == "claude":
            # Claude CLI는 Anthropic 계정 로그인 기반으로 동작
            return ["claude", "--dangerously-skip-permissions", "-p", "-"]

        if self.provider == "local":
            if not self.local_command:
                return None
            return self.local_command.split() + [prompt]

        # 알 수 없는 프로바이더
        return None

    def execute(self, prompt: str) -> str:
        """CLI를 통해 프롬프트를 실행 (로그인 기반, API 키 불필요)."""
        logger.info(
            "[%s] Executing (%s) model=%s (effective=%s), prompt_len=%d",
            self.client_name,
            self.provider,
            self.model_name,
            self.effective_model_name,
            len(prompt),
        )
        cmd = self._build_cmd(prompt)
        if not cmd:
            return f"Error: provider '{self.provider}' is not configured (use codex/claude/local/gemini)."

        # stdin prompt feeding:
        # - codex/claude/gemini: use stdin ("-"/-p -) to avoid arg length limits.
        # - local: prompt is appended as arg by default.
        input_text = None
        stdin_arg = subprocess.DEVNULL
        if self.provider in {"codex", "gemini", "claude"}:
            input_text = prompt
            stdin_arg = None

        # Windows 호환성 (cmd 확장자 처리 등)은 subprocess가 PATH에서 찾음

        t_start = time.monotonic()
        for attempt in range(1, self.retries + 2):
            try:
                logger.debug(f"[{self.client_name}] Subprocess call (attempt {attempt})...")
                result = subprocess.run(
                    cmd,
                    cwd=self.cwd,
                    capture_output=True,
                    text=True,
                    input=input_text,
                    stdin=stdin_arg,
                    timeout=self.timeout_sec,
                    check=False,
                )
                elapsed = time.monotonic() - t_start

                if result.returncode != 0:
                    logger.error(f"[{self.client_name}] {self.provider} failed (code={result.returncode}, {elapsed:.1f}s): {result.stderr[:200]}")
                    if attempt <= self.retries:
                        time.sleep(1)
                        continue
                    return f"Error: {result.stderr}"

                output = result.stdout.strip()
                logger.info(f"[{self.client_name}] {self.provider} success ({elapsed:.1f}s). Output len: {len(output)}")
                
                # Estimate tokens (heuristic)
                input_tokens = len(prompt) // 4
                output_tokens = len(output) // 4

                TokenTracker.get_instance().track_request(
                    provider=self.provider,
                    model=self.model_name,
                    input_tokens=input_tokens,
                    output_tokens=output_tokens,
                )
                
                if not output:
                    logger.warning(f"[{self.client_name}] {self.provider} returned empty response")
                return output

            except subprocess.TimeoutExpired:
                logger.error(f"[{self.client_name}] {self.provider} timeout after {self.timeout_sec}s (attempt {attempt})")
                if attempt <= self.retries:
                    time.sleep(1)
                    continue
                return f"Error: Timeout after {self.timeout_sec}s"
            except Exception as e:
                logger.error(f"[{self.client_name}] Exception during {self.provider} execution (attempt {attempt}): {e}")
                if attempt <= self.retries:
                    time.sleep(1)
                    continue
                return f"Exception: {str(e)}"
        return "Error: execution failed unexpectedly"

    def check_version(self) -> str:
        """CLI 버전 및 로그인 상태 확인."""
        VERSION_CHECK_TIMEOUT = 5  # seconds
        try:
            if self.provider == "codex":
                result = subprocess.run(["codex", "--version"], capture_output=True, text=True, timeout=VERSION_CHECK_TIMEOUT)
                return result.stdout.strip()
            if self.provider == "gemini":
                result = subprocess.run(["gemini", "--version"], capture_output=True, text=True, timeout=VERSION_CHECK_TIMEOUT)
                if result.returncode == 0:
                    return result.stdout.strip()
                return "Gemini CLI not found or not logged in"
            if self.provider == "claude":
                result = subprocess.run(["claude", "--version"], capture_output=True, text=True, timeout=VERSION_CHECK_TIMEOUT)
                if result.returncode == 0:
                    return result.stdout.strip()
                return "Claude CLI not found or not logged in"
            if self.provider == "local":
                return f"Local provider via: {self.local_command or 'unset'}"
        except subprocess.TimeoutExpired:
            return f"{self.provider} CLI version check timeout"
        except (subprocess.SubprocessError, FileNotFoundError):
            logger.debug("Failed to check CLI version for provider=%s", self.provider, exc_info=True)
            return f"{self.provider} CLI not found"
        return f"{self.provider} CLI not found"


class FrontendClient:
    """Wrapper to keep the existing interface while allowing provider overrides."""

    def __init__(self, **kwargs):
        self.client = CodexClient(client_name="frontend", **kwargs)

    def execute(self, prompt: str) -> str:
        return self.client.execute(prompt)

    def check_version(self) -> str:
        return self.client.check_version()


class BackendClient:
    """Wrapper to keep the existing interface while allowing provider overrides."""

    def __init__(self, **kwargs):
        self.client = CodexClient(client_name="backend", **kwargs)

    def execute(self, prompt: str) -> str:
        return self.client.execute(prompt)

    def check_version(self) -> str:
        return self.client.check_version()
