import os

import pytest
from fastapi.testclient import TestClient

from app.services.session_memory import session_memory

os.environ.setdefault("OPENAI_API_KEY", "test-key")

from main import app  # noqa: E402


@pytest.fixture(autouse=True)
def clear_sessions():
    session_memory.clear()
    yield
    session_memory.clear()


@pytest.fixture()
def client():
    return TestClient(app)