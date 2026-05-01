"""
DAACS v7.2 - Dynamic Runtime Verification & Scenario Validator
실제 프로세스 실행, 헬스 체크, 그리고 시나리오 기반 기능 검증
"""

import subprocess
import time
import os
import signal
import re
import shutil
import sys
import importlib.util
from typing import Dict, Any, Optional, List

import requests
from langchain_core.messages import HumanMessage, SystemMessage

from ..utils import setup_logger
from ..models.daacs_state import DAACSState
from .utils.network import find_free_port
from .templates.scenario_prompts import PLAYWRIGHT_TEST_GENERATION_PROMPT, PLAYWRIGHT_SYSTEM_MESSAGE

logger = setup_logger("RuntimeVerification")

# Constants
BACKEND_STARTUP_DELAY = 3
FRONTEND_STARTUP_DELAY = 5
HEALTH_CHECK_TIMEOUT = 5
HEALTH_CHECK_MAX_RETRIES = 15
E2E_TEST_TIMEOUT = 120
LOG_MAX_LENGTH = 1000


class ScenarioTestGenerator:
    """
    LLM을 사용하여 프로젝트 목표에 맞는 Playwright 시나리오 테스트를 생성
    """
    def __init__(self, llm: Any, project_dir: str):
        self.llm = llm
        self.project_dir = project_dir

    def generate_test_code(self, goal: str, api_spec: Dict[str, Any]) -> str:
        """목표와 API 명세를 기반으로 Playwright 테스트 코드 생성"""
        prompt = PLAYWRIGHT_TEST_GENERATION_PROMPT.format(
            goal=goal,
            api_spec_summary=list(api_spec.keys()) if api_spec else 'None'
        )
        response = self.llm.invoke([
            SystemMessage(content=PLAYWRIGHT_SYSTEM_MESSAGE),
            HumanMessage(content=prompt)
        ])
        return response.content.replace("```typescript", "").replace("```", "").strip()

    def save_test_file(self, content: str) -> str:
        """생성된 테스트 코드를 파일로 저장"""
        e2e_dir = os.path.join(self.project_dir, "frontend", "e2e")
        os.makedirs(e2e_dir, exist_ok=True)
        
        file_path = os.path.join(e2e_dir, "generated_verification.spec.ts")
        with open(file_path, "w", encoding="utf-8") as f:
            f.write(content)
        return file_path


class RuntimeVerifier:
    """
    백엔드/프론트엔드 프로세스를 실행하고 헬스 체크 및 시나리오 테스트를 수행하는 클래스
    """
    def __init__(self, workdir: str):
        self.workdir = workdir
        self.processes: List[subprocess.Popen] = []

    def _has_module(self, module_name: str) -> bool:
        return importlib.util.find_spec(module_name) is not None

    def start_backend(self, port: int) -> Optional[subprocess.Popen]:
        """FastAPI 백엔드 실행 (uvicorn)"""
        backend_dir = os.path.join(self.workdir, "backend")
        if not os.path.exists(backend_dir):
            backend_dir = self.workdir

        # main.py 찾기
        main_file = None
        if os.path.exists(os.path.join(backend_dir, "main.py")):
            main_file = "main"
        elif os.path.exists(os.path.join(backend_dir, "app", "main.py")):
            main_file = "app.main"
        
        if not main_file:
            logger.warning("Could not find backend entry point (main.py)")
            return None

        if not self._has_module("uvicorn"):
            logger.error("uvicorn module not available; cannot run backend runtime test.")
            return None

        cmd = [
            sys.executable, "-m", "uvicorn", 
            f"{main_file}:app", 
            "--host", "127.0.0.1", 
            "--port", str(port)
        ]
        
        try:
            logger.info("Starting backend on port %d...", port)
            env = os.environ.copy()
            env["PYTHONPATH"] = backend_dir
            
            # Use os.setsid on Unix, fallback for Windows
            preexec = os.setsid if hasattr(os, 'setsid') else None
            
            proc = subprocess.Popen(
                cmd,
                cwd=backend_dir,
                stdout=subprocess.PIPE,
                stderr=subprocess.PIPE,
                env=env,
                preexec_fn=preexec
            )
            self.processes.append(proc)
            return proc
        except (OSError, subprocess.SubprocessError) as e:
            logger.error("Failed to start backend: %s", e)
            return None

    def start_frontend(self, port: int) -> Optional[subprocess.Popen]:
        """Next.js 프론트엔드 실행 (npm run dev)"""
        frontend_dir = os.path.join(self.workdir, "frontend")
        if not os.path.exists(frontend_dir):
            if os.path.exists(os.path.join(self.workdir, "package.json")):
                frontend_dir = self.workdir
            else:
                logger.warning("Could not find frontend directory")
                return None

        if not shutil.which("npm"):
            logger.error("npm not found in PATH; cannot run frontend runtime test.")
            return None

        env = os.environ.copy()
        env["PORT"] = str(port)
        cmd = ["npm", "run", "dev"]
        
        try:
            logger.info("Starting frontend on port %d...", port)
            preexec = os.setsid if hasattr(os, 'setsid') else None
            
            proc = subprocess.Popen(
                cmd,
                cwd=frontend_dir,
                stdout=subprocess.PIPE,
                stderr=subprocess.PIPE,
                env=env,
                preexec_fn=preexec
            )
            self.processes.append(proc)
            return proc
        except (OSError, subprocess.SubprocessError) as e:
            logger.error("Failed to start frontend: %s", e)
            return None

    def check_health(self, url: str, timeout: int = HEALTH_CHECK_TIMEOUT, 
                    max_retries: int = HEALTH_CHECK_MAX_RETRIES) -> bool:
        """HTTP 헬스 체크"""
        for _ in range(max_retries):
            try:
                response = requests.get(url, timeout=timeout)
                if response.status_code < 500:
                    logger.info("Health check passed: %s (%d)", url, response.status_code)
                    return True
            except requests.exceptions.ConnectionError:
                pass
            except requests.RequestException as e:
                logger.debug("Health check error: %s", e)
            time.sleep(2)
        
        logger.warning("Health check failed after %d retries: %s", max_retries, url)
        return False

    def run_e2e_tests(self, test_file: str, base_url: str) -> Dict[str, Any]:
        """Playwright E2E 테스트 실행"""
        frontend_dir = os.path.join(self.workdir, "frontend")
        cmd = ["npx", "playwright", "test", test_file]

        if not shutil.which("npx"):
            return {"passed": False, "error": "npx not found; cannot run Playwright tests"}
        
        env = os.environ.copy()
        env["PLAYWRIGHT_TEST_BASE_URL"] = base_url
        env["CI"] = "true"

        try:
            result = subprocess.run(
                cmd,
                cwd=frontend_dir,
                capture_output=True,
                text=True,
                env=env,
                timeout=E2E_TEST_TIMEOUT
            )
            return {
                "passed": result.returncode == 0,
                "stdout": result.stdout,
                "stderr": result.stderr
            }
        except subprocess.TimeoutExpired:
            return {"passed": False, "error": "Test execution timed out"}
        except (subprocess.SubprocessError, OSError) as e:
            return {"passed": False, "error": str(e)}

    def check_process_alive(self, proc: subprocess.Popen) -> bool:
        """프로세스가 살아있는지 확인"""
        if proc.poll() is not None:
            stdout, stderr = proc.communicate()
            logger.error("Process died unexpectedly.\nSTDOUT: %s\nSTDERR: %s", 
                        stdout.decode(), stderr.decode())
            return False
        return True

    def stop_all(self):
        """모든 프로세스 종료"""
        for proc in self.processes:
            try:
                if hasattr(os, 'killpg'):
                    os.killpg(os.getpgid(proc.pid), signal.SIGTERM)
                else:
                    proc.terminate()
            except (OSError, ProcessLookupError):
                try:
                    proc.terminate()
                except (OSError, ProcessLookupError):
                    pass
        self.processes = []
        logger.info("All verification processes stopped.")


def _clean_and_truncate_log(text: str, max_len: int = LOG_MAX_LENGTH) -> str:
    """Clean ANSI codes and truncate log output."""
    ansi_escape = re.compile(r'\x1B(?:[@-Z\\-_]|\[[0-?]*[ -/]*[@-~])')
    text = ansi_escape.sub('', text)
    
    if len(text) <= max_len:
        return text
    
    head_len = int(max_len * 0.6)
    tail_len = int(max_len * 0.4)
    return f"{text[:head_len]}\n\n... [Log Truncated: {len(text)-max_len} chars skipped] ...\n\n{text[-tail_len:]}"


def runtime_verification_node(state: DAACSState, llm: Any = None) -> Dict[str, Any]:
    """
    Runtime Verification Node
    - 백엔드/프론트엔드를 실제 실행하여 Smoke Test 수행
    - LLM을 활용한 시나리오 테스트 생성 및 실행
    """
    logger.info("Starting dynamic verification...")
    project_dir = state.get("project_dir", ".")
    needs_backend = state.get("needs_backend", True)
    needs_frontend = state.get("needs_frontend", True)
    current_goal = state.get("current_goal", "")
    api_spec = state.get("api_spec", {})
    
    verifier = RuntimeVerifier(project_dir)
    issues = []
    
    backend_ok = True
    frontend_ok = True
    scenario_ok = False
    
    # 포트 할당
    be_port = find_free_port(8000)
    fe_port = find_free_port(3000)
    
    try:
        # 1. Backend Verification
        if needs_backend:
            be_proc = verifier.start_backend(be_port)
            if not be_proc:
                issues.append("Failed to spawn backend process")
                backend_ok = False
            else:
                time.sleep(BACKEND_STARTUP_DELAY)
                if not verifier.check_process_alive(be_proc):
                    issues.append("Backend process died immediately after startup")
                    backend_ok = False
                else:
                    health_urls = [
                        f"http://127.0.0.1:{be_port}/health",
                        f"http://127.0.0.1:{be_port}/",
                        f"http://127.0.0.1:{be_port}/docs"
                    ]
                    if not any(verifier.check_health(url) for url in health_urls):
                        issues.append("Backend server unresponsive (Health Check Failed)")
                        backend_ok = False

        # 2. Frontend Verification & Scenario Test
        if needs_frontend:
            fe_proc = verifier.start_frontend(fe_port)
            if not fe_proc:
                issues.append("Failed to spawn frontend process")
                frontend_ok = False
            else:
                time.sleep(FRONTEND_STARTUP_DELAY)
                if not verifier.check_process_alive(fe_proc):
                    issues.append("Frontend process died immediately (check build errors)")
                    frontend_ok = False
                else:
                    fe_url = f"http://127.0.0.1:{fe_port}"
                    if not verifier.check_health(fe_url, max_retries=20):
                        issues.append("Frontend server unresponsive (White Screen / Build Hang)")
                        frontend_ok = False
                    elif llm:
                        # 3. Scenario Testing
                        scenario_ok = _run_scenario_tests(
                            verifier, llm, project_dir, current_goal, 
                            api_spec, fe_url, issues
                        )
                    else:
                        scenario_ok = True

    except Exception as e:
        logger.error("Runtime verification exception: %s", e)
        issues.append(f"Runtime verification crashed: {str(e)}")
        backend_ok = False
        frontend_ok = False
    finally:
        verifier.stop_all()

    success = backend_ok and frontend_ok and len(issues) == 0
    logger.info("Final Status - Backend: %s, Frontend: %s, Issues: %d", 
               backend_ok, frontend_ok, len(issues))
    
    return {
        "runtime_verification_passed": success,
        "runtime_issues": issues,
        "needs_rework": not success, 
        "failure_summary": [f"runtime_error: {i}" for i in issues] if not success else []
    }


def _run_scenario_tests(verifier: RuntimeVerifier, llm: Any, project_dir: str,
                        goal: str, api_spec: Dict, fe_url: str,
                        issues: List[str]) -> bool:
    """Run LLM-generated scenario tests."""
    try:
        logger.info("Generating scenario test for: %s", goal)
        generator = ScenarioTestGenerator(llm, project_dir)
        test_code = generator.generate_test_code(goal, api_spec)
        generator.save_test_file(test_code)
        
        logger.info("Executing scenario test...")
        test_result = verifier.run_e2e_tests("e2e/generated_verification.spec.ts", fe_url)
        
        if test_result["passed"]:
            logger.info("✅ Scenario Verification Passed")
            return True
        else:
            logger.error("❌ Scenario Verification Failed: %s", test_result.get('error'))
            raw_err = test_result.get('stderr') or test_result.get('stdout') or "Unknown error"
            cleaned_err = _clean_and_truncate_log(raw_err)
            issues.append(f"Scenario verification failed: {cleaned_err}")
            return False
    except Exception as e:
        logger.error("Scenario generation/execution failed: %s", e)
        issues.append(f"Scenario test system error: {str(e)}")
        return False
