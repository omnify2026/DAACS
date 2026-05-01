"""
DAACS Server Manager
프로젝트 서버 시작/종료 관리 (공룡 함수 리팩토링)
"""
import os
import time
import socket
import subprocess
import http.client
import shutil
import sys
import importlib.util
from typing import Dict, Any, Optional, Tuple
from pathlib import Path

from .utils import setup_logger
from .config import (
    BACKEND_PORT_RANGE_START,
    BACKEND_PORT_RANGE_END,
    FRONTEND_PORT_RANGE_START,
    FRONTEND_PORT_RANGE_END,
    NPM_INSTALL_TIMEOUT_SEC,
    SERVER_POLL_INTERVAL_SEC,
    SERVER_STARTUP_TIMEOUT_SEC,
    PROCESS_SHUTDOWN_TIMEOUT,
)
from .constants import HEALTH_CHECK_TIMEOUT_SEC

logger = setup_logger("ServerManager")


from .infrastructure.process_registry import ProcessRegistry

# Global State Replaced by Singelton Registry
# _project_processes = {} 



class ServerManager:
    """프로젝트 서버 관리 클래스"""
    
    def __init__(self, project_id: str, workdir: str):
        self.project_id = project_id
        self.workdir = workdir
        self.registry = ProcessRegistry()
        self._log_dir = os.path.join(self.workdir, "logs")

    def _ensure_log_dir(self) -> str:
        os.makedirs(self._log_dir, exist_ok=True)
        return self._log_dir

    def _open_log_file(self, label: str):
        log_dir = self._ensure_log_dir()
        log_path = os.path.join(log_dir, f"{self.project_id}_{label}.log")
        try:
            return open(log_path, "ab")
        except OSError as e:
            logger.warning("Failed to open log file %s: %s", log_path, e)
            return None
        
    def find_free_port(self, start: int = 8100, end: int = 8200) -> int:
        """사용 가능한 포트 찾기"""
        for port in range(start, end):
            try:
                with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as s:
                    s.bind(('127.0.0.1', port))
                    return port
            except OSError:
                continue
        raise RuntimeError(f"No free port found in range {start}-{end}")

    def _startup_timeout(self) -> int:
        return SERVER_STARTUP_TIMEOUT_SEC

    def _has_module(self, module_name: str) -> bool:
        return importlib.util.find_spec(module_name) is not None

    def _wait_for_port(self, port: int, timeout_sec: Optional[int] = None) -> bool:
        timeout_sec = timeout_sec or self._startup_timeout()
        poll_interval = SERVER_POLL_INTERVAL_SEC
        deadline = time.monotonic() + timeout_sec
        while time.monotonic() < deadline:
            with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as sock:
                sock.settimeout(0.5)
                try:
                    sock.connect(("127.0.0.1", port))
                    return True
                except OSError:
                    time.sleep(poll_interval)
        return False

    def _wait_for_http(self, port: int, path: str = "/", timeout_sec: Optional[int] = None) -> bool:
        timeout_sec = timeout_sec or self._startup_timeout()
        poll_interval = SERVER_POLL_INTERVAL_SEC
        deadline = time.monotonic() + timeout_sec
        while time.monotonic() < deadline:
            conn = None
            try:
                conn = http.client.HTTPConnection("127.0.0.1", port, timeout=HEALTH_CHECK_TIMEOUT_SEC)
                conn.request("HEAD", path)
                resp = conn.getresponse()
                if resp.status < 500:
                    return True
            except OSError:
                pass
            finally:
                if conn:
                    try:
                        conn.close()
                    except OSError:
                        pass
            time.sleep(poll_interval)
        return False

    def _terminate_process(self, proc: subprocess.Popen, label: str) -> None:
        try:
            proc.terminate()
            proc.wait(timeout=PROCESS_SHUTDOWN_TIMEOUT)
        except OSError as e:
            logger.warning("Failed to terminate %s process: %s", label, e)
            try:
                proc.kill()
            except OSError:
                logger.warning("Failed to kill %s process", label, exc_info=True)
    
    def start_backend(self) -> Optional[int]:
        """Backend 서버 시작 (uvicorn)"""
        backend_dir = os.path.join(self.workdir, "backend")
        
        if not os.path.isdir(backend_dir):
            logger.debug(f"Backend dir not found: {backend_dir}")
            return None
        
        # main.py 찾기
        main_py = os.path.join(backend_dir, "app", "main.py")
        if os.path.exists(main_py):
            module_path = "app.main:app"
        else:
            main_py = os.path.join(backend_dir, "main.py")
            if not os.path.exists(main_py):
                logger.debug("No main.py found in backend")
                return None
            module_path = "main:app"
        
        if not self._has_module("uvicorn"):
            logger.error("uvicorn module not available; cannot start backend server.")
            return None
        for attempt in range(3):
            port = self.find_free_port(BACKEND_PORT_RANGE_START, BACKEND_PORT_RANGE_END)
            log_file = self._open_log_file("backend")
            try:
                proc = subprocess.Popen(
                    [sys.executable, "-m", "uvicorn", module_path, "--host", "0.0.0.0", "--port", str(port)],
                    cwd=backend_dir,
                    stdout=log_file or subprocess.DEVNULL,
                    stderr=log_file or subprocess.DEVNULL
                )
            except (OSError, subprocess.SubprocessError) as e:
                if log_file:
                    log_file.close()
                logger.error("Failed to start backend: %s", e)
                return None
            finally:
                if log_file:
                    log_file.close()

            if self._wait_for_port(port):
                self._save_process("backend", proc)
                logger.info("Backend started on port %s (PID: %s)", port, proc.pid)
                return port

            logger.warning("Backend failed to accept connections (attempt %s).", attempt + 1)
            self._terminate_process(proc, "backend")

        return None
    
    def start_frontend(self, backend_port: Optional[int] = None) -> Tuple[Optional[int], Optional[str]]:
        """Frontend 서버 시작 - npm run dev 또는 static server"""
        frontend_dir = self._find_frontend_dir()
        logger.info(f"Frontend directory detected: {frontend_dir}")
        
        # package.json이 있으면 npm 프로젝트
        if os.path.exists(os.path.join(frontend_dir, "package.json")):
            return self._start_npm_server(frontend_dir, backend_port)
        
        # Fallback: static file server
        return self._start_static_server(frontend_dir)
    
    def _find_frontend_dir(self) -> str:
        """프론트엔드 디렉토리 찾기"""
        # 프로젝트 루트에 package.json이 있으면 Vite 프로젝트
        if os.path.exists(os.path.join(self.workdir, "package.json")):
            return self.workdir
        
        # frontend/ 디렉토리 확인
        frontend_path = os.path.join(self.workdir, "frontend")
        if os.path.exists(os.path.join(frontend_path, "package.json")):
            return frontend_path
        if os.path.isdir(frontend_path):
            return frontend_path
        
        return self.workdir
    
    def _start_npm_server(self, frontend_dir: str, backend_port: Optional[int] = None) -> Tuple[Optional[int], Optional[str]]:
        """npm dev 서버 시작"""
        if not shutil.which("npm"):
            logger.error("npm not found in PATH; cannot start frontend dev server.")
            return None, None

        # npm install (node_modules 없으면)
        node_modules = os.path.join(frontend_dir, "node_modules")
        if not os.path.isdir(node_modules):
            logger.info(f"Running npm install in {frontend_dir}...")
            try:
                result = subprocess.run(
                    ["npm", "install"],
                    cwd=frontend_dir,
                    capture_output=True,
                    timeout=NPM_INSTALL_TIMEOUT_SEC
                )
                if result.returncode != 0:
                    logger.error(f"npm install failed: {result.stderr.decode()[:500]}")
            except (OSError, subprocess.SubprocessError) as e:
                logger.error(f"npm install error: {e}")
        
        for attempt in range(3):
            port = self.find_free_port(FRONTEND_PORT_RANGE_START, FRONTEND_PORT_RANGE_END)
            log_file = self._open_log_file("frontend")
            try:
                # 환경 변수 설정 (백엔드 포트 주입)
                env = os.environ.copy()
                if backend_port:
                    env["NEXT_PUBLIC_API_BASE_URL"] = f"http://localhost:{backend_port}"
                    logger.info(f"Injecting NEXT_PUBLIC_API_BASE_URL=http://localhost:{backend_port}")

                # Next.js 등에서 --host 옵션을 인식하지 못하는 경우가 있음
                # --port 옵션만 사용하고 host는 기본값(또는 next.config.js 설정)을 따르도록 함
                proc = subprocess.Popen(
                    ["npm", "run", "dev", "--", "--port", str(port)],
                    cwd=frontend_dir,
                    env=env,
                    stdout=log_file or subprocess.DEVNULL,
                    stderr=log_file or subprocess.DEVNULL
                )
            except (OSError, subprocess.SubprocessError) as e:
                if log_file:
                    log_file.close()
                logger.error("Failed to start npm dev server: %s", e)
                return None, None
            finally:
                if log_file:
                    log_file.close()

            if self._wait_for_http(port, "/"):
                self._save_process("frontend", proc)
                logger.info("Frontend (npm) started on port %s (PID: %s)", port, proc.pid)
                return port, "/"

            logger.warning("Frontend dev server failed to respond (attempt %s).", attempt + 1)
            self._terminate_process(proc, "frontend")

        return None, None
    
    def _start_static_server(self, frontend_dir: str) -> Tuple[Optional[int], Optional[str]]:
        """정적 파일 서버 시작"""
        serve_dir, entry_path = self._find_serve_dir(frontend_dir)
        
        if not serve_dir:
            logger.warning(f"No index.html found in {frontend_dir}")
            return None, None
        
        logger.info(f"Static file server will serve from: {serve_dir}, entry: {entry_path}")
        
        for attempt in range(3):
            port = self.find_free_port(FRONTEND_PORT_RANGE_START, FRONTEND_PORT_RANGE_END)
            log_file = self._open_log_file("frontend_static")
            try:
                cors_server_path = os.path.join(os.path.dirname(__file__), "cors_server.py")
                proc = subprocess.Popen(
                    [sys.executable, cors_server_path, str(port), serve_dir],
                    stdout=log_file or subprocess.DEVNULL,
                    stderr=log_file or subprocess.DEVNULL
                )
            except (OSError, subprocess.SubprocessError) as e:
                if log_file:
                    log_file.close()
                logger.error("Failed to start static server: %s", e)
                return None, None
            finally:
                if log_file:
                    log_file.close()

            if self._wait_for_http(port, entry_path):
                self._save_process("frontend", proc)
                logger.info("Frontend (static+CORS) started on port %s (PID: %s)", port, proc.pid)
                return port, entry_path

            logger.warning("Static server failed to respond (attempt %s).", attempt + 1)
            self._terminate_process(proc, "frontend")

        return None, None
    
    def _find_serve_dir(self, frontend_dir: str) -> Tuple[Optional[str], str]:
        """서빙할 디렉토리 찾기"""
        candidates = [
            (os.path.join(frontend_dir, "dist"), "/"),
            (os.path.join(frontend_dir, "public"), "/"),
            (frontend_dir, "/"),
            (os.path.join(frontend_dir, "src"), "/"),
        ]
        
        for dir_path, entry in candidates:
            if os.path.exists(os.path.join(dir_path, "index.html")):
                return dir_path, entry
        
        return None, "/"
    

    
    def _save_process(self, server_type: str, proc: subprocess.Popen):
        """프로세스 저장"""
        self.registry.register(self.project_id, server_type, proc)
    
    def stop_all(self):
        """모든 서버 종료"""
        processes = self.registry.get_all(self.project_id)
        if not processes:
            return
            
        for server_type, proc in processes.items():
            try:
                proc.terminate()
                proc.wait(timeout=PROCESS_SHUTDOWN_TIMEOUT)
                logger.info(f"Stopped {server_type} server for project {self.project_id}")
            except (OSError, subprocess.SubprocessError) as e:
                logger.error(f"Failed to stop {server_type}: {e}")
                try:
                    proc.kill()
                except OSError:
                    logger.warning("Failed to kill %s server", server_type, exc_info=True)
        
        self.registry.clear_project(self.project_id)


# 편의 함수들
def start_project_servers(project_id: str, workdir: str) -> Dict[str, Any]:
    """프로젝트 서버 시작 (편의 함수)"""
    manager = ServerManager(project_id, workdir)
    
    backend_port = manager.start_backend()
    frontend_result = manager.start_frontend(backend_port)
    
    if frontend_result:
        frontend_port, frontend_entry = frontend_result
    else:
        frontend_port, frontend_entry = None, None
    
    return {
        "backend_port": backend_port,
        "frontend_port": frontend_port,
        "frontend_entry": frontend_entry
    }


def stop_project_servers(project_id: str, workdir: str = None):
    """프로젝트 서버 종료 (편의 함수)"""
    manager = ServerManager(project_id, workdir or "")
    manager.stop_all()
