import json
import os
import subprocess
import shutil
from typing import Any, Dict, List, TypedDict, Optional
from pathlib import Path

from ..utils import setup_logger
from ..config import (
    E2E_PLAYWRIGHT_VERSION,
    E2E_BASE_URL_DEFAULT,
    E2E_BASE_URL_VITE,
    E2E_TEST_TIMEOUT,
)
from .enhanced_verification_utils import find_frontend_dir

logger = setup_logger("EnhancedVerification")

class TestResult(TypedDict):
    ok: bool
    reason: str
    template: str
    files_created: Optional[List[str]]
    dependency_updated: Optional[bool]
    file: Optional[str]
    details: Optional[str]


def _ensure_playwright_dependency(frontend_dir: str) -> Dict[str, Any]:
    package_json_path = os.path.join(frontend_dir, "package.json")
    if not os.path.exists(package_json_path):
        return {"ok": False, "reason": "package.json not found", "updated": False}

    try:
        with open(package_json_path, "r", encoding="utf-8") as f:
            pkg = json.load(f)
    except Exception as e:
        return {"ok": False, "reason": f"Failed to read package.json: {e}", "updated": False}

    deps = pkg.get("dependencies", {}) or {}
    dev_deps = pkg.get("devDependencies", {}) or {}
    if "@playwright/test" in deps or "@playwright/test" in dev_deps:
        return {"ok": True, "reason": "Playwright already present", "updated": False}

    # Use constant for version
    dev_deps["@playwright/test"] = E2E_PLAYWRIGHT_VERSION
    pkg["devDependencies"] = dev_deps

    try:
        with open(package_json_path, "w", encoding="utf-8") as f:
            json.dump(pkg, f, ensure_ascii=False, indent=2)
    except Exception as e:
        return {"ok": False, "reason": f"Failed to update package.json: {e}", "updated": False}

    return {"ok": True, "reason": "Playwright dependency added", "updated": True}


def e2e_test_scaffold(project_dir: str) -> TestResult:
    """
    E2E 테스트 스캐폴드 생성 (Playwright)
    실제 테스트 실행은 별도로 진행
    """
    frontend_dir = find_frontend_dir(project_dir)
    if not frontend_dir:
        return {
            "ok": False,
            "reason": "No frontend package.json found",
            "template": "e2e_test_scaffold",
            "files_created": [],
            "dependency_updated": False,
            "file": None,
            "details": None
        }

    # Playwright config template
    playwright_config = f'''import {{ defineConfig, devices }} from '@playwright/test';

const baseURL = process.env.DAACS_E2E_BASE_URL || '{E2E_BASE_URL_DEFAULT}';
const useWebServer = process.env.DAACS_E2E_SKIP_WEB_SERVER !== 'true';

export default defineConfig({{
  testDir: './tests/e2e',
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 2 : 0,
  workers: process.env.CI ? 1 : undefined,
  reporter: 'html',
  use: {{
    baseURL,
    trace: 'on-first-retry',
  }},
  projects: [
    {{ name: 'chromium', use: {{ ...devices['Desktop Chrome'] }} }},
  ],
  webServer: useWebServer ? {{
    command: 'npm run dev',
    url: baseURL,
    reuseExistingServer: !process.env.CI,
  }} : undefined,
}});
'''

    # Basic E2E test template
    basic_test = '''import { test, expect } from '@playwright/test';

test.describe('Basic E2E Tests', () => {
  test('homepage loads successfully', async ({ page }) => {
    await page.goto('/');
    await expect(page).toHaveTitle(/.*/);
  });

  test('main content is visible', async ({ page }) => {
    await page.goto('/');
    await expect(page.locator('body')).toBeVisible();
  });
});
'''

    # Create files
    try:
        dependency_result = _ensure_playwright_dependency(frontend_dir)

        tests_dir = os.path.join(frontend_dir, "tests", "e2e")
        os.makedirs(tests_dir, exist_ok=True)

        config_path = os.path.join(frontend_dir, "playwright.config.ts")
        test_path = os.path.join(tests_dir, "basic.spec.ts")

        files_created = []

        # Skip if exists
        if not os.path.exists(config_path):
            with open(config_path, "w") as f:
                f.write(playwright_config)
            files_created.append(config_path)

        if not os.path.exists(test_path):
            with open(test_path, "w") as f:
                f.write(basic_test)
            files_created.append(test_path)

        return {
            "ok": dependency_result.get("ok", True),
            "reason": "E2E test scaffold created",
            "template": "e2e_test_scaffold",
            "files_created": files_created,
            "dependency_updated": dependency_result.get("updated", False),
            "file": None,
            "details": None
        }

    except Exception as e:
        logger.error("Failed to create E2E scaffold", exc_info=True)
        return {
            "ok": False,
            "reason": f"Failed to create E2E scaffold: {str(e)}",
            "template": "e2e_test_scaffold",
            "files_created": [],
            "dependency_updated": False,
            "file": None,
            "details": None
        }


def e2e_generate_scenarios(project_dir: str, goal: str) -> TestResult:
    """목표 기반 시나리오 테스트 생성"""
    frontend_dir = find_frontend_dir(project_dir)
    if not frontend_dir:
        return {
            "ok": False,
            "reason": "No frontend package.json found",
            "template": "e2e_scenario_generation",
            "files_created": [],
            "dependency_updated": False,
            "file": "",
            "details": None
        }

    goal_lower = (goal or "").lower()
    scenarios: List[str] = []

    # Scenario generation helpers could be moved to separate file/templates
    if any(k in goal_lower for k in ["login", "로그인", "signin"]):
        scenarios.append(
            """  test('login inputs exist', async ({ page }) => {
    await page.goto('/');
    const emailInput = page.locator('input[type="email"], input[name*="email" i], input[placeholder*="email" i]');
    const passwordInput = page.locator('input[type="password"], input[name*="password" i], input[placeholder*="password" i]');
    const count = (await emailInput.count()) + (await passwordInput.count());
    expect(count).toBeGreaterThan(0);
  });"""
        )

    if any(k in goal_lower for k in ["search", "검색"]):
        scenarios.append(
            """  test('search input exists', async ({ page }) => {
    await page.goto('/');
    const searchInput = page.locator('input[type="search"], input[placeholder*="search" i]');
    expect(await searchInput.count()).toBeGreaterThan(0);
  });"""
        )
    
    # ... (Add other scenarios as needed, logic kept concise for now)

    if not scenarios:
        scenarios.append(
            """  test('primary layout exists', async ({ page }) => {
    await page.goto('/');
    const headings = page.locator('h1, h2, main, [data-testid*="main" i]');
    expect(await headings.count()).toBeGreaterThan(0);
  });"""
        )

    content = "import { test, expect } from '@playwright/test';\n\n"
    content += "test.describe('Scenario E2E Tests', () => {\n"
    content += "\n\n".join(scenarios)
    content += "\n});\n"

    try:
        tests_dir = os.path.join(frontend_dir, "tests", "e2e")
        os.makedirs(tests_dir, exist_ok=True)
        scenario_path = os.path.join(tests_dir, "scenarios.spec.ts")
        with open(scenario_path, "w", encoding="utf-8") as f:
            f.write(content)
        return {
            "ok": True,
            "reason": "Scenario tests generated",
            "template": "e2e_scenario_generation",
            "files_created": [scenario_path],
            "dependency_updated": False,
            "file": scenario_path,
            "details": None
        }
    except Exception as e:
        logger.error("Failed to write scenarios", exc_info=True)
        return {
            "ok": False,
            "reason": f"Failed to write scenarios: {e}",
            "template": "e2e_scenario_generation",
            "files_created": [],
            "dependency_updated": False,
            "file": "",
            "details": None
        }


def e2e_test_run(project_dir: str, timeout: int = E2E_TEST_TIMEOUT) -> TestResult:
    """Playwright E2E 실행"""
    frontend_dir = find_frontend_dir(project_dir)
    if not frontend_dir:
        return {
            "ok": False,
            "reason": "No frontend package.json found",
            "template": "e2e_test_run",
            "files_created": [],
            "dependency_updated": False,
            "file": None,
            "details": ""
        }

    package_json_path = os.path.join(frontend_dir, "package.json")
    try:
        with open(package_json_path, "r", encoding="utf-8") as f:
            pkg = json.load(f)
    except Exception as e:
        return {
            "ok": False,
            "reason": f"Failed to read package.json: {e}",
            "template": "e2e_test_run",
            "files_created": [],
            "dependency_updated": False,
            "file": None,
            "details": ""
        }

    deps = pkg.get("dependencies", {}) or {}
    dev_deps = pkg.get("devDependencies", {}) or {}
    if "@playwright/test" not in deps and "@playwright/test" not in dev_deps:
        return {
            "ok": False,
            "reason": "Playwright dependency missing",
            "template": "e2e_test_run",
            "files_created": [],
            "dependency_updated": False,
            "file": None,
            "details": ""
        }

    scripts = pkg.get("scripts", {}) or {}
    if "dev" not in scripts:
        return {
            "ok": False,
            "reason": "Missing dev script for Playwright webServer",
            "template": "e2e_test_run",
            "files_created": [],
            "dependency_updated": False,
            "file": None,
            "details": ""
        }

    if not shutil.which("npx"):
        return {
            "ok": False,
            "reason": "npx not found; cannot run Playwright",
            "template": "e2e_test_run",
            "files_created": [],
            "dependency_updated": False,
            "file": None,
            "details": ""
        }

    env = os.environ.copy()
    env["CI"] = "1"
    if "DAACS_E2E_BASE_URL" not in env:
        if "vite" in deps or "vite" in dev_deps:
            env["DAACS_E2E_BASE_URL"] = E2E_BASE_URL_VITE
        else:
            env["DAACS_E2E_BASE_URL"] = E2E_BASE_URL_DEFAULT

    try:
        cmd = ["npx", "playwright", "test", "--reporter=line"]
        result = subprocess.run(
            cmd,
            cwd=frontend_dir,
            capture_output=True,
            text=True,
            timeout=timeout,
            shell=False,
            env=env,
        )
    except subprocess.TimeoutExpired:
        return {
            "ok": False,
            "reason": "Playwright test timeout",
            "template": "e2e_test_run",
            "files_created": [],
            "dependency_updated": False,
            "file": None,
            "details": ""
        }

    output = (result.stdout or "") + (result.stderr or "")
    return {
        "ok": result.returncode == 0,
        "reason": "E2E tests passed" if result.returncode == 0 else "E2E tests failed",
        "template": "e2e_test_run",
        "files_created": [],
        "dependency_updated": False,
        "file": None,
        "details": output[-200:],
    }
