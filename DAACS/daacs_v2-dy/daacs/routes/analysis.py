import asyncio
import os
from typing import List

from fastapi import APIRouter, HTTPException

from ..project_analysis import ProjectAnalyzer
from ..utils import setup_logger
from ..graph.enhanced_verification import EnhancedVerificationTemplates
from ..release_gate import compute_release_gate
from ..server_context import ServerContext

logger = setup_logger("AnalysisRoutes")


def init_analysis_routes(ctx: ServerContext) -> APIRouter:
    router = APIRouter()

    def _collect_code_files(workdir: str, max_files: int = 20) -> List[str]:
        files = []
        for root, dirs, filenames in os.walk(workdir):
            dirs[:] = [d for d in dirs if d not in ["node_modules", ".git", "__pycache__", "venv"]]
            for name in filenames:
                if name.endswith((".py", ".js", ".jsx", ".ts", ".tsx", ".html")):
                    files.append(os.path.join(root, name))
                    if len(files) >= max_files:
                        return files
        return files

    @router.post("/api/projects/{project_id}/analyze")
    async def analyze_project(project_id: str):
        """
        프로젝트 심층 분석 (Phase 8.1)

        Returns:
            - project_type: 프로젝트 타입 (python, node, hybrid)
            - metrics: 코드 메트릭 (복잡도, 라인 수 등)
            - functions: 함수 목록
            - classes: 클래스 목록
            - dependencies: 의존성 목록
            - issues: 발견된 이슈
        """
        _ = ctx.get_project_or_404(project_id)

        workdir = str(ctx.get_project_workdir(project_id))

        try:
            analyzer = ProjectAnalyzer(workdir)
            analysis = analyzer.analyze()

            await ctx.manager.broadcast_log(
                project_id,
                f"[ANALYSIS] Completed: {analysis.summary}",
                node="DAACS",
            )

            return analyzer.to_dict()

        except Exception as e:
            logger.error("Project analysis failed: %s", e)
            raise HTTPException(status_code=500, detail=f"Analysis failed: {str(e)}")

    @router.get("/api/projects/{project_id}/suggest-improvements")
    async def suggest_improvements(project_id: str):
        """
        프로젝트 개선점 제안 (Phase 8.1)

        Returns:
            - suggestions: 개선점 목록 (카테고리, 우선순위, 설명, 액션)
        """
        _ = ctx.get_project_or_404(project_id)

        workdir = str(ctx.get_project_workdir(project_id))

        try:
            analyzer = ProjectAnalyzer(workdir)
            analyzer.analyze()
            suggestions = analyzer.suggest_improvements()

            return {
                "suggestions": suggestions,
                "total": len(suggestions),
                "high_priority": len([s for s in suggestions if s.get("priority") == "high"]),
            }

        except Exception as e:
            logger.error("Suggest improvements failed: %s", e)
            raise HTTPException(status_code=500, detail=f"Failed: {str(e)}")

    @router.post("/api/projects/{project_id}/semantic-check")
    async def semantic_consistency_check(project_id: str):
        """
        의미적 일관성 검증 (Phase 7.3)
        - 코드가 목표와 일치하는지 확인
        - 기본 템플릿/스캐폴드 감지
        - TODO/FIXME 감지
        """
        p_info = ctx.get_project_or_404(project_id)
        with ctx.locked_project(p_info):
            goal = p_info.get("goal", "")
        workdir = str(ctx.get_project_workdir(project_id))

        # 파일 수집
        files = _collect_code_files(workdir)

        try:
            result = EnhancedVerificationTemplates.semantic_consistency(
                goal=goal,
                files=files[:20],  # 최대 20개 파일
            )

            await ctx.manager.broadcast_log(
                project_id,
                f"[SEMANTIC] Check: {result.get('reason')}",
                node="DAACS",
            )

            return result

        except Exception as e:
            logger.error("Semantic check failed: %s", e)
            raise HTTPException(status_code=500, detail=f"Check failed: {str(e)}")

    @router.post("/api/projects/{project_id}/runtime-test")
    async def runtime_test(project_id: str, test_type: str = "backend"):
        """
        런타임 테스트 (Phase 7.3)
        - backend: 서버 시작 및 헬스체크
        - frontend: npm install 및 TypeScript 체크
        """
        _ = ctx.get_project_or_404(project_id)

        workdir = str(ctx.get_project_workdir(project_id))

        try:
            if test_type == "backend":
                result = await asyncio.to_thread(
                    EnhancedVerificationTemplates.runtime_test_backend,
                    workdir,
                )
            elif test_type == "frontend":
                result = await asyncio.to_thread(
                    EnhancedVerificationTemplates.runtime_test_frontend,
                    workdir,
                )
            else:
                raise HTTPException(status_code=400, detail="Invalid test_type. Use 'backend' or 'frontend'")

            await ctx.manager.broadcast_log(
                project_id,
                f"[RUNTIME] {test_type} test: {'PASSED' if result.get('ok') else 'FAILED'}",
                node="DAACS",
            )

            return result

        except Exception as e:
            logger.error("Runtime test failed: %s", e)
            raise HTTPException(status_code=500, detail=f"Test failed: {str(e)}")

    @router.get("/api/projects/{project_id}/performance-baseline")
    async def performance_baseline(project_id: str):
        """
        성능 기준 확인 (Phase 7.3)
        - 의존성 수
        - 소스 코드 크기
        - 파일 수
        """
        _ = ctx.get_project_or_404(project_id)

        workdir = str(ctx.get_project_workdir(project_id))

        try:
            result = EnhancedVerificationTemplates.performance_baseline(workdir)

            return result

        except Exception as e:
            logger.error("Performance baseline failed: %s", e)
            raise HTTPException(status_code=500, detail=f"Check failed: {str(e)}")

    @router.post("/api/projects/{project_id}/release-gate")
    async def release_gate(project_id: str, scaffold_e2e: bool = False):
        """
        Release Gate 자동 점검 (부분 자동화)
        - API spec 유효성 (full-stack일 때 강제)
        - Semantic consistency
        - Runtime backend/frontend
        - Performance baseline
        """
        p_info = ctx.get_project_or_404(project_id)
        with ctx.locked_project(p_info):
            goal = p_info.get("goal", "")
            api_spec = p_info.get("api_spec", {}) or {}
            needs_backend = bool(p_info.get("needs_backend", True))
            needs_frontend = bool(p_info.get("needs_frontend", True))

        workdir = str(ctx.get_project_workdir(project_id))
        release_gate_summary = await asyncio.to_thread(
            compute_release_gate,
            goal,
            api_spec,
            needs_backend,
            needs_frontend,
            workdir,
            scaffold_e2e,
        )
        with ctx.locked_project(p_info):
            p_info["release_gate"] = release_gate_summary
        ctx.save_project_state(project_id)

        await ctx.manager.broadcast_log(
            project_id,
            f"[RELEASE_GATE] status={release_gate_summary.get('status')} fullstack={release_gate_summary.get('fullstack_required')}",
            node="DAACS",
        )

        return release_gate_summary

    return router
