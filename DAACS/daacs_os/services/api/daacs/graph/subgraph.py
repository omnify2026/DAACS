"""
DAACS OS — Subgraph Builder
Backend/Frontend 병렬 실행을 위한 서브그래프 빌더.

Source: DAACS_v2-dy/daacs/graph/subgraph_builder.py
Adapted: ThreadPoolExecutor → asyncio.gather, DAACS_OS SharedWorkspace 연동.
"""
import asyncio
import logging
from typing import Any, Dict, List, Optional, Tuple

logger = logging.getLogger("daacs.graph.subgraph")


async def run_parallel_execution(
    state: Dict[str, Any],
    executor,
    manager,
    backend_fn=None,
    frontend_fn=None,
) -> Dict[str, Any]:
    """
    Backend/Frontend 서브그래프를 병렬 실행.

    execution 설정의 parallel_execution이 True면 동시 실행,
    False면 순차 실행.

    Args:
        state: 워크플로우 상태
        executor: LLMExecutor
        manager: AgentManager
        backend_fn: backend 실행 노드 함수
        frontend_fn: frontend 실행 노드 함수

    Returns:
        병합된 상태 업데이트
    """
    needs_backend = state.get("needs_backend", True)
    needs_frontend = state.get("needs_frontend", True)

    tasks = []
    task_names = []

    if needs_backend and backend_fn:
        tasks.append(backend_fn(state=state, executor=executor, manager=manager))
        task_names.append("backend")

    if needs_frontend and frontend_fn:
        tasks.append(frontend_fn(state=state, executor=executor, manager=manager))
        task_names.append("frontend")

    if not tasks:
        logger.info("[Subgraph] No subgraphs to execute")
        return {}

    logger.info(f"[Subgraph] Running parallel: {task_names}")

    # 병렬 실행 (에러 하나가 나도 나머지는 계속)
    results = await asyncio.gather(*tasks, return_exceptions=True)

    # 결과 병합
    merged: Dict[str, Any] = {}
    for name, result in zip(task_names, results):
        if isinstance(result, Exception):
            logger.error(f"[Subgraph] {name} failed: {result}")
            merged[f"{name}_status"] = "failed"
            merged.setdefault("failure_summary", []).append(f"{name}_error: {str(result)[:200]}")
        elif isinstance(result, dict):
            merged.update(result)
        else:
            logger.warning(f"[Subgraph] {name} returned unexpected type: {type(result)}")

    return merged


def parse_file_output(llm_response: str) -> Dict[str, str]:
    """
    LLM 응답에서 파일 컨텐츠를 파싱.

    Expected format:
        FILE: path/to/file.py
        ```python
        code content
        ```

        FILE: path/to/other.js
        ```javascript
        more code
        ```

    Returns:
        {file_path: code_content} dict
    """
    files: Dict[str, str] = {}
    current_file: Optional[str] = None
    current_code: List[str] = []
    in_code_block = False

    for line in llm_response.split("\n"):
        stripped = line.strip()

        # File marker
        if stripped.startswith("FILE:"):
            # Save previous file
            if current_file and current_code:
                files[current_file] = "\n".join(current_code).strip()
            current_file = stripped[5:].strip()
            current_code = []
            in_code_block = False
            continue

        # Code block markers
        if stripped.startswith("```") and not in_code_block:
            in_code_block = True
            continue
        if stripped == "```" and in_code_block:
            in_code_block = False
            continue

        # Accumulate code
        if in_code_block and current_file:
            current_code.append(line)

    # Save last file
    if current_file and current_code:
        files[current_file] = "\n".join(current_code).strip()

    return files
