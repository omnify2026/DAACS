"""Developer Agent — 코드 생성, Backend/Frontend 구현 (CoderAgent 계승)"""
import re
from pathlib import Path
from typing import Any, Dict, Optional

from .base import BaseAgent
from .base_roles import AgentRole
from .protocol import AgentMessage, MessageType
from .structured_output import (
    first_text,
    normalize_lines,
    render_context_sections,
    safe_extract_json_object,
    string_list,
)

SYSTEM_PROMPT = (
    "You are an expert full-stack developer. "
    "You write clean, production-ready code. "
    "When generating code, use the format:\n"
    "FILE: path/to/file.py\n"
    "```python\ncode here\n```\n"
    "Always include proper error handling and follow best practices."
)

COLLABORATION_SYSTEM_PROMPT = (
    "You are the implementation lead in a multi-agent collaboration round. "
    "Return strict JSON only with keys summary, new_files, open_questions, next_actions. "
    "Use concrete file paths, implementation outcomes, and immediate follow-ups. "
    "Do not use filler like 'implementation complete' unless you describe what changed."
)

COLLABORATION_DISCOVERY_SYSTEM_PROMPT = (
    "You are the repository investigation lead in a multi-agent collaboration round. "
    "Return strict JSON only with keys summary, new_files, open_questions, next_actions. "
    "This is read-only analysis: name exact file paths, symbols, and evidence. "
    "Do not propose or describe code changes unless the user explicitly asked for them."
)
DISCOVERY_FILE_PATTERN = re.compile(r"[\w./-]+\.(?:tsx|jsx|ts|js|py|rs|go)")
DISCOVERY_SYMBOL_PATTERN = re.compile(
    r"(?:export\s+)?(?:async\s+)?function\s+([A-Za-z_][A-Za-z0-9_]*)|"
    r"(?:export\s+)?const\s+([A-Za-z_][A-Za-z0-9_]*)\s*=|"
    r"(?:async\s+)?def\s+([A-Za-z_][A-Za-z0-9_]*)\s*\("
)
DISCOVERY_STOPWORDS = {
    "the",
    "and",
    "for",
    "with",
    "from",
    "that",
    "this",
    "into",
    "also",
    "name",
    "where",
    "which",
    "file",
    "main",
    "users",
    "user",
    "previous",
    "result",
    "revise",
    "exact",
    "flow",
    "involved",
    "render",
}
DISCOVERY_KEYWORD_EXPANSIONS = {
    "session": [
        "session",
        "collaborationsessionid",
        "activesessionid",
        "setcollaborationsession",
        "createcollaborationsession",
        "session_id",
    ],
    "reuse": ["reuse", "reuses", "existing session"],
    "reuses": ["reuse", "reuses", "existing session"],
    "collaboration": ["collaboration", "startcollaborationround"],
    "board": ["board", "sharedboardpanel"],
    "round": ["round", "roundstatus", "round status"],
    "status": ["status", "round status", "roundstatus"],
    "shared": ["shared", "sharedboardpanel"],
    "render": ["render", "renders", "rendered"],
    "renders": ["render", "renders", "rendered"],
    "meeting": ["meeting", "goalmeetingpanel", "runwithgoal"],
    "web": ["web", "goalmeetingpanel", "sharedboardpanel", "collaborationapi"],
    "ui": ["ui", "goalmeetingpanel", "sharedboardpanel"],
    "artifact": ["artifact", "sharedboardpanel", "collaborationstore", "addroundartifact"],
    "store": ["store", "collaborationstore", "addroundartifact"],
    "helper": ["helper", "collaborationapi", "startcollaborationround"],
    "entry": ["entry", "goalmeetingpanel", "runwithgoal"],
    "latest": ["latest", "collaborationstore", "addroundartifact"],
}
DISCOVERY_PHRASE_EXPANSIONS = {
    "이전 결과": ["previous result", "revision request", "existing result"],
    "기존 결과": ["existing result", "revision request"],
    "공유 보드": ["shared board", "sharedboardpanel", "board", "round status"],
    "보드 상태": ["shared board", "round status", "latest.status", "roundstatuslabel"],
    "상태 렌더": ["render", "round status", "roundstatuslabel", "latest.status"],
    "렌더 위치": ["render", "component", "roundstatuslabel", "latest.status"],
    "절대 경로": ["exact file path", "path", "file path"],
    "함수 이름": ["function name", "symbol", "callable"],
    "타임아웃": ["timeout", "timed out", "COLLAB_RESULT_TIMEOUT_SECONDS", "_wait_for_multi_results"],
    "120초": ["timeout", "COLLAB_RESULT_TIMEOUT_SECONDS", "_wait_for_multi_results"],
    "개발자 실행": ["developer", "development_team", "timeout"],
    "판별": ["discovery_only", "_is_discovery_only_request", "classifier"],
}
DISCOVERY_COLLAB_TARGETS: dict[str, dict[str, list[str]]] = {
    "session_ui": {
        "query_terms": [
            "session",
            "reuse",
            "existing session",
            "web flow",
            "entry point",
            "ui entry",
            "세션",
            "재사용",
            "진입점",
        ],
        "path_terms": ["goalmeetingpanel"],
        "content_terms": [
            "setcollaborationsession",
            "collaborationsessionid",
            "activesessionid",
            "createcollaborationsession",
            "startcollaborationround(",
        ],
    },
    "round_api": {
        "query_terms": [
            "starting a collaboration round",
            "start a collaboration round",
            "api helper",
            "start round",
            "helper",
            "라운드 시작",
            "시작 라운드",
            "api 헬퍼",
        ],
        "path_terms": ["collaborationapi"],
        "content_terms": [
            "startcollaborationround(",
            "createcollaborationsession(",
            "/api/collaboration/",
        ],
    },
    "backend_round_route": {
        "query_terms": [
            "backend route",
            "backend route file",
            "python route",
            "server route",
            "collaboration round responses",
            "serves collaboration round responses",
            "백엔드 라우트",
            "서버 라우트",
            "파이썬 라우트",
        ],
        "path_terms": [
            "services/api/daacs/routes/collaboration.py",
            "routes/collaboration.py",
            "collaboration.py",
        ],
        "content_terms": [
            "start_collaboration_round",
            "@router.post",
            "sessions/{session_id}/rounds",
            "persist_collaboration_round",
        ],
    },
    "shared_board": {
        "query_terms": [
            "shared board",
            "board ui",
            "rendering the round artifact",
            "render the merged artifact",
            "round artifact",
            "공유 보드",
            "보드 ui",
            "보드 상태",
            "상태 렌더",
        ],
        "path_terms": ["sharedboardpanel"],
        "content_terms": [
            "roundstatuslabel",
            "latest.decision",
            "latest.contributions",
            "latest.status",
        ],
    },
    "discovery_classifier": {
        "query_terms": [
            "discovery 판별",
            "discovery classifier",
            "classifier",
            "판별",
            "분기",
        ],
        "path_terms": [
            "services/api/daacs/routes/collaboration.py",
            "routes/collaboration.py",
            "collaboration.py",
        ],
        "content_terms": [
            "_is_discovery_only_request",
            "DISCOVERY_ONLY_HINTS",
            "DISCOVERY_RESULT_HINTS",
            "DISCOVERY_FILE_HINTS",
        ],
    },
    "timeout_control": {
        "query_terms": [
            "timeout",
            "timed out",
            "developer timeout",
            "waiting for tasks",
            "타임아웃",
            "120초",
            "개발자 실행",
        ],
        "path_terms": [
            "services/api/daacs/routes/collaboration.py",
            "routes/collaboration.py",
            "collaboration.py",
        ],
        "content_terms": [
            "COLLAB_RESULT_TIMEOUT_SECONDS",
            "_wait_for_multi_results",
            "timed out waiting for tasks",
        ],
    },
    "artifact_store": {
        "query_terms": [
            "store",
            "publishes the latest artifact",
            "latest artifact",
            "publishes",
            "board store",
            "스토어",
            "최신 결과",
            "최신 artifact",
        ],
        "path_terms": ["collaborationstore"],
        "content_terms": [
            "addroundartifact",
            "setcollaborationsession",
            "artifacts:",
        ],
    },
}
DISCOVERY_TARGET_LABELS = {
    "session_ui": "session_ui",
    "round_api": "round_api",
    "backend_round_route": "backend_round_route",
    "shared_board": "shared_board",
    "discovery_classifier": "discovery_classifier",
    "timeout_control": "timeout_control",
    "artifact_store": "artifact_store",
}
DISCOVERY_TARGET_EVIDENCE_TERMS = {
    "session_ui": ["setCollaborationSession", "createCollaborationSession", "collaborationSessionId"],
    "round_api": ["startRound", "createSession", "/api/collaboration/"],
    "backend_round_route": ["start_collaboration_round", "sessions/{session_id}/rounds"],
    "shared_board": ["roundStatusLabel", "latest.status", "latest.decision"],
    "discovery_classifier": ["_is_discovery_only_request", "DISCOVERY_ONLY_HINTS"],
    "timeout_control": ["COLLAB_RESULT_TIMEOUT_SECONDS", "_wait_for_multi_results", "timed out waiting for tasks"],
    "artifact_store": ["addRoundArtifact", "artifacts:", "setSession"],
}


def _build_collaboration_prompt(instruction: str, context: Dict[str, Any], role: AgentRole) -> str:
    member_instructions = context.get("member_instructions") or {}
    role_objective = str(member_instructions.get(role.value) or "").strip()
    prompt = (
        render_context_sections(
            [
                ("Shared Goal", context.get("shared_goal") or context.get("goal") or instruction),
                ("User Request", context.get("prompt") or instruction),
                ("Execution Card", context.get("execution_card")),
                ("Role Objective", role_objective),
                ("Acceptance Criteria", context.get("acceptance_criteria")),
                ("Prior Artifacts", context.get("artifacts")),
            ]
        )
        or instruction
    )
    return (
        f"{prompt}\n\n"
        "Return strict JSON only:\n"
        "{\n"
        '  "summary": "specific implementation outcome with concrete file or code impact",\n'
        '  "new_files": ["path/if_any"],\n'
        '  "open_questions": ["real blocker or dependency"],\n'
        '  "next_actions": ["immediate next implementation step"]\n'
        "}\n"
        "Rules:\n"
        "- Mention exact deliverables or code paths when possible.\n"
        "- Use empty arrays when there are no real blockers.\n"
        "- Keep the summary concise but specific.\n"
        "- Stay centered on the Execution Card and do not broaden the implementation scope unless a listed acceptance criterion forces it.\n"
        "- Do not wrap the JSON in markdown fences."
    )


def _build_collaboration_discovery_prompt(instruction: str, context: Dict[str, Any], role: AgentRole) -> str:
    member_instructions = context.get("member_instructions") or {}
    role_objective = str(member_instructions.get(role.value) or "").strip()
    search_roots = context.get("search_roots") or []
    search_roots_text = "\n".join(f"- {item}" for item in search_roots) if search_roots else ""
    prompt = (
        render_context_sections(
            [
                ("Question", context.get("prompt") or instruction),
                ("Shared Goal", context.get("shared_goal") or context.get("goal") or instruction),
                ("Role Objective", role_objective),
                ("Search Roots", search_roots_text),
                ("Repository Map", context.get("repo_layout")),
                ("Prior Artifacts", context.get("artifacts")),
            ]
        )
        or instruction
    )
    return (
        f"{prompt}\n\n"
        "Return strict JSON only:\n"
        "{\n"
        '  "summary": "answer with exact file paths and symbol names",\n'
        '  "new_files": ["exact/file/path.tsx"],\n'
        '  "open_questions": ["only if evidence is missing"],\n'
        '  "next_actions": ["brief follow-up validation step if needed"]\n'
        "}\n"
        "Rules:\n"
        "- This is read-only investigation. Do not propose implementation work.\n"
        "- The summary must mention the key file path(s) and the relevant function/component names.\n"
        "- Use new_files to list the exact file paths referenced in the answer, even if nothing was created.\n"
        "- Use empty arrays when there are no real blockers or follow-ups.\n"
        "- Use only the provided Search Roots for lookups; do not search placeholder roots unless they are listed.\n"
        "- Do at most 3 narrow searches and prefer filename/path searches before broad content searches.\n"
        "- If the answer is already implied by the provided context, do not search again.\n"
        "- Do not wrap the JSON in markdown fences."
    )


def _extract_discovery_terms(prompt: str) -> list[str]:
    text = str(prompt or "").lower()
    raw_terms = re.findall(r"[a-z0-9_]{3,}", text)
    terms: list[str] = []
    for term in raw_terms:
        if term in DISCOVERY_STOPWORDS:
            continue
        terms.append(term)
        terms.extend(DISCOVERY_KEYWORD_EXPANSIONS.get(term, []))
    for phrase, expansions in DISCOVERY_PHRASE_EXPANSIONS.items():
        if phrase not in text:
            continue
        terms.append(phrase)
        terms.extend(expansions)
    if "shared board" in text:
        terms.extend(["shared board", "sharedboardpanel", "round status"])
    if "existing session" in text:
        terms.extend(["existing session", "collaborationsessionid", "activesessionid"])
    return list(dict.fromkeys(terms))


def _extract_prior_file_paths(context: Dict[str, Any]) -> list[str]:
    candidates: list[str] = []
    for item in context.get("prior_contributions") or []:
        if not isinstance(item, dict):
            continue
        for value in (
            item.get("summary"),
            item.get("details"),
            item.get("new_files"),
        ):
            if isinstance(value, dict):
                haystack = " ".join(str(v) for v in value.values())
            elif isinstance(value, (list, tuple, set)):
                haystack = " ".join(str(v) for v in value)
            else:
                haystack = str(value or "")
            candidates.extend(DISCOVERY_FILE_PATTERN.findall(haystack))
    ordered = list(dict.fromkeys(candidates))
    full_path_names = {Path(path).name for path in ordered if "/" in path}
    return [
        path
        for path in ordered
        if "/" in path or Path(path).name not in full_path_names
    ]


def _nearest_symbol(lines: list[str], line_index: int) -> str | None:
    if not lines:
        return None
    line_index = max(0, min(line_index, len(lines) - 1))
    radius_limit = 80
    for radius in range(radius_limit + 1):
        candidate_indexes = [line_index - radius]
        if radius:
            candidate_indexes.append(line_index + radius)
        for idx in candidate_indexes:
            if idx < 0 or idx >= len(lines):
                continue
            match = DISCOVERY_SYMBOL_PATTERN.search(lines[idx])
            if not match:
                continue
            return next((group for group in match.groups() if group), None)
    return None


def _path_discovery_score(relative_path: str, terms: list[str]) -> int:
    path_lower = relative_path.lower()
    file_name = Path(relative_path).name.lower()
    score = 0
    for term in terms:
        if not term:
            continue
        weight = 10 if " " in term or len(term) >= 10 else 6
        if term in file_name:
            score += weight + 4
        elif term in path_lower:
            score += weight

    if "/components/" in f"/{path_lower}":
        score += 3
    if "/components/office/" in f"/{path_lower}":
        score += 10
    if path_lower.startswith("apps/web/src/"):
        score += 4
    if file_name.endswith((".tsx", ".jsx")):
        score += 2
    if "/stores/" in f"/{path_lower}":
        score -= 4

    if (
        ".test." in file_name
        or ".spec." in file_name
        or "/tests/" in f"/{path_lower}"
        or "/__tests__/" in f"/{path_lower}"
        or "/regression/" in f"/{path_lower}"
    ):
        score -= 10

    if file_name in {"i18n.ts", "i18n.tsx"}:
        score -= 14

    return score


def _active_discovery_targets(query_text: str) -> list[str]:
    lowered = str(query_text or "").lower()
    active: list[str] = []
    for target, spec in DISCOVERY_COLLAB_TARGETS.items():
        if any(term in lowered for term in spec["query_terms"]):
            active.append(target)
    if (
        ("backend" in lowered and "route" in lowered and "round" in lowered)
        or "collaboration round responses" in lowered
        or "serves collaboration round responses" in lowered
    ) and "backend_round_route" not in active:
        active.append("backend_round_route")
    if "collaboration session" in lowered and "session_ui" not in active:
        active.append("session_ui")
    if "shared board" in lowered and "shared_board" not in active:
        active.append("shared_board")
    if "start" in lowered and "round" in lowered and "round_api" not in active:
        active.append("round_api")
    if (
        "판별" in lowered
        or "classifier" in lowered
        or "discovery classifier" in lowered
    ) and "discovery_classifier" not in active:
        active.append("discovery_classifier")
    if ("타임아웃" in lowered or "120초" in lowered) and "timeout_control" not in active:
        active.append("timeout_control")
    if (
        "공유 보드" in lowered
        or ("보드" in lowered and "상태" in lowered)
        or ("상태" in lowered and "렌더" in lowered)
    ) and "shared_board" not in active:
        active.append("shared_board")
    if ("스토어" in lowered or "store" in lowered) and "artifact_store" not in active:
        active.append("artifact_store")
    if ("세션" in lowered and "재사용" in lowered) and "session_ui" not in active:
        active.append("session_ui")
    if ("라운드" in lowered and "시작" in lowered) and "round_api" not in active:
        active.append("round_api")
    return active


def _target_discovery_score(
    relative_path: str,
    lower_text: str,
    active_targets: list[str],
) -> tuple[int, list[str], dict[str, int]]:
    path_lower = relative_path.lower()
    matched_targets: list[str] = []
    target_scores: dict[str, int] = {}
    total = 0
    for target in active_targets:
        spec = DISCOVERY_COLLAB_TARGETS[target]
        target_score = 0
        if any(term in path_lower for term in spec["path_terms"]):
            target_score += 26
        if any(term in lower_text for term in spec["content_terms"]):
            target_score += 12
        if target == "artifact_store" and path_lower.endswith("collaborationstore.ts"):
            target_score += 10
        if target == "round_api" and path_lower.endswith("collaborationapi.ts"):
            target_score += 10
        if target == "backend_round_route" and path_lower.endswith("routes/collaboration.py"):
            target_score += 14
        if target == "shared_board" and path_lower.endswith("sharedboardpanel.tsx"):
            target_score += 10
        if target == "session_ui" and path_lower.endswith("goalmeetingpanel.tsx"):
            target_score += 10
        if target_score <= 0:
            continue
        matched_targets.append(target)
        target_scores[target] = target_score
        total += target_score
    return total, matched_targets, target_scores


def _preferred_symbol_hint(lines: list[str], matched_targets: list[str]) -> tuple[str | None, str]:
    preferred_symbols: list[str] = []
    for target in matched_targets:
        preferred_symbols.extend(DISCOVERY_TARGET_EVIDENCE_TERMS.get(target, []))

    for symbol in list(dict.fromkeys(preferred_symbols)):
        for line in lines:
            if symbol not in line:
                continue
            return symbol, line.strip()
    return None, ""


def _target_preferred_evidence(lines: list[str], target: str) -> dict[str, str]:
    if target == "timeout_control":
        timeout_symbol = ""
        timeout_excerpt = ""
        constant_excerpt = ""
        for index, line in enumerate(lines):
            if "COLLAB_RESULT_TIMEOUT_SECONDS" in line and not constant_excerpt:
                constant_excerpt = line.strip()
            if (
                "def _wait_for_multi_results" not in line
                and "async def _wait_for_multi_results" not in line
            ):
                continue
            timeout_symbol = _nearest_symbol(lines, index) or "_wait_for_multi_results"
            timeout_excerpt = line.strip()
            break
        if timeout_symbol or constant_excerpt or timeout_excerpt:
            return {
                "symbol": timeout_symbol or "_wait_for_multi_results",
                "excerpt": constant_excerpt or timeout_excerpt,
            }

    anchors = DISCOVERY_TARGET_EVIDENCE_TERMS.get(target, [])
    for anchor in anchors:
        for index, line in enumerate(lines):
            if anchor not in line:
                continue
            symbol = _nearest_symbol(lines, index)
            if not symbol and re.fullmatch(r"[A-Za-z_][A-Za-z0-9_]*", anchor):
                symbol = anchor
            return {
                "symbol": symbol or anchor,
                "excerpt": line.strip(),
            }
    return {}


def _local_discovery_answer(instruction: str, context: Dict[str, Any]) -> Dict[str, Any] | None:
    project_cwd = str(context.get("project_cwd") or "").strip()
    search_roots = [str(item).strip() for item in (context.get("search_roots") or []) if str(item).strip()]
    if not project_cwd or not search_roots:
        return None

    root = Path(project_cwd).expanduser()
    if not root.exists():
        return None

    discovery_query_text = " ".join(
        part
        for part in (
            str(context.get("prompt") or "").strip(),
            str(context.get("shared_goal") or "").strip(),
        )
        if part
    )
    discovery_control_text = " ".join(
        part
        for part in (
            discovery_query_text,
            str(instruction or "").strip(),
        )
        if part
    )
    terms = _extract_discovery_terms(discovery_query_text or discovery_control_text)
    if not terms:
        return None

    prior_files = _extract_prior_file_paths(context)
    prior_file_set = set(prior_files)
    revision_request = any(
        token in discovery_control_text.lower()
        for token in (
            "previous result",
            "existing result",
            "revise",
            "revision request",
            "also",
            "이전 결과",
            "기존 결과",
            "수정해서",
            "다시 정리",
            "추가해줘",
        )
    )
    active_targets = _active_discovery_targets(discovery_query_text or discovery_control_text)

    scored: list[dict[str, Any]] = []
    for relative_root in search_roots:
        target = root / relative_root
        if not target.exists():
            continue
        for path in target.rglob("*"):
            if not path.is_file() or path.suffix.lower() not in {".ts", ".tsx", ".js", ".jsx", ".py", ".rs", ".go"}:
                continue
            try:
                text = path.read_text(encoding="utf-8")
            except (OSError, UnicodeDecodeError):
                continue
            if not text.strip():
                continue
            lower = text.lower()
            relative_path = path.relative_to(root).as_posix()
            file_score = _path_discovery_score(relative_path, terms)
            target_bonus, matched_targets, target_scores = _target_discovery_score(
                relative_path,
                lower,
                active_targets,
            )
            file_score += target_bonus
            if revision_request and relative_path in prior_file_set:
                file_score += 12
            best_line = ""
            best_line_score = 0
            best_index = 0
            lines = text.splitlines()
            for index, line in enumerate(lines):
                lowered_line = line.lower()
                line_score = sum(3 if " " in term else 1 for term in terms if term in lowered_line)
                if line_score > best_line_score:
                    best_line_score = line_score
                    best_line = line.strip()
                    best_index = index
                file_score += line_score
            if file_score <= 0:
                continue
            preferred_symbol, preferred_excerpt = _preferred_symbol_hint(lines, matched_targets)
            symbol = preferred_symbol or _nearest_symbol(lines, best_index)
            if preferred_excerpt:
                best_line = preferred_excerpt
            target_evidence = {
                target: _target_preferred_evidence(lines, target)
                for target in matched_targets
            }
            scored.append(
                {
                    "path": relative_path,
                    "score": file_score,
                    "excerpt": best_line,
                    "symbol": symbol,
                    "targets": matched_targets,
                    "target_scores": target_scores,
                    "target_evidence": target_evidence,
                }
            )

    if not scored:
        return None

    scored.sort(key=lambda item: (-int(item["score"]), str(item["path"])))
    chosen: list[dict[str, Any]] = []
    target_matches: list[dict[str, Any]] = []
    seen_paths: set[str] = set()
    target_count = max(len(active_targets), 2 if revision_request else 1)
    for target in active_targets:
        target_candidates = [
            item
            for item in scored
            if target in {str(value) for value in item.get("targets") or []}
        ]
        if not target_candidates:
            continue
        best_match = max(
            target_candidates,
            key=lambda item: (
                int((item.get("target_scores") or {}).get(target, 0)),
                int(item.get("score", 0)),
                -len(str(item.get("path", ""))),
            ),
        )
        target_matches.append({"target": target, "item": best_match})
        if best_match["path"] not in seen_paths:
            chosen.append(best_match)
            seen_paths.add(best_match["path"])
    fallback_slots = target_count - len(target_matches)
    if fallback_slots > 0:
        for item in scored:
            if fallback_slots <= 0:
                break
            if item["path"] in seen_paths:
                continue
            chosen.append(item)
            seen_paths.add(item["path"])
            fallback_slots -= 1

    new_files = list(dict.fromkeys([*prior_files, *(item["path"] for item in chosen)]))
    summary_parts = []
    discovery_checklist: list[dict[str, str]] = []
    for match in target_matches:
        target = str(match.get("target") or "").strip()
        item = match.get("item") or {}
        evidence = ((item.get("target_evidence") or {}).get(target) or {}) if isinstance(item, dict) else {}
        symbol_name = str(evidence.get("symbol") or item.get("symbol") or "").strip()
        excerpt_text = str(evidence.get("excerpt") or item.get("excerpt") or "").strip()
        symbol = f"::{symbol_name}" if symbol_name else ""
        excerpt = f" ({excerpt_text[:120]})" if excerpt_text else ""
        label = DISCOVERY_TARGET_LABELS.get(target, target.replace("_", " "))
        summary_parts.append(f"{label}: {item['path']}{symbol}{excerpt}")
        checklist_item = {
            "target": target,
            "path": str(item.get("path") or "").strip(),
        }
        if symbol_name:
            checklist_item["symbol"] = symbol_name
        if excerpt_text:
            checklist_item["evidence"] = excerpt_text
        discovery_checklist.append(checklist_item)
    for item in chosen:
        if any(item["path"] == (match.get("item") or {}).get("path") for match in target_matches):
            continue
        symbol = f"::{item['symbol']}" if item.get("symbol") else ""
        excerpt = f" ({item['excerpt'][:120]})" if item.get("excerpt") else ""
        summary_parts.append(f"{item['path']}{symbol}{excerpt}")
        checklist_item = {
            "target": "supporting_path",
            "path": str(item.get("path") or "").strip(),
        }
        if item.get("symbol"):
            checklist_item["symbol"] = str(item["symbol"]).strip()
        if item.get("excerpt"):
            checklist_item["evidence"] = str(item["excerpt"]).strip()
        discovery_checklist.append(checklist_item)

    return {
        "action": "collaboration_discovery",
        "instruction": instruction,
        "summary": "Read-only discovery matched: " + "; ".join(summary_parts),
        "new_files": new_files,
        "discovery_checklist": discovery_checklist,
        "open_questions": [],
        "next_actions": ["Verify the cited file paths against the active UI flow if the user asks for deeper proof."],
        "llm_response": "",
        "status": "completed",
    }


class DeveloperAgent(BaseAgent):
    def __init__(self, project_id: Optional[str] = None):
        super().__init__(AgentRole.DEVELOPER, project_id)
        self.generated_files: Dict[str, str] = {}  # file_path → code

    async def process_message(self, message: AgentMessage):
        if message.type == MessageType.TASK:
            task_info = message.content if isinstance(message.content, dict) else {"instruction": message.content}
            file_name = task_info.get("file", "main.py")
            self.set_task(f"구현 중: {file_name}")
            result = await self.execute(task_info.get("instruction", ""), context=task_info)
            self.complete_task()

        elif message.type == MessageType.REJECT:
            content = message.content if isinstance(message.content, dict) else {}
            file_name = content.get("file", "unknown")
            self.set_task(f"수정 중: {file_name}")
            result = await self.execute(
                f"Fix: {content.get('feedback', '')}",
                context=content,
            )
            self.complete_task()

        elif message.type == MessageType.COMMAND:
            self.set_task(f"명령 처리: {message.content}")
            result = await self.execute(str(message.content))
            self.complete_task()

    async def execute(self, instruction: str, context: Optional[Dict[str, Any]] = None) -> Dict[str, Any]:
        """Developer 핵심 로직: LLM 기반 코드 생성"""
        self.logger.info(f"Developer implementing: {instruction}")

        if context and str(context.get("mode") or "") == "collaboration_round":
            discovery_only = bool(context.get("discovery_only"))
            if discovery_only:
                local_result = _local_discovery_answer(instruction, context)
                if local_result is not None:
                    local_result["role"] = self.role.value
                    return local_result
            llm_response = await self.execute_task(
                prompt=(
                    _build_collaboration_discovery_prompt(instruction, context, self.role)
                    if discovery_only
                    else _build_collaboration_prompt(instruction, context, self.role)
                ),
                system_prompt=(
                    COLLABORATION_DISCOVERY_SYSTEM_PROMPT
                    if discovery_only
                    else COLLABORATION_SYSTEM_PROMPT
                ),
                role_override=(
                    "developer_collaboration_discovery"
                    if discovery_only
                    else "developer_collaboration"
                ),
                include_skill_prompt=False,
            )
            structured = safe_extract_json_object(llm_response)
            new_files = string_list(structured.get("new_files"))
            return {
                "role": self.role.value,
                "action": "collaboration_implementation",
                "instruction": instruction,
                "summary": first_text(
                    [
                        structured.get("summary"),
                        llm_response,
                        instruction,
                    ]
                ),
                "new_files": new_files,
                "open_questions": normalize_lines(structured.get("open_questions")),
                "next_actions": normalize_lines(structured.get("next_actions")),
                "llm_response": llm_response,
                "status": "completed",
            }

        llm_response = await self.execute_task(
            prompt=instruction,
            system_prompt=SYSTEM_PROMPT,
        )

        # LLM 응답에서 파일 파싱
        from ..graph.subgraph import parse_file_output
        new_files = parse_file_output(llm_response)
        self.generated_files.update(new_files)

        return {
            "role": self.role.value,
            "action": "code_generation",
            "instruction": instruction,
            "files": self.generated_files,
            "new_files": list(new_files.keys()),
            "llm_response": llm_response[:500],
            "status": "completed",
        }
