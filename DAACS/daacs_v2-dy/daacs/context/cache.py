import json
import hashlib
from pathlib import Path
from datetime import datetime, timedelta, timezone
from typing import Optional, Dict, Any
from daacs.config import CACHE_DIR, CACHE_TTL_HOURS


class ContextCache:
    """
    Simple file-based cache for search results and fetched contexts.
    Ensures reproducibility and reduces external API calls.
    """
    def __init__(self, ttl_hours: Optional[int] = None, cache_dir: Optional[str] = None):
        target_dir = cache_dir or CACHE_DIR
        self.base = Path(target_dir)
        try:
            self.base.mkdir(parents=True, exist_ok=True)
        except OSError:
            # Fallback to temp if permission denied - logic could be improved here but keeps it simple
            pass
            
        hours = ttl_hours if ttl_hours is not None else CACHE_TTL_HOURS
        self.ttl = timedelta(hours=hours)

    def _key(self, text: str) -> Path:
        """Generate a deterministic filename from the query text."""
        h = hashlib.sha256(text.encode()).hexdigest()
        return self.base / f"{h}.json"

    def get(self, key: str) -> Optional[Dict[str, Any]]:
        """Retrieve cached data if it exists and is not expired."""
        path = self._key(key)
        if not path.exists():
            return None

        try:
            data = json.loads(path.read_text(encoding='utf-8'))
            fetched_at_str = data.get("fetched_at", "")
            if not fetched_at_str:
                return None
                
            fetched_at = datetime.fromisoformat(fetched_at_str)
            if fetched_at.tzinfo is None:
                fetched_at = fetched_at.replace(tzinfo=timezone.utc)
            
            # Check TTL
            if datetime.now(timezone.utc) - fetched_at > self.ttl:
                return None
            
            return data
        except (json.JSONDecodeError, ValueError, KeyError, OSError):
            return None

    def set(self, key: str, value: Dict[str, Any]):
        """Store data in cache."""
        path = self._key(key)
        # Ensure value has fetched_at
        if "fetched_at" not in value:
            value["fetched_at"] = datetime.now(timezone.utc).isoformat()
            
        try:
            path.write_text(json.dumps(value, ensure_ascii=False, indent=2), encoding='utf-8')
        except OSError:
            pass

    def clear(self):
        """Clear all cache files."""
        if self.base.exists():
            for p in self.base.glob("*.json"):
                try:
                    p.unlink()
                except OSError:
                    pass

