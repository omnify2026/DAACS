"""
Pydantic schemas for request/response validation and response structures
"""
import base64
from pydantic import BaseModel, Field
from typing import Literal, List
from uuid import UUID


class AudioPayload(BaseModel):
    """
    오디오 데이터 전송을 위한 Pydantic 모델
    """
    audio_base64: str = Field(..., description="Base64 인코딩된 오디오 데이터")
    audio_mime: Literal["audio/mpeg"] = Field("audio/mpeg", description="오디오 MIME 타입 (현재는 audio/mpeg만 지원)")


# --- Utility Functions ---
def encode_audio_to_base64(audio_bytes: bytes) -> str:
    """
    바이너리 오디오 데이터를 Base64 문자열로 인코딩

    Args:
        audio_bytes: 인코딩할 바이너리 오디오 데이터

    Returns:
        Base64 인코딩된 문자열
    """
    return base64.b64encode(audio_bytes).decode('utf-8')


def create_audio_payload(audio_bytes: bytes, mime_type: str = "audio/mpeg") -> AudioPayload:
    """
    바이너리 오디오 데이터로부터 AudioPayload 객체 생성

    Args:
        audio_bytes: 바이너리 오디오 데이터
        mime_type: MIME 타입 (기본값: "audio/mpeg")

    Returns:
        AudioPayload 객체
    """
    audio_base64 = encode_audio_to_base64(audio_bytes)
    return AudioPayload(
        audio_base64=audio_base64,
        audio_mime=mime_type
    )


# --- API Request Schemas ---
class CallStartRequest(BaseModel):
    """
    '/api/call/start' 엔드포인트 요청 스키마
    """
    child_name: str = Field(..., max_length=50, description="훈육할 아이의 이름")
    situation_hint: str = Field(..., min_length=1, description="부모가 설명하는 아이의 잘못된 행동")


class GenerateResponseRequest(BaseModel):
    """
    '/api/generate-response' 엔드포인트 요청 스키마
    """
    session_id: UUID = Field(..., description="현재 통화 세션 ID")
    child_name: str = Field(..., max_length=50, description="훈육할 아이의 이름") # 중복될 수 있으나, 세션 유효성 검증 및 LLM 프롬프트 재생성을 위해 포함
    parent_text: str = Field(..., min_length=1, description="부모가 입력한 음성 인식 텍스트")


# --- API Response Schemas ---
class CallStartResponse(BaseModel):
    """
    '/api/call/start' 엔드포인트 응답 스키마
    """
    session_id: UUID = Field(..., description="새로 생성된 통화 세션 ID")
    intro_text: str = Field(..., description="경찰관의 첫 멘트 텍스트")
    audio_base64: str = Field(..., description="Base64 인코딩된 첫 멘트 오디오 데이터")
    audio_mime: Literal["audio/mpeg"] = Field("audio/mpeg", description="오디오 MIME 타입")


class GenerateResponseResponse(BaseModel):
    """
    '/api/generate-response' 엔드포인트 응답 스키마
    """
    reply_text: str = Field(..., description="AI 경찰관의 훈육 텍스트")
    audio_base64: str = Field(..., description="Base64 인코딩된 훈육 오디오 데이터")
    audio_mime: Literal["audio/mpeg"] = Field("audio/mpeg", description="오디오 MIME 타입")
    turn_index: int = Field(..., description="현재 대화 턴의 인덱스 (0부터 시작)")