from __future__ import annotations

import uuid
from types import SimpleNamespace

from fastapi.testclient import TestClient

from daacs.core import deps
from daacs.core.security import decode_access_token, hash_password
from daacs.db.models import Project, ProjectMembership, User
from daacs.server import app


class _NoopDb:
    def add(self, _obj):
        return None

    async def flush(self):
        return None

    async def execute(self, _statement):
        return _RowsResult([])


async def _fake_db():
    yield _NoopDb()


class _ScalarResult:
    def __init__(self, value):
        self._value = value

    def scalar_one_or_none(self):
        return self._value


class _RowsResult:
    def __init__(self, rows):
        self._rows = rows

    def all(self):
        return self._rows


class _RegisterDb:
    def __init__(self):
        self.added = []

    def add(self, obj):
        self.added.append(obj)

    async def flush(self):
        for obj in self.added:
            if getattr(obj, "id", None) is None:
                obj.id = uuid.uuid4()
            if isinstance(obj, User):
                if getattr(obj, "plan", None) is None:
                    obj.plan = "free"
                if getattr(obj, "agent_slots", None) is None:
                    obj.agent_slots = 3
                if getattr(obj, "custom_agent_count", None) is None:
                    obj.custom_agent_count = 0
            if isinstance(obj, ProjectMembership) and getattr(obj, "project_id", None) is None:
                raise AssertionError("membership.project_id must be set before flush")

    async def execute(self, _statement):
        return _ScalarResult(None)


class _LoginDb:
    def __init__(self, user, memberships):
        self._user = user
        self._memberships = memberships
        self._execute_calls = 0

    async def execute(self, _statement):
        self._execute_calls += 1
        if self._execute_calls == 1:
            return _ScalarResult(self._user)
        return _RowsResult(self._memberships)


def test_auth_me_requires_token():
    app.dependency_overrides[deps.get_db] = _fake_db
    try:
        with TestClient(app) as client:
            res = client.get("/api/auth/me")
        assert res.status_code == 401
        assert res.json() == {"detail": "Missing or invalid authorization"}
    finally:
        app.dependency_overrides.clear()


def test_auth_byok_requires_payload():
    async def _fake_user():
        return SimpleNamespace(
            id=uuid.uuid4(),
            email="tester@example.com",
            byok_claude_key=None,
            byok_openai_key=None,
        )

    app.dependency_overrides[deps.get_db] = _fake_db
    app.dependency_overrides[deps.get_current_user] = _fake_user
    try:
        with TestClient(app) as client:
            res = client.post("/api/auth/byok", json={})
        assert res.status_code == 400
    finally:
        app.dependency_overrides.clear()


def test_auth_byok_status_requires_token():
    app.dependency_overrides[deps.get_db] = _fake_db
    try:
        with TestClient(app) as client:
            res = client.get("/api/auth/byok")
        assert res.status_code == 401
        assert res.json() == {"detail": "Missing or invalid authorization"}
    finally:
        app.dependency_overrides.clear()


def test_auth_byok_status_returns_current_flags():
    async def _fake_user():
        return SimpleNamespace(
            id=uuid.uuid4(),
            email="tester@example.com",
            billing_track="project",
            byok_claude_key=b"encrypted-claude",
            byok_openai_key=None,
        )

    app.dependency_overrides[deps.get_db] = _fake_db
    app.dependency_overrides[deps.get_current_user] = _fake_user
    try:
        with TestClient(app) as client:
            res = client.get("/api/auth/byok")
        assert res.status_code == 200
        assert res.json() == {
            "billing_track": "project",
            "byok_has_claude_key": True,
            "byok_has_openai_key": False,
        }
    finally:
        app.dependency_overrides.clear()


def test_auth_byok_status_normalizes_legacy_billing_track_values():
    async def _fake_user():
        return SimpleNamespace(
            id=uuid.uuid4(),
            email="tester@example.com",
            billing_track="enterprise",
            byok_claude_key=None,
            byok_openai_key=None,
        )

    app.dependency_overrides[deps.get_db] = _fake_db
    app.dependency_overrides[deps.get_current_user] = _fake_user
    try:
        with TestClient(app) as client:
            res = client.get("/api/auth/byok")
        assert res.status_code == 200
        assert res.json() == {
            "billing_track": "project",
            "byok_has_claude_key": False,
            "byok_has_openai_key": False,
        }
    finally:
        app.dependency_overrides.clear()


def test_auth_byok_rejects_whitespace_only_payload():
    async def _fake_user():
        return SimpleNamespace(
            id=uuid.uuid4(),
            email="tester@example.com",
            byok_claude_key=None,
            byok_openai_key=None,
        )

    app.dependency_overrides[deps.get_db] = _fake_db
    app.dependency_overrides[deps.get_current_user] = _fake_user
    try:
        with TestClient(app) as client:
            res = client.post(
                "/api/auth/byok",
                json={"byok_claude_key": "   ", "byok_openai_key": ""},
            )
        assert res.status_code == 400
    finally:
        app.dependency_overrides.clear()


def test_auth_byok_saves_keys():
    fake_user = SimpleNamespace(
        id=uuid.uuid4(),
        email="tester@example.com",
        plan="free",
        agent_slots=3,
        custom_agent_count=0,
        billing_track="byok",
        byok_claude_key=None,
        byok_openai_key=None,
    )

    async def _fake_user():
        return fake_user

    app.dependency_overrides[deps.get_db] = _fake_db
    app.dependency_overrides[deps.get_current_user] = _fake_user
    try:
        with TestClient(app) as client:
            res = client.post(
                "/api/auth/byok",
                json={
                    "byok_claude_key": "claude-test-key",
                    "byok_openai_key": "openai-test-key",
                },
            )
            status_res = client.get("/api/auth/byok")
        assert res.status_code == 200
        payload = res.json()
        assert payload == {
            "status": "saved",
            "billing_track": "byok",
            "byok_has_claude_key": True,
            "byok_has_openai_key": True,
            "updated": {
                "byok_claude_key": True,
                "byok_openai_key": True,
            },
        }
        assert status_res.status_code == 200
        assert status_res.json() == {
            "billing_track": "byok",
            "byok_has_claude_key": True,
            "byok_has_openai_key": True,
        }
    finally:
        app.dependency_overrides.clear()


def test_auth_me_returns_byok_flags_with_same_semantics_as_byok_status():
    fake_user = SimpleNamespace(
        id=uuid.uuid4(),
        email="tester@example.com",
        plan="free",
        agent_slots=3,
        custom_agent_count=0,
        billing_track="byok",
        byok_claude_key=b"encrypted-claude",
        byok_openai_key=None,
    )

    async def _fake_user():
        return fake_user

    app.dependency_overrides[deps.get_db] = _fake_db
    app.dependency_overrides[deps.get_current_user] = _fake_user
    try:
        with TestClient(app) as client:
            res = client.get("/api/auth/me")
            status_res = client.get("/api/auth/byok")
        assert res.status_code == 200
        payload = res.json()
        assert payload["user"]["billing_track"] == "byok"
        assert payload["user"]["byok_has_claude_key"] is True
        assert payload["user"]["byok_has_openai_key"] is False
        assert status_res.status_code == 200
        assert payload["user"]["billing_track"] == status_res.json()["billing_track"]
        assert payload["user"]["byok_has_claude_key"] == status_res.json()["byok_has_claude_key"]
        assert payload["user"]["byok_has_openai_key"] == status_res.json()["byok_has_openai_key"]
    finally:
        app.dependency_overrides.clear()


def test_auth_me_normalizes_legacy_billing_track_values():
    fake_user = SimpleNamespace(
        id=uuid.uuid4(),
        email="tester@example.com",
        plan="free",
        agent_slots=3,
        custom_agent_count=0,
        billing_track="enterprise",
        byok_claude_key=None,
        byok_openai_key=None,
    )

    async def _fake_user():
        return fake_user

    app.dependency_overrides[deps.get_db] = _fake_db
    app.dependency_overrides[deps.get_current_user] = _fake_user
    try:
        with TestClient(app) as client:
            res = client.get("/api/auth/me")
        assert res.status_code == 200
        payload = res.json()
        assert payload["user"]["billing_track"] == "project"
        assert payload["access_token"]
        token_payload = decode_access_token(payload["access_token"])
        assert token_payload is not None
        assert token_payload["billing_track"] == "project"
    finally:
        app.dependency_overrides.clear()


def test_auth_me_normalizes_padded_mixed_case_byok_billing_track():
    fake_user = SimpleNamespace(
        id=uuid.uuid4(),
        email="tester@example.com",
        plan="free",
        agent_slots=3,
        custom_agent_count=0,
        billing_track="  ByOk  ",
        byok_claude_key=None,
        byok_openai_key=b"encrypted-openai",
    )

    async def _fake_user():
        return fake_user

    app.dependency_overrides[deps.get_db] = _fake_db
    app.dependency_overrides[deps.get_current_user] = _fake_user
    try:
        with TestClient(app) as client:
            res = client.get("/api/auth/me")
        assert res.status_code == 200
        payload = res.json()
        assert payload["user"]["billing_track"] == "byok"
        assert payload["user"]["byok_has_claude_key"] is False
        assert payload["user"]["byok_has_openai_key"] is True
        assert payload["access_token"]
        token_payload = decode_access_token(payload["access_token"])
        assert token_payload is not None
        assert token_payload["billing_track"] == "byok"
    finally:
        app.dependency_overrides.clear()


def test_register_invalid_billing_track_falls_back_to_project():
    register_db = _RegisterDb()

    async def _fake_register_db():
        yield register_db

    app.dependency_overrides[deps.get_db] = _fake_register_db
    try:
        with TestClient(app) as client:
            res = client.post(
                "/api/auth/register",
                json={
                    "email": "signup@example.com",
                    "password": "password-123",
                    "project_name": "Signup Project",
                    "billing_track": "enterprise",
                },
            )
        assert res.status_code == 200
        payload = res.json()
        assert payload["access_token"]
        assert payload["user"]["billing_track"] == "project"
        created_user = next(obj for obj in register_db.added if isinstance(obj, User))
        created_project = next(obj for obj in register_db.added if isinstance(obj, Project))
        created_membership = next(obj for obj in register_db.added if isinstance(obj, ProjectMembership))
        assert created_user.billing_track == "project"
        assert payload["memberships"] == [
            {
                "project_id": str(created_project.id),
                "project_name": "Signup Project",
                "role": created_membership.role,
                "is_owner": created_membership.is_owner,
            }
        ]
    finally:
        app.dependency_overrides.clear()


def test_register_null_billing_track_defaults_to_project():
    register_db = _RegisterDb()

    async def _fake_register_db():
        yield register_db

    app.dependency_overrides[deps.get_db] = _fake_register_db
    try:
        with TestClient(app) as client:
            res = client.post(
                "/api/auth/register",
                json={
                    "email": "signup-null@example.com",
                    "password": "password-123",
                    "project_name": "Signup Project",
                    "billing_track": None,
                },
            )
        assert res.status_code == 200
        payload = res.json()
        assert payload["access_token"]
        assert payload["user"]["billing_track"] == "project"
        created_user = next(obj for obj in register_db.added if isinstance(obj, User))
        assert created_user.billing_track == "project"
    finally:
        app.dependency_overrides.clear()


def test_register_accepts_explicit_byok_billing_track():
    register_db = _RegisterDb()

    async def _fake_register_db():
        yield register_db

    app.dependency_overrides[deps.get_db] = _fake_register_db
    try:
        with TestClient(app) as client:
            res = client.post(
                "/api/auth/register",
                json={
                    "email": "signup-project@example.com",
                    "password": "password-123",
                    "project_name": "Signup Project",
                    "billing_track": "byok",
                },
            )
        assert res.status_code == 200
        payload = res.json()
        assert payload["access_token"]
        assert payload["user"]["billing_track"] == "byok"
        created_user = next(obj for obj in register_db.added if isinstance(obj, User))
        assert created_user.billing_track == "byok"
    finally:
        app.dependency_overrides.clear()


def test_register_normalizes_padded_mixed_case_byok_billing_track():
    register_db = _RegisterDb()

    async def _fake_register_db():
        yield register_db

    app.dependency_overrides[deps.get_db] = _fake_register_db
    try:
        with TestClient(app) as client:
            res = client.post(
                "/api/auth/register",
                json={
                    "email": "signup-mixed-case@example.com",
                    "password": "password-123",
                    "project_name": "Signup Project",
                    "billing_track": "  ByOk  ",
                },
            )
        assert res.status_code == 200
        payload = res.json()
        assert payload["access_token"]
        assert payload["user"]["billing_track"] == "byok"
        created_user = next(obj for obj in register_db.added if isinstance(obj, User))
        assert created_user.billing_track == "byok"
    finally:
        app.dependency_overrides.clear()


def test_login_returns_access_token_and_normalized_byok_billing_track():
    user_id = uuid.uuid4()
    project_id = uuid.uuid4()
    fake_user = User(
        id=user_id,
        email="login@example.com",
        hashed_password=hash_password("password-123"),
        plan="free",
        agent_slots=3,
        custom_agent_count=0,
        billing_track="  ByOk  ",
        byok_claude_key=None,
        byok_openai_key=None,
    )
    fake_project = Project(id=project_id, name="Login Project", goal="", workspace_path=None)
    fake_membership = ProjectMembership(
        project_id=project_id,
        user_id=user_id,
        role="owner",
        is_owner=True,
    )
    login_db = _LoginDb(fake_user, [(fake_membership, fake_project)])

    async def _fake_login_db():
        yield login_db

    app.dependency_overrides[deps.get_db] = _fake_login_db
    try:
        with TestClient(app) as client:
            res = client.post(
                "/api/auth/login",
                json={
                    "email": "login@example.com",
                    "password": "password-123",
                },
            )
        assert res.status_code == 200
        payload = res.json()
        assert payload["access_token"]
        assert payload["user"]["billing_track"] == "byok"
        token_payload = decode_access_token(payload["access_token"])
        assert token_payload is not None
        assert token_payload["sub"] == str(user_id)
        assert token_payload["email"] == "login@example.com"
        assert token_payload["billing_track"] == "byok"
        assert payload["memberships"] == [
            {
                "project_id": str(project_id),
                "project_name": "Login Project",
                "role": "owner",
                "is_owner": True,
            }
        ]
    finally:
        app.dependency_overrides.clear()


def test_login_falls_back_unknown_billing_track_to_project_in_user_and_token():
    user_id = uuid.uuid4()
    project_id = uuid.uuid4()
    fake_user = User(
        id=user_id,
        email="legacy-login@example.com",
        hashed_password=hash_password("password-123"),
        plan="free",
        agent_slots=3,
        custom_agent_count=0,
        billing_track="enterprise",
        byok_claude_key=None,
        byok_openai_key=None,
    )
    fake_project = Project(id=project_id, name="Legacy Login Project", goal="", workspace_path=None)
    fake_membership = ProjectMembership(
        project_id=project_id,
        user_id=user_id,
        role="owner",
        is_owner=True,
    )
    login_db = _LoginDb(fake_user, [(fake_membership, fake_project)])

    async def _fake_login_db():
        yield login_db

    app.dependency_overrides[deps.get_db] = _fake_login_db
    try:
        with TestClient(app) as client:
            res = client.post(
                "/api/auth/login",
                json={
                    "email": "legacy-login@example.com",
                    "password": "password-123",
                },
            )
        assert res.status_code == 200
        payload = res.json()
        assert payload["access_token"]
        assert payload["user"]["billing_track"] == "project"
        token_payload = decode_access_token(payload["access_token"])
        assert token_payload is not None
        assert token_payload["billing_track"] == "project"
    finally:
        app.dependency_overrides.clear()
