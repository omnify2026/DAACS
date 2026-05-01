"""
DAACS OS — Sandbox Manager
에이전트 코드 실행을 격리된 Docker 컨테이너에서 수행

보안 정책 (daacs_config.yaml sandbox):
  - CPU/메모리 제한
  - 네트워크 차단 (none) 또는 화이트리스트
  - 읽기전용 루트 파일시스템
  - 실행 타임아웃
"""
import asyncio
import logging
import os
import tempfile
import uuid
from dataclasses import dataclass, field
from datetime import datetime
from enum import Enum
from pathlib import Path
from typing import Any, Dict, List, Optional

logger = logging.getLogger("daacs.sandbox")


class SandboxStatus(str, Enum):
    CREATED = "created"
    RUNNING = "running"
    COMPLETED = "completed"
    TIMEOUT = "timeout"
    ERROR = "error"


@dataclass
class SandboxResult:
    """샌드박스 실행 결과"""
    sandbox_id: str
    status: SandboxStatus
    exit_code: int = 0
    stdout: str = ""
    stderr: str = ""
    duration_ms: float = 0
    files_created: List[str] = field(default_factory=list)
    timestamp: str = field(default_factory=lambda: datetime.now().isoformat())

    def to_dict(self) -> Dict[str, Any]:
        return {
            "sandbox_id": self.sandbox_id,
            "status": self.status.value,
            "exit_code": self.exit_code,
            "stdout": self.stdout[:10000],  # 출력 제한
            "stderr": self.stderr[:5000],
            "duration_ms": self.duration_ms,
            "files_created": self.files_created,
        }


class SandboxManager:
    """
    Docker 기반 코드 실행 샌드박스.

    사용법:
        sm = SandboxManager(config=sandbox_config)
        result = await sm.execute(
            code="print('hello')",
            language="python",
            project_id="my-project",
            agent_role="developer",
        )
    """

    def __init__(
        self,
        enabled: bool = True,
        cpu_limit: str = "0.5",
        memory_limit: str = "512m",
        network_mode: str = "none",
        timeout_seconds: int = 300,
        read_only_root: bool = True,
        egress_whitelist: Optional[List[str]] = None,
        workspace_root: str = "workspace",
    ):
        self.enabled = enabled
        self.cpu_limit = cpu_limit
        self.memory_limit = memory_limit
        self.network_mode = network_mode
        self.timeout_seconds = timeout_seconds
        self.read_only_root = read_only_root
        self.egress_whitelist = egress_whitelist or []
        self.workspace_root = Path(workspace_root)
        self._history: List[SandboxResult] = []

    @classmethod
    def from_config(cls, config: Dict[str, Any]) -> "SandboxManager":
        """daacs_config.yaml sandbox 섹션에서 생성"""
        return cls(
            enabled=config.get("enabled", True),
            cpu_limit=str(config.get("cpu_limit", "0.5")),
            memory_limit=config.get("memory_limit", "512m"),
            network_mode=config.get("network_mode", "none"),
            timeout_seconds=config.get("timeout_seconds", 300),
            read_only_root=config.get("read_only_root", True),
            egress_whitelist=config.get("egress_whitelist", []),
        )

    async def execute(
        self,
        code: str,
        language: str = "python",
        project_id: str = "",
        agent_role: str = "",
        files: Optional[Dict[str, str]] = None,
    ) -> SandboxResult:
        """
        코드를 격리된 컨테이너에서 실행.

        Args:
            code: 실행할 코드
            language: python | node | bash
            files: 추가 파일 {경로: 내용}
        """
        sandbox_id = f"sb-{uuid.uuid4().hex[:8]}"

        if not self.enabled:
            return await self._execute_local(sandbox_id, code, language)

        logger.info(
            f"Sandbox {sandbox_id}: {language} execution for "
            f"{agent_role}@{project_id}"
        )

        # 임시 작업 디렉토리 생성
        work_dir = tempfile.mkdtemp(prefix=f"daacs-{sandbox_id}-")

        try:
            # 코드 파일 작성
            entry_file = self._write_entry_file(work_dir, code, language)

            # 추가 파일 작성
            if files:
                for fpath, content in files.items():
                    target = Path(work_dir) / fpath
                    target.parent.mkdir(parents=True, exist_ok=True)
                    target.write_text(content, encoding="utf-8")

            # Docker 명령 구성
            docker_cmd = self._build_docker_command(
                sandbox_id, work_dir, entry_file, language
            )

            # 실행
            start = asyncio.get_event_loop().time()
            result = await self._run_container(sandbox_id, docker_cmd)
            duration = (asyncio.get_event_loop().time() - start) * 1000
            result.duration_ms = duration

            # 생성된 파일 수집
            result.files_created = self._collect_output_files(work_dir)

        except asyncio.TimeoutError:
            result = SandboxResult(
                sandbox_id=sandbox_id,
                status=SandboxStatus.TIMEOUT,
                stderr=f"Execution timed out after {self.timeout_seconds}s",
            )
        except Exception as e:
            result = SandboxResult(
                sandbox_id=sandbox_id,
                status=SandboxStatus.ERROR,
                stderr=str(e),
            )

        self._history.append(result)
        logger.info(
            f"Sandbox {sandbox_id}: {result.status.value} "
            f"({result.duration_ms:.0f}ms)"
        )
        return result

    def _write_entry_file(self, work_dir: str, code: str, language: str) -> str:
        """엔트리 파일 작성"""
        ext_map = {"python": "main.py", "node": "main.js", "bash": "main.sh"}
        filename = ext_map.get(language, "main.py")
        filepath = Path(work_dir) / filename
        filepath.write_text(code, encoding="utf-8")
        return filename

    def _build_docker_command(
        self,
        sandbox_id: str,
        work_dir: str,
        entry_file: str,
        language: str,
    ) -> List[str]:
        """Docker run 명령 구성"""
        image_map = {
            "python": "python:3.12-slim",
            "node": "node:20-alpine",
            "bash": "alpine:3.19",
        }
        image = image_map.get(language, "python:3.12-slim")

        run_cmd_map = {
            "python": f"python /workspace/{entry_file}",
            "node": f"node /workspace/{entry_file}",
            "bash": f"sh /workspace/{entry_file}",
        }
        run_cmd = run_cmd_map.get(language, f"python /workspace/{entry_file}")

        cmd = [
            "docker", "run",
            "--rm",
            "--name", sandbox_id,
            "--cpus", self.cpu_limit,
            "--memory", self.memory_limit,
            "--network", self.network_mode,
            "-v", f"{work_dir}:/workspace",
            "-w", "/workspace",
        ]

        if self.read_only_root:
            cmd.extend(["--read-only", "--tmpfs", "/tmp:rw,noexec,nosuid,size=64m"])

        cmd.extend([image, "sh", "-c", run_cmd])
        return cmd

    async def _run_container(
        self, sandbox_id: str, cmd: List[str]
    ) -> SandboxResult:
        """컨테이너 실행 + 결과 수집"""
        proc = await asyncio.create_subprocess_exec(
            *cmd,
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.PIPE,
        )

        try:
            stdout, stderr = await asyncio.wait_for(
                proc.communicate(), timeout=self.timeout_seconds
            )
        except asyncio.TimeoutError:
            # 타임아웃 시 컨테이너 강제 종료
            await asyncio.create_subprocess_exec(
                "docker", "kill", sandbox_id,
                stdout=asyncio.subprocess.DEVNULL,
                stderr=asyncio.subprocess.DEVNULL,
            )
            raise

        status = (
            SandboxStatus.COMPLETED if proc.returncode == 0
            else SandboxStatus.ERROR
        )

        return SandboxResult(
            sandbox_id=sandbox_id,
            status=status,
            exit_code=proc.returncode or 0,
            stdout=stdout.decode("utf-8", errors="replace"),
            stderr=stderr.decode("utf-8", errors="replace"),
        )

    async def _execute_local(
        self, sandbox_id: str, code: str, language: str
    ) -> SandboxResult:
        """샌드박스 비활성 시 로컬 실행 (개발용)"""
        logger.warning(f"Sandbox disabled — executing locally: {sandbox_id}")

        cmd_map = {"python": "python", "node": "node", "bash": "sh"}
        interpreter = cmd_map.get(language, "python")

        proc = await asyncio.create_subprocess_exec(
            interpreter, "-c", code,
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.PIPE,
        )

        try:
            stdout, stderr = await asyncio.wait_for(
                proc.communicate(), timeout=self.timeout_seconds
            )
        except asyncio.TimeoutError:
            proc.kill()
            return SandboxResult(
                sandbox_id=sandbox_id,
                status=SandboxStatus.TIMEOUT,
                stderr=f"Local execution timed out after {self.timeout_seconds}s",
            )

        return SandboxResult(
            sandbox_id=sandbox_id,
            status=SandboxStatus.COMPLETED if proc.returncode == 0 else SandboxStatus.ERROR,
            exit_code=proc.returncode or 0,
            stdout=stdout.decode("utf-8", errors="replace"),
            stderr=stderr.decode("utf-8", errors="replace"),
        )

    def _collect_output_files(self, work_dir: str) -> List[str]:
        """작업 디렉토리에서 생성된 파일 수집"""
        files = []
        for p in Path(work_dir).rglob("*"):
            if p.is_file() and p.name not in ("main.py", "main.js", "main.sh"):
                files.append(str(p.relative_to(work_dir)))
        return files

    # ─── 이력 ───

    def get_history(self) -> List[Dict]:
        return [r.to_dict() for r in self._history[-50:]]

    def get_stats(self) -> Dict[str, Any]:
        total = len(self._history)
        success = sum(1 for r in self._history if r.status == SandboxStatus.COMPLETED)
        return {
            "total": total,
            "success": success,
            "failure": total - success,
            "avg_duration_ms": (
                sum(r.duration_ms for r in self._history) / total if total else 0
            ),
        }
