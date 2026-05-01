"""
피드백 API 라우트
빌드 완료 후 사용자 피드백을 받아 분석하고 refine/complete 결정
"""
import asyncio
from fastapi import APIRouter, HTTPException
from pydantic import BaseModel, Field

from ..server_context import ServerContext
from ..orchestrator_agent import OrchestratorAgent


class FeedbackRequest(BaseModel):
    """피드백 요청"""
    feedback: str = Field(..., max_length=10000)


def init_feedback_routes(ctx: ServerContext) -> APIRouter:
    router = APIRouter()

    @router.post("/api/projects/{project_id}/feedback")
    async def submit_feedback(project_id: str, req: FeedbackRequest):
        """
        사용자 피드백을 분석하여 다음 단계 결정
        Returns: {"action": "refine", "new_goal": "..."} 또는 {"action": "complete"}
        """
        p_info = ctx.get_project_or_404(project_id)
        
        with ctx.locked_project(p_info):
            goal = p_info.get("goal", "")
            status = p_info.get("status", "")
        
        # 빌드 완료 상태가 아니면 에러
        if status not in ("completed", "completed_with_warnings", "failed", "stopped"):
            raise HTTPException(
                status_code=400, 
                detail=f"피드백은 빌드 완료 후에만 가능합니다. 현재 상태: {status}"
            )
        
        # 히스토리 요약 생성
        with ctx.locked_project(p_info):
            iteration = p_info.get("iteration", 0)
            stop_reason = p_info.get("stop_reason", "")
        
        history_summary = f"Goal: {goal}, Iterations: {iteration}, Status: {status}"
        if stop_reason:
            history_summary += f", StopReason: {stop_reason}"
        
        # OrchestratorAgent를 사용하여 피드백 분석
        try:
            agent = OrchestratorAgent(workdir=p_info.get("workdir", "."))
            analysis = await asyncio.to_thread(
                agent.analyze_feedback, 
                req.feedback, 
                history_summary
            )
            
            # refine인 경우 새 목표로 재실행 시작
            if analysis.get("action") == "refine":
                new_goal = analysis.get("new_goal", goal)
                with ctx.locked_project(p_info):
                    p_info["goal"] = new_goal
                    p_info["status"] = "created"  # 다시 시작 가능하도록
                ctx.save_project_state(project_id)
                
                return {
                    "action": "refine",
                    "new_goal": new_goal,
                    "message": "목표가 업데이트되었습니다. 'Run' 버튼을 눌러 다시 빌드하세요."
                }
            
            return {
                "action": "complete",
                "message": "피드백 분석 결과 작업이 완료되었습니다."
            }
            
        except Exception as e:
            ctx.logger.error(f"Feedback analysis failed: {e}")
            raise HTTPException(status_code=500, detail=f"피드백 분석 실패: {e}")

    return router
