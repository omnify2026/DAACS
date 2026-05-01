from typing import List
from .types import RFIResult

def build_queries(rfi: RFIResult, current_year: int = 2025) -> List[str]:
    """
    Constructs search queries based on the RFI result.
    Focuses on trends, adoption, and comparisons for the current year.
    """
    queries = []
    
    # Generic constraint queries
    for constraint in rfi.constraints:
        if "fast" in constraint.lower() or "speed" in constraint.lower():
            queries.append(f"high performance web framework {current_year} benchmarks")
        if "scale" in constraint.lower():
            queries.append(f"scalable backend architecture patterns {current_year}")

    # UI / Frontend related
    if rfi.ui_required:
        queries.append(f"frontend framework trends {current_year} adoption")
        queries.append(f"best react state management {current_year} for small apps")

    # Platform specific
    if rfi.platform == "desktop":
        queries.append(f"Electron vs Tauri {current_year} performance comparison")
        queries.append(f"desktop app frameworks python {current_year}")
    
    elif rfi.platform == "mobile":
        queries.append(f"React Native vs Flutter {current_year} market share")
        queries.append(f"cross platform mobile development trends {current_year}")

    # Language specific
    if rfi.language:
        queries.append(f"{rfi.language} backend framework trends {current_year}")
        if rfi.language.lower() == "python":
            queries.append(f"FastAPI vs Django vs Flask {current_year}")
        elif rfi.language.lower() == "typescript" or rfi.language.lower() == "javascript":
             queries.append(f"Node.js vs Bun vs Deno {current_year}")

    # Deduplicate while preserving order
    return list(dict.fromkeys(queries))
