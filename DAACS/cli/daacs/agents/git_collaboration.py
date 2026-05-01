"""
DAACS v2.1 - Git Collaboration System
에이전트 간 Git 기반 협업 시스템

핵심 아이디어:
- 에이전트가 코드 작성 → git commit → 커밋 ID 전달
- Reviewer가 커밋 확인 → git diff → 피드백
- Developer가 수정 → 새 커밋    
- 모든 협업 내역이 Git 히스토리로 남음
"""

import os
import subprocess
from typing import Dict, List, Optional, Tuple
from dataclasses import dataclass
from datetime import datetime

import logging

logger = logging.getLogger("GitCollaboration")


@dataclass
class CommitInfo:
    """커밋 정보"""
    commit_id: str
    author: str
    message: str
    timestamp: str
    files_changed: List[str]


class GitCollaborator:
    """
    에이전트 간 Git 기반 협업 관리자
    
    각 프로젝트는 독립적인 Git 저장소로 초기화되며,
    에이전트들의 모든 작업이 커밋으로 기록됩니다.
    """
    
    def __init__(self, repo_path: str):
        """
        Args:
            repo_path: Git 저장소 경로 (프로젝트 디렉토리)
        """
        self.repo_path = os.path.abspath(repo_path)
        self.is_initialized = False
        self.commit_history: List[CommitInfo] = []
        
    def _run_git(self, *args, check: bool = True) -> Tuple[int, str, str]:
        """
        Git 명령 실행
        
        Returns:
            (return_code, stdout, stderr)
        """
        cmd = ["git"] + list(args)
        
        try:
            result = subprocess.run(
                cmd,
                cwd=self.repo_path,
                capture_output=True,
                text=True,
                encoding='utf-8',
                errors='ignore',
                timeout=30
            )
            
            if check and result.returncode != 0:
                logger.warning(f"[Git] Command failed: {' '.join(cmd)}")
                logger.warning(f"[Git] stderr: {result.stderr[:200]}")
            
            return result.returncode, result.stdout.strip(), result.stderr.strip()
            
        except subprocess.TimeoutExpired:
            logger.error(f"[Git] Command timeout: {' '.join(cmd)}")
            return -1, "", "Timeout"
        except Exception as e:
            logger.error(f"[Git] Exception: {e}")
            return -1, "", str(e)
    
    def init_repo(self) -> bool:
        """
        Git 저장소 초기화
        
        Returns:
            성공 여부
        """
        # 디렉토리 생성
        os.makedirs(self.repo_path, exist_ok=True)
        
        # 이미 Git repo인지 확인
        git_dir = os.path.join(self.repo_path, ".git")
        if os.path.exists(git_dir):
            logger.info(f"[Git] Repository already exists at {self.repo_path}")
            self.is_initialized = True
            return True
        
        # git init
        code, out, err = self._run_git("init")
        if code != 0:
            logger.error(f"[Git] Failed to init: {err}")
            return False
        
        # 기본 설정
        self._run_git("config", "user.email", "daacs@ai-agents.dev")
        self._run_git("config", "user.name", "DAACS AI Team")
        # 🆕 Windows CRLF 문제 방지
        self._run_git("config", "core.autocrlf", "false")
        self._run_git("config", "core.safecrlf", "false")
        
        # .gitignore 생성
        gitignore_path = os.path.join(self.repo_path, ".gitignore")
        gitignore_content = """# DAACS Generated Project
__pycache__/
*.pyc
.venv/
venv/
node_modules/
.env
*.log
.DS_Store
"""
        with open(gitignore_path, 'w', encoding='utf-8') as f:
            f.write(gitignore_content)
        
        # 초기 커밋
        self._run_git("add", ".gitignore")
        self._run_git("commit", "-m", "[DAACS] Initialize project repository")
        
        self.is_initialized = True
        logger.info(f"[Git] ✅ Repository initialized at {self.repo_path}")
        
        return True
    
    def commit_work(self, agent_name: str, message: str) -> Optional[str]:
        """
        에이전트 작업 커밋
        
        Args:
            agent_name: 에이전트 이름 (예: "Backend Dev", "Architect")
            message: 커밋 메시지
            
        Returns:
            커밋 ID (SHA) 또는 None
        """
        if not self.is_initialized:
            self.init_repo()
        
        # Stage all changes
        self._run_git("add", "-A")
        
        # Check if there are changes to commit
        code, status, _ = self._run_git("status", "--porcelain")
        if not status:
            logger.info(f"[Git] No changes to commit for {agent_name}")
            # Return latest commit
            code, head, _ = self._run_git("rev-parse", "--short", "HEAD")
            return head if code == 0 else None
        
        # Commit with agent name in message
        full_message = f"[{agent_name}] {message}"
        code, out, err = self._run_git("commit", "-m", full_message)
        
        if code != 0:
            logger.error(f"[Git] Commit failed: {err}")
            return None
        
        # Get commit ID
        code, commit_id, _ = self._run_git("rev-parse", "--short", "HEAD")
        
        if code == 0:
            logger.info(f"[Git] ✅ Commit: {commit_id} by {agent_name}")
            print(f"  📝 Git Commit: {commit_id} [{agent_name}] {message[:50]}...")
            
            # 히스토리에 추가
            self.commit_history.append(CommitInfo(
                commit_id=commit_id,
                author=agent_name,
                message=message,
                timestamp=datetime.now().isoformat(),
                files_changed=status.split('\n') if status else []
            ))
            
            return commit_id
        
        return None
    
    def get_diff(self, from_commit: str = None, to_commit: str = "HEAD") -> str:
        """
        커밋 간 diff 확인
        
        Args:
            from_commit: 시작 커밋 (None이면 이전 커밋)
            to_commit: 끝 커밋 (기본: HEAD)
            
        Returns:
            diff 문자열
        """
        if from_commit:
            code, diff, _ = self._run_git("diff", f"{from_commit}..{to_commit}")
        else:
            code, diff, _ = self._run_git("diff", "HEAD~1", to_commit)
        
        return diff if code == 0 else ""
    
    def get_files_at_commit(self, commit_id: str = "HEAD", patterns: List[str] = None) -> Dict[str, str]:
        """
        특정 커밋의 파일 내용
        
        Args:
            commit_id: 커밋 ID
            patterns: 파일 패턴 리스트 (예: ["*.py", "*.js"])
            
        Returns:
            {파일경로: 내용} 딕셔너리
        """
        files = {}
        
        # 1. 파일 목록 조회
        cmd = ["ls-tree", "-r", "--name-only", commit_id]
        code, stdout, stderr = self._run_git(*cmd)
        
        if code != 0:
            logger.error(f"Failed to list files at {commit_id}: {stderr}")
            return {}
            
        all_files = stdout.strip().split('\n')
        
        # 2. 패턴 필터링
        import fnmatch
        target_files = []
        
        if patterns:
            for f in all_files:
                if not f: continue
                # 하나라도 매칭되면 포함
                for p in patterns:
                    if fnmatch.fnmatch(f, p):
                        target_files.append(f)
                        break
        else:
            target_files = [f for f in all_files if f]
            
        # 3. 파일 내용 읽기
        for file_path in target_files:
            # 바이너리 파일 등 제외 (간단한 체크)
            if file_path.endswith(('.png', '.jpg', '.jpeg', '.gif', '.ico', '.pyc')):
                continue
                
            # git show commit_id:file_path
            show_cmd = ["show", f"{commit_id}:{file_path}"]
            code, content, _ = self._run_git(*show_cmd)
            
            if code == 0:
                files[file_path] = content
                
        return files
    
    def get_changed_files(self, commit_id: str = "HEAD") -> List[str]:
        """
        특정 커밋에서 변경된 파일 목록
        
        Args:
            commit_id: 커밋 ID
            
        Returns:
            변경된 파일 경로 리스트
        """
        code, output, _ = self._run_git("diff-tree", "--no-commit-id", "--name-only", "-r", commit_id)
        return output.split('\n') if code == 0 and output else []
    
    def checkout_commit(self, commit_id: str) -> bool:
        """
        특정 커밋으로 체크아웃 (롤백)
        
        Args:
            commit_id: 커밋 ID
            
        Returns:
            성공 여부
        """
        code, out, err = self._run_git("checkout", commit_id)
        if code == 0:
            logger.info(f"[Git] Checked out to {commit_id}")
            return True
        logger.error(f"[Git] Checkout failed: {err}")
        return False
    
    def get_log(self, n: int = 10) -> List[CommitInfo]:
        """
        커밋 로그 조회
        
        Args:
            n: 조회할 커밋 수
            
        Returns:
            CommitInfo 리스트
        """
        # --pretty=format: hash|author|message|date
        fmt = "%h|%an|%s|%ci"
        code, output, _ = self._run_git("log", f"-{n}", f"--pretty=format:{fmt}")
        
        if code != 0 or not output:
            return []
        
        commits = []
        for line in output.split('\n'):
            parts = line.split('|')
            if len(parts) >= 4:
                commits.append(CommitInfo(
                    commit_id=parts[0],
                    author=parts[1],
                    message=parts[2],
                    timestamp=parts[3],
                    files_changed=[]
                ))
        
        return commits
    
    def get_log_formatted(self, n: int = 10) -> str:
        """
        포맷된 커밋 로그
        
        Returns:
            예쁘게 포맷된 로그 문자열
        """
        commits = self.get_log(n)
        
        lines = [
            "=" * 50,
            "  📋 GIT COMMIT HISTORY",
            "=" * 50,
        ]
        
        for c in commits:
            # [Backend Dev]가 포함된 메시지에서 에이전트 추출
            if c.message.startswith("["):
                agent = c.message.split("]")[0] + "]"
                msg = c.message.split("]", 1)[1].strip() if "]" in c.message else c.message
            else:
                agent = "[DAACS]"
                msg = c.message
            
            lines.append(f"  {c.commit_id} {agent} {msg[:40]}")
        
        lines.append("=" * 50)
        
        return "\n".join(lines)
    
    def create_review_context(self, commit_id: str, previous_commit: str = None) -> str:
        """
        리뷰를 위한 컨텍스트 생성
        
        Args:
            commit_id: 리뷰할 커밋
            previous_commit: 이전 커밋 (diff 계산용)
            
        Returns:
            리뷰어에게 전달할 컨텍스트 문자열
        """
        # 변경된 파일
        changed_files = self.get_changed_files(commit_id)
        
        # Diff
        if previous_commit:
            diff = self.get_diff(previous_commit, commit_id)
        else:
            diff = self.get_diff(to_commit=commit_id)
        
        # 현재 파일 내용 (변경된 파일만)
        files = self.get_files_at_commit(commit_id)
        relevant_files = {k: v for k, v in files.items() if k in changed_files}
        
        context = f"""
=== COMMIT TO REVIEW: {commit_id} ===

CHANGED FILES:
{chr(10).join(['- ' + f for f in changed_files])}

=== DIFF ===
{diff[:3000]}...
(diff truncated if too long)

=== FULL FILE CONTENTS ===
"""
        
        for filepath, content in relevant_files.items():
            context += f"\n--- {filepath} ---\n{content[:2000]}\n"
        
        return context


# 🆕 CycleGuard Integration
try:
    from ..utils.cycle_guard import CycleGuard
    HAS_CYCLE_GUARD = True
except ImportError:
    HAS_CYCLE_GUARD = False


class GitBasedTeamLoop:
    """
    Git 기반 팀 협업 루프
    
    Developer와 Reviewer가 Git 커밋을 통해 실제로 협업
    """
    
    def __init__(self, git: GitCollaborator, max_rounds: int = 5):
        self.git = git
        self.max_rounds = max_rounds
        self.cycle_guard = CycleGuard() if HAS_CYCLE_GUARD else None
        
    def run(
        self,
        developer,  # DeveloperAgent
        reviewer,   # ReviewerAgent
        task: Dict,
        api_contract: Dict,
        rework_feedback: str = None  # 🆕 통합 리뷰 피드백 (리워크 모드)
    ) -> Dict:
        """
        Git 기반 개발-리뷰 루프 실행
        
        Args:
            rework_feedback: 통합 리뷰에서 전달된 피드백 (있으면 수정부터 시작)
        
        Returns:
            {
                "final_commit": str,
                "approved": bool,
                "rounds": int,
                "history": List[str]
            }
        """
        history = []
        previous_commit = None
        
        # 🆕 리워크 모드: 수정부터 시작
        if rework_feedback:
            logger.info(f"[{developer.role.value}] 🔄 REWORK MODE - fixing integration issues...")
            print(f"\n  🔄 [{developer.role.value}] REWORK MODE")
            commit_id = developer.fix_with_git(rework_feedback, self.git)
            history.append(f"[{developer.role.value}] Rework Fix: {commit_id}")
        else:
            # 일반 모드: 초기 구현
            logger.info(f"[{developer.role.value}] Starting implementation...")
            commit_id = developer.implement_with_git(task, api_contract, self.git)
            history.append(f"[{developer.role.value}] Initial: {commit_id}")
        print(f"\n  📝 [{developer.role.value}] Commit: {commit_id}")
        
        # 🆕 Initial Cycle Check
        if self.cycle_guard and commit_id:
            # Use git tree hash for more accurate state tracking (commit hash changes with message/time)
            code, tree_hash, _ = self.git._run_git("rev-parse", f"{commit_id}^{{tree}}")
            if code == 0 and self.cycle_guard.add_state(tree_hash):
                logger.warning("[GitLoop] Cycle detected at initial commit!")
        
        for round_num in range(1, self.max_rounds + 1):
            logger.info(f"[Review Round {round_num}]")
            
            # 리뷰 컨텍스트 생성
            review_context = self.git.create_review_context(commit_id, previous_commit)
            
            # 리뷰어가 커밋 리뷰 (Task Description 전달)
            task_desc = task.get("description", "")
            review_result = reviewer.review_with_git(commit_id, review_context, task_description=task_desc)
            history.append(f"[{reviewer.role.value}] Review: {review_result.feedback[:50]}...")
            
            if review_result.approved:
                print(f"  ✅ [{reviewer.role.value}] Approved!")
                history.append(f"[{reviewer.role.value}] ✅ APPROVED")
                
                return {
                    "final_commit": commit_id,
                    "approved": True,
                    "rounds": round_num,
                    "history": history
                }
            
            # 피드백 출력
            print(f"  ⚠️ [{reviewer.role.value}] Feedback: {review_result.feedback[:80]}...")
            
            # Developer가 피드백 반영
            previous_commit = commit_id
            new_commit_id = developer.fix_with_git(review_result.feedback, self.git)
            
            if not new_commit_id:
                logger.warning(f"[{developer.role.value}] No changes made or commit failed.")
                print(f"  🔧 [{developer.role.value}] No changes made (keeping previous commit).")
                commit_id = previous_commit
            else:
                commit_id = new_commit_id
                print(f"  🔧 [{developer.role.value}] Fixed: {commit_id}")
                
                # 🆕 Cycle Check
                if self.cycle_guard:
                    code, tree_hash, _ = self.git._run_git("rev-parse", f"{commit_id}^{{tree}}")
                    if code == 0 and self.cycle_guard.add_state(tree_hash):
                        logger.error("[GitLoop] Cycle detected! Stopping loop to prevent infinite recursion.")
                        print(f"  ⛔ [CycleGuard] Infinite loop detected. Stopping.")
                        history.append(f"[{developer.role.value}] ⛔ CYCLE DETECTED")
                        return {
                            "final_commit": commit_id,
                            "approved": False,
                            "rounds": round_num,
                            "history": history,
                            "error": "Cycle detected"
                        }
            
            history.append(f"[{developer.role.value}] Fix: {commit_id}")
        
        logger.warning(f"Max rounds ({self.max_rounds}) reached")
        return {
            "final_commit": commit_id,
            "approved": False,
            "rounds": self.max_rounds,
            "history": history
        }
