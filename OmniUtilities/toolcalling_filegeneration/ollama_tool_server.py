from pathlib import Path
import os
import subprocess
from typing import Any
from datetime import datetime
from time import perf_counter
import json

from fastapi import FastAPI, HTTPException
from pydantic import BaseModel, Field


BASE_DIR = Path(__file__).resolve().parent

app = FastAPI(title="Ollama ToolCalling File Server", version="1.0.0")


def GetHostSandboxRoot() -> Path:
    outRaw = os.environ.get("DAACS_TOOL_SERVER_WORKSPACE", "").strip()
    if outRaw:
        return Path(outRaw).expanduser().resolve()
    return BASE_DIR.resolve()


def ResolveEffectiveWorkspaceRoot(InWorkspaceRoot: str | None) -> Path:
    outSandbox = GetHostSandboxRoot()
    if InWorkspaceRoot is None:
        return outSandbox
    outStripped = InWorkspaceRoot.strip()
    if not outStripped:
        return outSandbox
    outCandidate = Path(outStripped).expanduser()
    if outCandidate.is_absolute():
        outResolved = outCandidate.resolve()
    else:
        outResolved = (outSandbox / outCandidate).resolve()
    if outSandbox not in outResolved.parents and outResolved != outSandbox:
        raise HTTPException(status_code=403, detail="InWorkspaceRoot is outside the allowed sandbox.")
    if outResolved.exists() and not outResolved.is_dir():
        raise HTTPException(status_code=400, detail="InWorkspaceRoot must be a directory.")
    return outResolved


def ResolvePathWithinSandbox(InPath: str, InRelativeTo: Path) -> Path:
    if InPath is None:
        raise HTTPException(status_code=400, detail="InPath is required.")
    if not InPath.strip():
        raise HTTPException(status_code=400, detail="InPath cannot be empty.")
    outSandbox = GetHostSandboxRoot()
    outCandidate = Path(InPath.strip()).expanduser()
    if outCandidate.is_absolute():
        outPath = outCandidate.resolve()
    else:
        outPath = (InRelativeTo / outCandidate).resolve()
    if outSandbox not in outPath.parents and outPath != outSandbox:
        raise HTTPException(status_code=403, detail="Path access denied.")
    return outPath


class ToolCallRequest(BaseModel):
    InToolName: str = Field(..., min_length=1)
    InArguments: dict[str, Any] | None = None


def LogEvent(InEvent: str, **InData: Any) -> None:
    outTs = datetime.now().strftime("%Y-%m-%d %H:%M:%S.%f")[:-3]
    outPayload = {
        "event": InEvent,
        **InData,
    }
    print(f"[{outTs}] {json.dumps(outPayload, ensure_ascii=False)}", flush=True)


def ReadFileTool(InPath: str, InWorkspaceRoot: str | None = None) -> dict[str, Any]:
    outStart = perf_counter()
    outEffective = ResolveEffectiveWorkspaceRoot(InWorkspaceRoot)
    outPath = ResolvePathWithinSandbox(InPath, outEffective)
    if not outPath.exists():
        raise HTTPException(status_code=404, detail="File not found.")
    if not outPath.is_file():
        raise HTTPException(status_code=400, detail="Path is not a file.")

    outContent = outPath.read_text(encoding="utf-8")
    try:
        outRelPath = str(outPath.relative_to(outEffective))
    except ValueError:
        outRelPath = str(outPath.relative_to(GetHostSandboxRoot()))
    outByteLen = len(outContent.encode("utf-8"))
    outElapsedMs = int((perf_counter() - outStart) * 1000)
    LogEvent(
        "read_file.success",
        InPath=str(outPath),
        InRelativePath=outRelPath,
        InBytes=outByteLen,
        InElapsedMs=outElapsedMs,
    )
    return {
        "ok": True,
        "path": outRelPath,
        "content": outContent,
    }


def WriteFileTool(InPath: str, InContent: str, InWorkspaceRoot: str | None = None) -> dict[str, Any]:
    outStart = perf_counter()
    if InContent is None:
        raise HTTPException(status_code=400, detail="InContent is required.")

    outEffective = ResolveEffectiveWorkspaceRoot(InWorkspaceRoot)
    outPath = ResolvePathWithinSandbox(InPath, outEffective)
    outPath.parent.mkdir(parents=True, exist_ok=True)
    outPath.write_text(InContent, encoding="utf-8")
    try:
        outRelPath = str(outPath.relative_to(outEffective))
    except ValueError:
        outRelPath = str(outPath.relative_to(GetHostSandboxRoot()))
    outByteLen = len(InContent.encode("utf-8"))
    outElapsedMs = int((perf_counter() - outStart) * 1000)
    LogEvent(
        "write_file.success",
        InPath=str(outPath),
        InRelativePath=outRelPath,
        InBytes=outByteLen,
        InElapsedMs=outElapsedMs,
    )

    return {
        "ok": True,
        "path": outRelPath,
        "bytes": outByteLen,
    }


def ExecuteCliTool(
    InCommand: str,
    InWorkingDirectory: str | None = None,
    InTimeoutSec: int = 30,
    InWorkspaceRoot: str | None = None,
) -> dict[str, Any]:
    outStart = perf_counter()
    if InCommand is None:
        raise HTTPException(status_code=400, detail="InCommand is required.")
    if not InCommand.strip():
        raise HTTPException(status_code=400, detail="InCommand cannot be empty.")
    if InTimeoutSec is None:
        raise HTTPException(status_code=400, detail="InTimeoutSec is required.")
    if InTimeoutSec <= 0:
        raise HTTPException(status_code=400, detail="InTimeoutSec must be greater than zero.")

    outEffective = ResolveEffectiveWorkspaceRoot(InWorkspaceRoot)
    outWorkingPath = outEffective
    if InWorkingDirectory is not None:
        if not InWorkingDirectory.strip():
            raise HTTPException(status_code=400, detail="InWorkingDirectory cannot be empty when provided.")
        outWorkingPath = ResolvePathWithinSandbox(InWorkingDirectory, outEffective)
        if not outWorkingPath.exists() or not outWorkingPath.is_dir():
            raise HTTPException(status_code=400, detail="InWorkingDirectory must be an existing directory.")

    try:
        outResult = subprocess.run(
            InCommand,
            cwd=str(outWorkingPath),
            shell=True,
            capture_output=True,
            text=True,
            encoding="utf-8",
            timeout=InTimeoutSec,
        )
        outElapsedMs = int((perf_counter() - outStart) * 1000)
        outSandbox = GetHostSandboxRoot()
        outWorkingDir = (
            str(outWorkingPath.relative_to(outSandbox)) if outWorkingPath != outSandbox else "."
        )
        LogEvent(
            "execute_cli.success",
            InCommand=InCommand,
            InWorkingDirectory=outWorkingDir,
            InTimeoutSec=InTimeoutSec,
            InElapsedMs=outElapsedMs,
            InExitCode=outResult.returncode,
            InStdoutBytes=len((outResult.stdout or "").encode("utf-8")),
            InStderrBytes=len((outResult.stderr or "").encode("utf-8")),
        )
        return {
            "ok": True,
            "workingDirectory": outWorkingDir,
            "exitCode": outResult.returncode,
            "stdout": outResult.stdout,
            "stderr": outResult.stderr,
        }
    except subprocess.TimeoutExpired as outEx:
        outElapsedMs = int((perf_counter() - outStart) * 1000)
        outSandbox = GetHostSandboxRoot()
        outWorkingDir = (
            str(outWorkingPath.relative_to(outSandbox)) if outWorkingPath != outSandbox else "."
        )
        LogEvent(
            "execute_cli.timeout",
            InCommand=InCommand,
            InWorkingDirectory=outWorkingDir,
            InTimeoutSec=InTimeoutSec,
            InElapsedMs=outElapsedMs,
            InStdoutBytes=len((outEx.stdout or "").encode("utf-8")),
            InStderrBytes=len((outEx.stderr or "").encode("utf-8")),
        )
        return {
            "ok": False,
            "workingDirectory": outWorkingDir,
            "exitCode": None,
            "stdout": outEx.stdout or "",
            "stderr": outEx.stderr or "",
            "error": f"Command timed out after {InTimeoutSec} seconds.",
        }


@app.get("/tools")
def GetTools() -> dict[str, Any]:
    LogEvent("tools.list")
    return {
        "tools": [
            {
                "type": "function",
                "function": {
                    "name": "read_file",
                    "description": "Send local file content to AI context (UTF-8 text file). Optional InWorkspaceRoot sets the project root for relative InPath; it must stay inside the host sandbox (DAACS_TOOL_SERVER_WORKSPACE or tool server directory). Omit InWorkspaceRoot to use that sandbox root.",
                    "parameters": {
                        "type": "object",
                        "properties": {
                            "InWorkspaceRoot": {
                                "type": "string",
                                "description": "Optional directory (absolute or relative to sandbox root). Relative InPath joins this directory.",
                            },
                            "InPath": {
                                "type": "string",
                                "description": "Absolute path inside the sandbox, or path relative to InWorkspaceRoot when set, else relative to sandbox root.",
                            },
                        },
                        "required": ["InPath"],
                    },
                },
            },
            {
                "type": "function",
                "function": {
                    "name": "write_file",
                    "description": "Receive AI-generated content and save it to local file (UTF-8 text file). Optional InWorkspaceRoot sets the project root for relative InPath; must remain inside the host sandbox.",
                    "parameters": {
                        "type": "object",
                        "properties": {
                            "InWorkspaceRoot": {
                                "type": "string",
                                "description": "Optional directory (absolute or relative to sandbox root). Relative InPath joins this directory.",
                            },
                            "InPath": {
                                "type": "string",
                                "description": "Absolute path inside the sandbox, or path relative to InWorkspaceRoot when set, else relative to sandbox root.",
                            },
                            "InContent": {"type": "string"},
                        },
                        "required": ["InPath", "InContent"],
                    },
                },
            },
            {
                "type": "function",
                "function": {
                    "name": "execute_cli",
                    "description": "Execute a CLI command. Default cwd is the sandbox root unless InWorkspaceRoot sets a project directory inside the sandbox.",
                    "parameters": {
                        "type": "object",
                        "properties": {
                            "InCommand": {"type": "string"},
                            "InWorkspaceRoot": {
                                "type": "string",
                                "description": "Optional project directory inside the sandbox; default cwd when InWorkingDirectory is omitted. Relative InWorkingDirectory resolves under this directory.",
                            },
                            "InWorkingDirectory": {
                                "type": "string",
                                "description": "Optional directory for cwd; relative to InWorkspaceRoot if set else sandbox root, unless absolute inside sandbox.",
                            },
                            "InTimeoutSec": {"type": "integer", "minimum": 1, "default": 30},
                        },
                        "required": ["InCommand"],
                    },
                },
            },
        ]
    }


@app.post("/tool-call")
def CallTool(InRequest: ToolCallRequest) -> dict[str, Any]:
    outStart = perf_counter()
    InArguments = InRequest.InArguments or {}
    LogEvent(
        "tool_call.request",
        InToolName=InRequest.InToolName,
        InArgumentKeys=sorted(list(InArguments.keys())),
    )

    try:
        if InRequest.InToolName == "read_file":
            InPath = InArguments.get("InPath")
            InWorkspaceRoot = InArguments.get("InWorkspaceRoot")
            if InPath is None:
                raise HTTPException(status_code=400, detail="InPath is required.")
            if InWorkspaceRoot is not None and not isinstance(InWorkspaceRoot, str):
                raise HTTPException(status_code=400, detail="InWorkspaceRoot must be a string.")
            outResult = ReadFileTool(InPath=InPath, InWorkspaceRoot=InWorkspaceRoot)
            LogEvent(
                "tool_call.response",
                InToolName=InRequest.InToolName,
                InOk=bool(outResult.get("ok", False)),
                InElapsedMs=int((perf_counter() - outStart) * 1000),
            )
            return outResult

        if InRequest.InToolName == "write_file":
            InPath = InArguments.get("InPath")
            InContent = InArguments.get("InContent")
            InWorkspaceRoot = InArguments.get("InWorkspaceRoot")
            if InPath is None or InContent is None:
                raise HTTPException(status_code=400, detail="InPath and InContent are required.")
            if InWorkspaceRoot is not None and not isinstance(InWorkspaceRoot, str):
                raise HTTPException(status_code=400, detail="InWorkspaceRoot must be a string.")
            outResult = WriteFileTool(InPath=InPath, InContent=InContent, InWorkspaceRoot=InWorkspaceRoot)
            LogEvent(
                "tool_call.response",
                InToolName=InRequest.InToolName,
                InOk=bool(outResult.get("ok", False)),
                InElapsedMs=int((perf_counter() - outStart) * 1000),
            )
            return outResult

        if InRequest.InToolName == "execute_cli":
            InCommand = InArguments.get("InCommand")
            InWorkingDirectory = InArguments.get("InWorkingDirectory")
            InWorkspaceRoot = InArguments.get("InWorkspaceRoot")
            InTimeoutSec = InArguments.get("InTimeoutSec", 30)
            if InCommand is None:
                raise HTTPException(status_code=400, detail="InCommand is required.")
            if InWorkingDirectory is not None and not isinstance(InWorkingDirectory, str):
                raise HTTPException(status_code=400, detail="InWorkingDirectory must be a string.")
            if InWorkspaceRoot is not None and not isinstance(InWorkspaceRoot, str):
                raise HTTPException(status_code=400, detail="InWorkspaceRoot must be a string.")
            if not isinstance(InTimeoutSec, int):
                raise HTTPException(status_code=400, detail="InTimeoutSec must be an integer.")
            outResult = ExecuteCliTool(
                InCommand=InCommand,
                InWorkingDirectory=InWorkingDirectory,
                InTimeoutSec=InTimeoutSec,
                InWorkspaceRoot=InWorkspaceRoot,
            )
            LogEvent(
                "tool_call.response",
                InToolName=InRequest.InToolName,
                InOk=bool(outResult.get("ok", False)),
                InElapsedMs=int((perf_counter() - outStart) * 1000),
            )
            return outResult

        raise HTTPException(status_code=400, detail=f"Unknown tool: {InRequest.InToolName}")
    except HTTPException as outEx:
        LogEvent(
            "tool_call.error",
            InToolName=InRequest.InToolName,
            InStatusCode=outEx.status_code,
            InDetail=str(outEx.detail),
            InElapsedMs=int((perf_counter() - outStart) * 1000),
        )
        raise
