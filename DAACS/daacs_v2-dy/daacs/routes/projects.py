import asyncio
import threading
import json
import os
import shutil
import zipfile
from datetime import datetime
from io import BytesIO
from pathlib import Path
from typing import Any, Dict, Optional, List, Tuple

from fastapi import APIRouter, HTTPException, Query
from fastapi.responses import StreamingResponse

from ..api.models import (
    AssumptionDeltaRequest,
    FileUpdateRequest,
    PlanConfirmRequest,
    ClarifyRequest,
    ProjectConfig,
    ProjectEnhanceRequest,
    ProjectRequest,
    ProjectSyncRequest,
    UserInputRequest,
)
from ..server_context import ServerContext
from ..config import PROCESS_SHUTDOWN_TIMEOUT
from ..server_projects import _apply_global_execution_defaults


def init_project_routes(ctx: ServerContext) -> APIRouter:
    router = APIRouter()

    def validate_project_id(project_id: str) -> str:
        """Validate project_id to prevent path traversal attacks."""
        # Allow unicode word characters (including Korean), digits, underscores, hyphens
        import re
        if not re.match(r'^[\w-]+$', project_id, re.UNICODE):
            raise HTTPException(status_code=400, detail="Invalid project ID format")
        if '..' in project_id or '/' in project_id or '\\' in project_id:
            raise HTTPException(status_code=400, detail="Invalid project ID")
        return project_id

    def _parse_json_payload(payload: str) -> Optional[Dict[str, Any]]:
        try:
            data = json.loads(payload)
        except (TypeError, ValueError):
            return None
        return data if isinstance(data, dict) else None

    def _extract_event_payload(logs: List[Dict[str, Any]], marker: str) -> Optional[Dict[str, Any]]:
        for entry in reversed(logs):
            message = entry.get("message", "")
            idx = message.find(marker)
            if idx == -1:
                continue
            payload = message[idx + len(marker):].strip()
            if not payload:
                continue
            data = _parse_json_payload(payload)
            if data:
                return data
        return None

    def _get_live_context(
        p_info: Dict[str, Any],
        logs: List[Dict[str, Any]],
    ) -> Tuple[Optional[Dict[str, Any]], Optional[Dict[str, Any]]]:
        tech_context = None
        assumptions = None
        orch = p_info.get("orchestrator")
        ctx_manager = getattr(orch, "ctx_manager", None) if orch else None
        if ctx_manager:
            try:
                tech_context = ctx_manager.get_context_dict()
            except Exception:
                tech_context = None
            try:
                assumptions = ctx_manager.get_assumptions_dict()
            except Exception:
                assumptions = None
        if not tech_context:
            tech_context = _extract_event_payload(logs, "[TECH_CONTEXT]")
        if not assumptions:
            applied = _extract_event_payload(logs, "[ASSUMPTION_APPLIED]")
            if applied and isinstance(applied.get("assumptions"), dict):
                assumptions = applied.get("assumptions")
        return tech_context, assumptions

    def _build_requirements_plan(
        goal: str,
        rfp_data: Optional[Dict[str, Any]],
        api_spec: Optional[Dict[str, Any]],
        plan_text: str,
        tech_context: Optional[Dict[str, Any]],
        assumptions: Optional[Dict[str, Any]],
    ) -> Dict[str, Any]:
        plan: Dict[str, Any] = {}
        overview_title = goal
        overview_summary = goal

        if rfp_data:
            overview_title = rfp_data.get("goal") or goal
            overview_summary = rfp_data.get("goal") or goal
            specs = rfp_data.get("specs") or []
            if isinstance(specs, list) and specs:
                functional_reqs = []
                tech_reqs = {"frontend": [], "backend": [], "database": None, "external_apis": []}
                for idx, spec in enumerate(specs, start=1):
                    if not isinstance(spec, dict):
                        continue
                    spec_type = (spec.get("type") or "").lower()
                    spec_id = spec.get("id") or f"FR-{idx:03d}"
                    title = spec.get("title") or spec_id
                    description = spec.get("description") or ""
                    if spec_type == "feature" or spec_id.startswith("FR-"):
                        functional_reqs.append({
                            "id": spec_id,
                            "category": spec_type or "feature",
                            "title": title,
                            "description": description,
                            "priority": spec.get("status") or "medium",
                        })
                    elif spec_type == "tech":
                        category = (spec.get("tech_category") or "").lower()
                        if "front" in category:
                            tech_reqs["frontend"].append(title)
                        elif "back" in category or "server" in category:
                            tech_reqs["backend"].append(title)
                        elif "db" in category or "data" in category or "database" in category:
                            tech_reqs["database"] = title
                        elif "api" in category:
                            tech_reqs["external_apis"].append(title)
                        else:
                            tech_reqs["backend"].append(title)
                if functional_reqs:
                    plan["functional_requirements"] = functional_reqs
                if any(tech_reqs.get(key) for key in tech_reqs):
                    plan["technical_requirements"] = tech_reqs

            blueprint = rfp_data.get("blueprint") or {}
            if isinstance(blueprint, dict):
                mermaid_script = blueprint.get("mermaid_script")
                if mermaid_script:
                    plan["architecture"] = {
                        "diagram_mermaid": mermaid_script,
                        "description": None,
                    }

        if api_spec and isinstance(api_spec, dict):
            endpoints = api_spec.get("endpoints") or []
            if isinstance(endpoints, list) and endpoints:
                plan["api_specification"] = [
                    {
                        "id": ep.get("id") or f"API-{idx:03d}",
                        "method": (ep.get("method") or "GET").upper(),
                        "path": ep.get("path") or "",
                        "description": ep.get("description") or "",
                        "request_body": ep.get("request_body"),
                        "response_body": ep.get("response_body"),
                        "related_fr": ep.get("related_fr"),
                    }
                    for idx, ep in enumerate(endpoints, start=1)
                    if isinstance(ep, dict)
                ]

        plan["project_overview"] = {
            "title": overview_title,
            "summary": overview_summary,
        }

        if tech_context:
            plan["tech_context"] = {
                "facts": tech_context.get("facts") or [],
                "sources": tech_context.get("sources") or [],
                "constraints": tech_context.get("constraints") or [],
            }
        if assumptions:
            plan["assumptions"] = assumptions
        if plan_text and "plan" not in plan:
            plan["plan"] = plan_text

        return plan

    def _build_dependency_graph(
        plan: Dict[str, Any],
        rfp_data: Optional[Dict[str, Any]],
        api_spec: Optional[Dict[str, Any]],
        needs_frontend: Optional[bool] = None,
        needs_backend: Optional[bool] = None,
    ) -> Optional[Dict[str, Any]]:
        existing = None
        if isinstance(rfp_data, dict):
            existing = rfp_data.get("dependency_graph")
            if isinstance(existing, dict) and existing.get("nodes") and existing.get("edges"):
                return existing

        tech_reqs = plan.get("technical_requirements") or {}
        endpoints = (api_spec or {}).get("endpoints") if isinstance(api_spec, dict) else None
        has_api = bool(endpoints)

        nodes: List[Dict[str, str]] = []
        edges: List[Dict[str, str]] = []
        seen_ids: set[str] = set()

        def _slugify(value: str) -> str:
            import re
            slug = re.sub(r"[^a-zA-Z0-9]+", "_", value.strip().lower())
            return slug.strip("_") or "node"

        def _add_node(node_id: str, label: str, node_type: str) -> None:
            if node_id in seen_ids:
                return
            seen_ids.add(node_id)
            nodes.append({"id": node_id, "label": label, "type": node_type})

        # Determine if we have frontend/backend based on project flags first, then tech_reqs
        has_frontend = bool(needs_frontend) if needs_frontend is not None else bool(tech_reqs.get("frontend"))
        has_backend = bool(needs_backend) if needs_backend is not None else bool(tech_reqs.get("backend") or has_api)
        
        if has_frontend:
            _add_node("frontend", "Frontend", "frontend")
        if has_backend:
            _add_node("backend", "Backend", "backend")

        database = tech_reqs.get("database")
        if database:
            db_id = f"db_{_slugify(str(database))}"
            _add_node(db_id, str(database), "database")

        external_apis = tech_reqs.get("external_apis") or []
        for api in external_apis:
            api_id = f"api_{_slugify(str(api))}"
            _add_node(api_id, str(api), "external")

        if "frontend" in seen_ids and "backend" in seen_ids:
            edges.append({"source": "frontend", "target": "backend"})
        if database and "backend" in seen_ids:
            edges.append({"source": "backend", "target": f"db_{_slugify(str(database))}"})
        for api in external_apis:
            api_id = f"api_{_slugify(str(api))}"
            if "backend" in seen_ids:
                edges.append({"source": "backend", "target": api_id})
            elif "frontend" in seen_ids:
                edges.append({"source": "frontend", "target": api_id})

        if not nodes:
            return None
        return {"nodes": nodes, "edges": edges}

    @router.post("/api/projects")
    async def create_project(req: ProjectRequest):
        # Phase 5: Human-Readable Project Paths
        prefix = ""
        if req.goal:
            import re
            # 1. Remove common verbs
            clean_goal = re.sub(r'^(create|make|build|generate|design)\s+(a|an|the)?\s*', '', req.goal, flags=re.IGNORECASE)
            # 2. Extract first few words (max 3 words)
            words = re.findall(r'\w+', clean_goal)
            if words:
                # 3. Join with underscores and limit length
                candidate = "_".join(words[:3])
                prefix = candidate[:30]  # Max 30 chars
        
        project_id = ctx.get_next_project_id(prefix=prefix)
        config = _apply_global_execution_defaults(req.config or ProjectConfig())

        ctx.logger.info(
            "Creating project %s with source_path=%s, source_git=%s",
            project_id,
            req.source_path,
            req.source_git,
        )
        workdir = ctx.prepare_project_workspace(req, project_id)

        main_loop = asyncio.get_running_loop()
        p_info = ctx.build_project_record(project_id, req, workdir, config)
        with ctx.projects_lock:
            ctx.projects[project_id] = p_info

        event_cb = ctx.create_event_callback(
            project_id=project_id,
            p_info=p_info,
            emit_to_nova=ctx.emit_to_nova,
            broadcast_log=ctx.manager.broadcast_log,
            save_state=ctx.save_project_state,
            main_loop=main_loop,
        )

        orchestrator = ctx.create_orchestrator(config, workdir, event_cb)
        with ctx.locked_project(p_info):
            p_info["orchestrator"] = orchestrator
            orchestrator.input_provider = ctx.build_input_provider(p_info)
            orchestrator.planner_module.input_provider = orchestrator.input_provider

        ctx.save_project_state(project_id)

        return ctx.project_public_view(p_info)

    @router.post("/api/projects/{project_id}/sync")
    async def sync_project(project_id: str, req: ProjectSyncRequest):
        with ctx.projects_lock:
            p_info = ctx.projects.get(project_id)
        if not p_info:
            raise HTTPException(status_code=404, detail="Project not found")

        workdir = str(ctx.get_project_workdir(project_id))
        ctx.sync_project_sources(req, workdir)

        if req.goal:
            with ctx.locked_project(p_info):
                p_info["goal"] = req.goal

        ctx.save_project_state(project_id)

        enhance_status = None
        if req.run_enhance:
            main_loop = asyncio.get_running_loop()
            enhance_status = ctx.start_orchestrator_thread(
                project_id, main_loop, apply_source=True
            )

        response = {"status": "synced"}
        if enhance_status:
            response["enhance"] = enhance_status
        return response

    @router.post("/api/projects/{project_id}/enhance")
    async def enhance_project(project_id: str, req: ProjectEnhanceRequest):
        p_info = ctx.get_project_or_404(project_id)
        with ctx.locked_project(p_info):
            existing = p_info.get("run_thread")
            if isinstance(existing, threading.Thread) and existing.is_alive():
                return {"status": "already_running"}
        if req.goal:
            with ctx.locked_project(p_info):
                p_info["goal"] = req.goal

        patch_only = bool(req.patch_only)
        use_current_output = True if patch_only else (req.use_current_output if req.use_current_output is not None else True)
        if use_current_output:
            ctx.snapshot_current_output(project_id)

        with ctx.locked_project(p_info):
            p_info["enhance_options"] = {
                "prefer_patch": patch_only,
                "patch_targets": req.patch_targets or []
            }

        main_loop = asyncio.get_running_loop()
        apply_source = not patch_only
        status = ctx.start_orchestrator_thread(project_id, main_loop, apply_source=apply_source)
        if status == "already_running":
            with ctx.locked_project(p_info):
                p_info.pop("enhance_options", None)
            return {"status": status}

        ctx.save_project_state(project_id)
        return {"status": status}

    @router.get("/api/models")
    async def list_models():
        """지원되는 AI 모델 목록을 반환함."""
        # Return the public/UI-safe subset so the frontend dropdowns always match backend capability.
        from daacs.config import PUBLIC_MODEL_IDS

        models = ctx.supported_models or {}
        return {model_id: models[model_id] for model_id in PUBLIC_MODEL_IDS if model_id in models}

    @router.get("/api/projects")
    async def list_projects():
        with ctx.projects_lock:
            snapshot = list(ctx.projects.values())
        return [ctx.project_public_view(p) for p in snapshot]

    @router.get("/api/projects/{project_id}")
    async def get_project(project_id: str):
        p_info = ctx.get_project_or_404(project_id)
        with ctx.locked_project(p_info):
            return ctx.project_public_view(p_info)

    @router.get("/api/projects/{project_id}/messages")
    async def get_project_messages(project_id: str):
        p_info = ctx.get_project_or_404(project_id)
        with ctx.locked_project(p_info):
            return p_info.get("messages", [])

    @router.get("/api/projects/{project_id}/logs")
    async def get_project_logs(project_id: str):
        p_info = ctx.get_project_or_404(project_id)
        with ctx.locked_project(p_info):
            return p_info.get("logs", [])

    @router.get("/api/projects/{project_id}/files")
    async def get_project_files(project_id: str):
        _ = ctx.get_project_or_404(project_id)
        return ctx.list_project_files(project_id)

    @router.get("/api/projects/{project_id}/files/content")
    async def get_file_content(
        project_id: str,
        file: str = Query(...),
        file_type: str = Query("backend", alias="type"),
    ):
        _ = ctx.get_project_or_404(project_id)
        _ = file_type  # reserved for future use (backend/frontend scoping)

        path = ctx.resolve_project_path(project_id, file)
        if not path.exists():
            raise HTTPException(status_code=404, detail="File not found")
        if not path.is_file():
            raise HTTPException(status_code=400, detail="Not a file")

        try:
            content = path.read_text(encoding="utf-8")
        except UnicodeDecodeError:
            content = path.read_text(encoding="utf-8", errors="replace")
        return {"content": content}

    @router.put("/api/projects/{project_id}/files")
    async def update_file_content(
        project_id: str,
        req: FileUpdateRequest,
        file: str = Query(...),
        file_type: str = Query("backend", alias="type"),
    ):
        _ = ctx.get_project_or_404(project_id)
        _ = file_type  # reserved for future use (backend/frontend scoping)

        path = ctx.resolve_project_path(project_id, file)
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(req.content, encoding="utf-8")

        await ctx.manager.broadcast_log(project_id, f"[FILE_UPDATED] {file}", node="DAACS")
        return {"status": "updated"}

    @router.get("/api/projects/{project_id}/download")
    async def download_project(project_id: str):
        _ = ctx.get_project_or_404(project_id)

        base = ctx.get_project_workdir(project_id)
        if not base.exists():
            raise HTTPException(status_code=404, detail="Project directory not found")

        buf = BytesIO()
        with zipfile.ZipFile(buf, "w", compression=zipfile.ZIP_DEFLATED) as zf:
            total = 0
            for root, dirs, files in os.walk(base):
                dirs[:] = [d for d in dirs if d not in ctx.ignored_dirs]
                for name in files:
                    if name in ctx.ignored_files:
                        continue
                    full = Path(root) / name
                    if not full.is_file():
                        continue
                    rel = full.relative_to(base).as_posix()
                    zf.write(full, arcname=rel)
                    total += 1
                    if total >= ctx.max_project_files:
                        break
                if total >= ctx.max_project_files:
                    break

        buf.seek(0)
        headers = {"Content-Disposition": f'attachment; filename="project_{project_id}.zip"'}
        return StreamingResponse(buf, media_type="application/zip", headers=headers)

    @router.delete("/api/projects/{project_id}")
    async def delete_project(project_id: str):
        """프로젝트를 삭제함."""
        validate_project_id(project_id)
        p_info = ctx.get_project_or_404(project_id)
        existing = p_info.get("run_thread")
        if existing and getattr(existing, "is_alive", None) and existing.is_alive():
            ctx.request_orchestrator_stop(p_info, reason="delete")
            existing.join(timeout=PROCESS_SHUTDOWN_TIMEOUT)
            # Force kill if still alive - don't let zombie projects block deletion
            if existing.is_alive():
                ctx.logger.warning("Project %s thread did not stop gracefully, forcing deletion", project_id)

        workdir = str(ctx.get_project_workdir(project_id))
        ctx.stop_project_servers(project_id, workdir)
        try:
            shutil.rmtree(workdir, ignore_errors=True)
        except Exception as e:
            ctx.logger.warning("Failed to delete project workdir %s: %s", workdir, e)

        with ctx.projects_lock:
            if project_id in ctx.projects:
                del ctx.projects[project_id]
        ctx.logger.info("Project %s deleted", project_id)
        return {"status": "deleted", "project_id": project_id}

    @router.post("/api/projects/{project_id}/input")
    async def receive_input(project_id: str, req: UserInputRequest):
        validate_project_id(project_id)
        with ctx.projects_lock:
            p_info = ctx.projects.get(project_id)
        if not p_info:
            raise HTTPException(status_code=404, detail="Project not found")

        should_persist = False
        with ctx.locked_project(p_info):
            # Limit input queue size to prevent memory exhaustion
            MAX_QUEUE_SIZE = 100
            if p_info["input_queue"].qsize() >= MAX_QUEUE_SIZE:
                raise HTTPException(status_code=429, detail="Input queue full, try again later")
            p_info["input_queue"].put(req.text)
            if req.text.strip():
                p_info["messages"].append(
                    {
                        "id": len(p_info["messages"]) + 1,
                "projectId": project_id,  # Keep as string for consistency
                        "role": "user",
                        "content": req.text,
                        "createdAt": datetime.now().isoformat(),
                    }
                )
                should_persist = True
        if should_persist:
            ctx.save_project_state(project_id)

        return {"status": "received"}

    @router.post("/api/projects/{project_id}/apply_assumptions")
    async def apply_assumptions(project_id: str, req: AssumptionDeltaRequest):
        """Phase 1.5: Apply assumption changes and trigger re-plan."""
        p_info = ctx.get_project_or_404(project_id)
        with ctx.locked_project(p_info):
            orch = p_info.get("orchestrator")

        if not orch:
            raise HTTPException(status_code=400, detail="Orchestrator not initialized")

        from ..context import AssumptionDelta

        delta = AssumptionDelta(
            removed=req.removed,
            added=req.added,
            modified=req.modified,
        )

        try:
            orch.apply_assumption_delta(delta)
        except Exception as e:
            ctx.logger.error("Failed to apply assumptions to orchestrator: %s", e)

        ctx.logger.info(
            "Assumption delta applied: removed=%s, added=%s, modified=%s",
            len(req.removed),
            len(req.added),
            len(req.modified),
        )

        main_loop = asyncio.get_running_loop()
        try:
            delta_json = json.dumps({'removed': req.removed, 'added': req.added, 'modified': req.modified})
        except (TypeError, ValueError) as e:
            ctx.logger.error("Failed to serialize assumption delta: %s", e)
            delta_json = json.dumps({'error': 'serialization_failed'})
        
        asyncio.run_coroutine_threadsafe(
            ctx.manager.broadcast_log(
                project_id,
                f"[ASSUMPTION_DELTA] {delta_json}",
                node="DAACS",
            ),
            main_loop,
        )

        return {
            "status": "applied",
            "delta": {"removed": req.removed, "added": req.added, "modified": req.modified},
        }

    @router.get("/api/projects/{project_id}/plan")
    async def get_project_plan(project_id: str):
        """Plan/RFP 상태 조회"""
        p_info = ctx.get_project_or_404(project_id)
        with ctx.locked_project(p_info):
            raw_rfp = p_info.get("rfp_data") or p_info.get("rfp")
            plan_status = p_info.get("plan_status")
            requirements_plan = p_info.get("requirements_plan")
            clar_questions = p_info.get("clarification_questions", [])
            clar_answers = p_info.get("clarification_answers", {})
            needs_clarification = bool(p_info.get("needs_clarification", False))
            api_spec = p_info.get("api_spec") or {}
            plan_text = p_info.get("plan", "")
            goal = p_info.get("goal", "")
            status = p_info.get("status", "created")
            needs_frontend = p_info.get("needs_frontend")
            needs_backend = p_info.get("needs_backend")
            if needs_frontend is None and needs_backend is None:
                needs_frontend = True
                needs_backend = True
            logs = list(p_info.get("logs", []))

        rfp_data = None
        if isinstance(raw_rfp, dict):
            rfp_data = raw_rfp
        elif isinstance(raw_rfp, str):
            rfp_data = _parse_json_payload(raw_rfp)

        tech_context, assumptions = _get_live_context(p_info, logs)

        if not requirements_plan:
            requirements_plan = _build_requirements_plan(
                goal=goal,
                rfp_data=rfp_data,
                api_spec=api_spec,
                plan_text=plan_text,
                tech_context=tech_context,
                assumptions=assumptions,
            )
        # Always try to build dependency_graph if not present or invalid (no nodes)
        existing_graph = requirements_plan.get("dependency_graph") if requirements_plan else None
        graph_is_valid = (
            isinstance(existing_graph, dict) 
            and existing_graph.get("nodes") 
            and len(existing_graph.get("nodes", [])) > 0
        )
        if requirements_plan and not graph_is_valid:
            dependency_graph = _build_dependency_graph(
                requirements_plan,
                rfp_data,
                api_spec,
                needs_frontend=needs_frontend,
                needs_backend=needs_backend,
            )
            if dependency_graph:
                requirements_plan["dependency_graph"] = dependency_graph

        if not plan_status:
            if status in {"completed", "completed_with_warnings", "failed", "stopped"}:
                plan_status = "completed"
            elif rfp_data or requirements_plan:
                plan_status = "pending_confirmation"
            else:
                plan_status = "draft"

        return {
            "requirements_plan": requirements_plan or {},
            "plan_status": plan_status,
            "needs_clarification": needs_clarification,
            "clarification_questions": clar_questions,
            "clarification_answers": clar_answers,
        }

    @router.post("/api/projects/{project_id}/confirm_plan")
    async def confirm_plan(project_id: str, req: PlanConfirmRequest):
        """Plan 승인/거절 상태 업데이트"""
        p_info = ctx.get_project_or_404(project_id)
        with ctx.locked_project(p_info):
            p_info["plan_status"] = "confirmed" if req.confirmed else "draft"
            if req.feedback:
                p_info["plan_feedback"] = req.feedback
            if req.assumptions:
                p_info["assumptions"] = req.assumptions
        ctx.save_project_state(project_id)
        return {"status": "success", "plan_status": p_info.get("plan_status")}

    @router.post("/api/projects/{project_id}/clarify")
    async def submit_clarification(project_id: str, req: ClarifyRequest):
        """Clarification 답변 제출"""
        p_info = ctx.get_project_or_404(project_id)
        with ctx.locked_project(p_info):
            p_info["clarification_answers"] = req.answers
            p_info["needs_clarification"] = False
        ctx.save_project_state(project_id)
        return {"status": "clarified", "message": "Answers received"}

    return router
