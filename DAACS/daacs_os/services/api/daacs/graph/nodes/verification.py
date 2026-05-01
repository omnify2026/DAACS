"""
DAACS OS — Verification Node
생성된 코드의 기본 품질 검증 (파일 존재, 구문 검사, API 스펙 준수).

Source: DAACS_v2-dy/daacs/graph/verification.py
Adapted: Sandbox 실행 대신 정적 검증 중심 (v1). 향후 SandboxManager 연동.
"""
import ast
import json
import logging
from typing import Any, Dict, List

from ...agents.base_roles import AgentRole

logger = logging.getLogger("daacs.graph.nodes.verification")

_SUPPORTED_QA_PROFILES = {"lite", "standard", "ui", "strict"}


def _check_python_syntax(code: str, file_path: str) -> Dict[str, Any]:
    """Python 파일 구문 검증."""
    try:
        ast.parse(code)
        return {"template": "python_syntax", "file": file_path, "ok": True}
    except SyntaxError as e:
        return {
            "template": "python_syntax",
            "file": file_path,
            "ok": False,
            "error": f"Line {e.lineno}: {e.msg}",
        }


def _check_json_syntax(code: str, file_path: str) -> Dict[str, Any]:
    """JSON 파일 구문 검증."""
    try:
        json.loads(code)
        return {"template": "json_syntax", "file": file_path, "ok": True}
    except json.JSONDecodeError as e:
        return {
            "template": "json_syntax",
            "file": file_path,
            "ok": False,
            "error": str(e)[:200],
        }


def _check_files_exist(files: Dict[str, str], role: str) -> Dict[str, Any]:
    """파일 존재 및 비어있지 않음 확인."""
    if not files:
        return {
            "template": "files_exist",
            "role": role,
            "ok": False,
            "error": f"No {role} files generated",
        }
    empty_files = [p for p, c in files.items() if not c.strip()]
    if empty_files:
        return {
            "template": "files_exist",
            "role": role,
            "ok": False,
            "error": f"Empty files: {empty_files}",
        }
    return {"template": "files_exist", "role": role, "ok": True, "count": len(files)}


def _check_api_endpoints(api_spec: Dict[str, Any], backend_files: Dict[str, str]) -> Dict[str, Any]:
    """API 엔드포인트 구현 여부 확인."""
    endpoints = api_spec.get("endpoints", [])
    if not endpoints:
        return {"template": "api_compliance", "ok": True, "note": "No API spec defined"}

    all_code = "\n".join(backend_files.values()).lower()
    missing = []
    for ep in endpoints:
        path = ep.get("path", "")
        if path and path.lower() not in all_code:
            missing.append(f"{ep.get('method', 'GET')} {path}")

    return {
        "template": "api_compliance",
        "ok": len(missing) == 0,
        "total_endpoints": len(endpoints),
        "missing": missing,
    }


def _check_cors(backend_files: Dict[str, str]) -> Dict[str, Any]:
    """CORS 미들웨어 존재 확인."""
    all_code = "\n".join(backend_files.values()).lower()
    has_cors = "corsMiddleware" in all_code.replace(" ", "") or "cors" in all_code
    return {
        "template": "cors_check",
        "ok": has_cors,
        "error": "CORS middleware not detected" if not has_cors else None,
    }


def _normalize_qa_profile(value: Any) -> str:
    profile = str(value or "standard").strip().lower()
    return profile if profile in _SUPPORTED_QA_PROFILES else "standard"


def _default_evidence_required(
    qa_profile: str,
    needs_backend: bool,
    needs_frontend: bool,
) -> List[str]:
    requirements: List[str] = []
    if needs_backend:
        requirements.append("backend_files")
    if needs_frontend:
        requirements.append("frontend_files")
    if qa_profile in {"standard", "ui", "strict"}:
        requirements.append("python_json_syntax")
    if needs_backend and qa_profile in {"standard", "ui", "strict"}:
        requirements.append("api_compliance")
    if needs_backend and qa_profile == "strict":
        requirements.append("cors_check")
    return requirements


def _find_detail(details: List[Dict[str, Any]], template: str, role: str | None = None) -> Dict[str, Any] | None:
    for detail in details:
        if detail.get("template") != template:
            continue
        if role is not None and detail.get("role") != role:
            continue
        return detail
    return None


def _build_verification_evidence(
    details: List[Dict[str, Any]],
    *,
    needs_backend: bool,
    needs_frontend: bool,
) -> List[Dict[str, Any]]:
    evidence: List[Dict[str, Any]] = []

    if needs_backend:
        backend_files = _find_detail(details, "files_exist", role="backend")
        evidence.append(
            {
                "check": "backend_files",
                "ok": bool(backend_files and backend_files.get("ok", False)),
                "source": "files_exist",
            }
        )

    if needs_frontend:
        frontend_files = _find_detail(details, "files_exist", role="frontend")
        evidence.append(
            {
                "check": "frontend_files",
                "ok": bool(frontend_files and frontend_files.get("ok", False)),
                "source": "files_exist",
            }
        )

    syntax_details = [
        detail for detail in details if detail.get("template") in {"python_syntax", "json_syntax"}
    ]
    evidence.append(
        {
            "check": "python_json_syntax",
            "ok": all(detail.get("ok", True) for detail in syntax_details),
            "source": "syntax",
            "count": len(syntax_details),
        }
    )

    if needs_backend:
        api_detail = _find_detail(details, "api_compliance")
        evidence.append(
            {
                "check": "api_compliance",
                "ok": bool(api_detail and api_detail.get("ok", False)),
                "source": "api_compliance",
            }
        )

        cors_detail = _find_detail(details, "cors_check")
        evidence.append(
            {
                "check": "cors_check",
                "ok": bool(cors_detail and cors_detail.get("ok", False)),
                "source": "cors_check",
            }
        )

    return evidence


def _compute_verification_gaps(
    evidence: List[Dict[str, Any]],
    required_checks: List[str],
) -> List[str]:
    evidence_by_check = {str(item.get("check")): bool(item.get("ok", False)) for item in evidence}
    gaps: List[str] = []
    for check in required_checks:
        if not evidence_by_check.get(check, False):
            gaps.append(f"Missing required evidence: {check}")
    return gaps


def _compute_verification_confidence(
    details: List[Dict[str, Any]],
    evidence: List[Dict[str, Any]],
    gaps: List[str],
) -> int:
    detail_ratio = 100
    if details:
        passed_details = sum(1 for detail in details if detail.get("ok", True))
        detail_ratio = round((passed_details / len(details)) * 100)

    evidence_ratio = 100
    if evidence:
        passed_evidence = sum(1 for item in evidence if item.get("ok", False))
        evidence_ratio = round((passed_evidence / len(evidence)) * 100)

    gap_penalty = min(len(gaps) * 15, 45)
    confidence = round((detail_ratio * 0.45) + (evidence_ratio * 0.55) - gap_penalty)
    return max(0, min(100, int(confidence)))


async def verification_node(
    state: Dict[str, Any],
    executor=None,
    manager=None,
) -> Dict[str, Any]:
    """
    Verification Node — Verifier 에이전트가 코드 품질을 정적 검증.

    검증 항목:
    1. 파일 존재 및 비어있지 않음
    2. Python/JSON 구문 검사
    3. API 스펙 준수
    4. CORS 미들웨어 존재

    Returns:
        verification_passed, verification_details
    """
    backend_files = state.get("backend_files", {})
    frontend_files = state.get("frontend_files", {})
    api_spec = state.get("api_spec", {})
    needs_backend = state.get("needs_backend", True)
    needs_frontend = state.get("needs_frontend", True)
    qa_profile = _normalize_qa_profile(state.get("qa_profile"))
    required_checks = [
        str(item).strip()
        for item in state.get("evidence_required", []) or []
        if str(item).strip()
    ]
    if not required_checks:
        required_checks = _default_evidence_required(
            qa_profile=qa_profile,
            needs_backend=bool(needs_backend),
            needs_frontend=bool(needs_frontend),
        )

    logger.info(f"[Verify] Backend={len(backend_files)} files, Frontend={len(frontend_files)} files")

    # Verifier 상태
    if manager:
        verifier = manager.get_agent(AgentRole.VERIFIER)
        if verifier:
            verifier.set_task("테스트/빌드/품질 검증")

    details: List[Dict[str, Any]] = []

    # 1. File existence
    if needs_backend:
        details.append(_check_files_exist(backend_files, "backend"))
    if needs_frontend:
        details.append(_check_files_exist(frontend_files, "frontend"))

    # 2. Syntax checks
    for path, code in backend_files.items():
        if path.endswith(".py"):
            details.append(_check_python_syntax(code, path))
        elif path.endswith(".json"):
            details.append(_check_json_syntax(code, path))

    for path, code in frontend_files.items():
        if path.endswith(".json"):
            details.append(_check_json_syntax(code, path))

    # 3. API compliance
    if needs_backend:
        details.append(_check_api_endpoints(api_spec, backend_files))

    # 4. CORS check
    if needs_backend and backend_files:
        details.append(_check_cors(backend_files))

    # Aggregate
    all_passed = all(d.get("ok", True) for d in details)
    failed_count = sum(1 for d in details if not d.get("ok", True))
    failures = [
        detail.get("error") or f"{detail.get('template', 'check')} failed"
        for detail in details
        if not detail.get("ok", True)
    ]
    evidence = _build_verification_evidence(
        details,
        needs_backend=bool(needs_backend),
        needs_frontend=bool(needs_frontend),
    )
    gaps = _compute_verification_gaps(evidence, required_checks)
    confidence = _compute_verification_confidence(details, evidence, gaps)

    # Verifier 완료
    if manager:
        verifier = manager.get_agent(AgentRole.VERIFIER)
        if verifier:
            verifier.complete_task()

    logger.info(f"[Verify] Passed={all_passed}, checks={len(details)}, failed={failed_count}")

    return {
        "verification_passed": all_passed,
        "verification_details": details,
        "verification_evidence": evidence,
        "verification_gaps": gaps,
        "verification_confidence": confidence,
        "verification_failures": failures,
        "rework_source": "verifier" if not all_passed else None,
    }
