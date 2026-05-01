import os
import subprocess
import time
import shutil
import sys
import importlib.util
from dataclasses import asdict
from typing import Any, Dict, Optional

from ..utils import setup_logger
from ..config import HEALTH_CHECK_TIMEOUT_SEC, PROCESS_WAIT_TIMEOUT_SEC, NPM_INSTALL_TIMEOUT_SEC, TSC_CHECK_TIMEOUT_SEC
from .enhanced_verification_utils import find_frontend_dir
from .enhanced_verification_types import RuntimeTestResult

# 🆕 For Port Killing
import socket
from contextlib import closing

logger = setup_logger("EnhancedVerification")


def _is_port_in_use(port: int) -> bool:
    """Check if port is use."""
    with closing(socket.socket(socket.AF_INET, socket.SOCK_STREAM)) as sock:
        return sock.connect_ex(("127.0.0.1", port)) == 0


def _kill_port(port: int) -> bool:
    """
    Force kill any process using the specified port (Machine Healing).
    Returns True if port is free (or freed), False if failed.
    """
    if not _is_port_in_use(port):
        return True
    
    logger.info(f"[RuntimeHealing] Port {port} is busy. Attempting to kill process...")
    
    try:
        if os.name == 'nt': # Windows
             subprocess.run(["taskkill", "/F", "/PID", subprocess.check_output(f"netstat -ano | findstr :{port}", shell=True).decode().split()[-1]], check=False)
        else: # macOS / Linux
            # lsof -t -i:PORT returns PIDs
            pids = subprocess.check_output(["lsof", "-t", f"-i:{port}"]).decode().strip().split('\n')
            for pid in pids:
                if pid:
                    logger.info(f"Killing PID {pid} on port {port}")
                    subprocess.run(["kill", "-9", pid], check=False)
        
        # Verify
        time.sleep(1)
        if _is_port_in_use(port):
            logger.warning(f"[RuntimeHealing] Failed to free port {port}.")
            return False
        
        logger.info(f"[RuntimeHealing] Port {port} successfully freed.")
        return True
        
    except Exception as e:
        logger.warning(f"[RuntimeHealing] Error while killing port: {e}")
        return False



def _find_backend_entrypoint(
    project_dir: str,
    main_file: str = "main.py",
) -> Optional[Dict[str, str]]:
    def detect_entry(base_dir: str) -> Optional[str]:
        app_main = os.path.join(base_dir, "app", "main.py")
        if os.path.exists(app_main):
            return "app.main:app"

        candidates = [main_file, "main.py", "app.py", "server.py", "run.py"]
        for candidate in candidates:
            if not candidate:
                continue
            candidate_path = os.path.join(base_dir, candidate)
            if os.path.exists(candidate_path):
                module_name = os.path.splitext(candidate)[0]
                return f"{module_name}:app"
        return None

    for candidate_dir in [
        project_dir,
        os.path.join(project_dir, "backend"),
        os.path.join(project_dir, "server"),
    ]:
        if not os.path.isdir(candidate_dir):
            continue
        entrypoint = detect_entry(candidate_dir)
        if entrypoint:
            return {"entrypoint": entrypoint, "backend_dir": candidate_dir}
    return None


def project_output_presence(
    project_dir: str,
    needs_backend: bool = True,
    needs_frontend: bool = True,
    main_file: str = "main.py",
) -> Dict[str, Any]:
    missing = []
    details = {}

    backend_info = _find_backend_entrypoint(project_dir, main_file=main_file)
    if needs_backend:
        if backend_info:
            details["backend_dir"] = backend_info.get("backend_dir")
        else:
            missing.append("backend")

    frontend_dir = find_frontend_dir(project_dir)
    if needs_frontend:
        if frontend_dir:
            details["frontend_dir"] = frontend_dir
        else:
            missing.append("frontend")

    ok = len(missing) == 0
    reason = "Required outputs present" if ok else f"Missing output(s): {', '.join(missing)}"

    return {
        "ok": ok,
        "reason": reason,
        "template": "output_presence",
        "details": details,
        "missing": missing,
    }


def runtime_test_backend(
    project_dir: str,
    main_file: str = "main.py",
    port: int = 8099,
    timeout: int = 15,
) -> Dict[str, Any]:
    """
    백엔드 런타임 테스트
    - 서버 시작
    - 헬스체크 엔드포인트 호출
    - 응답 시간 측정
    """
    import urllib.request
    import urllib.error

    results = []

    # 1. 서버 시작 테스트
    backend_info = _find_backend_entrypoint(project_dir, main_file=main_file)
    backend_dir = project_dir
    entrypoint = None
    if backend_info:
        backend_dir = backend_info["backend_dir"]
        entrypoint = backend_info["entrypoint"]

    if not entrypoint:
        return {
            "ok": False,
            "reason": "No entry point found (app/main.py, main.py, app.py, server.py, run.py)",
            "template": "runtime_test_backend",
            "results": [],
        }

    if importlib.util.find_spec("uvicorn") is None:
        return {
            "ok": False,
            "reason": "uvicorn not installed",
            "template": "runtime_test_backend",
            "results": [],
        }

    # 🆕 MACHINE HEALING: Kill port before starting
    _kill_port(port)

    process = None
    try:
        # uvicorn으로 서버 시작
        process = subprocess.Popen(
            [sys.executable, "-m", "uvicorn", entrypoint, "--host", "127.0.0.1", "--port", str(port)],
            cwd=backend_dir,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
        )

        # 서버 시작 대기
        start_time = time.time()
        server_ready = False

        for _ in range(timeout * 2):
            time.sleep(0.5)
            try:
                urllib.request.urlopen(f"http://127.0.0.1:{port}/", timeout=1)
                server_ready = True
                break
            except urllib.error.HTTPError:
                # HTTP 에러라도 서버가 응답하면 OK
                server_ready = True
                break
            except (urllib.error.URLError, TimeoutError, ConnectionError):
                logger.debug("Backend runtime test server check failed", exc_info=True)
                continue

        startup_time = int((time.time() - start_time) * 1000)

        results.append(
            RuntimeTestResult(
                success=server_ready,
                test_type="server_start",
                duration_ms=startup_time,
                error_message=None if server_ready else "Server failed to start",
            )
        )

        if not server_ready:
            return {
                "ok": False,
                "reason": "Server failed to start",
                "template": "runtime_test_backend",
                "results": [asdict(r) for r in results],
            }

        # 2. 헬스체크 테스트
        health_endpoints = ["/health", "/api/health", "/", "/docs"]
        health_ok = False

        for endpoint in health_endpoints:
            try:
                start = time.time()
                response = urllib.request.urlopen(f"http://127.0.0.1:{port}{endpoint}", timeout=HEALTH_CHECK_TIMEOUT_SEC)
                duration = int((time.time() - start) * 1000)

                results.append(
                    RuntimeTestResult(
                        success=True,
                        test_type="api_call",
                        duration_ms=duration,
                        response_data={"endpoint": endpoint, "status": response.status},
                    )
                )
                health_ok = True
                break
            except urllib.error.HTTPError as e:
                if e.code < 500:  # 4xx는 일단 응답함
                    health_ok = True
                    break
            except (urllib.error.URLError, TimeoutError, ConnectionError):
                logger.debug("Backend health check failed", exc_info=True)
                continue

        all_passed = all(r.success for r in results)

        return {
            "ok": all_passed,
            "reason": "Backend runtime test passed" if all_passed else "Some tests failed",
            "template": "runtime_test_backend",
            "results": [asdict(r) for r in results],
            "server_startup_ms": startup_time,
        }

    except Exception as e:
        return {
            "ok": False,
            "reason": f"Runtime test error: {str(e)[:100]}",
            "template": "runtime_test_backend",
            "results": [],
        }
    finally:
        # Always clean up the process
        if process is not None:
            try:
                process.terminate()
                process.wait(timeout=PROCESS_WAIT_TIMEOUT_SEC)
            except (OSError, subprocess.SubprocessError):
                try:
                    process.kill()
                except (OSError, subprocess.SubprocessError):
                    pass


def runtime_test_frontend(
    project_dir: str,
    timeout: int = 300,
    skip_install: bool = False,
) -> Dict[str, Any]:
    """
    프론트엔드 런타임 테스트
    - npm install
    - npm run dev (간단히 시작되는지 확인)
    """
    results = []

    frontend_dir = find_frontend_dir(project_dir)
    if not frontend_dir:
        return {
            "ok": False,
            "reason": "No package.json found",
            "template": "runtime_test_frontend",
            "results": [],
        }

    if not shutil.which("npm"):
        return {
            "ok": False,
            "reason": "npm not found in PATH",
            "template": "runtime_test_frontend",
            "results": [],
        }

    try:
        should_install = not skip_install or not os.path.isdir(os.path.join(frontend_dir, "node_modules"))
        if should_install:
            start = time.time()
            result = subprocess.run(
                ["npm", "install"],
                cwd=frontend_dir,
                capture_output=True,
                text=True,
                timeout=timeout,
                shell=False,  # Safer: no shell injection
            )
            duration = int((time.time() - start) * 1000)

            results.append(
                RuntimeTestResult(
                    success=result.returncode == 0,
                    test_type="npm_install",
                    duration_ms=duration,
                    error_message=None if result.returncode == 0 else result.stderr[:200],
                )
            )

            if result.returncode != 0:
                return {
                    "ok": False,
                    "reason": f"npm install failed: {result.stderr[:100]}",
                    "template": "runtime_test_frontend",
                    "results": [asdict(r) for r in results],
                }

        # TypeScript 체크 (있다면)
        if os.path.exists(os.path.join(frontend_dir, "tsconfig.json")):
            if not shutil.which("npx"):
                results.append(
                    RuntimeTestResult(
                        success=False,
                        test_type="typescript_check",
                        duration_ms=0,
                        error_message="npx not found for TypeScript check",
                    )
                )
            else:
                tsc_result = subprocess.run(
                    ["npx", "tsc", "--noEmit"],
                    cwd=frontend_dir,
                    capture_output=True,
                    text=True,
                    timeout=TSC_CHECK_TIMEOUT_SEC,
                    shell=False,  # Safer: no shell injection
                )

                results.append(
                    RuntimeTestResult(
                        success=tsc_result.returncode == 0,
                        test_type="typescript_check",
                        duration_ms=0,
                        error_message=None if tsc_result.returncode == 0 else tsc_result.stderr[:200],
                    )
                )

        all_passed = all(r.success for r in results)

        return {
            "ok": all_passed,
            "reason": "Frontend runtime test passed" if all_passed else "Some tests failed",
            "template": "runtime_test_frontend",
            "results": [asdict(r) for r in results],
        }

    except subprocess.TimeoutExpired:
        return {
            "ok": False,
            "reason": "npm install timeout",
            "template": "runtime_test_frontend",
            "results": [asdict(r) for r in results],
        }
    except Exception as e:
        return {
            "ok": False,
            "reason": f"Runtime test error: {str(e)[:100]}",
            "template": "runtime_test_frontend",
            "results": [],
        }


def frontend_race_state_check(project_dir: str) -> Dict[str, Any]:
    """프론트 상태/레이스 위험 패턴 스캔"""
    frontend_dir = find_frontend_dir(project_dir)
    if not frontend_dir:
        return {
            "ok": True,
            "reason": "No frontend detected",
            "template": "frontend_race_state_check",
            "issues": [],
        }

    issues = []
    patterns = [
        ("setInterval", "clearInterval"),
        ("setTimeout", "clearTimeout"),
        ("addEventListener", "removeEventListener"),
    ]

    for root, dirs, files in os.walk(frontend_dir):
        dirs[:] = [d for d in dirs if d not in ["node_modules", ".git", "__pycache__"]]
        for name in files:
            if not name.endswith((".js", ".jsx", ".ts", ".tsx")):
                continue
            path = os.path.join(root, name)
            try:
                with open(path, "r", encoding="utf-8", errors="ignore") as f:
                    content = f.read()
            except OSError:
                continue
            for add, remove in patterns:
                if add in content and remove not in content:
                    issues.append(
                        {
                            "file": os.path.relpath(path, project_dir),
                            "pattern": add,
                            "suggestion": f"Add matching {remove} cleanup",
                        }
                    )

    return {
        "ok": len(issues) == 0,
        "reason": "No obvious race/state cleanup issues" if not issues else f"{len(issues)} potential cleanup issues",
        "template": "frontend_race_state_check",
        "issues": issues,
    }


def stability_test(
    project_dir: str,
    runs: int = 2,
    needs_backend: bool = True,
    needs_frontend: bool = True,
    skip_initial_install: bool = False,
) -> Dict[str, Any]:
    """반복 실행 안정성 테스트"""
    results = {"backend_runs": [], "frontend_runs": []}

    for i in range(runs):
        if needs_backend:
            backend_result = runtime_test_backend(project_dir)
            results["backend_runs"].append(backend_result)
        if needs_frontend:
            frontend_result = runtime_test_frontend(
                project_dir,
                skip_install=skip_initial_install or (i > 0),
            )
            results["frontend_runs"].append(frontend_result)

    backend_ok = all(r.get("ok", True) for r in results["backend_runs"]) if needs_backend else True
    frontend_ok = all(r.get("ok", True) for r in results["frontend_runs"]) if needs_frontend else True

    return {
        "ok": backend_ok and frontend_ok,
        "reason": "Stability test passed" if backend_ok and frontend_ok else "Stability test failed",
        "template": "stability_test",
        "results": results,
    }
