import re
from typing import Dict, Any, Tuple, List

class CodePatcher:
    """
    Deterministically patches code to enforce constraints.
    Prevents unnecessary LLM retry loops for simple fixes.
    """
    
    @staticmethod
    def patch(code: str, constraints: Dict[str, Any]) -> Tuple[str, bool]:
        """
        Apply patches. Returns (new_code, was_patched).
        """
        patched_code = code
        was_patched = False
        
        # 1. Port Patching (e.g., port=5000 -> port=8000)
        target_port = str(constraints.get("port", "8000"))
        # Regex for uvicorn.run(..., port=XXXX) or app.run(..., port=XXXX)
        port_pattern = r"(port\s*=\s*)(\d{4,5})"
        
        def port_replacer(match):
            nonlocal was_patched
            current_port = match.group(2)
            if current_port != target_port:
                was_patched = True
                return f"{match.group(1)}{target_port}"
            return match.group(0)
            
        patched_code = re.sub(port_pattern, port_replacer, patched_code)
        
        patched_code = re.sub(port_pattern, port_replacer, patched_code)
        
        # 2. API Prefix Patching
        target_prefix = constraints.get("api_prefix")
        if target_prefix:
            # Common patterns: @app.get("/"), @router.get("/"), url: "/"
            # We want to ensure routes start with prefix IF they are API routes
            # This is tricky regex. A safer approach for "Unification" is to look for
            # specific definitions like `API_PREFIX = "..."` or specific FastAPI/Flask route decorators.
            
            # Pattern 1: Hardcoded prefixes in FastAPI/Flask
            # e.g. prefix="/old" -> prefix="/new"
            prefix_arg_pattern = r'(prefix\s*=\s*["\'])([^"\']*)(["\'])'
            
            def prefix_replacer(match):
                nonlocal was_patched
                current = match.group(2)
                if current != target_prefix:
                    was_patched = True
                    return f"{match.group(1)}{target_prefix}{match.group(3)}"
                return match.group(0)
            
            patched_code = re.sub(prefix_arg_pattern, prefix_replacer, patched_code)
            
            # Pattern 2: Replace Base URL constants
            # e.g. BASE_URL = "/api" -> BASE_URL = "/api/v1"
            const_pattern = r'(API_PREFIX|BASE_URL)(\s*=\s*["\'])([^"\']*)(["\'])'
            patched_code = re.sub(const_pattern, prefix_replacer, patched_code)
            
            # Pattern 3: Inject prefix into bare decorators if needed (Riskier, but "Global Sync" implies force)
            # e.g. @app.get("/") -> @app.get("/api/v1/")
            # Skipping for now to avoid breaking static file serving, but this is where the "Global Node" would act.

        return patched_code, was_patched

    @staticmethod
    def check_and_fix_syntax(code: str, filename: str) -> Tuple[str, bool, List[str]]:
        """
        Check syntax using AST. If simple error, try to fix.
        Returns: (fixed_code, was_fixed, errors)
        """
        import ast
        errors = []
        if not filename.endswith(".py"):
            return code, False, []

        try:
            ast.parse(code)
            return code, False, []
        except SyntaxError as e:
            # We found a syntax error.
            error_msg = f"Syntax Error at line {e.lineno}: {e.msg}"
            errors.append(error_msg)
            
            # Simple Patch Attempt: Missing Colon after def/class/if/else/try/except
            # This is a very common LLM typo.
            lines = code.split('\n')
            if 1 <= e.lineno <= len(lines):
                line_idx = e.lineno - 1
                line = lines[line_idx]
                stripped = line.rstrip()
                
                # Check if it looks like a block statement missing a colon
                if re.match(r'^\s*(def|class|if|elif|else|try|except|while|for|with)\b', stripped) and not stripped.endswith(':'):
                    # SAFETY: Only add colon if it's clearly missing at end of line
                    lines[line_idx] = line.rstrip() + ":"
                    patched_code = "\n".join(lines)
                    
                    # Verify if patch fixed it
                    try:
                        ast.parse(patched_code)
                        return patched_code, True, [] # Fixed!
                    except SyntaxError:
                        pass # Patch didn't work, revert
                        
            return code, False, errors
