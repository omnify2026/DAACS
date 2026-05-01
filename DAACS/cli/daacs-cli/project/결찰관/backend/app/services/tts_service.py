from openai import OpenAI

from app.core.config import settings
from app.exceptions import OpenAIException


def synthesize_text_to_audio(text: str) -> bytes:
    """
    OpenAI TTS로 텍스트를 음성 바이너리로 변환한다.
    """
    client = OpenAI(api_key=settings.openai_api_key)

    try:
        response = client.audio.speech.create(
            model=settings.openai_tts_model,
            voice=settings.openai_tts_voice,
            input=text,
        )
        if hasattr(response, "read"):
            return response.read()
        if hasattr(response, "content"):
            return response.content
        raise OpenAIException("TTS 응답을 읽을 수 없습니다.")
    except OpenAIException:
        raise
    except Exception as exc:
        raise OpenAIException(str(exc)) from exc