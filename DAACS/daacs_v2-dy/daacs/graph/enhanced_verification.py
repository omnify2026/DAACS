"""
DAACS Enhanced Verification - Phase 7.3 검증 심화
semantic_consistency, runtime_test, e2e_test 등 고급 검증
"""

from typing import Any, Dict, List, Optional

from .enhanced_verification_semantic import semantic_consistency
from .enhanced_verification_runtime import (
    project_output_presence,
    runtime_test_backend,
    runtime_test_frontend,
    frontend_race_state_check,
    stability_test,
)
from .enhanced_verification_performance import performance_baseline
from .enhanced_verification_e2e import (
    e2e_test_scaffold,
    e2e_generate_scenarios,
    e2e_test_run,
)
from .enhanced_verification_replanning import (
    detect_enhanced_failure_type,
    get_enhanced_replan_strategy,
)
from .enhanced_verification_utils import find_frontend_dir


class EnhancedVerificationTemplates:
    """
    Phase 7.3 고급 검증 템플릿
    """

    @staticmethod
    def semantic_consistency(
        goal: str,
        files: List[str],
        llm_client: Optional[Any] = None,
    ) -> Dict[str, Any]:
        return semantic_consistency(goal=goal, files=files, llm_client=llm_client)

    @staticmethod
    def _find_frontend_dir(project_dir: str) -> Optional[str]:
        return find_frontend_dir(project_dir)

    @staticmethod
    def runtime_test_backend(
        project_dir: str,
        main_file: str = "main.py",
        port: int = 8099,
        timeout: int = 15,
    ) -> Dict[str, Any]:
        return runtime_test_backend(
            project_dir=project_dir,
            main_file=main_file,
            port=port,
            timeout=timeout,
        )

    @staticmethod
    def project_output_presence(
        project_dir: str,
        needs_backend: bool = True,
        needs_frontend: bool = True,
        main_file: str = "main.py",
    ) -> Dict[str, Any]:
        return project_output_presence(
            project_dir=project_dir,
            needs_backend=needs_backend,
            needs_frontend=needs_frontend,
            main_file=main_file,
        )

    @staticmethod
    def runtime_test_frontend(
        project_dir: str,
        timeout: int = 300,
        skip_install: bool = False,
    ) -> Dict[str, Any]:
        return runtime_test_frontend(
            project_dir=project_dir,
            timeout=timeout,
            skip_install=skip_install,
        )

    @staticmethod
    def performance_baseline(
        project_dir: str,
        thresholds: Optional[Dict[str, float]] = None,
    ) -> Dict[str, Any]:
        return performance_baseline(project_dir=project_dir, thresholds=thresholds)

    @staticmethod
    def e2e_test_scaffold(project_dir: str) -> Dict[str, Any]:
        return e2e_test_scaffold(project_dir)

    @staticmethod
    def e2e_generate_scenarios(project_dir: str, goal: str) -> Dict[str, Any]:
        return e2e_generate_scenarios(project_dir, goal)

    @staticmethod
    def e2e_test_run(project_dir: str, timeout: int = 120) -> Dict[str, Any]:
        return e2e_test_run(project_dir, timeout=timeout)

    @staticmethod
    def frontend_race_state_check(project_dir: str) -> Dict[str, Any]:
        return frontend_race_state_check(project_dir)

    @staticmethod
    def stability_test(
        project_dir: str,
        runs: int = 2,
        needs_backend: bool = True,
        needs_frontend: bool = True,
        skip_initial_install: bool = False,
    ) -> Dict[str, Any]:
        return stability_test(
            project_dir=project_dir,
            runs=runs,
            needs_backend=needs_backend,
            needs_frontend=needs_frontend,
            skip_initial_install=skip_initial_install,
        )


__all__ = [
    "EnhancedVerificationTemplates",
    "detect_enhanced_failure_type",
    "get_enhanced_replan_strategy",
]
