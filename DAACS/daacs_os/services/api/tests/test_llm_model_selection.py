import asyncio

from daacs.llm import executor as executor_module
from daacs.agents.manager import AgentManager
from daacs.llm.executor import LLMExecutor


def _base_config():
    return {
        "roles": {
            "pm": {"cli": "gemini", "tier": "standard"},
            "designer": {"cli": "claude", "tier": "standard"},
        },
        "router": {
            "tiers": {
                "flash": ["gemini-2.0-flash", "gpt-4o-mini"],
                "standard": ["gemini-2.0-pro", "gpt-4o"],
                "high": ["claude-sonnet-4-5", "gpt-5.3-codex"],
                "max": ["claude-opus-4-6", "o3"],
            }
        },
    }


def test_codex_only_prefers_codex_compatible_model(monkeypatch):
    monkeypatch.setattr(executor_module, "_config_cache", _base_config())
    monkeypatch.setenv("DAACS_CODEX_ONLY", "true")

    executor = LLMExecutor(project_id="proj-a")
    provider = executor._get_provider("pm")
    assert provider.get_model_name() == "gpt-5.3-codex"


def test_codex_only_uses_explicit_codex_model_override(monkeypatch):
    monkeypatch.setattr(executor_module, "_config_cache", _base_config())
    monkeypatch.setenv("DAACS_CODEX_ONLY", "true")

    executor = LLMExecutor(
        project_id="proj-b",
        llm_overrides={"codex_only": True, "codex_model": "gpt-4o-mini"},
    )
    provider = executor._get_provider("pm")
    assert provider.get_model_name() == "gpt-4o-mini"


def test_non_codex_role_falls_back_to_provider_default_when_tier_incompatible(monkeypatch):
    monkeypatch.setattr(executor_module, "_config_cache", _base_config())
    monkeypatch.setenv("DAACS_CODEX_ONLY", "false")

    executor = LLMExecutor(project_id="proj-c", llm_overrides={"codex_only": False})
    provider = executor._get_provider("designer")
    assert provider.get_model_name() == "claude-sonnet-4-6"


def test_empty_config_uses_default_router_tiers(monkeypatch):
    monkeypatch.setattr(executor_module, "_config_cache", {})
    monkeypatch.setenv("DAACS_CODEX_ONLY", "false")

    executor = LLMExecutor(project_id="proj-d", llm_overrides={"codex_only": False})
    provider = executor._get_provider("pm")
    assert provider.get_model_name() == "gemini-2.0-pro"


def test_empty_config_prefers_flash_for_review_roles(monkeypatch):
    monkeypatch.setattr(executor_module, "_config_cache", {})
    monkeypatch.setenv("DAACS_CODEX_ONLY", "false")

    executor = LLMExecutor(project_id="proj-d-review", llm_overrides={"codex_only": False})
    pm_provider = executor._get_provider("pm_collaboration")
    developer_provider = executor._get_provider("developer_collaboration")
    developer_discovery_provider = executor._get_provider("developer_collaboration_discovery")
    reviewer_collab_provider = executor._get_provider("reviewer_collaboration")
    verifier_collab_provider = executor._get_provider("verifier_collaboration")
    reviewer_provider = executor._get_provider("reviewer")
    verifier_provider = executor._get_provider("verifier")

    assert pm_provider.get_model_name() == "gpt-5.3-codex-spark"
    assert developer_provider.get_model_name() == "gpt-5.3-codex"
    assert developer_discovery_provider.get_model_name() == "gpt-5.3-codex-spark"
    assert reviewer_collab_provider.get_model_name() == "gpt-5.3-codex"
    assert verifier_collab_provider.get_model_name() == "gpt-5.3-codex"
    assert reviewer_provider.get_model_name() == "gemini-2.0-flash"
    assert verifier_provider.get_model_name() == "gemini-2.0-flash"


def test_codex_only_uses_upgraded_default_model_without_router_config(monkeypatch):
    monkeypatch.setattr(executor_module, "_config_cache", {})
    monkeypatch.setenv("DAACS_CODEX_ONLY", "true")

    executor = LLMExecutor(project_id="proj-e")
    provider = executor._get_provider("pm")
    assert provider.get_model_name() == "gpt-5.3-codex"


def test_update_overrides_clears_cached_provider_selection(monkeypatch):
    monkeypatch.setattr(executor_module, "_config_cache", {})
    monkeypatch.setenv("DAACS_CODEX_ONLY", "false")

    executor = LLMExecutor(project_id="proj-f")
    first_provider = executor._get_provider("pm")
    assert first_provider.get_model_name() == "gemini-2.0-pro"

    executor.update_overrides({"codex_only": True})
    second_provider = executor._get_provider("pm")
    assert second_provider.get_model_name() == "gpt-5.3-codex"
    assert second_provider is not first_provider


def test_manager_set_llm_overrides_refreshes_runtime_executor():
    class _DummyExecutor:
        def __init__(self):
            self.calls = []

        def update_overrides(self, overrides):
            self.calls.append(dict(overrides))

    class _DummyServer:
        def __init__(self):
            self.llm_overrides = {}

    manager = AgentManager(project_id="proj-g")
    manager._llm_executor = _DummyExecutor()
    manager._agent_server = _DummyServer()

    overrides = {"codex_only": True, "codex_model": "gpt-5.3-codex"}
    manager.set_llm_overrides(overrides)

    assert manager._llm_executor.calls == [overrides]
    assert manager._agent_server.llm_overrides == overrides


def test_load_config_ignores_empty_daacs_config_env(monkeypatch):
    monkeypatch.setattr(executor_module, "_config_cache", None)
    monkeypatch.setenv("DAACS_CONFIG", "")
    cfg = executor_module.load_config()
    assert isinstance(cfg, dict)
    assert cfg["router"]["tiers"]["standard"][0] == "gemini-2.0-pro"


def test_load_config_skips_empty_files_and_continues_search(monkeypatch, tmp_path):
    empty_config = tmp_path / "daacs_config.yaml"
    empty_config.write_text("", encoding="utf-8")

    real_config = tmp_path / "repo_root" / "daacs_config.yaml"
    real_config.parent.mkdir()
    real_config.write_text(
        """
roles:
  pm:
    cli: gemini
    tier: standard
router:
  tiers:
    standard:
      - gemini-2.0-pro
""",
        encoding="utf-8",
    )

    monkeypatch.setattr(executor_module, "_config_cache", None)
    monkeypatch.setattr(executor_module, "_default_config_candidates", lambda: [empty_config, real_config])

    cfg = executor_module.load_config()

    assert cfg["roles"]["pm"]["cli"] == "gemini"
    assert cfg["router"]["tiers"]["standard"][0] == "gemini-2.0-pro"


def test_load_config_reloads_when_file_changes(monkeypatch, tmp_path):
    config_path = tmp_path / "daacs_config.yaml"
    config_path.write_text(
        """
roles:
  pm:
    cli: gemini
    tier: standard
router:
  tiers:
    standard:
      - gemini-2.0-pro
""",
        encoding="utf-8",
    )

    monkeypatch.setattr(executor_module, "_config_cache", None)
    monkeypatch.setattr(executor_module, "_default_config_candidates", lambda: [config_path])

    first = executor_module.load_config()
    assert first["router"]["tiers"]["standard"][0] == "gemini-2.0-pro"

    config_path.write_text(
        """
roles:
  pm:
    cli: gemini
    tier: standard
router:
  tiers:
    standard:
      - gemini-2.0-flash
""",
        encoding="utf-8",
    )
    config_path.touch()

    second = executor_module.load_config()
    assert second["router"]["tiers"]["standard"][0] == "gemini-2.0-flash"


def test_gemini_quota_error_falls_back_to_codex(monkeypatch):
    class _DummyProvider:
        def __init__(self, cli_type: str, model_name: str):
            self.cli_type = cli_type
            self._model_name = model_name

        async def invoke(self, _prompt: str, _system_prompt: str = "") -> str:
            if self.cli_type == "gemini":
                raise RuntimeError(
                    "CLI gemini failed (exit 1): TerminalQuotaError: You have exhausted your capacity on this model."
                )
            return "ok"

        def get_model_name(self) -> str:
            return self._model_name

    def _fake_create_provider(cli_type: str, model_name: str = "", cwd: str | None = None, use_plugin: bool = False):
        return _DummyProvider(cli_type=cli_type, model_name=model_name or cli_type)

    monkeypatch.setattr(executor_module, "_config_cache", {})
    monkeypatch.setenv("DAACS_CODEX_ONLY", "false")
    monkeypatch.setattr(executor_module, "create_provider", _fake_create_provider)

    executor = LLMExecutor(project_id="proj-quota-fallback", llm_overrides={"codex_only": False})
    result = asyncio.run(executor.execute(role="reviewer", prompt="ping"))

    assert result == "ok"
    assert executor._providers["reviewer"].cli_type == "codex"
    assert executor._providers["reviewer"].get_model_name() == "gpt-5.4-mini"


def test_gemini_quota_error_uses_env_codex_override(monkeypatch):
    class _DummyProvider:
        def __init__(self, cli_type: str, model_name: str):
            self.cli_type = cli_type
            self._model_name = model_name

        async def invoke(self, _prompt: str, _system_prompt: str = "") -> str:
            if self.cli_type == "gemini":
                raise RuntimeError("TerminalQuotaError: quota will reset soon")
            return "ok"

        def get_model_name(self) -> str:
            return self._model_name

    def _fake_create_provider(cli_type: str, model_name: str = "", cwd: str | None = None, use_plugin: bool = False):
        return _DummyProvider(cli_type=cli_type, model_name=model_name or cli_type)

    monkeypatch.setattr(executor_module, "_config_cache", {})
    monkeypatch.setenv("DAACS_CODEX_ONLY", "false")
    monkeypatch.setenv("DAACS_CODEX_MODEL", "gpt-5.3-codex")
    monkeypatch.setattr(executor_module, "create_provider", _fake_create_provider)

    executor = LLMExecutor(project_id="proj-quota-env", llm_overrides={"codex_only": False})
    result = asyncio.run(executor.execute(role="reviewer", prompt="ping"))

    assert result == "ok"
    assert executor._providers["reviewer"].get_model_name() == "gpt-5.3-codex"
