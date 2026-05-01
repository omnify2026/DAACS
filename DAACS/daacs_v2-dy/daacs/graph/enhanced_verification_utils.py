import os
from typing import Optional


def find_frontend_dir(project_dir: str) -> Optional[str]:
    candidates = [
        project_dir,
        os.path.join(project_dir, "frontend"),
        os.path.join(project_dir, "client"),
        os.path.join(project_dir, "frontend", "client"),
    ]
    for candidate_dir in candidates:
        if os.path.exists(os.path.join(candidate_dir, "package.json")):
            return candidate_dir
    return None
