from __future__ import annotations

import asyncio

from daacs.graph.nodes.planning import planning_node
from daacs.graph.nodes.verification import verification_node


def test_planning_node_derives_minimal_qa_defaults():
    result = asyncio.run(
        planning_node(
            state={"current_goal": "Build a small dashboard"},
            executor=None,
            manager=None,
        )
    )

    assert result["qa_profile"] == "ui"
    assert result["evidence_required"] == [
        "backend_files",
        "frontend_files",
        "python_json_syntax",
        "api_compliance",
    ]
    assert "GET /api/health is implemented" in result["acceptance_criteria"]
    assert "Frontend deliverables are present and non-empty" in result["acceptance_criteria"]


def test_verification_node_returns_evidence_gaps_and_confidence():
    state = {
        "backend_files": {
            "app.py": "\n".join(
                [
                    "from fastapi import FastAPI",
                    "from fastapi.middleware.cors import CORSMiddleware",
                    "",
                    "app = FastAPI()",
                    "app.add_middleware(CORSMiddleware, allow_origins=['*'])",
                    "",
                    "@app.get('/api/health')",
                    "async def health():",
                    "    return {'ok': True}",
                ]
            )
        },
        "frontend_files": {"package.json": "{}"},
        "api_spec": {
            "endpoints": [
                {"method": "GET", "path": "/api/health", "description": "Health check"},
            ]
        },
        "needs_backend": True,
        "needs_frontend": True,
        "qa_profile": "ui",
        "evidence_required": [
            "backend_files",
            "frontend_files",
            "python_json_syntax",
            "api_compliance",
        ],
    }

    result = asyncio.run(verification_node(state=state, executor=None, manager=None))

    assert result["verification_passed"] is True
    assert result["verification_gaps"] == []
    assert result["verification_confidence"] == 100
    assert {item["check"] for item in result["verification_evidence"]} >= {
        "backend_files",
        "frontend_files",
        "python_json_syntax",
        "api_compliance",
        "cors_check",
    }
