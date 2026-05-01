"""
DAACS v6.0 - Replanning Configuration
Centralized configuration for replanning strategies and thresholds.
Enhanced with more specific, actionable instructions for effective self-healing.
"""

from typing import Dict, Any

# 실패 유형 → 재계획 전략 매핑
REPLANNING_STRATEGIES: Dict[str, Dict[str, Any]] = {
    "permission_denied": {
        "stop": True,
        "reason": "Permission error - requires manual intervention",
        "next_actions": [],
        "severity": "critical"
    },

    "tests_fail": {
        "stop": False,
        "reason": "Tests failed - fix the failing assertions",
        "next_actions": [
            {"type": "codegen", "cmd": "Read the test error messages carefully. Fix the code to make tests pass. Do not change the test expectations.", "client": "backend"},
        ],
        "severity": "medium",
        "fix_hint": "Check assertion errors and fix the logic. Tests define expected behavior."
    },

    "lint_fail": {
        "stop": False,
        "reason": "Lint errors - fix code style issues",
        "next_actions": [
            {"type": "codegen", "cmd": "Fix syntax errors, unused imports, and code style issues", "client": "backend"},
        ],
        "severity": "low",
        "fix_hint": "Remove unused imports, fix indentation, add type hints."
    },

    "build_fail": {
        "stop": False,
        "reason": "Build failed - fix import and dependency issues",
        "next_actions": [
            {"type": "codegen", "cmd": "Fix import errors. Ensure all modules exist and are correctly imported. Add missing packages to requirements.txt.", "client": "backend"},
            {"type": "codegen", "cmd": "Fix TypeScript/module errors. Ensure all components and types are correctly exported/imported.", "client": "frontend"}
        ],
        "severity": "high",
        "fix_hint": "Check ModuleNotFoundError, ImportError. Add missing dependencies."
    },

    "deploy_fail": {
        "stop": False,
        "reason": "Deployment failed - fix configuration",
        "next_actions": [
            {"type": "codegen", "cmd": "Ensure the app can start with: uvicorn main:app --host 0.0.0.0 --port 8000", "client": "backend"}
        ],
        "severity": "high",
        "fix_hint": "Check: uvicorn config, port binding, CORS settings, requirements.txt dependencies."
    },

    "codegen_fail": {
        "stop": False,
        "reason": "Code generation incomplete - generate missing files",
        "next_actions": [
            {"type": "codegen", "cmd": "You MUST generate complete files. Use FILE: path/file.ext marker before each file. Do not output partial code.", "client": "backend"}
        ],
        "severity": "medium",
        "fix_hint": "Each file must start with FILE: marker and have complete content."
    },

    "refactor_fail": {
        "stop": False,
        "reason": "Refactoring broke functionality - fix the regression",
        "next_actions": [
            {"type": "codegen", "cmd": "Your changes broke existing functionality. Review the error and restore working behavior while keeping improvements.", "client": "backend"}
        ],
        "severity": "high",
        "fix_hint": "Revert breaking changes while preserving improvements. Check function signatures and imports."
    },

    "verify_fail": {
        "stop": False,
        "reason": "Verification failed - review and fix issues",
        "next_actions": [
            {"type": "codegen", "cmd": "Review the verification feedback and fix all identified issues", "client": "backend"},
            {"type": "codegen", "cmd": "Review the verification feedback and fix all identified issues", "client": "frontend"}
        ],
        "severity": "medium",
        "fix_hint": "Check verification output for specific failures. Fix each reported issue."
    },
    
    "quality_issue": {
        "stop": False,
        "reason": "Code quality below threshold - improve to Level 8+",
        "next_actions": [
            {"type": "codegen", "cmd": "CRITICAL: Your code scored below 8/10. You MUST: 1) Add proper error handling with try/except 2) Add input validation with Pydantic 3) Implement all goal features 4) Handle edge cases 5) Add proper logging", "client": "backend"},
            {"type": "codegen", "cmd": "CRITICAL: Your code scored below 8/10. You MUST: 1) Add loading/error/empty states 2) Add TypeScript types for all data 3) Handle API errors gracefully 4) Implement all UI features from the goal 5) Add proper form validation", "client": "frontend"}
        ],
        "severity": "high",
        "fix_hint": "Focus on: error handling, input validation, completeness, edge cases."
    },

    "goal_miss": {
        "stop": False,
        "reason": "Goal requirements not fully implemented",
        "next_actions": [
            {"type": "codegen", "cmd": "CRITICAL: Your implementation is MISSING required features from the goal. Re-read the goal carefully and implement EVERY feature mentioned. Do not skip any functionality.", "client": "backend"},
            {"type": "codegen", "cmd": "CRITICAL: Your UI is MISSING required features from the goal. Check the goal again and implement ALL user-facing features.", "client": "frontend"}
        ],
        "severity": "high",
        "fix_hint": "Compare your code to the goal - what features are missing?"
    },
    
    "endpoint_mismatch": {
        "stop": False,
        "reason": "Frontend/Backend API mismatch - check proxy configuration first",
        "next_actions": [
            {"type": "codegen", "cmd": "CRITICAL: Frontend calls getting 404? 1) CHECK CONFIG: Verify next.config.js has 'rewrites' to proxy /api. 2) CHECK ANTI-PATTERN: Scan frontend code (e.g., page.tsx, utils/api.ts) for 'window.location.hostname', 'localhost', or '127.0.0.1' logic. DELETE IT. Do not try to outsmart the proxy. 3) FORCE '/api': Hardcode API base to '/api' so it hits the proxy.", "client": "frontend"},
            {"type": "codegen", "cmd": "Ensure backend endpoints match the API spec exactly. If frontend is getting 404s, it might be a configuration issue, but verify your routes are correct.", "client": "backend"}
        ],
        "severity": "high",
        "fix_hint": "404 Error? 1. Check next.config.js Proxy. 2. REMOVE 'window.location.hostname' checks in frontend code (Anti-Pattern). 3. Use '/api' relative path."
    },

    "frontend_entry_missing": {
        "stop": False,
        "reason": "Frontend entrypoint missing - create app/page.tsx and app/layout.tsx",
        "next_actions": [
            {"type": "codegen", "cmd": "CRITICAL: app/page.tsx and/or app/layout.tsx are MISSING. You MUST create these files with COMPLETE implementation (not stubs). The app/page.tsx must contain the full UI with all features.", "client": "frontend"}
        ],
        "severity": "critical",
        "fix_hint": "FILE: app/page.tsx followed by complete React component with all UI logic."
    },

    "frontend_smoke_failed": {
        "stop": False,
        "reason": "Frontend fails to boot - fix runtime errors",
        "next_actions": [
            {"type": "codegen", "cmd": "CRITICAL: Your frontend crashes on startup. Common issues: 1) TypeScript errors 2) Missing imports 3) Invalid JSX 4) Hydration errors 5) Missing dependencies in package.json. Fix the errors so the app renders.", "client": "frontend"}
        ],
        "severity": "critical",
        "fix_hint": "Check: imports, TypeScript types, JSX syntax, useClient/useServer."
    },

    "no_progress": {
        "stop": False,
        "reason": "No file changes detected - force new approach",
        "next_actions": [
            {"type": "codegen", "cmd": "WARNING: Your previous output produced NO file changes. You MUST output DIFFERENT code. Add new features, fix bugs, or improve quality. Do not repeat the same output.", "client": "backend"},
            {"type": "codegen", "cmd": "WARNING: Your previous output produced NO file changes. You MUST output DIFFERENT code. Add new features, fix bugs, or improve quality. Do not repeat the same output.", "client": "frontend"}
        ],
        "severity": "critical",
        "fix_hint": "Your code is identical to before. Make actual changes - add missing features, fix bugs."
    },
    
    "runtime_error": {
        "stop": False,
        "reason": "Runtime crash - fix execution errors",
        "next_actions": [
            {"type": "codegen", "cmd": "CRITICAL: Your app crashes at runtime. Check the error traceback and fix: 1) Missing modules/imports 2) TypeError/AttributeError 3) Database connection issues 4) Port binding issues", "client": "backend"},
            {"type": "codegen", "cmd": "CRITICAL: Your app crashes at runtime. Check browser console for: 1) Import errors 2) Type errors 3) API fetch failures 4) React hydration mismatches", "client": "frontend"}
        ],
        "severity": "critical",
        "fix_hint": "Read the error message carefully - it tells you exactly what to fix."
    },
}

DEFAULT_STRATEGY = {
    "stop": False,
    "reason": "Unknown failure - generic retry with improvements",
    "next_actions": [
        {"type": "codegen", "cmd": "Review all feedback and fix the identified issues", "client": "backend"},
        {"type": "codegen", "cmd": "Review all feedback and fix the identified issues", "client": "frontend"}
    ],
    "severity": "medium"
}

