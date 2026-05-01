import concurrent.futures
import json
import os
import queue
import threading
try:
    import fcntl
except ImportError:
    fcntl = None  # Windows compatibility
from contextlib import contextmanager
from datetime import datetime
from pathlib import Path
from typing import Any, Dict, Optional

from fastapi import HTTPException

from .config import MIN_CODE_REVIEW_SCORE
from .server_helpers import ProjectFileSystem
from .utils import setup_logger

logger = setup_logger("DAACS-API")

WORKSPACE_BASE = "workspace"
project_fs = ProjectFileSystem(WORKSPACE_BASE)

projects: Dict[str, Dict[str, Any]] = {}
projects_lock = threading.RLock()
nova_executor = concurrent.futures.ThreadPoolExecutor(max_workers=4)

_SENSITIVE_KEYWORDS = {
    "api_key",
    "apikey",
    "token",
    "secret",
    "password",
    "access_key",
    "refresh_token",
    "client_secret",
    "authorization",
}


def _redact_sensitive(value: Any) -> Any:
    if isinstance(value, dict):
        redacted = {}
        for key, item in value.items():
            key_lower = str(key).lower()
            if any(keyword in key_lower for keyword in _SENSITIVE_KEYWORDS):
                redacted[key] = "***REDACTED***"
            else:
                redacted[key] = _redact_sensitive(item)
        return redacted
    if isinstance(value, list):
        return [_redact_sensitive(item) for item in value]
    return value


@contextmanager
def locked_project(p_info: Dict[str, Any]):
    lock = p_info.get("lock")
    if lock:
        with lock:
            yield
    else:
        yield


def get_project_workdir(project_id: str) -> Path:
    with projects_lock:
        p_info = projects.get(project_id)
    if not p_info:
        raise HTTPException(status_code=404, detail="Project not found")
    with locked_project(p_info):
        workdir = p_info.get("workdir") or os.path.join(WORKSPACE_BASE, project_id)
    return Path(workdir).resolve()


def get_project_or_404(project_id: str) -> Dict[str, Any]:
    """
    Get project by ID or raise 404.
    
    WARNING: The returned dict is a reference to the live project state.
    Always use `with locked_project(p_info):` before modifying the dict
    to prevent race conditions. The lock is released after this function
    returns, so modifications without re-acquiring the lock are unsafe.
    
    Returns:
        Project info dict (reference, not copy)
    
    Raises:
        HTTPException: 404 if project not found
    """
    with projects_lock:
        p_info = projects.get(project_id)
    if not p_info:
        raise HTTPException(status_code=404, detail="Project not found")
    return p_info


def save_project_state(project_id: str) -> None:
    """프로젝트 상태를 JSON 파일로 저장"""
    with projects_lock:
        p_info = projects.get(project_id)
    if not p_info:
        return

    with locked_project(p_info):
        state = {
            "id": p_info["id"],
            "goal": p_info["goal"],
            "status": p_info["status"],
            "final_status": p_info.get("final_status"),
            "stop_reason": p_info.get("stop_reason"),
            "created_at": p_info["created_at"],
            "iteration": p_info.get("iteration", 0),
            "needs_backend": p_info.get("needs_backend", True),
            "needs_frontend": p_info.get("needs_frontend", True),
            "plan": p_info.get("plan", ""),
            "plan_status": p_info.get("plan_status"),
            "requirements_plan": p_info.get("requirements_plan"),
            "rfp_data": p_info.get("rfp_data"),
            "rfi_state": p_info.get("rfi_state"),
            "clarification_questions": p_info.get("clarification_questions", []),
            "clarification_answers": p_info.get("clarification_answers", {}),
            "needs_clarification": p_info.get("needs_clarification", False),
            "assumptions": p_info.get("assumptions"),
            "api_spec": p_info.get("api_spec"),
            "messages": p_info.get("messages", []),
            "run_info": p_info.get("run_info", {}),
            "config": p_info.get("config"),
            "quality": p_info.get("quality"),
            "code_review_score": p_info.get("code_review_score"),
            "code_review_passed": p_info.get("code_review_passed"),
            "code_review_critical_issues": p_info.get("code_review_critical_issues"),
            "code_review_goal_aligned": p_info.get("code_review_goal_aligned"),
            "overall_score": p_info.get("code_review_score"),
            "release_gate": p_info.get("release_gate"),
            "release_gate_failures": p_info.get("release_gate_failures", 0),
            "release_gate_guidance": p_info.get("release_gate_guidance"),
            # Verification & Files
            "backend_files": p_info.get("backend_files"),
            "frontend_files": p_info.get("frontend_files"),
            "backend_verification_details": p_info.get("backend_verification_details"),
            "frontend_verification_details": p_info.get("frontend_verification_details"),
            "backend_status": p_info.get("backend_status"),
            "frontend_status": p_info.get("frontend_status"),
            # Replanning state
            "consecutive_failures": p_info.get("consecutive_failures", 0),
            "failure_repeat_count": p_info.get("failure_repeat_count", 0),
            "last_failure_signature": p_info.get("last_failure_signature"),
            "replan_guidance": p_info.get("replan_guidance"),
            "failure_summary": p_info.get("failure_summary"),
            "needs_rework": p_info.get("needs_rework"),
        }
        state = _redact_sensitive(state)

    try:
        workdir = get_project_workdir(project_id)
        if not workdir.exists():
            workdir.mkdir(parents=True, exist_ok=True)

        state_path = workdir / "state.json"
        temp_path = workdir / "state.json.tmp"
        
        # Write to temp file first, then atomic rename
        with open(temp_path, "w", encoding="utf-8") as f:
            # Try to get exclusive lock (non-blocking)
            try:
                if fcntl:
                    fcntl.flock(f.fileno(), fcntl.LOCK_EX | fcntl.LOCK_NB)
                json.dump(state, f, ensure_ascii=False, indent=2)
                if fcntl:
                    fcntl.flock(f.fileno(), fcntl.LOCK_UN)
            except BlockingIOError:
                logger.warning(f"Could not acquire lock for {project_id} state file, skipping save")
                return
        
        # Atomic rename
        os.replace(temp_path, state_path)
    except Exception as e:
        logger.error(f"Failed to save project state for {project_id}: {e}")


def load_project_state(project_id: str) -> Optional[Dict[str, Any]]:
    """프로젝트별 state.json 로드"""
    try:
        workdir = Path(WORKSPACE_BASE) / project_id
        state_path = workdir / "state.json"
        if state_path.exists():
            with open(state_path, "r", encoding="utf-8") as f:
                return json.load(f)
    except Exception as e:
        logger.error(f"Failed to load project state for {project_id}: {e}")
    return None


def load_existing_projects() -> None:
    """서버 시작 시 workspace 폴더를 스캔하여 기존 프로젝트 로드."""
    workspace_dir = Path(WORKSPACE_BASE)
    if not workspace_dir.exists():
        return

    for item in workspace_dir.iterdir():
        if not item.is_dir():
            continue
        pid = item.name
        with projects_lock:
            exists = pid in projects
        if exists:
            continue

        try:
            loaded_state = load_project_state(pid)
            if loaded_state:
                config = loaded_state.get("config")
                if isinstance(config, dict):
                    config["allow_low_quality_delivery"] = False
                    score = config.get("code_review_min_score")
                    if score is None or score < MIN_CODE_REVIEW_SCORE:
                        config["code_review_min_score"] = MIN_CODE_REVIEW_SCORE
                messages = loaded_state.get("messages", [])
                if not messages and loaded_state.get("goal"):
                    messages = [
                        {
                            "id": 1,
                            "projectId": pid,
                            "role": "user",
                            "content": loaded_state.get("goal"),
                            "createdAt": loaded_state.get("created_at", datetime.now().isoformat()),
                        }
                    ]
                record = {
                    "id": pid,
                    "goal": loaded_state.get("goal", "(Loaded)"),
                    "status": loaded_state.get("status", "stopped"),
                    "final_status": loaded_state.get("final_status"),
                    "stop_reason": loaded_state.get("stop_reason"),
                    "created_at": loaded_state.get("created_at", datetime.now().isoformat()),
                    "iteration": loaded_state.get("iteration", 0),
                    "needs_backend": loaded_state.get("needs_backend", True),
                    "needs_frontend": loaded_state.get("needs_frontend", True),
                    "plan": loaded_state.get("plan", ""),
                    "plan_status": loaded_state.get("plan_status"),
                    "requirements_plan": loaded_state.get("requirements_plan"),
                    "rfp_data": loaded_state.get("rfp_data"),
                    "rfi_state": loaded_state.get("rfi_state"),
                    "clarification_questions": loaded_state.get("clarification_questions", []),
                    "clarification_answers": loaded_state.get("clarification_answers", {}),
                    "needs_clarification": loaded_state.get("needs_clarification", False),
                    "assumptions": loaded_state.get("assumptions"),
                    "api_spec": loaded_state.get("api_spec"),
                    "messages": messages,
                    "run_info": loaded_state.get("run_info", {"backend_port": None, "frontend_port": None, "frontend_entry": "/"}),
                    "config": config,
                    "quality": loaded_state.get("quality"),
                    "code_review_score": loaded_state.get("code_review_score"),
                    "code_review_passed": loaded_state.get("code_review_passed"),
                    "code_review_critical_issues": loaded_state.get("code_review_critical_issues"),
                    "code_review_goal_aligned": loaded_state.get("code_review_goal_aligned"),
                    "overall_score": loaded_state.get("overall_score"),
                    "release_gate": loaded_state.get("release_gate"),
                    "release_gate_failures": loaded_state.get("release_gate_failures", 0),
                    "release_gate_guidance": loaded_state.get("release_gate_guidance"),
                    # Verification & Files
                    "backend_files": loaded_state.get("backend_files"),
                    "frontend_files": loaded_state.get("frontend_files"),
                    "backend_verification_details": loaded_state.get("backend_verification_details"),
                    "frontend_verification_details": loaded_state.get("frontend_verification_details"),
                    "backend_status": loaded_state.get("backend_status"),
                    "frontend_status": loaded_state.get("frontend_status"),
                    # Replanning state
                    "consecutive_failures": loaded_state.get("consecutive_failures", 0),
                    "failure_repeat_count": loaded_state.get("failure_repeat_count", 0),
                    "last_failure_signature": loaded_state.get("last_failure_signature"),
                    "replan_guidance": loaded_state.get("replan_guidance"),
                    "failure_summary": loaded_state.get("failure_summary"),
                    "needs_rework": loaded_state.get("needs_rework"),
                    "orchestrator_thread": None,
                    "orchestrator": None,
                    "logs": [],
                    "websockets": set(),
                    "workdir": str(item.resolve()),
                    "input_queue": queue.Queue(),
                    "run_thread": None,
                    "lock": threading.RLock(),
                }
                with projects_lock:
                    projects[pid] = record
            else:
                record = {
                    "id": pid,
                    "goal": "(Loaded manually)",
                    "status": "stopped",
                    "created_at": datetime.now().isoformat(),
                    "orchestrator_thread": None,
                    "orchestrator": None,
                    "plan_status": "draft",
                    "requirements_plan": None,
                    "rfp_data": None,
                    "clarification_questions": [],
                    "clarification_answers": {},
                    "needs_clarification": False,
                    "assumptions": None,
                    "messages": [],
                    "logs": [],
                    "websockets": set(),
                    "workdir": str(item.resolve()),
                    "input_queue": queue.Queue(),
                    "run_thread": None,
                    "run_info": {"backend_port": None, "frontend_port": None, "frontend_entry": "/"},
                    "config": None,
                    "release_gate": None,
                    "api_spec": None,
                    "release_gate_failures": 0,
                    "release_gate_guidance": None,
                    "lock": threading.RLock(),
                }
                with projects_lock:
                    projects[pid] = record
        except Exception as e:
            logger.error(f"Failed to load project {pid}: {e}")
            continue  # Skip this project, continue with others
            
    logger.info(f"Loaded {len(projects)} existing projects from disk: {list(projects.keys())}")
