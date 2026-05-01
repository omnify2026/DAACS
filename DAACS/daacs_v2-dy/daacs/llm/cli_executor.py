import os
import subprocess
import time
import json
from typing import Optional

from ..config import DEFAULT_LLM_TIMEOUT_SEC
from ..monitoring.token_tracker import TokenTracker
from ..utils import setup_logger

logger = setup_logger("CLIExecutor")

_ALLOWED_REASONING_EFFORTS = {"low", "medium", "high", "xhigh"}


def _resolve_reasoning_effort(model_name: Optional[str]) -> Optional[str]:
    env_value = os.getenv("DAACS_REASONING_EFFORT") or os.getenv("DAACS_CODEX_REASONING_EFFORT")
    effort = (env_value or "").strip().lower()
    if not effort and model_name and "mini" in model_name.lower():
        effort = "high"
    if effort and effort not in _ALLOWED_REASONING_EFFORTS:
        logger.warning("Ignoring unsupported reasoning.effort=%s", effort)
        return None
    return effort or None

class CLIExecutionError(Exception):
    """Raised when CLI execution fails."""
    pass


class RateLimitExceeded(Exception):
    """Raised when max LLM calls exceeded."""
    pass


# Per-project call counters for rate limiting
_project_call_counts: dict = {}  # {project_id: count}
_global_call_count = 0  # Fallback for non-project calls
_max_llm_calls = 100  # Default limit per project


def set_max_llm_calls(limit: int):
    global _max_llm_calls
    _max_llm_calls = limit


def get_llm_call_count(project_id: str = None) -> int:
    if project_id:
        return _project_call_counts.get(project_id, 0)
    return _global_call_count


def reset_llm_call_count(project_id: str = None):
    global _global_call_count
    if project_id:
        _project_call_counts[project_id] = 0
    else:
        _global_call_count = 0
        _project_call_counts.clear()


def _increment_call_count(project_id: str = None) -> int:
    """Increment and return the new count for rate limit checking."""
    global _global_call_count
    if project_id:
        current = _project_call_counts.get(project_id, 0)
        _project_call_counts[project_id] = current + 1
        return _project_call_counts[project_id]
    else:
        _global_call_count += 1
        return _global_call_count


class SessionBasedCLIClient:
    """
    세션 기반 CLI 클라이언트 - 모든 CLI 통합 지원
    
    특징:
    - CLI의 네이티브 세션 관리 활용 (--resume, -c 플래그)
    - 매 호출마다 이전 세션 복원
    - subprocess.run() 사용 (안정적)
    - 동일 인터페이스로 Claude/Codex/Gemini 지원
    - Per-Project Rate Limiting 지원
    """
    
    def __init__(
        self, 
        cwd: str = ".", 
        cli_type: str = "codex", 
        client_name: str = "backend",
        timeout_sec: int = DEFAULT_LLM_TIMEOUT_SEC,
        session_id: str = None,
        project_id: str = None,  # For per-project rate limiting
        model_name: str = None  # Add model_name support
    ):
        self.cwd = os.path.abspath(cwd) if cwd else os.getcwd()
        self.cli_type = cli_type
        self.client_name = client_name
        self.timeout_sec = timeout_sec
        self.session_id = session_id
        self.project_id = project_id  # Track for rate limiting
        self.model_name = model_name
        self._first_run = (session_id is None)
        self._call_count = 0
        
        # 작업 디렉토리 생성
        if not os.path.exists(self.cwd):
            os.makedirs(self.cwd, exist_ok=True)
            
        logger.info(f"[{self.client_name}] SessionBasedCLIClient created (cli_type={cli_type}, cwd={self.cwd}, model={self.model_name})")

    def _build_cmd(self, prompt: str) -> tuple:
        """CLI 및 모드에 따른 명령어 생성"""
        input_str = None
        use_shell = False
        
        if self.cli_type == "codex":
            sandbox_permissions = ["disk-full-access", "extension-full-access", "network-full-access"]
            extension_permissions = ["*"]
            permissions_toml = f'sandbox_permissions={json.dumps(sandbox_permissions)}\nextension_permissions={json.dumps(extension_permissions)}'
            
            cmd = [
                "codex", "exec", 
                "--sandbox", "danger-full-access", 
                "-c", permissions_toml,
                "--skip-git-repo-check",
            ]

            reasoning_effort = _resolve_reasoning_effort(self.model_name)
            if reasoning_effort:
                cmd.extend(["-c", f"model_reasoning_effort=\"{reasoning_effort}\""])
            
            if self.model_name:
                cmd.extend(["-m", self.model_name])
                
            cmd.extend(["-C", self.cwd, "-"])
            
            input_str = prompt
            use_shell = False
            return (cmd, input_str, use_shell)

        elif self.cli_type == "gemini":
            # Gemini CLI: use default model (don't specify -m, API doesn't support custom model names)
            cmd = ["gemini", "-s"]
            # NOTE: -m flag removed because Gemini API returns "entity not found" for custom model names
                
            if not self._first_run:
                # Resume logic for subsequent calls in same session
                cmd = ["gemini", "--resume", "-s"]
            
            if os.name == 'nt':
                 cmd[0] = "gemini.cmd"
                 
            return (cmd, prompt, True)

        elif self.cli_type == "claude":
            cmd = ["claude", "--dangerously-skip-permissions", "-p", "-"]
            if os.name == 'nt':
                cmd[0] = "claude.cmd"
            return (cmd, prompt, True)
            
        else:
            raise ValueError(f"Unknown CLI type: {self.cli_type}")

    def execute(self, prompt: str, raise_on_error: bool = True) -> str:
        # Per-project Rate Limiting Check
        call_count = _increment_call_count(self.project_id)
        if call_count > _max_llm_calls:
            raise RateLimitExceeded(f"Maximum LLM calls exceeded ({call_count}/{_max_llm_calls}) for project {self.project_id or 'global'}")
        
        self._call_count += 1
        cmd, input_str, use_shell = self._build_cmd(prompt)
        
        logger.info(f"[{self.client_name}] Executing {self.cli_type} (call #{call_count} for {self.project_id or 'global'})...")
        start_time = time.time()
        
        try:
            result = subprocess.run(
                cmd,
                input=input_str,
                cwd=self.cwd,
                capture_output=True,
                text=True,
                timeout=self.timeout_sec,
                shell=use_shell,
                check=False
            )
            
            if result.returncode != 0:
                error_msg = f"CLI Error (exit {result.returncode}): {result.stderr}"
                logger.warning(f"[{self.client_name}] {error_msg}")
                if raise_on_error:
                    raise CLIExecutionError(error_msg)
                return f"Error: {result.stderr}"
                
            self._first_run = False
            elapsed = time.time() - start_time
            logger.info(f"[{self.client_name}] LLM call completed in {elapsed:.2f}s (response: {len(result.stdout)} chars)")
            
            # Estimate tokens (heuristic: 1 token ~= 4 chars)
            input_tokens = len(prompt) // 4
            output_tokens = len(result.stdout) // 4
            
            TokenTracker.get_instance().track_request(
                model=self.model_name or self.cli_type,
                input_tokens=input_tokens,
                output_tokens=output_tokens,
                provider=self.cli_type
            )
            return result.stdout.strip()
            
        except subprocess.TimeoutExpired:
            error_msg = f"Timeout after {self.timeout_sec}s"
            if raise_on_error:
                raise CLIExecutionError(error_msg)
            return f"Error: {error_msg}"
        except CLIExecutionError:
            raise
        except RateLimitExceeded:
            raise
        except Exception as e:
            error_msg = f"Exception: {str(e)}"
            if raise_on_error:
                raise CLIExecutionError(error_msg)
            return error_msg
