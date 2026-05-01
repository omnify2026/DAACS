"""Authentication endpoints.

Provides register/login/me/byok for token-backed session bootstrap.
"""

from __future__ import annotations

import logging
import uuid
import os
import secrets
from datetime import date
from typing import Any, Dict, List, Optional, Literal

from fastapi import APIRouter, Depends, HTTPException, Request, Response
from pydantic import BaseModel, EmailStr, Field
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy.exc import IntegrityError

from ..core.deps import get_current_user, get_db, get_optional_user
from ..core.rate_limit import check_rate_limit
from ..core.security import create_access_token, encrypt_secret, hash_password, verify_password
from ..core.ws_ticket import issue_ws_ticket
from ..db.models import Project, ProjectMembership, User
from ..core.deps import require_project_access

router = APIRouter(prefix="/api/auth", tags=["auth"])
logger = logging.getLogger("daacs.routes.auth")

BillingTrack = Literal["byok", "project"]


def _env_int(name: str, default: int, minimum: int = 1) -> int:
    raw = os.getenv(name, str(default)).strip()
    try:
        value = int(raw)
    except ValueError:
        logger.warning("Invalid integer env %s=%r, using default %s", name, raw, default)
        value = default
    return max(minimum, value)


def _is_production_env() -> bool:
    env = os.getenv("DAACS_ENV", "dev").strip().lower()
    return env in {"prod", "production"}


def _env_optional_bool(name: str) -> Optional[bool]:
    raw = os.getenv(name, "").strip().lower()
    if not raw:
        return None
    if raw in {"1", "true", "yes", "on"}:
        return True
    if raw in {"0", "false", "no", "off"}:
        return False
    logger.warning("Invalid boolean env %s=%r, ignoring override", name, raw)
    return None


_AUTH_RATE_WINDOW_SECONDS = _env_int("DAACS_AUTH_RATE_WINDOW_SECONDS", 300)
_AUTH_LOGIN_MAX_ATTEMPTS = _env_int("DAACS_AUTH_LOGIN_MAX_ATTEMPTS", 20)
_AUTH_REGISTER_MAX_ATTEMPTS = _env_int("DAACS_AUTH_REGISTER_MAX_ATTEMPTS", 10)
_AUTH_BYOK_MAX_ATTEMPTS = _env_int("DAACS_AUTH_BYOK_MAX_ATTEMPTS", 30)
_AUTH_COOKIE_NAME = (os.getenv("DAACS_AUTH_COOKIE_NAME", "daacs_access_token") or "").strip() or "daacs_access_token"
_AUTH_COOKIE_PATH = (os.getenv("DAACS_AUTH_COOKIE_PATH", "/") or "").strip() or "/"
_AUTH_COOKIE_DOMAIN = (os.getenv("DAACS_AUTH_COOKIE_DOMAIN", "") or "").strip() or None
_AUTH_COOKIE_MAX_AGE_SECONDS = _env_int("DAACS_AUTH_COOKIE_MAX_AGE_SECONDS", 60 * 60 * 24 * 7)
_AUTH_CSRF_COOKIE_NAME = (os.getenv("DAACS_CSRF_COOKIE_NAME", "daacs_csrf_token") or "").strip() or "daacs_csrf_token"


def _csrf_enforced() -> bool:
    raw = os.getenv("DAACS_CSRF_ENFORCE", "").strip().lower()
    return raw in {"1", "true", "yes", "on"}


def _cookie_samesite() -> Literal["lax", "strict", "none"]:
    raw = os.getenv("DAACS_AUTH_COOKIE_SAMESITE", "lax").strip().lower()
    if raw in {"lax", "strict", "none"}:
        if raw == "none" and not _csrf_enforced():
            logger.warning(
                "DAACS_AUTH_COOKIE_SAMESITE=none requires DAACS_CSRF_ENFORCE=true. Falling back to 'lax'."
            )
            return "lax"
        return raw
    logger.warning("Invalid DAACS_AUTH_COOKIE_SAMESITE=%r, defaulting to 'lax'", raw)
    return "lax"


def _cookie_secure(request: Request) -> bool:
    override = _env_optional_bool("DAACS_AUTH_COOKIE_SECURE")
    if override is not None:
        return override
    forwarded_proto = request.headers.get("x-forwarded-proto", "").strip().lower()
    return _is_production_env() or request.url.scheme == "https" or forwarded_proto == "https"


def _set_auth_cookie(response: Response, token: str, request: Request) -> None:
    secure = _cookie_secure(request)
    samesite = _cookie_samesite()
    if samesite == "none" and not secure:
        secure = True
    response.set_cookie(
        key=_AUTH_COOKIE_NAME,
        value=token,
        max_age=_AUTH_COOKIE_MAX_AGE_SECONDS,
        expires=_AUTH_COOKIE_MAX_AGE_SECONDS,
        path=_AUTH_COOKIE_PATH,
        domain=_AUTH_COOKIE_DOMAIN,
        secure=secure,
        httponly=True,
        samesite=samesite,
    )
    response.set_cookie(
        key=_AUTH_CSRF_COOKIE_NAME,
        value=secrets.token_urlsafe(24),
        max_age=_AUTH_COOKIE_MAX_AGE_SECONDS,
        expires=_AUTH_COOKIE_MAX_AGE_SECONDS,
        path=_AUTH_COOKIE_PATH,
        domain=_AUTH_COOKIE_DOMAIN,
        secure=secure,
        httponly=False,
        samesite=samesite,
    )


def _clear_auth_cookie(response: Response, request: Request) -> None:
    response.delete_cookie(
        key=_AUTH_COOKIE_NAME,
        path=_AUTH_COOKIE_PATH,
        domain=_AUTH_COOKIE_DOMAIN,
        secure=_cookie_secure(request),
        httponly=True,
        samesite=_cookie_samesite(),
    )
    response.delete_cookie(
        key=_AUTH_CSRF_COOKIE_NAME,
        path=_AUTH_COOKIE_PATH,
        domain=_AUTH_COOKIE_DOMAIN,
        secure=_cookie_secure(request),
        httponly=False,
        samesite=_cookie_samesite(),
    )


def _audit_auth_event(
    *,
    event: str,
    request: Request,
    success: bool,
    status_code: int,
    reason: Optional[str] = None,
    user_id: Optional[uuid.UUID] = None,
    email: Optional[str] = None,
) -> None:
    parts = [
        f"event={event}",
        f"success={str(success).lower()}",
        f"status={status_code}",
        f"ip={_client_ip(request)}",
    ]
    if user_id is not None:
        parts.append(f"user_id={user_id}")
    if email:
        parts.append(f"email={email}")
    if reason:
        parts.append(f"reason={reason}")
    message = "auth_audit " + " ".join(parts)
    if success:
        logger.info(message)
    else:
        logger.warning(message)


class RegisterRequest(BaseModel):
    email: EmailStr
    password: str = Field(..., min_length=8)
    project_name: Optional[str] = Field(default="Default Project")
    billing_track: Optional[str] = Field(default="project")


class LoginRequest(BaseModel):
    email: EmailStr
    password: str = Field(..., min_length=8)


class ByokRequest(BaseModel):
    byok_claude_key: Optional[str] = None
    byok_openai_key: Optional[str] = None


class ByokStatusResponse(BaseModel):
    billing_track: BillingTrack
    byok_has_claude_key: bool
    byok_has_openai_key: bool


class ByokSaveResponse(ByokStatusResponse):
    status: str
    updated: Dict[str, bool]


class CreateProjectRequest(BaseModel):
    project_name: str = Field(..., min_length=1, max_length=120)


class AuthUserInfo(BaseModel):
    id: str
    email: str
    plan: str
    agent_slots: int
    custom_agent_count: int
    billing_track: BillingTrack
    byok_has_claude_key: bool
    byok_has_openai_key: bool


class ProjectMembershipInfo(BaseModel):
    project_id: str
    project_name: str
    role: str
    is_owner: bool


class AuthResponse(BaseModel):
    user: AuthUserInfo
    memberships: List[ProjectMembershipInfo]
    access_token: str


class WsTicketResponse(BaseModel):
    ticket: str
    token_type: str = "ws-ticket"
    expires_in: int



def _client_ip(request: Request) -> str:
    x_real_ip = request.headers.get("x-real-ip", "").strip()
    if x_real_ip:
        return x_real_ip

    xff = request.headers.get("x-forwarded-for", "")
    if xff:
        parts = [part.strip() for part in xff.split(",") if part.strip()]
        if parts:
            # With proxy_add_x_forwarded_for, right-most entry is nearest trusted proxy.
            return parts[-1]
    if request.client and request.client.host:
        return request.client.host
    return "unknown"


async def _enforce_auth_rate_limit(request: Request, action: str, max_attempts: int) -> None:
    key = f"auth:{action}:{_client_ip(request)}"
    try:
        allowed, retry_after = await check_rate_limit(
            key=key,
            limit=max_attempts,
            window_seconds=_AUTH_RATE_WINDOW_SECONDS,
        )
    except RuntimeError as exc:
        _audit_auth_event(
            event=f"{action}_rate_limit_error",
            request=request,
            success=False,
            status_code=503,
            reason="rate_limit_backend_unavailable",
        )
        raise HTTPException(
            status_code=503,
            detail="Authentication service temporarily unavailable",
        ) from exc

    if not allowed:
        wait_for = max(1, int(retry_after or _AUTH_RATE_WINDOW_SECONDS))
        _audit_auth_event(
            event=f"{action}_rate_limited",
            request=request,
            success=False,
            status_code=429,
            reason="too_many_attempts",
        )
        raise HTTPException(
            status_code=429,
            detail="Too many authentication attempts. Please retry later.",
            headers={"Retry-After": str(wait_for)},
        )


def _normalize_email(value: str) -> str:
    return value.strip().lower()


def _to_uuid(value: uuid.UUID) -> str:
    return str(value)


def _format_user_payload(user: User) -> AuthUserInfo:
    billing_track = _normalize_billing_track(user.billing_track)
    return AuthUserInfo(
        id=_to_uuid(user.id),
        email=user.email,
        plan=user.plan,
        agent_slots=user.agent_slots,
        custom_agent_count=user.custom_agent_count,
        billing_track=billing_track,
        byok_has_claude_key=user.byok_claude_key is not None,
        byok_has_openai_key=user.byok_openai_key is not None,
    )


def _issue_token(user: User) -> str:
    billing_track = _normalize_billing_track(user.billing_track)
    return create_access_token(
        subject=_to_uuid(user.id),
        extra={
            "email": user.email,
            "plan": user.plan,
            "billing_track": billing_track,
            "issue_date": date.today().isoformat(),
        },
    )


def _normalize_project_name(value: Optional[str]) -> str:
    name = (value or "").strip()
    return name or "Default Project"


def _normalize_billing_track(value: Optional[str]) -> BillingTrack:
    # Preserve legacy compatibility by normalizing case and whitespace before
    # comparison. Mixed-case BYOK variants still map to "byok"; unknown legacy
    # values continue to fall back to the default "project" track.
    normalized = (value or "").strip().lower()
    return "byok" if normalized == "byok" else "project"


def _normalize_optional_secret(value: Optional[str]) -> Optional[str]:
    normalized = (value or "").strip()
    return normalized or None


def _format_byok_status(user: User) -> ByokStatusResponse:
    return ByokStatusResponse(
        billing_track=_normalize_billing_track(user.billing_track),
        byok_has_claude_key=user.byok_claude_key is not None,
        byok_has_openai_key=user.byok_openai_key is not None,
    )


def _build_membership_payload(
    rows: List[tuple[ProjectMembership, Project]],
) -> List[ProjectMembershipInfo]:
    return [
        ProjectMembershipInfo(
            project_id=_to_uuid(m.project_id),
            project_name=p.name,
            role=m.role,
            is_owner=m.is_owner,
        )
        for m, p in rows
    ]


async def _create_named_project(
    user: User,
    db: AsyncSession,
    project_name: str,
) -> ProjectMembership:
    project = Project(name=project_name, goal="", workspace_path=None)
    db.add(project)
    await db.flush()
    membership = ProjectMembership(
        project_id=project.id,
        user_id=user.id,
        role="owner",
        is_owner=True,
    )
    db.add(membership)
    return membership


async def _load_memberships_with_projects(
    user_id: uuid.UUID,
    db: AsyncSession,
) -> List[tuple[ProjectMembership, Project]]:
    rows = await db.execute(
        select(ProjectMembership, Project)
        .join(Project, Project.id == ProjectMembership.project_id)
        .where(ProjectMembership.user_id == user_id)
        .order_by(Project.created_at.desc())
    )
    return list(rows.all())


@router.post("/register", response_model=AuthResponse)
async def register(
    req: RegisterRequest,
    request: Request,
    response: Response,
    db: AsyncSession = Depends(get_db),
) -> AuthResponse:
    await _enforce_auth_rate_limit(request, "register", _AUTH_REGISTER_MAX_ATTEMPTS)

    email = _normalize_email(req.email)
    if not email:
        _audit_auth_event(
            event="register",
            request=request,
            success=False,
            status_code=400,
            reason="invalid_email",
        )
        raise HTTPException(status_code=400, detail="Invalid email")

    if not req.password.strip():
        _audit_auth_event(
            event="register",
            request=request,
            success=False,
            status_code=400,
            reason="password_required",
            email=email,
        )
        raise HTTPException(status_code=400, detail="Password required")

    existing = await db.execute(select(User).where(User.email == email))
    if existing.scalar_one_or_none() is not None:
        _audit_auth_event(
            event="register",
            request=request,
            success=False,
            status_code=409,
            reason="email_exists",
            email=email,
        )
        raise HTTPException(status_code=409, detail="Email already registered")

    user = User(
        email=email,
        hashed_password=hash_password(req.password),
        billing_track=_normalize_billing_track(req.billing_track),
    )
    db.add(user)
    try:
        await db.flush()
    except IntegrityError as exc:
        _audit_auth_event(
            event="register",
            request=request,
            success=False,
            status_code=409,
            reason="integrity_conflict",
            email=email,
        )
        raise HTTPException(status_code=409, detail="Email already registered") from exc

    project_name = _normalize_project_name(req.project_name)
    membership = await _create_named_project(user, db, project_name)
    await db.flush()

    token = _issue_token(user)
    _set_auth_cookie(response, token, request)
    _audit_auth_event(
        event="register",
        request=request,
        success=True,
        status_code=200,
        user_id=user.id,
        email=user.email,
    )
    return AuthResponse(
        user=_format_user_payload(user),
        memberships=[
            ProjectMembershipInfo(
                project_id=_to_uuid(membership.project_id),
                project_name=project_name,
                role=membership.role,
                is_owner=membership.is_owner,
            )
        ],
        access_token=token,
    )


@router.post("/login", response_model=AuthResponse)
async def login(
    req: LoginRequest,
    request: Request,
    response: Response,
    db: AsyncSession = Depends(get_db),
) -> AuthResponse:
    await _enforce_auth_rate_limit(request, "login", _AUTH_LOGIN_MAX_ATTEMPTS)

    email = _normalize_email(req.email)
    if not email:
        _audit_auth_event(
            event="login",
            request=request,
            success=False,
            status_code=400,
            reason="invalid_email",
        )
        raise HTTPException(status_code=400, detail="Invalid email")

    result = await db.execute(select(User).where(User.email == email))
    user = result.scalar_one_or_none()
    if user is None:
        _audit_auth_event(
            event="login",
            request=request,
            success=False,
            status_code=401,
            reason="invalid_credentials",
            email=email,
        )
        raise HTTPException(status_code=401, detail="Invalid credentials")

    if not verify_password(req.password, user.hashed_password):
        _audit_auth_event(
            event="login",
            request=request,
            success=False,
            status_code=401,
            reason="invalid_credentials",
            email=email,
            user_id=user.id,
        )
        raise HTTPException(status_code=401, detail="Invalid credentials")

    memberships = await _load_memberships_with_projects(user.id, db)

    token = _issue_token(user)
    _set_auth_cookie(response, token, request)
    _audit_auth_event(
        event="login",
        request=request,
        success=True,
        status_code=200,
        user_id=user.id,
        email=user.email,
    )
    return AuthResponse(
        user=_format_user_payload(user),
        memberships=_build_membership_payload(memberships),
        access_token=token,
    )


@router.get("/me", response_model=AuthResponse)
async def me(
    request: Request,
    response: Response,
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
) -> AuthResponse:
    memberships = await _load_memberships_with_projects(current_user.id, db)
    token = _issue_token(current_user)
    _set_auth_cookie(response, token, request)

    return AuthResponse(
        user=_format_user_payload(current_user),
        memberships=_build_membership_payload(memberships),
        access_token=token,
    )


@router.get("/projects", response_model=List[ProjectMembershipInfo])
async def list_projects(
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
) -> List[ProjectMembershipInfo]:
    memberships = await _load_memberships_with_projects(current_user.id, db)
    return _build_membership_payload(memberships)


@router.post("/projects", response_model=ProjectMembershipInfo)
async def create_project(
    req: CreateProjectRequest,
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
) -> ProjectMembershipInfo:
    project_name = _normalize_project_name(req.project_name)
    membership = await _create_named_project(current_user, db, project_name)
    await db.flush()
    return ProjectMembershipInfo(
        project_id=_to_uuid(membership.project_id),
        project_name=project_name,
        role=membership.role,
        is_owner=membership.is_owner,
    )


@router.get("/byok", response_model=ByokStatusResponse)
async def get_byok_status(
    current_user: User = Depends(get_current_user),
) -> ByokStatusResponse:
    return _format_byok_status(current_user)


@router.post("/byok", response_model=ByokSaveResponse)
async def store_byok(
    req: ByokRequest,
    request: Request,
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
) -> ByokSaveResponse:
    await _enforce_auth_rate_limit(request, "byok", _AUTH_BYOK_MAX_ATTEMPTS)

    updates: Dict[str, bool] = {"byok_claude_key": False, "byok_openai_key": False}

    if req.byok_claude_key is None and req.byok_openai_key is None:
        _audit_auth_event(
            event="byok_update",
            request=request,
            success=False,
            status_code=400,
            reason="empty_payload",
            user_id=current_user.id,
            email=current_user.email,
        )
        raise HTTPException(status_code=400, detail="No key payload provided")

    normalized_claude_key = _normalize_optional_secret(req.byok_claude_key)
    normalized_openai_key = _normalize_optional_secret(req.byok_openai_key)
    if normalized_claude_key is None and normalized_openai_key is None:
        _audit_auth_event(
            event="byok_update",
            request=request,
            success=False,
            status_code=400,
            reason="empty_payload",
            user_id=current_user.id,
            email=current_user.email,
        )
        raise HTTPException(status_code=400, detail="No key payload provided")

    if normalized_claude_key is not None:
        current_user.byok_claude_key = encrypt_secret(normalized_claude_key)
        updates["byok_claude_key"] = True

    if normalized_openai_key is not None:
        current_user.byok_openai_key = encrypt_secret(normalized_openai_key)
        updates["byok_openai_key"] = True

    if updates["byok_claude_key"] or updates["byok_openai_key"]:
        current_user.billing_track = "byok"

    db.add(current_user)
    await db.flush()

    _audit_auth_event(
        event="byok_update",
        request=request,
        success=True,
        status_code=200,
        user_id=current_user.id,
        email=current_user.email,
    )

    return ByokSaveResponse(
        status="saved",
        **_format_byok_status(current_user).model_dump(),
        updated=updates,
    )

@router.post("/logout")
async def logout(
    request: Request,
    response: Response,
    current_user: Optional[User] = Depends(get_optional_user),
) -> Dict[str, str]:
    _clear_auth_cookie(response, request)
    _audit_auth_event(
        event="logout",
        request=request,
        success=True,
        status_code=200,
        user_id=current_user.id if current_user else None,
        email=current_user.email if current_user else None,
    )
    return {"status": "logged_out"}


@router.post("/ws-ticket/{project_id}", response_model=WsTicketResponse)
async def create_ws_ticket(
    project_id: str,
    _project: uuid.UUID = Depends(require_project_access),
    current_user: User = Depends(get_current_user),
) -> WsTicketResponse:
    ttl = int(os.getenv("DAACS_WS_TICKET_TTL_SECONDS", "30"))
    ticket = await issue_ws_ticket(current_user.id, project_id, ttl_seconds=ttl)
    return WsTicketResponse(ticket=ticket, expires_in=max(1, ttl))
