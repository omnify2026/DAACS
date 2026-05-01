import json
import re
from pathlib import Path
from typing import Dict, Any, List


_TEMPLATE_CACHE: Dict[str, Any] | None = None


def _load_templates() -> Dict[str, Any]:
    global _TEMPLATE_CACHE
    if _TEMPLATE_CACHE is not None:
        return _TEMPLATE_CACHE

    template_path = Path(__file__).with_name("spec_templates.json")
    try:
        with open(template_path, "r", encoding="utf-8") as f:
            _TEMPLATE_CACHE = json.load(f)
    except (json.JSONDecodeError, OSError):
        _TEMPLATE_CACHE = {
            "domain_templates": {"default": {"features": [], "entities": [], "ui_sections": []}},
            "default_assumptions": {},
            "required_files": [],
            "ui_states": [],
            "constraints": [],
        }
    return _TEMPLATE_CACHE


def _classify_domain(goal: str) -> str:
    text = (goal or "").lower()
    if any(k in text for k in ["stock", "stocks", "ticker", "portfolio", "watchlist", "price"]):
        return "stock_dashboard"
    if any(k in text for k in ["dashboard", "analytics", "kpi", "metrics", "insight"]):
        return "analytics_dashboard"
    if any(k in text for k in ["chat", "messaging", "conversation"]):
        return "chat_app"
    if any(k in text for k in ["auth", "login", "signup", "register", "session"]):
        return "auth_app"
    if any(k in text for k in ["crud", "inventory", "catalog", "records", "management"]):
        return "crud_app"
    return "default"


def _extract_keywords(goal: str) -> List[str]:
    text = re.sub(r"[^a-z0-9\\s-]", " ", (goal or "").lower())
    tokens = [t for t in text.split() if len(t) > 2]
    seen = []
    for token in tokens:
        if token not in seen:
            seen.append(token)
        if len(seen) >= 8:
            break
    return seen


def build_auto_spec(goal: str, assumptions: Dict[str, Any], tech_context: Dict[str, Any]) -> Dict[str, Any]:
    templates = _load_templates()
    domain_templates = templates.get("domain_templates", {})
    domain = _classify_domain(goal)
    template = domain_templates.get(domain, domain_templates.get("default", {}))
    keywords = _extract_keywords(goal)

    return {
        "goal": goal,
        "domain": domain,
        "keywords": keywords,
        "assumptions": templates.get("default_assumptions", {}),
        "required_files": templates.get("required_files", []),
        "ui_states": templates.get("ui_states", []),
        "entities": template.get("entities", []),
        "features": template.get("features", []),
        "ui_sections": template.get("ui_sections", []),
        "constraints": templates.get("constraints", []),
    }
