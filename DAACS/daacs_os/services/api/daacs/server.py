"""
DAACS OS FastAPI Application
Includes REST API + CORS + Health
"""
import logging
import os
import sys
import asyncio
import secrets
from contextlib import asynccontextmanager

from dotenv import load_dotenv
from fastapi import FastAPI, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse
from sqlalchemy.exc import SQLAlchemyError

from .application.workflow_service import start_distributed_runtime, stop_distributed_runtime
from .core.security import validate_security_env
from .db.session import init_db_schema, validate_db_env
from .routes.agents import router as agents_router
from .routes.agents_ws import router as ws_router, ws_manager
from .routes.agent_dashboard import router as dashboard_router
from .routes.agent_factory import router as agent_factory_router
from .routes.collaboration import router as collaboration_router
from .routes.presets import router as presets_router
from .routes.skills import router as skills_router
from .routes.auth import router as auth_router
from .routes.runtime import router as runtime_router
from .routes.teams import router as teams_router
from .routes.workflows import router as workflow_router
from .routes.overnight import router as overnight_router
from .routes.owner_ops import router as owner_ops_router

load_dotenv(override=False)

if sys.platform.startswith("win"):
    try:
        asyncio.set_event_loop_policy(asyncio.WindowsSelectorEventLoopPolicy())
    except Exception:
        pass

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s [%(name)s] %(levelname)s: %(message)s",
)
logger = logging.getLogger("daacs.server")

_sentry_initialized = False
_CSRF_UNSAFE_METHODS = {"POST", "PUT", "PATCH", "DELETE"}
_CSRF_EXEMPT_PATHS = {
    "/api/auth/login",
    "/api/auth/register",
}


def _is_production_env() -> bool:
    env = os.getenv("DAACS_ENV", "dev").strip().lower()
    return env in {"prod", "production"}


def _csrf_enforced() -> bool:
    raw = os.getenv("DAACS_CSRF_ENFORCE", "").strip().lower()
    return raw in {"1", "true", "yes", "on"}


def _auth_cookie_name() -> str:
    return (os.getenv("DAACS_AUTH_COOKIE_NAME", "daacs_access_token") or "").strip() or "daacs_access_token"


def _csrf_cookie_name() -> str:
    return (os.getenv("DAACS_CSRF_COOKIE_NAME", "daacs_csrf_token") or "").strip() or "daacs_csrf_token"


def _csrf_header_name() -> str:
    return (os.getenv("DAACS_CSRF_HEADER_NAME", "x-csrf-token") or "").strip().lower() or "x-csrf-token"


def _init_sentry() -> None:
    global _sentry_initialized
    if _sentry_initialized:
        return
    dsn = os.getenv("SENTRY_DSN", "").strip()
    if not dsn:
        return
    try:
        import sentry_sdk
        from sentry_sdk.integrations.fastapi import FastApiIntegration

        sentry_sdk.init(
            dsn=dsn,
            environment=os.getenv("DAACS_ENV", "dev"),
            traces_sample_rate=float(os.getenv("SENTRY_TRACES_SAMPLE_RATE", "0.0")),
            profiles_sample_rate=float(os.getenv("SENTRY_PROFILES_SAMPLE_RATE", "0.0")),
            integrations=[FastApiIntegration()],
        )
        _sentry_initialized = True
        logger.info("Sentry initialized")
    except Exception as exc:  # pragma: no cover
        logger.warning("Sentry initialization failed: %s", exc)


@asynccontextmanager
async def lifespan(app: FastAPI):
    validate_security_env()
    try:
        validate_db_env()
    except RuntimeError as e:
        if _is_production_env():
            raise
        logger.warning(f"DB env not configured; continuing in dev mode. Reason: {e}")
    if not _is_production_env() and os.getenv("DAACS_DB_AUTO_CREATE", "true").strip().lower() in {"1", "true", "yes", "on"}:
        try:
            await init_db_schema()
        except Exception as e:
            logger.warning(f"DB schema init failed in dev mode. Reason: {e}")
    _init_sentry()
    await start_distributed_runtime()
    logger.info("DAACS OS API starting up...")
    try:
        yield
    finally:
        await ws_manager.shutdown()
        await stop_distributed_runtime()
        logger.info("DAACS OS API shutting down...")


app = FastAPI(
    title="DAACS OS API",
    description="AI-Powered Virtual Enterprise OS - One Man, One Enterprise",
    version="1.0.0",
    lifespan=lifespan,
)


@app.exception_handler(SQLAlchemyError)
async def sqlalchemy_error_handler(request: Request, exc: SQLAlchemyError):
    logger.error(
        "Database error method=%s path=%s",
        request.method,
        request.url.path,
        exc_info=exc,
    )
    return JSONResponse(
        status_code=503,
        content={"detail": "Database temporarily unavailable"},
    )


# CORS
_default_dev_origins = "http://localhost:3000,http://localhost:5173"
cors_raw_env = (os.getenv("DAACS_CORS_ORIGINS") or os.getenv("CORS_ORIGINS") or "").strip()
if _is_production_env() and not cors_raw_env:
    raise RuntimeError("DAACS_CORS_ORIGINS must be set in production")
cors_raw = cors_raw_env or _default_dev_origins

allowed_origins = [origin.strip() for origin in cors_raw.split(",") if origin.strip()]
if "*" in allowed_origins:
    if _is_production_env():
        raise RuntimeError("CORS wildcard '*' is forbidden in production")
    logger.warning("CORS wildcard '*' is not allowed with credentials; falling back to localhost allowlist")
    allowed_origins = [origin.strip() for origin in _default_dev_origins.split(",") if origin.strip()]
if _is_production_env() and any("localhost" in origin for origin in allowed_origins):
    logger.warning("Production CORS origins contain localhost entries: %s", allowed_origins)

app.add_middleware(
    CORSMiddleware,
    allow_origins=allowed_origins,
    allow_credentials=True,
    allow_methods=["GET", "POST", "PUT", "DELETE", "OPTIONS"],
    allow_headers=["Content-Type", "Authorization", "X-CSRF-Token"],
)


@app.middleware("http")
async def add_security_headers(request: Request, call_next):
    if (
        _csrf_enforced()
        and request.method.upper() in _CSRF_UNSAFE_METHODS
        and request.url.path.startswith("/api/")
        and request.url.path not in _CSRF_EXEMPT_PATHS
    ):
        # CSRF applies only when cookie-session auth is actually present.
        auth_cookie = request.cookies.get(_auth_cookie_name(), "")
        if auth_cookie:
            csrf_cookie = request.cookies.get(_csrf_cookie_name(), "")
            csrf_header = request.headers.get(_csrf_header_name(), "").strip()
            if not csrf_cookie or not csrf_header or not secrets.compare_digest(csrf_cookie, csrf_header):
                return JSONResponse(status_code=403, content={"detail": "CSRF validation failed"})

    response = await call_next(request)
    response.headers.setdefault("X-Content-Type-Options", "nosniff")
    response.headers.setdefault("X-Frame-Options", "DENY")
    response.headers.setdefault("Referrer-Policy", "strict-origin-when-cross-origin")
    response.headers.setdefault("Permissions-Policy", "camera=(), microphone=(), geolocation=()")
    response.headers.setdefault("X-XSS-Protection", "0")

    enable_hsts = os.getenv("DAACS_ENABLE_HSTS", "true").strip().lower() in {"1", "true", "yes", "on"}
    forwarded_proto = request.headers.get("x-forwarded-proto", "").strip().lower()
    is_https = request.url.scheme == "https" or forwarded_proto == "https"
    if enable_hsts and is_https:
        response.headers.setdefault("Strict-Transport-Security", "max-age=31536000; includeSubDomains")

    return response


# Routers
app.include_router(workflow_router)
app.include_router(overnight_router)
app.include_router(agents_router)
app.include_router(teams_router)
app.include_router(auth_router)
app.include_router(presets_router)
app.include_router(skills_router)
app.include_router(dashboard_router)
app.include_router(agent_factory_router)
app.include_router(ws_router)
app.include_router(collaboration_router)
app.include_router(owner_ops_router)
app.include_router(runtime_router)


# Health
@app.get("/health")
async def health_check():
    return {"status": "ok", "service": "daacs-os"}


@app.get("/")
async def root():
    return {
        "name": "DAACS OS",
        "version": "1.0.0",
        "description": "One Man, One Enterprise",
        "docs": "/docs",
    }


# Standalone run
if __name__ == "__main__":
    import uvicorn

    port = int(os.getenv("API_PORT", "8001"))
    log_level = os.getenv("LOG_LEVEL", "info").lower()

    logger.info(f"DAACS OS API starting on http://0.0.0.0:{port}")
    uvicorn.run(
        "daacs.server:app",
        host="0.0.0.0",
        port=port,
        log_level=log_level,
        reload=os.getenv("API_RELOAD", "true").lower() == "true",
    )
