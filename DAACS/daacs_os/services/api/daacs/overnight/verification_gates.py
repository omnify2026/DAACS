"""Verification gates for overnight runs."""

from __future__ import annotations

import asyncio
import json
import os
import shlex
import shutil
import time
from dataclasses import asdict, dataclass
from enum import Enum
from typing import Any, Dict, Iterable, List, Sequence

from daacs.llm.cli_env import resolve_venv_executable

from .guards import CommandPolicyGuard


class GateVerdict(str, Enum):
    PASS = "pass"
    FAIL_RECOVERABLE = "fail_recoverable"
    FAIL_NON_RECOVERABLE = "fail_non_recoverable"
    BLOCKED_EXTERNAL = "blocked_external"


class VerificationProfile(str, Enum):
    QUICK = "quick"
    DEFAULT = "default"
    STRICT = "strict"


@dataclass
class GateResult:
    gate_id: str
    verdict: GateVerdict
    hard: bool
    detail: str
    duration_sec: float

    def to_dict(self) -> Dict[str, Any]:
        data = asdict(self)
        data["verdict"] = self.verdict.value
        return data


class OvernightVerificationRunner:
    _API_SURFACE_TEST_ARGS: dict[str, tuple[str, ...]] = {
        "auth_surface": ("-m", "pytest", "-q", "tests/test_auth.py"),
        "byok_surface": ("-m", "pytest", "-q", "tests/test_byok_key_handling.py"),
        "ws_auth_surface": ("-m", "pytest", "-q", "tests/test_ws_auth.py"),
    }

    _PROFILE_GATES: dict[VerificationProfile, Sequence[str]] = {
        VerificationProfile.QUICK: ("preflight", "files_exist", "build", "progress"),
        VerificationProfile.DEFAULT: (
            "preflight",
            "files_exist",
            "build",
            "test",
            "auth_surface",
            "byok_surface",
            "ws_auth_surface",
            "static",
            "policy",
            "quality",
            "progress",
        ),
        VerificationProfile.STRICT: (
            "preflight",
            "files_exist",
            "build",
            "test",
            "auth_surface",
            "byok_surface",
            "ws_auth_surface",
            "static",
            "policy",
            "quality",
            "dod_eval",
            "progress",
        ),
    }

    _HARD_DEFAULT: dict[str, bool] = {
        "preflight": True,
        "files_exist": True,
        "build": True,
        "test": False,
        "auth_surface": False,
        "byok_surface": False,
        "ws_auth_surface": False,
        "static": False,
        "policy": True,
        "quality": True,
        "dod_eval": True,
        "progress": True,
    }

    def __init__(
        self,
        workspace_dir: str,
        command_policy_guard: CommandPolicyGuard | None = None,
        llm_executor: Any | None = None,
    ):
        self.workspace_dir = workspace_dir
        self.command_policy_guard = command_policy_guard
        self.llm_executor = llm_executor

    async def run(
        self,
        profile: str,
        state: Dict[str, Any],
        definition_of_done: Iterable[str] | None = None,
        quality_threshold: int = 7,
    ) -> List[GateResult]:
        normalized = VerificationProfile(profile or "default")
        gate_ids = self._PROFILE_GATES[normalized]
        dod_items = [str(item).strip().lower() for item in (definition_of_done or []) if str(item).strip()]

        # DoD 조건에 lint/test 언급이 있으면 soft gate 강등 방지용 hard 승격.
        hard_overrides = set()
        if any("lint" in item for item in dod_items):
            hard_overrides.add("static")
        if any("test" in item for item in dod_items):
            hard_overrides.add("test")

        results: List[GateResult] = []
        for gate_id in gate_ids:
            hard = gate_id in hard_overrides or self._HARD_DEFAULT.get(gate_id, True)
            result = await self._run_gate(
                gate_id=gate_id,
                hard=hard,
                state=state,
                definition_of_done=dod_items,
                quality_threshold=quality_threshold,
            )
            results.append(result)
        return results

    async def _run_gate(
        self,
        gate_id: str,
        hard: bool,
        state: Dict[str, Any],
        definition_of_done: Sequence[str],
        quality_threshold: int,
    ) -> GateResult:
        start = time.perf_counter()
        try:
            if gate_id == "preflight":
                verdict, detail = self._gate_preflight()
            elif gate_id == "files_exist":
                verdict, detail = self._gate_files_exist(state)
            elif gate_id == "build":
                verdict, detail = await self._gate_build()
            elif gate_id == "test":
                verdict, detail = await self._gate_test()
            elif gate_id in self._API_SURFACE_TEST_ARGS:
                verdict, detail = await self._gate_api_surface(gate_id)
            elif gate_id == "static":
                verdict, detail = await self._gate_static()
            elif gate_id == "policy":
                verdict, detail = self._gate_policy(state)
            elif gate_id == "quality":
                verdict, detail = self._gate_quality(state, quality_threshold)
            elif gate_id == "dod_eval":
                verdict, detail = await self._gate_dod_eval(state, definition_of_done)
            elif gate_id == "progress":
                verdict, detail = self._gate_progress(state)
            else:
                verdict, detail = GateVerdict.FAIL_NON_RECOVERABLE, f"Unknown gate: {gate_id}"
        except Exception as exc:
            verdict = GateVerdict.FAIL_NON_RECOVERABLE if hard else GateVerdict.FAIL_RECOVERABLE
            detail = f"{gate_id} error: {exc}"

        return GateResult(
            gate_id=gate_id,
            verdict=verdict,
            hard=hard,
            detail=detail,
            duration_sec=round(time.perf_counter() - start, 3),
        )

    def _gate_preflight(self) -> tuple[GateVerdict, str]:
        web_dir = os.path.join(self.workspace_dir, "apps", "web")
        api_dir = os.path.join(self.workspace_dir, "services", "api")
        if not os.path.isdir(web_dir) or not os.path.isdir(api_dir):
            return GateVerdict.FAIL_NON_RECOVERABLE, "Required directories missing"
        if self._resolve_api_python() is None and shutil.which("python") is None:
            return GateVerdict.BLOCKED_EXTERNAL, "python not found"
        return GateVerdict.PASS, "Environment preflight passed"

    def _gate_files_exist(self, state: Dict[str, Any]) -> tuple[GateVerdict, str]:
        backend_files = state.get("backend_files", {}) or {}
        frontend_files = state.get("frontend_files", {}) or {}
        if backend_files or frontend_files:
            return GateVerdict.PASS, "Generated files detected"
        return GateVerdict.FAIL_RECOVERABLE, "No generated files in state"

    async def _gate_build(self) -> tuple[GateVerdict, str]:
        checks: list[tuple[str, str]] = []
        web_dir = os.path.join(self.workspace_dir, "apps", "web")
        api_dir = os.path.join(self.workspace_dir, "services", "api")
        if os.path.isdir(web_dir) and shutil.which("npm"):
            checks.append((web_dir, "npm run build"))
        api_pytest = self._build_api_python_command("-m", "pytest", "--co", "-q", "tests")
        if os.path.isdir(api_dir) and api_pytest:
            checks.append((api_dir, api_pytest))
        if not checks:
            return GateVerdict.BLOCKED_EXTERNAL, "No build command available"
        return await self._run_commands(checks, recoverable=True)

    async def _gate_test(self) -> tuple[GateVerdict, str]:
        checks: list[tuple[str, str]] = []
        web_dir = os.path.join(self.workspace_dir, "apps", "web")
        api_dir = os.path.join(self.workspace_dir, "services", "api")
        if os.path.isdir(web_dir) and shutil.which("npm"):
            checks.append((web_dir, "npm run test:regression"))
            checks.append((web_dir, "npm run smoke:chromium"))
        api_pytest = self._build_api_python_command("-m", "pytest", "-q", "tests")
        if os.path.isdir(api_dir) and api_pytest:
            checks.append((api_dir, api_pytest))
        if not checks:
            return GateVerdict.BLOCKED_EXTERNAL, "Test command not configured"
        return await self._run_commands(checks, recoverable=True)

    async def _gate_api_surface(self, gate_id: str) -> tuple[GateVerdict, str]:
        api_dir = os.path.join(self.workspace_dir, "services", "api")
        command = self._build_api_python_command(*self._API_SURFACE_TEST_ARGS[gate_id])
        if not os.path.isdir(api_dir) or command is None:
            return GateVerdict.BLOCKED_EXTERNAL, f"{gate_id} command not configured"
        return await self._run_commands(
            [(api_dir, command)],
            recoverable=True,
        )

    async def _gate_static(self) -> tuple[GateVerdict, str]:
        checks: list[tuple[str, str]] = []
        web_dir = os.path.join(self.workspace_dir, "apps", "web")
        api_dir = os.path.join(self.workspace_dir, "services", "api")
        api_ruff = self._build_api_tool_command("ruff", "check", ".")
        if os.path.isdir(api_dir) and api_ruff:
            checks.append((api_dir, api_ruff))
        if os.path.isdir(web_dir):
            if shutil.which("npx"):
                checks.append((web_dir, "npx eslint src/"))
            elif shutil.which("npm"):
                checks.append((web_dir, "npm run lint"))
        if not checks:
            return GateVerdict.BLOCKED_EXTERNAL, "Static check command not configured"
        return await self._run_commands(checks, recoverable=True)

    def _gate_policy(self, state: Dict[str, Any]) -> tuple[GateVerdict, str]:
        if self.command_policy_guard is None:
            return GateVerdict.PASS, "Policy guard not configured"
        ok, detail = self.command_policy_guard.check_logs(state.get("logs", []))
        if ok:
            return GateVerdict.PASS, detail
        return GateVerdict.FAIL_NON_RECOVERABLE, detail

    def _gate_quality(self, state: Dict[str, Any], quality_threshold: int) -> tuple[GateVerdict, str]:
        score = int(state.get("code_review_score", state.get("quality_score", 0)) or 0)
        if score >= int(quality_threshold):
            return GateVerdict.PASS, f"Quality score {score} >= {quality_threshold}"
        return GateVerdict.FAIL_RECOVERABLE, f"Quality score {score} < {quality_threshold}"

    async def _gate_dod_eval(
        self,
        state: Dict[str, Any],
        definition_of_done: Sequence[str],
    ) -> tuple[GateVerdict, str]:
        if not definition_of_done:
            return GateVerdict.PASS, "No custom DoD provided"

        if self.llm_executor is not None:
            summary = {
                "goal": state.get("current_goal", ""),
                "verification_passed": state.get("verification_passed", False),
                "quality_score": state.get("code_review_score", state.get("quality_score", 0)),
                "logs_tail": list(state.get("logs", []))[-40:],
                "backend_files": len((state.get("backend_files") or {}).keys()),
                "frontend_files": len((state.get("frontend_files") or {}).keys()),
            }
            prompt = (
                "Evaluate whether all DoD items are satisfied.\n"
                f"DoD: {json.dumps(list(definition_of_done), ensure_ascii=False)}\n"
                f"Run summary: {json.dumps(summary, ensure_ascii=False)}\n"
                "Return strict JSON only: "
                '{"passed": boolean, "missing": string[], "reason": string}.'
            )
            try:
                raw = await self.llm_executor.execute(
                    role="reviewer",
                    prompt=prompt,
                    system_prompt="You are a strict software QA evaluator.",
                )
                payload = self._extract_json(raw)
                if payload.get("passed") is True:
                    return GateVerdict.PASS, str(payload.get("reason") or "DoD satisfied by LLM evaluation")
                missing = payload.get("missing") or []
                reason = str(payload.get("reason") or "").strip()
                msg = reason or f"LLM reported missing DoD items: {', '.join(missing[:4])}"
                return GateVerdict.FAIL_RECOVERABLE, msg
            except Exception as exc:
                return GateVerdict.BLOCKED_EXTERNAL, f"DoD LLM evaluation blocked: {exc}"

        corpus = " ".join(str(x).lower() for x in state.get("logs", []))
        misses = [item for item in definition_of_done if item not in corpus]
        if misses:
            return GateVerdict.FAIL_RECOVERABLE, f"DoD unmatched items (fallback): {', '.join(misses[:4])}"
        return GateVerdict.PASS, "DoD items matched (fallback)"

    @staticmethod
    def _extract_json(raw: str) -> Dict[str, Any]:
        text = str(raw or "").strip()
        if not text:
            raise ValueError("empty LLM response")
        try:
            data = json.loads(text)
            if isinstance(data, dict):
                return data
        except Exception:
            pass
        start = text.find("{")
        end = text.rfind("}")
        if start >= 0 and end > start:
            data = json.loads(text[start : end + 1])
            if isinstance(data, dict):
                return data
        raise ValueError("could not parse evaluator JSON")

    def _gate_progress(self, state: Dict[str, Any]) -> tuple[GateVerdict, str]:
        repeat = int(state.get("failure_repeat_count", 0) or 0)
        fingerprint = str(state.get("code_fingerprint", "") or "")
        if not fingerprint:
            return GateVerdict.FAIL_RECOVERABLE, "Missing code fingerprint"
        if repeat >= 3:
            return GateVerdict.FAIL_RECOVERABLE, f"Progress plateau detected (repeat={repeat})"
        return GateVerdict.PASS, "Fingerprint and progress look healthy"

    async def _run_commands(
        self,
        commands: Sequence[tuple[str, str]],
        recoverable: bool,
    ) -> tuple[GateVerdict, str]:
        failures: list[str] = []
        for cwd, cmd in commands:
            if self.command_policy_guard is not None:
                self.command_policy_guard.check_command(cmd)
            proc = await asyncio.create_subprocess_shell(
                cmd,
                cwd=cwd,
                stdout=asyncio.subprocess.PIPE,
                stderr=asyncio.subprocess.PIPE,
            )
            stdout, stderr = await proc.communicate()
            if proc.returncode != 0:
                out = (stderr or stdout or b"").decode("utf-8", errors="ignore").strip()
                failures.append(f"{cmd} -> {proc.returncode}: {out[:280]}")
        if failures:
            return (
                GateVerdict.FAIL_RECOVERABLE if recoverable else GateVerdict.FAIL_NON_RECOVERABLE,
                " | ".join(failures),
            )
        return GateVerdict.PASS, "Command checks passed"

    def _resolve_api_python(self) -> str | None:
        candidate = resolve_venv_executable(
            os.path.join(self.workspace_dir, "services", "api", ".venv312"),
            "python",
        )
        if candidate is not None:
            return str(candidate)
        return shutil.which("python")

    def _resolve_api_tool(self, tool: str) -> str | None:
        candidate = resolve_venv_executable(
            os.path.join(self.workspace_dir, "services", "api", ".venv312"),
            tool,
        )
        if candidate is not None:
            return str(candidate)
        return shutil.which(tool)

    def _build_api_python_command(self, *args: str) -> str | None:
        python_executable = self._resolve_api_python()
        if python_executable is None:
            return None
        return " ".join(shlex.quote(part) for part in (python_executable, *args))

    def _build_api_tool_command(self, tool: str, *args: str) -> str | None:
        executable = self._resolve_api_tool(tool)
        if executable is None:
            return None
        return " ".join(shlex.quote(part) for part in (executable, *args))
