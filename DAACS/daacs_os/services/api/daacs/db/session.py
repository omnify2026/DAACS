"""Async DB session helpers with lazy engine initialization.

Engine/sessionmaker creation is deferred until first real DB use so tests that
override DB dependencies can import the app without postgres driver presence.
"""

import os
import asyncio
from pathlib import Path
from typing import AsyncGenerator

from fastapi import HTTPException
from sqlalchemy.engine.url import make_url
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker, create_async_engine

_engine = None
_session_maker: async_sessionmaker[AsyncSession] | None = None
engine = None
async_session = None


def _is_production_env() -> bool:
    env = os.getenv("DAACS_ENV", "dev").strip().lower()
    return env in {"prod", "production"}


def validate_db_env() -> None:
    database_url = os.getenv("DATABASE_URL", "").strip()
    pg_pass = os.getenv("POSTGRES_PASSWORD", "").strip()
    if not database_url and not pg_pass:
        raise RuntimeError("DATABASE_URL or POSTGRES_PASSWORD env var is required")


def _database_url() -> str:
    validate_db_env()
    database_url = os.getenv("DATABASE_URL", "").strip()
    if database_url:
        return database_url

    pg_host = os.getenv("POSTGRES_HOST", "localhost")
    pg_port = os.getenv("POSTGRES_PORT", "5432")
    pg_db = os.getenv("POSTGRES_DB", "daacs")
    pg_user = os.getenv("POSTGRES_USER", "daacs")
    pg_pass = os.getenv("POSTGRES_PASSWORD", "").strip()
    return (
        f"postgresql+asyncpg://{pg_user}:{pg_pass}@{pg_host}:{pg_port}/{pg_db}"
    )


def _ensure_session_maker() -> async_sessionmaker[AsyncSession]:
    global _engine, _session_maker, engine, async_session
    if _session_maker is None:
        _engine = create_async_engine(
            _database_url(),
            echo=os.getenv("DB_ECHO", "false").lower() == "true",
            pool_pre_ping=True,
        )
        _session_maker = async_sessionmaker(
            _engine,
            class_=AsyncSession,
            expire_on_commit=False,
        )
        engine = _engine
        async_session = _session_maker
    return _session_maker


def get_engine():
    _ensure_session_maker()
    return _engine


async def get_db() -> AsyncGenerator[AsyncSession, None]:
    """FastAPI dependency for async DB session."""
    try:
        session_maker = _ensure_session_maker()
    except RuntimeError as e:
        if _is_production_env():
            raise
        raise HTTPException(status_code=503, detail=str(e)) from e
    async with session_maker() as session:
        try:
            yield session
            await session.commit()
        except Exception:
            await session.rollback()
            raise
        finally:
            await session.close()


async def init_db_schema() -> None:
    url_raw = os.getenv("DATABASE_URL", "").strip()
    if not url_raw:
        return

    url = make_url(url_raw)
    if url.drivername.startswith("sqlite"):
        database_path = (url.database or "").strip()
        if database_path:
            Path(database_path).parent.mkdir(parents=True, exist_ok=True)

    from .models import Base

    _ensure_session_maker()
    if _engine is None:
        return
    last_exc: Exception | None = None
    for attempt in range(1, 16):
        try:
            async with _engine.begin() as conn:
                await conn.run_sync(Base.metadata.create_all)
            return
        except Exception as e:
            last_exc = e
            await asyncio.sleep(min(5.0, 0.25 * attempt))
    if last_exc is not None:
        raise last_exc
