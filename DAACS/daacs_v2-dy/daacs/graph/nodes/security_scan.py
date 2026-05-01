"""
DAACS v7.0 - Security Scan Node
Pattern-based security vulnerability scanning (no LLM needed).
"""
from typing import Dict, Any, List, Tuple
import re
import os
import glob

from ...models.daacs_state import DAACSState
from ...utils import setup_logger

logger = setup_logger("SecurityScanNode")

# Exclude patterns for file search
EXCLUDE_PATTERNS = ["node_modules", "__pycache__", "venv", ".venv", "dist", ".next", "build"]

# Security patterns by language
SECURITY_PATTERNS: Dict[str, List[Tuple[str, str, str]]] = {
    "python": [
        (r'eval\s*\(', "Use of eval() - potential code injection", "critical"),
        (r'exec\s*\(', "Use of exec() - potential code injection", "critical"),
        (r'pickle\.loads?\s*\(', "Pickle deserialization - potential RCE", "critical"),
        (r'os\.system\s*\(', "os.system() - prefer subprocess.run()", "warning"),
        (r'shell\s*=\s*True', "subprocess with shell=True - potential injection", "warning"),
        (r'password\s*=\s*["\'][^"\']+["\']', "Hardcoded password", "critical"),
        (r'SECRET_KEY\s*=\s*["\'][^"\']+["\']', "Hardcoded secret key", "critical"),
        (r'\.execute\s*\([^)]*%', "SQL injection vulnerability (string formatting)", "critical"),
        (r'\.execute\s*\([^)]*\+', "SQL injection vulnerability (string concatenation)", "critical"),
    ],
    "javascript": [
        (r'eval\s*\(', "Use of eval() - potential code injection", "critical"),
        (r'innerHTML\s*=', "innerHTML assignment - potential XSS", "warning"),
        (r'document\.write\s*\(', "document.write() - potential XSS", "warning"),
        (r'localStorage\.setItem\s*\([^,]+,\s*[^)]*password', "Storing password in localStorage", "critical"),
        (r'console\.log\s*\([^)]*password', "Logging sensitive data", "warning"),
        (r'apiKey\s*[=:]\s*["\'][^"\']+["\']', "Hardcoded API key", "critical"),
    ]
}


def _scan_file(filepath: str, language: str, project_dir: str) -> List[Dict[str, Any]]:
    """Scan a single file for security issues."""
    issues = []
    patterns = SECURITY_PATTERNS.get(language, [])
    
    try:
        with open(filepath, 'r', encoding='utf-8', errors='ignore') as f:
            content = f.read()
            rel_path = os.path.relpath(filepath, project_dir)
            
            for pattern, description, severity in patterns:
                for match in re.finditer(pattern, content):
                    line_no = content[:match.start()].count('\n') + 1
                    issues.append({
                        "file": rel_path,
                        "line": line_no,
                        "severity": severity,
                        "description": description,
                        "pattern": pattern,
                        "snippet": content[max(0, match.start()-20):match.end()+20]
                    })
    except OSError:
        logger.debug("Failed to scan file: %s", filepath)
    
    return issues


def _collect_files(project_dir: str, extensions: List[str]) -> List[str]:
    """Collect files with given extensions."""
    files = []
    for ext in extensions:
        pattern = os.path.join(project_dir, f"**/*{ext}")
        found = glob.glob(pattern, recursive=True)
        files.extend([f for f in found if not any(p in f for p in EXCLUDE_PATTERNS)])
    return files


def security_scan_node(state: DAACSState) -> Dict[str, Any]:
    """
    기본 보안 취약점 스캔 노드 (LLM 없이 패턴 매칭)
    
    Returns:
        security_issues: 발견된 보안 문제 목록
        security_passed: 스캔 통과 여부 (critical 없음)
    """
    project_dir = state.get("project_dir", ".")
    
    logger.info("Scanning for security issues...")
    
    issues = []
    
    # Scan Python files
    py_files = _collect_files(project_dir, [".py"])
    for f in py_files:
        issues.extend(_scan_file(f, "python", project_dir))
    
    # Scan JavaScript/TypeScript files
    js_files = _collect_files(project_dir, [".js", ".jsx", ".ts", ".tsx"])
    for f in js_files:
        issues.extend(_scan_file(f, "javascript", project_dir))
    
    critical_count = sum(1 for i in issues if i["severity"] == "critical")
    warning_count = sum(1 for i in issues if i["severity"] == "warning")
    
    passed = critical_count == 0
    
    logger.info("Found %d critical, %d warnings. Passed: %s", critical_count, warning_count, passed)
    
    return {
        "security_issues": issues,
        "security_passed": passed,
        "security_summary": {
            "critical": critical_count,
            "warning": warning_count,
            "total": len(issues)
        }
    }
