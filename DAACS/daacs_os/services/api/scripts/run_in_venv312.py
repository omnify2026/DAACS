from __future__ import annotations

import subprocess
import sys
from pathlib import Path

PROJECT_ROOT = Path(__file__).resolve().parents[1]
if str(PROJECT_ROOT) not in sys.path:
    sys.path.insert(0, str(PROJECT_ROOT))

from daacs.llm.cli_env import resolve_venv_executable


def main() -> int:
    repo_root = PROJECT_ROOT
    venv_dir = repo_root / ".venv312"
    python_executable = resolve_venv_executable(venv_dir, "python")
    if python_executable is None:
        raise SystemExit(
            "services/api/.venv312 is missing a usable interpreter. "
            "Run `python3.12 services/api/scripts/rebuild_venv312.py` first."
        )
    if len(sys.argv) == 1:
        raise SystemExit("Usage: python scripts/run_in_venv312.py <python args...>")
    completed = subprocess.run([str(python_executable), *sys.argv[1:]], cwd=repo_root)
    return int(completed.returncode)


if __name__ == "__main__":
    raise SystemExit(main())
