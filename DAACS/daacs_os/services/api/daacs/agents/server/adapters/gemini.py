"""
DAACS OS — Gemini CLI Stream Adapter
Google Gemini CLI 기반 스트리밍 실행기

출력 형식: 일반 텍스트 stdout (gemini CLI)
"""
import asyncio
import json
import logging
import os
from pathlib import Path
import shutil
from typing import AsyncGenerator, Dict, List, Optional

from .base import LLMStreamAdapter, StreamEvent
from ....llm.cli_env import build_cli_subprocess_env

logger = logging.getLogger("daacs.adapter.gemini")


class GeminiAdapter(LLMStreamAdapter):
    """
    Gemini CLI 스트리밍 어댑터.

    `gemini` CLI는 일반 텍스트 stdout을 출력.
    JSON 라인이면 구조화 파싱, 아니면 텍스트 청크로 처리.
    """

    provider = "gemini"

    def __init__(self, model: Optional[str] = None, agent_role: str = "ceo"):
        self.model = model or "gemini-2.0-flash"
        self.agent_role = agent_role

    def _resolve_gemini_executable(self) -> Optional[str]:
        configured = (os.getenv("DAACS_GEMINI_CLI_PATH", "") or "").strip()
        if configured:
            if Path(configured).exists():
                return configured
            return None

        for name in ("gemini", "gemini.cmd", "gemini.exe"):
            found = shutil.which(name)
            if found:
                return found

        appdata = (os.getenv("APPDATA", "") or "").strip()
        if appdata:
            candidate = Path(appdata) / "npm" / "gemini.cmd"
            if candidate.exists():
                return str(candidate)

        local_appdata = (os.getenv("LOCALAPPDATA", "") or "").strip()
        if local_appdata:
            candidate = Path(local_appdata) / "npm" / "gemini.cmd"
            if candidate.exists():
                return str(candidate)

        return None

    def is_available(self) -> bool:
        return self._resolve_gemini_executable() is not None

    async def stream(
        self,
        prompt: str,
        system_prompt: str,
        history: List[Dict],
        cwd: str,
        timeout: int = 300,
    ) -> AsyncGenerator[StreamEvent, None]:
        gemini_exe = self._resolve_gemini_executable()
        if not gemini_exe:
            yield StreamEvent(
                type="error",
                content="gemini CLI not found. Set DAACS_GEMINI_CLI_PATH or install it (e.g., npm install -g @google/gemini-cli).",
                agent=self.agent_role,
            )
            return

        full_prompt = self._build_full_prompt(prompt, system_prompt, history)

        cmd = [
            gemini_exe,
            "-s",
        ]

        proc = None
        stderr_task = None
        stderr_buffer: List[str] = []
        deadline = asyncio.get_running_loop().time() + timeout

        try:
            proc = await asyncio.create_subprocess_exec(
                *cmd,
                stdin=asyncio.subprocess.PIPE,
                stdout=asyncio.subprocess.PIPE,
                stderr=asyncio.subprocess.PIPE,
                cwd=cwd,
                env=build_cli_subprocess_env(),
            )
            stderr_task = asyncio.create_task(self._drain_stderr(proc, stderr_buffer))
            await self._write_stdin(proc, full_prompt)

            yield StreamEvent(
                type="session_start",
                content=f"gemini [{self.model}] started",
                agent=self.agent_role,
            )

            async for line in self._iter_stdout_lines(proc, deadline):
                event = self._parse_line(line)
                if event:
                    yield event

            await self._wait_for_exit(proc, deadline)
            err_text = "".join(stderr_buffer).strip()
            if proc.returncode and proc.returncode != 0:
                detail = err_text[:500] if err_text else "no stderr"
                yield StreamEvent(
                    type="error",
                    content=f"gemini exited {proc.returncode}: {detail}",
                    agent=self.agent_role,
                )
                return

            yield StreamEvent(type="done", content="", agent=self.agent_role)

        except asyncio.TimeoutError:
            if proc and proc.returncode is None:
                proc.kill()
                try:
                    await asyncio.wait_for(proc.wait(), timeout=5)
                except asyncio.TimeoutError:
                    pass
            yield StreamEvent(
                type="error",
                content=f"gemini timed out after {timeout}s",
                agent=self.agent_role,
            )
        except Exception as e:
            logger.exception(f"GeminiAdapter error: {e}")
            yield StreamEvent(type="error", content=str(e), agent=self.agent_role)
        finally:
            if stderr_task:
                if not stderr_task.done():
                    stderr_task.cancel()
                try:
                    await stderr_task
                except asyncio.CancelledError:
                    pass

    async def _iter_stdout_lines(self, proc, deadline: float):
        loop = asyncio.get_running_loop()
        while True:
            remaining = deadline - loop.time()
            if remaining <= 0:
                raise asyncio.TimeoutError
            raw_line = await asyncio.wait_for(proc.stdout.readline(), timeout=remaining)
            if not raw_line:
                break
            line = raw_line.decode("utf-8", errors="replace").rstrip()
            if line:
                yield line

    async def _wait_for_exit(self, proc, deadline: float) -> None:
        remaining = deadline - asyncio.get_running_loop().time()
        if remaining <= 0:
            raise asyncio.TimeoutError
        await asyncio.wait_for(proc.wait(), timeout=remaining)

    async def _write_stdin(self, proc, payload: str) -> None:
        if proc.stdin is None:
            return
        proc.stdin.write(payload.encode("utf-8"))
        await proc.stdin.drain()
        proc.stdin.close()
        wait_closed = getattr(proc.stdin, "wait_closed", None)
        if callable(wait_closed):
            await wait_closed()

    async def _drain_stderr(self, proc, buffer: List[str]) -> None:
        if proc.stderr is None:
            return
        while True:
            chunk = await proc.stderr.read(1024)
            if not chunk:
                break
            buffer.append(chunk.decode("utf-8", errors="replace"))

    def _parse_line(self, line: str) -> Optional[StreamEvent]:
        """Gemini stdout 라인 파싱"""
        # JSON 라인 시도
        if line.startswith("{"):
            try:
                obj = json.loads(line)
                # Gemini MCP/agent 출력이 JSON인 경우
                candidates = obj.get("candidates", [])
                if candidates:
                    text = ""
                    for cand in candidates:
                        for part in cand.get("content", {}).get("parts", []):
                            text += part.get("text", "")
                    if text:
                        return StreamEvent(type="chunk", content=text, agent=self.agent_role)
                    return None

                # 단순 {"text": ...} 또는 {"content": ...}
                text = obj.get("text") or obj.get("content") or ""
                if text:
                    return StreamEvent(type="chunk", content=str(text), agent=self.agent_role)
                return None
            except json.JSONDecodeError:
                pass

        # 툴 호출 패턴
        lower = line.lower()
        if any(lower.startswith(pat) for pat in ("ran ", "running ", "> ", "$ ", "tool:")):
            return StreamEvent(type="tool_call", content=line, agent=self.agent_role)

        return StreamEvent(type="chunk", content=line, agent=self.agent_role)

    def _build_full_prompt(self, prompt: str, system_prompt: str, history: List[Dict]) -> str:
        parts = []
        if system_prompt:
            parts.append(f"System: {system_prompt}\n")
        for msg in history[-10:]:
            role = msg.get("role", "user")
            content = msg.get("content", "")
            prefix = "User:" if role == "user" else "Model:"
            parts.append(f"{prefix} {content}")
        parts.append(f"User: {prompt}")
        return "\n\n".join(parts)
