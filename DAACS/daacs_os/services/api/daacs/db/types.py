from __future__ import annotations

import json
import uuid
from typing import Any, Optional

from sqlalchemy.dialects.postgresql import ARRAY as PG_ARRAY
from sqlalchemy.dialects.postgresql import JSONB as PG_JSONB
from sqlalchemy.dialects.postgresql import UUID as PG_UUID
from sqlalchemy.types import JSON, TEXT, TypeDecorator


class UuidType(TypeDecorator):
    impl = TEXT
    cache_ok = True

    def load_dialect_impl(self, dialect):
        if dialect.name == "postgresql":
            return dialect.type_descriptor(PG_UUID(as_uuid=True))
        return dialect.type_descriptor(TEXT())

    def process_bind_param(self, value: Any, dialect):
        if value is None:
            return None
        if isinstance(value, uuid.UUID):
            return value if dialect.name == "postgresql" else str(value)
        parsed = uuid.UUID(str(value))
        return parsed if dialect.name == "postgresql" else str(parsed)

    def process_result_value(self, value: Any, dialect):
        if value is None:
            return None
        if isinstance(value, uuid.UUID):
            return value
        try:
            return uuid.UUID(str(value))
        except Exception:
            return value


class JsonType(TypeDecorator):
    impl = JSON
    cache_ok = True

    def load_dialect_impl(self, dialect):
        if dialect.name == "postgresql":
            return dialect.type_descriptor(PG_JSONB())
        return dialect.type_descriptor(JSON())

    def process_bind_param(self, value: Any, dialect):
        return value

    def process_result_value(self, value: Any, dialect):
        return value


class UuidArrayType(TypeDecorator):
    impl = JSON
    cache_ok = True

    def load_dialect_impl(self, dialect):
        if dialect.name == "postgresql":
            return dialect.type_descriptor(PG_ARRAY(PG_UUID(as_uuid=True)))
        return dialect.type_descriptor(JSON())

    def process_bind_param(self, value: Any, dialect):
        if value is None:
            return None
        if dialect.name == "postgresql":
            return [uuid.UUID(str(v)) for v in value]
        return [str(uuid.UUID(str(v))) for v in value]

    def process_result_value(self, value: Any, dialect):
        if value is None:
            return None
        if dialect.name == "postgresql":
            return [v if isinstance(v, uuid.UUID) else uuid.UUID(str(v)) for v in value]
        if isinstance(value, str):
            try:
                value = json.loads(value)
            except Exception:
                return value
        return [v if isinstance(v, uuid.UUID) else uuid.UUID(str(v)) for v in (value or [])]

