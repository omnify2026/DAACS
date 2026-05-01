"""
DAACS Orchestrator Verification
액션 결과 검증 로직
"""
import os
from typing import Dict, Any, List, Optional

from ..utils import setup_logger
from ..graph.verifier.static_checks import (
    files_exist as sc_files_exist,
    files_not_empty as sc_files_not_empty,
    files_no_hidden as sc_files_no_hidden,
)

logger = setup_logger("Verification")


class ActionVerifier:
    """액션 실행 결과 검증 클래스"""
    
    def __init__(self, workdir: str = "."):
        self.workdir = workdir
        
    def verify(self, action: Dict[str, Any], result: str) -> Dict[str, Any]:
        """
        액션 결과 검증
        
        Args:
            action: 실행된 액션 정보 (verify 필드 포함)
            result: 실행 결과 문자열
            
        Returns:
            {"success": bool, "verdicts": [{"ok": bool, "reason": str}, ...]}
        """
        verdicts: List[Dict[str, Any]] = []
        verify_items = action.get("verify", []) or []
        result_lower = result.lower()
        
        def add_verdict(ok: bool, reason: str):
            verdicts.append({"ok": ok, "reason": reason})
        
        # 결과에 error/exception 포함 시 즉시 실패
        if "error" in result_lower or "exception" in result_lower:
            add_verdict(False, "result contains error")
            return {"success": False, "verdicts": verdicts}
        
        # 표준 검증 항목들
        self._verify_tests(verify_items, result_lower, add_verdict)
        self._verify_lint(verify_items, result_lower, add_verdict)
        self._verify_build(verify_items, result_lower, add_verdict)
        
        # 파일 기반 검증
        for item in verify_items:
            if item.startswith("files_exist:"):
                self._verify_file_exists(item, add_verdict)
            elif item.startswith("files_not_empty:"):
                self._verify_file_not_empty(item, add_verdict)
            elif item.startswith("files_no_hidden:"):
                self._verify_no_hidden_files(item, add_verdict)
            elif item.startswith("files_match_listing:"):
                self._verify_file_listing(item, add_verdict)
            elif item == "quality_pass":
                add_verdict("quality_pass" in result_lower, "quality_pass")
            elif not item.startswith(("tests_", "lint_", "build_")):
                add_verdict(True, f"unknown verifier ignored: {item}")
        
        success = all(v["ok"] for v in verdicts) if verdicts else True
        return {"success": success, "verdicts": verdicts}
    
    def _resolve_path(self, path: str) -> str:
        """상대 경로를 workdir 기준 절대 경로로 변환"""
        if not os.path.isabs(path):
            return os.path.abspath(os.path.join(self.workdir, path))
        return path
    
    def _verify_tests(self, verify_items: List[str], result_lower: str, add_verdict):
        """테스트 관련 검증"""
        if "tests_pass" in verify_items:
            ok = "fail" not in result_lower and "error" not in result_lower
            add_verdict(ok, "tests_pass")
        if "tests_no_error" in verify_items:
            ok = "error" not in result_lower
            add_verdict(ok, "tests_no_error")
    
    def _verify_lint(self, verify_items: List[str], result_lower: str, add_verdict):
        """린트 관련 검증"""
        if "lint_pass" in verify_items:
            ok = "lint" in result_lower and ("pass" in result_lower or "no issues" in result_lower)
            add_verdict(ok, "lint_pass")
    
    def _verify_build(self, verify_items: List[str], result_lower: str, add_verdict):
        """빌드 관련 검증"""
        if "build_success" in verify_items:
            ok = "build failed" not in result_lower and "error" not in result_lower
            add_verdict(ok, "build_success")
    
    def _verify_file_exists(self, item: str, add_verdict):
        """파일 존재 여부 검증 (delegates to static_checks)"""
        path = item.split(":", 1)[1]
        path = self._resolve_path(path)
        result = sc_files_exist([path])
        add_verdict(result["ok"], f"files_exist:{path}")
    
    def _verify_file_not_empty(self, item: str, add_verdict):
        """파일이 비어있지 않은지 검증 (delegates to static_checks)"""
        path = item.split(":", 1)[1]
        path = self._resolve_path(path)
        result = sc_files_not_empty([path])
        add_verdict(result["ok"], result["reason"])
    
    def _verify_no_hidden_files(self, item: str, add_verdict):
        """숨김 파일이 없는지 검증"""
        path = item.split(":", 1)[1]
        path = self._resolve_path(path)
        ok = True
        try:
            if os.path.exists(path):
                with open(path, "r", encoding="utf-8", errors="ignore") as f:
                    for line in f:
                        name = line.strip()
                        if name.startswith("."):
                            ok = False
                            break
            else:
                ok = False
        except OSError:
            logger.debug("Failed to scan hidden files for %s", path, exc_info=True)
            ok = False
        add_verdict(ok, f"files_no_hidden:{path}")
    
    def _verify_file_listing(self, item: str, add_verdict):
        """파일 목록 일치 여부 검증"""
        path = item.split(":", 1)[1]
        try:
            if not os.path.exists(path):
                add_verdict(False, f"files_match_listing:{path} (missing)")
                return
                
            with open(path, "r", encoding="utf-8", errors="ignore") as f:
                content = [line.strip() for line in f if line.strip()]
                
            expected = sorted([
                p for p in os.listdir(".") 
                if not p.startswith(".") and p != path
            ])
            content_filtered = sorted([p for p in content if p != path])
            ok = content_filtered == expected
            add_verdict(ok, f"files_match_listing:{path} (self-excluded)")
        except (OSError, ValueError):
            logger.debug("Failed to compare file listing for %s", path, exc_info=True)
            add_verdict(False, f"files_match_listing:{path} (exception)")


# 편의 함수
def verify_action(action: Dict[str, Any], result: str, workdir: str = ".") -> Dict[str, Any]:
    """간편한 검증 함수"""
    verifier = ActionVerifier(workdir)
    return verifier.verify(action, result)
