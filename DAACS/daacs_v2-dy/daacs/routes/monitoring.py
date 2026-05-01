from fastapi import APIRouter, HTTPException
from ..monitoring.token_tracker import TokenTracker

def init_monitoring_routes(ctx):
    router = APIRouter(prefix="/api/monitoring", tags=["monitoring"])
    tracker = TokenTracker.get_instance()

    @router.get("/usage")
    async def get_usage_summary():
        """Get current session token usage and cost"""
        return tracker.get_summary()

    @router.post("/reset")
    async def reset_usage_stats():
        """Reset usage statistics"""
        tracker.reset_stats()
        return {"status": "reset_completed"}

    return router
