"""
DAACS Prompt Builder
기본 프롬프트 빌더 + 고도화된 프롬프트 통합
"""
import json
from typing import Any, Dict, Optional

# 고도화된 프롬프트 시스템 import
from .enhanced_prompts import (
    build_enhanced_orchestrator_prompt,
    AgentRole,
    extract_thinking,
    validate_action_response,
    get_enhanced_clarify_goal_prompt,
    get_enhanced_rfp_prompt,
    select_few_shot_example,
    get_few_shot_prompt,
)

# 고도화 프롬프트 사용 여부 플래그
USE_ENHANCED_PROMPTS = True


def _build_constraints_prompt(constraints_enabled: bool) -> str:
    if constraints_enabled:
        return (
            "DAACS TEST MODE is active. Apply mandatory constraints:\n"
            "- At most ONE file per turn.\n"
            "- Do NOT generate HTML/CSS/JS or other web assets.\n"
            "- Prefer CLI-based Python; keep outputs concise (<=200 lines).\n"
            "- If generating tests, create ONLY ONE dummy test (tests/test_basic.py).\n"
            "- For files.txt updates, use: find . -maxdepth 1 -mindepth 1 -not -name 'files.txt' -not -name '.*' | sed 's|^./||' | sort > files.txt\n"
        )
    return (
        "DAACS PROD MODE is active. Constraints disabled; full codegen allowed. "
        "You have access to IDE-tier extensions: Browser (web interaction), Search (web/codebase), "
        "Shell (terminal), and Image Generation. Use them via natural language instructions. "
        "Still keep responses valid JSON only.\n"
        "IMPORTANT: All test files must be created inside 'tests/' directory of the project."
    )


def _build_tech_context_prompts(tech_context: Optional[Any]) -> Dict[str, str]:
    non_negotiable_prompt = ""
    tech_context_prompt = ""

    if not tech_context:
        return {"non_negotiable": non_negotiable_prompt, "tech_context": tech_context_prompt}

    constraints = getattr(tech_context, "constraints", None) or []
    facts = getattr(tech_context, "facts", None) or []

    constraint_items = [c for c in constraints if c.startswith("CONSTRAINT:")]
    if constraint_items:
        constraint_list = "\n".join(f"- {c}" for c in constraint_items)
        non_negotiable_prompt = (
            "\n\n=== NON-NEGOTIABLE CONSTRAINTS (DO NOT VIOLATE) ===\n"
            f"{constraint_list}\n"
            "These constraints are ABOLUTE. You MUST align all architecture decisions with them.\n"
        )

    if facts:
        facts_list = "\n".join(f"- {f}" for f in facts)
        tech_context_prompt = (
            "\n\n=== TECH STACK & RFP ALIGNMENT ===\n"
            f"{facts_list}\n"
            "CRITICAL INSTRUCTION: You MUST cross-reference the Goal/RFP with these Technology Facts.\n"
            " - If RFP says 'React', do NOT build a Python backend. Build a React app.\n"
            " - If RFP says 'Client-Side', do NOT build server-side logic.\n"
            " - Use the 'client' field in actions: 'frontend' for React/Web, 'backend' for Python/API.\n"
            " - VIOLATING THE TECH STACK IS A CRITICAL FAILURE.\n"
        )

    return {"non_negotiable": non_negotiable_prompt, "tech_context": tech_context_prompt}


def _build_project_context_prompt(project_structure: Optional[Dict[str, Any]]) -> str:
    if project_structure is None:
        return ""

    files = project_structure.get("files", [])
    key_files = project_structure.get("key_files", {})

    if len(files) == 0:
        return (
            "\n\n=== PROJECT STRUCTURE ===\n"
            "This is a NEW/EMPTY project. No files exist yet.\n"
            "CRITICAL: You MUST create ALL necessary files from scratch, including:\n"
            "- package.json (for npm projects)\n"
            "- Main entry files (App.tsx, main.py, index.html, etc.)\n"
            "- Configuration files as needed\n"
            "Do NOT assume any files exist. Create everything needed.\n"
        )

    file_list = "\n".join(f"  - {f}" for f in files[:25])
    more_note = f"\n  ... and {len(files) - 25} more files" if len(files) > 25 else ""

    key_files_content = ""
    if key_files:
        key_files_content = "\n\n=== KEY FILE CONTENTS (for context) ===\n"
        for path, content in list(key_files.items())[:5]:
            key_files_content += f"\n--- {path} ---\n{content}\n"

    return (
        "\n\n=== PROJECT STRUCTURE ===\n"
        f"Existing files in project:\n{file_list}{more_note}\n"
        "IMPORTANT: This is an EXISTING project. Analyze the structure and:\n"
        "- MODIFY existing files to add/change functionality\n"
        "- CREATE new files only if they don't exist\n"
        "- RESPECT the existing architecture and patterns\n"
        f"{key_files_content}"
    )


def _build_deployment_context() -> str:
    return (
        "\n\n=== DEPLOYMENT CONTEXT (CRITICAL) ===\n"
        "Choose ONE approach and follow it COMPLETELY:\n\n"
        "OPTION A: REACT/VITE PROJECT (for complex UI apps)\n"
        "If you use React, you MUST create a COMPLETE Vite project with ALL of these files:\n"
        "  1. package.json (with dependencies: react, react-dom, vite, @vitejs/plugin-react)\n"
        "  2. vite.config.ts (with react plugin)\n"
        "  3. index.html (with <div id='root'></div> and <script type='module' src='./src/main.tsx'>)\n"
        "  4. src/main.tsx (createRoot and render <App />)\n"
        "  5. src/App.tsx (your main component)\n"
        "  6. tsconfig.json (for TypeScript support)\n"
        "After creating these, run: npm install && npm run dev\n\n"
        "OPTION B: VANILLA HTML/CSS/JS (for simple apps - PREFERRED for quick demos)\n"
        "For simple apps without build tools:\n"
        "  1. Put ALL files in ONE directory (e.g., public/)\n"
        "  2. Use RELATIVE paths (./styles.css, ./app.js)\n"
        "  3. Create: index.html, styles.css, app.js\n"
        "Runs directly with: python3 -m http.server\n\n"
        "CRITICAL RULES:\n"
        "- Do NOT create partial React (e.g., just .tsx without package.json)\n"
        "- If unsure, use OPTION B (vanilla) for reliability\n"
        "- A single component file (.tsx) is NEVER a complete project\n"
    )


def build_orchestrator_prompt(
    goal: str,
    constraints_enabled: bool,
    tech_context: Optional[Any] = None,
    project_structure: Optional[Dict[str, Any]] = None,
    use_enhanced: Optional[bool] = None,
) -> str:
    """
    오케스트레이터 프롬프트 생성
    
    Args:
        goal: 사용자 목표
        constraints_enabled: 테스트 모드 제약 조건 활성화
        tech_context: 기술 컨텍스트 객체
        project_structure: 프로젝트 파일 구조
        use_enhanced: 고도화 프롬프트 사용 여부 (None이면 글로벌 설정 사용)
    
    Returns:
        완성된 프롬프트 문자열
    """
    # 고도화 프롬프트 사용 여부 결정
    should_use_enhanced = use_enhanced if use_enhanced is not None else USE_ENHANCED_PROMPTS
    
    if should_use_enhanced:
        # 고도화된 프롬프트 사용
        return build_enhanced_orchestrator_prompt(
            goal=goal,
            role=AgentRole.ORCHESTRATOR,
            tech_context=tech_context,
            project_structure=project_structure,
            include_few_shot=True,
            include_cot=True,
            test_mode=constraints_enabled
        )
    
    # 기존 프롬프트 (레거시)
    schema_hint = {
        "goal": goal,
        "actions": [
            {
                "action": "dev_instruction",
                "type": "shell",
                "instruction": "natural language instruction for Codex CLI",
                "verify": ["files_exist:files.txt"],
                "comment": "why this step",
                "targets": ["files.txt"],
                "client": "frontend"
            }
        ],
        "next_goal": "optional next target or empty"
    }

    constraints_prompt = _build_constraints_prompt(constraints_enabled)
    non_negotiable_prompt = ""
    tech_context_prompt = ""

    if not constraints_enabled:
        tech_prompts = _build_tech_context_prompts(tech_context)
        non_negotiable_prompt = tech_prompts["non_negotiable"]
        tech_context_prompt = tech_prompts["tech_context"]

    project_context_prompt = _build_project_context_prompt(project_structure)
    deployment_context = _build_deployment_context()

    return (
        "You are the Orchestrator. Output ONLY JSON in the exact schema below. "
        "CRITICAL 1: IMPLEMENTATION. If the project is new, you MUST generate actions to CREATE the necessary files (e.g., 'Write file X with content Y'). "
        "CRITICAL 2: VERIFICATION. You MUST include verification steps (e.g., 'files_exist', 'build_success', 'tests_pass') in your actions. DO NOT leave 'verify' empty.\n"
        "CRITICAL 3: ALIGNMENT. Follow the defined Technology Stack strictly.\n"
        "No markdown, no code fences. If you cannot follow, output nothing.\n"
        f"{constraints_prompt}"
        f"{non_negotiable_prompt}"
        f"{tech_context_prompt}"
        f"{project_context_prompt}"
        f"{deployment_context}\n"
        f"{json.dumps(schema_hint, ensure_ascii=False)}"
    )


# 고도화 프롬프트 유틸리티 re-export
__all__ = [
    # 메인 빌더
    "build_orchestrator_prompt",
    
    # 고도화 프롬프트 유틸리티
    "extract_thinking",
    "validate_action_response",
    "get_enhanced_clarify_goal_prompt",
    "get_enhanced_rfp_prompt",
    "select_few_shot_example",
    "get_few_shot_prompt",
    
    # 설정
    "USE_ENHANCED_PROMPTS",
    "AgentRole",
]
