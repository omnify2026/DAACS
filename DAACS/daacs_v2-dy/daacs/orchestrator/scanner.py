"""
DAACS Orchestrator Project Scanner
프로젝트 구조 스캔 및 분석 유틸리티
"""
import os
import json
from typing import Dict, Any, List, Set
from enum import Enum

from ..utils import setup_logger
from daacs.config import (
    KEY_FILE_NAMES,
    PROJECT_SCAN_MAX_FILES,
    PROJECT_SCAN_MAX_FILE_SIZE,
    PROJECT_SCAN_IGNORED_DIRS,
)

logger = setup_logger("ProjectScanner")


class ProjectType(str, Enum):
    """프로젝트 타입 enum"""
    REACT = "react"
    VITE = "vite"
    NODE = "node"
    PYTHON = "python"
    VANILLA = "vanilla"
    UNKNOWN = "unknown"


# 무시할 디렉토리
IGNORED_DIRS: Set[str] = set(PROJECT_SCAN_IGNORED_DIRS)

# 주요 설정 파일 (내용까지 읽을 파일들)
KEY_FILES_DEFAULT: Set[str] = set(KEY_FILE_NAMES) if KEY_FILE_NAMES else {
    "package.json", "README.md", "requirements.txt",
    "pyproject.toml", "tsconfig.json", "vite.config.ts",
    ".env.example", "Dockerfile"
}


class ProjectScanner:
    """프로젝트 구조 스캔 클래스"""
    
    def __init__(self, workdir: str = "."):
        self.workdir = workdir
        
    def scan(self, max_files: int = 0) -> Dict[str, Any]:
        """프로젝트 구조 스캔"""
        if max_files <= 0:
            max_files = PROJECT_SCAN_MAX_FILES
            
        result = {
            "files": [],
            "key_files": {}
        }
        
        if not self.workdir or not os.path.exists(self.workdir):
            return result
        
        files: List[str] = []
        
        try:
            for root, dirs, filenames in os.walk(self.workdir):
                dirs[:] = [d for d in dirs if d not in IGNORED_DIRS]
                
                for fname in filenames:
                    if fname.startswith(".") and fname not in {".env.example"}:
                        continue
                    
                    rel_path = os.path.relpath(os.path.join(root, fname), self.workdir)
                    full_path = os.path.join(root, fname)
                    
                    files.append(rel_path)
                    
                    # Use config KEY_FILE_NAMES or fallback
                    key_files = KEY_FILE_NAMES if KEY_FILE_NAMES else KEY_FILES_DEFAULT
                    if fname in key_files:
                        content = self._read_file_content(full_path, PROJECT_SCAN_MAX_FILE_SIZE)
                        if content:
                            result["key_files"][rel_path] = content
                    
                    if len(files) >= max_files:
                        break
                        
                if len(files) >= max_files:
                    break
                    
        except Exception as e:
            logger.warning(f"Failed to scan project structure: {e}")
        
        result["files"] = files
        return result
    
    def _read_file_content(self, path: str, max_size: int = 0) -> str:
        """파일 내용 읽기"""
        if max_size <= 0:
            max_size = PROJECT_SCAN_MAX_FILE_SIZE
        try:
            try:
                with open(path, "r", encoding="utf-8") as f:
                    content = f.read(max_size)
            except UnicodeDecodeError:
                logger.warning("Unicode decode failed for %s, using replacement characters", path)
                with open(path, "r", encoding="utf-8", errors="replace") as f:
                    content = f.read(max_size)
            if len(content) >= max_size:
                content += "\n... (truncated)"
            return content
        except Exception as e:
            logger.warning(f"Failed to read file {path}: {e}")
            return ""
    
    def get_project_type(self) -> ProjectType:
        """
        프로젝트 타입 추론 (JSON 파싱 개선)
        
        Returns: ProjectType enum value
        """
        if not os.path.exists(self.workdir):
            return ProjectType.UNKNOWN
        
        # package.json 확인 (proper JSON parsing)
        package_json = os.path.join(self.workdir, "package.json")
        if os.path.exists(package_json):
            try:
                content = self._read_file_content(package_json)
                pkg = json.loads(content)
                deps = pkg.get("dependencies", {})
                dev_deps = pkg.get("devDependencies", {})
                all_deps = {**deps, **dev_deps}
                
                if "vite" in all_deps:
                    return ProjectType.VITE
                if "react" in all_deps:
                    return ProjectType.REACT
                return ProjectType.NODE
            except json.JSONDecodeError:
                # Fallback to string search if JSON invalid
                content = self._read_file_content(package_json)
                if "vite" in content:
                    return ProjectType.VITE
                if "react" in content:
                    return ProjectType.REACT
                return ProjectType.NODE
        
        # Python 프로젝트 확인
        if os.path.exists(os.path.join(self.workdir, "requirements.txt")):
            return ProjectType.PYTHON
        if os.path.exists(os.path.join(self.workdir, "pyproject.toml")):
            return ProjectType.PYTHON
        
        # index.html만 있으면 vanilla
        if os.path.exists(os.path.join(self.workdir, "index.html")):
            return ProjectType.VANILLA
        if os.path.exists(os.path.join(self.workdir, "public", "index.html")):
            return ProjectType.VANILLA
        
        return ProjectType.UNKNOWN
    
    def count_files_by_type(self) -> Dict[str, int]:
        """파일 타입별 개수 카운트"""
        counts: Dict[str, int] = {}
        if not os.path.exists(self.workdir):
            return counts
        
        for root, dirs, filenames in os.walk(self.workdir):
            dirs[:] = [d for d in dirs if d not in IGNORED_DIRS]
            for fname in filenames:
                ext = os.path.splitext(fname)[1].lower()
                if ext:
                    counts[ext] = counts.get(ext, 0) + 1
        return counts


# 편의 함수
def scan_project(workdir: str, max_files: int = 0) -> Dict[str, Any]:
    """간편한 스캔 함수"""
    scanner = ProjectScanner(workdir)
    return scanner.scan(max_files)


def get_project_type(workdir: str) -> str:
    """간편한 프로젝트 타입 추론 함수"""
    scanner = ProjectScanner(workdir)
    return scanner.get_project_type().value
