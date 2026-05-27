from __future__ import annotations

import importlib
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
        channel_details: dict[str, dict[str, Any]] | None = None,
        channel_errors: dict[str, Exception] | None = None,
        message_errors: dict[str, Exception] | None = None,
        archived_errors: dict[str, Exception] | None = None,
    ) -> None:
        self.channels = channels or []
        self.active_threads = active_threads or []
        self.messages = messages or {}
        self.archived_threads = archived_threads or {}
        self.channel_details = channel_details or {}
        self.channel_errors = channel_errors or {}
        self.message_errors = message_errors or {}
        self.archived_errors = archived_errors or {}
        self.channel_calls: list[str] = []
        self.message_calls: list[dict[str, Any]] = []
        self.archived_calls: list[dict[str, Any]] = []

    def list_guild_channels(self, guild_id: str) -> list[dict[str, Any]]:
        return self.channels

    def list_active_threads(self, guild_id: str) -> list[dict[str, Any]]:
        return self.active_threads

    def get_channel(self, channel_id: str) -> dict[str, Any]:
        self.channel_calls.append(channel_id)
        if channel_id in self.channel_errors:
            raise self.channel_errors[channel_id]
        if channel_id in self.channel_details:
            return self.channel_details[channel_id]
        for channel in self.channels:
            if str(channel.get("id") or "") == channel_id:
                return channel
        for thread in self.active_threads:
            if str(thread.get("id") or "") == channel_id:
                return thread
        for page in self.archived_threads.values():
            for thread in page.get("threads", []):
                if str(thread.get("id") or "") == channel_id:
                    return thread
        if channel_id in self.messages:
            return {
                "id": channel_id,
                "guild_id": "guild-1",
                "name": channel_id,
                "type": 11 if channel_id.startswith("thread") else 0,
            }
        return {}

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
        if channel_id in self.archived_errors:
            raise self.archived_errors[channel_id]
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
        if channel_id in self.message_errors:
            raise self.message_errors[channel_id]
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
        "TRUNCATE TABLE company_context_documents, discord_sync_backfill_jobs, "
        "discord_sync_checkpoints, "
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


def _message_with_thread(
    message_id: str,
    content: str,
    *,
    thread_id: str,
    thread_name: str,
    parent_id: str = "chan-good",
    thread_type: int = 11,
) -> dict[str, Any]:
    message = _message(message_id, content)
    message["thread"] = {
        "id": thread_id,
        "guild_id": "guild-1",
        "parent_id": parent_id,
        "name": thread_name,
        "type": thread_type,
        "thread_metadata": {"archived": False},
    }
    return message


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
        "SELECT channel_id FROM discord_sync_channels WHERE channel_id = 'chan-secret'",
    )
    assert skipped is None

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
async def test_sync_excludes_active_threads_by_channel_pattern(
    db_pool,
    monkeypatch,
):
    from workflows import discord_sync

    monkeypatch.setenv("DISCORD_ETL_EXCLUDED_CHANNEL_PATTERNS", "*legal*,*bank*")
    inherited = _category()["permission_overwrites"]
    forum = {
        "id": "forum-1",
        "guild_id": "guild-1",
        "parent_id": "cat-1",
        "name": "warrunner",
        "type": 15,
        "permission_overwrites": inherited,
    }
    public_thread = {
        "id": "thread-public",
        "guild_id": "guild-1",
        "parent_id": "forum-1",
        "name": "Dapital roadmap",
        "type": 11,
        "thread_metadata": {"archived": False},
    }
    sensitive_thread = {
        "id": "thread-sensitive",
        "guild_id": "guild-1",
        "parent_id": "forum-1",
        "name": "Legal and bank setup",
        "type": 11,
        "thread_metadata": {"archived": False},
    }
    fake = FakeDiscordClient(
        channels=[_category(), forum],
        active_threads=[public_thread, sensitive_thread],
        messages={
            "thread-public": [_message("100000000000000010", "Dapital roadmap")],
            "thread-sensitive": [
                _message("100000000000000011", "should not be stored")
            ],
        },
    )
    monkeypatch.setattr(discord_sync, "shared_client", lambda: fake)

    result = await discord_sync.handler(discord_sync.Input(), FakeCtx(db_pool))

    assert result["status"] == "completed"
    assert result["channels_synced"] == 1
    assert result["channels_skipped"] == 1
    assert result["messages_upserted"] == 1

    sensitive = await db_pool.fetchrow(
        "SELECT channel_id FROM discord_sync_channels WHERE channel_id = 'thread-sensitive'",
    )
    assert sensitive is None

    stored = await db_pool.fetch(
        "SELECT channel_id, content FROM discord_sync_messages ORDER BY channel_id",
    )
    assert [(row["channel_id"], row["content"]) for row in stored] == [
        ("thread-public", "Dapital roadmap")
    ]


@pytest.mark.asyncio
async def test_sync_skips_parent_starter_message_for_excluded_thread(
    db_pool,
    monkeypatch,
):
    from workflows import discord_sync

    monkeypatch.setenv("DISCORD_ETL_EXCLUDED_CHANNEL_PATTERNS", "*legal*")
    inherited = _category()["permission_overwrites"]
    sensitive_thread = {
        "id": "thread-sensitive",
        "guild_id": "guild-1",
        "parent_id": "chan-good",
        "name": "Legal review",
        "type": 11,
        "thread_metadata": {"archived": False},
    }
    fake = FakeDiscordClient(
        channels=[
            _category(),
            _text_channel("chan-good", "general", inherited),
        ],
        active_threads=[sensitive_thread],
        messages={
            "chan-good": [
                _message_with_thread(
                    "100000000000000015",
                    "legal starter content should not be stored",
                    thread_id="thread-sensitive",
                    thread_name="Legal review",
                )
            ],
        },
    )
    monkeypatch.setattr(discord_sync, "shared_client", lambda: fake)

    result = await discord_sync.handler(discord_sync.Input(), FakeCtx(db_pool))

    assert result["status"] == "completed"
    assert result["messages_upserted"] == 0
    assert (
        await db_pool.fetchval("SELECT COUNT(*)::int FROM discord_sync_messages") == 0
    )
    assert (
        await db_pool.fetchrow(
            "SELECT channel_id FROM discord_sync_channels WHERE channel_id = 'thread-sensitive'",
        )
        is None
    )


@pytest.mark.asyncio
async def test_sync_purges_channel_when_recent_message_fetch_forbidden(
    db_pool,
    monkeypatch,
):
    from workflows import discord_sync
    from workflows.discord_sync_shared import DiscordApiError

    inherited = _category()["permission_overwrites"]
    fake = FakeDiscordClient(
        channels=[
            _category(),
            _text_channel("chan-good", "general", inherited),
        ],
        message_errors={
            "chan-good": DiscordApiError(
                403, "GET", "/channels/chan-good/messages", ""
            ),
        },
    )
    monkeypatch.setattr(discord_sync, "shared_client", lambda: fake)

    result = await discord_sync.handler(discord_sync.Input(), FakeCtx(db_pool))

    assert result["status"] == "completed"
    assert result["channels_failed"] == 0
    assert result["channels_skipped"] == 1
    assert (
        await db_pool.fetchrow(
            "SELECT channel_id FROM discord_sync_channels WHERE channel_id = 'chan-good'",
        )
        is None
    )


@pytest.mark.asyncio
async def test_sync_purges_out_of_scope_category_metadata(
    db_pool,
    monkeypatch,
):
    from workflows import discord_sync

    monkeypatch.setenv("DISCORD_ETL_ALLOWED_CATEGORY_IDS", "cat-1")
    inherited = _category()["permission_overwrites"]
    other_category = {
        "id": "cat-other",
        "guild_id": "guild-1",
        "name": "Board pipeline",
        "type": 4,
        "permission_overwrites": inherited,
    }
    other_channel = {
        "id": "chan-other",
        "guild_id": "guild-1",
        "parent_id": "cat-other",
        "name": "strategy",
        "type": 0,
        "permission_overwrites": inherited,
    }
    await db_pool.execute(
        "INSERT INTO discord_sync_channels ("
        "channel_id, guild_id, channel_name, channel_type, is_category, is_syncable"
        ") VALUES ('cat-other', 'guild-1', 'Board pipeline', 4, TRUE, FALSE)",
    )
    await db_pool.execute(
        "INSERT INTO discord_sync_channels ("
        "channel_id, guild_id, parent_id, channel_name, channel_type, is_syncable"
        ") VALUES ('chan-other', 'guild-1', 'cat-other', 'strategy', 0, TRUE)",
    )
    await db_pool.execute(
        "INSERT INTO discord_sync_messages (channel_id, message_id, guild_id, content) "
        "VALUES ('chan-other', '100000000000000012', 'guild-1', 'old private context')",
    )
    fake = FakeDiscordClient(
        channels=[
            _category(),
            other_category,
            _text_channel("chan-good", "general", inherited),
            other_channel,
        ],
        messages={
            "chan-good": [_message("100000000000000013", "Dapital public context")],
            "chan-other": [_message("100000000000000014", "should not be stored")],
        },
    )
    monkeypatch.setattr(discord_sync, "shared_client", lambda: fake)

    result = await discord_sync.handler(discord_sync.Input(), FakeCtx(db_pool))

    assert result["status"] == "completed"
    assert result["messages_upserted"] == 1
    assert (
        await db_pool.fetchrow(
            "SELECT channel_id FROM discord_sync_channels "
            "WHERE channel_id IN ('cat-other', 'chan-other')",
        )
        is None
    )
    assert (
        await db_pool.fetchval(
            "SELECT COUNT(*)::int FROM discord_sync_messages WHERE channel_id = 'chan-other'",
        )
        == 0
    )


@pytest.mark.asyncio
async def test_sync_purges_legacy_skipped_channel_metadata_even_when_absent(
    db_pool,
    monkeypatch,
):
    from workflows import discord_sync

    inherited = _category()["permission_overwrites"]
    await db_pool.execute(
        "INSERT INTO discord_sync_channels ("
        "channel_id, guild_id, parent_id, channel_name, channel_type, is_syncable, "
        "exclusion_reason, raw_payload"
        ") VALUES ("
        "'chan-legacy-secret', 'guild-1', 'cat-legacy', 'Legal archive', 0, FALSE, "
        "'non_category_permissions', "
        '\'{"id":"chan-legacy-secret","name":"Legal archive"}\'::jsonb'
        ")",
    )
    await db_pool.execute(
        "INSERT INTO discord_sync_messages (channel_id, message_id, guild_id, content) "
        "VALUES ('chan-legacy-secret', '100000000000000016', 'guild-1', 'old sensitive context')",
    )
    await db_pool.execute(
        "INSERT INTO company_context_documents ("
        "document_id, source, source_type, source_document_id, title, body, metadata"
        ") VALUES ("
        "'discord:legacy-secret', 'discord', 'discord_channel_day', "
        "'chan-legacy-secret:2026-05-20', 'Legal archive', 'old sensitive context', "
        '\'{"channel_id":"chan-legacy-secret"}\'::jsonb'
        ")",
    )
    fake = FakeDiscordClient(
        channels=[
            _category(),
            _text_channel("chan-good", "general", inherited),
        ],
        messages={
            "chan-good": [_message("100000000000000017", "Dapital public context")],
        },
    )
    monkeypatch.setattr(discord_sync, "shared_client", lambda: fake)

    result = await discord_sync.handler(discord_sync.Input(), FakeCtx(db_pool))

    assert result["status"] == "completed"
    assert result["messages_upserted"] == 1
    assert (
        await db_pool.fetchrow(
            "SELECT channel_id FROM discord_sync_channels WHERE channel_id = 'chan-legacy-secret'",
        )
        is None
    )
    assert (
        await db_pool.fetchval(
            "SELECT COUNT(*)::int FROM discord_sync_messages WHERE channel_id = 'chan-legacy-secret'",
        )
        == 0
    )
    assert (
        await db_pool.fetchval(
            "SELECT COUNT(*)::int FROM company_context_documents "
            "WHERE metadata->>'channel_id' = 'chan-legacy-secret'",
        )
        == 0
    )


@pytest.mark.asyncio
async def test_purge_thread_scope_deletes_parent_channel_day_document(db_pool):
    from workflows.discord_sync_shared import purge_channels_from_sync_scope

    await db_pool.execute(
        "INSERT INTO discord_sync_channels (channel_id, guild_id, channel_name, channel_type, is_syncable) "
        "VALUES ('chan-good', 'guild-1', 'general', 0, TRUE)",
    )
    await db_pool.execute(
        "INSERT INTO discord_sync_channels ("
        "channel_id, guild_id, parent_id, channel_name, channel_type, is_thread, is_syncable"
        ") VALUES ('thread-sensitive', 'guild-1', 'chan-good', 'Legal review', 11, TRUE, TRUE)",
    )
    await db_pool.execute(
        "INSERT INTO discord_sync_messages ("
        "channel_id, message_id, guild_id, thread_id, occurred_at, content"
        ") VALUES ("
        "'chan-good', '100000000000000018', 'guild-1', 'thread-sensitive', "
        "'2026-05-20T12:00:00+00:00'::timestamptz, 'sensitive starter content'"
        ")",
    )
    await db_pool.execute(
        "INSERT INTO company_context_documents ("
        "document_id, source, source_type, source_document_id, title, body, metadata"
        ") VALUES ("
        "'discord:channel_day:chan-good:2026-05-20', 'discord', 'discord_channel_day', "
        "'chan-good:2026-05-20', '#general - 2026-05-20', 'sensitive starter content', "
        '\'{"channel_id":"chan-good","date":"2026-05-20","aggregation":"channel_day"}\'::jsonb'
        ")",
    )

    result = await purge_channels_from_sync_scope(
        db_pool,
        ["thread-sensitive"],
        delete_channel_rows=True,
    )

    assert result["documents_deleted"] == 1
    assert result["messages_deleted"] == 1
    assert (
        await db_pool.fetchval("SELECT COUNT(*)::int FROM discord_sync_messages") == 0
    )
    assert (
        await db_pool.fetchval(
            "SELECT COUNT(*)::int FROM company_context_documents "
            "WHERE source_type = 'discord_channel_day'",
        )
        == 0
    )


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


@pytest.mark.asyncio
async def test_backfill_excludes_archived_threads_by_channel_pattern(
    db_pool,
    monkeypatch,
):
    from workflows import discord_backfill

    monkeypatch.setenv("DISCORD_ETL_EXCLUDED_CHANNEL_PATTERNS", "*legal*")
    await db_pool.execute(
        "INSERT INTO discord_sync_channels (channel_id, guild_id, channel_name, channel_type, is_syncable) "
        "VALUES ('forum-1', 'guild-1', 'warrunner', 15, TRUE)",
    )
    await db_pool.execute(
        "INSERT INTO discord_sync_backfill_jobs ("
        "job_key, job_type, channel_id, payload_json, status"
        ") VALUES ("
        "'thread_discovery:forum-1:', 'thread_discovery', 'forum-1', "
        '\'{"guild_id":"guild-1","limit":100}\'::jsonb, '
        "'pending'"
        ")",
    )
    fake = FakeDiscordClient(
        archived_threads={
            "forum-1": {
                "threads": [
                    {
                        "id": "thread-public",
                        "guild_id": "guild-1",
                        "parent_id": "forum-1",
                        "name": "Dapital roadmap",
                        "type": 11,
                        "thread_metadata": {
                            "archived": True,
                            "archive_timestamp": "2026-05-20T12:00:00.000000+00:00",
                        },
                    },
                    {
                        "id": "thread-sensitive",
                        "guild_id": "guild-1",
                        "parent_id": "forum-1",
                        "name": "Legal review",
                        "type": 11,
                        "thread_metadata": {
                            "archived": True,
                            "archive_timestamp": "2026-05-19T12:00:00.000000+00:00",
                        },
                    },
                ],
                "has_more": False,
            }
        }
    )
    monkeypatch.setattr(discord_backfill, "shared_client", lambda: fake)

    result = await discord_backfill.handler(
        discord_backfill.Input(channel_batch_limit=1),
        FakeCtx(db_pool, run_id="wfr-test-discord-backfill-threads"),
    )

    assert result["status"] == "completed"
    assert result["threads_fetched"] == 2
    assert result["threads_upserted"] == 1

    sensitive = await db_pool.fetchrow(
        "SELECT channel_id FROM discord_sync_channels WHERE channel_id = 'thread-sensitive'",
    )
    assert sensitive is None

    jobs = await db_pool.fetch(
        "SELECT job_key, channel_id FROM discord_sync_backfill_jobs ORDER BY job_key",
    )
    assert [(row["job_key"], row["channel_id"]) for row in jobs] == [
        ("message_history:thread-public:", "thread-public"),
        ("thread_discovery:forum-1:", "forum-1"),
    ]


@pytest.mark.asyncio
async def test_backfill_thread_discovery_skips_fresh_excluded_category_chain(
    db_pool,
    monkeypatch,
):
    from workflows import discord_backfill

    monkeypatch.setenv("DISCORD_ETL_EXCLUDED_CATEGORY_PATTERNS", "*legal*")
    await db_pool.execute(
        "INSERT INTO discord_sync_channels ("
        "channel_id, guild_id, channel_name, channel_type, is_category, is_syncable"
        ") VALUES ('cat-safe', 'guild-1', 'Dapital', 4, TRUE, FALSE)",
    )
    await db_pool.execute(
        "INSERT INTO discord_sync_channels ("
        "channel_id, guild_id, parent_id, channel_name, channel_type, is_syncable"
        ") VALUES ('forum-1', 'guild-1', 'cat-safe', 'warrunner', 15, TRUE)",
    )
    await db_pool.execute(
        "INSERT INTO discord_sync_backfill_jobs ("
        "job_key, job_type, channel_id, payload_json, status"
        ") VALUES ("
        "'thread_discovery:forum-1:', 'thread_discovery', 'forum-1', "
        '\'{"guild_id":"guild-1","limit":100}\'::jsonb, '
        "'pending'"
        ")",
    )
    fake = FakeDiscordClient(
        archived_threads={
            "forum-1": {
                "threads": [
                    {
                        "id": "thread-sensitive",
                        "guild_id": "guild-1",
                        "parent_id": "forum-1",
                        "name": "Dapital roadmap",
                        "type": 11,
                    }
                ],
                "has_more": False,
            }
        },
        channel_details={
            "forum-1": {
                "id": "forum-1",
                "guild_id": "guild-1",
                "parent_id": "cat-legal",
                "name": "warrunner",
                "type": 15,
            },
            "cat-legal": {
                "id": "cat-legal",
                "guild_id": "guild-1",
                "name": "Legal",
                "type": 4,
            },
        },
    )
    monkeypatch.setattr(discord_backfill, "shared_client", lambda: fake)

    result = await discord_backfill.handler(
        discord_backfill.Input(channel_batch_limit=1),
        FakeCtx(db_pool, run_id="wfr-test-discord-backfill-fresh-category"),
    )

    assert result["status"] == "completed"
    assert result["threads_fetched"] == 0
    assert fake.channel_calls == ["forum-1", "cat-legal"]
    assert fake.archived_calls == []
    assert (
        await db_pool.fetchrow(
            "SELECT channel_id FROM discord_sync_channels WHERE channel_id = 'forum-1'",
        )
        is None
    )


@pytest.mark.asyncio
async def test_backfill_thread_discovery_purges_when_archived_fetch_forbidden(
    db_pool,
    monkeypatch,
):
    from workflows import discord_backfill
    from workflows.discord_sync_shared import DiscordApiError

    await db_pool.execute(
        "INSERT INTO discord_sync_channels (channel_id, guild_id, channel_name, channel_type, is_syncable) "
        "VALUES ('forum-1', 'guild-1', 'warrunner', 15, TRUE)",
    )
    await db_pool.execute(
        "INSERT INTO discord_sync_backfill_jobs ("
        "job_key, job_type, channel_id, payload_json, status"
        ") VALUES ("
        "'thread_discovery:forum-1:', 'thread_discovery', 'forum-1', "
        '\'{"guild_id":"guild-1","limit":100}\'::jsonb, '
        "'pending'"
        ")",
    )
    fake = FakeDiscordClient(
        channel_details={
            "forum-1": {
                "id": "forum-1",
                "guild_id": "guild-1",
                "name": "warrunner",
                "type": 15,
            },
        },
        archived_errors={
            "forum-1": DiscordApiError(
                403, "GET", "/channels/forum-1/threads/archived/public", ""
            ),
        },
    )
    monkeypatch.setattr(discord_backfill, "shared_client", lambda: fake)

    result = await discord_backfill.handler(
        discord_backfill.Input(channel_batch_limit=1),
        FakeCtx(db_pool, run_id="wfr-test-discord-backfill-archive-403"),
    )

    assert result["status"] == "completed"
    assert result["threads_fetched"] == 0
    assert fake.archived_calls == [
        {"channel_id": "forum-1", "before": None, "limit": 100}
    ]
    assert (
        await db_pool.fetchrow(
            "SELECT channel_id FROM discord_sync_channels WHERE channel_id = 'forum-1'",
        )
        is None
    )


@pytest.mark.asyncio
async def test_backfill_audits_stored_archived_threads_even_without_pending_jobs(
    db_pool,
    monkeypatch,
):
    from workflows import discord_backfill

    monkeypatch.setenv("DISCORD_ETL_EXCLUDED_CHANNEL_PATTERNS", "*legal*")
    await db_pool.execute(
        "INSERT INTO discord_sync_channels (channel_id, guild_id, channel_name, channel_type, is_syncable) "
        "VALUES ('forum-1', 'guild-1', 'warrunner', 15, TRUE)",
    )
    await db_pool.execute(
        "INSERT INTO discord_sync_channels ("
        "channel_id, guild_id, parent_id, channel_name, channel_type, is_thread, is_archived, is_syncable"
        ") VALUES ('thread-old', 'guild-1', 'forum-1', 'Roadmap', 11, TRUE, TRUE, TRUE)",
    )
    await db_pool.execute(
        "INSERT INTO discord_sync_messages ("
        "channel_id, message_id, guild_id, thread_id, occurred_at, content"
        ") VALUES ("
        "'thread-old', '100000000000000027', 'guild-1', 'thread-old', "
        "'2026-05-20T12:00:00+00:00'::timestamptz, 'old sensitive context'"
        ")",
    )
    await db_pool.execute(
        "INSERT INTO company_context_documents ("
        "document_id, source, source_type, source_document_id, title, body, metadata"
        ") VALUES ("
        "'discord:thread:thread-old', 'discord', 'discord_thread', "
        "'thread-old', 'Roadmap', 'old sensitive context', "
        '\'{"thread_id":"thread-old","aggregation":"thread"}\'::jsonb'
        ")",
    )
    fake = FakeDiscordClient(
        channel_details={
            "thread-old": {
                "id": "thread-old",
                "guild_id": "guild-1",
                "parent_id": "forum-1",
                "name": "Legal review",
                "type": 11,
            },
        },
    )
    monkeypatch.setattr(discord_backfill, "shared_client", lambda: fake)

    result = await discord_backfill.handler(
        discord_backfill.Input(channel_batch_limit=1),
        FakeCtx(db_pool, run_id="wfr-test-discord-backfill-audit-old-thread"),
    )

    assert result["status"] == "skipped"
    assert result["reason"] == "no_pending_backfills"
    assert result["threads_audited"] == 1
    assert result["threads_purged"] == 1
    assert fake.channel_calls == ["thread-old"]
    assert (
        await db_pool.fetchrow(
            "SELECT channel_id FROM discord_sync_channels WHERE channel_id = 'thread-old'",
        )
        is None
    )
    assert (
        await db_pool.fetchval("SELECT COUNT(*)::int FROM discord_sync_messages") == 0
    )
    assert (
        await db_pool.fetchval(
            "SELECT COUNT(*)::int FROM company_context_documents",
        )
        == 0
    )


@pytest.mark.asyncio
async def test_backfill_stored_thread_audit_is_bounded(db_pool, monkeypatch):
    from workflows import discord_backfill

    monkeypatch.setenv("DISCORD_ETL_EXCLUDED_CHANNEL_PATTERNS", "*legal*")
    monkeypatch.setenv("DISCORD_BACKFILL_AUDIT_THREAD_LIMIT", "1")
    await db_pool.execute(
        "INSERT INTO discord_sync_channels (channel_id, guild_id, channel_name, channel_type, is_syncable) "
        "VALUES ('forum-1', 'guild-1', 'warrunner', 15, TRUE)",
    )
    for thread_id in ("thread-a", "thread-b"):
        await db_pool.execute(
            "INSERT INTO discord_sync_channels ("
            "channel_id, guild_id, parent_id, channel_name, channel_type, is_thread, is_archived, is_syncable"
            ") VALUES ($1, 'guild-1', 'forum-1', 'Roadmap', 11, TRUE, TRUE, TRUE)",
            thread_id,
        )
    fake = FakeDiscordClient(
        channel_details={
            "thread-a": {
                "id": "thread-a",
                "guild_id": "guild-1",
                "parent_id": "forum-1",
                "name": "Legal review A",
                "type": 11,
            },
            "thread-b": {
                "id": "thread-b",
                "guild_id": "guild-1",
                "parent_id": "forum-1",
                "name": "Legal review B",
                "type": 11,
            },
        },
    )
    monkeypatch.setattr(discord_backfill, "shared_client", lambda: fake)

    result = await discord_backfill.handler(
        discord_backfill.Input(channel_batch_limit=1),
        FakeCtx(db_pool, run_id="wfr-test-discord-backfill-audit-limit"),
    )

    assert result["status"] == "skipped"
    assert result["threads_audited"] == 1
    assert result["threads_purged"] == 1
    assert fake.channel_calls == ["thread-a"]
    remaining = await db_pool.fetch(
        "SELECT channel_id FROM discord_sync_channels WHERE is_thread = TRUE ORDER BY channel_id",
    )
    assert [row["channel_id"] for row in remaining] == ["thread-b"]


@pytest.mark.asyncio
async def test_backfill_message_history_excludes_thread_by_ancestor_category_pattern(
    db_pool,
    monkeypatch,
):
    from workflows import discord_backfill

    monkeypatch.setenv("DISCORD_ETL_EXCLUDED_CATEGORY_PATTERNS", "*legal*")
    await db_pool.execute(
        "INSERT INTO discord_sync_channels ("
        "channel_id, guild_id, channel_name, channel_type, is_category, is_syncable"
        ") VALUES ('cat-legal', 'guild-1', 'Legal', 4, TRUE, FALSE)",
    )
    await db_pool.execute(
        "INSERT INTO discord_sync_channels ("
        "channel_id, guild_id, parent_id, channel_name, channel_type, is_syncable"
        ") VALUES ('forum-1', 'guild-1', 'cat-legal', 'warrunner', 15, TRUE)",
    )
    await db_pool.execute(
        "INSERT INTO discord_sync_channels ("
        "channel_id, guild_id, parent_id, channel_name, channel_type, is_thread, is_syncable"
        ") VALUES ('thread-sensitive', 'guild-1', 'forum-1', 'Dapital roadmap', 11, TRUE, TRUE)",
    )
    await db_pool.execute(
        "INSERT INTO discord_sync_backfill_jobs ("
        "job_key, job_type, channel_id, payload_json, status"
        ") VALUES ("
        "'message_history:thread-sensitive:', 'message_history', 'thread-sensitive', "
        '\'{"guild_id":"guild-1","parent_channel_id":"forum-1","is_thread_channel":true}\'::jsonb, '
        "'pending'"
        ")",
    )
    fake = FakeDiscordClient(
        messages={
            "thread-sensitive": [
                _message("100000000000000020", "should never be fetched")
            ]
        }
    )
    monkeypatch.setattr(discord_backfill, "shared_client", lambda: fake)

    result = await discord_backfill.handler(
        discord_backfill.Input(channel_batch_limit=1),
        FakeCtx(db_pool, run_id="wfr-test-discord-backfill-ancestor-category"),
    )

    assert result["status"] == "completed"
    assert result["messages_fetched"] == 0
    assert fake.message_calls == []
    assert (
        await db_pool.fetchval("SELECT COUNT(*)::int FROM discord_sync_messages") == 0
    )
    assert (
        await db_pool.fetchrow(
            "SELECT channel_id FROM discord_sync_channels "
            "WHERE channel_id IN ('cat-legal', 'forum-1', 'thread-sensitive')",
        )
        is None
    )


@pytest.mark.asyncio
async def test_backfill_skips_parent_starter_message_for_excluded_thread(
    db_pool,
    monkeypatch,
):
    from workflows import discord_backfill

    monkeypatch.setenv("DISCORD_ETL_EXCLUDED_CHANNEL_PATTERNS", "*legal*")
    await db_pool.execute(
        "INSERT INTO discord_sync_channels (channel_id, guild_id, channel_name, channel_type, is_syncable) "
        "VALUES ('chan-good', 'guild-1', 'general', 0, TRUE)",
    )
    await db_pool.execute(
        "INSERT INTO discord_sync_channels ("
        "channel_id, guild_id, parent_id, channel_name, channel_type, is_thread, is_syncable"
        ") VALUES ('thread-sensitive', 'guild-1', 'chan-good', 'Legal review', 11, TRUE, TRUE)",
    )
    await db_pool.execute(
        "INSERT INTO discord_sync_backfill_jobs ("
        "job_key, job_type, channel_id, payload_json, status"
        ") VALUES ("
        "'message_history:chan-good:', 'message_history', 'chan-good', "
        '\'{"guild_id":"guild-1","parent_channel_id":"","is_thread_channel":false}\'::jsonb, '
        "'pending'"
        ")",
    )
    fake = FakeDiscordClient(
        messages={
            "chan-good": [
                _message_with_thread(
                    "100000000000000021",
                    "legal starter content should not be stored",
                    thread_id="thread-sensitive",
                    thread_name="Legal review",
                )
            ],
        }
    )
    monkeypatch.setattr(discord_backfill, "shared_client", lambda: fake)

    result = await discord_backfill.handler(
        discord_backfill.Input(channel_batch_limit=1),
        FakeCtx(db_pool, run_id="wfr-test-discord-backfill-parent-starter"),
    )

    assert result["status"] == "completed"
    assert result["messages_upserted"] == 0
    assert (
        await db_pool.fetchval("SELECT COUNT(*)::int FROM discord_sync_messages") == 0
    )
    assert (
        await db_pool.fetchrow(
            "SELECT channel_id FROM discord_sync_channels WHERE channel_id = 'thread-sensitive'",
        )
        is None
    )


@pytest.mark.asyncio
async def test_backfill_skips_parent_starter_message_for_private_thread(
    db_pool,
    monkeypatch,
):
    from workflows import discord_backfill

    await db_pool.execute(
        "INSERT INTO discord_sync_channels (channel_id, guild_id, channel_name, channel_type, is_syncable) "
        "VALUES ('chan-good', 'guild-1', 'general', 0, TRUE)",
    )
    await db_pool.execute(
        "INSERT INTO discord_sync_channels ("
        "channel_id, guild_id, parent_id, channel_name, channel_type, is_thread, is_syncable"
        ") VALUES ('thread-private', 'guild-1', 'chan-good', 'Private thread', 12, TRUE, TRUE)",
    )
    await db_pool.execute(
        "INSERT INTO discord_sync_backfill_jobs ("
        "job_key, job_type, channel_id, payload_json, status"
        ") VALUES ("
        "'message_history:chan-good:', 'message_history', 'chan-good', "
        '\'{"guild_id":"guild-1","parent_channel_id":"","is_thread_channel":false}\'::jsonb, '
        "'pending'"
        ")",
    )
    fake = FakeDiscordClient(
        messages={
            "chan-good": [
                _message_with_thread(
                    "100000000000000023",
                    "private starter content should not be stored",
                    thread_id="thread-private",
                    thread_name="Private thread",
                    thread_type=12,
                )
            ],
        }
    )
    monkeypatch.setattr(discord_backfill, "shared_client", lambda: fake)

    result = await discord_backfill.handler(
        discord_backfill.Input(channel_batch_limit=1),
        FakeCtx(db_pool, run_id="wfr-test-discord-backfill-private-thread"),
    )

    assert result["status"] == "completed"
    assert result["messages_upserted"] == 0
    assert (
        await db_pool.fetchval("SELECT COUNT(*)::int FROM discord_sync_messages") == 0
    )
    assert (
        await db_pool.fetchrow(
            "SELECT channel_id FROM discord_sync_channels WHERE channel_id = 'thread-private'",
        )
        is None
    )


@pytest.mark.asyncio
async def test_backfill_skips_direct_private_thread_history_job(
    db_pool,
    monkeypatch,
):
    from workflows import discord_backfill

    await db_pool.execute(
        "INSERT INTO discord_sync_channels (channel_id, guild_id, channel_name, channel_type, is_syncable) "
        "VALUES ('chan-good', 'guild-1', 'general', 0, TRUE)",
    )
    await db_pool.execute(
        "INSERT INTO discord_sync_channels ("
        "channel_id, guild_id, parent_id, channel_name, channel_type, is_thread, is_syncable"
        ") VALUES ('thread-private', 'guild-1', 'chan-good', 'Private thread', 12, TRUE, TRUE)",
    )
    await db_pool.execute(
        "INSERT INTO discord_sync_backfill_jobs ("
        "job_key, job_type, channel_id, payload_json, status"
        ") VALUES ("
        "'message_history:thread-private:', 'message_history', 'thread-private', "
        '\'{"guild_id":"guild-1","parent_channel_id":"chan-good","is_thread_channel":true}\'::jsonb, '
        "'pending'"
        ")",
    )
    fake = FakeDiscordClient(
        messages={
            "thread-private": [
                _message("100000000000000024", "private content should not be fetched")
            ],
        }
    )
    monkeypatch.setattr(discord_backfill, "shared_client", lambda: fake)

    result = await discord_backfill.handler(
        discord_backfill.Input(channel_batch_limit=1),
        FakeCtx(db_pool, run_id="wfr-test-discord-backfill-direct-private-thread"),
    )

    assert result["status"] == "completed"
    assert result["messages_upserted"] == 0
    assert fake.message_calls == []
    assert (
        await db_pool.fetchval("SELECT COUNT(*)::int FROM discord_sync_messages") == 0
    )
    assert (
        await db_pool.fetchrow(
            "SELECT channel_id FROM discord_sync_channels WHERE channel_id = 'thread-private'",
        )
        is None
    )


@pytest.mark.asyncio
async def test_backfill_skips_direct_thread_history_after_fresh_sensitive_rename(
    db_pool,
    monkeypatch,
):
    from workflows import discord_backfill

    monkeypatch.setenv("DISCORD_ETL_EXCLUDED_CHANNEL_PATTERNS", "*legal*")
    await db_pool.execute(
        "INSERT INTO discord_sync_channels (channel_id, guild_id, channel_name, channel_type, is_syncable) "
        "VALUES ('chan-good', 'guild-1', 'general', 0, TRUE)",
    )
    await db_pool.execute(
        "INSERT INTO discord_sync_channels ("
        "channel_id, guild_id, parent_id, channel_name, channel_type, is_thread, is_syncable"
        ") VALUES ('thread-renamed', 'guild-1', 'chan-good', 'Roadmap', 11, TRUE, TRUE)",
    )
    await db_pool.execute(
        "INSERT INTO discord_sync_backfill_jobs ("
        "job_key, job_type, channel_id, payload_json, status"
        ") VALUES ("
        "'message_history:thread-renamed:', 'message_history', 'thread-renamed', "
        '\'{"guild_id":"guild-1","parent_channel_id":"chan-good","is_thread_channel":true}\'::jsonb, '
        "'pending'"
        ")",
    )
    fake = FakeDiscordClient(
        messages={
            "thread-renamed": [
                _message("100000000000000025", "renamed content should not be fetched")
            ],
        },
        channel_details={
            "thread-renamed": {
                "id": "thread-renamed",
                "guild_id": "guild-1",
                "parent_id": "chan-good",
                "name": "Legal review",
                "type": 11,
            },
        },
    )
    monkeypatch.setattr(discord_backfill, "shared_client", lambda: fake)

    result = await discord_backfill.handler(
        discord_backfill.Input(channel_batch_limit=1),
        FakeCtx(db_pool, run_id="wfr-test-discord-backfill-direct-renamed-thread"),
    )

    assert result["status"] == "completed"
    assert result["messages_upserted"] == 0
    assert fake.channel_calls == ["thread-renamed"]
    assert fake.message_calls == []
    assert (
        await db_pool.fetchval("SELECT COUNT(*)::int FROM discord_sync_messages") == 0
    )
    assert (
        await db_pool.fetchrow(
            "SELECT channel_id FROM discord_sync_channels WHERE channel_id = 'thread-renamed'",
        )
        is None
    )


@pytest.mark.asyncio
async def test_backfill_skips_direct_thread_history_after_fresh_parent_category_rename(
    db_pool,
    monkeypatch,
):
    from workflows import discord_backfill

    monkeypatch.setenv("DISCORD_ETL_EXCLUDED_CATEGORY_PATTERNS", "*legal*")
    await db_pool.execute(
        "INSERT INTO discord_sync_channels ("
        "channel_id, guild_id, channel_name, channel_type, is_category, is_syncable"
        ") VALUES ('cat-safe', 'guild-1', 'Dapital', 4, TRUE, FALSE)",
    )
    await db_pool.execute(
        "INSERT INTO discord_sync_channels ("
        "channel_id, guild_id, parent_id, channel_name, channel_type, is_syncable"
        ") VALUES ('forum-1', 'guild-1', 'cat-safe', 'warrunner', 15, TRUE)",
    )
    await db_pool.execute(
        "INSERT INTO discord_sync_channels ("
        "channel_id, guild_id, parent_id, channel_name, channel_type, is_thread, is_syncable"
        ") VALUES ('thread-roadmap', 'guild-1', 'forum-1', 'Roadmap', 11, TRUE, TRUE)",
    )
    await db_pool.execute(
        "INSERT INTO discord_sync_backfill_jobs ("
        "job_key, job_type, channel_id, payload_json, status"
        ") VALUES ("
        "'message_history:thread-roadmap:', 'message_history', 'thread-roadmap', "
        '\'{"guild_id":"guild-1","parent_channel_id":"forum-1","is_thread_channel":true}\'::jsonb, '
        "'pending'"
        ")",
    )
    fake = FakeDiscordClient(
        messages={
            "thread-roadmap": [
                _message(
                    "100000000000000026",
                    "parent category content should not be fetched",
                )
            ],
        },
        channel_details={
            "thread-roadmap": {
                "id": "thread-roadmap",
                "guild_id": "guild-1",
                "parent_id": "forum-1",
                "name": "Roadmap",
                "type": 11,
            },
            "forum-1": {
                "id": "forum-1",
                "guild_id": "guild-1",
                "parent_id": "cat-legal",
                "name": "warrunner",
                "type": 15,
            },
            "cat-legal": {
                "id": "cat-legal",
                "guild_id": "guild-1",
                "name": "Legal",
                "type": 4,
            },
        },
    )
    monkeypatch.setattr(discord_backfill, "shared_client", lambda: fake)

    result = await discord_backfill.handler(
        discord_backfill.Input(channel_batch_limit=1),
        FakeCtx(db_pool, run_id="wfr-test-discord-backfill-direct-parent-category"),
    )

    assert result["status"] == "completed"
    assert result["messages_upserted"] == 0
    assert fake.channel_calls == ["thread-roadmap", "forum-1", "cat-legal"]
    assert fake.message_calls == []
    assert (
        await db_pool.fetchval("SELECT COUNT(*)::int FROM discord_sync_messages") == 0
    )
    assert (
        await db_pool.fetchrow(
            "SELECT channel_id FROM discord_sync_channels WHERE channel_id = 'thread-roadmap'",
        )
        is None
    )


@pytest.mark.asyncio
async def test_backfill_skips_direct_thread_history_when_parent_leaves_scope(
    db_pool,
    monkeypatch,
):
    from workflows import discord_backfill

    category_overwrites = [{"id": "role-team", "type": 0, "allow": "1024", "deny": "0"}]
    custom_overwrites = [{"id": "role-admin", "type": 0, "allow": "2048", "deny": "0"}]
    await db_pool.execute(
        "INSERT INTO discord_sync_channels ("
        "channel_id, guild_id, channel_name, channel_type, is_category, is_syncable"
        ") VALUES ('cat-1', 'guild-1', 'Dapital', 4, TRUE, FALSE)",
    )
    await db_pool.execute(
        "INSERT INTO discord_sync_channels ("
        "channel_id, guild_id, parent_id, channel_name, channel_type, is_syncable"
        ") VALUES ('forum-1', 'guild-1', 'cat-1', 'warrunner', 15, TRUE)",
    )
    await db_pool.execute(
        "INSERT INTO discord_sync_channels ("
        "channel_id, guild_id, parent_id, channel_name, channel_type, is_thread, is_syncable"
        ") VALUES ('thread-roadmap', 'guild-1', 'forum-1', 'Roadmap', 11, TRUE, TRUE)",
    )
    await db_pool.execute(
        "INSERT INTO discord_sync_backfill_jobs ("
        "job_key, job_type, channel_id, payload_json, status"
        ") VALUES ("
        "'message_history:thread-roadmap:', 'message_history', 'thread-roadmap', "
        '\'{"guild_id":"guild-1","parent_channel_id":"forum-1","is_thread_channel":true}\'::jsonb, '
        "'pending'"
        ")",
    )
    fake = FakeDiscordClient(
        channels=[
            {
                "id": "cat-1",
                "guild_id": "guild-1",
                "name": "Dapital",
                "type": 4,
                "permission_overwrites": category_overwrites,
            },
            {
                "id": "forum-1",
                "guild_id": "guild-1",
                "parent_id": "cat-1",
                "name": "warrunner",
                "type": 15,
                "permission_overwrites": custom_overwrites,
            },
        ],
        messages={
            "thread-roadmap": [
                _message(
                    "100000000000000028",
                    "parent custom-permission content should not be fetched",
                )
            ],
        },
        channel_details={
            "thread-roadmap": {
                "id": "thread-roadmap",
                "guild_id": "guild-1",
                "parent_id": "forum-1",
                "name": "Roadmap",
                "type": 11,
            },
        },
    )
    monkeypatch.setattr(discord_backfill, "shared_client", lambda: fake)

    result = await discord_backfill.handler(
        discord_backfill.Input(channel_batch_limit=1),
        FakeCtx(db_pool, run_id="wfr-test-discord-backfill-parent-out-of-scope"),
    )

    assert result["status"] == "completed"
    assert result["messages_upserted"] == 0
    assert fake.message_calls == []
    assert (
        await db_pool.fetchrow(
            "SELECT channel_id FROM discord_sync_channels WHERE channel_id = 'thread-roadmap'",
        )
        is None
    )


@pytest.mark.asyncio
async def test_backfill_skips_renamed_embedded_thread_even_when_stored_syncable(
    db_pool,
    monkeypatch,
):
    from workflows import discord_backfill

    monkeypatch.setenv("DISCORD_ETL_EXCLUDED_CHANNEL_PATTERNS", "*legal*")
    await db_pool.execute(
        "INSERT INTO discord_sync_channels (channel_id, guild_id, channel_name, channel_type, is_syncable) "
        "VALUES ('chan-good', 'guild-1', 'general', 0, TRUE)",
    )
    await db_pool.execute(
        "INSERT INTO discord_sync_channels ("
        "channel_id, guild_id, parent_id, channel_name, channel_type, is_thread, is_syncable"
        ") VALUES ('thread-renamed', 'guild-1', 'chan-good', 'Roadmap', 11, TRUE, TRUE)",
    )
    await db_pool.execute(
        "INSERT INTO discord_sync_backfill_jobs ("
        "job_key, job_type, channel_id, payload_json, status"
        ") VALUES ("
        "'message_history:chan-good:', 'message_history', 'chan-good', "
        '\'{"guild_id":"guild-1","parent_channel_id":"","is_thread_channel":false}\'::jsonb, '
        "'pending'"
        ")",
    )
    fake = FakeDiscordClient(
        messages={
            "chan-good": [
                _message_with_thread(
                    "100000000000000022",
                    "renamed sensitive starter content should not be stored",
                    thread_id="thread-renamed",
                    thread_name="Legal review",
                )
            ],
        }
    )
    monkeypatch.setattr(discord_backfill, "shared_client", lambda: fake)

    result = await discord_backfill.handler(
        discord_backfill.Input(channel_batch_limit=1),
        FakeCtx(db_pool, run_id="wfr-test-discord-backfill-renamed-thread"),
    )

    assert result["status"] == "completed"
    assert result["messages_upserted"] == 0
    assert (
        await db_pool.fetchval("SELECT COUNT(*)::int FROM discord_sync_messages") == 0
    )
    assert (
        await db_pool.fetchrow(
            "SELECT channel_id FROM discord_sync_channels WHERE channel_id = 'thread-renamed'",
        )
        is None
    )


@pytest.mark.asyncio
async def test_backfill_advances_cursor_after_filtered_parent_starter_page(
    db_pool,
    monkeypatch,
):
    from workflows import discord_backfill

    monkeypatch.setenv("DISCORD_ETL_EXCLUDED_CHANNEL_PATTERNS", "*legal*")
    await db_pool.execute(
        "INSERT INTO discord_sync_channels (channel_id, guild_id, channel_name, channel_type, is_syncable) "
        "VALUES ('chan-good', 'guild-1', 'general', 0, TRUE)",
    )
    await db_pool.execute(
        "INSERT INTO discord_sync_channels ("
        "channel_id, guild_id, parent_id, channel_name, channel_type, is_thread, is_syncable"
        ") VALUES ('thread-sensitive', 'guild-1', 'chan-good', 'Legal review', 11, TRUE, TRUE)",
    )
    await db_pool.execute(
        "INSERT INTO discord_sync_backfill_jobs ("
        "job_key, job_type, channel_id, payload_json, status"
        ") VALUES ("
        "'message_history:chan-good:', 'message_history', 'chan-good', "
        '\'{"guild_id":"guild-1","parent_channel_id":"","is_thread_channel":false}\'::jsonb, '
        "'pending'"
        ")",
    )

    class PaginatedFake(FakeDiscordClient):
        def get_messages_page(
            self,
            channel_id: str,
            *,
            limit: int = 100,
            before: str | None = None,
            after: str | None = None,
        ) -> list[dict[str, Any]]:
            self.message_calls.append(
                {
                    "channel_id": channel_id,
                    "limit": limit,
                    "before": before,
                    "after": after,
                }
            )
            if before is None:
                return [
                    _message_with_thread(
                        "100000000000000030",
                        "filtered starter",
                        thread_id="thread-sensitive",
                        thread_name="Legal review",
                    )
                ]
            if before == "100000000000000030":
                return [_message("100000000000000029", "older in-scope message")]
            return []

    fake = PaginatedFake()
    monkeypatch.setattr(discord_backfill, "shared_client", lambda: fake)

    result = await discord_backfill.handler(
        discord_backfill.Input(channel_batch_limit=1, pages_per_job=2, limit=1),
        FakeCtx(db_pool, run_id="wfr-test-discord-backfill-filter-cursor"),
    )

    assert result["status"] == "completed"
    assert result["messages_upserted"] == 1
    assert fake.message_calls == [
        {
            "channel_id": "chan-good",
            "limit": 1,
            "before": None,
            "after": None,
        },
        {
            "channel_id": "chan-good",
            "limit": 1,
            "before": "100000000000000030",
            "after": None,
        },
    ]
    assert (
        await db_pool.fetchval(
            "SELECT content FROM discord_sync_messages WHERE channel_id = 'chan-good'",
        )
        == "older in-scope message"
    )
