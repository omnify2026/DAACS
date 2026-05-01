"""Authentication and secret-management helpers for DAACS API."""

from __future__ import annotations

import base64
import hashlib
import logging
import os
from datetime import datetime, timedelta, timezone
from typing import Any, Dict, Optional

from cryptography.fernet import Fernet
from jose import JWTError, jwt
from passlib.context import CryptContext

_pwd_context = CryptContext(schemes=["bcrypt"], deprecated="auto")
logger = logging.getLogger("daacs.security")

_jwt_algorithm = os.getenv("DAACS_JWT_ALG", "HS256")
_jwt_ttl_minutes = int(os.getenv("DAACS_JWT_TTL_MINUTES", "1440"))
_fernet: Fernet | None = None
_validated_signature: tuple[str, str, str] | None = None


def _jwt_secret() -> str:
    return os.getenv("DAACS_JWT_SECRET", "").strip()


def _fernet_secret() -> str:
    return os.getenv("DAACS_FERNET_SECRET", "").strip()


def _is_production_env() -> bool:
    env = os.getenv("DAACS_ENV", "dev").strip().lower()
    return env in {"prod", "production"}


def _is_weak_secret(secret: str) -> bool:
    lowered = secret.lower()
    weak_markers = (
        "changeme",
        "default",
        "example",
        "generate-a-strong",
        "password",
    )
    if len(secret) < 32:
        return True
    return any(marker in lowered for marker in weak_markers)


def validate_security_env() -> None:
    global _validated_signature

    jwt_secret = _jwt_secret()
    fernet_secret = _fernet_secret()
    env = os.getenv("DAACS_ENV", "dev").strip().lower()
    signature = (jwt_secret, fernet_secret, env)
    if _validated_signature == signature:
        return

    missing = []
    if not jwt_secret:
        missing.append("DAACS_JWT_SECRET")
    if not fernet_secret:
        missing.append("DAACS_FERNET_SECRET")
    if missing:
        raise RuntimeError(f"Missing required security env vars: {', '.join(missing)}")

    weak = []
    if _is_weak_secret(jwt_secret):
        weak.append("DAACS_JWT_SECRET")
    if _is_weak_secret(fernet_secret):
        weak.append("DAACS_FERNET_SECRET")

    if weak:
        msg = (
            "Weak security secrets detected: "
            + ", ".join(weak)
            + ". Use random values with at least 32 characters."
        )
        if _is_production_env():
            raise RuntimeError(msg)
        logger.warning(msg)

    _validated_signature = signature


def _ensure_fernet_key() -> bytes:
    validate_security_env()
    secret = _fernet_secret().encode("utf-8")
    digest = hashlib.sha256(secret).digest()
    return base64.urlsafe_b64encode(digest)


def _get_fernet() -> Fernet:
    global _fernet
    if _fernet is None:
        _fernet = Fernet(_ensure_fernet_key())
    return _fernet


def hash_password(password: str) -> str:
    return _pwd_context.hash(password)


def verify_password(plain_password: str, hashed_password: str) -> bool:
    if not plain_password or not hashed_password:
        return False
    return _pwd_context.verify(plain_password, hashed_password)


def _now_utc() -> datetime:
    return datetime.now(timezone.utc)


def create_access_token(subject: str, extra: Optional[Dict[str, Any]] = None) -> str:
    validate_security_env()
    payload: Dict[str, Any] = {
        "sub": subject,
        "iat": int(_now_utc().timestamp()),
        "exp": int((_now_utc() + timedelta(minutes=_jwt_ttl_minutes)).timestamp()),
    }
    if extra:
        payload.update(extra)
    return jwt.encode(payload, _jwt_secret(), algorithm=_jwt_algorithm)


def decode_access_token(token: str) -> Optional[Dict[str, Any]]:
    validate_security_env()
    try:
        return jwt.decode(token, _jwt_secret(), algorithms=[_jwt_algorithm])
    except JWTError:
        return None


def encrypt_secret(raw: str) -> bytes:
    return _get_fernet().encrypt(raw.encode("utf-8"))


def decrypt_secret(payload: Optional[bytes]) -> Optional[str]:
    if payload is None:
        return None
    return _get_fernet().decrypt(payload).decode("utf-8")


def byok_mask(value: Optional[bytes]) -> bool:
    return value is not None
