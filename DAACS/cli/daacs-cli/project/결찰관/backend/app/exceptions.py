from fastapi import HTTPException, status
from typing import Any, Dict, Optional


class APIException(HTTPException):
    """
    API 관련 예외를 위한 기본 클래스
    """
    def __init__(
        self,
        status_code: int = status.HTTP_500_INTERNAL_SERVER_ERROR,
        detail: Any = "Internal Server Error",
        headers: Optional[Dict[str, Any]] = None,
    ):
        super().__init__(status_code=status_code, detail=detail, headers=headers)


class BadRequestException(APIException):
    """
    400 Bad Request 예외
    """
    def __init__(self, detail: Any = "Bad Request", headers: Optional[Dict[str, Any]] = None):
        super().__init__(status_code=status.HTTP_400_BAD_REQUEST, detail=detail, headers=headers)


class OpenAIException(APIException):
    """
    502 Bad Gateway (OpenAI API 관련) 예외
    """
    def __init__(self, detail: Any = "OpenAI API Error", headers: Optional[Dict[str, Any]] = None):
        super().__init__(status_code=status.HTTP_502_BAD_GATEWAY, detail=detail, headers=headers)


class InternalServerError(APIException):
    """
    500 Internal Server Error 예외
    """
    def __init__(self, detail: Any = "Internal Server Error", headers: Optional[Dict[str, Any]] = None):
        super().__init__(status_code=status.HTTP_500_INTERNAL_SERVER_ERROR, detail=detail, headers=headers)
