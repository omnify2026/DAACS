from typing import Any, Dict, List, Optional, TypedDict
import textwrap

from ..models.daacs_state import DAACSState
from ..config import (
    MIN_CODE_REVIEW_SCORE,
    REPLANNING_MAX_FAILURES,
    REPLANNING_PLATEAU_MAX_RETRIES,
    REPLANNING_ALLOW_LOW_QUALITY_DELIVERY,
    REPLANNING_LOG_TAIL_LINES,
)
from ..utils import setup_logger
from .replanning import ReplanningStrategies, detect_failure_type

# Conditional import for MemoryManager pattern
try:
    from ..memory.vector_store import MemoryManager
    HAS_MEMORY = True
except ImportError:
    HAS_MEMORY = False

logger = setup_logger("OrchestratorReplanning")

class ReplanResponse(TypedDict, total=False):
    needs_rework: bool
    backend_needs_rework: bool
    frontend_needs_rework: bool
    failure_type: str
    consecutive_failures: int
    stop_reason: Optional[str]
    last_failure_signature: str
    failure_repeat_count: int
    replan_guidance: str
    prefer_patch: bool
    patch_targets: List[str]
    is_recovery_mode: bool
    best_effort_delivery: bool
    final_status: str


def _tail_log_entries(entries: List[str], max_lines: int) -> List[str]:
    if max_lines <= 0 or not entries:
        return entries
    if len(entries) <= max_lines:
        return entries
    return entries[-max_lines:]


def _get_patch_targets(state: DAACSState, failure_summary: List[str]) -> List[str]:
    """패치 대상 파일 결정"""
    patch_targets: List[str] = []
    
    # 1. 리뷰 기반 patch targets
    review = state.get("code_review", {})
    if isinstance(review, dict):
        for issue in review.get("issues", []):
            if isinstance(issue, dict):
                file = (issue.get("file") or "").strip()
                if file:
                    patch_targets.append(file)
    
    # 2. Frontend Critical Failures
    frontend_entrypoint_missing = bool(state.get("frontend_entrypoint_missing"))
    frontend_smoke_failed = bool(state.get("frontend_smoke_failed"))
    
    if frontend_entrypoint_missing:
        patch_targets.extend(["app/page.tsx", "app/layout.tsx"])
        
    if frontend_smoke_failed:
        patch_targets.extend([
            "app/page.tsx",
            "app/layout.tsx",
            "package.json",
            "tailwind.config.js",
            "postcss.config.js",
            "next.config.js",
        ])
        
    # 3. Compatibility Issues
    compatibility_issues = state.get("compatibility_issues", [])
    if compatibility_issues:
        patch_targets.extend(["backend", "frontend"])
        
    # 4. Stall Recovery
    if "backend_no_progress" in str(failure_summary):
        patch_targets.append("main.py")
    if "frontend_no_progress" in str(failure_summary):
        patch_targets.append("app/page.tsx")

    # 5. Quality fallback (ensure core files get a polish pass)
    code_review_score = state.get("code_review_score", 0)
    code_review_min_score = state.get("code_review_min_score", MIN_CODE_REVIEW_SCORE)
    if not patch_targets and code_review_score < code_review_min_score:
        patch_targets.extend(["backend/main.py", "frontend/app/page.tsx", "frontend/app/layout.tsx"])

    return sorted(list(set(p for p in patch_targets if p)))


def _build_failure_signature(state: DAACSState, failure_type: str, goal_validation: Dict) -> str:
    """실패 시그니처 생성"""
    consistency_passed = state.get("consistency_passed", True)
    code_review_score = state.get("code_review_score", 0)
    code_review_min_score = state.get("code_review_min_score", MIN_CODE_REVIEW_SCORE)
    compatibility_issues = state.get("compatibility_issues", [])

    parts = [
        f"type:{failure_type}",
        f"goal:{goal_validation.get('reason', '')}",
        f"score:{code_review_score}/{code_review_min_score}",
        f"compat:{len(compatibility_issues)}",
        f"consistency:{consistency_passed}",
    ]
    return "|".join(parts)


def _check_plateau(state: DAACSState, failure_signature: str, plateau_threshold: int) -> int:
    """Check if we are stuck in a plateau (repeated failure mode)"""
    last_signature = state.get("last_failure_signature")
    failure_repeat_count = state.get("failure_repeat_count", 0)
    
    if failure_signature == last_signature:
        return failure_repeat_count + 1
    return 1


def _build_replan_guidance(state: DAACSState, failure_type: str) -> str:
    """Build detailed guidance for the next iteration"""
    guidance_parts = []
    
    # 🆕 0. Strategy-based fix hint (most important - specific to failure type)
    from .replanning_config import REPLANNING_STRATEGIES
    strategy = REPLANNING_STRATEGIES.get(failure_type, {})
    fix_hint = strategy.get("fix_hint")
    if fix_hint:
        guidance_parts.append(f"=== 🔧 FIX HINT ===\n{fix_hint}\n")
    
    # 1. Memory suggestions
    failure_summary = state.get("failure_summary", [])
    if HAS_MEMORY:
        try:
            memory = MemoryManager()
            query = f"fix for {failure_type} {str(failure_summary)[:100]}"
            results = memory.search_memory(query, n_results=1, filter_metadata={"type": "solution"})
            if results:
                guidance_parts.append(f"\n=== SUGGESTED FIX FROM MEMORY ===\n{results[0]['content']}\n")
                logger.info("[Replanning] Injected fix from memory.")
        except Exception as e:
            logger.debug(f"Memory retrieval failed: {e}")

    # 2. Quality Gate Issues
    code_review_passed = state.get("code_review_passed", True)
    code_review_score = state.get("code_review_score", 0)
    review = state.get("code_review", {})
    if not code_review_passed and isinstance(review, dict):
        issues = review.get("issues", [])
        critical = [i for i in issues if isinstance(i, dict) and i.get("severity") == "critical"]
        warnings = [i for i in issues if isinstance(i, dict) and i.get("severity") == "warning"]

        if critical:
            guidance_parts.append(f"=== CRITICAL FIXES REQUIRED (score {code_review_score}) ===")
            for i, issue in enumerate(critical[:5], 1):
                guidance_parts.append(f"{i}. {issue.get('description')} ({issue.get('file')}:{issue.get('line')})")
                if issue.get("suggestion"):
                    guidance_parts.append(f"   → Fix: {issue.get('suggestion')}")

        if warnings and len(critical) < 3:
            guidance_parts.append("\n=== WARNINGS ===")
            for issue in warnings[:3]:
                guidance_parts.append(f"- {issue.get('description')}")
        
    # 3. Missing Features
    goal_alignment = review.get("goal_alignment", {}) if isinstance(review, dict) else {}
    if not goal_alignment.get("aligned", True):
        missing = goal_alignment.get("missing_features", [])
        if missing:
            guidance_parts.append("\n=== MISSING FEATURES ===")
            for feat in missing[:5]:
                guidance_parts.append(f"- {feat}")

    # 4. Structural Issues
    if state.get("frontend_entrypoint_missing"):
        guidance_parts.append("\n=== ENTRYPOINT MISSING ===\nCreate app/page.tsx and app/layout.tsx with full UI implementation.")
    
    if state.get("frontend_smoke_failed"):
        # 🆕 Get captured error details from verification
        smoke_error_details = ""
        frontend_verification_details = state.get("frontend_verification_details", [])
        for verdict in frontend_verification_details:
            if verdict.get("template") == "frontend_smoke_test" and not verdict.get("ok"):
                smoke_error_details = verdict.get("error_details", "")
                break
        
        if smoke_error_details:
            guidance_parts.append(f"\n=== FRONTEND SMOKE FAILED ===\n"
                                 f"Actual error from dev server:\n"
                                 f"{smoke_error_details}\n\n"
                                 f"Fix the above error so the app boots and renders / without 404."
            )
        else:
            guidance_parts.append("\n=== FRONTEND SMOKE FAILED ===\nEnsure the app boots and renders / without 404.")

    if not state.get("consistency_passed"):
        guidance_parts.append("\n=== CONSISTENCY CHECK FAILED ===\nAlign frontend API calls with backend endpoints.")

    # 5. Runtime Errors
    runtime_errors = [s for s in failure_summary if "runtime_error" in s or "Scenario verification failed" in s]
    if runtime_errors:
        guidance_parts.append("\n=== RUNTIME/SCENARIO VERIFICATION FAILED ===")
        guidance_parts.append(runtime_errors[0].replace("runtime_error: ", "").strip())
        
        # 🆕 Smart Tip for 404s (Route Mismatch)
        if "404" in str(runtime_errors):
            guidance_parts.append("HINT: 404 Error means Frontend called an API path that Backend doesn't have.\n"
                                  "1. Check `consistency_check` status.\n"
                                  "2. Add the missing @app.get('/path') to backend/main.py.")


    # 6. 🆕 File Parsing Failures
    no_files_errors = [s for s in failure_summary if "No files collected" in s]
    if no_files_errors:
        guidance_parts.append("""
=== FILE PARSING FAILED ===
Your code output was not recognized. You MUST use this exact format:

FILE: path/to/filename.ext
```language
code content here
```

Example:
FILE: main.py
```python
from fastapi import FastAPI
app = FastAPI()

@app.get("/health")
def health():
    return {"status": "ok"}
```

FILE: app/page.tsx
```tsx
export default function Page() {
  return <main>Hello</main>;
}
```

CRITICAL: Each file MUST start with "FILE: " followed by the path, then a code block.
""")

    # 7. 🆕 Missing Endpoints
    missing_endpoints_errors = [s for s in failure_summary if "Missing endpoints" in s]
    if missing_endpoints_errors:
        guidance_parts.append(f"""
=== MISSING API ENDPOINTS ===
{missing_endpoints_errors[0]}

You must create a main.py with FastAPI endpoints. Example:

FILE: main.py
```python
from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware

app = FastAPI()
app.add_middleware(CORSMiddleware, allow_origins=["*"], allow_methods=["*"], allow_headers=["*"])

@app.get("/api/health")
def health():
    return {{"status": "ok"}}

@app.get("/api/versions")
def versions():
    return {{"versions": ["v1.0.0"]}}
```
""")

    # 8. 🆕 NPM Version Errors (ETARGET / No matching version)
    npm_version_errors = [s for s in failure_summary if any(
        pattern in str(s) for pattern in ["No matching version", "ETARGET", "notarget", "npm ERR! 404"]
    )]
    if npm_version_errors:
        guidance_parts.append("""
=== NPM VERSION ERROR ===
A package version you specified does not exist in npm registry.

DO NOT use exact patch versions like "14.1.5" or "19.0.1".
Use semver ranges:
- "^15.0.0" (allows 15.x.x)
- "latest" (always works)

Example GOOD package.json:
{
  "dependencies": {
    "next": "^15.1.0",
    "react": "^19.0.0",
    "react-dom": "^19.0.0"
  }
}

CRITICAL: The scaffold already provides working versions.
Only ADD new dependencies, do NOT modify core package versions.
""")

    # 9. 🆕 Python/Backend import or syntax errors
    python_errors = [s for s in failure_summary if any(
        pattern in str(s) for pattern in ["ModuleNotFoundError", "ImportError", "SyntaxError", "IndentationError"]
    )]
    if python_errors:
        guidance_parts.append("""
=== PYTHON ERROR ===
Fix the Python error in your backend code.

Common fixes:
- ModuleNotFoundError: Add missing package to requirements.txt
- ImportError: Check relative vs absolute imports
- SyntaxError: Fix brackets, quotes, colons
- IndentationError: Use consistent 4-space indentation
""")

    # 10. 🆕 Pydantic V2 Migration Errors
    pydantic_errors = [s for s in failure_summary if any(
        pattern in str(s) for pattern in ["root_validator", "PydanticUserError", "model_validator", "@validator"]
    )]
    if pydantic_errors:
        guidance_parts.append("""
=== PYDANTIC V2 REQUIRED ===
You are using deprecated Pydantic V1 syntax. Update to Pydantic V2:

WRONG (v1): @validator, @root_validator
CORRECT (v2): @field_validator + @classmethod, @model_validator(mode="after")

Example:
```python
from pydantic import field_validator, model_validator

class Model(BaseModel):
    @field_validator("field")
    @classmethod
    def check_field(cls, v):
        return v
    
    @model_validator(mode="after")
    def check_all(self):
        return self
```
""")

    return "\n".join(part for part in guidance_parts if part)


def orchestrator_replanning_node(state: DAACSState, llm_type: str = "gemini") -> Dict[str, Any]:
    """재계획 노드 - ReplanningStrategies 사용"""
    # 1. Extract State
    compatibility_issues = state.get("compatibility_issues", [])
    failure_summary = state.get("failure_summary", [])
    backend_logs = state.get("backend_logs", [])
    frontend_logs = state.get("frontend_logs", [])
    consecutive_failures = state.get("consecutive_failures", 0)
    
    # Config values
    max_failures = state.get("max_failures", REPLANNING_MAX_FAILURES)
    plateau_max_retries = state.get("plateau_max_retries", REPLANNING_PLATEAU_MAX_RETRIES)
    allow_low_quality = REPLANNING_ALLOW_LOW_QUALITY_DELIVERY
    hard_failure = bool(state.get("hard_failure"))

    # 2. Detect Failure Type
    log_entries = _tail_log_entries(backend_logs + frontend_logs, REPLANNING_LOG_TAIL_LINES)
    all_logs = "\n".join(log_entries)
    failure_type = detect_failure_type(failure_summary or compatibility_issues, all_logs)
    
    # Override failure type based on specific flags
    goal_validation = state.get("goal_validation", {})
    code_review_passed = state.get("code_review_passed", True)
    code_review_score = state.get("code_review_score", 0)
    code_review_min_score = state.get("code_review_min_score", MIN_CODE_REVIEW_SCORE)

    if (not code_review_passed) or (code_review_score < code_review_min_score):
        failure_type = "quality_issue"
    if state.get("frontend_entrypoint_missing"):
        failure_type = "frontend_entry_missing"
    elif state.get("frontend_smoke_failed"):
        failure_type = "frontend_smoke_failed"
    elif not goal_validation.get("achieved", True) and failure_type == "verify_fail":
        failure_type = "goal_miss"

    logger.info(
        "[Replanning] Detected failure type: %s, consecutive: %s/%s",
        failure_type, consecutive_failures + 1, max_failures
    )

    # 3. Check Plateau (Repeated Failures)
    failure_signature = _build_failure_signature(state, failure_type, goal_validation)
    failure_repeat_count = _check_plateau(state, failure_signature, plateau_max_retries)

    patch_targets = _get_patch_targets(state, failure_summary)
    
    # CHECK: Plateau Stop Condition
    if failure_repeat_count >= plateau_max_retries:
        reason = f"plateau_detected ({failure_repeat_count}/{plateau_max_retries})"
        response: ReplanResponse = {
            "needs_rework": False,
            "stop_reason": reason,
            "last_failure_signature": failure_signature,
            "failure_repeat_count": failure_repeat_count,
            "prefer_patch": True,
            "patch_targets": patch_targets,
            "final_status": "stopped",
        }
        
        if allow_low_quality and not hard_failure:
            response["best_effort_delivery"] = True
            response["final_status"] = "completed_with_warnings"
            
        return response

    # 4. Generate Replan Guidance
    replan_response = ReplanningStrategies.create_replan_response(
        failure_type=failure_type,
        current_goal=state.get("current_goal", ""),
        consecutive_failures=consecutive_failures + 1,
        max_failures=max_failures,
        context={"issues": compatibility_issues},
    )

    replan_guidance = _build_replan_guidance(state, failure_type)
    
    # 5. Check Stall (No Progress)
    if "no_progress" in str(failure_summary).lower():
        logger.warning("[Replanning] Stall Detected! Attempting 'Kickstart' recovery.")
        
        if state.get("is_recovery_mode"):
             # Already tried recovery, now giving up
            return {
                "needs_rework": False,
                "stop_reason": "stalled_despite_recovery_attempt",
                "final_status": "stopped",
                "best_effort_delivery": False,
                "is_recovery_mode": False,
            }

        return {
            "needs_rework": True,
            "backend_needs_rework": "backend_no_progress" in str(failure_summary),
            "frontend_needs_rework": "frontend_no_progress" in str(failure_summary),
            "is_recovery_mode": True,
            "prefer_patch": True,
            "replan_guidance": (
                "=== STALL DETECTED (NO CODE CHANGES) ===\n"
                "The previous code generation did not modify any files.\n"
                "You MUST make tangible changes to the codebase.\n"
                "1. Review the logs/errors carefully.\n"
                "2. If you are stuck, try a simpler implementation or debug prints.\n"
                "3. DO NOT output the exact same code again."
            ),
            "patch_targets": patch_targets,
            "failure_repeat_count": failure_repeat_count,
            "last_failure_signature": failure_signature,
        }

    # 6. Check Standard Stop
    if replan_response.get("stop"):
        return {
            "needs_rework": False,
            "stop_reason": replan_response.get("reason"),
            "final_status": "completed_with_warnings" if allow_low_quality else "stopped",
            "best_effort_delivery": bool(allow_low_quality),
            "last_failure_signature": failure_signature,
            "failure_repeat_count": failure_repeat_count,
            "replan_guidance": replan_guidance,
            "prefer_patch": True,
            "patch_targets": patch_targets,
            "is_recovery_mode": False,
        }

    # 7. Continue Rework
    return {
        "needs_rework": replan_response.get("needs_rework", False),
        "backend_needs_rework": True,
        "frontend_needs_rework": True,
        "failure_type": failure_type,
        "consecutive_failures": consecutive_failures + 1,
        "stop_reason": None,
        "last_failure_signature": failure_signature,
        "failure_repeat_count": failure_repeat_count,
        "replan_guidance": replan_guidance,
        "prefer_patch": True,
        "patch_targets": patch_targets,
        "is_recovery_mode": False,
    }
