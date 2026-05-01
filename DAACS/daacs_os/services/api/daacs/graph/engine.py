"""
DAACS OS Workflow Engine
"""
import asyncio
import hashlib
import inspect
import json
import logging
import time
import zlib
from typing import Any, Callable, Dict, List, Optional

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker

from ..db.models import WorkflowCheckpoint
from ..db.session import get_engine
from ..overnight import (
    BudgetExceededError,
    CommandPolicyGuard,
    GateVerdict,
    OvernightVerificationRunner,
    TimeExceededError,
    TimeGuard,
)
from .state import WorkflowState, create_initial_state

logger = logging.getLogger("daacs.graph.engine")

_MERGED_LIST_FIELDS = {
    "logs",
    "failure_summary",
    "consistency_issues",
    "verification_details",
    "verification_failures",
    "pending_handoffs",
    "completed_handoffs",
    "handoff_history",
    "gate_results",
}

_LEGACY_NODE_ALIASES = {
    "judge": "review",
    "verify": "verification",
    "replan": "replanning",
}

_CANONICAL_NODE_FALLBACKS = {
    "review": ["review", "judge"],
    "verification": ["verification", "verify"],
    "replanning": ["replanning", "replan"],
}

_NODE_ROLE_MAP = {
    "plan": "pm",
    "execute_backend": "developer",
    "execute_frontend": "developer",
    "review": "reviewer",
    "verification": "verifier",
    "replanning": "pm",
}

_VERIFICATION_CONFIDENCE_THRESHOLDS = {
    "lite": 55,
    "standard": 70,
    "ui": 75,
    "strict": 85,
}


class WorkflowEngine:
    """Main workflow execution engine."""

    def __init__(
        self,
        project_id: str,
        llm_executor=None,
        agent_manager=None,
        event_broadcaster: Optional[Callable] = None,
        workspace_dir: Optional[str] = None,
    ):
        self.project_id = project_id
        self.executor = llm_executor
        self.manager = agent_manager
        self.event_broadcaster = event_broadcaster
        self.workspace_dir = workspace_dir or f"workspace/{project_id}"
        self._session_factory = async_sessionmaker(
            get_engine(),
            class_=AsyncSession,
            expire_on_commit=False,
        )
        self._active_run_id: Optional[str] = None
        self._active_overnight_config: Dict[str, Any] = {}
        self._nodes = None

    def _load_nodes(self):
        if self._nodes is not None:
            return
        from .nodes.execution import backend_execution_node, frontend_execution_node
        from .nodes.judgment import judgment_node
        from .nodes.planning import planning_node
        from .nodes.replanning import replanning_node
        from .nodes.verification import verification_node

        self._nodes = {
            "plan": planning_node,
            "execute_backend": backend_execution_node,
            "execute_frontend": frontend_execution_node,
            "review": judgment_node,
            "judge": judgment_node,
            "replanning": replanning_node,
            "replan": replanning_node,
            "verification": verification_node,
            "verify": verification_node,
        }

    def _canonical_node_name(self, node_name: str) -> str:
        return _LEGACY_NODE_ALIASES.get(node_name, node_name)

    def _node_lookup_names(self, node_name: str) -> List[str]:
        canonical = self._canonical_node_name(node_name)
        return _CANONICAL_NODE_FALLBACKS.get(canonical, [canonical])

    def _emit(self, event_type: str, data: Dict[str, Any]):
        if self.event_broadcaster:
            from ..agents.protocol import AgentEvent

            event = AgentEvent(
                type=event_type,
                agent_role="system",
                data={**data, "project_id": self.project_id},
            )
            try:
                self.event_broadcaster(event)
            except Exception as exc:
                logger.warning("Event broadcast failed: %s", exc)

    def _apply_updates(self, state: WorkflowState, updates: Dict[str, Any]) -> None:
        for key, value in updates.items():
            if key in _MERGED_LIST_FIELDS and isinstance(value, list):
                existing = list(state.get(key, []) or [])
                state[key] = existing + value
            else:
                state[key] = value

    def _available_roles(self, state: WorkflowState) -> List[str]:
        roles = list(state.get("active_roles", []) or [])
        if roles:
            return roles
        if self.manager is not None and getattr(self.manager, "agents", None):
            return [role.value for role in self.manager.agents.keys()]
        return []

    def _default_orchestration_policy(self, state: WorkflowState) -> Dict[str, Any]:
        active_roles = set(self._available_roles(state))
        execution_handoffs: List[str] = []
        if state.get("needs_backend", True):
            execution_handoffs.append("execute_backend")
        if state.get("needs_frontend", True):
            execution_handoffs.append("execute_frontend")

        quality_handoffs: List[str] = []
        if "reviewer" in active_roles:
            quality_handoffs.append("review")
        if "verifier" in active_roles:
            quality_handoffs.append("verification")

        return {
            "execution_handoffs": execution_handoffs,
            "quality_handoffs": quality_handoffs,
            "replan_handoff": "replanning" if "pm" in active_roles else None,
            "allow_skip_review": "reviewer" not in active_roles,
            "allow_skip_verification": "verifier" not in active_roles,
        }

    def _orchestration_policy(self, state: WorkflowState) -> Dict[str, Any]:
        base = self._default_orchestration_policy(state)
        base.update(dict(state.get("orchestration_policy", {}) or {}))
        return base

    def _execution_handoffs(self, state: WorkflowState) -> List[str]:
        policy = self._orchestration_policy(state)
        valid = {"execute_backend", "execute_frontend"}
        return [item for item in policy.get("execution_handoffs", []) if item in valid]

    def _quality_handoffs(self, state: WorkflowState) -> List[str]:
        policy = self._orchestration_policy(state)
        valid = {"review", "verification", "judge", "verify"}
        handoffs: List[str] = []
        for item in policy.get("quality_handoffs", []):
            if item not in valid:
                continue
            canonical = self._canonical_node_name(item)
            if canonical not in handoffs:
                handoffs.append(canonical)
        return handoffs

    def _replan_handoff(self, state: WorkflowState) -> Optional[str]:
        value = self._orchestration_policy(state).get("replan_handoff")
        return self._canonical_node_name(str(value)) if value else None

    def _verification_threshold(self, state: WorkflowState) -> int:
        profile = str(state.get("qa_profile") or "standard").strip().lower()
        return _VERIFICATION_CONFIDENCE_THRESHOLDS.get(profile, _VERIFICATION_CONFIDENCE_THRESHOLDS["standard"])

    def _verification_rework_reasons(self, state: WorkflowState) -> List[str]:
        reasons = list(state.get("verification_failures", []) or [])
        reasons.extend(
            str(item).strip()
            for item in list(state.get("verification_gaps", []) or [])
            if str(item).strip()
        )

        confidence = int(state.get("verification_confidence", 0) or 0)
        threshold = self._verification_threshold(state)
        if confidence < threshold:
            reasons.append(
                f"Verification confidence {confidence} is below threshold {threshold}"
            )
        return reasons

    def _record_handoff(self, state: WorkflowState, node_name: str) -> None:
        canonical = self._canonical_node_name(node_name)
        role = _NODE_ROLE_MAP.get(canonical, "system")
        self._apply_updates(
            state,
            {
                "completed_handoffs": [canonical],
                "handoff_history": [
                    {
                        "node": canonical,
                        "role": role,
                        "iteration": int(state.get("iteration", 0)),
                    }
                ],
            },
        )
        self._emit("WORKFLOW_HANDOFF", {"node": canonical, "role": role, "iteration": int(state.get("iteration", 0))})

    def _compute_fingerprint(self, state: WorkflowState) -> str:
        all_code = ""
        for files in [state.get("backend_files", {}), state.get("frontend_files", {})]:
            for path in sorted(files.keys()):
                all_code += f"{path}:{files[path]}\n"
        return hashlib.md5(all_code.encode()).hexdigest()[:16]

    async def run(
        self,
        goal: str,
        workflow_name: str = "feature_development",
        params: Optional[Dict[str, Any]] = None,
        config: Optional[Dict[str, Any]] = None,
        resume: bool = False,
    ) -> Dict[str, Any]:
        self._load_nodes()

        params = params or {}
        overnight_mode = bool(params.get("overnight_mode"))
        run_id = str(params.get("run_id") or "")
        self._active_run_id = run_id or None
        self._active_overnight_config = dict(config or {})

        max_iterations = int(params.get("max_iterations", 10))
        state = create_initial_state(
            project_id=self.project_id,
            goal=goal,
            project_dir=self.workspace_dir,
            workflow_name=workflow_name,
            max_iterations=max_iterations,
        )
        if self.manager is not None and getattr(self.manager, "agents", None):
            state["active_roles"] = [role.value for role in self.manager.agents.keys()]
            state["orchestration_policy"] = self._default_orchestration_policy(state)
        state["overnight_mode"] = overnight_mode
        state["run_id"] = run_id
        state["gate_results"] = []
        state["gate_retry_by_gate"] = {}
        state["gate_retry_total"] = 0

        if overnight_mode and resume and run_id:
            restored = await self._load_latest_checkpoint(run_id)
            if restored:
                state.update(restored)

        time_guard = None
        verification_runner = None
        if overnight_mode:
            constraints = self._active_overnight_config.get("constraints", {})
            blocked_commands = constraints.get("blocked_commands", [])
            command_policy = CommandPolicyGuard(blocked_commands)
            verification_runner = OvernightVerificationRunner(
                workspace_dir=self.workspace_dir,
                command_policy_guard=command_policy,
                llm_executor=self.executor,
            )
            deadline_raw = self._active_overnight_config.get("deadline_at")
            if deadline_raw:
                from datetime import datetime

                try:
                    parsed = datetime.fromisoformat(str(deadline_raw).replace("Z", "+00:00"))
                    time_guard = TimeGuard(run_id=run_id, deadline_at=parsed)
                except ValueError:
                    time_guard = None

        self._emit("WORKFLOW_STARTED", {"workflow_name": workflow_name, "goal": goal})
        logger.info("[Engine] Workflow started: goal='%s', max_iter=%s", goal, max_iterations)

        try:
            state = await self._run_node("plan", state)
        except BudgetExceededError:
            state["stop_reason"] = "budget_exceeded"
            state["failure_summary"] = state.get("failure_summary", []) + ["Budget exceeded"]
            return self._finalize(state, "stopped_with_report")
        if overnight_mode and run_id:
            await self._save_checkpoint(run_id, "plan", int(state.get("iteration", 0)), state)

        if state.get("stop_reason"):
            return self._finalize(state, "stopped")

        for iteration in range(max_iterations):
            try:
                state["iteration"] = iteration + 1
                await self._refresh_spent_usd(state)
                if time_guard is not None:
                    try:
                        time_guard.check_or_raise()
                    except TimeExceededError:
                        state["stop_reason"] = "deadline_exceeded"
                        return self._finalize(state, "stopped_with_report")

                logger.info("[Engine] === Iteration %s/%s ===", iteration + 1, max_iterations)
                self._emit(
                    "WORKFLOW_ITERATION",
                    {
                        "iteration": iteration + 1,
                        "max": max_iterations,
                        "spent_usd": float(state.get("spent_usd", 0.0)),
                    },
                )

                prev_fingerprint = state.get("code_fingerprint", "")
                execution_handoffs = self._execution_handoffs(state)
                state["pending_handoffs"] = execution_handoffs + self._quality_handoffs(state)
                from .subgraph import run_parallel_execution

                parallel_updates = await run_parallel_execution(
                    state=state,
                    executor=self.executor,
                    manager=self.manager,
                    backend_fn=self._nodes["execute_backend"] if "execute_backend" in execution_handoffs else None,
                    frontend_fn=self._nodes["execute_frontend"] if "execute_frontend" in execution_handoffs else None,
                )
                if parallel_updates:
                    self._apply_updates(state, parallel_updates)
                for handoff in execution_handoffs:
                    self._record_handoff(state, handoff)

                if overnight_mode and run_id:
                    await self._save_checkpoint(run_id, "execute_parallel", iteration + 1, state)

                new_fingerprint = self._compute_fingerprint(state)
                if new_fingerprint == prev_fingerprint and iteration > 0:
                    state["logs"] = state.get("logs", []) + [f"iter_{iteration + 1}: no_progress_detected"]
                    logger.warning("[Engine] No progress detected at iteration %s", iteration + 1)
                state["code_fingerprint"] = new_fingerprint

                quality_handoffs = self._quality_handoffs(state)
                for node_name in quality_handoffs:
                    state = await self._run_node(node_name, state)
                    if overnight_mode and run_id:
                        await self._save_checkpoint(run_id, node_name, iteration + 1, state)

                    if node_name == "review" and state.get("needs_rework", False):
                        break

                    if node_name == "verification" and not state.get("verification_passed", False):
                        state["needs_rework"] = True
                        state["rework_source"] = "verifier"
                        verification_failures = self._verification_rework_reasons(state)
                        if verification_failures:
                            existing = list(state.get("failure_summary", []) or [])
                            state["failure_summary"] = existing + [
                                item for item in verification_failures if item not in existing
                            ]
                        break

                    if node_name == "verification":
                        verification_failures = self._verification_rework_reasons(state)
                        if verification_failures:
                            state["needs_rework"] = True
                            state["rework_source"] = "verifier"
                            existing = list(state.get("failure_summary", []) or [])
                            state["failure_summary"] = existing + [
                                item for item in verification_failures if item not in existing
                            ]
                            break

                if not state.get("needs_rework", False):
                    if not quality_handoffs:
                        logger.info("[Engine] No review/verifier handoffs selected; completing after execution")

                    if overnight_mode and verification_runner is not None:
                        profile = str(self._active_overnight_config.get("verification_profile", "default"))
                        dod = self._active_overnight_config.get("definition_of_done", [])
                        quality_threshold = int(self._active_overnight_config.get("quality_threshold", 7))
                        gate_results = await verification_runner.run(
                            profile=profile,
                            state=state,
                            definition_of_done=dod,
                            quality_threshold=quality_threshold,
                        )
                        state["gate_results"] = [g.to_dict() for g in gate_results]

                        hard_failures = [g for g in gate_results if g.hard and g.verdict != GateVerdict.PASS]
                        if hard_failures:
                            first = hard_failures[0]
                            state["failure_summary"] = state.get("failure_summary", []) + [first.detail]
                            if first.verdict in {GateVerdict.FAIL_NON_RECOVERABLE, GateVerdict.BLOCKED_EXTERNAL}:
                                state["stop_reason"] = f"hard_gate:{first.gate_id}:{first.verdict.value}"
                                return self._finalize(state, "needs_human")

                            by_gate = dict(state.get("gate_retry_by_gate", {}))
                            by_gate[first.gate_id] = int(by_gate.get(first.gate_id, 0)) + 1
                            state["gate_retry_by_gate"] = by_gate
                            state["gate_retry_total"] = int(state.get("gate_retry_total", 0)) + 1

                            resume_policy = self._active_overnight_config.get("resume_policy", {})
                            per_gate_cap = int(resume_policy.get("max_retries_per_gate", 3))
                            total_cap = int(resume_policy.get("max_total_retries", 12))
                            if by_gate[first.gate_id] > per_gate_cap or int(state["gate_retry_total"]) > total_cap:
                                state["stop_reason"] = f"gate_retry_exhausted:{first.gate_id}"
                                return self._finalize(state, "needs_human")

                            state["needs_rework"] = True
                            state["replan_guidance"] = f"Recover from {first.gate_id}: {first.detail}"
                        else:
                            return self._finalize(state, "completed")
                    else:
                        return self._finalize(state, "completed")

                replan_handoff = self._replan_handoff(state)
                if replan_handoff:
                    state = await self._run_node(replan_handoff, state)
                    if overnight_mode and run_id:
                        await self._save_checkpoint(run_id, replan_handoff, iteration + 1, state)

                if state.get("stop_reason"):
                    return self._finalize(state, state.get("final_status", "stopped"))
            except BudgetExceededError:
                await self._refresh_spent_usd(state)
                state["stop_reason"] = "budget_exceeded"
                state["failure_summary"] = state.get("failure_summary", []) + ["Budget exceeded"]
                return self._finalize(state, "stopped_with_report")

        state["stop_reason"] = f"max_iterations_reached ({max_iterations})"
        return self._finalize(state, "stopped_with_report" if overnight_mode else "stopped")

    async def _run_node(self, node_name: str, state: WorkflowState) -> WorkflowState:
        canonical = self._canonical_node_name(node_name)
        node_fn = None
        for lookup_name in self._node_lookup_names(canonical):
            node_fn = self._nodes.get(lookup_name)
            if node_fn is not None:
                break
        if node_fn is None:
            logger.error("[Engine] Unknown node: %s", canonical)
            return state

        self._emit("WORKFLOW_NODE_START", {"node": canonical})
        start = time.time()
        try:
            updates = await node_fn(
                state=state,
                executor=self.executor,
                manager=self.manager,
            )
            if updates:
                self._apply_updates(state, updates)
            self._record_handoff(state, canonical)

            elapsed = time.time() - start
            state["logs"] = state.get("logs", []) + [f"{canonical}: ok ({elapsed:.1f}s)"]
            self._emit("WORKFLOW_NODE_DONE", {"node": canonical, "elapsed": elapsed})
            logger.info("[Engine] Node %s completed in %.1fs", canonical, elapsed)
        except BudgetExceededError:
            raise
        except Exception as exc:
            elapsed = time.time() - start
            error_msg = f"{canonical}: error: {str(exc)[:200]}"
            state["logs"] = state.get("logs", []) + [error_msg]
            self._emit("WORKFLOW_NODE_ERROR", {"node": canonical, "error": str(exc)[:200]})
            logger.error("[Engine] Node %s failed: %s", canonical, exc, exc_info=True)
        return state

    async def _save_checkpoint(
        self,
        run_id: str,
        node_name: str,
        iteration: int,
        state: WorkflowState,
    ) -> None:
        payload = json.dumps(dict(state), default=str).encode("utf-8")
        checkpoint = zlib.compress(payload)
        thread_id = f"{run_id}:{node_name}:{iteration}"
        metadata = {
            "run_id": run_id,
            "node": node_name,
            "iteration": iteration,
            "spent_usd": self._active_overnight_config.get("spent_usd", 0),
        }
        try:
            async with self._session_factory() as db:
                row = await db.get(WorkflowCheckpoint, thread_id)
                if row is None:
                    db.add(
                        WorkflowCheckpoint(
                            thread_id=thread_id,
                            checkpoint=checkpoint,
                            metadata_=metadata,
                        )
                    )
                else:
                    row.checkpoint = checkpoint
                    row.metadata_ = metadata
                await db.commit()
        except Exception as exc:
            logger.warning("Checkpoint save failed for %s: %s", thread_id, exc)

    async def _load_latest_checkpoint(self, run_id: str) -> Dict[str, Any] | None:
        pattern = f"{run_id}:%"
        try:
            async with self._session_factory() as db:
                row = (
                    await db.execute(
                        select(WorkflowCheckpoint)
                        .where(WorkflowCheckpoint.thread_id.like(pattern))
                        .order_by(
                            WorkflowCheckpoint.updated_at.desc(),
                            WorkflowCheckpoint.created_at.desc(),
                            WorkflowCheckpoint.thread_id.desc(),
                        )
                        .limit(1)
                    )
                ).scalars().first()
                if row is None or not row.checkpoint:
                    return None
                raw = zlib.decompress(row.checkpoint).decode("utf-8", errors="ignore")
                data = json.loads(raw)
                return data if isinstance(data, dict) else None
        except Exception as exc:
            logger.warning("Checkpoint load failed for run=%s: %s", run_id, exc)
            return None

    async def _refresh_spent_usd(self, state: WorkflowState) -> None:
        guard = getattr(self.executor, "spend_guard", None) if self.executor is not None else None
        if guard is None:
            return
        spent = None
        if hasattr(guard, "spent_so_far"):
            probe = guard.spent_so_far()
            spent = await probe if inspect.isawaitable(probe) else probe
        elif hasattr(guard, "today_spent"):
            spent = getattr(guard, "today_spent")
        if spent is not None:
            try:
                state["spent_usd"] = float(spent)
            except (TypeError, ValueError):
                pass

    def _finalize(self, state: WorkflowState, status: str) -> Dict[str, Any]:
        state["final_status"] = status
        self._emit(
            "WORKFLOW_COMPLETED",
            {
                "status": status,
                "iterations": state.get("iteration", 0),
                "stop_reason": state.get("stop_reason"),
                "spent_usd": float(state.get("spent_usd", 0.0)),
            },
        )
        logger.info(
            "[Engine] Workflow %s: iterations=%s, reason=%s",
            status,
            state.get("iteration", 0),
            state.get("stop_reason", "none"),
        )
        return dict(state)
