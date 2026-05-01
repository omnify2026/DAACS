from typing import Dict, Any, List
import re

LOG_SUMMARY_LIMIT = 200

def tests_pass(result: str) -> Dict[str, Any]:
    """테스트 통과 확인"""
    fail_patterns = ["FAILED", "ERROR", "error", "failures"]
    passed = not any(pattern in result for pattern in fail_patterns)

    return {
        "ok": passed,
        "reason": "Tests passed" if passed else "Tests failed - check output",
        "template": "tests_pass",
        "details": result[:LOG_SUMMARY_LIMIT] if not passed else ""
    }

def lint_pass(result: str) -> Dict[str, Any]:
    """린트 통과 확인"""
    lint_error_patterns = ["error", "ERROR", "E[0-9]{3}", "W[0-9]{3}"]
    passed = not any(re.search(pattern, result, re.IGNORECASE) for pattern in lint_error_patterns)

    return {
        "ok": passed,
        "reason": "Lint passed" if passed else "Lint errors found",
        "template": "lint_pass",
        "details": result[:LOG_SUMMARY_LIMIT] if not passed else ""
    }

def build_success(returncode: int, stderr: str = "") -> Dict[str, Any]:
    """빌드 성공 확인"""
    success = returncode == 0
    return {
        "ok": success,
        "reason": "Build succeeded" if success else f"Build failed (code {returncode})",
        "template": "build_success",
        "details": stderr[:LOG_SUMMARY_LIMIT] if not success else ""
    }

def deploy_success(returncode: int, stderr: str = "") -> Dict[str, Any]:
    """배포 성공 확인"""
    success = returncode == 0
    return {
        "ok": success,
        "reason": "Deploy succeeded" if success else f"Deploy failed (code {returncode})",
        "template": "deploy_success",
        "details": stderr[:LOG_SUMMARY_LIMIT] if not success else ""
    }
