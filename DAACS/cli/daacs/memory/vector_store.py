"""
DAACS Memory Manager
Long-Term Memory using ChromaDB and SentenceTransformers.
Ported from DAACS-dy for hybrid integration.
"""

import os
import time
import threading
import uuid
from typing import List, Dict, Any, Optional

try:
    import chromadb
    from sentence_transformers import SentenceTransformer
    HAS_MEMORY_DEPS = True
except ImportError:
    HAS_MEMORY_DEPS = False

import logging

logger = logging.getLogger("MemoryManager")

# Thread lock for singleton pattern
_singleton_lock = threading.Lock()


class MemoryManager:
    """
    Long-Term Memory Manager using ChromaDB and SentenceTransformers.
    Stores and retrieves 'episodic' memories (Code Snippets, Solutions, Errors).
    Thread-safe singleton pattern.
    """
    
    _instance = None
    
    def __new__(cls, *args, **kwargs):
        if cls._instance is None:
            with _singleton_lock:
                # Double-check locking pattern
                if cls._instance is None:
                    cls._instance = super(MemoryManager, cls).__new__(cls)
        return cls._instance

    def __init__(self, persistence_path: str = ".daacs_memory"):
        if not HAS_MEMORY_DEPS:
            logger.warning("Memory dependencies not installed. Install with: pip install chromadb sentence-transformers")
            self._initialized = False
            return
            
        if hasattr(self, "_initialized") and self._initialized:
            return
            
        self.persistence_path = os.path.abspath(persistence_path)
        logger.info(f"Initializing MemoryManager at {self.persistence_path}")
        
        try:
            self.client = chromadb.PersistentClient(path=self.persistence_path)
            
            # Create or get collections
            self.solution_collection = self.client.get_or_create_collection(
                name="daacs_solutions",
                metadata={"hnsw:space": "cosine"}
            )
            
            # Lazy load embedding model - only when first needed
            self._embedding_model = None
            self._initialized = True
            logger.info("MemoryManager initialized successfully (embedding model will load on first use).")
            
        except Exception as e:
            logger.error(f"Failed to initialize MemoryManager: {e}")
            self._initialized = False

    @property
    def embedding_model(self):
        """Lazy load SentenceTransformer only when needed."""
        if self._embedding_model is None:
            logger.info("Loading SentenceTransformer model (first use)...")
            self._embedding_model = SentenceTransformer('all-MiniLM-L6-v2')
        return self._embedding_model

    def _generate_embedding(self, text: str) -> List[float]:
        return self.embedding_model.encode(text).tolist()

    def add_memory(self, 
                   text: str, 
                   metadata: Dict[str, Any], 
                   memory_type: str = "solution") -> str:
        """
        Store a new memory.
        
        Args:
            text: The content to store (e.g., code snippet, error description)
            metadata: Context info (e.g., {'stack': 'react', 'success': True})
            memory_type: 'solution', 'error', 'pattern' (For future collection splitting)
            
        Returns:
            memory_id on success, empty string on failure
        """
        if not self._initialized:
            logger.warning("MemoryManager not initialized, skipping add_memory")
            return ""
            
        try:
            embedding = self._generate_embedding(text)
            memory_id = str(uuid.uuid4())
            
            # Ensure metadata values are strings, ints, floats, or bools for Chroma
            clean_metadata = {k: v for k, v in metadata.items() if isinstance(v, (str, int, float, bool))}
            clean_metadata["type"] = memory_type
            clean_metadata["timestamp"] = str(time.time())

            self.solution_collection.add(
                documents=[text],
                embeddings=[embedding],
                metadatas=[clean_metadata],
                ids=[memory_id]
            )
            logger.info(f"Stored memory ({memory_type}): {memory_id}")
            return memory_id
        except Exception as e:
            logger.error(f"Failed to add memory: {e}")
            return ""

    def search_memory(self, query: str, n_results: int = 3, filter_metadata: Dict = None) -> List[Dict]:
        """
        Retrieve relevant memories.
        """
        if not self._initialized:
            logger.warning("MemoryManager not initialized, skipping search_memory")
            return []
            
        try:
            query_embedding = self._generate_embedding(query)
            
            results = self.solution_collection.query(
                query_embeddings=[query_embedding],
                n_results=n_results,
                where=filter_metadata
            )
            
            parsed_results = []
            if results and results['documents']:
                for i in range(len(results['documents'][0])):
                    parsed_results.append({
                        "content": results['documents'][0][i],
                        "metadata": results['metadatas'][0][i],
                        "distance": results['distances'][0][i] if results['distances'] else 0.0,
                        "id": results['ids'][0][i]
                    })
            
            return parsed_results
        except Exception as e:
            logger.error(f"Failed to search memory: {e}")
            return []

    def reset_memory(self):
        """Clear all memories (Use with caution)"""
        if not self._initialized:
            return
            
        try:
            self.client.delete_collection("daacs_solutions")
            self.solution_collection = self.client.get_or_create_collection(
                name="daacs_solutions",
                metadata={"hnsw:space": "cosine"}
            )
            logger.warning("Memory reset complete.")
        except Exception as e:
            logger.error(f"Failed to reset memory: {e}")
