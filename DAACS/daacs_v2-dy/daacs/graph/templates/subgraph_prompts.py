"""
DAACS v6.0 - Subgraph Prompts
Centralized prompts for backend and frontend code generation.
"""

import os
import glob
from typing import Dict, Any, List
from ...config import MIN_CODE_REVIEW_SCORE
from ...models.daacs_state import DAACSState


# ============================================================================
# HELPER: READ EXISTING CODE FILES
# ============================================================================

EXCLUDE_DIRS = {'node_modules', '__pycache__', '.git', '.venv', 'venv', 'dist', 'build', '.next', '.cache'}
MAX_FILES_FOR_CONTEXT = 8
MAX_LINES_PER_FILE = 300


def _read_existing_code(base_dir: str, extensions: List[str]) -> str:
    """
    Read existing code files from directory for inclusion in prompts.
    This enables the LLM to see its previous output and effectively fix/improve it.
    """
    if not os.path.exists(base_dir):
        return ""
    
    files_content = []
    all_files = []
    
    for ext in extensions:
        pattern = os.path.join(base_dir, f"**/*{ext}")
        matched = glob.glob(pattern, recursive=True)
        for f in matched:
            if not any(excluded in f for excluded in EXCLUDE_DIRS):
                all_files.append(f)
    
    # Prioritize important files
    priority_files = ['main.py', 'page.tsx', 'layout.tsx', 'globals.css', 'routes.py', 'models.py']
    def priority_key(path: str) -> int:
        basename = os.path.basename(path)
        for i, p in enumerate(priority_files):
            if basename == p:
                return i
        return len(priority_files)
    
    all_files = sorted(set(all_files), key=priority_key)
    
    for f in all_files[:MAX_FILES_FOR_CONTEXT]:
        try:
            with open(f, 'r', encoding='utf-8', errors='ignore') as file:
                content = file.read()
                lines = content.split('\n')[:MAX_LINES_PER_FILE]
                rel_path = os.path.relpath(f, base_dir)
                files_content.append(f"--- {rel_path} ---\n" + '\n'.join(lines))
        except Exception:
            pass
    
    if not files_content:
        return ""
    
    # 🆕 Add explicit instruction to prevent verbatim copy
    header = "\n\n=== YOUR PREVIOUS CODE (REFERENCE ONLY) ===\n"
    header += "⚠️ DO NOT copy this code verbatim. Study the issues above and output FIXED, IMPROVED code.\n"
    header += "Your new output must address all CRITICAL ISSUES and MISSING FEATURES listed above.\n\n"
    
    return header + "\n\n".join(files_content)


def _build_detailed_feedback(state: DAACSState, role: str = "backend") -> str:
    """
    Build detailed, actionable feedback from code review and verification results.
    This gives the LLM specific information about what went wrong and how to fix it.
    """
    feedback_parts = []
    
    # 1. Code Review Issues (most important)
    code_review = state.get("code_review", {})
    if isinstance(code_review, dict):
        issues = code_review.get("issues", [])
        if issues:
            critical = [i for i in issues if i.get("severity") == "critical"]
            warnings = [i for i in issues if i.get("severity") == "warning"]
            
            if critical:
                feedback_parts.append("=== ❌ CRITICAL ISSUES (MUST FIX) ===")
                for i, issue in enumerate(critical[:5], 1):
                    file = issue.get("file", "unknown")
                    line = issue.get("line", "?")
                    desc = issue.get("description", "")
                    suggestion = issue.get("suggestion", "")
                    feedback_parts.append(f"{i}. [{file}:{line}] {desc}")
                    if suggestion:
                        feedback_parts.append(f"   FIX: {suggestion}")
            
            if warnings:
                feedback_parts.append("\n=== ⚠️ WARNINGS (SHOULD FIX) ===")
                for issue in warnings[:5]:
                    file = issue.get("file", "unknown")
                    desc = issue.get("description", "")
                    feedback_parts.append(f"- [{file}] {desc}")
        
        # Missing features
        goal_alignment = code_review.get("goal_alignment", {})
        if not goal_alignment.get("aligned", True):
            missing = goal_alignment.get("missing_features", [])
            if missing:
                feedback_parts.append("\n=== 🎯 MISSING FEATURES (MUST IMPLEMENT) ===")
                for feat in missing[:5]:
                    feedback_parts.append(f"- {feat}")
    
    # 2. Verification Failures
    verification_key = f"{role}_verification_details"
    verification_details = state.get(verification_key, [])
    if verification_details:
        failed_verifications = [v for v in verification_details if not v.get("ok", True)]
        if failed_verifications:
            feedback_parts.append(f"\n=== 🔍 {role.upper()} VERIFICATION FAILURES ===")
            for v in failed_verifications[:5]:
                template = v.get("template", "unknown_check")
                reason = v.get("reason", "No details")
                feedback_parts.append(f"- {template}: {reason}")
    
    # 3. Failure Summary
    failure_summary = state.get("failure_summary", [])
    if failure_summary:
        feedback_parts.append("\n=== 📋 FAILURE SUMMARY ===")
        for item in failure_summary[:10]:
            feedback_parts.append(f"- {item}")
    
    # 4. Compatibility Issues
    compatibility_issues = state.get("compatibility_issues", [])
    if compatibility_issues:
        feedback_parts.append("\n=== 🔗 COMPATIBILITY ISSUES ===")
        for issue in compatibility_issues[:5]:
            feedback_parts.append(f"- {issue}")
    
    if not feedback_parts:
        return ""
    
    return "\n\n=== 🛠️ DETAILED FEEDBACK (ACTION REQUIRED) ===\n" + "\n".join(feedback_parts) + "\n"


# ============================================================================
# BACKEND PROMPT
# ============================================================================

BACKEND_PROMPT_TEMPLATE = """
🚨 MANDATORY OUTPUT FORMAT (READ FIRST!) 🚨
You MUST output files using this EXACT format:

FILE: filename.py
```python
[file contents here]
```

Without the code block fences (```), parsing will fail.
Start EVERY file with "FILE: path/filename.ext" followed by a code block.

=== MISSION ===
Build a COMPLETE, PRODUCTION-READY backend API that fully implements the Goal below.

Goal: {current_goal}
Plan: {orchestrator_plan}
Instructions: {backend_instructions}
API Spec: {api_spec}
Auto Spec: {auto_spec}
Success Criteria: {success_criteria}

=== FILE STRUCTURE ===
Create these files with REAL, WORKING code:

1. main.py - FastAPI app with all endpoints fully implemented
2. requirements.txt - All dependencies (fastapi, uvicorn, etc.)
3. Additional files in routes/, models/, utils/ as needed

=== CORE PRINCIPLES ===

1. **Goal-Driven Implementation**
   - Read the Goal carefully and implement EVERY feature mentioned
   - If Goal says "user management" -> implement full CRUD for users
   - If Goal says "authentication" -> implement login, register, JWT
   - If Goal says "data API" -> implement complete data operations

2. **Complete Code, Not Stubs**
   - Every endpoint must have real business logic
   - Every route must process data and return meaningful responses
   - Include input validation with Pydantic models
   - Implement proper error handling (try/except, HTTPException)

3. **Data Layer**
   - If database needed, use in-memory storage (dict/list) for simplicity
   - Define clear data models with Pydantic
   - Provide sample/seed data for testing

4. **API Best Practices**
   - Use proper HTTP methods (GET, POST, PUT, DELETE)
   - Return appropriate status codes (200, 201, 400, 404, 500)
   - Include CORS middleware if frontend integration needed
   - Document endpoints with docstrings
   - Provide GET /health returning {{"status": "ok"}}

5. **Package Structure (CRITICAL)**
   - EVERY __init__.py file MUST contain meaningful content
   - NO EMPTY __init__.py FILES ALLOWED
   - At minimum, include a docstring: \"\"\"Package description.\"\"\"
   - Better: include explicit exports: from .module import ClassName
   - Example:
     ```python
     \"\"\"Routes package for API endpoints.\"\"\"
     from .users import router as users_router
     ```

6. **Quality Bar (Target 8/10+)**
   - No critical issues (crashes/security/data loss)
   - Clear input validation + consistent error responses
   - Functions are small, named, and typed where useful
   - Align all endpoints with API Spec and Goal

7. **Entry Point (CRITICAL)**
   - You MUST include the following block at the end of `main.py` to allow the server to run:
     ```python
     if __name__ == "__main__":
         import uvicorn
         uvicorn.run(app, host="0.0.0.0", port=8000)
     ```
   - WITHOUT THIS, THE PROJECT WILL FAIL.

=== DO NOT ===
- Create placeholder routes that just return "Not implemented"
- Leave business logic empty
- Skip input validation
- Forget error handling
- Create EMPTY __init__.py files (WILL FAIL VERIFICATION)
- **INCLUDE ANY CONVERSATIONAL TEXT OR "COMPLETION MESSAGES" INSIDE CODE FILES.** (e.g., "- Fixed the syntax error..." at the end of a .py file). This causes SyntaxErrors.
- Use prose outside of comments.

=== LANGUAGE REQUIREMENT ===
- **All comments, docstrings, and README files MUST be in KOREAN.**
- Variable names and function names must remain in English.
- Error messages returned to the user should be in KOREAN.

=== CURATED PYTHON PACKAGES (use these for compatibility) ===
Core (always include):
- fastapi>=0.115.0
- uvicorn>=0.34.0
- pydantic>=2.10.0

Optional (add as needed):
- httpx>=0.28.0 (for HTTP client)
- python-multipart>=0.0.20 (for file uploads)
- sqlalchemy>=2.0.0 (for database)
- aiosqlite>=0.20.0 (for async SQLite)
- python-jose>=3.3.0 (for JWT)
- passlib>=1.7.0 (for password hashing)

CRITICAL: Use >= for minimum version, NOT exact versions.

=== PYDANTIC V2 SYNTAX (CRITICAL) ===
You MUST use Pydantic V2 syntax. DO NOT use deprecated V1 patterns:

WRONG (will crash):
- @validator → use @field_validator + @classmethod
- @root_validator → use @model_validator(mode="after")

Example:
```python
from pydantic import BaseModel, field_validator, model_validator

class UserCreate(BaseModel):
    email: str
    
    @field_validator("email")
    @classmethod
    def validate_email(cls, v: str) -> str:
        if "@" not in v:
            raise ValueError("Invalid email")
        return v
```

=== OUTPUT FORMAT (CRITICAL - FILES WILL BE PARSED AUTOMATICALLY) ===
⚠️ YOUR OUTPUT MUST FOLLOW THIS EXACT FORMAT OR FILES WILL NOT BE SAVED:

FILE: path/to/filename.ext
```python
...code...
```

Example:
FILE: main.py
```python
from fastapi import FastAPI
app = FastAPI()
```

FILE: requirements.txt
```text
fastapi>=0.115.0
uvicorn>=0.34.0
```

❌ DO NOT: Just output code without file markers
❌ DO NOT: Use "--- filename ---" or "=== filename ===" style (DEPRECATED)
❌ DO NOT: Put comments or explanations OUTSIDE the code blocks
✅ DO: Wrap ALL content in markdown code blocks
"""


# ============================================================================
# FRONTEND PROMPT
# ============================================================================

FRONTEND_PROMPT_TEMPLATE = """
🚨 MANDATORY OUTPUT FORMAT (READ FIRST!) 🚨
You MUST output files using this EXACT format:

FILE: app/page.tsx
```tsx
[file contents here]
```

Without the code block fences (```), parsing will fail.
Start EVERY file with "FILE: path/filename.ext" followed by a code block.

=== MISSION ===
Build a COMPLETE, PRODUCTION-READY frontend application that fully implements the Goal below.

Goal: {current_goal}
Plan: {orchestrator_plan}
Instructions: {frontend_instructions}
Backend API: {api_spec}
Auto Spec: {auto_spec}

=== MANDATORY FILES ===
You MUST create these files with REAL, WORKING code:

1. app/page.tsx - Main page with COMPLETE implementation (all features in one file)
2. app/layout.tsx - Root layout with html/body tags
3. app/globals.css - Full Tailwind styling
4. package.json - Next.js scripts (dev/build/start) and dependencies (next/react/react-dom)
5. tailwind.config.js + postcss.config.js - Tailwind configured for app/ directory
6. tsconfig.json - TypeScript config for Next.js app

=== CURATED DEPENDENCY STACK (CRITICAL) ===
The scaffold already provides a working package.json with tested versions.
DO NOT replace the entire package.json. Only ADD new packages if needed.

**Core (DO NOT CHANGE versions):**
- next: ^15.1.0
- react: ^19.0.0
- react-dom: ^19.0.0

**DevDependencies (CRITICAL):**
- typescript: ^5.0.0
- @types/node: ^20.0.0
- @types/react: ^19.0.0
- @types/react-dom: ^19.0.0
- postcss: ^8.0.0
- tailwindcss: ^3.4.0
- autoprefixer: ^10.0.0

**Recommended Additional Packages (use these for compatibility):**
- UI Components: @radix-ui/react-*, lucide-react, class-variance-authority
- State: zustand (^5.0), @tanstack/react-query (^5.0)
- Forms: react-hook-form (^7.0), zod (^3.0)
- Date: date-fns (^4.0)
- Charts: recharts (^2.0)
- HTTP: axios (^1.0) or native fetch

**Version Rules:**
- Use semver ranges: "^5.0.0" (allows 5.x.x)
- NEVER use exact patch versions like "19.0.1" - use "^19.0.0"
- If unsure, use "latest"

=== IMPLEMENTATION REQUIREMENTS ===

**UI Features (implement ALL):**
- Every list item must have a DELETE button (X icon or "Remove" button)
- Show loading spinners during API calls / data fetching
- Display error messages when operations fail
- Handle empty states gracefully ("No items yet")

**Next.js 15 Compatibility (CRITICAL):**
- In App Router dynamic routes (e.g. `[id]/page.tsx` or `[id]/route.ts`), `params` is a Promise.
- You MUST await params: `const {{ id }} = await params;`
- DO NOT access `params.id` synchronously.


**State Management:**
- Use React hooks: useState, useEffect, useCallback
- Initialize all state with proper TypeScript types
- Clean up intervals/subscriptions in useEffect return

**Data Handling:**
- If using real-time updates, check conditions before starting intervals
  Example: ONLY stream when range === "1D", stop for other ranges
- Use LocalStorage for persistence: JSON.stringify/parse safely
- Handle missing data with fallbacks

**Quality Bar (Target 8/10+)**
- No critical runtime errors or missing features
- Typed state and safe null handling
- Loading/error/empty states for every async flow
- UI aligns with Goal and Backend API

=== REPLAN COMPLIANCE ===
If REPLAN GUIDANCE is provided, treat every bullet as MUST-FIX.
Do not output final files until all guidance items are addressed.

**Type Safety:**
- Define interfaces for ALL data structures
- Type ALL function parameters and return values
- Export shared types to separate file if needed

=== CODE PATTERNS ===

DELETE BUTTON pattern:
```tsx
<button 
  onClick={{(e) => {{ e.stopPropagation(); handleRemove(item.id); }}}}
  className="text-red-500 hover:text-red-700"
  aria-label="Remove item"
>
  Remove
</button>
```

CONDITIONAL INTERVAL pattern:
```tsx
useEffect(() => {{
  if (condition !== "activeState") return; // Only run when needed
  const timer = setInterval(() => {{ /* update */ }}, 2500);
  return () => clearInterval(timer);
}}, [condition]);
```

=== DO NOT ===
- Create empty/placeholder components
- Leave TODO comments in code
- Use default templates ("count is 0", "Hello World")
- Forget delete buttons on list items
- Stream data unconditionally
- **INCLUDE ANY CONVERSATIONAL TEXT OR "COMPLETION MESSAGES" INSIDE CODE FILES.**
- Use prose outside of comments.

=== LANGUAGE REQUIREMENT ===
- **All UI text, labels, and messages, comments MUST be in KOREAN.**
- Variable names and function names must remain in English.

=== OUTPUT FORMAT (CRITICAL - FILES WILL BE PARSED AUTOMATICALLY) ===
⚠️ YOUR OUTPUT MUST FOLLOW THIS EXACT FORMAT OR FILES WILL NOT BE SAVED:

FILE: path/to/filename.ext
```tsx
...code...
```

Example:
FILE: app/page.tsx
```tsx
"use client";
import {{ useState }} from "react";

export default function Page() {{
  return <div>Content</div>;
}}
```

FILE: app/layout.tsx
```tsx
export default function Layout({{ children }}) {{
  return <html><body>{{children}}</body></html>;
}}
```

❌ DO NOT: Just output code without file markers
❌ DO NOT: Use "--- filename ---" or "=== filename ===" style (DEPRECATED)
❌ DO NOT: Put comments or explanations OUTSIDE the code blocks
✅ DO: Wrap ALL content in markdown code blocks
"""


def build_backend_prompt(state: DAACSState) -> str:
    """Build backend generation prompt from state."""
    prompt = BACKEND_PROMPT_TEMPLATE.format(
        current_goal=state.get('current_goal', ''),
        orchestrator_plan=state.get('orchestrator_plan', ''),
        backend_instructions=state.get('backend_instructions', ''),
        api_spec=state.get('api_spec', {}),
        auto_spec=state.get('auto_spec', {}),
        success_criteria=state.get('success_criteria', ''),
    )
    
    # Add optional context
    tech_context = state.get("tech_context")
    if tech_context:
        prompt += f"\nTech Context: {tech_context}"
    
    replan_guidance = state.get("replan_guidance")
    if replan_guidance:
        prompt += f"\n\n=== REPLAN GUIDANCE ===\n{replan_guidance}\n"

    min_score = state.get("code_review_min_score") or MIN_CODE_REVIEW_SCORE
    score = state.get("code_review_score")
    if score is not None and score < min_score:
        prompt += (
            f"\n\n=== QUALITY BOOST REQUIRED ===\n"
            f"Last code review score: {score}. Target >= {min_score}.\n"
            "Fix all critical/warning issues and raise quality to production-ready.\n"
        )
    
    prefer_patch = state.get("prefer_patch")
    patch_targets = state.get("patch_targets", [])
    if prefer_patch:
        prompt += "\n\n=== PATCH MODE ===\n"
        if patch_targets:
            prompt += f"Modify ONLY the necessary files. Focus on: {patch_targets}\n"
        prompt += "Do not rewrite unrelated files. Keep existing structure and behavior intact.\n"
    
    generation_stage = state.get("generation_stage")
    if generation_stage:
        prompt += f"\n\n=== GENERATION STAGE ===\n{generation_stage}\n"
        if generation_stage == "scaffold":
            prompt += (
                "Create the full API structure, routing, and data models. "
                "Use simple in-memory data; focus on endpoints and schemas.\n"
            )
        elif generation_stage == "implement":
            prompt += (
                "Implement full business logic, validation, and error handling for all endpoints.\n"
            )
        elif generation_stage == "polish":
            prompt += (
                "Refine response consistency, edge cases, and data handling. "
                "Ensure API spec compliance and clean error messages.\n"
            )
    
    iteration = state.get("backend_subgraph_iterations", 0)
    if iteration > 0:
        prompt += f"\n\n=== ITERATION {iteration+1} (REFINEMENT) ===\n"
        prompt += "You are explicitly refining your previous code.\n"
        prompt += "DO NOT output the exact same content again.\n"
        prompt += "Focus on fixing errors, improving structure, or completing missing features.\n"
        
        # 🆕 Include detailed feedback from code review and verification
        detailed_feedback = _build_detailed_feedback(state, role="backend")
        if detailed_feedback:
            prompt += detailed_feedback
        
        # 🆕 Include existing code so LLM can see what to fix
        project_dir = state.get('project_dir', '.')
        backend_dir = os.path.join(project_dir, 'backend')
        existing_code = _read_existing_code(backend_dir, ['.py'])
        if existing_code:
            prompt += existing_code

    return prompt


def build_frontend_prompt(state: DAACSState) -> str:
    """Build frontend generation prompt from state."""
    prompt = FRONTEND_PROMPT_TEMPLATE.format(
        current_goal=state.get('current_goal', ''),
        orchestrator_plan=state.get('orchestrator_plan', ''),
        frontend_instructions=state.get('frontend_instructions', ''),
        api_spec=state.get('api_spec', {}),
        auto_spec=state.get('auto_spec', {}),
    )
    
    # Add optional context
    tech_context = state.get("tech_context")
    if tech_context:
        prompt += f"\nTech Context: {tech_context}"
    
    replan_guidance = state.get("replan_guidance")
    if replan_guidance:
        prompt += f"\n\n=== REPLAN GUIDANCE ===\n{replan_guidance}\n"

    min_score = state.get("code_review_min_score") or MIN_CODE_REVIEW_SCORE
    score = state.get("code_review_score")
    if score is not None and score < min_score:
        prompt += (
            f"\n\n=== QUALITY BOOST REQUIRED ===\n"
            f"Last code review score: {score}. Target >= {min_score}.\n"
            "Fix all critical/warning issues and raise quality to production-ready.\n"
        )
    
    prefer_patch = state.get("prefer_patch")
    patch_targets = state.get("patch_targets", [])
    if prefer_patch:
        prompt += "\n\n=== PATCH MODE ===\n"
        if patch_targets:
            prompt += f"Modify ONLY the necessary files. Focus on: {patch_targets}\n"
        prompt += "Do not rewrite unrelated files. Keep existing structure and behavior intact.\n"
    
    generation_stage = state.get("generation_stage")
    if generation_stage:
        prompt += f"\n\n=== GENERATION STAGE ===\n{generation_stage}\n"
        if generation_stage == "scaffold":
            prompt += (
                "Create the full UI structure, layout, and component skeletons. "
                "Focus on page layout and component hierarchy.\n"
            )
        elif generation_stage == "implement":
            prompt += (
                "Implement full UI logic, state management, and data handling.\n"
                "You MUST implement the integration with the provided Backend API endpoints (`api_spec`).\n"
                "Use `fetch` or `axios` to call the API. Handle loading and error states.\n"
                "Do not output a scaffold or placeholders.\n"
            )
        elif generation_stage == "polish":
            prompt += (
                "Refine styling, UX polish, and edge case handling. "
                "Ensure responsive design and accessibility.\n"
            )
    
    iteration = state.get("frontend_subgraph_iterations", 0)
    if iteration > 0:
        prompt += f"\n\n=== ITERATION {iteration+1} (REFINEMENT) ===\n"
        prompt += "You are explicitly refining your previous code.\n"
        prompt += "DO NOT output the exact same content again.\n"
        prompt += "Focus on fixing errors, improving structure, or completing missing features.\n"
        
        # 🆕 Include detailed feedback from code review and verification
        detailed_feedback = _build_detailed_feedback(state, role="frontend")
        if detailed_feedback:
            prompt += detailed_feedback
        
        # 🆕 Include existing code so LLM can see what to fix
        project_dir = state.get('project_dir', '.')
        frontend_dir = os.path.join(project_dir, 'frontend')
        existing_code = _read_existing_code(frontend_dir, ['.tsx', '.ts', '.js', '.css'])
        if existing_code:
            prompt += existing_code

    return prompt
