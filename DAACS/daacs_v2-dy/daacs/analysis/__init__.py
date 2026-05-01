"""
DAACS Analysis Package
Modular project analysis components.
"""
from .models import (
    FunctionInfo,
    ClassInfo,
    ImportInfo,
    DependencyInfo,
    CodeIssue,
    ProjectAnalysis,
    CodePatch,
)
from .python_analyzer import analyze_python_file
from .dependency_analyzer import (
    analyze_python_dependencies,
    analyze_node_dependencies,
    analyze_all_dependencies,
)
from .issue_detector import detect_issues

__all__ = [
    # Models
    "FunctionInfo",
    "ClassInfo",
    "ImportInfo",
    "DependencyInfo",
    "CodeIssue",
    "ProjectAnalysis",
    "CodePatch",
    # Analyzers
    "analyze_python_file",
    "analyze_python_dependencies",
    "analyze_node_dependencies",
    "analyze_all_dependencies",
    "detect_issues",
]
