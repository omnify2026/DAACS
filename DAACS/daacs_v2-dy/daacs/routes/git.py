from typing import Optional

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel

from ..git_operations import GitWorkflowManager
from ..server_context import ServerContext


class GitBranchRequest(BaseModel):
    """브랜치 생성 요청"""
    name: str
    base_branch: Optional[str] = None


class GitCommitRequest(BaseModel):
    """커밋 요청"""
    message: Optional[str] = None
    auto_message: bool = True
    push: bool = False


def init_git_routes(ctx: ServerContext) -> APIRouter:
    router = APIRouter()

    @router.get("/api/projects/{project_id}/git/analyze")
    async def analyze_git_repository(project_id: str):
        """
        프로젝트 Git 저장소 분석

        Returns:
            - repo_url: 원격 저장소 URL
            - current_branch: 현재 브랜치
            - branches: 브랜치 목록
            - recent_commits: 최근 커밋
            - tech_stack: 기술 스택
            - contributors: 기여자 목록
        """
        _ = ctx.get_project_or_404(project_id)

        workdir = str(ctx.get_project_workdir(project_id))
        manager_git = GitWorkflowManager(workdir)

        if not manager_git.is_git_repo():
            raise HTTPException(status_code=400, detail="Not a Git repository")

        analysis = manager_git.analyze_repository()
        return manager_git.to_dict(analysis)

    @router.get("/api/projects/{project_id}/git/branches")
    async def get_git_branches(project_id: str):
        """브랜치 목록 조회"""
        _ = ctx.get_project_or_404(project_id)

        workdir = str(ctx.get_project_workdir(project_id))
        manager_git = GitWorkflowManager(workdir)

        if not manager_git.is_git_repo():
            return {"branches": [], "current": ""}

        branches = manager_git._get_branches()
        current = manager_git.get_current_branch()

        return {
            "branches": [
                {
                    "name": b.name,
                    "is_current": b.is_current,
                    "is_remote": b.is_remote,
                    "last_commit": b.last_commit,
                }
                for b in branches
            ],
            "current": current,
        }

    @router.post("/api/projects/{project_id}/git/branches")
    async def create_git_branch(project_id: str, req: GitBranchRequest):
        """Feature 브랜치 생성"""
        _ = ctx.get_project_or_404(project_id)

        workdir = str(ctx.get_project_workdir(project_id))
        manager_git = GitWorkflowManager(workdir)

        if not manager_git.is_git_repo():
            raise HTTPException(status_code=400, detail="Not a Git repository")

        success, result = manager_git.create_feature_branch(req.name, req.base_branch)

        if not success:
            raise HTTPException(status_code=400, detail=result)

        await ctx.manager.broadcast_log(project_id, f"[GIT] Created branch: {result}", node="DAACS")
        return {"status": "created", "branch": result}

    @router.get("/api/projects/{project_id}/git/changes")
    async def get_git_changes(project_id: str, staged: bool = False):
        """변경 사항 조회"""
        _ = ctx.get_project_or_404(project_id)

        workdir = str(ctx.get_project_workdir(project_id))
        manager_git = GitWorkflowManager(workdir)

        if not manager_git.is_git_repo():
            return {"changes": []}

        changes = manager_git.get_changes(staged_only=staged)

        return {
            "changes": [
                {
                    "file": c.file_path,
                    "type": c.change_type,
                    "additions": c.additions,
                    "deletions": c.deletions,
                    "preview": c.content_preview,
                }
                for c in changes
            ],
            "total": len(changes),
        }

    @router.post("/api/projects/{project_id}/git/commit")
    async def create_git_commit(project_id: str, req: GitCommitRequest):
        """커밋 생성 (자동 메시지 생성 옵션)"""
        _ = ctx.get_project_or_404(project_id)

        workdir = str(ctx.get_project_workdir(project_id))
        manager_git = GitWorkflowManager(workdir)

        if not manager_git.is_git_repo():
            raise HTTPException(status_code=400, detail="Not a Git repository")

        # Stage all files
        success, msg = manager_git.stage_files()
        if not success:
            raise HTTPException(status_code=400, detail=msg)

        # Commit
        success, commit_msg = manager_git.commit(req.message, auto_message=req.auto_message)
        if not success:
            raise HTTPException(status_code=400, detail=commit_msg)

        result = {"status": "committed", "message": commit_msg}

        # Push if requested
        if req.push and "Nothing to commit" not in commit_msg:
            success, push_msg = manager_git.push_branch()
            result["push"] = {"success": success, "message": push_msg}

        await ctx.manager.broadcast_log(project_id, f"[GIT] {commit_msg}", node="DAACS")
        return result

    @router.post("/api/projects/{project_id}/git/push")
    async def push_git_branch(project_id: str):
        """현재 브랜치 푸시"""
        _ = ctx.get_project_or_404(project_id)

        workdir = str(ctx.get_project_workdir(project_id))
        manager_git = GitWorkflowManager(workdir)

        if not manager_git.is_git_repo():
            raise HTTPException(status_code=400, detail="Not a Git repository")

        success, msg = manager_git.push_branch()

        if not success:
            raise HTTPException(status_code=400, detail=msg)

        await ctx.manager.broadcast_log(project_id, f"[GIT] {msg}", node="DAACS")
        return {"status": "pushed", "message": msg}

    @router.get("/api/projects/{project_id}/git/pr-draft")
    async def get_pr_draft(project_id: str):
        """PR 초안 생성"""
        _ = ctx.get_project_or_404(project_id)

        workdir = str(ctx.get_project_workdir(project_id))
        manager_git = GitWorkflowManager(workdir)

        if not manager_git.is_git_repo():
            raise HTTPException(status_code=400, detail="Not a Git repository")

        pr = manager_git.generate_pr_draft()

        return {
            "title": pr.title,
            "body": pr.body,
            "base_branch": pr.base_branch,
            "head_branch": pr.head_branch,
            "labels": pr.labels,
            "reviewers": pr.reviewers,
        }

    @router.post("/api/projects/{project_id}/git/quick-commit")
    async def quick_commit_and_push(project_id: str, message: Optional[str] = None):
        """빠른 커밋 및 푸시 (stage → commit → push)"""
        _ = ctx.get_project_or_404(project_id)

        workdir = str(ctx.get_project_workdir(project_id))
        manager_git = GitWorkflowManager(workdir)

        if not manager_git.is_git_repo():
            raise HTTPException(status_code=400, detail="Not a Git repository")

        result = manager_git.quick_commit_and_push(message)

        if result["commit"]["success"]:
            await ctx.manager.broadcast_log(project_id, f"[GIT] Quick commit: {result['commit']['message']}", node="DAACS")

        return result

    return router
