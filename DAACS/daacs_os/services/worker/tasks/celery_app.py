"""
DAACS OS — Celery Application Configuration
비동기 태스크 큐 (Redis 브로커)

docker-compose.yml 기준:
  - Broker:  redis://redis:6379/0
  - Backend: redis://redis:6379/1

태스크 종류:
  1. sandbox_execute — Docker 샌드박스 코드 실행
  2. workflow_step   — 워크플로 단계 비동기 실행
  3. llm_call        — LLM API 호출 (비용 추적 포함)
"""
import logging
import os
from datetime import timedelta

from celery import Celery

logger = logging.getLogger("daacs.worker")

# ─── Celery 인스턴스 ───

REDIS_HOST = os.getenv("REDIS_HOST", "redis")
REDIS_PORT = os.getenv("REDIS_PORT", "6379")

BROKER_URL = os.getenv("CELERY_BROKER_URL", f"redis://{REDIS_HOST}:{REDIS_PORT}/0")
RESULT_BACKEND = os.getenv("CELERY_RESULT_BACKEND", f"redis://{REDIS_HOST}:{REDIS_PORT}/1")

app = Celery("daacs_worker")

app.conf.update(
    broker_url=BROKER_URL,
    result_backend=RESULT_BACKEND,

    # 직렬화
    task_serializer="json",
    result_serializer="json",
    accept_content=["json"],

    # 시간대
    timezone="Asia/Seoul",
    enable_utc=True,

    # 결과 보존
    result_expires=timedelta(hours=24),

    # 동시성
    worker_concurrency=4,
    worker_prefetch_multiplier=1,  # 공정한 분배

    # 태스크 라우팅
    task_routes={
        "daacs.worker.tasks.sandbox.*": {"queue": "sandbox"},
        "daacs.worker.tasks.workflow.*": {"queue": "workflow"},
        "daacs.worker.tasks.llm.*": {"queue": "llm"},
    },

    # 재시도 정책
    task_acks_late=True,
    task_reject_on_worker_lost=True,

    # 하트비트
    broker_heartbeat=10,
    broker_connection_retry_on_startup=True,
)


# ─── 태스크 정의 ───

@app.task(name="daacs.worker.tasks.sandbox.execute", bind=True, max_retries=2)
def sandbox_execute(self, code: str, language: str = "python",
                    project_id: str = "", agent_role: str = ""):
    """
    Docker 샌드박스 코드 실행 (동기 래퍼).
    SandboxManager는 async이므로 여기서 asyncio.run()으로 감싼다.
    """
    import asyncio
    from daacs.sandbox.manager import SandboxManager

    try:
        sm = SandboxManager()
        result = asyncio.run(sm.execute(
            code=code,
            language=language,
            project_id=project_id,
            agent_role=agent_role,
        ))
        return result.to_dict()
    except Exception as exc:
        logger.error(f"Sandbox task failed: {exc}")
        raise self.retry(exc=exc, countdown=5)


@app.task(name="daacs.worker.tasks.workflow.step", bind=True, max_retries=1)
def workflow_step(self, project_id: str, workflow_name: str,
                  step_index: int, step_data: dict):
    """
    워크플로 단계 비동기 실행.
    from → to 에이전트 메시지 전달 + 결과 기록.
    """
    logger.info(
        f"Workflow step: {workflow_name}[{step_index}] "
        f"{step_data.get('from')} → {step_data.get('to')}"
    )
    return {
        "project_id": project_id,
        "workflow_name": workflow_name,
        "step_index": step_index,
        "status": "completed",
        "result": f"Step {step_index} executed",
    }


@app.task(name="daacs.worker.tasks.workflow.run", bind=True, max_retries=3)
def workflow_run(
    self,
    project_id: str,
    goal: str,
    workflow_name: str = "feature_development",
    params: dict = None,
    run_id: str = "",
    config: dict = None,
    resume: bool = False,
):
    """
    전체 워크플로우 실행 (Celery worker에서 비동기 실행).
    WorkflowEngine.run()을 asyncio.run()으로 감싼다.
    """
    import asyncio
    from daacs.application.persistence_service import update_workflow_fields
    from daacs.llm.executor import LLMExecutor
    from daacs.safety.spend_cap import SpendCapGuard
    from daacs.safety.turn_limit import TurnLimitGuard
    from daacs.overnight.guards import OvernightBudgetGuard
    from daacs.graph.engine import WorkflowEngine

    logger.info(f"Workflow run: project={project_id}, goal={goal[:80]}")

    try:
        overnight_mode = bool((params or {}).get("overnight_mode"))
        if overnight_mode and run_id:
            budget = float((config or {}).get("constraints", {}).get("max_spend_usd", 5.0))
            spend_guard = OvernightBudgetGuard(
                run_id=run_id,
                project_id=project_id,
                budget_usd=budget,
            )
        else:
            spend_guard = SpendCapGuard.from_config({"daily_spend_cap_usd": 1.00})
        turn_guard = TurnLimitGuard()
        executor = LLMExecutor(
            project_id=project_id,
            spend_guard=spend_guard,
            turn_guard=turn_guard,
        )
        engine = WorkflowEngine(
            project_id=project_id,
            llm_executor=executor,
        )
        if run_id:
            asyncio.run(update_workflow_fields(run_id, {"status": "running"}))
        result = asyncio.run(
            engine.run(
                goal=goal,
                workflow_name=workflow_name,
                params=params or {},
                config=config or {},
                resume=bool(resume),
            )
        )
        if run_id:
            spent = 0.0
            if overnight_mode:
                spent = asyncio.run(spend_guard.spent_so_far())
            asyncio.run(
                update_workflow_fields(
                    run_id,
                    {
                        "status": str(result.get("final_status", "completed")),
                        "spent_usd": spent,
                        "overnight_config": {
                            **(config or {}),
                            "gate_results": result.get("gate_results", []),
                        },
                    },
                )
            )
        return result
    except Exception as exc:
        logger.error(f"Workflow run failed: {exc}")
        if run_id:
            asyncio.run(update_workflow_fields(run_id, {"status": "error"}))
        raise self.retry(exc=exc, countdown=10)


@app.task(name="daacs.worker.tasks.llm.call", bind=True, max_retries=3)
def llm_call(self, prompt: str, model: str = "gemini-2.0-flash",
             agent_role: str = "", task_id: str = "",
             project_id: str = ""):
    """
    LLM API 호출 태스크.
    LLMExecutor를 통해 실제 LLM 호출 수행.
    """
    import asyncio
    from daacs.llm.executor import LLMExecutor
    from daacs.safety.spend_cap import SpendCapGuard

    logger.info(f"LLM call: model={model}, role={agent_role}, task={task_id}")

    try:
        spend_guard = SpendCapGuard.from_config({"daily_spend_cap_usd": 1.00})
        executor = LLMExecutor(
            project_id=project_id,
            spend_guard=spend_guard,
        )
        response = asyncio.run(executor.execute(
            role=agent_role or "developer",
            prompt=prompt,
        ))
        stats = executor.get_stats()
        return {
            "project_id": project_id,
            "agent_role": agent_role,
            "task_id": task_id,
            "model": model,
            "response": response,
            "total_tokens": stats.get("total_tokens", 0),
        }
    except Exception as exc:
        logger.error(f"LLM call failed: {exc}")
        raise self.retry(exc=exc, countdown=5)
