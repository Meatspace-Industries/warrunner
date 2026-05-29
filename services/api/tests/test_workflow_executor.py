from __future__ import annotations

import datetime as dt
import os

import pytest

os.environ.setdefault("DATABASE_URL", "postgresql://test:test@localhost/test")

from api import agent, workflow_executor


class FakePool:
    async def fetchrow(self, *_args, **_kwargs):
        return {
            "run_id": "wfr-test",
            "workflow_name": "echo",
            "input_json": {},
            "status": "running",
            "created_at": dt.datetime.now(dt.timezone.utc),
            "worker_id": "worker-test",
        }


@pytest.mark.asyncio
async def test_workflow_executor_installs_agent_pool_override(monkeypatch):
    pool = FakePool()
    observed: list[object] = []

    async def fake_create_pool(_database_url):
        return pool

    async def fake_close_pool(closed_pool):
        assert closed_pool is pool

    async def fake_run_handler(run_pool, _run_row):
        assert run_pool is pool
        observed.append(agent._get_pool())

    monkeypatch.setattr(workflow_executor, "create_pool", fake_create_pool)
    monkeypatch.setattr(workflow_executor, "close_pool", fake_close_pool)
    monkeypatch.setattr(workflow_executor, "discover_workflow_handlers", lambda: None)
    monkeypatch.setattr(workflow_executor, "_run_handler", fake_run_handler)

    assert await workflow_executor._run("wfr-test") == 0
    assert observed == [pool]
    assert agent._DB_POOL_OVERRIDE is None
