import base64
from uuid import UUID

from app.routers.call import INTRO_TEXT
from app.services.session_memory import session_memory


def test_call_start_success(client, monkeypatch):
    def fake_tts(_: str) -> bytes:
        return b"fake-audio"

    monkeypatch.setattr("app.routers.call.synthesize_text_to_audio", fake_tts)

    response = client.post(
        "/api/call/start",
        json={"child_name": "민수", "situation_hint": "장난감을 던짐"},
    )

    assert response.status_code == 200
    data = response.json()
    assert data["intro_text"] == INTRO_TEXT
    assert data["audio_mime"] == "audio/mpeg"
    assert data["audio_base64"] == base64.b64encode(b"fake-audio").decode("utf-8")

    session_id = UUID(data["session_id"])
    session = session_memory.get_session(session_id)
    assert session is not None
    assert session.child_name == "민수"


def test_call_start_validation_error(client):
    response = client.post("/api/call/start", json={"child_name": "민수"})

    assert response.status_code == 422
    data = response.json()
    assert data["detail"] == "Validation Error"


def test_call_start_openai_error(client, monkeypatch):
    from app.exceptions import OpenAIException

    def fake_tts(_: str) -> bytes:
        raise OpenAIException("tts 실패")

    monkeypatch.setattr("app.routers.call.synthesize_text_to_audio", fake_tts)

    response = client.post(
        "/api/call/start",
        json={"child_name": "민수", "situation_hint": "장난감을 던짐"},
    )

    assert response.status_code == 502
    data = response.json()
    assert data["detail"] == "tts 실패"