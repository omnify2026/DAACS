"""
Route-splitting helpers for incremental router decomposition.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import List

from fastapi import APIRouter
from fastapi.routing import APIRoute


@dataclass(frozen=True)
class PathMatcher:
    prefix: str

    @property
    def normalized(self) -> List[str]:
        direct = self.prefix if self.prefix.startswith("/") else f"/{self.prefix}"
        api_prefix = f"/api{direct}" if not direct.startswith("/api/") else direct
        return [direct, api_prefix]


def split_router(source_router: APIRouter, matcher: PathMatcher) -> APIRouter:
    target = APIRouter()
    prefixes = matcher.normalized
    for route in source_router.routes:
        if isinstance(route, APIRoute):
            path = getattr(route, "path", "")
            if any(path.startswith(prefix) for prefix in prefixes):
                target.routes.append(route)
    return target
