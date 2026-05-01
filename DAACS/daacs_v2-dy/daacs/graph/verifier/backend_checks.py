import os
import re
import socket
import time
import subprocess
import urllib.request
import urllib.error
import importlib.util
from typing import Dict, List, Any, Optional

from ...config import PYTHON_COMPILE_TIMEOUT_SEC, HEALTH_CHECK_TIMEOUT_SEC, PROCESS_WAIT_TIMEOUT_SEC
from ...utils import setup_logger

logger = setup_logger("Verifier.BackendChecks")

# Constants
BACKEND_STARTUP_WAIT_SEC = 3
HEALTH_CHECK_TIMEOUT_SEC = 5
BACKEND_HEALTH_TOTAL_WAIT_SEC = 12
BACKEND_HEALTH_RETRY_DELAYS = [0.5, 0.75, 1.0, 1.5, 2.0]

_ROUTER_PREFIX_PATTERN = re.compile(
    r'(?P<router>[A-Za-z_][\w]*)\s*=\s*APIRouter\([^)]*?prefix\s*=\s*["\'](?P<prefix>[^"\']+)["\']',
    re.IGNORECASE | re.DOTALL,
)
_ROUTER_ASSIGN_PATTERN = re.compile(
    r'(?P<router>[A-Za-z_][\w]*)\s*=\s*APIRouter\s*\(',
    re.IGNORECASE,
)
_INCLUDE_ROUTER_PREFIX_PATTERN = re.compile(
    r'include_router\(\s*(?P<router>[A-Za-z_][\w]*)\s*,[^)]*?prefix\s*=\s*["\'](?P<prefix>[^"\']+)["\']',
    re.IGNORECASE | re.DOTALL,
)
_ROUTER_DECORATOR_PATTERN = re.compile(
    r'@(?P<router>[A-Za-z_][\w]*)\.(?P<method>get|post|put|delete|patch)\s*\(\s*["\'](?P<path>[^"\']+)["\']',
    re.IGNORECASE,
)
_IMPORT_ALIAS_PATTERN = re.compile(
    r'from\s+[\w.]+\s+import\s+(?P<orig>\w+)\s+as\s+(?P<alias>\w+)',
    re.IGNORECASE,
)


def _normalize_path(path: str) -> str:
    """Normalize path for comparison.
    
    - Adds leading slash if missing
    - Removes trailing slash
    - Converts Express :param to FastAPI {param} style
    """
    if not path:
        return ""
    if not path.startswith("/"):
        path = "/" + path
    if path != "/" and path.endswith("/"):
        path = path[:-1]
    # 🆕 Convert :param (Express) to {param} (FastAPI) for unified matching
    path = re.sub(r':(\w+)', r'{\1}', path)
    return path


def _join_paths(prefix: str, route: str) -> str:
    if not prefix:
        return _normalize_path(route)
    if not route:
        return _normalize_path(prefix)
    prefix_norm = _normalize_path(prefix)
    route_norm = _normalize_path(route)
    if prefix_norm == "/":
        return route_norm
    if route_norm == "/":
        return prefix_norm
    return prefix_norm + route_norm


def _paths_match(spec_path: str, candidate_path: str) -> bool:
    spec_norm = _normalize_path(spec_path)
    cand_norm = _normalize_path(candidate_path)
    if spec_norm == cand_norm:
        return True
    spec_regex = re.escape(spec_norm)
    spec_regex = re.sub(r'\\\{[^}]+\\\}', r'[^/]+', spec_regex)
    return re.fullmatch(spec_regex, cand_norm) is not None


def _extract_router_metadata(
    py_contents: List[str],
) -> Dict[str, Any]:
    router_prefixes: Dict[str, set] = {}
    include_prefixes: Dict[str, set] = {}
    router_routes: List[Dict[str, str]] = []
    aliases: Dict[str, str] = {}  # alias -> orig

    for content in py_contents:
        for match in _ROUTER_PREFIX_PATTERN.finditer(content):
            router_prefixes.setdefault(match.group("router"), set()).add(match.group("prefix"))
        for match in _ROUTER_ASSIGN_PATTERN.finditer(content):
            router_prefixes.setdefault(match.group("router"), set()).add("")
        for match in _INCLUDE_ROUTER_PREFIX_PATTERN.finditer(content):
            include_prefixes.setdefault(match.group("router"), set()).add(match.group("prefix"))
        for match in _ROUTER_DECORATOR_PATTERN.finditer(content):
            router_routes.append(
                {
                    "router": match.group("router"),
                    "method": match.group("method").upper(),
                    "path": match.group("path"),
                }
            )
        # 🆕 Track aliases (import ... as ...)
        for match in _IMPORT_ALIAS_PATTERN.finditer(content):
            aliases[match.group("alias")] = match.group("orig")

    return {
        "router_prefixes": router_prefixes,
        "include_prefixes": include_prefixes,
        "router_routes": router_routes,
        "aliases": aliases,
    }


def _build_router_endpoints(metadata: Dict[str, Any]) -> List[Dict[str, str]]:
    router_prefixes = metadata.get("router_prefixes", {})
    include_prefixes = metadata.get("include_prefixes", {})
    router_routes = metadata.get("router_routes", [])
    aliases = metadata.get("aliases", {})  # alias -> orig

    # Build reverse alias map: orig -> list of aliases
    # This matches `include_router(ALIAS)` with `router = ORIG()`
    reverse_aliases: Dict[str, List[str]] = {}
    for alias, orig in aliases.items():
        reverse_aliases.setdefault(orig, []).append(alias)

    endpoints: List[Dict[str, str]] = []

    for route in router_routes:
        router = route["router"]
        prefixes = router_prefixes.get(router) or {""}
        
        # Check direct includes
        include = set(include_prefixes.get(router) or set())
        
        # 🆕 Check includes via aliases
        # If route uses 'router', but main.py did 'include_router(api_router)' where 'api_router' is alias of 'router'
        if router in reverse_aliases:
            for alias in reverse_aliases[router]:
                alias_includes = include_prefixes.get(alias)
                if alias_includes:
                    include.update(alias_includes)
                    
        # Also handle case where route uses alias directly (less common for decorators but possible)
        # (Already handled if router name matches include key)

        # Fallback: if no include found, empty string (root)
        if not include:
            include = {""}

        for inc_prefix in include:
            for router_prefix in prefixes:
                if inc_prefix and router_prefix:
                    combined_prefix = _join_paths(inc_prefix, router_prefix)
                else:
                    combined_prefix = inc_prefix or router_prefix or ""
                full_path = _join_paths(combined_prefix, route["path"])
                endpoints.append({"method": route["method"], "path": full_path})

    return endpoints

def python_import_test(files: List[str]) -> Dict[str, Any]:
    """Python syntax check using py_compile (safer than exec)"""
    import_errors = []
    
    for file in files:
        if file.endswith('.py') and os.path.exists(file):
            try:
                # Python syntax check only (import test is too fragile)
                result = subprocess.run(
                    ['python', '-m', 'py_compile', file],
                    capture_output=True,
                    text=True,
                    timeout=PYTHON_COMPILE_TIMEOUT_SEC
                )
                if result.returncode != 0:
                    import_errors.append(f"{os.path.basename(file)}: {result.stderr[:100]}")
            except subprocess.TimeoutExpired:
                import_errors.append(f"{os.path.basename(file)}: Timeout")
            except Exception as e:
                import_errors.append(f"{os.path.basename(file)}: {str(e)[:50]}")
    
    return {
        "ok": len(import_errors) == 0,
        "reason": f"Compile errors: {import_errors}" if import_errors else "All Python files compile successfully",
        "template": "python_import_test",
        "details": "\n".join(import_errors[:5]) if import_errors else ""
    }

def api_spec_compliance(files: List[str], api_spec: Dict, fullstack_required: bool = False) -> Dict[str, Any]:
    """API 스펙 준수 검증 - 엔드포인트가 코드에 구현되어 있는지 확인"""
    if not api_spec or not api_spec.get("endpoints"):
        if fullstack_required:
            return {
                "ok": False,
                "reason": "API spec required for full-stack output",
                "template": "api_spec_compliance"
            }
        return {
            "ok": True,
            "reason": "No API spec to verify",
            "template": "api_spec_compliance"
        }
    if not files:
        return {
            "ok": False,
            "reason": "No backend files to scan for API spec compliance",
            "template": "api_spec_compliance",
        }
    
    # 모든 파일 내용 합치기
    all_content_parts: List[str] = []
    py_contents: List[str] = []
    for file in files:
        if not file.endswith(".py"):
            continue
        if os.path.exists(file):
            try:
                with open(file, 'r', encoding='utf-8', errors='ignore') as f:
                    content = f.read()
                    all_content_parts.append(content)
                    py_contents.append(content)
            except OSError:
                logger.debug("Failed to read file for API spec compliance: %s", file)
    all_content = "\n".join(all_content_parts)
    router_endpoints = _build_router_endpoints(_extract_router_metadata(py_contents))
    
    missing_endpoints = []
    found_endpoints = []
    
    for endpoint in api_spec.get("endpoints", []):
        path = endpoint.get("path", "")
        method = endpoint.get("method", "").upper()
        
        # 🆕 Skip WebSocket endpoints - they use different patterns (@sio.on, @app.websocket)
        if method == "WS" or "socket.io" in path.lower() or "/ws" in path.lower():
            found_endpoints.append(f"{method} {path} (WebSocket, skipped)")
            continue
        
        base_path = path.split("?")[0]
        # Normalize path params for basic matching
        normalized_path = re.sub(r'\{[^}]+\}', r'{[^}]+}', base_path)
        
        patterns = [
            f'"{base_path}"',
            f"'{base_path}'",
            f'@app.{method.lower()}("{base_path}"',
            f"@app.{method.lower()}('{base_path}'",
            f'@router.{method.lower()}("{base_path}"',
            f"@router.{method.lower()}('{base_path}'",
        ]
        
        found = any(pattern in all_content for pattern in patterns)
        
        if not found and "{" in base_path:
            regex_path = re.escape(base_path)
            regex_path = regex_path.replace(r'\{', r'{').replace(r'\}', r'}')
            regex_path = re.sub(r'\{[^}]+\}', r'\\{[^}]+\\}', regex_path)
            
            decorator_patterns = [
                rf'@app\.{method.lower()}\(["\']' + regex_path,
                rf'@router\.{method.lower()}\(["\']' + regex_path,
            ]
            
            for pattern in decorator_patterns:
                if re.search(pattern, all_content):
                    found = True
                    break
        
        if not found:
            for candidate in router_endpoints:
                if candidate["method"] != method:
                    continue
                if _paths_match(base_path, candidate["path"]):
                    found = True
                    break

        if found:
            found_endpoints.append(f"{method} {path}")
        else:
            missing_endpoints.append(f"{method} {path}")
    
    return {
        "ok": len(missing_endpoints) == 0,
        "reason": f"Missing endpoints: {missing_endpoints}" if missing_endpoints else f"All {len(found_endpoints)} endpoints implemented",
        "template": "api_spec_compliance",
        "found_endpoints": found_endpoints,
        "missing_endpoints": missing_endpoints
    }

def backend_server_test(project_dir: str, main_file: str = "main.py", port: int = 8080) -> Dict[str, Any]:
    """Backend 서버 시작 테스트 - 실제로 서버가 시작되는지 확인"""
    main_path = os.path.join(project_dir, main_file)
    if not os.path.exists(main_path):
        return {
            "ok": False,
            "reason": f"Main file not found: {main_file}",
            "template": "backend_server_test"
        }
    
    if importlib.util.find_spec("uvicorn") is None:
        return {
            "ok": True,
            "reason": "uvicorn not installed; backend runtime test skipped",
            "template": "backend_server_test",
            "skipped": True,
        }

    def _find_free_port() -> int:
        with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as sock:
            sock.bind(("127.0.0.1", 0))
            return sock.getsockname()[1]

    port = _find_free_port()

    # 서버 시작 (백그라운드)
    process = None
    try:
        process = subprocess.Popen(
            ['python', '-m', 'uvicorn', 'main:app', '--host', '127.0.0.1', '--port', str(port)],
            cwd=project_dir,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE
        )
        
        # Smart retry: 짧은 초기 대기 + 총 타임아웃 내 폴링
        INITIAL_WAIT_SEC = 1.5
        time.sleep(INITIAL_WAIT_SEC)

        health_ok = False
        health_data = ""
        start_time = time.monotonic()
        attempt = 0

        while time.monotonic() - start_time < BACKEND_HEALTH_TOTAL_WAIT_SEC:
            if process.poll() is not None:
                stdout, stderr = process.communicate(timeout=1)
                health_data = f"Server process exited early: {stderr.decode(errors='ignore')[:120]}"
                break

            for path in ("/health", "/openapi.json", "/docs", "/"):
                try:
                    response = urllib.request.urlopen(
                        f"http://127.0.0.1:{port}{path}",
                        timeout=HEALTH_CHECK_TIMEOUT_SEC
                    )
                    if response.status < 400:
                        health_ok = True
                        health_data = f"{path} -> {response.status}"
                        break
                    health_data = f"{path} -> {response.status}"
                except urllib.error.URLError as e:
                    # Connection refused - server not ready yet
                    health_data = f"{path} -> {str(e)}"
                except Exception as e:
                    health_data = f"{path} -> {str(e)}"

            if health_ok:
                break

            delay = BACKEND_HEALTH_RETRY_DELAYS[min(attempt, len(BACKEND_HEALTH_RETRY_DELAYS) - 1)]
            time.sleep(delay)
            attempt += 1
        
        return {
            "ok": health_ok,
            "reason": "Server started and health check passed" if health_ok else f"Server health check failed: {health_data[:100]}",
            "template": "backend_server_test"
        }
        
    except Exception as e:
        return {
            "ok": False,
            "reason": f"Server start failed: {str(e)[:100]}",
            "template": "backend_server_test"
        }
    finally:
        if process is not None:
            try:
                process.terminate()
                process.wait(timeout=PROCESS_WAIT_TIMEOUT_SEC)
            except (OSError, subprocess.SubprocessError):
                try:
                    process.kill()
                except (OSError, subprocess.SubprocessError):
                    pass


def cors_middleware_check(files: List[str], needs_frontend: bool = False) -> Dict[str, Any]:
    """CORS 미들웨어 존재 여부 검증 - Frontend+Backend 프로젝트에서 필수"""
    if not needs_frontend:
        return {
            "ok": True,
            "reason": "CORS check skipped (no frontend)",
            "template": "cors_middleware_check"
        }
    
    # 모든 Python 파일에서 CORS 관련 코드 검색
    cors_patterns = [
        "CORSMiddleware",
        "add_cors",
        "CORS(",
        "cors_allow",
        "Access-Control-Allow-Origin",
    ]
    
    cors_found = False
    for file in files:
        if file.endswith('.py') and os.path.exists(file):
            try:
                with open(file, 'r', encoding='utf-8', errors='ignore') as f:
                    content = f.read()
                    if any(pattern in content for pattern in cors_patterns):
                        cors_found = True
                        break
            except OSError:
                logger.debug("Failed to read file for CORS check: %s", file)
    
    return {
        "ok": cors_found,
        "reason": "CORS middleware configured" if cors_found else "WARNING: No CORS middleware found. Frontend may fail to connect to backend.",
        "template": "cors_middleware_check"
    }
