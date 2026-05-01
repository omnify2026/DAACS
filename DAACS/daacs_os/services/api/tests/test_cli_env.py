from daacs.llm.cli_env import build_cli_subprocess_env
from daacs.llm.cli_env import resolve_venv_executable


def test_build_cli_subprocess_env_removes_sentinel_proxies():
    env = build_cli_subprocess_env(
        {
            "HTTP_PROXY": "http://127.0.0.1:9",
            "HTTPS_PROXY": "http://127.0.0.1:9",
            "ALL_PROXY": "127.0.0.1:9",
            "NO_PROXY": "localhost,127.0.0.1",
            "KEEP_ME": "ok",
        }
    )
    assert env["HTTP_PROXY"] == ""
    assert env["HTTPS_PROXY"] == ""
    assert env["ALL_PROXY"] == ""
    assert env["NO_PROXY"] == "localhost,127.0.0.1"
    assert env["KEEP_ME"] == "ok"


def test_build_cli_subprocess_env_keeps_custom_proxy():
    env = build_cli_subprocess_env(
        {
            "HTTP_PROXY": "http://corp-proxy.internal:8080",
            "KEEP_ME": "ok",
        }
    )
    assert env["HTTP_PROXY"] == "http://corp-proxy.internal:8080"
    assert env["KEEP_ME"] == "ok"


def test_resolve_venv_executable_prefers_posix_bin(tmp_path):
    venv_dir = tmp_path / ".venv312"
    target = venv_dir / "bin" / "python"
    target.parent.mkdir(parents=True)
    target.write_text("", encoding="utf-8")

    assert resolve_venv_executable(venv_dir, "python") == target


def test_resolve_venv_executable_supports_windows_scripts(tmp_path):
    venv_dir = tmp_path / ".venv312"
    target = venv_dir / "Scripts" / "pytest.exe"
    target.parent.mkdir(parents=True)
    target.write_text("", encoding="utf-8")

    assert resolve_venv_executable(venv_dir, "pytest") == target
