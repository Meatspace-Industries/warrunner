from __future__ import annotations

import datetime as dt
import importlib
import json
from typing import Any

import pytest
import pytest_asyncio


class FakeCtx:
    def __init__(self, db_pool, run_id: str = "wfr-test-discord-context-documents"):
        self._pool = db_pool
        self.run_id = run_id
        self.logs: list[tuple[str, dict[str, Any]]] = []

    def log(self, msg: str, **kwargs: Any) -> None:
        self.logs.append((msg, kwargs))


@pytest_asyncio.fixture(autouse=True)
async def _clear_context_tables(db_pool, monkeypatch):
    monkeypatch.setenv("DISCORD_ETL_ENABLED", "true")
    await db_pool.execute(
        "TRUNCATE TABLE company_context_documents, discord_sync_backfill_jobs, "
        "discord_sync_checkpoints, discord_sync_messages, discord_sync_runs, "
        "discord_sync_users, discord_sync_channels, workflow_runs CASCADE",
    )
    yield


def test_schedule_defaults_disabled(monkeypatch):
    monkeypatch.delenv("DISCORD_ETL_ENABLED", raising=False)
    monkeypatch.delenv("DISCORD_CONTEXT_DOCUMENTS_ENABLED", raising=False)
    monkeypatch.delenv("DISCORD_CONTEXT_DOCUMENTS_INTERVAL_SECONDS", raising=False)

    from workflows import discord_context_documents

    reloaded = importlib.reload(discord_context_documents)

    assert reloaded.SCHEDULE == {
        "schedule_id": "discord_context_documents",
        "interval_seconds": 14400,
        "enabled": False,
        "no_delivery": True,
    }


async def _seed_discord_basics(db_pool) -> None:
    await db_pool.execute(
        "INSERT INTO discord_sync_channels ("
        "channel_id, guild_id, parent_id, channel_name, channel_type, is_thread, is_syncable"
        ") VALUES "
        "('chan-general', 'guild-1', '', 'general', 0, FALSE, TRUE), "
        "('forum-dapital', 'guild-1', '', 'dapital', 15, FALSE, TRUE), "
        "('thread-roadmap', 'guild-1', 'forum-dapital', 'Dapital roadmap', 11, TRUE, TRUE)",
    )
    await db_pool.execute(
        "INSERT INTO discord_sync_users (user_id, username, global_name, display_name) "
        "VALUES "
        "('1001', 'alice', 'Alice Example', 'Alice'), "
        "('1002', 'bob', 'Bob Example', 'Bob')",
    )


async def _insert_discord_message(
    db_pool,
    *,
    channel_id: str,
    message_id: str,
    occurred_at: dt.datetime,
    updated_at: dt.datetime,
    author_id: str,
    content: str,
    thread_id: str | None = None,
    parent_channel_id: str = "",
) -> None:
    await db_pool.execute(
        "INSERT INTO discord_sync_messages ("
        "channel_id, message_id, guild_id, parent_channel_id, thread_id, occurred_at, "
        "author_id, content, attachment_count, embed_count, raw_payload, updated_at, last_seen_at"
        ") VALUES ("
        "$1, $2, 'guild-1', $3, $4, $5, $6, $7, 0, 0, '{}'::jsonb, $8, $8"
        ")",
        channel_id,
        message_id,
        parent_channel_id,
        thread_id,
        occurred_at,
        author_id,
        content,
        updated_at,
    )


@pytest.mark.asyncio
async def test_projects_discord_channel_day_and_thread_documents(db_pool):
    from workflows import discord_context_documents

    await _seed_discord_basics(db_pool)
    base = dt.datetime(2026, 5, 20, 12, 0, tzinfo=dt.timezone.utc)
    updated = dt.datetime(2026, 5, 20, 12, 30, tzinfo=dt.timezone.utc)
    await _insert_discord_message(
        db_pool,
        channel_id="chan-general",
        message_id="msg-1",
        occurred_at=base,
        updated_at=updated,
        author_id="1001",
        content="Dapital needs reliable spot balance indexing for <@1002>",
    )
    await _insert_discord_message(
        db_pool,
        channel_id="thread-roadmap",
        message_id="msg-2",
        occurred_at=base + dt.timedelta(minutes=1),
        updated_at=updated + dt.timedelta(seconds=1),
        author_id="1001",
        content="Roadmap: Discord-first Warrunner should know Dapital context",
        thread_id="thread-roadmap",
        parent_channel_id="forum-dapital",
    )
    await _insert_discord_message(
        db_pool,
        channel_id="thread-roadmap",
        message_id="msg-3",
        occurred_at=base + dt.timedelta(minutes=2),
        updated_at=updated + dt.timedelta(seconds=2),
        author_id="1002",
        content="Decision: index forum threads into company_context_documents",
        thread_id="thread-roadmap",
        parent_channel_id="forum-dapital",
    )

    result = await discord_context_documents.handler(
        discord_context_documents.Input(watermark_overlap_seconds=0),
        FakeCtx(db_pool),
    )

    assert result["status"] == "completed"
    assert result["changed_messages"] == 3
    assert result["documents_upserted"] == 2
    assert result["channel_day_documents"] == 1
    assert result["thread_candidates"] == 1

    rows = await db_pool.fetch(
        "SELECT document_id, source_type, title, body, author_name, metadata "
        "FROM company_context_documents ORDER BY source_type",
    )
    assert [row["source_type"] for row in rows] == [
        "discord_channel_day",
        "discord_thread",
    ]
    channel_day = rows[0]
    assert channel_day["document_id"] == "discord:channel_day:chan-general:2026-05-20"
    assert channel_day["title"] == "#general - 2026-05-20"
    assert "@Bob" in channel_day["body"]
    assert json.loads(channel_day["metadata"])["aggregation"] == "channel_day"

    thread = rows[1]
    assert thread["document_id"] == "discord:thread:thread-roadmap"
    assert thread["title"] == "Dapital roadmap"
    assert thread["author_name"] == "Alice"
    assert "Parent channel: #dapital" in thread["body"]
    assert "Participants: Alice, Bob" in thread["body"]
    assert json.loads(thread["metadata"])["aggregation"] == "thread"
