from datetime import datetime, timezone
from typing import List, Optional
from .types import RFIResult, TechContext, Assumptions
from .query_builder import build_queries
from .cache import ContextCache
from .search_client import SearchClient, MockSearchClient, DuckDuckGoSearchClient
from .constraints import generate_constraints
from ..utils import setup_logger
from ..config import WEB_SEARCH_PROVIDER, WEB_TECH_FILTER_WORDS

logger = setup_logger("WebTechContext")

class WebTechContextProvider:
    """
    Fetches factual tech trend context from the web.
    Uses caching to ensure efficient and reproducible results.
    NO recommendation, NO decision.
    """

    def __init__(self, search_client: Optional[SearchClient] = None, cache: Optional[ContextCache] = None):
        self.search = search_client or self._default_search_client()
        self.cache = cache or ContextCache()

    @staticmethod
    def _default_search_client() -> SearchClient:
        if WEB_SEARCH_PROVIDER == "duckduckgo":
            return DuckDuckGoSearchClient()
        return MockSearchClient()

    def fetch(self, rfi: RFIResult, assumptions: Optional[Assumptions] = None) -> TechContext:
        queries = build_queries(rfi)
        facts: List[str] = []
        sources: List[str] = []
        constraints: List[str] = []

        if assumptions is None:
            assumptions = Assumptions()

        # Generate constraints from assumptions
        constraints.extend(generate_constraints(assumptions))

        for q in queries:
            logger.info(f"[WebTech] Processing Query: {q}")
            
            # 1. Check Cache
            cached = self.cache.get(q)
            if cached:
                logger.info(f"[WebTech] Cache HIT for: {q}")
                facts.extend(cached.get("facts", []))
                sources.extend(cached.get("sources", []))
                continue

            logger.info(f"[WebTech] Cache MISS. Searching external...")
            # 2. External Search
            try:
                result = self.search.search(q)  # {snippets: [], urls: [], error: str}
                if result.get("error"):
                    raise RuntimeError(result["error"])
                
                # 3. Extract Facts
                snippets = result.get("snippets", [])
                urls = result.get("urls", [])
                extracted = self._extract_facts(snippets)

                payload = {
                    "facts": extracted,
                    "sources": urls,
                    "fetched_at": datetime.now(timezone.utc).isoformat(),
                }

                # 4. Update Cache
                self.cache.set(q, payload)

                facts.extend(extracted)
                sources.extend(urls)
            except (RuntimeError, ValueError) as e:
                logger.warning(f"[WebTech] Search failed for '{q}': {e}")
                continue
            except Exception as e:
                logger.warning(f"[WebTech] Search failed for '{q}': {e}")
                # Be resilient: continue to next query even if one fails
                continue

        # Deduplicate results
        facts = list(dict.fromkeys(facts))
        sources = list(dict.fromkeys(sources))

        return TechContext(
            facts=facts,
            constraints=constraints + (rfi.constraints.copy() if rfi.constraints else []),
            sources=sources,
            fetched_at=datetime.now(timezone.utc),
        )

    def _extract_facts(self, snippets: List[str]) -> List[str]:
        """
        Conservative extraction:
        - Removes highly opinionated sentences (containing 'best', 'should')
        - Keeps adoption / usage / trend statements
        """
        facts = []
        filters = [w.strip().lower() for w in WEB_TECH_FILTER_WORDS if w.strip()]
        for s in snippets:
            # Simple heuristic to avoid subjective recommendations
            s_lower = s.lower()
            if any(word in s_lower for word in filters):
                 # Skip purely opinionated "advice"
                 continue
            facts.append(s.strip())
        return facts
