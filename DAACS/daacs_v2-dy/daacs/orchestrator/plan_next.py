from typing import Any, Dict, List, Optional
from daacs.config import MAX_FAILED_STREAK


def _create_action(
    action_type: str,
    instruction: str,
    verify_templates: Dict[str, List[str]],
    comment: str = "",
    verify: Optional[List[str]] = None,
    targets: Optional[List[str]] = None,
    client: str = "frontend",
) -> Dict[str, Any]:
    """Helper to create a standard dev_instruction action."""
    return {
        "action": "dev_instruction",
        "type": action_type,
        "instruction": instruction,
        "verify": verify if verify is not None else verify_templates.get(action_type, []),
        "comment": comment,
        "targets": targets or [],
        "client": client
    }


def build_next_plan(
    goal: str,
    failed_streak: int,
    feedback: List[Dict[str, Any]],
    verify_templates: Dict[str, List[str]],
) -> Dict[str, Any]:
    """Determine the next set of actions based on feedback and failure analysis."""
    
    # Check for excessive failures
    if failed_streak >= MAX_FAILED_STREAK:
        return {"stop": True, "reason": "failed_streak_exceeded", "next_goal": goal, "next_actions": []}
        
    if not feedback:
        return {"stop": False, "next_goal": goal, "next_actions": []}

    last = feedback[-1]
    action = last.get("action", {}) or {}
    review = last.get("review", {}) or {}
    result_text = (last.get("result") or "")
    result_lower = result_text.lower()
    verify = review.get("verify", {}) if isinstance(review, dict) else {}
    verdicts = verify.get("verdicts") or []

    failed_reasons = [v.get("reason", "") for v in verdicts if not v.get("ok")]
    
    # Failure categorization
    files_fail = any(r.startswith("files_") for r in failed_reasons)
    tests_fail = any("tests" in r for r in failed_reasons) or "assert" in result_lower
    lint_fail = any("lint" in r for r in failed_reasons)
    build_fail = any("build" in r for r in failed_reasons) or "build failed" in result_lower
    permission_error = "rollout recorder" in result_lower or "operation not permitted" in result_lower
    timeout_error = "timeout" in result_lower or "timed out" in result_lower

    if permission_error:
        # Critical failure requiring manual intervention or stop
        return {"stop": True, "reason": "permission_denied_rollout", "next_goal": goal, "next_actions": []}

    next_actions: List[Dict[str, Any]] = []
    next_goal = goal

    # Recovery Strategies
    
    if action.get("type") == "shell" and files_fail:
        next_actions.append(_create_action(
            "shell",
            "List both files and directories (non-hidden) at repo root using `find . -maxdepth 1 -mindepth 1 -not -name \"files.txt\" -not -path \"./.*\" | sed 's|^./||' | sort > files.txt`.",
            verify_templates,
            "Use find to include directories and avoid repeated listing failures",
            ["files_exist:files.txt", "files_not_empty:files.txt", "files_no_hidden:files.txt", "files_match_listing:files.txt"],
            ["files.txt"]
        ))

    if tests_fail:
        next_actions.append(_create_action(
            "test",
            "Rerun tests with verbose output, capture failing cases, fix blocking issues, and rerun tests until they pass.",
            verify_templates,
            "Retry tests after addressing failures",
            client="backend"
        ))

    if lint_fail:
        next_actions.append(_create_action(
            "refactor",
            "Run lint (e.g., ruff/flake8/pylint), fix reported issues, and rerun lint to ensure a clean result.",
            verify_templates,
            "Resolve lint blockers",
            client="backend"
        ))

    if build_fail or action.get("type") == "build":
        next_actions.append(_create_action(
            "build",
            "Inspect build logs, fix errors, and rerun the same build command to confirm success.",
            verify_templates,
            "Retry build after fixing errors",
            client="backend"
        ))

    if action.get("type") in ["codegen", "refactor"] and not tests_fail and not lint_fail:
        next_actions.append(_create_action(
            "test",
            "Run the project's tests to validate the generated changes; fix any failing cases and rerun.",
            verify_templates,
            "Validate generated code with tests",
            client="backend"
        ))

    if action.get("type") == "deploy":
        next_actions.append(_create_action(
            "build",
            "Ensure the build succeeds before deploy; rerun the build command and fix any errors.",
            verify_templates,
            "Prepare for deploy",
            client="backend"
        ))
        next_actions.append(_create_action(
            "deploy",
            "Retry deploy after build success; capture deploy logs and ensure no permission issues.",
            verify_templates,
            "Retry deploy after build",
            client="backend"
        ))

    if timeout_error and action.get("type") in ["codegen", "refactor", "build", "deploy"]:
        # Hard reset / skeleton strategy for timeouts
        next_actions.append(_create_action(
            "shell",
            "Create project skeleton folders: mkdir -p project && cd project && mkdir -p todo_app tests && touch todo_app/__init__.py tests/__init__.py",
            verify_templates,
            "Ensure directories exist for skeleton",
            [],
            client="frontend"
        ))
        next_actions.append(_create_action(
            "codegen",
            "Create todo_app/main.py with a minimal in-memory ToDoStore (add/list/complete/delete placeholders) and a simple CLI entry guarded by __name__ == '__main__'. Keep it concise.",
            verify_templates,
            "Minimal app entrypoint",
            [],
            client="frontend"
        ))
        next_actions.append(_create_action(
            "codegen",
            "Create tests/test_basic.py with a minimal test for ToDoStore add/list behaviors using pytest; keep it short.",
            verify_templates,
            "Add a basic test to validate codegen",
            None, # Use default from template
            client="backend"
        ))
        next_actions.append(_create_action(
            "test",
            "Run pytest -q to validate the skeleton and capture failures; fix blocking issues if any.",
            verify_templates,
            "Validate skeleton with tests",
            client="backend"
        ))

    # If no specific recovery action was added, we might need a default fallback or just return empty to let the Planner decide ultimate failure
    if not next_actions:
        return {"stop": False, "next_goal": next_goal, "next_actions": []}

    return {"stop": False, "next_goal": next_goal, "next_actions": next_actions}
