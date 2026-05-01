"""
DAACS Git Operations - Phase 8.2 고도화
Git 워크플로우 관리: 브랜치 분석, 자동 커밋, PR 생성 등

기능:
1. 저장소 분석 (브랜치, 커밋 히스토리, 기술 스택)
2. Feature 브랜치 자동 생성
3. AI 커밋 메시지 생성
4. PR 초안 자동 생성
5. 변경 영향 분석
"""

import os
import re
import json
import subprocess
from typing import Dict, Any, List, Optional, Tuple
from dataclasses import dataclass, field, asdict
from datetime import datetime
from pathlib import Path
from .utils import setup_logger
from .constants import GIT_TIMEOUT_SEC, GIT_NETWORK_TIMEOUT_SEC

logger = setup_logger("GitOperations")


@dataclass
class BranchInfo:
    """브랜치 정보"""
    name: str
    is_current: bool = False
    is_remote: bool = False
    last_commit: str = ""
    last_commit_date: str = ""


@dataclass
class CommitInfo:
    """커밋 정보"""
    hash: str
    short_hash: str
    author: str
    date: str
    message: str
    files_changed: int = 0


@dataclass
class RepoAnalysis:
    """저장소 분석 결과"""
    repo_url: str = ""
    default_branch: str = "main"
    current_branch: str = ""
    branches: List[BranchInfo] = field(default_factory=list)
    recent_commits: List[CommitInfo] = field(default_factory=list)
    tech_stack: Dict[str, Any] = field(default_factory=lambda: {"languages": [], "frameworks": [], "tools": []})
    file_count: int = 0
    contributors: List[str] = field(default_factory=list)
    last_activity: str = ""
    readme_summary: str = ""
    entry_points: List[str] = field(default_factory=list)
    
    def __post_init__(self):
        """Sanitize fields after init"""
        if self.tech_stack is None:
            self.tech_stack = {"languages": [], "frameworks": [], "tools": []}
    

@dataclass
class ChangeInfo:
    """변경 정보"""
    file_path: str
    change_type: str  # added, modified, deleted
    additions: int = 0
    deletions: int = 0
    content_preview: str = ""


@dataclass 
class PRDraft:
    """PR 초안"""
    title: str
    body: str
    base_branch: str
    head_branch: str
    labels: List[str] = field(default_factory=list)
    reviewers: List[str] = field(default_factory=list)


class GitWorkflowManager:
    """
    Git 워크플로우 고도화 매니저
    
    기능:
    - 저장소 분석
    - 브랜치 관리
    - 자동 커밋
    - PR 생성
    """
    
    def __init__(self, workdir: str, llm_client=None):
        """
        Args:
            workdir: Git 저장소 경로
            llm_client: LLM 클라이언트 (커밋 메시지/PR 생성용)
        """
        self.workdir = workdir
        self.llm_client = llm_client
        self.git_timeout = self._load_timeout_env("DAACS_GIT_TIMEOUT_SEC", GIT_TIMEOUT_SEC)
        self.git_network_timeout = self._load_timeout_env(
            "DAACS_GIT_NETWORK_TIMEOUT_SEC",
            GIT_NETWORK_TIMEOUT_SEC,
        )

    @staticmethod
    def _load_timeout_env(key: str, default: int) -> int:
        value = os.getenv(key, str(default)).strip()
        try:
            return max(1, int(value))
        except (TypeError, ValueError):
            logger.warning("Invalid %s=%r, using default %s", key, value, default)
            return default
        
    def _run_git(self, args: List[str], timeout: Optional[int] = None) -> Tuple[bool, str, str]:
        """Git 명령 실행"""
        command_timeout = timeout if timeout is not None else self.git_timeout
        try:
            result = subprocess.run(
                ["git"] + args,
                cwd=self.workdir,
                capture_output=True,
                text=True,
                timeout=command_timeout
            )
            return result.returncode == 0, result.stdout, result.stderr
        except subprocess.TimeoutExpired:
            return False, "", "Git command timeout"
        except Exception as e:
            return False, "", str(e)
    
    def is_git_repo(self) -> bool:
        """Git 저장소인지 확인"""
        git_dir = os.path.join(self.workdir, ".git")
        return os.path.isdir(git_dir)
    
    # ==================== 저장소 분석 ====================
    
    def analyze_repository(self) -> RepoAnalysis:
        """저장소 전체 분석"""
        analysis = RepoAnalysis()
        
        if not self.is_git_repo():
            return analysis
        
        # Remote URL
        success, stdout, _ = self._run_git(["config", "--get", "remote.origin.url"])
        if success:
            analysis.repo_url = stdout.strip()
        
        # 현재 브랜치
        success, stdout, _ = self._run_git(["branch", "--show-current"])
        if success:
            analysis.current_branch = stdout.strip()
        
        # 기본 브랜치 탐지
        analysis.default_branch = self._detect_default_branch()
        
        # 브랜치 목록
        analysis.branches = self._get_branches()
        
        # 최근 커밋
        analysis.recent_commits = self._get_recent_commits(10)
        
        # 기술 스택 탐지
        analysis.tech_stack = self._detect_tech_stack()
        
        # 파일 수
        analysis.file_count = self._count_files()
        
        # 기여자
        analysis.contributors = self._get_contributors()
        
        # 마지막 활동
        if analysis.recent_commits:
            analysis.last_activity = analysis.recent_commits[0].date
        
        # README 요약
        analysis.readme_summary = self._get_readme_summary()
        
        # 진입점 탐지
        analysis.entry_points = self._detect_entry_points()
        
        return analysis
    
    def _detect_default_branch(self) -> str:
        """기본 브랜치 탐지"""
        # HEAD가 가리키는 브랜치 확인
        success, stdout, _ = self._run_git(["symbolic-ref", "refs/remotes/origin/HEAD"])
        if success:
            # refs/remotes/origin/main -> main
            return stdout.strip().split("/")[-1]
        
        # 일반적인 브랜치 이름 확인
        for branch in ["main", "master", "develop"]:
            success, _, _ = self._run_git(["rev-parse", "--verify", branch])
            if success:
                return branch
        
        return "main"
    
    def _get_branches(self) -> List[BranchInfo]:
        """브랜치 목록 조회"""
        branches = []
        
        # 로컬 브랜치
        success, stdout, _ = self._run_git(["branch", "-v", "--format=%(refname:short)|%(objectname:short)|%(committerdate:short)|%(HEAD)"])
        if success:
            for line in stdout.strip().split("\n"):
                if not line:
                    continue
                parts = line.split("|")
                if len(parts) >= 4:
                    branches.append(BranchInfo(
                        name=parts[0],
                        is_current=parts[3] == "*",
                        is_remote=False,
                        last_commit=parts[1],
                        last_commit_date=parts[2]
                    ))
        
        # 리모트 브랜치
        success, stdout, _ = self._run_git(["branch", "-r", "--format=%(refname:short)|%(objectname:short)|%(committerdate:short)"])
        if success:
            for line in stdout.strip().split("\n"):
                if not line or "HEAD" in line:
                    continue
                parts = line.split("|")
                if len(parts) >= 3:
                    branches.append(BranchInfo(
                        name=parts[0],
                        is_current=False,
                        is_remote=True,
                        last_commit=parts[1],
                        last_commit_date=parts[2]
                    ))
        
        return branches
    
    def _get_recent_commits(self, count: int = 10) -> List[CommitInfo]:
        """최근 커밋 조회"""
        commits = []
        
        success, stdout, _ = self._run_git([
            "log", f"-{count}", 
            "--format=%H|%h|%an|%ad|%s",
            "--date=short"
        ])
        
        if success:
            for line in stdout.strip().split("\n"):
                if not line:
                    continue
                parts = line.split("|", 4)
                if len(parts) >= 5:
                    commits.append(CommitInfo(
                        hash=parts[0],
                        short_hash=parts[1],
                        author=parts[2],
                        date=parts[3],
                        message=parts[4]
                    ))
        
        return commits
    
    def _detect_tech_stack(self) -> Dict[str, Any]:
        """기술 스택 탐지"""
        tech_stack = {
            "languages": [],
            "frameworks": [],
            "tools": []
        }

        def _load_json(path: str) -> Optional[Dict[str, Any]]:
            try:
                with open(path, "r", encoding="utf-8") as f:
                    return json.load(f)
            except (json.JSONDecodeError, UnicodeDecodeError, OSError) as e:
                logger.debug("Failed to parse JSON file %s: %s", path, e)
                return None
        
        # package.json 확인 (Node.js)
        pkg_path = os.path.join(self.workdir, "package.json")
        if os.path.exists(pkg_path):
            pkg = _load_json(pkg_path)
            if pkg:
                deps = {**pkg.get("dependencies", {}), **pkg.get("devDependencies", {})}
                
                if "react" in deps:
                    tech_stack["frameworks"].append("React")
                if "vue" in deps:
                    tech_stack["frameworks"].append("Vue")
                if "next" in deps:
                    tech_stack["frameworks"].append("Next.js")
                if "vite" in deps:
                    tech_stack["tools"].append("Vite")
                if "typescript" in deps:
                    tech_stack["languages"].append("TypeScript")
                
                tech_stack["languages"].append("JavaScript")
        
        # requirements.txt 확인 (Python)
        req_path = os.path.join(self.workdir, "requirements.txt")
        if os.path.exists(req_path):
            tech_stack["languages"].append("Python")
            try:
                with open(req_path, 'r', encoding='utf-8') as f:
                    content = f.read().lower()
                if "fastapi" in content:
                    tech_stack["frameworks"].append("FastAPI")
                if "django" in content:
                    tech_stack["frameworks"].append("Django")
                if "flask" in content:
                    tech_stack["frameworks"].append("Flask")
            except (UnicodeDecodeError, OSError) as e:
                logger.debug(f"Failed to parse requirements.txt (encoding/read error): {e}")
            except (ValueError, KeyError, OSError):
                logger.debug("Failed to parse requirements.txt for tech stack", exc_info=True)
        
        # pyproject.toml 확인
        pyproject_path = os.path.join(self.workdir, "pyproject.toml")
        if os.path.exists(pyproject_path) and "Python" not in tech_stack["languages"]:
            tech_stack["languages"].append("Python")
        
        # Dockerfile 확인
        if os.path.exists(os.path.join(self.workdir, "Dockerfile")):
            tech_stack["tools"].append("Docker")
        
        return tech_stack
    
    def _count_files(self) -> int:
        """파일 수 카운트"""
        success, stdout, _ = self._run_git(["ls-files"])
        if success:
            return len([f for f in stdout.strip().split("\n") if f])
        return 0
    
    def _get_contributors(self) -> List[str]:
        """기여자 목록"""
        success, stdout, _ = self._run_git(["shortlog", "-sn", "--all"])
        if success:
            contributors = []
            for line in stdout.strip().split("\n")[:10]:  # 상위 10명
                if line:
                    # "  123\tAuthor Name" 형식
                    match = re.match(r'\s*\d+\s+(.+)', line)
                    if match:
                        contributors.append(match.group(1))
            return contributors
        return []
    
    def _get_readme_summary(self) -> str:
        """README 요약"""
        for readme in ["README.md", "README", "readme.md"]:
            readme_path = os.path.join(self.workdir, readme)
            if os.path.exists(readme_path):
                try:
                    with open(readme_path, "r", encoding="utf-8", errors="ignore") as f:
                        content = f.read()
                    # 첫 500자만 반환
                    return content[:500]
                except OSError:
                    logger.debug("Failed to read README summary", exc_info=True)
        return ""
    
    def _detect_entry_points(self) -> List[str]:
        """진입점 탐지"""
        entry_points = []
        
        candidates = [
            "main.py", "app.py", "server.py", "index.py",
            "src/main.py", "src/app.py", "src/index.py",
            "src/main.tsx", "src/index.tsx", "src/App.tsx",
            "index.html", "public/index.html",
            "main.go", "cmd/main.go"
        ]
        
        for candidate in candidates:
            if os.path.exists(os.path.join(self.workdir, candidate)):
                entry_points.append(candidate)
        
        return entry_points
    
    # ==================== 브랜치 관리 ====================
    
    def create_feature_branch(self, name: str, base_branch: Optional[str] = None) -> Tuple[bool, str]:
        """Feature 브랜치 생성"""
        # 브랜치 이름 정규화 (Issue 97)
        # 1. Lowercase and strip
        safe_name = name.lower().strip()
        # 2. Replace non-alphanumeric (except - and _) with -
        safe_name = re.sub(r'[^a-z0-9_-]', '-', safe_name)
        # 3. Prevent multiple dashes
        safe_name = re.sub(r'-+', '-', safe_name)
        # 4. Remove leading/trailing dashes
        safe_name = safe_name.strip('-')
        # 5. Limit length (e.g., 50 chars)
        safe_name = safe_name[:50]
        if not safe_name:
            safe_name = "update"
        
        branch_name = f"feature/{safe_name}"
        
        # 기본 브랜치로 체크아웃
        base = base_branch or self._detect_default_branch()
        success, _, stderr = self._run_git(["checkout", base])
        if not success:
            return False, f"Failed to checkout {base}: {stderr}"
        
        # 최신 상태로 업데이트
        self._run_git(["pull", "--ff-only"])
        
        # 새 브랜치 생성
        success, _, stderr = self._run_git(["checkout", "-b", branch_name])
        if not success:
            return False, f"Failed to create branch: {stderr}"
        
        return True, branch_name
    
    def switch_branch(self, branch_name: str) -> Tuple[bool, str]:
        """브랜치 전환"""
        success, _, stderr = self._run_git(["checkout", branch_name])
        if not success:
            return False, f"Failed to switch branch: {stderr}"
        return True, f"Switched to {branch_name}"
    
    def get_current_branch(self) -> str:
        """현재 브랜치 조회"""
        success, stdout, _ = self._run_git(["branch", "--show-current"])
        return stdout.strip() if success else ""
    
    # ==================== 변경 관리 ====================
    
    def get_changes(self, staged_only: bool = False) -> List[ChangeInfo]:
        """변경 사항 조회"""
        changes = []
        
        if staged_only:
            success, stdout, _ = self._run_git(["diff", "--cached", "--numstat"])
        else:
            success, stdout, _ = self._run_git(["diff", "--numstat"])
        
        if success:
            for line in stdout.strip().split("\n"):
                if not line:
                    continue
                parts = line.split("\t")
                if len(parts) >= 3:
                    changes.append(ChangeInfo(
                        file_path=parts[2],
                        change_type="modified",
                        additions=int(parts[0]) if parts[0] != "-" else 0,
                        deletions=int(parts[1]) if parts[1] != "-" else 0
                    ))
        
        # 새 파일 (untracked)
        if not staged_only:
            success, stdout, _ = self._run_git(["ls-files", "--others", "--exclude-standard"])
            if success:
                for line in stdout.strip().split("\n"):
                    if line:
                        changes.append(ChangeInfo(
                            file_path=line,
                            change_type="added"
                        ))
        
        return changes
    
    def stage_files(self, files: Optional[List[str]] = None) -> Tuple[bool, str]:
        """파일 스테이징"""
        if files:
            success, _, stderr = self._run_git(["add"] + files)
        else:
            success, _, stderr = self._run_git(["add", "-A"])
        
        if not success:
            return False, f"Failed to stage files: {stderr}"
        return True, "Files staged successfully"
    
    # ==================== 커밋 ====================
    
    def generate_commit_message(self, changes: List[ChangeInfo]) -> str:
        """AI 커밋 메시지 생성"""
        if not changes:
            return "chore: minor updates"
        
        # 변경 유형 분석
        added = [c for c in changes if c.change_type == "added"]
        modified = [c for c in changes if c.change_type == "modified"]
        deleted = [c for c in changes if c.change_type == "deleted"]
        
        # 파일 확장자 분석
        extensions = set()
        for c in changes:
            ext = os.path.splitext(c.file_path)[1]
            if ext:
                extensions.add(ext)
        
        # 커밋 타입 결정
        commit_type = "chore"
        if any(c.file_path.startswith("test") or "test_" in c.file_path for c in changes):
            commit_type = "test"
        elif any(c.file_path.endswith((".md", ".txt", ".rst")) for c in changes):
            commit_type = "docs"
        elif any(c.file_path.endswith((".css", ".scss", ".html")) for c in changes):
            commit_type = "style"
        elif len(added) > len(modified):
            commit_type = "feat"
        elif len(modified) > 0:
            commit_type = "fix"
        
        # 스코프 결정
        scope = ""
        if ".py" in str(extensions):
            scope = "backend"
        elif any(ext in str(extensions) for ext in [".tsx", ".jsx", ".vue"]):
            scope = "frontend"
        elif ".md" in str(extensions):
            scope = "docs"
        
        # 메시지 생성
        if len(changes) == 1:
            action = changes[0].change_type
            file_name = os.path.basename(changes[0].file_path)
            message = f"{commit_type}({scope}): {action} {file_name}" if scope else f"{commit_type}: {action} {file_name}"
        else:
            if len(added) > 0 and len(modified) == 0:
                action = f"add {len(added)} files"
            elif len(modified) > 0 and len(added) == 0:
                action = f"update {len(modified)} files"
            else:
                action = f"update {len(changes)} files"
            message = f"{commit_type}({scope}): {action}" if scope else f"{commit_type}: {action}"
        
        return message
    
    def commit(self, message: Optional[str] = None, auto_message: bool = True) -> Tuple[bool, str]:
        """커밋"""
        if not message and auto_message:
            changes = self.get_changes(staged_only=True)
            message = self.generate_commit_message(changes)
        
        if not message:
            return False, "Commit message required"
        
        success, stdout, stderr = self._run_git(["commit", "-m", message])
        if not success:
            if "nothing to commit" in stderr:
                return True, "Nothing to commit"
            return False, f"Commit failed: {stderr}"
        
        return True, f"Committed: {message}"
    
    # ==================== PR 생성 ====================
    
    def generate_pr_draft(self, changes: Optional[List[ChangeInfo]] = None) -> PRDraft:
        """PR 초안 생성"""
        current_branch = self.get_current_branch()
        default_branch = self._detect_default_branch()
        
        if not changes:
            changes = self.get_changes()
        
        # 커밋 메시지에서 PR 제목 추출
        commits = self._get_recent_commits(5)
        
        # PR 제목 생성
        if len(commits) == 1:
            title = commits[0].message
        else:
            # 브랜치 이름에서 제목 추출
            title = current_branch.replace("feature/", "").replace("-", " ").title()
            title = f"Feature: {title}"
        
        # PR 본문 생성
        body_parts = ["## Summary", ""]
        
        # 변경 사항 요약
        if changes:
            body_parts.append("### Changes")
            added = [c for c in changes if c.change_type == "added"]
            modified = [c for c in changes if c.change_type == "modified"]
            deleted = [c for c in changes if c.change_type == "deleted"]
            
            if added:
                body_parts.append(f"- Added {len(added)} files")
                for c in added[:5]:
                    body_parts.append(f"  - `{c.file_path}`")
            if modified:
                body_parts.append(f"- Modified {len(modified)} files")
                for c in modified[:5]:
                    body_parts.append(f"  - `{c.file_path}` (+{c.additions}/-{c.deletions})")
            if deleted:
                body_parts.append(f"- Deleted {len(deleted)} files")
            body_parts.append("")
        
        # 커밋 목록
        if commits:
            body_parts.append("### Commits")
            for c in commits[:10]:
                body_parts.append(f"- {c.short_hash}: {c.message}")
            body_parts.append("")
        
        # 체크리스트
        body_parts.extend([
            "## Checklist",
            "- [ ] Code has been tested locally",
            "- [ ] Documentation updated (if needed)",
            "- [ ] Tests added/updated (if applicable)",
            ""
        ])
        
        # 라벨 결정
        labels = []
        file_types = set(os.path.splitext(c.file_path)[1] for c in changes)
        if ".py" in file_types:
            labels.append("backend")
        if any(ext in file_types for ext in [".tsx", ".jsx", ".vue", ".js"]):
            labels.append("frontend")
        if any("test" in c.file_path.lower() for c in changes):
            labels.append("tests")
        if ".md" in file_types:
            labels.append("documentation")
        
        return PRDraft(
            title=title,
            body="\n".join(body_parts),
            base_branch=default_branch,
            head_branch=current_branch,
            labels=labels
        )
    
    def push_branch(self, set_upstream: bool = True) -> Tuple[bool, str]:
        """브랜치 푸시"""
        current_branch = self.get_current_branch()
        
        if set_upstream:
            success, _, stderr = self._run_git(["push", "-u", "origin", current_branch], timeout=self.git_network_timeout)
        else:
            success, _, stderr = self._run_git(["push"], timeout=self.git_network_timeout)
        
        if not success:
            return False, f"Push failed: {stderr}"
        
        return True, f"Pushed {current_branch} to origin"
    
    # ==================== 편의 메서드 ====================
    
    def quick_commit_and_push(self, message: Optional[str] = None) -> Dict[str, Any]:
        """빠른 커밋 및 푸시"""
        result = {
            "stage": {"success": False, "message": ""},
            "commit": {"success": False, "message": ""},
            "push": {"success": False, "message": ""}
        }
        
        # Stage
        success, msg = self.stage_files()
        result["stage"] = {"success": success, "message": msg}
        if not success:
            return result
        
        # Commit
        success, msg = self.commit(message)
        result["commit"] = {"success": success, "message": msg}
        if not success or "Nothing to commit" in msg:
            return result
        
        # Push
        success, msg = self.push_branch()
        result["push"] = {"success": success, "message": msg}
        
        if not success:
            return result
            
        return result
    
    def to_dict(self, analysis: RepoAnalysis) -> Dict[str, Any]:
        """RepoAnalysis를 딕셔너리로 변환"""
        return {
            "repo_url": analysis.repo_url,
            "default_branch": analysis.default_branch,
            "current_branch": analysis.current_branch,
            "branches": [asdict(b) for b in analysis.branches],
            "recent_commits": [asdict(c) for c in analysis.recent_commits],
            "tech_stack": analysis.tech_stack,
            "file_count": analysis.file_count,
            "contributors": analysis.contributors,
            "last_activity": analysis.last_activity,
            "readme_summary": analysis.readme_summary[:200] + "..." if len(analysis.readme_summary) > 200 else analysis.readme_summary,
            "entry_points": analysis.entry_points
        }

# Backward compatibility alias
GitOperations = GitWorkflowManager
