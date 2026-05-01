"""
DAACS v6.0 - Verification Templates
v5.0 검증 템플릿을 v6.0 Verifier 노드로 마이그레이션
"""

from typing import Dict, List, Any, Optional
import os

from ..utils import setup_logger
from .verifier.static_checks import files_exist, files_not_empty, files_no_hidden
from .verifier.syntax_checks import python_syntax_valid, javascript_syntax_valid
from .verifier.result_parsers import tests_pass, lint_pass, build_success, deploy_success
from .verifier.backend_checks import python_import_test, api_spec_compliance, backend_server_test, cors_middleware_check
from .verifier.frontend_checks import frontend_entrypoint_exists, frontend_build_test, frontend_smoke_test, frontend_system_smoke_test

logger = setup_logger("VerificationTemplates")


class VerificationTemplates:
    """
    Verification Templates Facade (Backward Compatibility)
    Proxies calls to specific checker modules.
    """

    @staticmethod
    def files_exist(files: List[str]) -> Dict[str, Any]:
        return files_exist(files)

    @staticmethod
    def files_not_empty(files: List[str]) -> Dict[str, Any]:
        return files_not_empty(files)

    @staticmethod
    def files_no_hidden(files: List[str]) -> Dict[str, Any]:
        return files_no_hidden(files)

    @staticmethod
    def tests_pass(result: str) -> Dict[str, Any]:
        return tests_pass(result)

    @staticmethod
    def lint_pass(result: str) -> Dict[str, Any]:
        return lint_pass(result)

    @staticmethod
    def build_success(returncode: int, stderr: str = "") -> Dict[str, Any]:
        return build_success(returncode, stderr)
    
    @staticmethod
    def deploy_success(returncode: int, stderr: str = "") -> Dict[str, Any]:
        return deploy_success(returncode, stderr)

    @staticmethod
    def python_syntax_valid(files: List[str]) -> Dict[str, Any]:
        return python_syntax_valid(files)

    @staticmethod
    def javascript_syntax_valid(files: List[str]) -> Dict[str, Any]:
        return javascript_syntax_valid(files)
    
    @staticmethod
    def python_import_test(files: List[str]) -> Dict[str, Any]:
        return python_import_test(files)
        
    @staticmethod
    def api_spec_compliance(files: List[str], api_spec: Dict, fullstack_required: bool = False) -> Dict[str, Any]:
        return api_spec_compliance(files, api_spec, fullstack_required)

    @staticmethod
    def backend_server_test(project_dir: str, main_file: str = "main.py", port: int = 8080) -> Dict[str, Any]:
        return backend_server_test(project_dir, main_file, port)

    @staticmethod
    def frontend_entrypoint_exists(files: List[str]) -> Dict[str, Any]:
        return frontend_entrypoint_exists(files)
    
    @staticmethod
    def frontend_build_test(project_dir: str) -> Dict[str, Any]:
        return frontend_build_test(project_dir)
    
    @staticmethod
    def frontend_smoke_test(project_dir: str) -> Dict[str, Any]:
        return frontend_smoke_test(project_dir)
    
    @staticmethod
    def frontend_system_smoke_test(project_dir: str) -> Dict[str, Any]:
        """System Smoke Test - /api/health (required, fast)"""
        return frontend_system_smoke_test(project_dir)


# 액션 타입별 템플릿 매핑 (v5.0과 동일 + 확장)
TYPE_TO_TEMPLATES = {
    "files": ["files_exist", "files_not_empty", "files_no_hidden"],
    "test": ["files_exist", "tests_pass"],
    "lint": ["files_exist", "lint_pass"],
    "build": ["files_exist", "build_success"],
    "deploy": ["files_exist", "deploy_success"],
    "codegen": ["files_exist", "files_not_empty"],
    "refactor": ["files_exist", "files_not_empty", "tests_pass"],
    "shell": ["files_exist"],
    # v6.1: 실행 검증 포함
    "backend": ["files_exist", "files_not_empty", "python_syntax_valid", "python_import_test", "api_spec_compliance", "cors_middleware_check"],
    # v6.2: Dual Smoke Test - system_smoke_test (required) + smoke_test (optional for UI)
    "frontend": ["files_exist", "frontend_entrypoint_exists", "files_not_empty", "javascript_syntax_valid", "frontend_build_test", "frontend_system_smoke_test"],
    # 전체 실행 테스트 (선택적) - UI smoke test included
    "backend_full": ["files_exist", "files_not_empty", "python_syntax_valid", "python_import_test", "backend_server_test", "api_spec_compliance", "cors_middleware_check"],
    "frontend_full": ["files_exist", "frontend_entrypoint_exists", "files_not_empty", "javascript_syntax_valid", "frontend_build_test", "frontend_system_smoke_test", "frontend_smoke_test"],
}


def _resolve_frontend_project_dir(files: List[str]) -> Optional[str]:
    for f in files:
        if f.endswith('package.json'):
            return os.path.dirname(f)
    if not files:
        return None
    first_file = files[0]
    if os.path.isabs(first_file):
        project_dir = os.path.dirname(first_file)
        if os.path.basename(project_dir) == 'src':
            return os.path.dirname(project_dir)
        return project_dir
    return os.getcwd()

# Handlers
def _handle_files_exist(vt: VerificationTemplates, context: Dict[str, Any]) -> Dict[str, Any]:
    return vt.files_exist(context["files"])

def _handle_files_not_empty(vt: VerificationTemplates, context: Dict[str, Any]) -> Dict[str, Any]:
    return vt.files_not_empty(context["files"])

def _handle_files_no_hidden(vt: VerificationTemplates, context: Dict[str, Any]) -> Dict[str, Any]:
    return vt.files_no_hidden(context["files"])

def _handle_tests_pass(vt: VerificationTemplates, context: Dict[str, Any]) -> Optional[Dict[str, Any]]:
    if context["test_result"] is None: return None
    return vt.tests_pass(context["test_result"])

def _handle_lint_pass(vt: VerificationTemplates, context: Dict[str, Any]) -> Optional[Dict[str, Any]]:
    if context["lint_result"] is None: return None
    return vt.lint_pass(context["lint_result"])

def _handle_build_success(vt: VerificationTemplates, context: Dict[str, Any]) -> Optional[Dict[str, Any]]:
    if context["build_returncode"] is None: return None
    return vt.build_success(context["build_returncode"], context["build_stderr"] or "")

def _handle_deploy_success(vt: VerificationTemplates, context: Dict[str, Any]) -> Optional[Dict[str, Any]]:
    if context["build_returncode"] is None: return None
    return vt.deploy_success(context["build_returncode"], context["build_stderr"] or "")

def _handle_python_syntax_valid(vt: VerificationTemplates, context: Dict[str, Any]) -> Dict[str, Any]:
    changed_files = context.get("changed_files")
    if changed_files is not None:
        if not changed_files:
            return {
                "ok": True,
                "reason": "No Python changes; syntax check skipped",
                "template": "python_syntax_valid",
                "skipped": True,
            }
        return vt.python_syntax_valid(changed_files)
    return vt.python_syntax_valid(context["files"])

def _handle_javascript_syntax_valid(vt: VerificationTemplates, context: Dict[str, Any]) -> Dict[str, Any]:
    changed_files = context.get("changed_files")
    if changed_files is not None:
        if not changed_files:
            return {
                "ok": True,
                "reason": "No frontend changes; syntax check skipped",
                "template": "javascript_syntax_valid",
                "skipped": True,
            }
        return vt.javascript_syntax_valid(changed_files)
    return vt.javascript_syntax_valid(context["files"])

def _handle_api_spec_compliance(vt: VerificationTemplates, context: Dict[str, Any]) -> Optional[Dict[str, Any]]:
    if context["api_spec"] is None: return None
    changed_files = context.get("changed_files")
    if changed_files is not None and not changed_files:
        return {
            "ok": True,
            "reason": "No backend changes; API spec check skipped",
            "template": "api_spec_compliance",
            "skipped": True,
        }
    return vt.api_spec_compliance(context["files"], context["api_spec"], context.get("fullstack_required", False))

def _handle_python_import_test(vt: VerificationTemplates, context: Dict[str, Any]) -> Dict[str, Any]:
    changed_files = context.get("changed_files")
    if changed_files is not None:
        if not changed_files:
            return {
                "ok": True,
                "reason": "No Python changes; import check skipped",
                "template": "python_import_test",
                "skipped": True,
            }
        return vt.python_import_test(changed_files)
    return vt.python_import_test(context["files"])

def _handle_frontend_build_test(vt: VerificationTemplates, context: Dict[str, Any]) -> Optional[Dict[str, Any]]:
    if not context["files"]: return None
    project_dir = _resolve_frontend_project_dir(context["files"])
    if not project_dir: return None
    return vt.frontend_build_test(project_dir)

def _handle_frontend_smoke_test(vt: VerificationTemplates, context: Dict[str, Any]) -> Optional[Dict[str, Any]]:
    if not context["files"]: return None
    project_dir = _resolve_frontend_project_dir(context["files"])
    if not project_dir: return None
    return vt.frontend_smoke_test(project_dir)

def _handle_frontend_system_smoke_test(vt: VerificationTemplates, context: Dict[str, Any]) -> Optional[Dict[str, Any]]:
    """System Smoke Test - /api/health (required, fast, no page compilation)."""
    if not context["files"]: return None
    project_dir = _resolve_frontend_project_dir(context["files"])
    if not project_dir: return None
    return vt.frontend_system_smoke_test(project_dir)

def _handle_frontend_entrypoint_exists(vt: VerificationTemplates, context: Dict[str, Any]) -> Dict[str, Any]:
    return vt.frontend_entrypoint_exists(context["files"])

def _handle_backend_server_test(vt: VerificationTemplates, context: Dict[str, Any]) -> Optional[Dict[str, Any]]:
    if not context["files"]: return None
    project_dir = os.path.dirname(context["files"][0])
    if not project_dir: return None
    return vt.backend_server_test(project_dir)

def _handle_cors_middleware_check(vt: VerificationTemplates, context: Dict[str, Any]) -> Optional[Dict[str, Any]]:
    """Handle CORS middleware check for frontend+backend projects."""
    needs_frontend = context.get("needs_frontend", False)
    return cors_middleware_check(context["files"], needs_frontend=needs_frontend)


TEMPLATE_HANDLERS = {
    "files_exist": _handle_files_exist,
    "files_not_empty": _handle_files_not_empty,
    "files_no_hidden": _handle_files_no_hidden,
    "tests_pass": _handle_tests_pass,
    "lint_pass": _handle_lint_pass,
    "build_success": _handle_build_success,
    "deploy_success": _handle_deploy_success,
    "python_syntax_valid": _handle_python_syntax_valid,
    "javascript_syntax_valid": _handle_javascript_syntax_valid,
    "api_spec_compliance": _handle_api_spec_compliance,
    "python_import_test": _handle_python_import_test,
    "frontend_build_test": _handle_frontend_build_test,
    "frontend_smoke_test": _handle_frontend_smoke_test,
    "frontend_system_smoke_test": _handle_frontend_system_smoke_test,
    "frontend_entrypoint_exists": _handle_frontend_entrypoint_exists,
    "backend_server_test": _handle_backend_server_test,
    "cors_middleware_check": _handle_cors_middleware_check,
}


def run_verification(
    action_type: str,
    files: List[str],
    changed_files: Optional[List[str]] = None,
    test_result: Optional[str] = None,
    lint_result: Optional[str] = None,
    build_returncode: Optional[int] = None,
    build_stderr: Optional[str] = None,
    api_spec: Optional[Dict] = None,
    fullstack_required: bool = False,
    runtime_checks: bool = False,
    full_verification: bool = False  # 🆕 Escalation flag
) -> Dict[str, Any]:
    """
    액션 타입에 맞는 검증 실행 (Delegates to modular checkers)
    
    full_verification: If True, escalate to _full version (e.g., frontend → frontend_full)
                      This adds UI smoke test in addition to system smoke test.
    """
    
    # 🆕 Verification Escalation: frontend → frontend_full when full_verification=True
    effective_action_type = action_type
    if full_verification and action_type == "frontend":
        effective_action_type = "frontend_full"
        logger.info("[Verification] Escalated: frontend → frontend_full (full_verification=True)")
    elif full_verification and action_type == "backend":
        effective_action_type = "backend_full"
        logger.info("[Verification] Escalated: backend → backend_full (full_verification=True)")

    templates = list(TYPE_TO_TEMPLATES.get(effective_action_type, ["files_exist"]))
    if effective_action_type == "backend" and (fullstack_required or runtime_checks):
        if "backend_server_test" not in templates:
            templates.append("backend_server_test")
            
    verdicts = []
    vt = VerificationTemplates()

    context = {
        "files": files,
        "changed_files": changed_files,
        "test_result": test_result,
        "lint_result": lint_result,
        "build_returncode": build_returncode,
        "build_stderr": build_stderr,
        "api_spec": api_spec,
        "fullstack_required": fullstack_required,
    }

    for template in templates:
        handler = TEMPLATE_HANDLERS.get(template)
        if not handler:
            continue
        verdict = handler(vt, context)
        if verdict is not None:
            verdicts.append(verdict)

    # 전체 결과
    all_passed = all(v["ok"] for v in verdicts)
    failed_reasons = [v["reason"] for v in verdicts if not v["ok"]]

    summary = "All verifications passed" if all_passed else f"Failed: {', '.join(failed_reasons)}"

    return {
        "ok": all_passed,
        "verdicts": verdicts,
        "summary": summary
    }
