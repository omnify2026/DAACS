"""
DAACS v7.0 - Enhanced Graph Nodes (Facade)
Phase 7.2: 품질 향상을 위한 추가 노드

Nodes are now modular. This file re-exports them for backward compatibility.

노드 목록:
1. code_review_node - 생성된 코드 자동 리뷰
2. consistency_check_node - 프론트-백엔드 API 일관성 검증
3. api_spec_validation_node - API 스펙 검증
4. security_scan_node - 보안 취약점 스캔
5. dependency_check_node - 의존성 검증
"""

from typing import Dict, Any, List
import json
import re
import os
import glob

from ..models.daacs_state import DAACSState
from ..utils import setup_logger

# Re-export modular nodes
from .nodes.code_review import code_review_node
from .nodes.security_scan import security_scan_node
from .nodes.consistency_check import consistency_check_node

logger = setup_logger("EnhancedNodes")

# ==================== API Spec Validation Node ====================

def api_spec_validation_node(state: DAACSState, llm_type: str = "gemini") -> Dict[str, Any]:
    """
    API 스펙이 올바르게 생성되었는지 검증하는 노드
    
    Returns:
        api_spec_valid: API 스펙 유효성
        api_spec_issues: 문제점 목록
    """
    api_spec = state.get("api_spec", {})
    current_goal = state.get("current_goal", "")
    needs_backend = state.get("needs_backend", True)
    needs_frontend = state.get("needs_frontend", True)
    fullstack_required = bool(needs_backend and needs_frontend)
    
    logger.info("Validating API specification...")
    
    issues = []
    
    # Skip if no spec
    if not api_spec:
        if fullstack_required:
            return {
                "api_spec_valid": False,
                "api_spec_issues": ["API spec required for full-stack output (frontend+backend)"]
            }
        return {
            "api_spec_valid": True,
            "api_spec_issues": ["No API spec defined - this may be a frontend-only project"]
        }
    
    endpoints = api_spec.get("endpoints", [])
    
    # Basic validation
    if not endpoints:
        issues.append("No endpoints defined in API spec")
        if fullstack_required:
            issues.append("API spec must include endpoints for full-stack output")
    
    for ep in endpoints:
        if not ep.get("method"):
            issues.append(f"Endpoint missing method: {ep}")
        if not ep.get("path"):
            issues.append(f"Endpoint missing path: {ep}")
        
        path = ep.get("path", "")
        if path and not path.startswith("/"):
            issues.append(f"Path should start with /: {path}")
        
        method = ep.get("method", "").upper()
        if method and method not in ["GET", "POST", "PUT", "DELETE", "PATCH", "HEAD", "OPTIONS"]:
            issues.append(f"Invalid HTTP method: {method}")
    
    # Goal keyword validation
    goal_lower = current_goal.lower()
    spec_text = json.dumps(api_spec).lower()
    
    if "사용자" in goal_lower or "user" in goal_lower:
        if "user" not in spec_text and "auth" not in spec_text:
            issues.append("Goal mentions users but API spec has no user-related endpoints")
    
    if "crud" in goal_lower or ("생성" in goal_lower and "삭제" in goal_lower):
        methods = [ep.get("method", "").upper() for ep in endpoints]
        if "POST" not in methods:
            issues.append("Goal requires CRUD but no POST endpoint for creation")
        if "DELETE" not in methods:
            issues.append("Goal requires CRUD but no DELETE endpoint")
    
    valid = len(issues) == 0
    
    logger.info("Valid: %s, Issues: %d", valid, len(issues))
    
    return {
        "api_spec_valid": valid,
        "api_spec_issues": issues
    }


# ==================== Dependency Check Node ====================

EXCLUDE_PATTERNS = ["node_modules", "__pycache__", "venv", ".venv"]

def dependency_check_node(state: DAACSState) -> Dict[str, Any]:
    """
    package.json / requirements.txt 의존성 검증 노드
    
    Returns:
        dependencies_valid: 의존성 파일 유효성
        dependency_issues: 문제점 목록
    """
    project_dir = state.get("project_dir", ".")
    
    logger.info("Checking dependencies...")
    
    issues = []
    dependencies_found = False
    
    # package.json check
    package_json_path = os.path.join(project_dir, "package.json")
    if os.path.exists(package_json_path):
        dependencies_found = True
        try:
            with open(package_json_path, 'r', encoding='utf-8') as f:
                pkg = json.load(f)
            
            if not pkg.get("name"):
                issues.append("package.json missing 'name' field")
            if not pkg.get("scripts"):
                issues.append("package.json missing 'scripts' field")
            
            deps = pkg.get("dependencies", {})
            dev_deps = pkg.get("devDependencies", {})
            all_deps = {**deps, **dev_deps}
            
            if "react" in all_deps and "react-dom" not in all_deps:
                issues.append("React project missing 'react-dom' dependency")
            
            if "vite" in all_deps and "@vitejs/plugin-react" not in all_deps and "react" in all_deps:
                issues.append("Vite + React project missing '@vitejs/plugin-react'")
                
        except json.JSONDecodeError as e:
            issues.append(f"package.json is not valid JSON: {e}")
        except Exception as e:
            issues.append(f"Error reading package.json: {e}")
    
    # requirements.txt check
    requirements_path = os.path.join(project_dir, "requirements.txt")
    if os.path.exists(requirements_path):
        dependencies_found = True
        try:
            with open(requirements_path, 'r', encoding='utf-8') as f:
                content = f.read()
            
            if not content.strip():
                issues.append("requirements.txt is empty")
            
            for line in content.split('\n'):
                line = line.strip()
                if line and not line.startswith('#'):
                    if not re.match(r'^[a-zA-Z0-9_-]+(\[.*\])?(==|>=|<=|>|<|~=|!=)?.*$', line):
                        issues.append(f"Invalid requirements.txt line: {line}")
        except Exception as e:
            issues.append(f"Error reading requirements.txt: {e}")
    
    # No dependency files found
    if not dependencies_found:
        has_html = len(glob.glob(os.path.join(project_dir, "**/*.html"), recursive=True)) > 0
        if not has_html:
            issues.append("No dependency files found (package.json or requirements.txt)")
    
    valid = len(issues) == 0
    
    logger.info("Valid: %s, Issues: %d", valid, len(issues))
    
    return {
        "dependencies_valid": valid,
        "dependency_issues": issues
    }


# Export all nodes
__all__ = [
    "code_review_node",
    "consistency_check_node",
    "api_spec_validation_node",
    "security_scan_node",
    "dependency_check_node",
]
