from types import SimpleNamespace
from unittest.mock import AsyncMock

import pytest

from api.sandbox.base import RuntimeState, SandboxSession


@pytest.mark.asyncio
async def test_get_or_spawn_respawns_stale_repo_scoped_session(monkeypatch) -> None:
    import api.agent as agent

    old = SandboxSession(
        sandbox_id="old-sandbox",
        thread_key="discord:guild:channel:thread",
        harness="codex",
        engine="codex",
        started_at=100.0,
        db_state="idle",
        repo="Meatspace-Industries/dappios",
    )
    new = SandboxSession(
        sandbox_id="new-sandbox",
        thread_key=old.thread_key,
        harness="codex",
        engine="codex",
        started_at=200.0,
        repo="Meatspace-Industries/dappios",
    )
    backend = SimpleNamespace(
        status=AsyncMock(return_value="running"),
        stop=AsyncMock(),
        create=AsyncMock(return_value=new),
        stop_by_id=AsyncMock(),
    )

    monkeypatch.setattr(agent, "GITHUB_APP_REPO_SESSION_MAX_AGE_S", 60)
    monkeypatch.setattr(agent, "GITHUB_APP_REPO_SESSION_REFRESH_MARGIN_S", 30)
    monkeypatch.setattr(agent.time, "time", lambda: 200.0)
    monkeypatch.setattr(agent, "_get_pool", lambda: object())
    monkeypatch.setattr(agent, "get_backend", lambda: backend)
    monkeypatch.setattr(agent, "_db_get_session", AsyncMock(return_value=old))
    monkeypatch.setattr(agent, "_db_delete_session", AsyncMock())
    monkeypatch.setattr(agent, "_db_insert_session", AsyncMock(return_value=True))
    monkeypatch.setattr(
        agent,
        "get_or_create_thread_trace_id",
        AsyncMock(return_value="00000000-0000-0000-0000-000000000123"),
    )
    monkeypatch.setattr(agent, "_evict_idle_sessions_for_capacity", AsyncMock())
    monkeypatch.setattr(
        agent,
        "_resolve_harness_profile",
        lambda *_args, **_kwargs: ("codex", None, None),
    )
    monkeypatch.setattr(agent, "_get_runtime", lambda _sandbox_id: RuntimeState())
    monkeypatch.setattr(agent, "_drop_runtime", lambda _sandbox_id: None)

    result = await agent.get_or_spawn(
        old.thread_key,
        "codex",
        engine="codex",
        repo="Meatspace-Industries/dappios",
    )

    assert result is new
    backend.stop.assert_awaited_once_with(old)
    backend.create.assert_awaited_once()
    assert backend.create.await_args.kwargs["repo"] == "Meatspace-Industries/dappios"


@pytest.mark.asyncio
async def test_get_or_spawn_respawns_repo_session_before_token_expiry(
    monkeypatch,
) -> None:
    import api.agent as agent

    old = SandboxSession(
        sandbox_id="old-sandbox",
        thread_key="discord:guild:channel:thread",
        harness="codex",
        engine="codex",
        started_at=100.0,
        db_state="idle",
        repo="Meatspace-Industries/dappios",
        github_token_expires_at=501.0,
    )
    new = SandboxSession(
        sandbox_id="new-sandbox",
        thread_key=old.thread_key,
        harness="codex",
        engine="codex",
        started_at=200.0,
        repo="Meatspace-Industries/dappios",
        github_token_expires_at=4_000.0,
    )
    backend = SimpleNamespace(
        status=AsyncMock(return_value="running"),
        stop=AsyncMock(),
        create=AsyncMock(return_value=new),
        stop_by_id=AsyncMock(),
    )

    monkeypatch.setattr(agent, "GITHUB_APP_REPO_SESSION_MAX_AGE_S", 2700)
    monkeypatch.setattr(agent, "GITHUB_APP_REPO_SESSION_REFRESH_MARGIN_S", 2700)
    monkeypatch.setattr(agent.time, "time", lambda: 200.0)
    monkeypatch.setattr(agent, "_get_pool", lambda: object())
    monkeypatch.setattr(agent, "get_backend", lambda: backend)
    monkeypatch.setattr(agent, "_db_get_session", AsyncMock(return_value=old))
    monkeypatch.setattr(agent, "_db_delete_session", AsyncMock())
    monkeypatch.setattr(agent, "_db_insert_session", AsyncMock(return_value=True))
    monkeypatch.setattr(
        agent,
        "get_or_create_thread_trace_id",
        AsyncMock(return_value="00000000-0000-0000-0000-000000000123"),
    )
    monkeypatch.setattr(agent, "_evict_idle_sessions_for_capacity", AsyncMock())
    monkeypatch.setattr(
        agent,
        "_resolve_harness_profile",
        lambda *_args, **_kwargs: ("codex", None, None),
    )
    monkeypatch.setattr(agent, "_get_runtime", lambda _sandbox_id: RuntimeState())
    monkeypatch.setattr(agent, "_drop_runtime", lambda _sandbox_id: None)

    result = await agent.get_or_spawn(
        old.thread_key,
        "codex",
        engine="codex",
        repo="Meatspace-Industries/dappios",
    )

    assert result is new
    backend.stop.assert_awaited_once_with(old)
    backend.create.assert_awaited_once()
