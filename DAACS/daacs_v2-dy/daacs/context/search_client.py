from typing import List, Protocol, Dict, Any, TypedDict
import logging

logger = logging.getLogger(__name__)

class SearchResult(TypedDict):
    urls: List[str]
    snippets: List[str]
    error: str  # Add error field

class SearchClient(Protocol):
    def search(self, query: str) -> SearchResult:
        """Execute a search query and return snippets and URLs."""
        ...

class MockSearchClient:
    """
    A simulated search client for testing or when no API key is present.
    Returns deterministic fake results based on keywords.
    """
    def search(self, query: str) -> SearchResult:
        query_lower = query.lower()
        snippets = []
        urls = []

        if "frontend" in query_lower or "react" in query_lower:
            snippets.append("In 2025, React combined with Vite remains the dominant choice for SPAs.")
            snippets.append("Next.js 15 is widely adopted for larger scale projects.")
            urls.append("https://example.com/frontend-trends-2025")
        
        if "electron" in query_lower or "tauri" in query_lower:
            snippets.append("Tauri v2 is gaining traction due to its smaller bundle size compared to Electron.")
            snippets.append("Electron is still the standard for enterprise desktop apps needing full node integration.")
            urls.append("https://example.com/desktop-wars")
            
        if "fastapi" in query_lower or "python" in query_lower:
            snippets.append("FastAPI is the fastest growing Python web framework in 2024-2025.")
            snippets.append("Django remains the choice for monolithic batteries-included apps.")
            urls.append("https://example.com/python-web-2025")

        if not snippets:
            snippets.append(f"No specific trends found for {query} in mock database.")
            urls.append("https://example.com/generic-search")

        return {"urls": urls, "snippets": snippets, "error": ""}


class DuckDuckGoSearchClient:
    """
    Real search client using DuckDuckGo.
    """
    def search(self, query: str, timeout: int = 10) -> SearchResult:
        try:
            from duckduckgo_search import DDGS
            with DDGS(timeout=timeout) as ddgs:
                # Get top 5 results
                results = list(ddgs.text(query, max_results=5))
                
                urls = [r['href'] for r in results]
                snippets = [r['body'] for r in results]
                
                if not snippets:
                    return {"urls": [], "snippets": [f"No results found for {query}"], "error": ""}
                    
                return {"urls": urls, "snippets": snippets, "error": ""}
                
        except Exception as e:
            logger.warning(f"DuckDuckGo search failed for query '{query}': {e}")
            return {"urls": [], "snippets": [], "error": str(e)}


