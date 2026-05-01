from typing import Any, Dict, List

from daacs.config import (
    QUALITY_COVERAGE_MIN,
    QUALITY_COVERAGE_TARGETS,
    QUALITY_GATE_TOOLS,
    QUALITY_PYTHONPATHS,
    QUALITY_RADON_EXCLUDE,
    QUALITY_RADON_MAX_COMPLEXITY,
)


def quality_gate_actions() -> List[Dict[str, Any]]:
    tools = " ".join(QUALITY_GATE_TOOLS)
    pythonpath = ":".join(path for path in QUALITY_PYTHONPATHS if path)
    coverage_targets = " ".join(f"--cov={target}" for target in QUALITY_COVERAGE_TARGETS if target)
    instruction = (
        "Run the following bash script strictly. Missing tools or threshold failures must exit non-zero.\n"
        "set -e\n"
        "# Check tool installation with helpful messages\n"
        f"for tool in {tools}; do\n"
        "  if ! command -v \"$tool\" > /dev/null 2>&1; then\n"
        "    echo \"FAIL: $tool not installed. Install with: pip install $tool\"\n"
        "    exit 1\n"
        "  fi\n"
        "done\n"
        "echo '=== Running Quality Gates ==='\n"
        "# Ruff: Fast Python linter (limit to source/tests)\n"
        "echo 'Running ruff check...'\n"
        "ruff check daacs project tests || { echo '✗ ruff failed'; exit 1; }\n"
        "echo '✓ ruff passed'\n"
        "# MyPy: Type checking (gradual, not strict to allow existing code)\n"
        "echo 'Running mypy...'\n"
        "mypy --check-untyped-defs --disallow-any-unimported --ignore-missing-imports daacs project tests || { echo '✗ mypy failed'; exit 1; }\n"
        "echo '✓ mypy passed'\n"
        "# Bandit: Security scanner (HIGH severity only)\n"
        "echo 'Running bandit (HIGH severity filter)...'\n"
        "bandit -r daacs project tests -lll -q || { echo '✗ bandit found HIGH severity issues'; exit 1; }\n"
        "echo '✓ bandit passed (no HIGH issues)'\n"
        "# Radon: Complexity analysis (JSON parsing for stability)\n"
        "echo 'Running radon complexity check...'\n"
        f"RADON_JSON=$(mktemp)\nexport RADON_JSON\nradon cc -j . --exclude '{QUALITY_RADON_EXCLUDE}' > \"$RADON_JSON\"\n"
        "python3 - <<'PY'\n"
        "import json, sys\n"
        "try:\n"
        "    import os\n"
        "    radon_json = os.environ.get('RADON_JSON')\n"
        "    if not radon_json:\n"
        "        print('✗ radon parsing error: RADON_JSON not set')\n"
        "        sys.exit(1)\n"
        "    with open(radon_json) as f:\n"
        "        data = json.load(f)\n"
        "    max_cc = 0\n"
        "    for file_path, items in data.items():\n"
        "        for item in items:\n"
        "            if 'complexity' in item:\n"
        "                max_cc = max(max_cc, item['complexity'])\n"
        f"    if max_cc > {QUALITY_RADON_MAX_COMPLEXITY}:\n"
        f"        print(f'✗ FAIL: Max complexity {{max_cc}} > {QUALITY_RADON_MAX_COMPLEXITY}')\n"
        "        sys.exit(1)\n"
        f"    print(f'✓ radon passed: Max complexity {{max_cc}} <= {QUALITY_RADON_MAX_COMPLEXITY}')\n"
        "except Exception as e:\n"
        "    print(f'✗ radon parsing error: {e}')\n"
        "    sys.exit(1)\n"
        "PY\n"
        "# Pytest: Unit tests with coverage\n"
        "echo 'Running pytest with coverage...'\n"
        f"PYTHONPATH=\"{pythonpath}\" pytest --maxfail=1 {coverage_targets} --cov-fail-under={QUALITY_COVERAGE_MIN} -q "
        f"&& echo '✓ pytest passed (coverage ≥{QUALITY_COVERAGE_MIN}%)' || {{ echo '✗ pytest failed or coverage <{QUALITY_COVERAGE_MIN}%'; exit 1; }}\n"
        "echo '=== All Quality Gates Passed ==='\n"
        "echo QUALITY_PASS\n"
    )
    return [
        {
            "action": "dev_instruction",
            "type": "quality",
            "instruction": instruction,
            "verify": ["quality_pass"],
            "comment": "Run quality gates (ruff/mypy/bandit/radon/pytest+coverage) with thresholds",
            "targets": [],
            "client": "backend",
        }
    ]
