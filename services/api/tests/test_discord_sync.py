from __future__ import annotations

import importlib
import json
from typing import Any

import pytest
import pytest_asyncio


class FakeCtx:
    def __init__(self, db_pool, run_id: str = "wfr-test-discord-sync"):
        self._pool = db_pool
        self.run_id = run_id
        self.logs: list[tuple[str, dict[str, Any]]] = []

    def log(self, msg: str, **kwargs: Any) -> None:
        self.logs.append((msg, kwargs))


class FakeDiscordClient:
    def __init__(
        self,
        *,
        channels: list[dict[str, Any]] | None = None,
        active_threads: list[dict[str, Any]] | None = None,
        messages: dict[str, list[dict[str, Any]]] | None = None,
        archived_threads: dict[str, dict[str, Any]] | None = None,
    ) -> None:
        self.channels = channels or []
        self.active_threads = active_threads or []
        self.messages = messages or {}
        self.archived_threads = archived_threads or {}
        self.message_calls: list[dict[str, Any]] = []
        self.archived_calls: list[dict[str, Any]] = []

    def list_guild_channels(self, guild_id: str) -> list[dict[str, Any]]:
        return self.channels

    def list_active_threads(self, guild_id: str) -> list[dict[str, Any]]:
        return self.active_threads

    def list_public_archived_threads(
        self,
        channel_id: str,
        *,
        before: str | None = None,
        limit: int = 100,
    ) -> dict[str, Any]:
        self.archived_calls.append(
            {"channel_id": channel_id, "before": before, "limit": limit}
        )
        return self.archived_threads.get(channel_id, {"threads": [], "has_more": False})

    def get_messages_page(
        self,
        channel_id: str,
        *,
        limit: int = 100,
        before: str | None = None,
        after: str | None = None,
    ) -> list[dict[str, Any]]:
        self.message_calls.append(
            {"channel_id": channel_id, "limit": limit, "before": before, "after": after}
        )
        return self.messages.get(channel_id, [])


@pytest_asyncio.fixture(autouse=True)
async def _clear_discord_tables(db_pool, monkeypatch):
    monkeypatch.setenv("DISCORD_ETL_ENABLED", "true")
    monkeypatch.setenv("DISCORD_GUILD_ID", "guild-1")
    monkeypatch.setenv("DISCORD_ETL_TYPICAL_CATEGORY_MIN_COUNT", "1")
    monkeypatch.delenv("DISCORD_ETL_EXCLUDED_CHANNEL_IDS", raising=False)
    monkeypatch.delenv("DISCORD_ETL_EXCLUDED_CHANNEL_PATTERNS", raising=False)
    monkeypatch.delenv("DISCORD_ETL_EXCLUDED_CATEGORY_PATTERNS", raising=False)
    await db_pool.execute(
        "TRUNCATE TABLE discord_sync_backfill_jobs, discord_sync_checkpoints, "
        "discord_sync_messages, discord_sync_runs, discord_sync_users, "
        "discord_sync_channels CASCADE",
    )
    yield


def _category() -> dict[str, Any]:
    return {
        "id": "cat-1",
        "guild_id": "guild-1",
        "name": "Dapital",
        "type": 4,
        "permission_overwrites": [
            {"id": "role-team", "type": 0, "allow": "1024", "deny": "0"}
        ],
    }


def _text_channel(
    channel_id: str, name: str, overwrites: list[dict[str, str]]
) -> dict[str, Any]:
    return {
        "id": channel_id,
        "guild_id": "guild-1",
        "parent_id": "cat-1",
        "name": name,
        "type": 0,
        "permission_overwrites": overwrites,
    }


def _message(
    message_id: str, content: str, author_id: str = "user-1"
) -> dict[str, Any]:
    return {
        "id": message_id,
        "channel_id": "chan-good",
        "guild_id": "guild-1",
        "timestamp": "2026-05-20T12:00:00.000000+00:00",
        "type": 0,
        "content": content,
        "author": {
            "id": author_id,
            "username": f"user-{author_id}",
            "global_name": f"User {author_id}",
        },
        "mentions": [],
        "attachments": [],
        "embeds": [],
    }


def test_schedule_defaults_disabled(monkeypatch):
    monkeypatch.delenv("DISCORD_ETL_ENABLED", raising=False)
    monkeypatch.delenv("DISCORD_SYNC_INTERVAL_SECONDS", raising=False)

    from workflows import discord_sync

    reloaded = importlib.reload(discord_sync)

    assert reloaded.SCHEDULE == {
        "schedule_id": "discord_sync",
        "interval_seconds": 3600,
        "enabled": False,
        "no_delivery": True,
    }


def test_typical_category_signature_fails_closed_on_ambiguity():
    from workflows import discord_sync

    categories = {
        "cat-1": {
            "id": "cat-1",
            "type": 4,
            "permission_overwrites": [
                {"id": "role-team", "type": 0, "allow": "1024", "deny": "0"}
            ],
        },
        "cat-2": {
            "id": "cat-2",
            "type": 4,
            "permission_overwrites": [
                {"id": "role-admin", "type": 0, "allow": "1024", "deny": "0"}
            ],
        },
    }

    assert discord_sync._typical_category_signatures(categories, min_count=1) == set()


@pytest.mark.asyncio
async def test_sync_filters_custom_permission_channels_and_stores_recent_messages(
    db_pool,
    monkeypatch,
):
    from workflows import discord_sync

    inherited = _category()["permission_overwrites"]
    secret_overwrites = [{"id": "role-admin", "type": 0, "allow": "1024", "deny": "0"}]
    forum = {
        "id": "forum-1",
        "guild_id": "guild-1",
        "parent_id": "cat-1",
        "name": "warrunner",
        "type": 15,
        "permission_overwrites": inherited,
    }
    thread = {
        "id": "thread-1",
        "guild_id": "guild-1",
        "parent_id": "forum-1",
        "name": "Dapital roadmap",
        "type": 11,
        "thread_metadata": {"archived": False},
    }
    fake = FakeDiscordClient(
        channels=[
            _category(),
            _text_channel("chan-good", "general", inherited),
            _text_channel("chan-secret", "founders", secret_overwrites),
            forum,
        ],
        active_threads=[thread],
        messages={
            "chan-good": [_message("100000000000000001", "Dapital spot balances")],
            "thread-1": [_message("100000000000000002", "We are building Dapital")],
        },
    )
    monkeypatch.setattr(discord_sync, "shared_client", lambda: fake)

    result = await discord_sync.handler(discord_sync.Input(), FakeCtx(db_pool))

    assert result["status"] == "completed"
    assert result["channels_synced"] == 2
    assert result["channels_skipped"] == 1
    assert result["messages_fetched"] == 2
    assert result["messages_upserted"] == 2

    skipped = await db_pool.fetchrow(
        "SELECT is_syncable, exclusion_reason, raw_payload "
        "FROM discord_sync_channels WHERE channel_id = 'chan-secret'",
    )
    assert skipped["is_syncable"] is False
    assert skipped["exclusion_reason"] == "non_category_permissions"
    assert json.loads(skipped["raw_payload"])["parent_id"] == "cat-1"

    messages = await db_pool.fetch(
        "SELECT channel_id, thread_id, content FROM discord_sync_messages ORDER BY channel_id",
    )
    assert [
        (row["channel_id"], row["thread_id"], row["content"]) for row in messages
    ] == [
        ("chan-good", None, "Dapital spot balances"),
        ("thread-1", "thread-1", "We are building Dapital"),
    ]

    jobs = await db_pool.fetch(
        "SELECT job_type, channel_id, payload_json FROM discord_sync_backfill_jobs ORDER BY job_type, channel_id",
    )
    assert {row["job_type"] for row in jobs} == {"message_history", "thread_discovery"}


@pytest.mark.asyncio
async def test_incremental_sync_filters_locally_and_does_not_seed_short_history(
    db_pool,
    monkeypatch,
):
    from workflows import discord_sync

    inherited = _category()["permission_overwrites"]
    await db_pool.execute(
        "INSERT INTO discord_sync_channels (channel_id, guild_id, channel_name, channel_type, is_syncable) "
        "VALUES ('chan-good', 'guild-1', 'general', 0, TRUE)",
    )
    await db_pool.execute(
        "INSERT INTO discord_sync_checkpoints (channel_id, newest_message_id) "
        "VALUES ('chan-good', '100000000000000001')",
    )
    fake = FakeDiscordClient(
        channels=[
            _category(),
            _text_channel("chan-good", "general", inherited),
        ],
        messages={
            "chan-good": [_message("100000000000000002", "new Dapital context")],
        },
    )
    monkeypatch.setattr(discord_sync, "shared_client", lambda: fake)

    result = await discord_sync.handler(
        discord_sync.Input(pages_per_channel=3),
        FakeCtx(db_pool, run_id="wfr-test-discord-sync-incremental"),
    )

    assert result["status"] == "completed"
    assert fake.message_calls == [
        {
            "channel_id": "chan-good",
            "limit": 100,
            "before": None,
            "after": None,
        }
    ]
    jobs = await db_pool.fetch(
        "SELECT job_type FROM discord_sync_backfill_jobs WHERE channel_id = 'chan-good'",
    )
    assert {row["job_type"] for row in jobs} == {"thread_discovery"}


@pytest.mark.asyncio
async def test_backfill_message_history_requeues_when_page_is_full(
    db_pool, monkeypatch
):
    from workflows import discord_backfill

    await db_pool.execute(
        "INSERT INTO discord_sync_channels (channel_id, guild_id, channel_name, channel_type, is_syncable) "
        "VALUES ('chan-good', 'guild-1', 'general', 0, TRUE)",
    )
    await db_pool.execute(
        "INSERT INTO discord_sync_backfill_jobs ("
        "job_key, job_type, channel_id, payload_json, status"
        ") VALUES ("
        "'message_history:chan-good:200', 'message_history', 'chan-good', "
        '\'{"before_id":"200","guild_id":"guild-1","parent_channel_id":"","is_thread_channel":false}\'::jsonb, '
        "'pending'"
        ")",
    )
    fake = FakeDiscordClient(
        messages={
            "chan-good": [
                _message(str(100000000000000000 + index), f"message {index}")
                for index in range(100)
            ],
        }
    )
    monkeypatch.setattr(discord_backfill, "shared_client", lambda: fake)

    result = await discord_backfill.handler(
        discord_backfill.Input(channel_batch_limit=1, pages_per_job=1),
        FakeCtx(db_pool, run_id="wfr-test-discord-backfill"),
    )

    assert result["status"] == "completed"
    assert result["messages_fetched"] == 100
    assert result["messages_upserted"] == 100

    statuses = await db_pool.fetch(
        "SELECT job_key, status FROM discord_sync_backfill_jobs ORDER BY job_key",
    )
    assert statuses[0]["status"] == "completed"
    assert any(
        row["job_key"].startswith("message_history:chan-good:") for row in statuses[1:]
    )
