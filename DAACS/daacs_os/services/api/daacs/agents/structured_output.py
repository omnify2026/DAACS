"""Helpers for structured LLM output parsing in collaboration flows."""

from __future__ import annotations

import json
from typing import Any, Dict, Iterable, List, Sequence


def clean_text(value: Any) -> str:
    return str(value or "").strip()


def truncate(value: Any, limit: int = 320) -> str:
    text = " ".join(clean_text(value).split())
    if len(text) <= limit:
        return text
    return f"{text[: max(limit - 3, 0)].rstrip()}..."


def dedupe_lines(items: Iterable[str]) -> List[str]:
    seen: set[str] = set()
    ordered: List[str] = []
    for item in items:
        value = clean_text(item)
        if not value or value in seen:
            continue
        seen.add(value)
        ordered.append(value)
    return ordered


def normalize_lines(value: Any) -> List[str]:
    if value is None:
        return []
    if isinstance(value, str):
        parts = [segment.strip(" -*\t") for segment in value.splitlines()]
        return dedupe_lines(parts or [value])
    if isinstance(value, (list, tuple, set)):
        lines: List[str] = []
        for item in value:
            lines.extend(normalize_lines(item))
        return dedupe_lines(lines)
    return []


def string_list(value: Any) -> List[str]:
    if value is None:
        return []
    if isinstance(value, str):
        return [clean_text(value)] if clean_text(value) else []
    if isinstance(value, (list, tuple, set)):
        return dedupe_lines(str(item) for item in value if clean_text(item))
    return []


def extract_json_object(raw: str) -> Dict[str, Any]:
    text = clean_text(raw)
    if not text:
        raise ValueError("empty structured response")
    try:
        data = json.loads(text)
        if isinstance(data, dict):
            return data
    except json.JSONDecodeError:
        pass

    first = text.find("{")
    last = text.rfind("}")
    if first >= 0 and last > first:
        data = json.loads(text[first : last + 1])
        if isinstance(data, dict):
            return data
    raise ValueError("could not parse structured JSON object")


def safe_extract_json_object(raw: str) -> Dict[str, Any]:
    try:
        return extract_json_object(raw)
    except (ValueError, json.JSONDecodeError, TypeError):
        return {}


def first_text(values: Sequence[Any], *, limit: int = 320) -> str:
    for value in values:
        text = truncate(value, limit)
        if text:
            return text
    return ""


def render_context_sections(sections: Sequence[tuple[str, Any]]) -> str:
    blocks: List[str] = []
    for title, value in sections:
        text = clean_text(value)
        if not text:
            continue
        blocks.append(f"## {title}\n{text}")
    return "\n\n".join(blocks).strip()
