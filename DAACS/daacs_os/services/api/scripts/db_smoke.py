from __future__ import annotations

import asyncio
import os
import sys

from dotenv import load_dotenv
from sqlalchemy import text
from sqlalchemy.ext.asyncio import create_async_engine

if sys.platform.startswith("win"):
    asyncio.set_event_loop_policy(asyncio.WindowsSelectorEventLoopPolicy())


async def Main() -> None:
    load_dotenv()
    database_url = (os.getenv("DATABASE_URL") or "").strip()
    if not database_url:
        raise RuntimeError("DATABASE_URL is empty")

    engine = create_async_engine(database_url, pool_pre_ping=True)
    async with engine.connect() as conn:
        outValue = await conn.execute(text("select 1"))
        outRow = outValue.first()
        print(outRow[0] if outRow else None)
    await engine.dispose()


if __name__ == "__main__":
    asyncio.run(Main())
