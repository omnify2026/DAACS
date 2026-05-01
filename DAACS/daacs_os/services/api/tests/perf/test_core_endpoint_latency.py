from __future__ import annotations

import statistics
import time

from fastapi.testclient import TestClient

from daacs.server import app


def test_health_endpoint_latency_budget():
    with TestClient(app) as client:
        t0 = time.perf_counter()
        res = client.get("/health")
        elapsed_ms = (time.perf_counter() - t0) * 1000
    assert res.status_code == 200
    assert elapsed_ms < 300


def test_health_endpoint_p95_latency_budget_under_small_burst():
    samples = []
    with TestClient(app) as client:
        for _ in range(20):
            t0 = time.perf_counter()
            res = client.get("/health")
            elapsed_ms = (time.perf_counter() - t0) * 1000
            assert res.status_code == 200
            samples.append(elapsed_ms)

    p95 = statistics.quantiles(samples, n=100, method="inclusive")[94]
    assert p95 < 300
