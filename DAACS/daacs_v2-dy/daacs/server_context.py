from dataclasses import dataclass
from typing import Any, Dict

from .config import SUPPORTED_MODELS
from .event_handler import create_event_callback
from .server_events import emit_to_nova, manager
from .server_manager import stop_project_servers as sm_stop_servers
from .server_projects import (
    IGNORED_DIRS,
    IGNORED_FILES,
    MAX_PROJECT_FILES,
    _build_input_provider,
    _build_project_record,
    _create_orchestrator,
    _get_next_project_id,
    _list_project_files,
    _prepare_project_workspace,
    _project_public_view,
    _request_orchestrator_stop,
    _reset_project_runtime_state,
    _resolve_project_path,
    _snapshot_current_output,
    _sync_project_sources,
)
from .server_runtime import _start_orchestrator_thread, run_orchestrator_sync, run_servers_sync
from .server_state import (
    get_project_or_404,
    get_project_workdir,
    locked_project,
    logger,
    projects,
    projects_lock,
    save_project_state,
)


@dataclass(frozen=True)
class ServerContext:
    projects: Dict[str, Dict[str, Any]]
    projects_lock: Any
    locked_project: Any
    manager: Any
    logger: Any
    supported_models: Any
    emit_to_nova: Any
    get_next_project_id: Any
    prepare_project_workspace: Any
    build_project_record: Any
    create_orchestrator: Any
    build_input_provider: Any
    create_event_callback: Any
    save_project_state: Any
    get_project_or_404: Any
    get_project_workdir: Any
    project_public_view: Any
    list_project_files: Any
    resolve_project_path: Any
    sync_project_sources: Any
    snapshot_current_output: Any
    start_orchestrator_thread: Any
    request_orchestrator_stop: Any
    stop_project_servers: Any
    ignored_dirs: Any
    ignored_files: Any
    max_project_files: int
    reset_project_runtime_state: Any
    run_servers_sync: Any
    run_orchestrator_sync: Any


def build_server_context() -> ServerContext:
    return ServerContext(
        projects=projects,
        projects_lock=projects_lock,
        locked_project=locked_project,
        manager=manager,
        logger=logger,
        supported_models=SUPPORTED_MODELS,
        emit_to_nova=emit_to_nova,
        get_next_project_id=_get_next_project_id,
        prepare_project_workspace=_prepare_project_workspace,
        build_project_record=_build_project_record,
        create_orchestrator=_create_orchestrator,
        build_input_provider=_build_input_provider,
        create_event_callback=create_event_callback,
        save_project_state=save_project_state,
        get_project_or_404=get_project_or_404,
        get_project_workdir=get_project_workdir,
        project_public_view=_project_public_view,
        list_project_files=_list_project_files,
        resolve_project_path=_resolve_project_path,
        sync_project_sources=_sync_project_sources,
        snapshot_current_output=_snapshot_current_output,
        start_orchestrator_thread=_start_orchestrator_thread,
        request_orchestrator_stop=_request_orchestrator_stop,
        stop_project_servers=sm_stop_servers,
        ignored_dirs=IGNORED_DIRS,
        ignored_files=IGNORED_FILES,
        max_project_files=MAX_PROJECT_FILES,
        reset_project_runtime_state=_reset_project_runtime_state,
        run_servers_sync=run_servers_sync,
        run_orchestrator_sync=run_orchestrator_sync,
    )
