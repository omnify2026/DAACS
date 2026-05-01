"""
DAACS - Dependency Analyzer
Extracted from project_analysis.py for modularity.
"""
import os
import re
import json
from typing import List
from .models import DependencyInfo


def analyze_python_dependencies(project_dir: str) -> List[DependencyInfo]:
    """Analyze Python dependencies from requirements.txt."""
    dependencies = []
    requirements_txt = os.path.join(project_dir, "requirements.txt")
    
    if os.path.exists(requirements_txt):
        try:
            with open(requirements_txt, 'r', encoding='utf-8') as f:
                for line in f:
                    line = line.strip()
                    if line and not line.startswith('#'):
                        match = re.match(r'^([a-zA-Z0-9_-]+)(?:[=><~!]+([0-9.]+))?', line)
                        if match:
                            dependencies.append(DependencyInfo(
                                name=match.group(1),
                                version=match.group(2) or "latest"
                            ))
        except OSError:
            pass
    
    return dependencies


def analyze_node_dependencies(project_dir: str) -> List[DependencyInfo]:
    """Analyze Node.js dependencies from package.json."""
    dependencies = []
    package_json = os.path.join(project_dir, "package.json")
    
    if os.path.exists(package_json):
        try:
            with open(package_json, 'r', encoding='utf-8') as f:
                pkg = json.load(f)
            
            for name, version in pkg.get("dependencies", {}).items():
                dependencies.append(DependencyInfo(
                    name=name,
                    version=version.lstrip('^~'),
                    is_dev=False
                ))
            
            for name, version in pkg.get("devDependencies", {}).items():
                dependencies.append(DependencyInfo(
                    name=name,
                    version=version.lstrip('^~'),
                    is_dev=True
                ))
        except (json.JSONDecodeError, OSError):
            pass
    
    return dependencies


def analyze_all_dependencies(project_dir: str) -> List[DependencyInfo]:
    """Analyze all dependencies (Python + Node.js)."""
    deps = analyze_python_dependencies(project_dir)
    deps.extend(analyze_node_dependencies(project_dir))
    return deps
