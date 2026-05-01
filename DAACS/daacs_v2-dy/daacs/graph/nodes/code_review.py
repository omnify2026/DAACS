"""
DAACS v7.0 - Code Review Node
Automated code review using LLM.
"""
from typing import Dict, Any, List
import json
import re
import os
import glob

from ...models.daacs_state import DAACSState
from ...llm.cli_executor import SessionBasedCLIClient
from ...orchestrator.enhanced_prompts import extract_thinking
from ...utils import setup_logger
from ...config import MIN_CODE_REVIEW_SCORE, DEFAULT_LLM_TIMEOUT_SEC

logger = setup_logger("CodeReviewNode")

# Exclude patterns for file search
EXCLUDE_PATTERNS = ["node_modules", "__pycache__", "venv", ".venv", "dist", ".next", "build"]

# Maximum files and lines to review
MAX_FILES_TO_REVIEW = 12
MAX_LINES_PER_FILE = 500

CODE_REVIEW_PROMPT = """You are an expert code reviewer. Analyze the following code files and provide a detailed review.

Project Goal:
{goal}

Plan Summary:
{plan}

API Spec (if any):
{api_spec}

API Spec (if any):
{api_spec}

Knowledge Base (Best Practices & Past Lessons):
{memory_context}

Files to review:
{files_content}

Review the code for:
1. **Syntax Errors**: Any parsing issues or invalid code
2. **Logic Bugs**: Potential runtime errors, edge cases not handled
3. **Best Practices**: Code organization, naming conventions, DRY principle
4. **Security**: Input validation, potential vulnerabilities
5. **Performance**: Inefficient patterns, memory issues
6. **Goal Alignment**: Does the code actually implement the goal?

Severity guidelines:
- critical: crash/data loss/security vulnerability
- warning: bug risk, missing validation, or missing features
- info: style or minor improvements

Scoring rubric:
- 9-10: production-ready, no critical issues
- 7-8: solid implementation, minor warnings only
- 5-6: missing pieces or multiple warnings
- <5: incomplete or unsafe

<thinking>
Analyze each file systematically...
</thinking>

Respond with JSON:
{{
  "overall_score": 1-10,
  "issues": [
    {{
      "file": "filename.py",
      "line": 10,
      "severity": "critical|warning|info",
      "category": "syntax|logic|security|performance|best_practice",
      "description": "Issue description",
      "suggestion": "How to fix"
    }}
  ],
  "strengths": ["Good things about the code"],
  "goal_alignment": {{
    "aligned": true/false,
    "missing_features": ["Feature not implemented"],
    "extra_features": ["Unexpected feature"]
  }},
  "summary": "Overall assessment"
}}"""


def _collect_files_to_review(project_dir: str) -> List[str]:
    """Collect code files to review."""
    # Python files
    py_files = glob.glob(os.path.join(project_dir, "**/*.py"), recursive=True)
    py_files = [f for f in py_files if not any(p in f for p in EXCLUDE_PATTERNS)]

    # JavaScript/TypeScript files
    js_patterns = ["**/*.js", "**/*.jsx", "**/*.ts", "**/*.tsx"]
    js_files: List[str] = []
    for pattern in js_patterns:
        js_files.extend(glob.glob(os.path.join(project_dir, pattern), recursive=True))
    js_files = [f for f in js_files if not any(p in f for p in EXCLUDE_PATTERNS)]

    # HTML files
    html_files = glob.glob(os.path.join(project_dir, "**/*.html"), recursive=True)
    html_files = [f for f in html_files if not any(p in f for p in EXCLUDE_PATTERNS)]

    all_files = sorted({*py_files, *js_files, *html_files})
    priority_order = [
        "/backend/main.py",
        "/backend/routes",
        "/backend/models",
        "/backend/utils",
        "/frontend/app/page.tsx",
        "/frontend/app/layout.tsx",
        "/frontend/src",
        "/frontend/pages",
        "/frontend/components",
        "/frontend/lib",
    ]

    def _priority(path: str) -> int:
        normalized = path.replace("\\", "/")
        for idx, token in enumerate(priority_order):
            if token in normalized:
                return idx
        return len(priority_order)

    return sorted(all_files, key=_priority)


def _read_files_content(files: List[str], project_dir: str) -> List[str]:
    """Read file contents with limits."""
    contents = []
    for f in files[:MAX_FILES_TO_REVIEW]:
        try:
            with open(f, 'r', encoding='utf-8', errors='ignore') as file:
                content = file.read()
                lines = content.split('\n')[:MAX_LINES_PER_FILE]
                rel_path = os.path.relpath(f, project_dir)
                contents.append(f"=== {rel_path} ===\n" + '\n'.join(lines))
        except Exception as e:
            logger.warning("Error reading %s: %s", f, e)
    return contents


def _parse_review_response(response: str) -> Dict[str, Any]:
    """Parse the LLM review response."""
    _, clean_response = extract_thinking(response)
    
    # Try direct JSON parse
    try:
        return json.loads(clean_response)
    except json.JSONDecodeError:
        pass
    
    # Try extracting JSON from code block
    json_match = re.search(r'```(?:json)?\s*([\s\S]*?)\s*```', clean_response)
    if json_match:
        try:
            return json.loads(json_match.group(1))
        except json.JSONDecodeError:
            pass
    
    # Try finding JSON in braces
    brace_match = re.search(r'\{[\s\S]*\}', clean_response)
    if brace_match:
        try:
            return json.loads(brace_match.group(0))
        except json.JSONDecodeError:
            pass
    
    return None


def code_review_node(state: DAACSState, llm_type: str = "gemini") -> Dict[str, Any]:
    """
    생성된 코드를 LLM으로 자동 리뷰하는 노드
    
    Returns:
        code_review: 리뷰 결과 딕셔너리
        code_review_passed: 리뷰 통과 여부
    """
    project_dir = state.get("project_dir", ".")
    current_goal = state.get("current_goal", "")
    
    logger.info("Starting code review...")
    
    # Collect files
    files_to_review = _collect_files_to_review(project_dir)
    
    if not files_to_review:
        logger.info("No files to review")
        return {
            "code_review": {"overall_score": 0, "issues": [], "summary": "No code files found"},
            "code_review_passed": False
        }
    
    # Read file contents
    files_content = _read_files_content(files_to_review, project_dir)
    
    if not files_content:
        return {
            "code_review": {"overall_score": 0, "issues": [], "summary": "Could not read any files"},
            "code_review_passed": False
        }
    
    # LLM review request
    timeout_sec = state.get("code_review_timeout_sec", DEFAULT_LLM_TIMEOUT_SEC)
    from daacs.config import PLANNER_MODEL
    model_name = state.get("code_review_model") or PLANNER_MODEL
    client = SessionBasedCLIClient(
        cwd=project_dir,
        cli_type=llm_type,
        client_name="code_reviewer",
        timeout_sec=timeout_sec,
        model_name=model_name
    )
    
    api_spec = state.get("api_spec", {}) or {}
    plan_summary = state.get("orchestrator_plan", "") or ""
    try:
        api_spec_text = json.dumps(api_spec, ensure_ascii=True)[:2000]
    except (TypeError, ValueError):
        api_spec_text = str(api_spec)[:2000]

    # [Memory Retrieval]
    memory_context = ""
    # Conditional import for MemoryManager pattern (scoped import to avoid circular dep issues if any)
    try:
        from ...memory.vector_store import MemoryManager
        HAS_MEMORY = True
    except ImportError:
        HAS_MEMORY = False

    if HAS_MEMORY:
        try:
            memory = MemoryManager()
            # Search for relevant guidelines and past lessons
            query = f"code review best practices {current_goal}"
            results = memory.search_memory(query, n_results=3, filter_metadata={"type": "guideline"}) # Assuming 'guideline' type exists or general search
            
            # Also fetch failure lessons to avoid repeating mistakes
            fail_results = memory.search_memory(current_goal, n_results=2, filter_metadata={"type": "failure_lesson"})
            
            if results or fail_results:
                memory_context = "Consider the following knowledge base items during review:\n"
                for res in results:
                    memory_context += f"- [GUIDELINE] {res['content']}\n"
                for res in fail_results:
                    memory_context += f"- [PAST MISTAKE] {res['content']}\n"
                logger.info("[CodeReview] Retrieved %s guidelines and %s failure lessons.", len(results), len(fail_results))
        except Exception as e:
            logger.warning(f"Memory retrieval failed: {e}")

    prompt = CODE_REVIEW_PROMPT.format(
        files_content="\n\n".join(files_content),
        goal=current_goal,
        plan=plan_summary,
        api_spec=api_spec_text,
        memory_context=memory_context,
    )
    
    try:
        response = client.execute(prompt)
        review_data = _parse_review_response(response)
        
        if not review_data:
            logger.error("Failed to parse review response")
            return {
                "code_review": {"overall_score": 0, "issues": [], "summary": "Review response parsing failed"},
                "code_review_passed": False,
                "code_review_score": 0,
                "code_review_error": "parse_failed"
            }
        
        # Analyze results
        overall_score = review_data.get("overall_score", 0)
        critical_issues = [i for i in review_data.get("issues", []) if i.get("severity") == "critical"]
        goal_aligned = review_data.get("goal_alignment", {}).get("aligned", True)
        
        # 🆕 Progressive scoring: stricter on first attempt, relaxed on retries (min 7)
        main_cycle_count = state.get("main_cycle_count", 1)
        base_min_score = state.get("code_review_min_score", MIN_CODE_REVIEW_SCORE)
        
        if main_cycle_count == 1:
            # First attempt: require higher score (8)
            min_score = max(8, base_min_score)
        else:
            # Retries: use base score but never below absolute minimum (7)
            min_score = max(base_min_score, MIN_CODE_REVIEW_SCORE)
        
        passed = overall_score >= min_score and len(critical_issues) == 0 and goal_aligned
        
        logger.info("Score: %d/10 (min=%d, cycle=%d), Critical: %d, Aligned: %s, Passed: %s", 
                   overall_score, min_score, main_cycle_count, len(critical_issues), goal_aligned, passed)
        
        return {
            "code_review": review_data,
            "code_review_passed": passed,
            "code_review_score": overall_score
        }
        
    except Exception as e:
        logger.error("Error: %s", e)
        return {
            "code_review": {"overall_score": 0, "issues": [], "summary": f"Review failed: {e}"},
            "code_review_passed": False,
            "code_review_score": 0,
            "code_review_error": "execution_failed"
        }
