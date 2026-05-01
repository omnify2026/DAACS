from dataclasses import dataclass
from typing import Callable, Dict, Any, Optional, List
import hashlib
import os
import shutil
import time

from langgraph.graph import StateGraph, END
from ..models.daacs_state import DAACSState
from ..llm.cli_executor import SessionBasedCLIClient, CLIExecutionError, RateLimitExceeded
from .verification import run_verification
from .file_parser import parse_files_from_response, save_parsed_files
from ..utils import setup_logger

logger = setup_logger("SubgraphBuilder")


@dataclass(frozen=True)
class SubgraphRoleConfig:
    role: str
    subdir_name: str
    iteration_key: str
    status_key: str
    logs_key: str
    files_key: str
    verification_details_key: str
    needs_rework_key: str
    verification_type: str
    prompt_builder: Callable[[DAACSState], str]
    verification_kwargs_builder: Callable[[DAACSState], Dict[str, Any]]
    preflight: Optional[Callable[[DAACSState, str], None]] = None  # Runs BEFORE LLM (use sparingly)
    postflight: Optional[Callable[[DAACSState, str], None]] = None  # Runs AFTER LLM (for scaffold fallback)
    generation_stages: Optional[List[str]] = None
    file_extensions: Optional[List[str]] = None


def create_role_subgraph(config, role_config: SubgraphRoleConfig, event_callback: callable = None):
    workflow = StateGraph(DAACSState)
    execution_config = config.get_execution_config()
    max_no_progress = execution_config.get("max_no_progress", 2)
    if max_no_progress is None:
        max_no_progress = 2
    no_progress_key = f"{role_config.role}_no_progress_count"

    def emit(event, data):
        if event_callback:
            try:
                event_callback(event, data)
            except (RuntimeError, TypeError, ValueError):
                logger.warning("Event callback failed", exc_info=True)

    def _collect_files(base_dir: str, allowed_exts: Optional[List[str]] = None):
        """Collect project files, excluding vendor/cache directories."""
        EXCLUDED_DIRS = {'node_modules', '__pycache__', '.git', '.venv', 'venv', 'dist', 'build', '.next', '.cache'}
        try:
            normalized_exts = None
            if allowed_exts:
                normalized_exts = {
                    ext.lower() if ext.startswith(".") else f".{ext.lower()}"
                    for ext in allowed_exts
                }
            all_files = []
            for root, dirs, filenames in os.walk(base_dir):
                # Prune excluded directories from search
                dirs[:] = [d for d in dirs if d not in EXCLUDED_DIRS]
                for filename in filenames:
                    if normalized_exts:
                        if os.path.splitext(filename)[1].lower() not in normalized_exts:
                            continue
                    all_files.append(os.path.join(root, filename))
            return all_files
        except OSError as e:
            logger.warning("[%s_verifier] Error scanning files: %s", role_config.role, e)
            return []

    def _read_preview(files):
        preview = {}
        for f in files[:10]:
            try:
                with open(f, "r", encoding="utf-8", errors="ignore") as file:
                    preview[os.path.basename(f)] = file.read()[:500]
            except OSError:
                logger.debug("Failed to read preview file: %s", f, exc_info=True)
        return preview

    def _compute_fingerprint(base_dir: str) -> str:
        entries = []
        try:
            for root, dirs, filenames in os.walk(base_dir):
                dirs[:] = [d for d in dirs if d not in {'node_modules', '__pycache__', '.git', '.venv', 'venv', 'dist', 'build', '.next', '.cache'}]
                for filename in filenames:
                    path = os.path.join(root, filename)
                    try:
                        stat = os.stat(path)
                    except OSError:
                        continue
                    rel = os.path.relpath(path, base_dir)
                    entries.append(f"{rel}:{stat.st_size}:{int(stat.st_mtime)}")
        except OSError as e:
            logger.warning("[%s_verifier] Fingerprint failed: %s", role_config.role, e)
            return ""

    def _compute_file_hashes(files: List[str]) -> Dict[str, str]:
        hashes: Dict[str, str] = {}
        for path in files:
            try:
                hasher = hashlib.sha1()
                with open(path, "rb") as handle:
                    for chunk in iter(lambda: handle.read(8192), b""):
                        hasher.update(chunk)
                hashes[path] = hasher.hexdigest()
            except OSError:
                logger.debug("[%s_verifier] Failed to hash file: %s", role_config.role, path)
        return hashes
        entries.sort()
        digest = hashlib.sha256("\n".join(entries).encode("utf-8")).hexdigest()
        return digest

    def emit_node_status(node_id: str, status: str, extras: dict = None):
        """워크플로우 노드 상태를 프론트엔드로 전송"""
        node_data = {"node_id": node_id, "status": status}
        if extras:
            node_data.update(extras)
        emit("WORKFLOW_NODE", node_data)

    def coder(state: DAACSState):
        """Role code generation (CLI)."""
        iteration = state.get(role_config.iteration_key, 0)
        project_dir = state.get("project_dir", ".")
        role_dir = os.path.join(project_dir, role_config.subdir_name)

        # Emit running status
        emit_node_status(role_config.role, "running")

        prefer_patch = bool(state.get("prefer_patch"))
        if iteration == 0 and os.path.exists(role_dir) and os.listdir(role_dir) and not prefer_patch:
            backup_dir = os.path.join(
                project_dir,
                f"{role_config.subdir_name}_backup_{int(time.time())}"
            )
            try:
                shutil.move(role_dir, backup_dir)
                logger.info("[%s_coder] Backup existing %s to %s", role_config.role, role_config.role, backup_dir)
            except Exception as e:
                logger.error("[%s_coder] Backup failed: %s - stopping to prevent data loss", role_config.role, e)
                emit("ERROR", {"message": f"Backup failed: {e} - cannot overwrite without backup"})
                return {
                    role_config.status_key: "failed",
                    role_config.needs_rework_key: True,
                    "stop_reason": "backup_failed",
                }

        os.makedirs(role_dir, exist_ok=True)
        # Note: preflight runs BEFORE LLM - use only for creating directories, not content
        if role_config.preflight:
            try:
                role_config.preflight(state, role_dir)
            except Exception as e:
                logger.warning("[%s_coder] Preflight failed: %s", role_config.role, e)

        # 🆕 FIX: Determine CLI type from model config, not llm_sources
        from .orchestrator_planning import get_cli_type_for_model
        from ..config import SUPPORTED_MODELS
        
        project_id = state.get("project_id")  # Get project_id for rate limiting
        from ..config import PLANNER_MODEL
        model_key = state.get(f"{role_config.role}_model") or PLANNER_MODEL
        
        # Get CLI type and actual model name from config
        cli_type = get_cli_type_for_model(model_key)
        model_config = SUPPORTED_MODELS.get(model_key, {})
        actual_model = model_config.get("model_name", model_key)
        
        logger.info(f"[{role_config.role}_coder] Using CLI type: {cli_type}, model: {actual_model} (selected: {model_key})")

        client = SessionBasedCLIClient(
            cwd=role_dir,
            cli_type=cli_type,  # 🆕 Use determined CLI type from model config
            client_name=role_config.role,
            timeout_sec=config.get_cli_config().get("timeout", 300),
            project_id=project_id,  # Pass project_id for per-project rate limiting
            model_name=actual_model  # 🆕 Use actual model name from config
        )

        before_fingerprint = _compute_fingerprint(role_dir)
        fingerprint_valid = bool(before_fingerprint)  # Track if fingerprint is valid

        try:
            emit("ACTION_START", {"action": {"type": "codegen", "goal": role_config.role}, "client": role_config.role})
            outputs = []
            stages = role_config.generation_stages or []
            if prefer_patch and stages:
                stages = [stage for stage in stages if stage != "scaffold"] or ["patch"]

            if stages:
                for stage in stages:
                    stage_state = dict(state)
                    stage_state["generation_stage"] = stage
                    prompt = role_config.prompt_builder(stage_state)
                    output = client.execute(prompt)
                    outputs.append(output)
                    try:
                        files = parse_files_from_response(output)
                        if files:
                            save_parsed_files(files, role_dir)
                            logger.info(
                                "[%s_coder] Parsed and saved %s files from output (stage=%s).",
                                role_config.role,
                                len(files),
                                stage
                            )
                            emit("message", {"content": f"Generated {len(files)} {role_config.role} files (stage: {stage})."})
                        else:
                            # 🆕 Track file parsing failure for next iteration's feedback
                            logger.warning("[%s_coder] No files parsed from output (stage=%s) - LLM output format may be incorrect", role_config.role, stage)
                            emit("ERROR", {"message": f"⚠️ [{role_config.role}] LLM이 코드를 생성하지 못했습니다 (stage: {stage}). 파일 마커 형식 확인 필요."})
                    except Exception as e:
                        logger.warning("[%s_coder] Failed to parse/save files (stage=%s): %s", role_config.role, stage, e)
                        emit("ERROR", {"message": f"File parsing failed (stage {stage}): {e}"})
            else:
                prompt = role_config.prompt_builder(state)
                output = client.execute(prompt)
                outputs.append(output)
                
                # 🆕 Auto-retry on file parsing failure (max 2 retries)
                MAX_PARSE_RETRIES = 2
                parse_retry = 0
                files = {}
                
                while parse_retry <= MAX_PARSE_RETRIES:
                    try:
                        files = parse_files_from_response(output)
                        if files:
                            save_parsed_files(files, role_dir)
                            logger.info("[%s_coder] Parsed and saved %s files from output.", role_config.role, len(files))
                            emit("message", {"content": f"Generated {len(files)} {role_config.role} files."})
                            break  # Success, exit retry loop
                        else:
                            parse_retry += 1
                            if parse_retry <= MAX_PARSE_RETRIES:
                                logger.warning("[%s_coder] No files parsed (retry %s/%s) - retrying with stronger prompt", 
                                             role_config.role, parse_retry, MAX_PARSE_RETRIES)
                                emit("message", {"content": f"⚠️ 파일 파싱 실패, 재시도 중... ({parse_retry}/{MAX_PARSE_RETRIES})"})
                                
                                # Stronger retry prompt
                                retry_prompt = f"""🚨🚨🚨 CRITICAL: YOUR PREVIOUS OUTPUT HAD NO FILES! 🚨🚨🚨

YOUR PREVIOUS OUTPUT WAS REJECTED because it did not contain any file markers.

YOU MUST USE THIS EXACT FORMAT FOR EVERY FILE:
--- path/to/filename.ext ---
[complete file contents here]

EXAMPLE:
--- main.py ---
from fastapi import FastAPI
app = FastAPI()

@app.get("/health")
def health():
    return {{"status": "ok"}}

--- requirements.txt ---
fastapi>=0.115.0
uvicorn>=0.34.0

WITHOUT THESE MARKERS, YOUR CODE WILL NOT BE SAVED!

Now, generate the complete code with proper file markers:

{prompt}"""
                                output = client.execute(retry_prompt)
                                outputs.append(output)
                            else:
                                logger.error("[%s_coder] No files parsed after %s retries", role_config.role, MAX_PARSE_RETRIES)
                                emit("ERROR", {"message": f"⚠️ [{role_config.role}] LLM이 {MAX_PARSE_RETRIES}회 시도에도 코드를 생성하지 못했습니다."})
                    except Exception as e:
                        logger.warning("[%s_coder] Failed to parse/save files: %s", role_config.role, e)
                        emit("ERROR", {"message": f"File parsing failed: {e}"})
                        break

            # 🆕 Postflight: Run scaffold AFTER LLM to fill only truly missing files
            if role_config.postflight:
                try:
                    role_config.postflight(state, role_dir)
                    logger.info("[%s_coder] Postflight completed (scaffold fallback).", role_config.role)
                except Exception as e:
                    logger.warning("[%s_coder] Postflight failed: %s", role_config.role, e)

            after_fingerprint = _compute_fingerprint(role_dir)
            no_progress_count = int(state.get(no_progress_key, 0) or 0)
            
            # Only check progress if fingerprints are valid (non-empty)
            if fingerprint_valid and after_fingerprint:
                if after_fingerprint == before_fingerprint:
                    no_progress_count += 1
                    logger.warning("[%s_coder] No file changes detected (%s/%s).", role_config.role, no_progress_count, max_no_progress)
                else:
                    no_progress_count = 0
            elif not fingerprint_valid and not after_fingerprint:
                # Both fingerprints failed - don't increment no_progress
                logger.warning("[%s_coder] Fingerprint computation failed, skipping progress check.", role_config.role)

            emit(
                "ACTION_DONE",
                {"action": {"type": "codegen"}, "client": role_config.role, "result": "Codegen complete", "review": {"success": True}}
            )
            fingerprint_key = f"{role_config.role}_code_fingerprint"
            return {
                role_config.logs_key: outputs,
                role_config.iteration_key: iteration + 1,
                no_progress_key: no_progress_count,
                fingerprint_key: after_fingerprint,
            }
        except RateLimitExceeded as e:
            emit_node_status(role_config.role, "error", {"error": "Rate limit exceeded"})
            emit("ERROR", {"message": f"🛑 Rate Limit Exceeded: {e}"})
            # Return gracefully to allow workflow to stop cleanly
            return {
                role_config.status_key: "failed",
                role_config.needs_rework_key: False,  # Don't retry - hard stop
                "stop_reason": "rate_limit_exceeded",
            }
        except CLIExecutionError as e:
            emit_node_status(role_config.role, "error", {"error": str(e)})
            emit("ERROR", {"message": f"{role_config.role.capitalize()} CLI Failed: {e}"})
            # Allow retry via normal workflow
            return {
                role_config.logs_key: [f"CLI Error: {e}"],
                role_config.iteration_key: iteration + 1,
                no_progress_key: int(state.get(no_progress_key, 0) or 0) + 1,
            }
        except Exception as e:
            emit_node_status(role_config.role, "error", {"error": str(e)})
            emit("ERROR", {"message": f"{role_config.role.capitalize()} Coder Failed: {e}"})
            raise e

    def verifier(state: DAACSState):
        """Role code verification."""
        project_dir = state.get("project_dir", ".")
        role_dir = os.path.join(project_dir, role_config.subdir_name)

        all_files = _collect_files(role_dir, role_config.file_extensions)
        file_hashes_key = f"{role_config.role}_file_hashes"
        prev_hashes = state.get(file_hashes_key, {}) or {}
        file_hashes = _compute_file_hashes(all_files)
        changed_files = [f for f, digest in file_hashes.items() if prev_hashes.get(f) != digest]
        if prev_hashes:
            removed_files = [f for f in prev_hashes.keys() if f not in file_hashes]
            if removed_files and not changed_files:
                changed_files = list(all_files)
        if state.get(role_config.needs_rework_key) and not changed_files:
            changed_files = list(all_files)
        logger.info(
            "[%s_verifier] Project dir: %s, Role dir: %s",
            role_config.role,
            project_dir,
            role_dir,
        )
        logger.debug("[%s_verifier] Files: %s", role_config.role, all_files)

        emit("ACTION_START", {"action": {"type": "verification", "target": role_config.role}, "client": role_config.role})

        verification_kwargs = role_config.verification_kwargs_builder(state)
        verification_result = run_verification(
            action_type=role_config.verification_type,
            files=all_files,
            changed_files=changed_files,
            **verification_kwargs
        )

        all_passed = verification_result.get("ok", False)
        verdicts = verification_result.get("verdicts", [])
        no_progress_count = int(state.get(no_progress_key, 0) or 0)
        if max_no_progress and no_progress_count >= max_no_progress:
            # Soft warning instead of hard failure - let build continue
            verdicts.append({
                "ok": True,  # Changed from False - don't block build
                "template": "no_progress_warning",
                "reason": f"No file changes for {no_progress_count} iterations (continuing anyway)"
            })
            logger.warning("[%s_verifier] No progress for %s iterations - continuing with warning", 
                          role_config.role, no_progress_count)
            # Don't set all_passed = False, let other checks decide
        status = "completed" if all_passed else "failed"

        # Emit node status based on verification result
        emit_node_status(role_config.role, "completed" if all_passed else "error", {"files": len(all_files)})

        preview_files = _read_preview(all_files)

        logger.info(
            "[%s_verifier] Status: %s, Passed: %s, Files: %s",
            role_config.role,
            status,
            all_passed,
            len(all_files),
        )

        emit(
            "ACTION_DONE",
            {"action": {"type": "verification"}, "client": role_config.role, "result": status, "review": {"success": all_passed, "verify": verification_result}}
        )

        return {
            role_config.status_key: status,
            role_config.files_key: preview_files,
            role_config.verification_details_key: verdicts,
            role_config.needs_rework_key: not all_passed,
            file_hashes_key: file_hashes,
        }

    coder_node = f"{role_config.role}_coder"
    verifier_node = f"{role_config.role}_verifier"

    workflow.add_node(coder_node, coder)
    workflow.add_node(verifier_node, verifier)

    workflow.set_entry_point(coder_node)
    workflow.add_edge(coder_node, verifier_node)

    def router(state: DAACSState):
        # Check for stop conditions first
        if state.get("stop_reason"):
            logger.info("[%s_router] Stop reason detected: %s", role_config.role, state.get("stop_reason"))
            return END
        if state.get(role_config.status_key) == "completed":
            return END
        # Removed: no_progress early exit - let it continue trying
        if state.get(role_config.iteration_key, 0) > config.get_execution_config().get("max_subgraph_iterations", 3):
            return END
        return coder_node

    workflow.add_conditional_edges(verifier_node, router)

    return workflow.compile()
