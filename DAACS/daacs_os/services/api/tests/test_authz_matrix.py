from __future__ import annotations

import uuid

from fastapi.testclient import TestClient

from daacs.core import deps
from daacs.server import app


class _Db:
    async def execute(self, _statement):
        class _R:
            def scalar_one_or_none(self):
                return None

        return _R()


async def _fake_db():
    yield _Db()


def test_sensitive_paths_require_authentication():
    pid = str(uuid.uuid4())
    app.dependency_overrides[deps.get_db] = _fake_db
    with TestClient(app) as client:
        try:
            checks = [
                ("get", f"/api/workflows/{pid}"),
                ("post", f"/api/workflows/{pid}/start"),
                ("get", f"/api/agents/{pid}"),
                ("post", f"/api/teams/{pid}/task"),
                ("post", f"/api/collaboration/{pid}/sessions"),
                ("post", f"/api/collaboration/{pid}/sessions/{uuid.uuid4()}/stop"),
            ]
            for method, path in checks:
                if method == "get":
                    res = client.get(path)
                else:
                    res = client.post(path, json={})
                assert res.status_code in {401, 403, 422}
        finally:
            app.dependency_overrides.clear()
