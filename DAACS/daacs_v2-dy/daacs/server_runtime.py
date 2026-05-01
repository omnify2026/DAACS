import asyncio
import os
import threading
from typing import Any, Dict

from fastapi import HTTPException

from .event_handler import create_event_callback
from .server_events import emit_to_nova, manager
from .server_manager import start_project_servers, stop_project_servers
from .server_projects import (
    _apply_synced_source,
    _build_input_provider,
    _create_orchestrator,
    _get_project_config,
    _reset_project_runtime_state,
)
from .release_gate import compute_release_gate
from .server_state import locked_project, projects, projects_lock, save_project_state


def _format_release_gate_guidance(release_gate_summary: Dict[str, Any]) -> str:
    results = release_gate_summary.get("results", {}) if isinstance(release_gate_summary, dict) else {}
    issues = []
    for key, label in [
        ("output_presence", "Output presence"),
        ("runtime_backend", "Backend runtime"),
        ("runtime_frontend", "Frontend runtime"),
        ("e2e_test_run", "E2E tests"),
        ("stability_test", "Stability"),
        ("frontend_race_state_check", "Frontend state/race"),
        ("regression_check", "Regression"),
    ]:
        result = results.get(key)
        if isinstance(result, dict) and not result.get("ok", True):
            reason = str(result.get("reason") or "").strip()
            issues.append(f"{label}: {reason}".strip())

    regressions = results.get("regression_check", {}).get("regressions", []) or []
    if regressions:
        issues.append(f"Regressions: {', '.join(regressions)}")

    return "\n".join(f"- {issue}" for issue in issues) if issues else ""


def _is_release_gate_enabled(config: Any) -> bool:
    value = getattr(config, "enable_release_gate", None)
    if value is not None:
        return bool(value)
    env_value = os.getenv("DAACS_ENABLE_RELEASE_GATE")
    if env_value is not None and env_value.strip():
        return env_value.strip().lower() in ("1", "true", "yes", "on")
    return False


def _ensure_orchestrator(project_id: str, main_loop: asyncio.AbstractEventLoop):
    with projects_lock:
        p_info = projects.get(project_id)
    if not p_info:
        raise HTTPException(status_code=404, detail="Project not found")

    with locked_project(p_info):
        existing = p_info.get("orchestrator")
        if existing:
            return existing

        config = _get_project_config(p_info)
        p_info["config"] = config.model_dump() if hasattr(config, "model_dump") else config.dict()

        event_cb = create_event_callback(
            project_id=project_id,
            p_info=p_info,
            emit_to_nova=emit_to_nova,
            broadcast_log=manager.broadcast_log,
            save_state=save_project_state,
            main_loop=main_loop,
        )

        orchestrator = _create_orchestrator(config, p_info["workdir"], event_cb)
        p_info["orchestrator"] = orchestrator
        orchestrator.input_provider = _build_input_provider(p_info)
        orchestrator.planner_module.input_provider = orchestrator.input_provider
        return orchestrator


def _start_orchestrator_thread(
    project_id: str,
    main_loop: asyncio.AbstractEventLoop,
    apply_source: bool = False,
) -> str:
    with projects_lock:
        p_info = projects.get(project_id)
    if not p_info:
        raise HTTPException(status_code=404, detail="Project not found")

    with locked_project(p_info):
        existing = p_info.get("run_thread")
        if isinstance(existing, threading.Thread) and existing.is_alive():
            return "already_running"
        # Clean up old thread reference if it's dead
        elif existing is not None:
            p_info["run_thread"] = None  # Clear dead thread reference

    if apply_source:
        _apply_synced_source(project_id)

    _ensure_orchestrator(project_id, main_loop)
    with locked_project(p_info):
        enhance_options = p_info.pop("enhance_options", None) or {}
    orch = p_info.get("orchestrator")
    if orch:
        orch.prefer_patch = bool(enhance_options.get("prefer_patch"))
        orch.patch_targets = enhance_options.get("patch_targets") or []
    _reset_project_runtime_state(p_info, clear_logs=True, clear_messages=False, reset_release_gate_failures=True)
    with locked_project(p_info):
        p_info["status"] = "planning"
        p_info["run_info"] = {"backend_port": None, "frontend_port": None, "frontend_entry": "/"}

        thread = threading.Thread(target=run_orchestrator_sync, args=(project_id,), name=f"orch-{project_id}")
        thread.daemon = True
        p_info["run_thread"] = thread
    thread.start()
    return "started"


def run_servers_sync(project_id: str) -> None:
    """서버 시작 (백그라운드 스레드) - ServerManager 사용"""
    import time

    # Wait for project state to stabilize before starting servers
    SERVER_STARTUP_DELAY_SEC = 1
    time.sleep(SERVER_STARTUP_DELAY_SEC)
    with projects_lock:
        p_info = projects.get(project_id)
    if not p_info:
        return
    with locked_project(p_info):
        workdir = p_info.get("workdir", f"workspace/{project_id}")
        current_status = p_info.get("status")

    try:
        run_info = start_project_servers(project_id, workdir)
    except Exception as e:
        with locked_project(p_info):
            if current_status not in ("completed", "completed_with_warnings", "failed"):
                p_info["status"] = "failed"
        emit_to_nova(project_id, "ERROR", {"message": f"Server start failed: {e}"})
        save_project_state(project_id)
        return

    with locked_project(p_info):
        p_info["run_info"] = run_info

    if run_info.get("backend_port") or run_info.get("frontend_port"):
        with locked_project(p_info):
            if current_status not in ("completed", "completed_with_warnings", "failed"):
                p_info["status"] = "running"
    else:
        with locked_project(p_info):
            if current_status not in ("completed", "completed_with_warnings", "failed"):
                p_info["status"] = "failed"


def run_orchestrator_sync(project_id: str) -> None:
    with projects_lock:
        p_info = projects.get(project_id)
    if not p_info:
        return
    with locked_project(p_info):
        orch = p_info.get("orchestrator")
        goal = p_info.get("goal")
        guidance = p_info.get("release_gate_guidance")
        current_status = p_info.get("status", "")
        final_status = p_info.get("final_status", "")
        completed_statuses = {"completed", "completed_with_warnings", "delivered", "saved"}
        skip_rfi = bool(
            guidance
            or p_info.get("release_gate_failures", 0)
            or p_info.get("chat_history", [])  # 🆕 RFI 대화 기록이 있으면 건너뛰기
            or p_info.get("rfp_data")  # 🆕 RFP가 이미 생성되었으면 건너뛰기
            or current_status in completed_statuses
            or final_status in completed_statuses
        )
    if guidance:
        goal = f"{goal}\n\nRelease Gate Fixes:\n{guidance}"
    if orch is None:
        emit_to_nova(project_id, "ERROR", {"message": "Orchestrator not initialized"})
        return
    orch.skip_rfi = skip_rfi
    try:
        result = orch.run(goal)
        final_status = None
        needs_rework = False
        stop_reason = None
        if isinstance(result, dict):
            final_status = result.get("final_status")
            needs_rework = bool(result.get("needs_rework"))
            stop_reason = result.get("stop_reason")
            
            # 🆕 Sync verification & file data from LangGraph result to p_info
            with locked_project(p_info):
                for key in [
                    "backend_files", "frontend_files",
                    "backend_verification_details", "frontend_verification_details",
                    "backend_status", "frontend_status",
                    "needs_backend", "needs_frontend",
                    "code_review_score", "code_review_passed",
                    # Replanning state
                    "consecutive_failures", "failure_repeat_count",
                    "last_failure_signature", "replan_guidance",
                    "failure_summary", "needs_rework", "iteration",
                ]:
                    if result.get(key) is not None:
                        p_info[key] = result[key]


        if orch.stop_requested or final_status == "stopped":
            stop_reason = stop_reason or orch.stop_reason or "stopped"
            with locked_project(p_info):
                if p_info.get("status") not in ("completed", "completed_with_warnings", "failed"):
                    p_info["status"] = "stopped"
                p_info["final_status"] = final_status or "stopped"
                p_info["stop_reason"] = stop_reason
            emit_to_nova(project_id, "BUILD_COMPLETE", {"message": "빌드가 중단되었습니다.", "status": "stopped"})
            save_project_state(project_id)
            return

        success_statuses = {"completed", "saved", "delivered", "completed_with_warnings"}
        if final_status in success_statuses:
            needs_backend = True
            needs_frontend = True
            max_release_gate_retries = 3
            release_gate_summary = None
            release_gate_enabled = True
            try:
                with locked_project(p_info):
                    goal = p_info.get("goal", "")
                    api_spec = p_info.get("api_spec", {}) or {}
                    needs_backend = bool(p_info.get("needs_backend", True))
                    needs_frontend = bool(p_info.get("needs_frontend", True))
                    workdir = p_info.get("workdir", f"workspace/{project_id}")
                    config = _get_project_config(p_info)
                    max_release_gate_retries = getattr(config, "plateau_max_retries", 3) or 3
                    release_gate_enabled = _is_release_gate_enabled(config)
                if release_gate_enabled:
                    release_gate_summary = compute_release_gate(
                        goal,
                        api_spec,
                        needs_backend,
                        needs_frontend,
                        workdir,
                    )
                    with locked_project(p_info):
                        p_info["release_gate"] = release_gate_summary
                    save_project_state(project_id)
                else:
                    release_gate_summary = {
                        "status": "skipped",
                        "auto_ok": True,
                        "fullstack_required": bool(needs_backend and needs_frontend),
                        "manual_gates": [],
                        "results": {"reason": "Release gate disabled"},
                    }
                    with locked_project(p_info):
                        p_info["release_gate"] = release_gate_summary
                    save_project_state(project_id)
            except Exception as e:
                release_gate_summary = {
                    "status": "fail",
                    "auto_ok": False,
                    "fullstack_required": bool(needs_backend and needs_frontend),
                    "manual_gates": [],
                    "results": {"error": str(e)},
                }
                with locked_project(p_info):
                    p_info["release_gate"] = release_gate_summary
                save_project_state(project_id)

            if release_gate_enabled and release_gate_summary and release_gate_summary.get("status") == "fail":
                guidance = _format_release_gate_guidance(release_gate_summary)
                with locked_project(p_info):
                    failures = int(p_info.get("release_gate_failures", 0)) + 1
                    p_info["release_gate_failures"] = failures
                    if guidance:
                        p_info["release_gate_guidance"] = guidance
                    workdir = p_info.get("workdir", f"workspace/{project_id}")

                if failures <= max_release_gate_retries:
                    stop_project_servers(project_id, workdir)
                    _reset_project_runtime_state(
                        p_info,
                        clear_logs=False,
                        clear_messages=False,
                        reset_release_gate_failures=False,
                    )
                    with locked_project(p_info):
                        p_info["status"] = "planning"
                        p_info["run_info"] = {"backend_port": None, "frontend_port": None, "frontend_entry": "/"}
                        # Note: This creates a new thread for retry, limited by max_release_gate_retries
                        from .server_state import logger as state_logger
                        state_logger.info(f"Creating retry thread for project {project_id} (attempt {failures}/{max_release_gate_retries})")
                        thread = threading.Thread(target=run_orchestrator_sync, args=(project_id,), name=f"orch-retry-{project_id}-{failures}")
                        thread.daemon = True
                        p_info["run_thread"] = thread
                    thread.start()
                    emit_to_nova(
                        project_id,
                        "RELEASE_GATE_RETRY",
                        {
                            "message": f"Release gate failed. Retrying ({failures}/{max_release_gate_retries})",
                            "attempt": failures,
                        },
                    )
                    save_project_state(project_id)
                    return

                with locked_project(p_info):
                    p_info["status"] = "failed"
                    p_info["final_status"] = "failed"
                    p_info["stop_reason"] = "release_gate_failed"
                emit_to_nova(project_id, "BUILD_COMPLETE", {"message": "Release gate failed.", "status": "failed"})
                save_project_state(project_id)
                return

            with locked_project(p_info):
                p_info["release_gate_failures"] = 0
                p_info["release_gate_guidance"] = None

            with locked_project(p_info):
                status_value = "completed_with_warnings" if final_status == "completed_with_warnings" else "completed"
                p_info["status"] = status_value
                p_info["final_status"] = final_status
                p_info["stop_reason"] = stop_reason

            message = (
                "빌드가 완료되었지만 일부 품질 기준을 충족하지 못했습니다."
                if final_status == "completed_with_warnings"
                else "빌드가 성공적으로 완료되었습니다."
            )
            emit_to_nova(project_id, "BUILD_COMPLETE", {"message": message, "status": status_value})
            save_project_state(project_id)
            run_servers_sync(project_id)
            return

        with locked_project(p_info):
            p_info["status"] = "failed"
            p_info["final_status"] = final_status or "failed"
            p_info["stop_reason"] = stop_reason
        message = (
            "빌드가 완료되지 않았습니다. 재작업이 필요합니다."
            if needs_rework or final_status == "needs_rework"
            else "빌드가 실패했습니다."
        )
        emit_to_nova(project_id, "BUILD_COMPLETE", {"message": message, "status": "failed"})
        save_project_state(project_id)

    except Exception as e:
        with locked_project(p_info):
            p_info["status"] = "failed"
            p_info["stop_reason"] = str(e)
        emit_to_nova(project_id, "ERROR", {"message": str(e)})
        save_project_state(project_id)
