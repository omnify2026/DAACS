"""
DAACS OS ??LLM Executor
?듯빀 LLM ?ㅽ뻾 ?명꽣?섏씠?? role ??model 留ㅽ븨, 鍮꾩슜 異붿쟻, ?띾룄 ?쒗븳.

紐⑤뱺 ?먯씠?꾪듃??LLM ?몄텧? ??Executor瑜??듦낵?쒕떎.
SpendCapGuard, TurnLimitGuard? ?곕룞?섏뿬 ?덉쟾?μ튂瑜??곸슜?쒕떎.
"""
import logging
import os
import time
import inspect
import asyncio
import subprocess
import json
import copy
from pathlib import Path
from typing import Any, Dict, Optional

import yaml

from .providers import (
    CLIProvider,
    LLMProvider,
    create_provider,
    estimate_cost,
    estimate_tokens,
)

logger = logging.getLogger("daacs.llm.executor")

# ??? Config Loader ???

_config_cache: Optional[Dict[str, Any]] = None
_config_cache_source: Optional[str] = None
_config_cache_signature: Optional[tuple[str, int]] = None
_config_cache_identity: Optional[int] = None

_DEFAULT_DAACS_CONFIG: Dict[str, Any] = {
    "roles": {
        "pm_collaboration": {"cli": "codex", "tier": "high", "model": "gpt-5.3-codex-spark"},
        "developer_collaboration": {"cli": "codex", "tier": "high", "model": "gpt-5.3-codex"},
        "developer_collaboration_discovery": {"cli": "codex", "tier": "high", "model": "gpt-5.3-codex-spark"},
        "reviewer_collaboration": {"cli": "codex", "tier": "high", "model": "gpt-5.3-codex"},
        "verifier_collaboration": {"cli": "codex", "tier": "high", "model": "gpt-5.3-codex"},
        "reviewer": {"cli": "gemini", "tier": "flash"},
        "verifier": {"cli": "gemini", "tier": "flash"},
    },
    "router": {
        "tiers": {
            "flash": ["gemini-2.0-flash", "gpt-4o-mini"],
            "standard": ["gemini-2.0-pro", "gpt-4o"],
            "high": ["claude-sonnet-4-5", "gpt-5.3-codex"],
            "max": ["claude-opus-4-6", "o3"],
        }
    }
}


def _default_config_candidates() -> list[Path]:
    """Build config candidates without assuming a fixed process cwd."""
    here = Path(__file__).resolve()
    env_path = (os.getenv("DAACS_CONFIG", "") or os.getenv("DAACS_CONFIG_PATH", "")).strip()
    candidates: list[Path] = []
    if env_path:
        candidates.append(Path(env_path))
    candidates.append(Path.cwd() / "daacs_config.yaml")
    for parent in here.parents:
        candidates.append(parent / "daacs_config.yaml")
    candidates.append(Path("/app/daacs_config.yaml"))

    unique: list[Path] = []
    seen: set[str] = set()
    for item in candidates:
        key = str(item)
        if key in seen:
            continue
        seen.add(key)
        unique.append(item)
    return unique


def _deep_merge_dicts(base: Dict[str, Any], override: Dict[str, Any]) -> Dict[str, Any]:
    for key, value in override.items():
        if isinstance(value, dict) and isinstance(base.get(key), dict):
            _deep_merge_dicts(base[key], value)
        else:
            base[key] = value
    return base


def _apply_config_defaults(config: Optional[Dict[str, Any]]) -> Dict[str, Any]:
    merged = copy.deepcopy(_DEFAULT_DAACS_CONFIG)
    if isinstance(config, dict):
        _deep_merge_dicts(merged, config)
    return merged


def _load_config_file(path: Path) -> Optional[Dict[str, Any]]:
    """Load one config file and skip empty or non-dict files."""
    with open(path, "r", encoding="utf-8") as f:
        loaded = yaml.safe_load(f)

    if not isinstance(loaded, dict) or not loaded:
        return None
    return loaded


def load_config() -> Dict[str, Any]:
    """daacs_config.yaml 濡쒕뱶 (罹먯떛)."""
    global _config_cache
    global _config_cache_source
    global _config_cache_signature
    global _config_cache_identity

    if _config_cache is not None and _config_cache_identity != id(_config_cache):
        return _apply_config_defaults(_config_cache)

    if _config_cache is not None and _config_cache_source is None and _config_cache_signature is None:
        return _apply_config_defaults(_config_cache)

    current_candidates = _default_config_candidates()
    current_source: Optional[Path] = None
    current_signature: Optional[tuple[str, int]] = None
    for path in current_candidates:
        if path.is_file():
            try:
                stat = path.stat()
                current_source = path
                current_signature = (str(path.resolve()), int(stat.st_mtime_ns))
                break
            except OSError:
                continue

    if _config_cache is not None and _config_cache_signature == current_signature and _config_cache_source == (
        str(current_source.resolve()) if current_source is not None else None
    ):
        return _apply_config_defaults(_config_cache)

    for path in current_candidates:
        if path.is_file():
            try:
                loaded = _load_config_file(path)
            except OSError:
                continue

            if loaded is None:
                logger.warning("Config file is empty or invalid, skipping: %s", path)
                continue

            _config_cache = loaded
            _config_cache_identity = id(_config_cache)
            try:
                _config_cache_source = str(path.resolve())
                _config_cache_signature = (str(path.resolve()), int(path.stat().st_mtime_ns))
            except OSError:
                _config_cache_source = str(path)
                _config_cache_signature = None
            logger.info(f"Config loaded from: {path}")
            return _apply_config_defaults(_config_cache)

    logger.warning("daacs_config.yaml not found, using defaults")
    _config_cache = {}
    _config_cache_identity = id(_config_cache)
    _config_cache_source = None
    _config_cache_signature = None
    return _apply_config_defaults(_config_cache)


def get_role_config(role: str) -> Dict[str, Any]:
    """??븷蹂?LLM ?ㅼ젙 (cli, tier ?? 諛섑솚."""
    config = load_config()
    roles = config.get("roles", {})
    return roles.get(role, {"cli": "gemini", "tier": "standard"})


def get_execution_config() -> Dict[str, Any]:
    """execution ?뱀뀡 諛섑솚."""
    config = load_config()
    return config.get("execution", {})


# ??? Rate Limiter (per-project) ???

_call_windows: Dict[str, Dict[str, float]] = {}
_MAX_CALLS_PER_PROJECT = 200
_RATE_LIMIT_WINDOW_SECONDS = int(os.getenv("DAACS_RATE_LIMIT_WINDOW_SECONDS", "86400"))

class RateLimitExceeded(Exception):
    """?꾨줈?앺듃蹂??몄텧 ?잛닔 珥덇낵."""
    def __init__(self, project_id: str, count: int, limit: int):
        self.project_id = project_id
        self.count = count
        self.limit = limit
        super().__init__(f"Rate limit exceeded for {project_id}: {count}/{limit} calls")


def _check_rate_limit(project_id: str):
    """?꾨줈?앺듃蹂??몄텧 ?잛닔 泥댄겕."""
    now = time.time()
    window = _call_windows.get(project_id)
    if window is None or now - window["window_start"] >= _RATE_LIMIT_WINDOW_SECONDS:
        window = {"count": 0, "window_start": now}
        _call_windows[project_id] = window
    count = int(window["count"])
    if count >= _MAX_CALLS_PER_PROJECT:
        raise RateLimitExceeded(project_id, count, _MAX_CALLS_PER_PROJECT)
    window["count"] = count + 1

def reset_rate_limit(project_id: str):
    """?꾨줈?앺듃 ?몄텧 ?잛닔 由ъ뀑 (???뚰겕?뚮줈???쒖옉 ??."""
    _call_windows.pop(project_id, None)


# ??? LLM Executor ???

class LLMExecutor:
    """
    ?듯빀 LLM ?ㅽ뻾湲?

    ?ъ슜踰?
        executor = LLMExecutor(project_id="proj-123")
        response = await executor.execute(
            role="developer",
            prompt="Implement a FastAPI health endpoint",
            system_prompt="You are an expert Python developer.",
        )
    """

    def __init__(
        self,
        project_id: str,
        spend_guard=None,  # SpendCapGuard instance
        turn_guard=None,   # TurnLimitGuard instance
        workspace_dir: Optional[str] = None,
        llm_overrides: Optional[Dict[str, Any]] = None,
    ):
        self.project_id = project_id
        self.spend_guard = spend_guard
        self.turn_guard = turn_guard
        # Ensure a valid existing workspace directory for CLI tools (avoids WinError 267).
        raw_workspace = workspace_dir or os.path.join("workspace", project_id)
        workspace_path = Path(raw_workspace)
        try:
            workspace_path.mkdir(parents=True, exist_ok=True)
        except Exception:
            # Fallback to current working directory if the configured path is invalid.
            workspace_path = Path.cwd()
        self.workspace_dir = str(workspace_path)
        self.llm_overrides = llm_overrides or {}
        self._providers: Dict[str, LLMProvider] = {}
        self._total_calls = 0
        self._total_tokens = 0

    @staticmethod
    def _provider_default_model(cli_type: str) -> str:
        defaults = {
            "codex": "gpt-5.3-codex",
            "claude": "claude-sonnet-4-6",
            "gemini": "gemini-2.0-pro",
        }
        return defaults.get(cli_type, "")

    def update_overrides(self, llm_overrides: Optional[Dict[str, Any]]) -> None:
        """Apply runtime LLM setting changes to future calls."""
        self.llm_overrides = dict(llm_overrides or {})
        self._providers.clear()

    @staticmethod
    def _is_model_compatible(cli_type: str, model_name: str) -> bool:
        model = (model_name or "").lower()
        if not model:
            return False
        if cli_type == "codex":
            return model.startswith("gpt-") or model.startswith("o") or "codex" in model
        if cli_type == "claude":
            return model.startswith("claude-")
        if cli_type == "gemini":
            return model.startswith("gemini-")
        return True

    def _select_model_for_cli(self, cli_type: str, tier: str, explicit_model: str = "") -> str:
        if explicit_model:
            return explicit_model

        config = load_config()
        router = config.get("router", {})
        tiers = router.get("tiers", {})
        model_list = tiers.get(tier, [])
        for candidate in model_list:
            if self._is_model_compatible(cli_type, candidate):
                return candidate

        return self._provider_default_model(cli_type)

    def _get_provider(self, role: str) -> LLMProvider:
        """??븷蹂??꾨줈諛붿씠?붾? 罹먯떛?섏뿬 諛섑솚."""
        if role in self._providers:
            return self._providers[role]

        role_config = dict(get_role_config(role))
        role_overrides = self.llm_overrides.get("role_overrides", {}).get(role, {})
        if isinstance(role_overrides, dict):
            role_config.update(role_overrides)

        cli_type = role_config.get("cli", "gemini")
        tier = role_config.get("tier", "standard")
        codex_only = self.llm_overrides.get("codex_only")
        if codex_only is None:
            codex_only = os.getenv("DAACS_CODEX_ONLY", "false").lower() in {"1", "true", "yes", "on"}
        forced_cli = (self.llm_overrides.get("cli_only_provider") or os.getenv("DAACS_CLI_ONLY_PROVIDER", "")).strip().lower()
        if forced_cli:
            cli_type = forced_cli
        explicit_model = str(role_config.get("model") or "").strip()
        if (not explicit_model) and (codex_only or cli_type == "codex"):
            explicit_model = str(
                self.llm_overrides.get("codex_model")
                or os.getenv("DAACS_CODEX_MODEL", "")
            ).strip()

        if codex_only:
            cli_type = "codex"
            if tier not in {"high", "max"}:
                tier = "high"
            if not explicit_model:
                explicit_model = (
                    str(self.llm_overrides.get("codex_model", "")).strip()
                    or os.getenv("DAACS_CODEX_MODEL", "").strip()
                )

        model_name = self._select_model_for_cli(
            cli_type=cli_type,
            tier=tier,
            explicit_model=explicit_model,
        )

        use_plugin = False
        if cli_type == "gemini":
            raw_mode = os.getenv("DAACS_GEMINI_MODE", "").strip().lower()
            if raw_mode in {"plugin", "api"}:
                use_plugin = True

        provider = create_provider(
            cli_type=cli_type,
            model_name=model_name,
            cwd=self.workspace_dir,
            use_plugin=use_plugin,
        )
        self._providers[role] = provider
        logger.info(f"[Executor] Provider created: role={role}, cli={cli_type}, model={model_name}, tier={tier}")
        return provider

    @staticmethod
    def _is_gemini_quota_error(exc: Exception) -> bool:
        message = str(exc or "").lower()
        if message == "":
            return False
        return (
            "terminalquotaerror" in message
            or "exhausted your capacity on this model" in message
            or "quota will reset" in message
        )

    def _switch_role_to_codex_fallback(self, role: str, provider: LLMProvider) -> LLMProvider | None:
        if getattr(provider, "cli_type", "") != "gemini":
            return None

        fallback_model = (
            str(self.llm_overrides.get("codex_model", "")).strip()
            or os.getenv("DAACS_CODEX_MODEL", "").strip()
            or "gpt-5.4-mini"
        )
        fallback = create_provider(
            cli_type="codex",
            model_name=fallback_model,
            cwd=self.workspace_dir,
            use_plugin=False,
        )
        self._providers[role] = fallback
        logger.warning(
            "[Executor] quota fallback role=%s from gemini to codex model=%s",
            role,
            fallback_model,
        )
        return fallback

    async def _invoke_with_retry(
        self,
        provider: LLMProvider,
        role: str,
        prompt: str,
        system_prompt: str = "",
        max_retries: int = 3,
    ) -> str:
        """
        Retry transient provider failures with exponential backoff.
        Backoff: 1s, 2s, 4s... capped at 30s.
        Timeout-like failures escalate provider timeout by 1.5x.
        """
        last_exc: Exception | None = None
        active_provider = provider
        for attempt in range(max_retries + 1):
            try:
                return await active_provider.invoke(prompt, system_prompt)
            except Exception as exc:
                last_exc = exc
                if self._is_gemini_quota_error(exc):
                    fallback_provider = self._switch_role_to_codex_fallback(role, active_provider)
                    if fallback_provider is not None and fallback_provider is not active_provider:
                        active_provider = fallback_provider
                        continue
                if attempt >= max_retries:
                    break
                if isinstance(exc, (TimeoutError, asyncio.TimeoutError, subprocess.TimeoutExpired)):
                    timeout_sec = getattr(active_provider, "timeout_sec", None)
                    if isinstance(timeout_sec, (int, float)) and timeout_sec > 0:
                        setattr(active_provider, "timeout_sec", int(max(1, timeout_sec * 1.5)))
                delay = min(30, 2 ** attempt)
                logger.warning(
                    "[Executor] retry role=%s attempt=%s/%s delay=%ss err=%s",
                    role,
                    attempt + 1,
                    max_retries + 1,
                    delay,
                    str(exc)[:180],
                )
                await asyncio.sleep(delay)
        assert last_exc is not None
        raise last_exc

    async def execute(
        self,
        role: str,
        prompt: str,
        system_prompt: str = "",
        context: Optional[Dict[str, Any]] = None,
    ) -> str:
        """
        ??븷 湲곕컲 LLM ?몄텧.

        1. Rate limit 泥댄겕
        2. SpendCapGuard ?덉궛 ?뺤씤
        3. Provider瑜??듯빐 LLM ?몄텧
        4. 鍮꾩슜 湲곕줉 + ?좏겙 異붿쟻
        5. TurnLimitGuard API ?몄텧 湲곕줉

        Args:
            role: ?먯씠?꾪듃 ??븷 ("developer", "reviewer", etc.)
            prompt: LLM???꾩넚???꾨＼?꾪듃
            system_prompt: ?쒖뒪???꾨＼?꾪듃 (?ㅽ궗 ?ы븿)
            context: 異붽? 而⑦뀓?ㅽ듃 (?꾩옱 誘몄궗?? ?뺤옣??

        Returns:
            LLM ?묐떟 ?띿뒪??
        """
        # 1. Rate limit
        _check_rate_limit(self.project_id)
        if self.turn_guard:
            self.turn_guard.check_turn(role, self.project_id)

        # 2. Budget check
        input_tokens = estimate_tokens(prompt + system_prompt)
        estimated_output = input_tokens * 2  # Conservative estimate
        provider = self._get_provider(role)
        model_name = provider.get_model_name()
        estimated_cost = estimate_cost(model_name, input_tokens, estimated_output)

        if self.spend_guard:
            budget_check = self.spend_guard.check_or_raise(estimated_cost)
            if inspect.isawaitable(budget_check):
                await budget_check

        # 3. LLM call
        start_time = time.time()
        try:
            response = await self._invoke_with_retry(
                provider=provider,
                role=role,
                prompt=prompt,
                system_prompt=system_prompt,
                max_retries=3,
            )
        except Exception as e:
            # Record error in turn guard
            if self.turn_guard:
                self.turn_guard.record_error(role, self.project_id, str(e)[:200])
            raise

        elapsed = time.time() - start_time
        provider = self._providers.get(role, provider)
        model_name = provider.get_model_name()

        # 4. Cost recording
        output_tokens = estimate_tokens(response)
        actual_cost = estimate_cost(model_name, input_tokens, output_tokens)

        if self.spend_guard:
            record_result = self.spend_guard.record(
                agent_role=role,
                model=model_name,
                input_tokens=input_tokens,
                output_tokens=output_tokens,
                cost_usd=actual_cost,
            )
            if inspect.isawaitable(record_result):
                await record_result

        # 5. Turn guard tracking
        if self.turn_guard:
            self.turn_guard.record_api_call(role, self.project_id)

        self._total_calls += 1
        self._total_tokens += input_tokens + output_tokens

        logger.info(
            f"[Executor] {role} via {model_name}: "
            f"in={input_tokens} out={output_tokens} "
            f"cost=${actual_cost:.4f} time={elapsed:.1f}s"
        )

        return response

    def get_stats(self) -> Dict[str, Any]:
        """?ㅽ뻾 ?듦퀎 諛섑솚."""
        return {
            "project_id": self.project_id,
            "total_calls": self._total_calls,
            "total_tokens": self._total_tokens,
            "providers": {role: p.get_model_name() for role, p in self._providers.items()},
        }
