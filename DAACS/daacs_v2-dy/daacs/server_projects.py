import os
import queue
import shutil
import subprocess
import threading
import time
from datetime import datetime
from pathlib import Path
from typing import Any, Dict, List
from uuid import uuid4

from fastapi import HTTPException

from .api.models import ProjectConfig, ProjectRequest, ProjectSyncRequest
from .config import BACKUP_KEEP, INPUT_PROVIDER_TIMEOUT_SEC, MIN_CODE_REVIEW_SCORE, DEFAULT_VERIFICATION_LANE
from .graph.config_loader import DAACSConfig
from .orchestrator.core import DAACSOrchestrator
from .server_helpers import GitOperations, ProjectFileSystem, SourceSynchronizer
from .server_state import get_project_workdir, locked_project, logger, project_fs, projects, projects_lock

SOURCE_DIR_NAME = ".daacs_source"
BACKUP_DIR_NAME = ".daacs_backups"
IGNORED_DIRS = set(ProjectFileSystem.IGNORED_DIRS) | {
    ".daacs_cache",
    SOURCE_DIR_NAME,
    BACKUP_DIR_NAME,
    ".pytest_cache",
}
IGNORED_FILES = set(ProjectFileSystem.IGNORED_FILES)
MAX_PROJECT_FILES = ProjectFileSystem.MAX_PROJECT_FILES


def _get_project_source_dir(project_id: str) -> Path:
    return get_project_workdir(project_id) / SOURCE_DIR_NAME


def _resolve_project_path(project_id: str, rel_path: str) -> Path:
    if not rel_path:
        raise HTTPException(status_code=400, detail="Missing file path")
    base = get_project_workdir(project_id)
    candidate = (base / rel_path).resolve()
    if not candidate.is_relative_to(base):
        raise HTTPException(status_code=400, detail="Invalid file path")
    if candidate.name == "state.json":
        raise HTTPException(status_code=403, detail="Access to state.json is forbidden")
    return candidate


def _classify_file(rel_posix: str) -> str:
    first = rel_posix.split("/", 1)[0]
    if first in {"frontend", "client", "ui", "web"}:
        return "frontend"
    if first in {"backend", "server", "api"}:
        return "backend"

    ext = Path(rel_posix).suffix.lower()
    if ext in {".ts", ".tsx", ".js", ".jsx", ".css", ".scss", ".sass", ".html", ".vue", ".svelte"}:
        return "frontend"
    return "backend"


def _list_project_files(project_id: str) -> Dict[str, List[str]]:
    """프로젝트 파일 목록 조회 (Phase 6: project_fs 헬퍼 활용)"""
    result = project_fs.list_files(project_id)
    return {
        "backend_files": sorted(result.get("backend", []) + result.get("config", [])),
        "frontend_files": sorted(result.get("frontend", [])),
    }


def _get_next_project_id(prefix: str = "") -> str:
    with projects_lock:
        while True:
            # Generate shorter UUID for readability if prefix is present
            unique_part = uuid4().hex[:12] if prefix else uuid4().hex
            
            if prefix:
                # Sanitize prefix again just in case (alphanumeric only)
                clean_prefix = "".join(c for c in prefix if c.isalnum() or c in ("_", "-"))
                candidate = f"{clean_prefix}_{unique_part}"
            else:
                candidate = unique_part

            if candidate not in projects:
                return candidate


def _clone_git_repo(repo_url: str, workdir: str) -> None:
    os.makedirs(workdir, exist_ok=True)
    result = GitOperations.clone(repo_url, workdir)
    if not result["success"]:
        error_msg = (result.get("error") or "Unknown error")[:200]
        raise HTTPException(status_code=400, detail=f"Git clone failed: {error_msg}")


def _copy_source_folder(source_path: str, target_dir: str, replace: bool = False) -> None:
    source_path = os.path.abspath(source_path)
    target_dir = os.path.abspath(target_dir)
    if not os.path.isdir(source_path):
        raise HTTPException(status_code=400, detail=f"Source path not found: {source_path}")

    result = SourceSynchronizer.copy_folder(source_path, target_dir, replace)
    if not result["success"]:
        error_msg = result.get("error", "Unknown error")
        raise HTTPException(status_code=400, detail=f"Folder copy error: {error_msg}")


def _prepare_project_workspace(req: ProjectRequest, project_id: str) -> str:
    workdir = os.path.abspath(os.path.join("workspace", project_id))
    if req.source_git:
        _clone_git_repo(req.source_git, workdir)
        return workdir
    if req.source_path:
        _copy_source_folder(req.source_path, workdir)
        return workdir
    os.makedirs(workdir, exist_ok=True)
    return workdir


def _build_project_record(project_id: str, req: ProjectRequest, workdir: str, config: ProjectConfig) -> Dict[str, Any]:
    config = _enforce_quality_config(config)
    config_dict = _config_to_dict(config)
    return {
        "id": project_id,
        "goal": req.goal,
        "status": "created",
        "final_status": None,
        "stop_reason": None,
        "created_at": datetime.now().isoformat(),
        "iteration": 0,
        "needs_backend": True,
        "needs_frontend": True,
        "plan": "",
        "plan_status": "draft",
        "requirements_plan": None,
        "rfp_data": None,
        "clarification_questions": [],
        "clarification_answers": {},
        "needs_clarification": False,
        "assumptions": None,
        "api_spec": {},
        "logs": [],
        "workdir": workdir,
        "run_info": {"backend_port": None, "frontend_port": None, "frontend_entry": "/"},
        "run_thread": None,
        "orchestrator": None,
        "input_queue": queue.Queue(),
        "messages": [
            {
                "id": 1,
                "projectId": project_id,
                "role": "user",
                "content": req.goal,
                "createdAt": datetime.now().isoformat(),
            }
        ],
        "config": config_dict,
        "release_gate": None,
        "release_gate_failures": 0,
        "release_gate_guidance": None,
        "lock": threading.RLock(),
    }


def _apply_global_execution_defaults(config: ProjectConfig) -> ProjectConfig:
    global_cfg = DAACSConfig.get_instance()
    exec_cfg = global_cfg.get_execution_config()
    data = config.model_dump()
    explicit = set(getattr(config, "model_fields_set", set()) or set())
    field_mapping = {
        "parallel_execution": "parallel_execution",
        "max_iterations": "max_iterations",
        "max_failures": "max_failures",
        "max_no_progress": "max_no_progress",
        "code_review_min_score": "code_review_min_score",
        "plateau_max_retries": "plateau_max_retries",
        "verification_lane": "verification_lane",
        "allow_low_quality_delivery": "allow_low_quality_delivery",
        "enable_quality_gates": "enable_quality_gates",
        "enable_release_gate": "enable_release_gate",
    }

    for field, key in field_mapping.items():
        if field in explicit:
            continue
        value = exec_cfg.get(key)
        if value is not None:
            data[field] = value

    try:
        return ProjectConfig(**data)
    except Exception:
        return config


def _create_orchestrator(config: ProjectConfig, workdir: str, event_cb: callable) -> DAACSOrchestrator:
    config = _enforce_quality_config(config)
    return DAACSOrchestrator(
        analyst_model=config.orchestrator_model,
        frontend_model=config.frontend_model,
        backend_model=config.backend_model,
        workdir=workdir,
        max_turns=config.max_iterations or 10,
        max_failures=config.max_failures or 10,
        max_no_progress=config.max_no_progress or 2,
        code_review_min_score=config.code_review_min_score or MIN_CODE_REVIEW_SCORE,
        allow_low_quality_delivery=False,
        plateau_max_retries=config.plateau_max_retries or 3,
        mode=config.mode,
        parallel_execution=config.parallel_execution,
        force_backend=config.force_backend,
        enable_quality_gates=config.enable_quality_gates,  # 🆕 UI에서 설정 가능
        verification_lane=config.verification_lane,
        event_callback=event_cb,
    )


def _build_input_provider(p_info: Dict[str, Any]) -> callable:
    max_wait_seconds = INPUT_PROVIDER_TIMEOUT_SEC
    
    def _provider(_prompt: str) -> str:
        import time
        start_time = time.time()
        logger.info(f"[InputProvider] Waiting for input (Timeout: {max_wait_seconds}s). Prompt: {_prompt[:100]}...")
        
        while True:
            # Check overall timeout
            if time.time() - start_time > max_wait_seconds:
                logger.warning("[InputProvider] Timed out waiting for input")
                return "timeout"
            
            orch = p_info.get("orchestrator")
            if orch and getattr(orch, "stop_requested", False):
                logger.info("[InputProvider] Stop requested")
                return "stop"
            try:
                val = p_info["input_queue"].get(timeout=1)
                logger.info(f"[InputProvider] Received input: {val[:100]}")
                return val
            except queue.Empty:
                continue

    return _provider


def _request_orchestrator_stop(p_info: Dict[str, Any], reason: str = "user") -> None:
    with locked_project(p_info):
        orch = p_info.get("orchestrator")
        if orch:
            try:
                orch.request_stop(reason)
            except (AttributeError, RuntimeError):
                pass
        input_queue = p_info.get("input_queue")
        if input_queue:
            try:
                input_queue.put_nowait("stop")
            except queue.Full:
                input_queue.put("stop")


def _reset_project_runtime_state(
    p_info: Dict[str, Any],
    clear_logs: bool = True,
    clear_messages: bool = False,
    reset_release_gate_failures: bool = True,
) -> None:
    """Reset per-run runtime state to avoid cross-run leakage."""
    with locked_project(p_info):
        if clear_logs:
            p_info["logs"] = []
        if clear_messages:
            p_info["messages"] = []
        if reset_release_gate_failures:
            p_info["release_gate_failures"] = 0
            p_info["release_gate_guidance"] = None
        p_info["workflow_state"] = {}

        p_info["final_status"] = None
        p_info["stop_reason"] = None
        p_info["input_queue"] = queue.Queue()
        orch = p_info.get("orchestrator")
        if orch:
            reset = getattr(orch, "reset_for_run", None)
            if callable(reset):
                reset()
            else:
                setattr(orch, "stop_requested", False)
                setattr(orch, "stop_reason", "")
            orch.input_provider = _build_input_provider(p_info)
            orch.planner_module.input_provider = orch.input_provider


def _project_public_view(project_info: Dict[str, Any]) -> Dict[str, Any]:
    return {k: v for k, v in project_info.items() if k not in ["orchestrator", "input_queue", "run_thread", "lock"]}


def _config_to_dict(config: ProjectConfig) -> Dict[str, Any]:
    model_dump = getattr(config, "model_dump", None)
    if callable(model_dump):
        return model_dump()
    return config.dict()


def _enforce_quality_config(config: ProjectConfig) -> ProjectConfig:
    lane = (config.verification_lane or DEFAULT_VERIFICATION_LANE or "full").strip().lower()
    if lane not in {"fast", "full"}:
        lane = DEFAULT_VERIFICATION_LANE or "full"
    config.verification_lane = lane
    if config.code_review_min_score is None or config.code_review_min_score < MIN_CODE_REVIEW_SCORE:
        config.code_review_min_score = MIN_CODE_REVIEW_SCORE
    if config.max_no_progress is None or config.max_no_progress < 1:
        config.max_no_progress = 1
    config.allow_low_quality_delivery = False
    return config


def _get_project_config(p_info: Dict[str, Any]) -> ProjectConfig:
    raw = p_info.get("config")
    if isinstance(raw, ProjectConfig):
        return _enforce_quality_config(raw)
    if isinstance(raw, dict):
        return _enforce_quality_config(ProjectConfig(**raw))
    return _enforce_quality_config(ProjectConfig())


def _get_git_remote_url(workdir: str) -> str:
    result = GitOperations.get_remote_url(workdir)
    if not result.get("success"):
        return ""
    return result.get("url", "").strip()


def _sync_git_repo(repo_url: str, workdir: str) -> None:
    os.makedirs(workdir, exist_ok=True)
    git_dir = os.path.join(workdir, ".git")
    if os.path.isdir(git_dir):
        current_url = _get_git_remote_url(workdir)
        if current_url and current_url != repo_url:
            raise HTTPException(
                status_code=409,
                detail=f"Git remote mismatch: {current_url} != {repo_url}",
            )
        result = GitOperations.pull_ff_only(workdir)
        if not result.get("success"):
            error_msg = (result.get("error") or "Unknown error")[:200]
            raise HTTPException(status_code=409, detail=f"Git pull failed: {error_msg}")
        return

    if os.listdir(workdir):
        raise HTTPException(status_code=409, detail="Workdir not empty; cannot clone git repo")
    _clone_git_repo(repo_url, workdir)


def _sync_project_sources(req: ProjectSyncRequest, workdir: str) -> None:
    if req.source_git and req.source_path:
        raise HTTPException(status_code=400, detail="Provide only one source: source_git or source_path")
    source_dir = os.path.join(workdir, SOURCE_DIR_NAME)
    if req.source_git:
        git_dir = os.path.join(source_dir, ".git")
        if os.path.exists(source_dir) and not os.path.isdir(git_dir):
            shutil.rmtree(source_dir)
        _sync_git_repo(req.source_git, source_dir)
        return
    if req.source_path:
        _copy_source_folder(req.source_path, source_dir, replace=True)
        return
    raise HTTPException(status_code=400, detail="source_git or source_path is required")


def _prune_backup_dirs(backup_root: Path, keep: int) -> None:
    if keep <= 0:
        return
    try:
        dirs = [p for p in backup_root.iterdir() if p.is_dir()]
        dirs.sort(key=lambda p: p.name, reverse=True)
        for old in dirs[keep:]:
            shutil.rmtree(old, ignore_errors=True)
    except OSError:
        pass


def _handle_remove_readonly(func, path, exc_info):
    try:
        os.chmod(path, 0o700)
        func(path)
    except OSError:
        pass


def _safe_rmtree(target: Path, retries: int = 2, delay_sec: float = 0.1) -> None:
    for attempt in range(retries + 1):
        try:
            shutil.rmtree(target, onerror=_handle_remove_readonly)
            return
        except (OSError, shutil.Error):
            if attempt >= retries:
                raise
            time.sleep(delay_sec)


def _apply_synced_source(project_id: str) -> bool:
    workdir = get_project_workdir(project_id)
    source_dir = workdir / SOURCE_DIR_NAME
    if not source_dir.exists():
        return False
    try:
        next(source_dir.iterdir())
    except StopIteration:
        return False

    backup_root = workdir / BACKUP_DIR_NAME
    backup_root.mkdir(parents=True, exist_ok=True)
    timestamp = datetime.now().strftime("%Y%m%d_%H%M%S")
    backup_dir = backup_root / timestamp
    backup_dir.mkdir(parents=True, exist_ok=True)

    keep_names = {SOURCE_DIR_NAME, BACKUP_DIR_NAME, "state.json"}
    try:
        for item in workdir.iterdir():
            if item.name in keep_names:
                continue
            shutil.move(str(item), backup_dir / item.name)
        _copy_source_folder(str(source_dir), str(workdir), replace=False)
    except Exception as e:
        # Rollback: remove partial output, restore from backup
        try:
            for item in workdir.iterdir():
                if item.name in keep_names:
                    continue
                if item.is_dir():
                    _safe_rmtree(item)
                else:
                    item.unlink(missing_ok=True)
            for item in backup_dir.iterdir():
                shutil.move(str(item), workdir / item.name)
        except Exception as rollback_error:
            raise HTTPException(
                status_code=500,
                detail=f"Failed to apply synced source: {e}; rollback failed: {rollback_error}",
            )
        raise HTTPException(status_code=500, detail=f"Failed to apply synced source: {e}")

    _prune_backup_dirs(backup_root, BACKUP_KEEP)
    return True


def _snapshot_current_output(project_id: str) -> bool:
    workdir = get_project_workdir(project_id)
    source_dir = workdir / SOURCE_DIR_NAME
    with projects_lock:
        p_info = projects.get(project_id)
    if p_info:
        with locked_project(p_info):
            if source_dir.exists():
                _safe_rmtree(source_dir)
    else:
        if source_dir.exists():
            _safe_rmtree(source_dir)

    def ignore_patterns(_directory: str, names: List[str]):
        ignored = []
        for name in names:
            if name in IGNORED_DIRS or name in IGNORED_FILES or name == "state.json":
                ignored.append(name)
        return ignored

    try:
        if hasattr(shutil, 'copytree'):
            shutil.copytree(workdir, source_dir, ignore=ignore_patterns, dirs_exist_ok=True)
        else:
             shutil.copytree(workdir, source_dir, ignore=ignore_patterns)
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Failed to snapshot current output: {e}")
    return True
