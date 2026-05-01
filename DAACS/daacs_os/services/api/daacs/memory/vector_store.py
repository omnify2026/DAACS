"""
DAACS OS — Memory Vector Store
ChromaDB 기반 장기 기억 — 성공 솔루션 + 실패 교훈 저장/검색.

Source: DAACS_v2-dy/daacs/memory/vector_store.py
Adapted: docker-compose의 chromadb 서비스 사용 (port 8000).
"""
import logging
import time
import uuid
from typing import Any, Dict, List, Optional

logger = logging.getLogger("daacs.memory.vector_store")


class MemoryStore:
    """
    ChromaDB 벡터 스토어 래퍼.

    사용법:
        store = MemoryStore()
        store.add("FastAPI CORS solution", {"type": "solution", "success": True})
        results = store.search("CORS issue", n_results=3)

    ChromaDB 클라이언트가 없으면 gracefully degrade (빈 결과 반환).
    """

    _instance: Optional["MemoryStore"] = None

    def __new__(cls, *args, **kwargs):
        if cls._instance is None:
            cls._instance = super().__new__(cls)
            cls._instance._initialized = False
        return cls._instance

    def __init__(self, host: str = "chromadb", port: int = 8000):
        if self._initialized:
            return

        self._collection = None
        self._available = False

        try:
            import chromadb
            client = chromadb.HttpClient(host=host, port=port)
            self._collection = client.get_or_create_collection(
                name="daacs_memory",
                metadata={"hnsw:space": "cosine"},
            )
            self._available = True
            logger.info(f"MemoryStore connected to ChromaDB at {host}:{port}")
        except Exception as e:
            logger.warning(f"ChromaDB not available ({e}), memory disabled")
            self._available = False

        self._initialized = True

    @property
    def available(self) -> bool:
        return self._available

    def add(
        self,
        text: str,
        metadata: Optional[Dict[str, Any]] = None,
        doc_id: Optional[str] = None,
    ) -> Optional[str]:
        """텍스트를 벡터 스토어에 저장."""
        if not self._available or self._collection is None:
            return None

        doc_id = doc_id or str(uuid.uuid4())
        meta = metadata or {}
        meta["timestamp"] = time.time()

        try:
            self._collection.add(
                documents=[text],
                metadatas=[meta],
                ids=[doc_id],
            )
            logger.debug(f"Memory added: id={doc_id}, type={meta.get('type', 'unknown')}")
            return doc_id
        except Exception as e:
            logger.warning(f"Memory add failed: {e}")
            return None

    def search(
        self,
        query: str,
        n_results: int = 3,
        filter_metadata: Optional[Dict[str, Any]] = None,
    ) -> List[Dict[str, Any]]:
        """유사 텍스트 검색."""
        if not self._available or self._collection is None:
            return []

        try:
            kwargs: Dict[str, Any] = {
                "query_texts": [query],
                "n_results": n_results,
            }
            if filter_metadata:
                kwargs["where"] = filter_metadata

            results = self._collection.query(**kwargs)

            parsed = []
            documents = results.get("documents", [[]])[0]
            metadatas = results.get("metadatas", [[]])[0]
            distances = results.get("distances", [[]])[0]

            for doc, meta, dist in zip(documents, metadatas, distances):
                parsed.append({
                    "content": doc,
                    "metadata": meta,
                    "distance": dist,
                    "similarity": 1.0 - dist,
                })

            return parsed
        except Exception as e:
            logger.warning(f"Memory search failed: {e}")
            return []

    def add_solution(self, goal: str, solution: str, project_id: str = "") -> Optional[str]:
        """성공 솔루션 저장."""
        return self.add(
            text=f"Goal: {goal}\nSolution: {solution}",
            metadata={"type": "solution", "success": True, "project_id": project_id},
        )

    def add_failure_lesson(self, goal: str, failure: str, lesson: str, project_id: str = "") -> Optional[str]:
        """실패 교훈 저장."""
        return self.add(
            text=f"Goal: {goal}\nFailure: {failure}\nLesson: {lesson}",
            metadata={"type": "failure_lesson", "success": False, "project_id": project_id},
        )

    def search_solutions(self, query: str, n_results: int = 3) -> List[Dict[str, Any]]:
        """성공 솔루션만 검색."""
        return self.search(query, n_results, filter_metadata={"success": True})

    def search_failures(self, query: str, n_results: int = 3) -> List[Dict[str, Any]]:
        """실패 교훈만 검색."""
        return self.search(query, n_results, filter_metadata={"type": "failure_lesson"})
