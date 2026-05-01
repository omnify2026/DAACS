"""Pytest configuration shared by API tests.

Keep this lightweight; S0 only sets safe defaults and compatibility markers.
"""

from __future__ import annotations

import os
import pytest


@pytest.fixture(autouse=True)
def _set_test_environment():
    os.environ.setdefault("PYTEST_CURRENT_TEST", "1")
    os.environ.setdefault("DAACS_ENV", "test")
    os.environ.setdefault("DAACS_JWT_SECRET", "test-jwt-secret")
    os.environ.setdefault("DAACS_FERNET_SECRET", "test-fernet-secret")
    os.environ.setdefault("POSTGRES_PASSWORD", "test-postgres-password")
    yield


def pytest_collection_modifyitems(config, items):
    # keep async fixtures discoverable regardless of plugin options
    for item in items:
        item.add_marker(pytest.mark.anyio)
