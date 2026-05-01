"""
Configuration management using Pydantic Settings
환경 변수를 타입 안전하게 로딩하고 검증
"""
from pydantic_settings import BaseSettings, SettingsConfigDict
from typing import Literal


class Settings(BaseSettings):
    """
    애플리케이션 설정
    
    환경 변수 또는 .env 파일에서 자동으로 로딩됩니다.
    모든 설정은 타입 검증을 거칩니다.
    """
    
    # OpenAI API 설정
    openai_api_key: str
    openai_llm_model: str = "gpt-4o-mini"
    openai_tts_model: str = "tts-1"
    openai_tts_voice: Literal["alloy", "echo", "fable", "onyx", "nova", "shimmer"] = "onyx"
    
    # 오디오 응답 모드
    audio_response_mode: Literal["base64", "url"] = "base64"
    
    # 서버 설정
    host: str = "0.0.0.0"
    port: int = 8000
    
    # 시스템 프롬프트 (고정값)
    system_prompt: str = (
        "너는 20년 경력의 베테랑 강력계 형사다. "
        "아이의 잘못을 듣고 아이에게 직접 아주 엄하고 단호하게 훈육하라. "
        "'~했나?', '~하도록 해라' 같은 종결어미를 사용하고, "
        "아이의 이름을 직접 불러라. "
        "다시는 안 그러겠다는 약속을 받아내는 것이 목적이다."
    )
    
    # Pydantic Settings 설정
    model_config = SettingsConfigDict(
        env_file=".env",
        env_file_encoding="utf-8",
        case_sensitive=False,
        extra="ignore"
    )


# 전역 설정 인스턴스
settings = Settings()