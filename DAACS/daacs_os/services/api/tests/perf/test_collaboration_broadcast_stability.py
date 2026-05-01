from __future__ import annotations

import asyncio

from daacs.routes.agents_ws import ConnectionManager


class _FakeWs:
    def __init__(self, fail_after: int | None = None):
        self.payloads = []
        self._fail_after = fail_after

    async def send_json(self, payload):
        if self._fail_after is not None and len(self.payloads) >= self._fail_after:
            raise RuntimeError("simulated send failure")
        self.payloads.append(payload)


class _Event:
    def model_dump(self):
        return {"type": "COLLAB_ARTIFACT_UPDATED", "agent_role": "pm", "data": {}, "timestamp": 0}


def test_collaboration_broadcast_stability_under_multiple_clients():
    async def _run():
        manager = ConnectionManager()
        clients = [_FakeWs() for _ in range(12)]
        for ws in clients:
            await manager.connect("p1", ws)

        for _ in range(25):
            await manager.broadcast_to_project("p1", _Event())

        assert manager.get_connection_count("p1") == 12
        assert all(len(c.payloads) == 25 for c in clients)

    asyncio.run(_run())


def test_collaboration_broadcast_is_project_scoped_and_drops_dead_connections():
    async def _run():
        manager = ConnectionManager()
        good = _FakeWs()
        flaky = _FakeWs(fail_after=1)
        other_project = _FakeWs()

        await manager.connect("project-a", good)
        await manager.connect("project-a", flaky)
        await manager.connect("project-b", other_project)

        await manager.broadcast_to_project("project-a", _Event())
        await manager.broadcast_to_project("project-a", _Event())

        # project-b must not receive project-a events
        assert len(other_project.payloads) == 0
        # flaky ws drops after first failure and is removed
        assert len(flaky.payloads) == 1
        assert manager.get_connection_count("project-a") == 1
        assert len(good.payloads) == 2

    asyncio.run(_run())
