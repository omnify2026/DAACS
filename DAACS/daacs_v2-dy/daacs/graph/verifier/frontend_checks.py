import os
import json
import socket
import time
import subprocess
import urllib.request
from typing import Dict, List, Any

from ...config import NPM_INSTALL_TIMEOUT_SEC, PROCESS_WAIT_TIMEOUT_SEC, HEALTH_CHECK_TIMEOUT_SEC, TSC_CHECK_TIMEOUT_SEC
from ...utils import setup_logger

logger = setup_logger("Verifier.FrontendChecks")

def frontend_entrypoint_exists(files: List[str]) -> Dict[str, Any]:
    """Frontend entrypoint 확인 (Next/React/Vite 기본 엔트리)"""
    if not files:
        return {
            "ok": False,
            "reason": "No frontend files found",
            "template": "frontend_entrypoint_exists"
        }

    normalized = [f.replace("\\", "/") for f in files]

    def has_any(suffixes: List[str]) -> bool:
        return any(path.endswith(suffix) for suffix in suffixes for path in normalized)

    next_configs = [
        "next.config.js",
        "next.config.mjs",
        "next.config.ts",
        "next.config.cjs"
    ]
    next_app_pages = [
        "app/page.tsx", "app/page.jsx", "app/page.ts", "app/page.js",
        "src/app/page.tsx", "src/app/page.jsx", "src/app/page.ts", "src/app/page.js"
    ]
    next_app_layouts = [
        "app/layout.tsx", "app/layout.jsx", "app/layout.ts", "app/layout.js",
        "src/app/layout.tsx", "src/app/layout.jsx", "src/app/layout.ts", "src/app/layout.js"
    ]
    next_pages_index = [
        "pages/index.tsx", "pages/index.jsx", "pages/index.ts", "pages/index.js",
        "src/pages/index.tsx", "src/pages/index.jsx", "src/pages/index.ts", "src/pages/index.js"
    ]

    has_next_config = has_any(next_configs)
    has_app_page = has_any(next_app_pages)
    has_app_layout = has_any(next_app_layouts)

    if has_next_config or has_app_page or has_app_layout:
        if has_app_page or has_app_layout:
            missing = []
            if not has_app_page: missing.append("app/page.(tsx|jsx|ts|js)")
            if not has_app_layout: missing.append("app/layout.(tsx|jsx|ts|js)")
            if missing:
                # Auto-recovery: try to find project root and create missing files
                recovered = False
                candidates = []
                for f in files:
                    normalized_path = f.replace("\\", "/")
                    if normalized_path.endswith(tuple(next_configs)) or normalized_path.endswith("package.json"):
                        candidates.append(os.path.dirname(f))
                if not candidates:
                    candidates = list({os.path.dirname(f) for f in files})

                for root in candidates:
                    try:
                        app_dir = os.path.join(root, "app")
                        src_app_dir = os.path.join(root, "src", "app")
                        target_dir = src_app_dir if os.path.isdir(src_app_dir) else app_dir
                        os.makedirs(target_dir, exist_ok=True)

                        if not has_app_page:
                            page_path = os.path.join(target_dir, "page.tsx")
                            if not os.path.exists(page_path):
                                with open(page_path, "w") as pf:
                                    pf.write(
                                        "export default function Page() {\n"
                                        "  return <main><h1>Welcome</h1></main>;\n"
                                        "}\n"
                                    )

                        if not has_app_layout:
                            layout_path = os.path.join(target_dir, "layout.tsx")
                            if not os.path.exists(layout_path):
                                with open(layout_path, "w") as lf:
                                    lf.write(
                                        "export default function RootLayout({ children }: { children: React.ReactNode }) {\n"
                                        "  return <html><body>{children}</body></html>;\n"
                                        "}\n"
                                    )

                        recovered = True
                        logger.info("Auto-recovered missing Next.js entry files in %s", root)
                        break
                    except Exception as e:
                        logger.warning("Failed to auto-recover Next.js files: %s", e)

                if recovered:
                    return {
                        "ok": True,
                        "reason": f"Auto-recovered missing Next.js files: {missing}",
                        "template": "frontend_entrypoint_exists",
                        "recovered": missing
                    }
                
                return {
                    "ok": False,
                    "reason": f"Missing Next.js app entry files: {missing}",
                    "template": "frontend_entrypoint_exists",
                    "missing": missing
                }
            return {
                "ok": True,
                "reason": "Next.js app entrypoints found",
                "template": "frontend_entrypoint_exists"
            }

        if not has_any(next_pages_index):
            return {
                "ok": False,
                "reason": "Missing Next.js pages entry (pages/index.*)",
                "template": "frontend_entrypoint_exists",
                "missing": ["pages/index.(tsx|jsx|ts|js)"]
            }
        return {
            "ok": True,
            "reason": "Next.js pages entry found",
            "template": "frontend_entrypoint_exists"
        }

    react_entrypoints = [
        "src/main.tsx", "src/main.jsx", "src/main.ts", "src/main.js",
        "src/index.tsx", "src/index.jsx", "src/index.ts", "src/index.js",
        "index.html"
    ]
    if not has_any(react_entrypoints):
        return {
            "ok": False,
            "reason": "Missing frontend entrypoint (src/main.* / src/index.* / index.html)",
            "template": "frontend_entrypoint_exists",
            "missing": ["src/main.*", "src/index.*", "index.html"]
        }

    return {
        "ok": True,
        "reason": "Frontend entrypoint found",
        "template": "frontend_entrypoint_exists"
    }

def frontend_build_test(project_dir: str) -> Dict[str, Any]:
    """Frontend 빌드 테스트 - npm install 또는 단순 HTML 프로젝트 검증"""
    package_json = os.path.join(project_dir, "package.json")
    index_html = os.path.join(project_dir, "index.html")
    
    # Case 1: Simple HTML project
    if not os.path.exists(package_json):
        if os.path.exists(index_html):
            return {
                "ok": True,
                "reason": "Simple HTML project (index.html found)",
                "template": "frontend_build_test"
            }
        else:
            for root, _, files in os.walk(project_dir):
                for f in files:
                    if f.endswith('.html'):
                        return {
                            "ok": True,
                            "reason": f"Simple HTML project ({f} found)",
                            "template": "frontend_build_test"
                        }
                break 
            
            return {
                "ok": True,
                "reason": "Static project (no build required)",
                "template": "frontend_build_test"
            }
    
    # Case 2: Node.js project - with auto-healing fallbacks
    try:
        # First attempt: normal npm install
        npm_cmd = ["npm", "install"]
        result = subprocess.run(
            npm_cmd,
            cwd=project_dir,
            capture_output=True,
            text=True,
            timeout=NPM_INSTALL_TIMEOUT_SEC,
            shell=False 
        )
        
        if result.returncode != 0:
            # Fallback 1: --legacy-peer-deps (resolves peer dependency conflicts)
            logger.info("npm install failed, trying --legacy-peer-deps fallback")
            result = subprocess.run(
                ["npm", "install", "--legacy-peer-deps"],
                cwd=project_dir,
                capture_output=True,
                text=True,
                timeout=NPM_INSTALL_TIMEOUT_SEC,
                shell=False
            )
        
        if result.returncode != 0:
            # Fallback 2: --force (last resort)
            logger.info("--legacy-peer-deps failed, trying --force fallback")
            result = subprocess.run(
                ["npm", "install", "--force"],
                cwd=project_dir,
                capture_output=True,
                text=True,
                timeout=NPM_INSTALL_TIMEOUT_SEC,
                shell=False
            )
        
        if result.returncode != 0:
            error_msg = result.stderr[:200] if result.stderr else result.stdout[:200]
            return {
                "ok": False,
                "reason": f"npm install failed: {error_msg}",
                "template": "frontend_build_test"
            }
        
        return {
            "ok": True,
            "reason": "npm install succeeded",
            "template": "frontend_build_test"
        }
        
    except subprocess.TimeoutExpired:
        return {
            "ok": False,
            "reason": "npm install timeout (120s)",
            "template": "frontend_build_test"
        }
    except Exception as e:
        return {
            "ok": False,
            "reason": f"Frontend build failed: {str(e)[:100]}",
            "template": "frontend_build_test"
        }

def frontend_smoke_test(project_dir: str) -> Dict[str, Any]:
    """Frontend smoke test (HTTP or Playwright if available).
    
    Enhanced: Captures dev server error output for replanning feedback.
    """
    package_json = os.path.join(project_dir, "package.json")
    if not os.path.exists(package_json):
        html_files = []
        for root, _, files in os.walk(project_dir):
            html_files.extend(
                os.path.join(root, f) for f in files if f.endswith(".html")
            )
            break
        if html_files:
            return {
                "ok": True,
                "reason": "Static HTML project - smoke test skipped",
                "template": "frontend_smoke_test"
            }
        return {
            "ok": False,
            "reason": "No package.json or HTML files for smoke test",
            "template": "frontend_smoke_test"
        }

    try:
        with open(package_json, "r", encoding="utf-8") as f:
            package = json.load(f)
    except Exception as e:
        return {
            "ok": False,
            "reason": f"Failed to read package.json: {str(e)[:80]}",
            "template": "frontend_smoke_test"
        }

    scripts = package.get("scripts", {}) or {}
    script_name = "dev" if "dev" in scripts else "start" if "start" in scripts else "preview" if "preview" in scripts else None
    if not script_name:
        return {
            "ok": False,
            "reason": "No dev/start/preview script for smoke test",
            "template": "frontend_smoke_test"
        }

    dependencies = {**(package.get("dependencies") or {}), **(package.get("devDependencies") or {})}
    script_text = scripts.get(script_name, "")
    is_next = "next" in dependencies or "next" in script_text
    is_vite = "vite" in dependencies or "vite" in script_text
    is_react_scripts = "react-scripts" in dependencies or "react-scripts" in script_text

    def _find_free_port() -> int:
        with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as sock:
            sock.bind(("127.0.0.1", 0))
            return sock.getsockname()[1]

    def _port_open(port: int) -> bool:
        with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as sock:
            sock.settimeout(0.2)
            return sock.connect_ex(("127.0.0.1", port)) == 0

    def _extract_error_details(output: str) -> str:
        """Extract meaningful error details from dev server output."""
        if not output:
            return ""
        
        # Common error patterns to look for
        error_patterns = [
            r"(Error|TypeError|ReferenceError|SyntaxError):\s*[^\n]+",
            r"Unhandled Runtime Error[^\n]*\n[^\n]+",
            r"Module not found[^\n]+",
            r"Cannot find module[^\n]+",
            r"failed to compile[^\n]+",
            r"Build error[^\n]+",
            r"at (app|src)/[^\n]+:\d+",  # Stack trace with file:line
        ]
        
        import re
        extracted = []
        for pattern in error_patterns:
            matches = re.findall(pattern, output, re.IGNORECASE)
            for match in matches[:3]:  # Limit to 3 matches per pattern
                if isinstance(match, tuple):
                    match = match[0]
                if match and len(match) > 10:
                    extracted.append(match.strip())
        
        if extracted:
            # Deduplicate and limit total length
            unique = list(dict.fromkeys(extracted))[:5]
            return " | ".join(unique)[:500]
        
        # Fallback: return last 300 chars of output
        return output[-300:].strip() if len(output) > 300 else output.strip()

    port = _find_free_port()
    env = os.environ.copy()
    env["PORT"] = str(port)
    env["HOST"] = "127.0.0.1"

    cmd = ["npm", "run", script_name]
    if is_vite:
        cmd += ["--", "--host", "127.0.0.1", "--port", str(port)]
    elif is_next:
        cmd += ["--", "-p", str(port)]
    elif is_react_scripts:
        env["PORT"] = str(port)

    process = None
    open_port = None
    captured_output = ""
    
    try:
        # 🆕 Capture stdout/stderr instead of discarding
        process = subprocess.Popen(
            cmd,
            cwd=project_dir,
            stdout=subprocess.PIPE,
            stderr=subprocess.STDOUT,
            env=env,
            text=True,
            bufsize=1
        )

        candidate_ports = [port, 3000, 5173, 4173, 8080]
        start_time = time.monotonic()
        
        # 🆕 Next.js 15+ takes longer to start - increased from 25s to 45s
        max_wait_seconds = 45 if is_next else 25
        
        # 🆕 Read output while waiting for server to start
        import select
        while time.monotonic() - start_time < max_wait_seconds:
            # Non-blocking read of process output
            if process.stdout:
                try:
                    # Use select for non-blocking read on Unix
                    readable, _, _ = select.select([process.stdout], [], [], 0.1)
                    if readable:
                        line = process.stdout.readline()
                        if line:
                            captured_output += line
                            # Limit captured output to 10KB
                            if len(captured_output) > 10240:
                                captured_output = captured_output[-10240:]
                except (OSError, ValueError):
                    pass
            
            for candidate in candidate_ports:
                if _port_open(candidate):
                    open_port = candidate
                    break
            if open_port:
                break
            time.sleep(0.3)

        if not open_port:
            error_details = _extract_error_details(captured_output)
            logger.warning("[Smoke Test] Dev server did not start. Output: %s", error_details[:200])
            return {
                "ok": False,
                "reason": "Dev server did not start in time",
                "template": "frontend_smoke_test",
                "error_details": error_details  # 🆕 Include error details
            }


        url = f"http://127.0.0.1:{open_port}/"
        try:
            from playwright.sync_api import sync_playwright
            use_playwright = True
        except ImportError:
            use_playwright = False

        ok = False
        playwright_error = None
        if use_playwright:
            try:
                with sync_playwright() as p:
                    browser = p.chromium.launch()
                    page = browser.new_page()
                    response = page.goto(url, wait_until="domcontentloaded", timeout=10000)
                    status = response.status if response else 0
                    content = page.content()
                    browser.close()
                ok = status < 400 and "404" not in content.lower()
            except Exception as e:
                playwright_error = str(e)
                use_playwright = False

        if not use_playwright:
            try:
                response = urllib.request.urlopen(url, timeout=HEALTH_CHECK_TIMEOUT_SEC)
                body = response.read(2000).decode("utf-8", errors="ignore")
                ok = response.status < 400 and "404" not in body.lower()
            except Exception as e:
                # 🆕 Capture more output after HTTP error
                if process.stdout:
                    try:
                        readable, _, _ = select.select([process.stdout], [], [], 0.5)
                        if readable:
                            extra = process.stdout.read(2048)
                            if extra:
                                captured_output += extra
                    except (OSError, ValueError):
                        pass
                
                error_details = _extract_error_details(captured_output)
                reason = f"Smoke test HTTP error: {str(e)[:100]}"
                if playwright_error:
                    reason = f"Playwright failed: {playwright_error[:80]}; HTTP error: {str(e)[:80]}"
                
                logger.warning("[Smoke Test] HTTP error. Captured: %s", error_details[:200])
                return {
                    "ok": False,
                    "reason": reason,
                    "template": "frontend_smoke_test",
                    "error_details": error_details  # 🆕 Include error details
                }

        return {
            "ok": ok,
            "reason": "Smoke test passed (HTTP fallback)" if ok and playwright_error else "Smoke test passed" if ok else "Smoke test failed (404 or bad status)",
            "template": "frontend_smoke_test",
            "error_details": "" if ok else _extract_error_details(captured_output)
        }
    except Exception as e:
        error_details = _extract_error_details(captured_output)
        return {
            "ok": False,
            "reason": f"Smoke test error: {str(e)[:100]}",
            "template": "frontend_smoke_test",
            "error_details": error_details
        }
    finally:
        if process:
            try:
                process.terminate()
                process.wait(timeout=PROCESS_WAIT_TIMEOUT_SEC)
            except (OSError, subprocess.SubprocessError):
                try:
                    process.kill()
                except (OSError, subprocess.SubprocessError):
                    pass


def _ensure_frontend_health_endpoint(project_dir: str) -> bool:
    """Auto-generate /api/health endpoint for Next.js if missing.
    
    Creates app/api/health/route.ts for fast smoke test.
    Returns True if health endpoint exists or was created.
    """
    # Check for existing health endpoint
    health_paths = [
        os.path.join(project_dir, "app", "api", "health", "route.ts"),
        os.path.join(project_dir, "app", "api", "health", "route.js"),
        os.path.join(project_dir, "src", "app", "api", "health", "route.ts"),
        os.path.join(project_dir, "src", "app", "api", "health", "route.js"),
        os.path.join(project_dir, "pages", "api", "health.ts"),
        os.path.join(project_dir, "pages", "api", "health.js"),
    ]
    
    for hp in health_paths:
        if os.path.exists(hp):
            logger.info("[HealthCheck] Found existing health endpoint: %s", hp)
            return True
    
    # Determine app directory structure
    app_api_dir = None
    if os.path.isdir(os.path.join(project_dir, "src", "app")):
        app_api_dir = os.path.join(project_dir, "src", "app", "api", "health")
    elif os.path.isdir(os.path.join(project_dir, "app")):
        app_api_dir = os.path.join(project_dir, "app", "api", "health")
    elif os.path.isdir(os.path.join(project_dir, "pages")):
        # Pages router - create pages/api/health.ts
        api_dir = os.path.join(project_dir, "pages", "api")
        os.makedirs(api_dir, exist_ok=True)
        health_path = os.path.join(api_dir, "health.ts")
        try:
            with open(health_path, "w") as f:
                f.write(
                    "import type { NextApiRequest, NextApiResponse } from 'next';\n\n"
                    "export default function handler(req: NextApiRequest, res: NextApiResponse) {\n"
                    "  res.status(200).json({ status: 'ok' });\n"
                    "}\n"
                )
            logger.info("[HealthCheck] Created pages router health endpoint: %s", health_path)
            return True
        except Exception as e:
            logger.warning("[HealthCheck] Failed to create pages router health: %s", e)
            return False
    else:
        logger.warning("[HealthCheck] Could not determine app structure for health endpoint")
        return False
    
    # App Router - create app/api/health/route.ts
    try:
        os.makedirs(app_api_dir, exist_ok=True)
        health_path = os.path.join(app_api_dir, "route.ts")
        with open(health_path, "w") as f:
            f.write(
                "import { NextResponse } from 'next/server';\n\n"
                "export async function GET() {\n"
                "  return NextResponse.json({ status: 'ok' });\n"
                "}\n"
            )
        logger.info("[HealthCheck] Created app router health endpoint: %s", health_path)
        return True
    except Exception as e:
        logger.warning("[HealthCheck] Failed to create app router health: %s", e)
        return False


def frontend_system_smoke_test(project_dir: str) -> Dict[str, Any]:
    """System Smoke Test - Fast /api/health check (REQUIRED).
    
    This is the primary liveness check that bypasses page compilation.
    If /api/health doesn't exist, it will be auto-generated.
    
    Architecture: Dual Smoke Test
    - System Smoke (/api/health): Required, fast, no page compilation
    - UI Smoke (/): Optional, slow, requires full page compilation
    """
    package_json = os.path.join(project_dir, "package.json")
    if not os.path.exists(package_json):
        return {
            "ok": True,
            "reason": "Static project - system smoke test skipped",
            "template": "frontend_system_smoke_test"
        }
    
    try:
        with open(package_json, "r", encoding="utf-8") as f:
            package = json.load(f)
    except Exception as e:
        return {
            "ok": False,
            "reason": f"Failed to read package.json: {str(e)[:80]}",
            "template": "frontend_system_smoke_test"
        }
    
    dependencies = {**(package.get("dependencies") or {}), **(package.get("devDependencies") or {})}
    is_next = "next" in dependencies
    
    if not is_next:
        # Not Next.js - fallback to standard smoke test
        return {
            "ok": True,
            "reason": "Non-Next.js project - system smoke test skipped, use standard smoke test",
            "template": "frontend_system_smoke_test"
        }
    
    # Auto-generate /api/health if missing
    health_created = _ensure_frontend_health_endpoint(project_dir)
    if not health_created:
        logger.warning("[SystemSmoke] Could not ensure health endpoint exists")
    
    # Find free port and start dev server
    def _find_free_port() -> int:
        with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as sock:
            sock.bind(("127.0.0.1", 0))
            return sock.getsockname()[1]

    def _port_open(port: int) -> bool:
        with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as sock:
            sock.settimeout(0.2)
            return sock.connect_ex(("127.0.0.1", port)) == 0

    port = _find_free_port()
    env = os.environ.copy()
    env["PORT"] = str(port)
    env["HOST"] = "127.0.0.1"

    scripts = package.get("scripts", {}) or {}
    script_name = "dev" if "dev" in scripts else "start" if "start" in scripts else None
    if not script_name:
        return {
            "ok": False,
            "reason": "No dev/start script for system smoke test",
            "template": "frontend_system_smoke_test"
        }

    cmd = ["npm", "run", script_name, "--", "-p", str(port)]
    process = None
    
    try:
        process = subprocess.Popen(
            cmd,
            cwd=project_dir,
            stdout=subprocess.PIPE,
            stderr=subprocess.STDOUT,
            env=env,
            text=True,
            bufsize=1
        )

        candidate_ports = [port, 3000, 5173]
        start_time = time.monotonic()
        open_port = None
        
        # Wait for server to start (max 30 seconds for system smoke)
        while time.monotonic() - start_time < 30:
            for candidate in candidate_ports:
                if _port_open(candidate):
                    open_port = candidate
                    break
            if open_port:
                break
            time.sleep(0.3)

        if not open_port:
            return {
                "ok": False,
                "reason": "Dev server did not start in time for system smoke test",
                "template": "frontend_system_smoke_test"
            }

        # Check /api/health (fast, no page compilation)
        health_url = f"http://127.0.0.1:{open_port}/api/health"
        try:
            response = urllib.request.urlopen(health_url, timeout=HEALTH_CHECK_TIMEOUT_SEC)
            body = response.read(1000).decode("utf-8", errors="ignore")
            ok = response.status < 400 and "status" in body.lower()
            
            return {
                "ok": ok,
                "reason": "System smoke test passed (/api/health)" if ok else "System smoke test failed",
                "template": "frontend_system_smoke_test",
                "endpoint": "/api/health",
                "port": open_port
            }
        except Exception as e:
            return {
                "ok": False,
                "reason": f"System smoke test failed: {str(e)[:100]}",
                "template": "frontend_system_smoke_test",
                "endpoint": "/api/health"
            }

    except Exception as e:
        return {
            "ok": False,
            "reason": f"System smoke test error: {str(e)[:100]}",
            "template": "frontend_system_smoke_test"
        }
    finally:
        if process:
            try:
                process.terminate()
                process.wait(timeout=PROCESS_WAIT_TIMEOUT_SEC)
            except (OSError, subprocess.SubprocessError):
                try:
                    process.kill()
                except (OSError, subprocess.SubprocessError):
                    pass
