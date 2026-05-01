import os
import subprocess
import time
import json
from typing import Optional, List, Dict, Any
import logging

# Local constants to replace daacs.core.config
PLANNER_MODEL = "gpt-5.1-codex-max"
SUPPORTED_MODELS = {
    "gpt-5.1-codex-max": {"provider": "openai", "model_name": "gpt-5.1-codex-max", "tier": "max"},
    "claude-sonnet-4.5": {"provider": "anthropic", "model_name": "claude-sonnet-4.5", "tier": "standard"},
    "gemini-3-pro-high": {"provider": "google", "model_name": "gemini-3-pro", "tier": "high"}
}

from .token_tracker import get_tracker
# 🆕 Security Integration
try:
    from ..security.command_filter import CommandFilter
    HAS_SECURITY = True
except ImportError:
    HAS_SECURITY = False

logger = logging.getLogger("CodexClient")


def _remove_bom_from_files(directory: str):
    """
    디렉토리 내 모든 텍스트 파일에서 UTF-8 BOM 제거
    
    Codex/Claude/Gemini CLI가 Windows에서 파일 생성시 BOM을 추가하는 문제 해결
    """
    import glob
    from pathlib import Path
    
    bom_fixed = 0
    dir_path = Path(directory)
    
    # 코드 파일 확장자들
    for ext in ["*.json", "*.py", "*.js", "*.jsx", "*.ts", "*.tsx", "*.css", "*.html", "*.md", "*.txt", "*.yaml", "*.yml"]:
        for file_path in dir_path.rglob(ext):
            # node_modules, venv, __pycache__ 제외
            if any(skip in str(file_path) for skip in ["node_modules", ".venv", "__pycache__", ".git"]):
                continue
            try:
                with open(file_path, 'rb') as f:
                    content = f.read()
                # UTF-8 BOM 확인 (EF BB BF)
                if content.startswith(b'\xef\xbb\xbf'):
                    with open(file_path, 'wb') as f:
                        f.write(content[3:])
                    bom_fixed += 1
            except Exception:
                pass
    
    if bom_fixed > 0:
        logger.info(f"[BOM] Removed BOM from {bom_fixed} files in {directory}")
    
    return bom_fixed

class GeminiRateLimiter:
    """Gemini 무료 티어 (60 req/min) 제한을 위한 Rate Limiter"""
    _last_request_time = 0
    _min_interval = 1.5  # 1.5초 대기 (60 req/min = 1초당 1회, 여유 있게 설정)

    @classmethod
    def wait_for_slot(cls):
        current_time = time.time()
        elapsed = current_time - cls._last_request_time
        if elapsed < cls._min_interval:
            wait_time = cls._min_interval - elapsed
            logger.info(f"[GeminiRateLimiter] Waiting {wait_time:.1f}s for next slot...")
            time.sleep(wait_time)
        cls._last_request_time = time.time()


class CodexClient:
    def __init__(self, cwd: str = ".", timeout_sec: int = 240, retries: int = 2, sandbox_permissions=None, client_name: str = "frontend", model_name: Optional[str] = None, cli_type: str = "codex"):
        env_cwd = os.getenv("DAACS_WORKDIR")
        # 기본 작업 경로를 project/로 설정해 산출물이 루트에 흩어지지 않도록 함
        default_cwd = "project" if os.path.exists("project") else "."
        self.cwd = env_cwd or cwd or default_cwd
        if self.cwd and not os.path.exists(self.cwd):
            os.makedirs(self.cwd, exist_ok=True)
        self.process: Optional[subprocess.Popen] = None
        self.timeout_sec = timeout_sec
        self.retries = retries
        self.client_name = client_name
        self.cli_type = cli_type
        env_model = os.getenv(f"DAACS_{client_name.upper()}_MODEL")
        self.model_name = model_name or env_model or PLANNER_MODEL
        self.model_config = SUPPORTED_MODELS.get(self.model_name, SUPPORTED_MODELS.get("gpt-5.1-codex-max"))
        # 기본적으로 Codex가 rollout recorder를 홈 경로에 쓰려 하므로, 권한 오류 방지를 위해 풀 액세스 부여
        self.sandbox_permissions = sandbox_permissions or ['disk-full-access']

    def execute(self, prompt: str) -> str:
        """CLI를 비대화형 모드(exec)로 실행하여 결과를 받아옵니다."""
        logger.info(f"[{self.client_name}] Executing {self.cli_type} with prompt length: {len(prompt)}")

        # Gemini Rate Limiting
        if self.cli_type == "gemini":
            GeminiRateLimiter.wait_for_slot()

        cmd = []
        shell_mode = False
        input_str = None
        
        if self.cli_type == "claude_code":
            # Claude CLI: Agentic mode - let Claude create files directly in cwd
            # Remove --print to enable file creation
            cmd = ["claude.cmd", "--dangerously-skip-permissions"] if os.name == 'nt' else ["claude", "--dangerously-skip-permissions"]
            input_str = prompt
            shell_mode = True
        elif self.cli_type == "gemini":
            # Gemini CLI: Non-interactive mode using stdin for prompt
            # -y flag for auto-approval (YOLO mode), -o text for text output
            gemini_cmd = "gemini.cmd" if os.name == 'nt' else "gemini"
            # 절대 경로 보장
            abs_cwd = os.path.abspath(self.cwd).replace("\\", "/")
            dir_instruction = f"Create all files in '{abs_cwd}'. "
            enhanced_prompt = dir_instruction + prompt
            
            # Use stdin for prompt passing (more reliable than positional args for long prompts)
            # -y for yolo mode to auto-approve file creations
            cmd = [gemini_cmd, "-y"]
            input_str = enhanced_prompt  # Pass prompt via stdin
            shell_mode = True if os.name == 'nt' else False
        else:
            # Codex CLI (Default)
            # Use npx to run codex on Windows (npm global scripts have path issues)
            # Pass prompt via stdin to avoid command line length limits
            permissions_toml = f'sandbox_permissions={json.dumps(self.sandbox_permissions)}'
            if os.name == 'nt':
                # Windows: use npx to run @openai/codex (--skip-git-repo-check to avoid trusted dir error)
                cmd = ["npx", "@openai/codex", "exec", "--skip-git-repo-check", "--sandbox", "danger-full-access", "-c", permissions_toml]
            else:
                cmd = ["codex", "exec", "--skip-git-repo-check", "--sandbox", "danger-full-access", "-c", permissions_toml]
            input_str = prompt  # Pass prompt via stdin
            shell_mode = True
            
        # Windows shell=True일 때 리스트를 문자열로 변환 (subprocess 호환성)
        if shell_mode and isinstance(cmd, list) and os.name == 'nt':
            import subprocess
            cmd = subprocess.list2cmdline(cmd)
            logger.info(f"[{self.client_name}] Converted command list to string for shell execution")

        for attempt in range(1, self.retries + 2):  # initial try + retries
            # UTF-8 환경 강제 (Windows에서 한글 깨짐 방지)
            env = os.environ.copy()
            env['PYTHONUTF8'] = '1'
            env['PYTHONIOENCODING'] = 'utf-8'
            env['LANG'] = 'en_US.UTF-8'
            
            try:
                result = subprocess.run(
                    cmd,
                    input=input_str,
                    cwd=self.cwd,
                    capture_output=True,
                    text=True,
                    timeout=self.timeout_sec,
                    check=False,
                    shell=shell_mode,
                    encoding='utf-8',
                    errors='ignore',  # 롤백: 깨진 문자 무시 (이전 동작 복원)
                    env=env  # UTF-8 환경 적용
                )

                if result.returncode != 0:
                    logger.error(f"[{self.client_name}] CLI failed return code: {result.returncode}")
                    logger.error(f"[{self.client_name}] CLI stderr: {result.stderr[:500]}")
                    logger.error(f"[{self.client_name}] CLI stdout: {result.stdout[:500]}")
                    logger.error(f"[{self.client_name}] {self.cli_type} execution failed (attempt {attempt}): {result.stderr}")
                    # Fallback: try 'claude' if 'claude.cmd' failed
                    if self.cli_type == "claude_code" and cmd[0] == "claude.cmd" and attempt == 1:
                         cmd[0] = "claude"
                         logger.info(f"[{self.client_name}] Retrying with 'claude'...")
                         continue
                    
                    # Fallback: try 'gemini' if 'gemini.cmd' failed
                    if self.cli_type == "gemini" and cmd[0] == "gemini.cmd" and attempt == 1:
                         cmd[0] = "gemini"
                         logger.info(f"[{self.client_name}] Retrying with 'gemini'...")
                         continue

                    if attempt <= self.retries:
                        time.sleep(1)
                        continue
                    return f"Error: {result.stderr}"

                logger.info(f"[{self.client_name}] {self.cli_type} execution successful")
                if not result.stdout:
                     logger.warning(f"[{self.client_name}] {self.cli_type} returned empty output. Stderr: {result.stderr}")
                
                output = result.stdout.strip() if result.stdout else ""
                
                # 🆕 Token Tracking
                try:
                    tracker = get_tracker()
                    input_chars = len(input_str) if input_str else 0
                    output_chars = len(output)
                    tracker.log_usage_from_chars(
                        agent_name=self.client_name,
                        input_chars=input_chars,
                        output_chars=output_chars,
                        model=self.cli_type
                    )
                except Exception as e:
                    logger.warning(f"Failed to track tokens: {e}")
                
                # Gemini Output Cleaning (노이즈 제거)
                if self.cli_type == "gemini":
                    lines = output.splitlines()
                    # 더 많은 노이즈 패턴 필터링
                    noise_prefixes = (
                        "Loaded cached",
                        "Using project",
                        "YOLO mode is enabled",
                        "Exit code:",
                        "Thinking...",
                        "```",  # 마크다운 코드 블록 제거 (JSON만 남기기)
                    )
                    cleaned_lines = [l for l in lines if not any(l.strip().startswith(p) for p in noise_prefixes)]
                    output = "\n".join(cleaned_lines).strip()

                # 🆕 BOM 제거 (파일 생성 후 후처리)
                _remove_bom_from_files(self.cwd)

                return output

            except subprocess.TimeoutExpired:
                logger.error(f"[{self.client_name}] {self.cli_type} execution timeout after {self.timeout_sec}s (attempt {attempt})")
                if attempt <= self.retries:
                    time.sleep(1)
                    continue
                return f"Error: Timeout after {self.timeout_sec}s"
            except Exception as e:
                logger.error(f"[{self.client_name}] Exception during {self.cli_type} execution (attempt {attempt}): {e}")
                if attempt <= self.retries:
                    time.sleep(1)
                    continue
                return f"Exception: {str(e)}"

    def check_version(self) -> str:
        try:
            if self.cli_type == "claude_code":
                cmd = ["claude.cmd", "--version"] if os.name == 'nt' else ["claude", "--version"]
            elif self.cli_type == "gemini":
                cmd = ["gemini.cmd", "--version"] if os.name == 'nt' else ["gemini", "--version"]
            else:
                cmd = ["codex", "--version"]
            
            shell_mode = (self.cli_type in ["claude_code", "gemini"])
            
            result = subprocess.run(
                cmd, 
                capture_output=True, 
                text=True, 
                shell=shell_mode,
                encoding='utf-8',
                errors='ignore'
            )
            return result.stdout.strip()
        except Exception:
            return f"{self.cli_type} CLI not found"


class FrontendClient(CodexClient):
    def __init__(self, **kwargs):
        super().__init__(client_name="frontend", **kwargs)


class BackendClient(CodexClient):
    def __init__(self, **kwargs):
        super().__init__(client_name="backend", **kwargs)


class SessionBasedCLIClient:
    """
    세션 기반 CLI 클라이언트 - 모든 CLI 통합 지원
    
    특징:
    - CLI의 네이티브 세션 관리 활용 (--resume, -c 플래그)
    - 매 호출마다 이전 세션 복원
    - subprocess.run() 사용 (안정적)
    - 동일 인터페이스로 Claude/Codex/Gemini 지원
    
    Rework 시 이전 작업 컨텍스트를 CLI가 기억하므로
    "저거 고쳐" 한 마디로 수정 가능
    """
    
    def __init__(
        self, 
        cwd: str = ".", 
        cli_type: str = "claude_code", 
        client_name: str = "backend",
        timeout_sec: int = 600,
        session_id: str = None
    ):
        """
        Args:
            cwd: 작업 디렉토리
            cli_type: CLI 타입 ("claude_code", "codex", "gemini")
            client_name: 클라이언트 이름 ("backend" or "frontend")
            timeout_sec: 실행 타임아웃 (초)
            session_id: 복원할 세션 ID (Rework 시 사용)
        """
        self.cwd = os.path.abspath(cwd) if cwd else os.getcwd()
        self.cli_type = cli_type
        self.client_name = client_name
        self.timeout_sec = timeout_sec
        self.session_id = session_id
        self._first_run = (session_id is None)
        self._call_count = 0
        
        # 작업 디렉토리 생성
        if not os.path.exists(self.cwd):
            os.makedirs(self.cwd, exist_ok=True)
        
        logger.info(f"[{self.client_name}] SessionBasedCLIClient created (cli_type={cli_type}, cwd={self.cwd})")
    
    def _build_command(self, prompt: str) -> tuple:
        """
        CLI별 명령어 생성
        
        Returns:
            (cmd_list, input_str, use_shell)
        """
        use_continue = not self._first_run
        
        if self.cli_type == "claude_code" or self.cli_type == "claude":
            # Claude CLI
            # 🔧 프롬프트를 stdin으로 전달 (명령줄 길이 제한 및 쉘 이스케이프 문제 방지)
            # claude --dangerously-skip-permissions -p - (stdin에서 읽음)
            base_cmd = "claude.cmd" if os.name == 'nt' else "claude"
            
            if use_continue:
                # -c: 가장 최근 대화 계속
                cmd = [base_cmd, "-c", "--dangerously-skip-permissions", "-p", "-"]
                logger.info(f"[{self.client_name}] Using --continue mode for session restoration")
            else:
                cmd = [base_cmd, "--dangerously-skip-permissions", "-p", "-"]
            
            # 프롬프트를 stdin으로 전달
            return (cmd, prompt, True)
        
        elif self.cli_type == "codex":
            # Codex CLI - exec 모드 + stdin으로 프롬프트 전달
            # 🔗 https://developers.openai.com/codex/sdk#using-codex-cli-programmatically
            # 
            # ⚠️ 프롬프트를 stdin으로 전달 (명령줄 인수 X)
            # 이유: Windows shell에서 긴 프롬프트 + 줄바꿈 + 특수문자가 명령줄 인수로 전달되면 파싱 오류 발생
            # 해결: Codex의 `-` 플래그로 stdin에서 프롬프트 읽기
            #
            if os.name == 'nt':
                base_cmd = ["npx", "@openai/codex"]
            else:
                base_cmd = ["codex"]
            
            # 절대 경로 보장
            abs_cwd = os.path.abspath(self.cwd)
            
            # 프롬프트에 작업 디렉토리 명시적 포함 (제거: 절대 경로가 파일명에 포함되는 문제 발생)
            # dir_instruction = f"Create all files in '{abs_cwd}'. "
            enhanced_prompt = prompt
            
            # stdin으로 프롬프트 전달 (Claude와 동일 패턴)
            # `-` 플래그가 stdin에서 프롬프트를 읽도록 지시
            # 🆕 2026-01-05: --dangerously-bypass-approvals-and-sandbox 추가 (Y/N 프롬프트 방지)
            cmd = base_cmd + [
                "exec", 
                "--skip-git-repo-check", 
                "--dangerously-bypass-approvals-and-sandbox",
                "-"
            ]
            input_str = enhanced_prompt
            logger.info(f"[{self.client_name}] Codex exec (stdin, prompt length={len(enhanced_prompt)})")
            
            return (cmd, input_str, True)
        
        elif self.cli_type == "gemini":
            # Gemini CLI (비대화형 모드)
            # 🆕 프롬프트를 stdin으로 전달 (Claude/Codex와 동일 패턴)
            # 긴 프롬프트 + 특수문자 + 셸 이스케이프 문제 방지
            base_cmd = "gemini.cmd" if os.name == 'nt' else "gemini"
            
            # Gemini Rate Limiting (60 req/min)
            GeminiRateLimiter.wait_for_slot()
            
            # 프롬프트 준비
            # 🆕 파일 생성 위치 명시 (CodexClient 로직 복원)
            abs_cwd = os.path.abspath(self.cwd).replace("\\", "/")
            dir_instruction = f"Create all files in '{abs_cwd}'. "
            enhanced_prompt = dir_instruction + prompt
            
            if use_continue:
                # --resume: 가장 최근 세션 복원, -y: 자동 승인 (YOLO mode)
                cmd = [base_cmd, "--resume", "latest", "-y"]
                logger.info(f"[{self.client_name}] Using --resume mode for session restoration")
            else:
                # -y: 자동 승인 (YOLO mode for file creation)
                cmd = [base_cmd, "-y"]
            
            # Windows에서는 shell=True가 필요할 수 있음 (PATH 문제 등)
            use_shell_flag = True if os.name == 'nt' else False
            
            logger.info(f"[{self.client_name}] Gemini CLI mode (stdin, prompt length={len(enhanced_prompt)})")
            return (cmd, enhanced_prompt, use_shell_flag)  # 프롬프트를 stdin으로 전달
        
        elif self.cli_type == "glm":
            # GLM CLI (ChatGLM)
            # 🆕 GLM은 API 기반으로 동작 - aichat 또는 직접 API 호출
            # Windows: glm.cmd, Linux/Mac: glm
            base_cmd = "aichat" if os.name != 'nt' else "aichat.cmd"
            
            # aichat with GLM model
            cmd = [base_cmd, "-m", "glm-4", prompt]
            
            logger.info(f"[{self.client_name}] GLM CLI mode (aichat, prompt length={len(prompt)})")
            return (cmd, None, True)  # aichat은 인자로 프롬프트 전달
        
        elif self.cli_type == "deepseek":
            # DeepSeek CLI
            # 🆕 DeepSeek도 API 기반 - aichat 또는 직접 API 호출
            base_cmd = "aichat" if os.name != 'nt' else "aichat.cmd"
            
            # aichat with DeepSeek model
            cmd = [base_cmd, "-m", "deepseek", prompt]
            
            logger.info(f"[{self.client_name}] DeepSeek CLI mode (aichat, prompt length={len(prompt)})")
            return (cmd, None, True)  # aichat은 인자로 프롬프트 전달
        
        else:
            # Unknown CLI type - fallback to CodexClient behavior
            logger.warning(f"[{self.client_name}] Unknown CLI type: {self.cli_type}, using basic mode")
            return ([self.cli_type], prompt, True)
    
    def execute(self, prompt: str) -> str:
        """
        CLI 실행 - 세션 복원 포함
        
        Args:
            prompt: 실행할 프롬프트
            
        Returns:
            CLI 응답 문자열
        """
        self._call_count += 1
        logger.info(f"[{self.client_name}] Execute #{self._call_count} (first_run={self._first_run})")
        
        cmd, input_str, use_shell = self._build_command(prompt)
        
        # 🆕 Security Check
        if HAS_SECURITY and input_str:
            is_safe, reason = CommandFilter.is_safe(input_str)
            if not is_safe:
                logger.error(f"[{self.client_name}] Security violation: {reason}")
                return f"Error: Command blocked by security policy. Reason: {reason}"
        
        # Windows shell=True일 때 리스트를 문자열로 변환 (subprocess 호환성)
        if use_shell and isinstance(cmd, list) and os.name == 'nt':
            import subprocess
            cmd = subprocess.list2cmdline(cmd)
            logger.info(f"[{self.client_name}] Converted command list to string for shell execution")
        
        if isinstance(cmd, str):
             logger.info(f"[{self.client_name}] Running command: {cmd[:50]}...")
        else:
             logger.info(f"[{self.client_name}] Running command: {' '.join(cmd[:5])}...")
        
        # UTF-8 환경 강제 (Windows에서 한글 깨짐 방지)
        env = os.environ.copy()
        env['PYTHONUTF8'] = '1'
        env['PYTHONIOENCODING'] = 'utf-8'
        env['LANG'] = 'en_US.UTF-8'
        
        try:
            result = subprocess.run(
                cmd,
                input=input_str,
                cwd=self.cwd,
                capture_output=True,
                text=True,
                timeout=self.timeout_sec,
                check=False,
                shell=use_shell,
                encoding='utf-8',
                errors='ignore',  # 롤백: 깨진 문자 무시 (이전 동작 복원)
                env=env  # UTF-8 환경 적용
            )
            
            if result.returncode != 0:
                logger.error(f"[{self.client_name}] CLI failed return code: {result.returncode}")
                logger.error(f"[{self.client_name}] CLI stderr: {result.stderr[:500]}")
                logger.error(f"[{self.client_name}] CLI stdout: {result.stdout[:500]}")
                
                # Fallback: Windows에서 .cmd 확장자 문제 시
                if self.cli_type == "claude_code" and "claude.cmd" in str(cmd):
                    logger.info(f"[{self.client_name}] Retrying with 'claude' instead of 'claude.cmd'")
                    cmd[0] = "claude"
                    result = subprocess.run(
                        cmd, input=input_str, cwd=self.cwd, capture_output=True,
                        text=True, timeout=self.timeout_sec, shell=use_shell,
                        encoding='utf-8', errors='ignore'
                    )
                    if result.returncode != 0:
                        return f"Error: {result.stderr}"
                else:
                    return f"Error: {result.stderr}"
            
            # 첫 실행 완료 후 플래그 업데이트
            if self._first_run:
                self._first_run = False
                logger.info(f"[{self.client_name}] First run completed, future calls will use session restoration")
            
            output = result.stdout.strip() if result.stdout else ""
            
            # Gemini 출력 정리 (노이즈 제거)
            if self.cli_type == "gemini":
                lines = output.splitlines()
                # 더 많은 노이즈 패턴 필터링
                noise_prefixes = (
                    "Loaded cached",
                    "Using project",
                    "YOLO mode is enabled",
                    "Exit code:",
                    "Thinking...",
                    "```",  # 마크다운 코드 블록 제거 (JSON만 남기기)
                )
                cleaned = [l for l in lines if not any(l.strip().startswith(p) for p in noise_prefixes)]
                output = "\n".join(cleaned).strip()
            
            logger.info(f"[{self.client_name}] CLI execution successful (output length={len(output)})")
            
            # 🆕 BOM 제거 (파일 생성 후 후처리)
            _remove_bom_from_files(self.cwd)
            
            return output
            
        except subprocess.TimeoutExpired:
            logger.error(f"[{self.client_name}] Timeout after {self.timeout_sec}s")
            return f"Error: Timeout after {self.timeout_sec}s"
        except Exception as e:
            logger.error(f"[{self.client_name}] Exception: {repr(e)}")
            return f"Exception: {str(e)}"
    
    def reset_session(self):
        """세션 초기화 - 새로운 대화 시작"""
        self._first_run = True
        self._call_count = 0
        logger.info(f"[{self.client_name}] Session reset, next call will start fresh")
    
    @property
    def is_continuing(self) -> bool:
        """현재 세션 복원 모드인지 확인"""
        return not self._first_run


# 하위 호환성: PersistentCLIClient를 SessionBasedCLIClient로 별칭
PersistentCLIClient = SessionBasedCLIClient

