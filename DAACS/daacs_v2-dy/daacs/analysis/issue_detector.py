"""
DAACS - Code Issue Detector
Extracted from project_analysis.py for modularity.
"""
from typing import List
from .models import FunctionInfo, ClassInfo, CodeIssue

# Configurable thresholds
COMPLEXITY_WARNING = 15
COMPLEXITY_CRITICAL = 25
LINES_WARNING = 100
LINES_CRITICAL = 200
PARAMS_WARNING = 7


def detect_issues(
    functions: List[FunctionInfo],
    classes: List[ClassInfo]
) -> List[CodeIssue]:
    """Detect code issues based on functions and classes."""
    issues = []
    
    # 1. High complexity functions
    for f in functions:
        if f.complexity > COMPLEXITY_CRITICAL:
            issues.append(CodeIssue(
                category="complexity",
                severity="critical",
                file=f.file,
                line=f.line_start,
                description=f"Function '{f.name}' has very high complexity ({f.complexity})",
                suggestion="Split into smaller functions"
            ))
        elif f.complexity > COMPLEXITY_WARNING:
            issues.append(CodeIssue(
                category="complexity",
                severity="warning",
                file=f.file,
                line=f.line_start,
                description=f"Function '{f.name}' has high complexity ({f.complexity})",
                suggestion="Consider refactoring"
            ))
    
    # 2. Very long functions
    for f in functions:
        if f.lines_of_code > LINES_CRITICAL:
            issues.append(CodeIssue(
                category="size",
                severity="critical",
                file=f.file,
                line=f.line_start,
                description=f"Function '{f.name}' is too long ({f.lines_of_code} lines)",
                suggestion="Split into smaller functions"
            ))
        elif f.lines_of_code > LINES_WARNING:
            issues.append(CodeIssue(
                category="size",
                severity="warning",
                file=f.file,
                line=f.line_start,
                description=f"Function '{f.name}' is long ({f.lines_of_code} lines)",
                suggestion="Consider refactoring"
            ))
    
    # 3. Too many parameters
    for f in functions:
        if len(f.params) > PARAMS_WARNING:
            issues.append(CodeIssue(
                category="design",
                severity="warning",
                file=f.file,
                line=f.line_start,
                description=f"Function '{f.name}' has many parameters ({len(f.params)})",
                suggestion="Use parameter object pattern"
            ))
    
    # 4. Missing docstrings
    for f in functions:
        if not f.docstring and not f.name.startswith('_'):
            issues.append(CodeIssue(
                category="documentation",
                severity="info",
                file=f.file,
                line=f.line_start,
                description=f"Function '{f.name}' lacks docstring",
                suggestion="Add docstring"
            ))
    
    for c in classes:
        if not c.docstring:
            issues.append(CodeIssue(
                category="documentation",
                severity="info",
                file=c.file,
                line=c.line_start,
                description=f"Class '{c.name}' lacks docstring",
                suggestion="Add docstring"
            ))
    
    return issues
