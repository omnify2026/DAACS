import base64
from uuid import UUID, uuid4

from app.services.session_memory import session_memory


def test_generate_response_success(client, monkeypatch):
    session = session_memory.create_session("민수")

    def fake_llm(child_name: str, parent_text: str) -> str:
        return f"{child_name}야, 다시는 그러지 말아라."

    def fake_tts(_: str) -> bytes:
        return b"reply-audio"

    monkeypatch.setattr("app.routers.call.generate_reply", fake_llm)
    monkeypatch.setattr("app.routers.call.synthesize_text_to_audio", fake_tts)

    response = client.post(
        "/api/generate-response",
        json={
            "session_id": str(session.session_id),
            "child_name": "민수",
            "parent_text": "장난감을 던졌어요.",
        },
    )

    assert response.status_code == 200
    data = response.json()
    assert data["reply_text"] == "민수야, 다시는 그러지 말아라."
    assert data["audio_mime"] == "audio/mpeg"
    assert data["audio_base64"] == base64.b64encode(b"reply-audio").decode("utf-8")
    assert data["turn_index"] == 0

    stored = session_memory.get_session(UUID(data["session_id"])) if "session_id" in data else session
    assert stored is not None
    assert len(stored.turns) == 1
    assert stored.turns[0].parent_text == "장난감을 던졌어요."


def test_generate_response_invalid_session(client):
    response = client.post(
        "/api/generate-response",
        json={
            "session_id": str(uuid4()),
            "child_name": "민수",
            "parent_text": "장난감을 던졌어요.",
        },
    )

    assert response.status_code == 400
    data = response.json()
    assert data["detail"] == "세션이 유효하지 않습니다."


def test_generate_response_openai_error(client, monkeypatch):
    from app.exceptions import OpenAIException

    session = session_memory.create_session("민수")

    def fake_llm(child_name: str, parent_text: str) -> str:
        raise OpenAIException("llm 실패")

    monkeypatch.setattr("app.routers.call.generate_reply", fake_llm)

    response = client.post(
        "/api/generate-response",
        json={
            "session_id": str(session.session_id),
            "child_name": "민수",
            "parent_text": "장난감을 던졌어요.",
        },
    )

    assert response.status_code == 502
    data = response.json()
    assert data["detail"] == "llm 실패"