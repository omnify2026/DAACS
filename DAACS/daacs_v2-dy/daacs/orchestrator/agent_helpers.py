import json
import os
import re
from typing import Any, Dict, List, Optional

from daacs.config import PROJECT_SCAN_MAX_FILES
from daacs.utils import setup_logger
from .scanner import ProjectScanner

# Constants to reduce hardcoding
MODIFY_KEYWORDS = {"modify", "update", "edit", "add", "append", "change"}
FILE_CREATION_KEYWORDS = {"create", "write", ">", "touch"}
FILES_TXT_VERIFICATION_CHECKS = [
    "files_exist:files.txt",
    "files_not_empty:files.txt",
    "files_no_hidden:files.txt",
    "files_match_listing:files.txt",
]
DEFAULT_ACTION_TYPE = "shell"
DEFAULT_ACTION_CLIENT = "frontend"
SAFE_FILES_TXT_COMMAND = (
    "find . -maxdepth 1 -mindepth 1 -not -name 'files.txt' -not -name '.*' "
    "| sed 's|^./||' | sort > files.txt"
)
logger = setup_logger("AgentHelpers")


def scan_project_structure(workdir: str, max_files: int, logger_override=None) -> Dict[str, Any]:
    """workdir의 현재 파일 구조를 스캔하여 LLM에게 제공."""
    # Use fallback from config if max_files is default/None
    if not max_files:
        max_files = PROJECT_SCAN_MAX_FILES
    active_logger = logger_override or logger

    if not workdir or not os.path.exists(workdir):
        return {"files": [], "key_files": {}}

    try:
        scanner = ProjectScanner(workdir)
        return scanner.scan(max_files)
    except Exception as e:
        active_logger.warning(f"Failed to scan project structure: {e}")
        return {"files": [], "key_files": {}}


def _normalize_ls_command(instr: str) -> str:
    """Normalize 'ls' variants to safe 'ls -1'."""
    instr = re.sub(r"ls -[aA]*l[aA]*", "ls -1", instr)
    instr = re.sub(r"ls -[aA]*", "ls -1", instr)
    return instr.replace("ls -A", "ls -1")


def _augment_instruction_for_files_txt(instr: str) -> str:
    """Augment instruction to properly generate files.txt."""
    if "files.txt" in instr:
        lower_instr = instr.lower()
        if "list" in lower_instr or "ls" in lower_instr or "rg --files" in lower_instr:
             # Safer find command that avoids ./ prefix and excluding files.txt itself
             instr = SAFE_FILES_TXT_COMMAND
        else:
             if "exclude files.txt" not in lower_instr:
                 instr = instr + " Exclude files.txt from the output."
             if "sort" not in lower_instr:
                 instr = instr + " Sort names one per line."
    return instr


def _check_missing_files_for_modify(action: Dict[str, Any], workdir: str, logger_override=None) -> str:
    """Check if targets exist for modification actions, augment instruction if missing."""
    active_logger = logger_override or logger
    instr = action.get("instruction", "") or ""
    targets = action.get("targets", [])
    lower_instr = instr.lower()

    is_modify_op = any(kw in lower_instr for kw in MODIFY_KEYWORDS)

    if is_modify_op and targets and workdir:
        missing_files = []
        for target in targets:
            full_path = os.path.abspath(os.path.join(workdir, target))
            if not full_path.startswith(os.path.abspath(workdir) + os.sep):
                active_logger.warning("[Sanitize] Skipping unsafe target path: %s", target)
                missing_files.append(target)
                continue
            if not os.path.exists(full_path):
                missing_files.append(target)
        
        if missing_files:
            missing_list = ", ".join(missing_files)
            instr = (
                f"IMPORTANT: The following file(s) do NOT exist and must be CREATED first: {missing_list}. "
                f"Create the file(s) with appropriate content before proceeding. "
                f"Original instruction: {instr}"
            )
            active_logger.info(f"[Sanitize] Augmented instruction for missing files: {missing_list}")
            
    return instr


def _add_verification_steps(action: Dict[str, Any], verify_templates: Dict[str, List[str]]) -> List[str]:
    """Add standard verification steps based on action type."""
    verify = list(action.get("verify") or [])
    verify_set = set(verify)
    instr_lower = str(action.get("instruction", "")).lower()
    targets = action.get("targets", [])

    if action["type"] == "shell":
        is_file_op = any(kw in instr_lower for kw in ["create", "write", ">", "touch"])
        if is_file_op and targets:
            for target in targets:
                check = f"files_exist:{target}"
                if check not in verify_set:
                    verify.append(check)
                    verify_set.add(check)
    else:
        template = verify_templates.get(action["type"], [])
        for v in template:
            if v not in verify_set:
                verify.append(v)
                verify_set.add(v)
    
    # Specific checks for files.txt generation
    if "files.txt" in action.get("instruction", ""):
        for check in FILES_TXT_VERIFICATION_CHECKS:
            if check not in verify_set:
                verify.append(check)
                verify_set.add(check)
                
    return verify


def sanitize_actions(
    actions: List[Dict[str, Any]],
    workdir: str,
    verify_templates: Dict[str, List[str]],
    logger_override=None,
) -> List[Dict[str, Any]]:
    """액션 목록을 후처리하여 위험/비일관 지시를 교정."""
    active_logger = logger_override or logger
    sanitized = []
    for action in actions:
        a = dict(action)
        instr = a.get("instruction", "") or ""
        
        # 1. Normalize ls commands
        instr = _normalize_ls_command(instr)
        
        # 2. Augment for files.txt
        instr = _augment_instruction_for_files_txt(instr)
        
        a["instruction"] = instr
        
        # 3. Check for missing files in modify/edit operations
        a["instruction"] = _check_missing_files_for_modify(a, workdir, active_logger)
        
        # 4. Set defaults
        if "type" not in a:
            a["type"] = DEFAULT_ACTION_TYPE
        if "client" not in a:
            a["client"] = DEFAULT_ACTION_CLIENT
            
        # 5. Add verification steps
        a["verify"] = _add_verification_steps(a, verify_templates)

        sanitized.append(a)
    return sanitized


def parse_llm_response(text: str, logger) -> Optional[Dict[str, Any]]:
    """LLM 응답에서 JSON을 추출/파싱 (Regex 기반으로 개선)."""
    if not text:
        return None
        
    stripped = text.strip()
    
    # Try Regex first - looking for biggest block enclosed in brackets
    # This handles "Reasoning: ... { JSON }"
    json_match = re.search(r'(\{[\s\S]*\})', stripped)
    
    candidates = []
    if json_match:
         candidates.append(json_match.group(1))

    # Basic substring fallback (handles cases where regex might be too strict or confused)
    start = stripped.find("{")
    end = stripped.rfind("}")
    if start != -1 and end != -1 and end > start:
        candidates.append(stripped[start : end + 1])
        
    for candidate in candidates:
        try:
            # Clean up markdown code blocks if inside the candidate
            if candidate.startswith("```"):
                 candidate = candidate.strip("`").strip()
                 if candidate.startswith("json"):
                     candidate = candidate[4:].strip()
            
            return json.loads(candidate)
        except json.JSONDecodeError:
            continue
            
    logger.debug("Failed to extract JSON from LLM response.")
    return None
