from __future__ import annotations

from fastapi.testclient import TestClient

import daacs.api as daacs_api


def test_api_files_content_update_and_download(tmp_path, monkeypatch):
    daacs_api.projects.clear()
    # Clear messages table for test isolation
    try:
        from daacs.db import get_db, Session
        db = next(get_db())
        db.execute("DELETE FROM messages")
        db.commit()
    except Exception:
        pass  # DB might not exist in test environment
    client = TestClient(daacs_api.app)

    monkeypatch.chdir(tmp_path)

    res = client.post("/api/projects", json={"goal": "api smoke", "config": {}})
    assert res.status_code == 200
    project = res.json()
    project_id = project["id"]

    # Empty input should still be accepted but must not create an empty chat message.
    # First, get current message count
    res = client.get(f"/api/projects/{project_id}/messages")
    assert res.status_code == 200
    initial_message_count = len(res.json())
    
    # Send empty input
    res = client.post(f"/api/projects/{project_id}/input", json={"text": ""})
    assert res.status_code == 200
    
    # Verify no new message was added
    res = client.get(f"/api/projects/{project_id}/messages")
    assert res.status_code == 200
    assert len(res.json()) == initial_message_count  # No new message should be added

    # File listing should work.
    res = client.get(f"/api/projects/{project_id}/files")
    assert res.status_code == 200
    payload = res.json()
    assert "backend_files" in payload
    assert "frontend_files" in payload

    # Write a file, read it back.
    rel_path = "backend/__api_test__.txt"
    res = client.put(
        f"/api/projects/{project_id}/files",
        params={"file": rel_path, "type": "backend"},
        json={"content": "hello"},
    )
    assert res.status_code == 200

    res = client.get(
        f"/api/projects/{project_id}/files/content",
        params={"file": rel_path, "type": "backend"},
    )
    assert res.status_code == 200
    assert res.json()["content"] == "hello"

    # Path traversal should be rejected.
    res = client.get(
        f"/api/projects/{project_id}/files/content",
        params={"file": "../README.md", "type": "backend"},
    )
    assert res.status_code == 400

    # Download should return a zip.
    res = client.get(f"/api/projects/{project_id}/download")
    assert res.status_code == 200
    assert res.headers.get("content-type") == "application/zip"
