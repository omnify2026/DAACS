import json
import os
from dataclasses import asdict
from typing import Any, Dict, Optional

from ..utils import setup_logger
from .enhanced_verification_types import PerformanceMetric

logger = setup_logger("EnhancedVerification")


def performance_baseline(
    project_dir: str,
    thresholds: Optional[Dict[str, float]] = None,
) -> Dict[str, Any]:
    """
    성능 기준 검증
    - 빌드 시간
    - 파일 크기
    - 의존성 수
    """
    metrics = []

    default_thresholds = {
        "build_time_s": 60,  # 빌드 시간 60초 이하
        "bundle_size_mb": 10,  # 번들 크기 10MB 이하
        "dependency_count": 100,  # 의존성 100개 이하
    }
    thresholds = thresholds or default_thresholds

    # 1. 의존성 수 체크
    package_json = os.path.join(project_dir, "package.json")
    if os.path.exists(package_json):
        try:
            with open(package_json, "r", encoding="utf-8") as f:
                pkg = json.load(f)
            dep_count = len(pkg.get("dependencies", {})) + len(pkg.get("devDependencies", {}))

            metrics.append(
                PerformanceMetric(
                    metric_name="dependency_count",
                    value=dep_count,
                    unit="packages",
                    threshold=thresholds.get("dependency_count", 100),
                    passed=dep_count <= thresholds.get("dependency_count", 100),
                )
            )
        except (json.JSONDecodeError, OSError):
            logger.debug("Failed to read package.json for performance baseline", exc_info=True)

    requirements_txt = os.path.join(project_dir, "requirements.txt")
    if os.path.exists(requirements_txt):
        try:
            with open(requirements_txt, "r", encoding="utf-8") as f:
                lines = [l.strip() for l in f.readlines() if l.strip() and not l.startswith("#")]
            dep_count = len(lines)

            metrics.append(
                PerformanceMetric(
                    metric_name="python_dependency_count",
                    value=dep_count,
                    unit="packages",
                    threshold=thresholds.get("dependency_count", 100),
                    passed=dep_count <= thresholds.get("dependency_count", 100),
                )
            )
        except OSError:
            logger.debug("Failed to read requirements.txt for performance baseline", exc_info=True)

    # 2. 디렉토리 크기
    total_size = 0
    file_count = 0
    for root, dirs, files in os.walk(project_dir):
        dirs[:] = [d for d in dirs if d not in ["node_modules", ".git", "__pycache__", "venv", "dist"]]
        for name in files:
            try:
                fp = os.path.join(root, name)
                if os.path.isfile(fp):
                    total_size += os.path.getsize(fp)
                    file_count += 1
            except OSError:
                logger.debug("Failed to stat file for performance baseline: %s", fp, exc_info=True)

    size_mb = total_size / (1024 * 1024)
    metrics.append(
        PerformanceMetric(
            metric_name="source_size",
            value=round(size_mb, 2),
            unit="MB",
            threshold=thresholds.get("bundle_size_mb", 10),
            passed=size_mb <= thresholds.get("bundle_size_mb", 10),
        )
    )

    metrics.append(
        PerformanceMetric(
            metric_name="file_count",
            value=file_count,
            unit="files",
            threshold=500,
            passed=file_count <= 500,
        )
    )

    all_passed = all(m.passed for m in metrics)

    return {
        "ok": all_passed,
        "reason": "All performance metrics within thresholds" if all_passed else "Some metrics exceeded thresholds",
        "template": "performance_baseline",
        "metrics": [asdict(m) for m in metrics],
    }
