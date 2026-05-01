from __future__ import annotations

import uuid

from fastapi.testclient import TestClient

from daacs.core import deps
from daacs.core.security import decrypt_secret
from daacs.db.models import User
from daacs.server import app


class _Db:
    def add(self, _x):
        return None

    async def flush(self):
        return None


async def _fake_db():
    yield _Db()


def test_byok_values_are_encrypted_at_rest():
    user = User(
        id=uuid.uuid4(),
        email="byok@example.com",
        hashed_password="hashed",
        is_active=True,
    )

    async def _fake_user():
        return user

    app.dependency_overrides[deps.get_db] = _fake_db
    app.dependency_overrides[deps.get_current_user] = _fake_user
    try:
        with TestClient(app) as client:
            res = client.post(
                "/api/auth/byok",
                json={"byok_claude_key": "plain-secret"},
            )
        assert res.status_code == 200
        assert user.byok_claude_key is not None
        assert user.byok_claude_key != b"plain-secret"
        assert decrypt_secret(user.byok_claude_key) == "plain-secret"
    finally:
        app.dependency_overrides.clear()

