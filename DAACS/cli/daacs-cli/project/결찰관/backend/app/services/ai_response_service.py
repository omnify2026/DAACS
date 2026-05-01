from openai import OpenAI

from app.core.config import settings
from app.exceptions import OpenAIException


def generate_reply(child_name: str, parent_text: str) -> str:
    """
    OpenAI LLM으로 훈육 대사를 생성한다.
    """
    client = OpenAI(api_key=settings.openai_api_key)
    user_message = f"아이 이름: {child_name}\n부모 설명: {parent_text}"

    try:
        response = client.chat.completions.create(
            model=settings.openai_llm_model,
            messages=[
                {"role": "system", "content": settings.system_prompt},
                {"role": "user", "content": user_message},
            ],
            temperature=0.7,
        )
        content = response.choices[0].message.content if response.choices else None
        if not content:
            raise OpenAIException("OpenAI 응답이 비어 있습니다.")
        return content.strip()
    except OpenAIException:
        raise
    except Exception as exc:
        raise OpenAIException(str(exc)) from exc