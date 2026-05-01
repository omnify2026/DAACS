"""
DAACS OS — Claude CLI Stream Adapter
Anthropic Claude Code CLI 기반 스트리밍 실행기

출력 형식: `claude --output-format stream-json --print`
각 라인은 NDJSON: {"type": "...", "delta": {...}}
"""
import asyncio
import json
import logging
import shutil
from typing import AsyncGenerator, Dict, List, Optional

from .base import LLMStreamAdapter, StreamEvent
from ....llm.cli_env import build_cli_subprocess_env

logger = logging.getLogger("daacs.adapter.claude")

class ClaudeAdapter(LLMStreamAdapter):
    """
    Claude Code CLI 스트리밍 어댑터.

    기본 실행 커맨드는 CLIProvider와 동일하게 유지한다:
    `claude --dangerously-skip-permissions -p -`

    stdout이 JSON 라인이면 구조적으로 파싱하고, 일반 텍스트면 청크/툴콜
    휴리스틱으로 처리한다.
    """

    provider = "claude"

    def __init__(self, model: Optional[str] = None, agent_role: str = "reviewer"):
        self.model = model or "claude-sonnet-4-6"
        self.agent_role = agent_role

    def is_available(self) -> bool:
        return shutil.which("claude") is not None

    async def stream(
        self,
        prompt: str,
        system_prompt: str,
        history: List[Dict],
        cwd: str,
        timeout: int = 300,
    ) -> AsyncGenerator[StreamEvent, None]:
        if not self.is_available():
            yield StreamEvent(
                type="error",
                content="claude CLI not found. Install: npm install -g @anthropic-ai/claude-code",
                agent=self.agent_role,
            )
            return

        full_prompt = self._build_full_prompt(prompt, system_prompt, history)

        cmd = [
            "claude",
            "--dangerously-skip-permissions",
            "-p",
            "-",
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
                content=f"claude [{self.model}] started",
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
                    content=f"claude exited {proc.returncode}: {detail}",
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
                content=f"claude timed out after {timeout}s",
                agent=self.agent_role,
            )
        except Exception as e:
            logger.exception(f"ClaudeAdapter error: {e}")
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
        """Claude 출력 라인 파싱 (JSON or plain text)."""
        if not line.startswith("{"):
            lower = line.lower()
            if any(lower.startswith(pat) for pat in ("ran ", "running ", "> ", "$ ", "tool:")):
                return StreamEvent(type="tool_call", content=line, agent=self.agent_role)
            return StreamEvent(type="chunk", content=line, agent=self.agent_role)

        try:
            obj = json.loads(line)
        except json.JSONDecodeError:
            return StreamEvent(type="chunk", content=line, agent=self.agent_role)

        event_type = obj.get("type", "")

        # content_block_delta → 텍스트 청크
        if event_type == "content_block_delta":
            delta = obj.get("delta", {})
            text = delta.get("text", "")
            if text:
                return StreamEvent(type="chunk", content=text, agent=self.agent_role)
            return None

        # tool_use → 툴 호출
        if event_type == "tool_use":
            name = obj.get("name", "tool")
            inp = obj.get("input", {})
            # 보기 좋게 포맷팅
            if "file_path" in inp:
                content = f"Ran {name} {inp['file_path']}"
            elif "command" in inp:
                content = f"Ran {name}: {inp['command']}"
            else:
                content = f"Ran {name}"
            return StreamEvent(type="tool_call", content=content, agent=self.agent_role, metadata={"tool": name, "input": inp})

        # tool_result
        if event_type == "tool_result":
            result = obj.get("content", "")
            if isinstance(result, list):
                result = " ".join(r.get("text", "") for r in result if isinstance(r, dict))
            return StreamEvent(type="tool_result", content=str(result)[:200], agent=self.agent_role)

        # message_stop is not emitted as done here.
        # Stream completion is emitted once at process exit.
        if event_type == "message_stop":
            return None

        return None

    def _build_full_prompt(self, prompt: str, system_prompt: str, history: List[Dict]) -> str:
        """히스토리 + 시스템 프롬프트 + 현재 prompt를 단일 문자열로."""
        parts = []
        if system_prompt:
            parts.append(f"[System]\n{system_prompt}\n")
        for msg in history[-10:]:
            role = msg.get("role", "user")
            content = msg.get("content", "")
            prefix = "User:" if role == "user" else "Assistant:"
            parts.append(f"{prefix} {content}")
        parts.append(f"User: {prompt}")
        return "\n\n".join(parts)
