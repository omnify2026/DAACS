"""Dependency helpers for authn/authz checks."""

from __future__ import annotations

import os
import uuid
from typing import Any, Optional

from fastapi import Depends, HTTPException, Query, Request
from fastapi.security import OAuth2PasswordBearer
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from .security import decode_access_token
from ..db.models import ProjectMembership, User
from ..db.session import get_db

oauth2_scheme = OAuth2PasswordBearer(tokenUrl="/api/auth/login", auto_error=False)
_AUTH_REQUIRED_DETAIL = "Missing or invalid authorization"


def _auth_cookie_name() -> str:
    return (os.getenv("DAACS_AUTH_COOKIE_NAME", "daacs_access_token") or "").strip() or "daacs_access_token"


def _resolve_auth_token(token: str, request: Request | None) -> str:
    bearer = (token or "").strip()
    if bearer:
        return bearer
    if request is None:
        return ""
    cookie_value = (request.cookies.get(_auth_cookie_name()) or "").strip()
    return cookie_value


async def get_current_user(
    request: Request,
    token: str = Depends(oauth2_scheme),
    db: AsyncSession = Depends(get_db),
) -> User:
    resolved_token = _resolve_auth_token(token, request)
    if not resolved_token:
        raise HTTPException(status_code=401, detail=_AUTH_REQUIRED_DETAIL)

    payload = decode_access_token(resolved_token)
    if payload is None:
        raise HTTPException(status_code=401, detail=_AUTH_REQUIRED_DETAIL)

    subject = payload.get("sub")
    if not subject:
        raise HTTPException(status_code=401, detail=_AUTH_REQUIRED_DETAIL)

    try:
        user_id = uuid.UUID(str(subject))
    except ValueError:
        raise HTTPException(status_code=401, detail=_AUTH_REQUIRED_DETAIL)

    result = await db.execute(select(User).where(User.id == user_id))
    user = result.scalar_one_or_none()
    if user is None or not user.is_active:
        raise HTTPException(status_code=401, detail="Invalid user")
    return user


async def get_optional_user(
    request: Request,
    token: str = Depends(oauth2_scheme),
    db: AsyncSession = Depends(get_db),
) -> Optional[User]:
    resolved_token = _resolve_auth_token(token, request)
    if not resolved_token:
        return None
    payload = decode_access_token(resolved_token)
    if payload is None:
        return None
    subject = payload.get("sub")
    if not subject:
        return None
    try:
        user_id = uuid.UUID(str(subject))
    except ValueError:
        return None

    result = await db.execute(select(User).where(User.id == user_id))
    user = result.scalar_one_or_none()
    if user is None or not user.is_active:
        return None
    return user


def _parse_project_id(project_id: str) -> uuid.UUID:
    try:
        return uuid.UUID(project_id)
    except ValueError as exc:
        raise HTTPException(status_code=400, detail="Invalid project_id") from exc


async def require_project_access(
    project_id: str,
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
) -> uuid.UUID:
    project_uuid = _parse_project_id(project_id)
    result = await db.execute(
        select(ProjectMembership).where(
            ProjectMembership.project_id == project_uuid,
            ProjectMembership.user_id == user.id,
        )
    )
    membership = result.scalar_one_or_none()
    if membership is None:
        raise HTTPException(status_code=403, detail="Forbidden: no project access")
    return project_uuid


async def require_any_user(
    token: str = Query(None),
    db: AsyncSession = Depends(get_db),
) -> User:
    if not token:
        raise HTTPException(status_code=401, detail="Token query missing")
    payload = decode_access_token(token)
    if payload is None:
        raise HTTPException(status_code=401, detail="Invalid or expired token")
    subject = payload.get("sub")
    if not subject:
        raise HTTPException(status_code=401, detail="Invalid token")
    try:
        user_id = uuid.UUID(str(subject))
    except ValueError:
        raise HTTPException(status_code=401, detail="Invalid token")
    result = await db.execute(select(User).where(User.id == user_id))
    user = result.scalar_one_or_none()
    if user is None or not user.is_active:
        raise HTTPException(status_code=401, detail="Invalid user")
    return user
