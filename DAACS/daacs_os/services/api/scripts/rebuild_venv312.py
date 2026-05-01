from __future__ import annotations

import os
import shutil
import subprocess
import sys
import venv
from pathlib import Path

PROJECT_ROOT = Path(__file__).resolve().parents[1]
if str(PROJECT_ROOT) not in sys.path:
    sys.path.insert(0, str(PROJECT_ROOT))

from daacs.llm.cli_env import resolve_venv_executable


def _is_windows_borrowed_venv(cfg_path: Path) -> bool:
    if not cfg_path.is_file():
        return False
    content = cfg_path.read_text(encoding="utf-8", errors="ignore").lower()
    return "c:\\" in content and "\\python" in content


def main() -> int:
    project_root = PROJECT_ROOT
    venv_dir = project_root / ".venv312"
    cfg_path = venv_dir / "pyvenv.cfg"
    requirements = project_root / "requirements.txt"

    if _is_windows_borrowed_venv(cfg_path):
        shutil.rmtree(venv_dir, ignore_errors=True)

    if resolve_venv_executable(venv_dir, "python") is None:
        builder = venv.EnvBuilder(with_pip=True, clear=True)
        builder.create(venv_dir)

    python_executable = resolve_venv_executable(venv_dir, "python")
    if python_executable is None:
        raise SystemExit("Failed to create a usable interpreter in services/api/.venv312")

    env = dict(os.environ)
    env.setdefault("PIP_DISABLE_PIP_VERSION_CHECK", "1")
    subprocess.run(
        [str(python_executable), "-m", "pip", "install", "-r", str(requirements)],
        check=True,
        cwd=project_root,
        env=env,
    )
    print(str(python_executable))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
