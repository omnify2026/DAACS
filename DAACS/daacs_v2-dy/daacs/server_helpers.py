"""
Phase 6: 공룡 함수 리팩토링 - 서버 헬퍼

server.py의 대형 함수들을 작은 모듈로 분리.
단일 책임 원칙(SRP)에 따른 구조화.
"""

import os
import shutil
import subprocess
import threading
import time
from pathlib import Path
from typing import Dict, Any, Optional, List

from .utils import setup_logger
from .config import GIT_CLONE_TIMEOUT_SEC, HTTP_REQUEST_TIMEOUT_SEC, PROJECT_FILES_CACHE_TTL_SEC

logger = setup_logger("ServerHelpers")


# ==================== 프로젝트 파일 시스템 ====================

class ProjectFileSystem:
    """프로젝트 파일 시스템 관리"""
    
    IGNORED_DIRS = {
        ".git", "__pycache__", "node_modules", "dist", "build",
        ".next", ".turbo", ".cache", ".venv", "venv"
    }
    IGNORED_FILES = {".DS_Store"}
    MAX_PROJECT_FILES = 5000
    
    def __init__(self, workspace_base: str):
        self.workspace_base = Path(workspace_base)
        self._list_cache: Dict[str, Any] = {}
        self._cache_lock = threading.Lock()
    
    def get_workdir(self, project_id: str) -> Path:
        """프로젝트 작업 디렉토리"""
        return self.workspace_base / project_id
    
    def classify_file(self, rel_path: str) -> str:
        """파일을 backend/frontend/config로 분류"""
        path = rel_path.lower()
        
        # Backend 패턴
        if any(path.endswith(ext) for ext in ['.py', '.go', '.rs', '.java', '.rb']):
            return 'backend'
        if any(d in path for d in ['backend/', 'server/', 'api/', 'daacs/']):
            return 'backend'
        
        # Frontend 패턴
        if any(path.endswith(ext) for ext in ['.tsx', '.jsx', '.vue', '.svelte', '.html', '.css']):
            return 'frontend'
        if any(d in path for d in ['frontend/', 'client/', 'src/', 'components/', 'pages/']):
            return 'frontend'
        
        # 나머지는 config
        return 'config'
    
    def list_files(self, project_id: str) -> Dict[str, List[str]]:
        """프로젝트 파일 목록 조회 (카테고리별)"""
        workdir = self.get_workdir(project_id)
        if not workdir.exists():
            return {"backend": [], "frontend": [], "config": []}

        if PROJECT_FILES_CACHE_TTL_SEC > 0:
            now = time.monotonic()
            with self._cache_lock:
                cached = self._list_cache.get(project_id)
                if cached and now - cached["ts"] <= PROJECT_FILES_CACHE_TTL_SEC:
                    return {k: list(v) for k, v in cached["data"].items()}
        
        result: Dict[str, List[str]] = {"backend": [], "frontend": [], "config": []}
        count = 0
        
        for root, dirs, files in os.walk(workdir):
            # 무시할 디렉토리 제외
            dirs[:] = [d for d in dirs if d not in self.IGNORED_DIRS]
            
            for f in files:
                if f in self.IGNORED_FILES:
                    continue
                count += 1
                if count > self.MAX_PROJECT_FILES:
                    break
                
                full = Path(root) / f
                rel = full.relative_to(workdir).as_posix()
                cat = self.classify_file(rel)
                result[cat].append(rel)
            
            if count > self.MAX_PROJECT_FILES:
                break
        if PROJECT_FILES_CACHE_TTL_SEC > 0:
            with self._cache_lock:
                self._list_cache[project_id] = {"ts": time.monotonic(), "data": result}
        return {k: list(v) for k, v in result.items()}


# ==================== Git 작업 ====================

class GitOperations:
    """Git 저장소 작업"""
    
    @staticmethod
    def clone(repo_url: str, target_dir: str, branch: Optional[str] = None) -> Dict[str, Any]:
        """Git 저장소 클론"""
        cmd = ["git", "clone", "--depth", "1"]
        if branch:
            cmd.extend(["-b", branch])
        cmd.extend([repo_url, target_dir])
        
        try:
            result = subprocess.run(
                cmd,
                capture_output=True,
                text=True,
                timeout=GIT_CLONE_TIMEOUT_SEC
            )
            
            if result.returncode != 0:
                return {"success": False, "error": result.stderr}
            
            return {"success": True, "path": target_dir}
            
        except subprocess.TimeoutExpired:
            return {"success": False, "error": "Clone timeout"}
        except Exception as e:
            return {"success": False, "error": str(e)}

    @staticmethod
    def get_remote_url(workdir: str) -> Dict[str, Any]:
        """Fetch git remote URL for origin."""
        try:
            result = subprocess.run(
                ["git", "config", "--get", "remote.origin.url"],
                cwd=workdir,
                capture_output=True,
                text=True,
                timeout=HTTP_REQUEST_TIMEOUT_SEC,
            )
            if result.returncode != 0:
                return {"success": False, "error": result.stderr}
            return {"success": True, "url": result.stdout.strip()}
        except subprocess.TimeoutExpired:
            return {"success": False, "error": "Git config timeout"}
        except Exception as e:
            return {"success": False, "error": str(e)}

    @staticmethod
    def pull_ff_only(workdir: str) -> Dict[str, Any]:
        """Fast-forward only pull."""
        try:
            result = subprocess.run(
                ["git", "pull", "--ff-only"],
                cwd=workdir,
                capture_output=True,
                text=True,
                timeout=GIT_CLONE_TIMEOUT_SEC,
            )
            if result.returncode != 0:
                return {"success": False, "error": result.stderr}
            return {"success": True}
        except subprocess.TimeoutExpired:
            return {"success": False, "error": "Git pull timeout"}
        except Exception as e:
            return {"success": False, "error": str(e)}
    
    @staticmethod
    def is_git_repo(workdir: str) -> bool:
        """Git 저장소 여부 확인"""
        return (Path(workdir) / ".git").exists()


# ==================== 소스 동기화 ====================

class SourceSynchronizer:
    """소스 폴더 동기화"""
    
    IGNORED_DIRS = {"node_modules", ".git", "__pycache__", "venv", ".venv", "dist", "build"}
    
    @classmethod
    def copy_folder(cls, source: str, target: str, replace: bool = False) -> Dict[str, Any]:
        """소스 폴더 복사"""
        source_path = Path(source)
        target_path = Path(target)
        
        if not source_path.exists():
            return {"success": False, "error": f"Source not found: {source}"}
        
        if target_path.exists() and replace:
            shutil.rmtree(target_path)
        
        def ignore_patterns(directory, files):
            return [f for f in files if f in cls.IGNORED_DIRS]
        
        try:
            if hasattr(shutil, 'copytree'):
                # Python 3.8+ supports dirs_exist_ok
                shutil.copytree(source_path, target_path, ignore=ignore_patterns, dirs_exist_ok=True)
            else:
                # Fallback for older python (unlikely but safe)
                if target_path.exists():
                    shutil.rmtree(target_path)
                shutil.copytree(source_path, target_path, ignore=ignore_patterns)
            return {"success": True, "path": str(target_path)}
        except Exception as e:
            return {"success": False, "error": str(e)}


# ==================== 프로젝트 컨텍스트 저장 ====================

def save_project_context(workdir: str, p_info: Dict[str, Any]) -> bool:
    """
    프로젝트 컨텍스트를 PROJECT_CONTEXT.md 파일로 저장.
    나중에 프로젝트 재개발 시 LLM이 컨텍스트를 유지할 수 있도록 함.
    """
    try:
        context_path = Path(workdir) / "PROJECT_CONTEXT.md"
        
        # 원본 사용자 요청
        original_goal = p_info.get("goal", "")
        
        # RFP 데이터
        rfp_data = p_info.get("rfp_data") or {}
        rfp_goal = rfp_data.get("goal", "") if isinstance(rfp_data, dict) else ""
        
        # API 스펙
        api_spec = p_info.get("api_spec") or {}
        endpoints = api_spec.get("endpoints", []) if isinstance(api_spec, dict) else []
        
        # 기술 스택 (assumptions에서 추출)
        assumptions = p_info.get("assumptions") or {}
        tech_stack = assumptions.get("tech_stack", {}) if isinstance(assumptions, dict) else {}
        
        # Markdown 생성
        lines = [
            "# Project Context",
            "",
            f"**Created:** {p_info.get('created_at', 'Unknown')}",
            f"**Project ID:** {p_info.get('id', 'Unknown')}",
            "",
            "---",
            "",
            "## 원본 사용자 요청",
            "",
            "```",
            original_goal[:5000] if original_goal else "(없음)",  # 5000자 제한
            "```",
            "",
        ]
        
        # RFP가 있으면 추가
        if rfp_goal and rfp_goal != original_goal:
            lines.extend([
                "## 생성된 RFP (Request for Proposal)",
                "",
                "```",
                rfp_goal[:5000] if rfp_goal else "(없음)",
                "```",
                "",
            ])
        
        # RFP 상세 스펙
        specs = rfp_data.get("specs", []) if isinstance(rfp_data, dict) else []
        if specs:
            lines.extend([
                "## 기능 스펙",
                "",
            ])
            for spec in specs[:20]:  # 최대 20개
                if isinstance(spec, dict):
                    lines.append(f"- **{spec.get('title', 'Unknown')}**: {spec.get('description', '')[:200]}")
                else:
                    lines.append(f"- {spec}")
            lines.append("")
        
        # API 스펙
        if endpoints:
            lines.extend([
                "## API 엔드포인트",
                "",
                "| Method | Path | Description |",
                "|--------|------|-------------|",
            ])
            for ep in endpoints[:30]:  # 최대 30개
                if isinstance(ep, dict):
                    method = ep.get("method", "GET")
                    path = ep.get("path", "/")
                    desc = ep.get("description", "")[:50]
                    lines.append(f"| {method} | {path} | {desc} |")
            lines.append("")
        
        # 기술 스택
        if tech_stack:
            lines.extend([
                "## 기술 스택",
                "",
            ])
            for key, value in tech_stack.items():
                lines.append(f"- **{key}**: {value}")
            lines.append("")
        
        # 파일 작성
        context_path.write_text("\n".join(lines), encoding="utf-8")
        logger.info(f"[SaveContext] Saved PROJECT_CONTEXT.md to {workdir}")
        return True
        
    except Exception as e:
        logger.error(f"[SaveContext] Failed to save context: {e}")
        return False

    
