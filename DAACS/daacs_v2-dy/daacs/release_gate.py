from datetime import datetime
import json
import os
from typing import Any, Dict, List, Optional

from .graph.enhanced_nodes import api_spec_validation_node, consistency_check_node
from .graph.enhanced_verification import EnhancedVerificationTemplates
from .config import (
    RELEASE_GATE_MAX_FILES,
    RELEASE_GATE_PERF_THRESHOLD,
    RELEASE_GATE_STABILITY_RUNS,
)
from .utils import setup_logger

BASELINE_FILE = ".daacs_release_gate_baseline.json"
logger = setup_logger("ReleaseGate")


def _collect_code_files(workdir: str, max_files: int = RELEASE_GATE_MAX_FILES) -> List[str]:
    if not os.path.isdir(workdir):
        logger.warning("_collect_code_files: workdir does not exist: %s", workdir)
        return []
    
    files: List[str] = []
    for root, dirs, filenames in os.walk(workdir):
        dirs[:] = [d for d in dirs if d not in ["node_modules", ".git", "__pycache__", "venv"]]
        for name in filenames:
            if name.endswith((".py", ".js", ".jsx", ".ts", ".tsx", ".html")):
                files.append(os.path.join(root, name))
                if len(files) >= max_files:
                    return files
    return files


def _baseline_path(workdir: str) -> str:
    return os.path.join(workdir, BASELINE_FILE)


def _load_baseline(workdir: str) -> Optional[Dict[str, Any]]:
    path = _baseline_path(workdir)
    if not os.path.exists(path):
        return None
    try:
        with open(path, "r", encoding="utf-8") as f:
            return json.load(f)
    except Exception as e:
        logger.warning("Failed to load baseline: %s", e)
        return None


def _save_baseline(workdir: str, baseline: Dict[str, Any]) -> None:
    path = _baseline_path(workdir)
    try:
        with open(path, "w", encoding="utf-8") as f:
            json.dump(baseline, f, ensure_ascii=False, indent=2)
    except Exception as e:
        # Log but don't crash - baseline save is not critical
        logger.warning("Failed to save baseline to %s: %s", path, e)


def _build_baseline(results: Dict[str, Any]) -> Dict[str, Any]:
    semantic = results.get("semantic_consistency", {}) or {}
    performance = results.get("performance_baseline", {}) or {}
    race = results.get("frontend_race_state_check", {}) or {}
    stability = results.get("stability_test", {}) or {}
    e2e = results.get("e2e_test_run", {}) or {}

    metrics = {}
    for metric in performance.get("metrics", []) or []:
        name = metric.get("metric_name")
        value = metric.get("value")
        if name is not None and value is not None:
            metrics[name] = value

    return {
        "created_at": datetime.now().isoformat(),
        "semantic": {
            "issues_count": len(semantic.get("issues", []) or []),
            "feature_coverage": semantic.get("feature_coverage"),
            "total_features": semantic.get("total_features"),
        },
        "performance": metrics,
        "race_issues": len(race.get("issues", []) or []),
        "stability_ok": bool(stability.get("ok", True)),
        "e2e_ok": bool(e2e.get("ok", True)),
    }


def _compare_baseline(baseline: Dict[str, Any], results: Dict[str, Any]) -> Dict[str, Any]:
    regressions = []
    semantic = results.get("semantic_consistency", {}) or {}
    performance = results.get("performance_baseline", {}) or {}
    race = results.get("frontend_race_state_check", {}) or {}
    stability = results.get("stability_test", {}) or {}
    e2e = results.get("e2e_test_run", {}) or {}

    base_semantic = baseline.get("semantic", {}) or {}
    base_issue_count = int(base_semantic.get("issues_count", 0))
    current_issue_count = len(semantic.get("issues", []) or [])
    if current_issue_count > base_issue_count:
        regressions.append("semantic_issue_count_increased")

    base_total = base_semantic.get("total_features")
    base_coverage = base_semantic.get("feature_coverage")
    current_total = semantic.get("total_features")
    current_coverage = semantic.get("feature_coverage")
    if base_total and current_total and base_total > 0 and current_total > 0:
        base_ratio = float(base_coverage or 0) / float(base_total)
        current_ratio = float(current_coverage or 0) / float(current_total)
        if current_ratio < base_ratio:
            regressions.append("semantic_feature_coverage_decreased")

    base_perf = baseline.get("performance", {}) or {}
    current_metrics = {}
    for metric in performance.get("metrics", []) or []:
        name = metric.get("metric_name")
        value = metric.get("value")
        if name is not None and value is not None:
            current_metrics[name] = value
    for name, base_value in base_perf.items():
        current_value = current_metrics.get(name)
        if isinstance(base_value, (int, float)) and isinstance(current_value, (int, float)):
            if current_value > base_value * RELEASE_GATE_PERF_THRESHOLD:
                regressions.append(f"performance_regression:{name}")

    base_race = int(baseline.get("race_issues", 0))
    current_race = len(race.get("issues", []) or [])
    if current_race > base_race:
        regressions.append("frontend_race_issues_increased")

    if baseline.get("stability_ok", True) and not stability.get("ok", True):
        regressions.append("stability_failed")

    if baseline.get("e2e_ok", True) and not e2e.get("ok", True):
        regressions.append("e2e_failed")

    return {
        "ok": len(regressions) == 0,
        "reason": "No regressions" if not regressions else "Regressions detected",
        "template": "regression_check",
        "regressions": regressions,
    }


def compute_release_gate(
    goal: str,
    api_spec: Dict[str, Any],
    needs_backend: bool,
    needs_frontend: bool,
    workdir: str,
    scaffold_e2e: bool = False,
) -> Dict[str, Any]:
    fullstack_required = bool(needs_backend and needs_frontend)
    state = {
        "current_goal": goal,
        "api_spec": api_spec,
        "needs_backend": needs_backend,
        "needs_frontend": needs_frontend,
    }

    results: Dict[str, Any] = {}
    results["api_spec_validation"] = api_spec_validation_node(state)
    if fullstack_required:
        results["consistency_check"] = consistency_check_node(
            {
                "project_dir": workdir,
                "api_spec": api_spec,
            }
        )

    files = _collect_code_files(workdir)
    results["semantic_consistency"] = EnhancedVerificationTemplates.semantic_consistency(
        goal=goal,
        files=files,
    )

    if needs_frontend:
        results["e2e_scaffold"] = EnhancedVerificationTemplates.e2e_test_scaffold(workdir)
        results["e2e_scenarios"] = EnhancedVerificationTemplates.e2e_generate_scenarios(workdir, goal)
        results["runtime_frontend"] = EnhancedVerificationTemplates.runtime_test_frontend(workdir)
        results["frontend_race_state_check"] = EnhancedVerificationTemplates.frontend_race_state_check(workdir)
        results["e2e_test_run"] = EnhancedVerificationTemplates.e2e_test_run(workdir)

    if needs_backend or needs_frontend:
        results["output_presence"] = EnhancedVerificationTemplates.project_output_presence(
            workdir,
            needs_backend=needs_backend,
            needs_frontend=needs_frontend,
        )

    if needs_backend:
        results["runtime_backend"] = EnhancedVerificationTemplates.runtime_test_backend(workdir)

    results["stability_test"] = EnhancedVerificationTemplates.stability_test(
        workdir,
        runs=RELEASE_GATE_STABILITY_RUNS,
        needs_backend=needs_backend,
        needs_frontend=needs_frontend,
        skip_initial_install=needs_frontend,
    )

    results["performance_baseline"] = EnhancedVerificationTemplates.performance_baseline(workdir)

    auto_checks = []
    api_spec_result = results.get("api_spec_validation") or {}
    api_spec_ok = api_spec_result.get("api_spec_valid", True)
    if fullstack_required and not api_spec_ok:
        auto_checks.append(False)
    else:
        auto_checks.append(True)

    if fullstack_required:
        consistency_result = results.get("consistency_check") or {}
        auto_checks.append(bool(consistency_result.get("consistency_passed", True)))

    semantic_result = results.get("semantic_consistency") or {}
    auto_checks.append(bool(semantic_result.get("ok", True)))
    if needs_backend or needs_frontend:
        output_presence = results.get("output_presence") or {}
        auto_checks.append(bool(output_presence.get("ok", True)))
    if needs_backend:
        runtime_backend = results.get("runtime_backend") or {}
        auto_checks.append(bool(runtime_backend.get("ok", True)))
    if needs_frontend:
        runtime_frontend = results.get("runtime_frontend") or {}
        auto_checks.append(bool(runtime_frontend.get("ok", True)))
        race_check = results.get("frontend_race_state_check") or {}
        auto_checks.append(bool(race_check.get("ok", True)))
        e2e_result = results.get("e2e_test_run") or {}
        auto_checks.append(bool(e2e_result.get("ok", True)))
    if needs_backend or needs_frontend:
        stability = results.get("stability_test") or {}
        auto_checks.append(bool(stability.get("ok", True)))
    perf_result = results.get("performance_baseline") or {}
    auto_checks.append(bool(perf_result.get("ok", True)))

    baseline = _load_baseline(workdir)
    if baseline:
        results["regression_check"] = _compare_baseline(baseline, results)
    else:
        results["regression_check"] = {
            "ok": True,
            "reason": "Baseline not found",
            "template": "regression_check",
            "regressions": [],
        }
    auto_checks.append(bool(results["regression_check"].get("ok", True)))

    auto_ok = all(auto_checks)
    manual_gates = ["refactoring_behavior_consistency"]
    if needs_backend:
        manual_gates.append("backend_integration_validation")
    if fullstack_required:
        manual_gates.append("e2e_flow_validation")

    status = "pass" if auto_ok and not manual_gates else "conditional" if auto_ok else "fail"

    if baseline is None and auto_ok:
        _save_baseline(workdir, _build_baseline(results))

    return {
        "status": status,
        "auto_ok": auto_ok,
        "fullstack_required": fullstack_required,
        "manual_gates": manual_gates,
        "results": results,
        "checked_at": datetime.now().isoformat(),
    }
