from fastapi import APIRouter

from app.exceptions import BadRequestException, InternalServerError, OpenAIException
from app.models.session import CallStatus
from app.schemas import (
    CallStartRequest,
    CallStartResponse,
    GenerateResponseRequest,
    GenerateResponseResponse,
    create_audio_payload,
)
from app.services.ai_response_service import generate_reply
from app.services.session_memory import session_memory
from app.services.tts_service import synthesize_text_to_audio


router = APIRouter(prefix="/api", tags=["call"])

INTRO_TEXT = "관할 경찰서입니다. 무슨 일입니까?"


@router.post("/call/start", response_model=CallStartResponse)
async def call_start(payload: CallStartRequest):
    session = session_memory.create_session(child_name=payload.child_name)

    try:
        audio_bytes = synthesize_text_to_audio(INTRO_TEXT)
    except OpenAIException:
        raise
    except Exception as exc:
        raise InternalServerError(str(exc)) from exc

    audio_payload = create_audio_payload(audio_bytes)
    return CallStartResponse(
        session_id=session.session_id,
        intro_text=INTRO_TEXT,
        audio_base64=audio_payload.audio_base64,
        audio_mime=audio_payload.audio_mime,
    )


@router.post("/generate-response", response_model=GenerateResponseResponse)
async def generate_response(payload: GenerateResponseRequest):
    session = session_memory.get_session(payload.session_id)
    if session is None or session.status != CallStatus.ACTIVE:
        raise BadRequestException("세션이 유효하지 않습니다.")
    if session.child_name != payload.child_name:
        raise BadRequestException("세션이 유효하지 않습니다.")

    try:
        reply_text = generate_reply(
            child_name=payload.child_name,
            parent_text=payload.parent_text,
        )
        audio_bytes = synthesize_text_to_audio(reply_text)
    except OpenAIException:
        raise
    except Exception as exc:
        raise InternalServerError(str(exc)) from exc

    session_memory.add_turn(session.session_id, payload.parent_text, reply_text)
    turn_index = len(session.turns) - 1

    audio_payload = create_audio_payload(audio_bytes)
    return GenerateResponseResponse(
        reply_text=reply_text,
        audio_base64=audio_payload.audio_base64,
        audio_mime=audio_payload.audio_mime,
        turn_index=turn_index,
    )