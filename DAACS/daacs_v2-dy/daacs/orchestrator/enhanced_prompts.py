"""
DAACS Enhanced Prompts - Phase 7.1 고도화
3단계 프롬프트 구조 + Few-shot + Chain-of-Thought

구조:
1. SYSTEM_PROMPT - 역할 정의 (Who you are)
2. TASK_PROMPT - 태스크 설명 (What to do)
3. FORMAT_PROMPT - 출력 형식 (How to respond)
4. FEW_SHOT_EXAMPLES - 성공 사례 (Learn from examples)
"""
import json
from typing import Dict, Any, List, Optional
from enum import Enum


# ==================== 역할 정의 (System Prompts) ====================

class AgentRole(Enum):
    """에이전트 역할 정의"""
    ORCHESTRATOR = "orchestrator"
    PLANNER = "planner"
    CODE_REVIEWER = "code_reviewer"
    ANALYZER = "analyzer"


SYSTEM_PROMPTS: Dict[AgentRole, str] = {
    AgentRole.ORCHESTRATOR: """You are DAACS Orchestrator, an expert software architect and development coordinator.

Your Core Competencies:
- Decompose complex goals into actionable development steps
- Select appropriate technologies based on requirements
- Coordinate frontend and backend development
- Ensure code quality through verification steps
- Adapt plans based on execution results

Your Personality:
- Precise and structured in your responses
- Conservative in technology choices (prefer proven solutions)
- Always include verification for every action
- Think step-by-step before acting

CRITICAL RULES:
1. ALWAYS output valid JSON only - no markdown, no explanations outside JSON
2. NEVER skip verification steps
3. ALWAYS respect the specified technology stack
4. When in doubt, prefer simpler solutions""",

    AgentRole.PLANNER: """You are DAACS Planner, an expert at analyzing user requirements and creating development plans.

Your Core Competencies:
- Extract clear, actionable goals from vague descriptions
- Identify necessary clarifications before development
- Create structured specifications (RFP)
- Prioritize features based on complexity and dependencies

Your Approach:
- Ask minimal but essential questions
- Prefer to start with MVP then iterate
- Always provide concrete recommendations
- Consider user's technical level""",

    AgentRole.CODE_REVIEWER: """You are DAACS Code Reviewer, an expert at evaluating generated code quality.

Your Core Competencies:
- Detect syntax errors and bugs
- Identify security vulnerabilities
- Check code consistency and patterns
- Verify alignment with requirements

Your Standards:
- Production-ready code only
- Proper error handling required
- Documentation for complex logic
- DRY (Don't Repeat Yourself) principle""",

    AgentRole.ANALYZER: """You are DAACS Analyzer, an expert at understanding existing codebases.

Your Core Competencies:
- Identify technology stacks from code
- Map project structure and dependencies
- Detect code patterns and conventions
- Find potential improvement areas

Your Approach:
- Systematic file-by-file analysis
- Pattern recognition over line counting
- Focus on architecture decisions"""
}


# ==================== Few-shot 성공 사례 ====================

FEW_SHOT_EXAMPLES = {
    "simple_webapp": {
        "description": "Simple calculator web app",
        "goal": "간단한 계산기 웹앱을 만들어주세요",
        "thinking": """<thinking>
1. 목표 분석: 간단한 계산기 = 사칙연산 기능이 있는 웹 UI
2. 기술 선택: 간단한 앱이므로 Vanilla HTML/CSS/JS가 적합
3. 필요 파일: index.html, styles.css, app.js
4. 검증 방법: 파일 존재 확인 + JS 문법 검사
</thinking>""",
        "response": {
            "goal": "간단한 계산기 웹앱을 만들어주세요",
            "actions": [
                {
                    "action": "dev_instruction",
                    "type": "files",
                    "instruction": "Create index.html with calculator UI structure: display area on top, number buttons (0-9), operator buttons (+, -, *, /, =), and clear button. Include links to styles.css and app.js.",
                    "verify": ["files_exist:index.html"],
                    "comment": "Main HTML structure for calculator",
                    "targets": ["index.html"],
                    "client": "frontend"
                },
                {
                    "action": "dev_instruction",
                    "type": "files",
                    "instruction": "Create styles.css with modern calculator styling: grid layout for buttons, large display font, button hover effects, and responsive design.",
                    "verify": ["files_exist:styles.css"],
                    "comment": "Visual styling",
                    "targets": ["styles.css"],
                    "client": "frontend"
                },
                {
                    "action": "dev_instruction",
                    "type": "files",
                    "instruction": "Create app.js with calculator logic: handleNumber, handleOperator, calculate, clear functions. Add event listeners to all buttons.",
                    "verify": ["files_exist:app.js", "javascript_syntax_valid:app.js"],
                    "comment": "Calculator business logic",
                    "targets": ["app.js"],
                    "client": "frontend"
                }
            ],
            "next_goal": ""
        }
    },
    
    "react_dashboard": {
        "description": "React dashboard with API",
        "goal": "React로 대시보드 만들어주세요. 차트랑 데이터 테이블 포함해서요.",
        "thinking": """<thinking>
1. 목표 분석: 대시보드 = 차트 + 데이터 테이블, 복잡한 UI
2. 기술 선택: React + Vite (복잡한 UI에 적합), Chart.js for charts
3. 필요 파일: 전체 Vite 프로젝트 구조 + components
4. 검증 방법: npm build 성공 + 파일 존재
5. 주의: 반드시 package.json부터 시작해야 함
</thinking>""",
        "response": {
            "goal": "React 대시보드 (차트 + 데이터 테이블)",
            "actions": [
                {
                    "action": "dev_instruction",
                    "type": "files",
                    "instruction": "Create package.json with dependencies: react, react-dom, vite, @vitejs/plugin-react, chart.js, react-chartjs-2. Include scripts: dev, build, preview.",
                    "verify": ["files_exist:package.json"],
                    "comment": "Project configuration",
                    "targets": ["package.json"],
                    "client": "frontend"
                },
                {
                    "action": "dev_instruction",
                    "type": "files",
                    "instruction": "Create vite.config.ts with React plugin configuration.",
                    "verify": ["files_exist:vite.config.ts"],
                    "comment": "Build tool config",
                    "targets": ["vite.config.ts"],
                    "client": "frontend"
                },
                {
                    "action": "dev_instruction",
                    "type": "files",
                    "instruction": "Create index.html with root div and module script pointing to src/main.tsx",
                    "verify": ["files_exist:index.html"],
                    "comment": "HTML entry point",
                    "targets": ["index.html"],
                    "client": "frontend"
                },
                {
                    "action": "dev_instruction",
                    "type": "files",
                    "instruction": "Create src/main.tsx with React 18 createRoot rendering App component",
                    "verify": ["files_exist:src/main.tsx"],
                    "comment": "React entry point",
                    "targets": ["src/main.tsx"],
                    "client": "frontend"
                },
                {
                    "action": "dev_instruction",
                    "type": "files",
                    "instruction": "Create src/App.tsx with Dashboard layout: ChartWidget and DataTable components",
                    "verify": ["files_exist:src/App.tsx"],
                    "comment": "Main app component",
                    "targets": ["src/App.tsx"],
                    "client": "frontend"
                },
                {
                    "action": "dev_instruction",
                    "type": "shell",
                    "instruction": "npm install && npm run build",
                    "verify": ["build_success"],
                    "comment": "Verify complete project",
                    "targets": [],
                    "client": "frontend"
                }
            ],
            "next_goal": ""
        }
    },
    
    "backend_api": {
        "description": "FastAPI backend with endpoints",
        "goal": "사용자 관리 REST API를 만들어주세요",
        "thinking": """<thinking>
1. 목표 분석: REST API = CRUD endpoints for User resource
2. 기술 선택: FastAPI (Python REST API 최적)
3. 필요 파일: main.py, models.py, requirements.txt
4. 검증 방법: Python 문법 검사 + 서버 시작 테스트
5. 엔드포인트: GET/POST/PUT/DELETE /users
</thinking>""",
        "response": {
            "goal": "사용자 관리 REST API",
            "actions": [
                {
                    "action": "dev_instruction",
                    "type": "files",
                    "instruction": "Create requirements.txt with: fastapi, uvicorn, pydantic",
                    "verify": ["files_exist:requirements.txt"],
                    "comment": "Python dependencies",
                    "targets": ["requirements.txt"],
                    "client": "backend"
                },
                {
                    "action": "dev_instruction",
                    "type": "files",
                    "instruction": "Create models.py with Pydantic User model: id, name, email, created_at fields",
                    "verify": ["files_exist:models.py", "python_syntax_valid:models.py"],
                    "comment": "Data models",
                    "targets": ["models.py"],
                    "client": "backend"
                },
                {
                    "action": "dev_instruction",
                    "type": "files",
                    "instruction": "Create main.py with FastAPI app and CRUD endpoints: GET /users, GET /users/{id}, POST /users, PUT /users/{id}, DELETE /users/{id}. Use in-memory dict for storage.",
                    "verify": ["files_exist:main.py", "python_syntax_valid:main.py"],
                    "comment": "API endpoints",
                    "targets": ["main.py"],
                    "client": "backend"
                },
                {
                    "action": "dev_instruction",
                    "type": "shell",
                    "instruction": "pip install -r requirements.txt",
                    "verify": ["build_success"],
                    "comment": "Install dependencies",
                    "targets": [],
                    "client": "backend"
                }
            ],
            "next_goal": ""
        }
    }
}


# ==================== 출력 스키마 (Format Prompts) ====================

ACTION_SCHEMA = {
    "type": "object",
    "properties": {
        "goal": {
            "type": "string",
            "description": "The original or refined goal"
        },
        "actions": {
            "type": "array",
            "items": {
                "type": "object",
                "properties": {
                    "action": {"type": "string", "enum": ["dev_instruction"]},
                    "type": {"type": "string", "enum": ["files", "shell", "test", "deploy"]},
                    "instruction": {"type": "string", "description": "Clear instruction for the developer agent"},
                    "verify": {
                        "type": "array",
                        "items": {"type": "string"},
                        "description": "Verification steps like 'files_exist:path', 'python_syntax_valid:path'"
                    },
                    "comment": {"type": "string", "description": "Why this step is needed"},
                    "targets": {"type": "array", "items": {"type": "string"}},
                    "client": {"type": "string", "enum": ["frontend", "backend"]}
                },
                "required": ["action", "type", "instruction", "verify", "targets", "client"]
            }
        },
        "next_goal": {
            "type": "string",
            "description": "Optional next goal after current actions complete"
        }
    },
    "required": ["goal", "actions"]
}


def get_format_prompt(include_schema: bool = True) -> str:
    """출력 형식 프롬프트"""
    schema_json = json.dumps(ACTION_SCHEMA, indent=2, ensure_ascii=False)
    
    return f"""
=== OUTPUT FORMAT ===

You MUST respond with ONLY valid JSON. No markdown, no code fences, no explanations.

Before outputting JSON, think through your plan inside <thinking> tags:
<thinking>
1. Analyze the goal
2. Choose technology stack
3. List required files
4. Define verification steps
</thinking>

Then output the JSON response.

{"JSON Schema:" + chr(10) + schema_json if include_schema else ""}

VERIFICATION OPTIONS (use in 'verify' array):
- files_exist:<path> - Check file exists
- files_not_empty:<path> - Check file is not empty
- python_syntax_valid:<path> - Validate Python syntax
- javascript_syntax_valid:<path> - Validate JS syntax
- build_success - npm/pip install succeeded
- tests_pass - All tests pass
"""


# ==================== 컨텍스트 빌더 ====================

def build_context_prompt(
    tech_stack: Optional[List[str]] = None,
    constraints: Optional[List[str]] = None,
    project_files: Optional[List[str]] = None,
    key_file_contents: Optional[Dict[str, str]] = None
) -> str:
    """컨텍스트 정보를 구조화된 프롬프트로 변환"""
    sections = []
    
    # 기술 스택
    if tech_stack:
        tech_list = "\n".join(f"  • {t}" for t in tech_stack)
        sections.append(f"""
=== TECHNOLOGY STACK (MUST FOLLOW) ===
{tech_list}

CRITICAL: Do NOT deviate from this stack. Using different technologies is a FAILURE.""")
    
    # 제약 조건
    if constraints:
        constraint_list = "\n".join(f"  ⚠️ {c}" for c in constraints)
        sections.append(f"""
=== CONSTRAINTS (NON-NEGOTIABLE) ===
{constraint_list}""")
    
    # 프로젝트 구조
    if project_files is not None:
        if len(project_files) == 0:
            sections.append("""
=== PROJECT STATUS ===
This is a NEW/EMPTY project. Create all files from scratch.
Do NOT assume any files exist.""")
        else:
            file_list = "\n".join(f"  - {f}" for f in project_files[:30])
            more = f"\n  ... and {len(project_files) - 30} more files" if len(project_files) > 30 else ""
            sections.append(f"""
=== EXISTING PROJECT ===
Files:
{file_list}{more}

IMPORTANT: Modify existing files when appropriate. Respect existing patterns.""")
    
    # 주요 파일 내용
    if key_file_contents:
        content_sections = []
        for path, content in list(key_file_contents.items())[:3]:
            # 내용이 너무 길면 truncate
            truncated = content[:500] + "..." if len(content) > 500 else content
            content_sections.append(f"--- {path} ---\n{truncated}")
        
        sections.append(f"""
=== KEY FILE CONTENTS ===
{chr(10).join(content_sections)}""")
    
    return "\n".join(sections)


def select_few_shot_example(goal: str) -> Optional[Dict[str, Any]]:
    """목표에 맞는 Few-shot 예제 선택"""
    goal_lower = goal.lower()
    
    # 키워드 매칭
    if any(kw in goal_lower for kw in ["react", "대시보드", "dashboard", "chart", "차트"]):
        return FEW_SHOT_EXAMPLES["react_dashboard"]
    elif any(kw in goal_lower for kw in ["api", "rest", "fastapi", "backend", "서버"]):
        return FEW_SHOT_EXAMPLES["backend_api"]
    elif any(kw in goal_lower for kw in ["간단", "simple", "calculator", "계산기", "basic"]):
        return FEW_SHOT_EXAMPLES["simple_webapp"]
    
    # 기본값
    return FEW_SHOT_EXAMPLES["simple_webapp"]


def get_few_shot_prompt(example: Dict[str, Any]) -> str:
    """Few-shot 예제를 프롬프트 형식으로 변환"""
    return f"""
=== EXAMPLE (LEARN FROM THIS) ===

User Goal: "{example['goal']}"

{example['thinking']}

Response:
{json.dumps(example['response'], indent=2, ensure_ascii=False)}

=== END EXAMPLE ===
"""


# ==================== 통합 프롬프트 빌더 ====================

def build_enhanced_orchestrator_prompt(
    goal: str,
    role: AgentRole = AgentRole.ORCHESTRATOR,
    tech_context: Optional[Any] = None,
    project_structure: Optional[Dict[str, Any]] = None,
    include_few_shot: bool = True,
    include_cot: bool = True,
    test_mode: bool = False
) -> str:
    """
    고도화된 오케스트레이터 프롬프트 생성
    
    Args:
        goal: 사용자 목표
        role: 에이전트 역할
        tech_context: 기술 컨텍스트 객체
        project_structure: 프로젝트 파일 구조
        include_few_shot: Few-shot 예제 포함 여부
        include_cot: Chain-of-Thought 유도 여부
        test_mode: 테스트 모드 (제약 조건 활성화)
    
    Returns:
        완성된 프롬프트 문자열
    """
    parts = []
    
    # 1. 시스템 프롬프트 (역할 정의)
    parts.append(SYSTEM_PROMPTS[role])
    
    # 2. 모드 설정
    if test_mode:
        parts.append("""
=== MODE: TEST ===
- Maximum ONE file per action
- Keep outputs concise (<200 lines)
- Prefer simple solutions""")
    else:
        parts.append("""
=== MODE: PRODUCTION ===
- Full codegen capabilities enabled
- Create complete, production-ready code
- Include proper error handling""")
    
    # 3. 컨텍스트 정보
    tech_stack = None
    constraints = None
    if tech_context:
        facts = getattr(tech_context, "facts", None) or []
        constraints = getattr(tech_context, "constraints", None) or []
        tech_stack = facts
    
    project_files = None
    key_files = None
    if project_structure:
        project_files = project_structure.get("files", [])
        key_files = project_structure.get("key_files", {})
    
    context_prompt = build_context_prompt(
        tech_stack=tech_stack,
        constraints=constraints,
        project_files=project_files,
        key_file_contents=key_files
    )
    if context_prompt:
        parts.append(context_prompt)
    
    # 4. Few-shot 예제
    if include_few_shot:
        example = select_few_shot_example(goal)
        if example:
            parts.append(get_few_shot_prompt(example))
    
    # 5. 현재 태스크
    parts.append(f"""
=== CURRENT TASK ===
Goal: "{goal}"
""")
    
    # 6. 출력 형식 + Chain-of-Thought 유도
    if include_cot:
        parts.append("""
=== INSTRUCTIONS ===
1. First, think through your plan inside <thinking> tags
2. Then output ONLY valid JSON (no markdown, no code fences)
3. Include verification for EVERY action
4. Match the technology stack exactly
""")
    
    parts.append(get_format_prompt(include_schema=True))
    
    return "\n".join(parts)


# ==================== RFI/RFP 고도화 프롬프트 ====================

def get_enhanced_clarify_goal_prompt(goal: str) -> str:
    """고도화된 목표 명확화 (RFI) 프롬프트"""
    return f"""{SYSTEM_PROMPTS[AgentRole.PLANNER]}

=== TASK: GOAL CLARIFICATION ===

User's initial request: "{goal}"

Your task:
1. Analyze if the goal is clear enough to start development.
2. If clear, respond with: {{"clear": true}}
   - Also set "clear": true if the user seems impatient (e.g. "just do it", "anything", "go").
3. If unclear, ask ONE specific question: {{"clear": false, "question": "Your question"}}

CRITICAL: In your question, ALWAYS briefly mention that the user can type 'go', 'run', or '시작' to start immediately.

Think first:
<thinking>
- What environment? (web/desktop/mobile/CLI)
- What features are essential vs nice-to-have?
- What technology preferences exist?
- Is there enough info to create an MVP?
</thinking>

Rules:
- Ask MAXIMUM 1 question
- Prefer starting with recommendations over asking questions
- If user mentions specific tech (React, Python), that's enough to proceed
- Keep questions SHORT (1 sentence)
- OUTPUT MUST BE IN KOREAN (Professional tone)

Output ONLY valid JSON."""


def get_enhanced_rfp_prompt(goal_history: str, tech_context: Optional[Dict[str, Any]] = None) -> str:
    """고도화된 RFP 생성 프롬프트"""
    tech_hint = ""
    if tech_context and tech_context.get("facts"):
        tech_hint = "\n\nKnown Technology Facts:\n" + "\n".join(f"- {f}" for f in tech_context["facts"])
    
    return f"""{SYSTEM_PROMPTS[AgentRole.PLANNER]}

=== TASK: CREATE RFP ===

Conversation History:
{goal_history}
{tech_hint}

Create a structured RFP (Request for Proposal) in JSON format.

<thinking>
1. What is the core goal?
2. What features are required (FR-xxx)?
3. What technology choices are best (TECH-xxx)?
4. What is the basic architecture?
</thinking>

Output this exact JSON structure:
{{
  "goal": "Clear, actionable one-sentence goal",
  "specs": [
    {{
      "id": "FR-001",
      "type": "feature",
      "title": "Feature name",
      "description": "What this feature does",
      "priority": "must-have|should-have|nice-to-have",
      "rationale": "Why this is needed"
    }},
    {{
      "id": "TECH-FE",
      "type": "tech",
      "title": "Technology name",
      "description": "Version and details",
      "category": "Frontend|Backend|Database|Infrastructure",
      "rationale": "Why this technology"
    }}
  ],
  "blueprint": {{
    "architecture": "Brief architecture description",
    "components": ["Component1", "Component2"]
  }}
}}

Rules:
- Include 2-5 features (must-have only for MVP)
- Include 1-3 technologies
- Output ONLY valid JSON"""


# ==================== 유틸리티 ====================

def extract_thinking(response: str) -> tuple[Optional[str], str]:
    """응답에서 <thinking> 태그 내용 추출"""
    import re
    
    thinking_match = re.search(r'<thinking>(.*?)</thinking>', response, re.DOTALL)
    thinking = thinking_match.group(1).strip() if thinking_match else None
    
    # thinking 태그 제거한 나머지
    clean_response = re.sub(r'<thinking>.*?</thinking>', '', response, flags=re.DOTALL).strip()
    
    return thinking, clean_response


def validate_action_response(response: Dict[str, Any]) -> tuple[bool, List[str]]:
    """액션 응답 유효성 검사"""
    errors = []
    
    # 필수 필드 체크
    if "goal" not in response:
        errors.append("Missing 'goal' field")
    if "actions" not in response:
        errors.append("Missing 'actions' field")
    elif not isinstance(response["actions"], list):
        errors.append("'actions' must be an array")
    else:
        for i, action in enumerate(response["actions"]):
            # Check if action is a valid dict
            if action is None:
                errors.append(f"Action {i}: is None")
                continue
            if not isinstance(action, dict):
                errors.append(f"Action {i}: must be a dictionary, got {type(action).__name__}")
                continue
            if "instruction" not in action:
                errors.append(f"Action {i}: Missing 'instruction'")
            if "verify" not in action or not action["verify"]:
                errors.append(f"Action {i}: Missing or empty 'verify'")
            if "client" not in action:
                errors.append(f"Action {i}: Missing 'client' (frontend/backend)")
    
    return len(errors) == 0, errors
