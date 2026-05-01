import os
import re
from typing import Dict, List, Any

from ...utils import setup_logger

logger = setup_logger("Verifier.StaticChecks")

EXCLUDED_PATTERNS = {'node_modules', '__pycache__', '.git', 'venv', '.venv', 'dist', 'build', '.next', '.cache'}
ALLOWED_EMPTY_BASENAMES = {"__init__.py", ".gitkeep", ".keep", ".empty"}

def files_exist(files: List[str]) -> Dict[str, Any]:
    """파일 존재 확인"""
    if not files:
        return {
            "ok": False,
            "reason": "No files collected for verification",
            "template": "files_exist"
        }
    missing = [f for f in files if not os.path.exists(f)]
    return {
        "ok": len(missing) == 0,
        "reason": f"Missing files: {missing}" if missing else "All files exist",
        "template": "files_exist"
    }

def files_not_empty(files: List[str]) -> Dict[str, Any]:
    """파일이 비어있지 않은지 확인 (vendor directories excluded)"""
    def should_check(filepath: str) -> bool:
        parts = filepath.replace('\\', '/').split('/')
        return not any(excluded in parts for excluded in EXCLUDED_PATTERNS)

    def is_allowed_empty(filepath: str) -> bool:
        return os.path.basename(filepath) in ALLOWED_EMPTY_BASENAMES

    files_to_check = [f for f in files if should_check(f)]
    
    def check_is_file_empty_and_disallowed(f: str) -> bool:
        if os.path.exists(f) and os.path.getsize(f) == 0:
            allowed = is_allowed_empty(f)
            if not allowed:
                 logger.warning(f"File flagged as empty (not allowed): {f}, basename: {os.path.basename(f)}")
                 return True
            return False
        return False

    empty = [f for f in files_to_check if check_is_file_empty_and_disallowed(f)]
    return {
        "ok": len(empty) == 0,
        "reason": f"Empty files: {empty}" if empty else "All files have content",
        "template": "files_not_empty"
    }

def files_no_hidden(files: List[str]) -> Dict[str, Any]:
    """숨김 문자 없음 확인"""
    hidden_pattern = re.compile(r'[\x00-\x08\x0B-\x0C\x0E-\x1F\x7F]')
    files_with_hidden = []
    
    for file in files:
        if os.path.exists(file):
            try:
                with open(file, 'r', encoding='utf-8', errors='ignore') as f:
                    content = f.read()
                    if hidden_pattern.search(content):
                        files_with_hidden.append(file)
            except OSError:
                logger.debug("Failed to read file for hidden char check: %s", file)

    return {
        "ok": len(files_with_hidden) == 0,
        "reason": f"Files with hidden chars: {files_with_hidden}" if files_with_hidden else "No hidden characters",
        "template": "files_no_hidden"
    }
