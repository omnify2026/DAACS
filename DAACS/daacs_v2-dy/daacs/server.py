import os
import time
import logging
from contextlib import asynccontextmanager

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware

from .routes.analysis import init_analysis_routes
from .routes.git import init_git_routes
from .routes.projects import init_project_routes
from .routes.runtime import init_runtime_routes
from .routes.websocket import init_websocket_routes
from .routes.rfi_routes import init_rfi_routes
from .routes.feedback import init_feedback_routes  # 🆕 Feedback API
from .routes.monitoring import init_monitoring_routes  # 🆕 Monitoring API
from .routes.stream import init_stream_routes  # 🆕 Visualization API
from .server_context import build_server_context
from .server_state import load_existing_projects


@asynccontextmanager
async def lifespan(app: FastAPI):
    load_existing_projects()
    yield
    # Cleanup on shutdown
    from .server_state import nova_executor
    nova_executor.shutdown(wait=False)


app = FastAPI(title="DAACS API Server", lifespan=lifespan)

# CORS configuration from environment
allowed_origins = os.getenv("DAACS_CORS_ORIGINS", "*").split(",")
if allowed_origins == ["*"]:
    # Development mode - allow all
    app.add_middleware(
        CORSMiddleware,
        allow_origins=["*"],
        allow_credentials=True,
        allow_methods=["*"],
        allow_headers=["*"],
    )
else:
    # Production mode - restricted origins
    app.add_middleware(
        CORSMiddleware,
        allow_origins=allowed_origins,
        allow_credentials=True,
        allow_methods=["GET", "POST", "PUT", "DELETE", "OPTIONS"],
        allow_headers=["Content-Type", "Authorization"],
    )

# Route modules
ctx = build_server_context()
app.include_router(init_project_routes(ctx))
app.include_router(init_runtime_routes(ctx))
app.include_router(init_git_routes(ctx))
app.include_router(init_analysis_routes(ctx))
app.include_router(init_websocket_routes(ctx))
app.include_router(init_rfi_routes(ctx))
app.include_router(init_feedback_routes(ctx))
app.include_router(init_monitoring_routes(ctx))  # 🆕 Monitoring API
app.include_router(init_stream_routes(ctx))  # 🆕 Visualization API


@app.get("/health")
async def health_check():
    """Health check endpoint"""
    return {"status": "ok", "service": "daacs-orchestrator"}


if __name__ == "__main__":
    import uvicorn

    port = int(os.getenv("DAACS_PORT", os.getenv("PORT", "8001")))
    log_level = os.getenv("DAACS_LOG_LEVEL", "info").lower()
    access_log_interval = int(os.getenv("DAACS_ACCESS_LOG_INTERVAL_SEC", "60"))

    class _AccessLogRateLimitFilter(logging.Filter):
        def __init__(self, interval_sec: int) -> None:
            super().__init__()
            self.interval_sec = max(1, interval_sec)
            self._last_emit = 0.0

        def filter(self, record: logging.LogRecord) -> bool:
            now = time.monotonic()
            if now - self._last_emit >= self.interval_sec:
                self._last_emit = now
                return True
            return False

    access_logger = logging.getLogger("uvicorn.access")
    access_log_enabled = access_log_interval > 0
    if access_log_enabled:
        access_logger.addFilter(_AccessLogRateLimitFilter(access_log_interval))
    
    print(f"\n🚀 DAACS Server starting on http://0.0.0.0:{port}")
    print(f"   (Log level: {log_level}, Access Log: {'Enabled' if access_log_enabled else 'Disabled'})")

    # 🆕 Initialize ConfigLoader
    from .graph.config_loader import DAACSConfig
    config = DAACSConfig.get_instance()
    cli_config = config.get_cli_config()
    exec_config = config.get_execution_config()
    print(f"   (Config: CLI={cli_config['type']}, Execution={exec_config['max_iterations']} iterations)\n")
    
    uvicorn.run(
        app,
        host="0.0.0.0",
        port=port,
        log_config=None,
        log_level=log_level,
        access_log=access_log_enabled,
    )
