"""Workflow: sync recent Discord history into Postgres."""

from __future__ import annotations

import asyncio
import fnmatch
import os
from dataclasses import dataclass, field
from typing import Any

from api.vm_metrics import (
    record_etl_items_enqueued,
    record_etl_items_failed,
    record_etl_items_seen,
    record_etl_items_upserted,
)
from api.workflow_engine import WorkflowContext
from workflows.discord_sync_shared import (
    BACKFILL_JOB_MESSAGE_HISTORY,
    BACKFILL_JOB_THREAD_DISCOVERY,
    DISCORD_CHANNEL_GUILD_CATEGORY,
    DISCORD_CHANNEL_PRIVATE_THREAD,
    DiscordApiError,
    MESSAGE_CONTAINER_TYPES,
    SYNCABLE_PARENT_TYPES,
    THREAD_PARENT_TYPES,
    THREAD_TYPES,
    bounded_discord_limit,
    channel_ref,
    channel_row,
    client as shared_client,
    embedded_thread_id,
    enqueue_backfill_job,
    env_flag_enabled,
    failure_reason,
    load_checkpoint,
    message_row,
    newest_snowflake,
    oldest_snowflake,
    permission_signature,
    positive_int,
    purge_channels_from_sync_scope,
    record_run_finish,
    record_run_start,
    snowflake_int,
    stale_syncable_channel_ids,
    update_checkpoint_failure,
    update_checkpoint_success,
    upsert_channels,
    upsert_messages,
    upsert_users,
    users_from_messages,
    workflow_run_id_to_sync_run_id,
)

WORKFLOW_NAME = "discord_sync"

DEFAULT_SYNC_INTERVAL_SECONDS = 3_600
DEFAULT_RECENT_LIMIT = 100
DEFAULT_PAGES_PER_CHANNEL = 2
DEFAULT_THREAD_DISCOVERY_LIMIT = 100
DEFAULT_TYPICAL_CATEGORY_MIN_COUNT = 2
PERMISSION_MODE_CATEGORY_DEFAULT = "category_default"
PERMISSION_MODE_ALL_VISIBLE = "all_visible"


SCHEDULE = {
    "schedule_id": "discord_sync",
    "interval_seconds": positive_int(
        os.getenv("DISCORD_SYNC_INTERVAL_SECONDS"),
        DEFAULT_SYNC_INTERVAL_SECONDS,
    ),
    "enabled": env_flag_enabled("DISCORD_ETL_ENABLED", default=False),
    "no_delivery": True,
}


@dataclass
class Input:
    """Runtime options for a manual Discord sync workflow run."""

    guild_id: str | None = None
    limit: int | None = None
    pages_per_channel: int | None = None
    thread_discovery_limit: int | None = None
    metadata: dict[str, Any] = field(default_factory=dict)


def _guild_id(inp: Input) -> str:
    guild_id = (inp.guild_id or os.getenv("DISCORD_GUILD_ID") or "").strip()
    if not guild_id:
        raise RuntimeError("DISCORD_GUILD_ID is required for Discord ETL")
    return guild_id


def _csv_set(value: str | None) -> set[str]:
    if not value:
        return set()
    return {item.strip() for item in value.split(",") if item.strip()}


def _glob_patterns(value: str | None) -> list[str]:
    if not value:
        return []
    return [item.strip().lower() for item in value.split(",") if item.strip()]


def _channel_name(channel: dict[str, Any]) -> str:
    return str(channel.get("name") or "").strip().lower()


def _pattern_match(name: str, patterns: list[str]) -> str | None:
    for pattern in patterns:
        if fnmatch.fnmatchcase(name, pattern):
            return pattern
    return None


def _category_name(
    channel: dict[str, Any],
    categories_by_id: dict[str, dict[str, Any]],
) -> str:
    parent_id = str(channel.get("parent_id") or "")
    category = categories_by_id.get(parent_id)
    return _channel_name(category or {})


def _category_allowed_by_config(
    category: dict[str, Any],
    *,
    allowed_category_ids: set[str],
    allowed_category_patterns: list[str],
) -> bool:
    category_id = str(category.get("id") or "")
    return category_id in allowed_category_ids or bool(
        _pattern_match(_channel_name(category), allowed_category_patterns)
    )


def _configured_category_allowlist_enabled(
    *,
    allowed_category_ids: set[str],
    allowed_category_patterns: list[str],
) -> bool:
    return bool(allowed_category_ids or allowed_category_patterns)


def _typical_category_signatures(
    categories_by_id: dict[str, dict[str, Any]],
    *,
    min_count: int,
) -> set[str]:
    counts: dict[str, int] = {}
    for category in categories_by_id.values():
        signature = permission_signature(category)
        counts[signature] = counts.get(signature, 0) + 1
    if not counts:
        return set()
    max_count = max(counts.values())
    if max_count < min_count:
        return set()
    if len(counts) == 1:
        return set(counts)
    winners = {signature for signature, count in counts.items() if count == max_count}
    return winners if len(winners) == 1 else set()


def _inherits_category_permissions(
    channel: dict[str, Any],
    categories_by_id: dict[str, dict[str, Any]],
) -> bool:
    parent_id = str(channel.get("parent_id") or "")
    channel_signature = permission_signature(channel)
    if not parent_id:
        return channel_signature == "[]"
    category = categories_by_id.get(parent_id)
    if not category:
        return False
    return channel_signature == permission_signature(category)


def _channel_exclusion_reason(
    channel: dict[str, Any],
    *,
    categories_by_id: dict[str, dict[str, Any]],
    excluded_ids: set[str],
    excluded_channel_patterns: list[str],
    excluded_category_patterns: list[str],
    allowed_category_ids: set[str],
    allowed_category_patterns: list[str],
    typical_category_signatures: set[str],
    permission_mode: str,
) -> str | None:
    channel_id = str(channel.get("id") or "")
    channel_type = int(channel.get("type") or 0)
    parent_id = str(channel.get("parent_id") or "")
    if channel_type not in SYNCABLE_PARENT_TYPES:
        return "unsupported_channel_type"
    if channel_id in excluded_ids:
        return "excluded_by_id"
    if parent_id in excluded_ids:
        return "excluded_by_category_id"
    pattern = _pattern_match(_channel_name(channel), excluded_channel_patterns)
    if pattern:
        return f"excluded_by_channel_pattern:{pattern}"
    category_pattern = _pattern_match(
        _category_name(channel, categories_by_id),
        excluded_category_patterns,
    )
    if category_pattern:
        return f"excluded_by_category_pattern:{category_pattern}"
    if bool(channel.get("nsfw")):
        return "excluded_nsfw"
    if permission_mode == PERMISSION_MODE_ALL_VISIBLE:
        return None

    if not parent_id:
        return "no_parent_category"
    category = categories_by_id.get(parent_id)
    if not category:
        return "missing_parent_category"
    if not _inherits_category_permissions(channel, categories_by_id):
        return "non_category_permissions"
    if _configured_category_allowlist_enabled(
        allowed_category_ids=allowed_category_ids,
        allowed_category_patterns=allowed_category_patterns,
    ):
        if not _category_allowed_by_config(
            category,
            allowed_category_ids=allowed_category_ids,
            allowed_category_patterns=allowed_category_patterns,
        ):
            return "non_allowed_category"
    elif permission_signature(category) not in typical_category_signatures:
        return "non_typical_category_permissions"
    return None


def _thread_exclusion_reason(
    thread: dict[str, Any],
    *,
    excluded_ids: set[str],
    excluded_channel_patterns: list[str],
) -> str | None:
    thread_id = str(thread.get("id") or "")
    parent_id = str(thread.get("parent_id") or "")
    if int(thread.get("type") or 0) == DISCORD_CHANNEL_PRIVATE_THREAD:
        return "excluded_private_thread"
    if thread_id in excluded_ids:
        return "excluded_by_id"
    if parent_id in excluded_ids:
        return "excluded_by_parent_id"
    pattern = _pattern_match(_channel_name(thread), excluded_channel_patterns)
    if pattern:
        return f"excluded_by_channel_pattern:{pattern}"
    return None


def _redacted_channel_ref(channel: dict[str, Any], reason: str) -> dict[str, str]:
    return {
        "channel_id": str(channel.get("id") or ""),
        "channel_name": "",
        "reason": reason,
    }


async def _syncable_embedded_thread_ids(pool, thread_ids: set[str]) -> set[str]:
    if not thread_ids:
        return set()
    rows = await pool.fetch(
        "SELECT channel_id FROM discord_sync_channels "
        "WHERE channel_id = ANY($1::text[]) AND is_syncable = TRUE",
        sorted(thread_ids),
    )
    return {str(row["channel_id"]) for row in rows}


async def _filter_messages_for_sync_scope(
    pool,
    messages: list[dict[str, Any]],
    *,
    is_thread_channel: bool,
    guild_id: str,
    excluded_ids: set[str],
    excluded_channel_patterns: list[str],
) -> list[dict[str, Any]]:
    if is_thread_channel or not messages:
        return messages

    allowed_thread_ids = await _syncable_embedded_thread_ids(
        pool,
        {
            embedded_thread_id(message)
            for message in messages
            if embedded_thread_id(message)
        },
    )
    kept: list[dict[str, Any]] = []
    purge_thread_ids: list[str] = []
    for message in messages:
        thread = (
            message.get("thread") if isinstance(message.get("thread"), dict) else {}
        )
        thread_id = str(thread.get("id") or "")
        if not thread_id:
            kept.append(message)
            continue
        thread_for_exclusion = {
            **thread,
            "guild_id": thread.get("guild_id") or guild_id,
        }
        reason = _thread_exclusion_reason(
            thread_for_exclusion,
            excluded_ids=excluded_ids,
            excluded_channel_patterns=excluded_channel_patterns,
        )
        if reason:
            purge_thread_ids.append(thread_id)
            continue
        if thread_id not in allowed_thread_ids:
            continue
        kept.append(message)

    if purge_thread_ids:
        await purge_channels_from_sync_scope(
            pool,
            purge_thread_ids,
            delete_channel_rows=True,
        )
    return kept


async def _stored_excluded_thread_ids(
    pool,
    *,
    guild_id: str,
    excluded_ids: set[str],
    excluded_channel_patterns: list[str],
) -> list[str]:
    rows = await pool.fetch(
        "SELECT channel_id, parent_id, channel_name, channel_type "
        "FROM discord_sync_channels "
        "WHERE guild_id = $1 AND is_thread = TRUE AND is_syncable = TRUE",
        guild_id,
    )
    excluded: list[str] = []
    for row in rows:
        channel_id = str(row["channel_id"] or "")
        reason = _thread_exclusion_reason(
            {
                "id": channel_id,
                "parent_id": str(row["parent_id"] or ""),
                "name": str(row["channel_name"] or ""),
                "type": int(row["channel_type"] or 0),
            },
            excluded_ids=excluded_ids,
            excluded_channel_patterns=excluded_channel_patterns,
        )
        if reason:
            excluded.append(channel_id)
    return excluded


def _split_syncable_channels(
    channels: list[dict[str, Any]],
    *,
    categories_by_id: dict[str, dict[str, Any]],
    excluded_ids: set[str],
    excluded_channel_patterns: list[str],
    excluded_category_patterns: list[str],
    allowed_category_ids: set[str],
    allowed_category_patterns: list[str],
    typical_category_signatures: set[str],
    permission_mode: str,
) -> tuple[list[dict[str, Any]], list[tuple[dict[str, Any], str]]]:
    syncable: list[dict[str, Any]] = []
    skipped: list[tuple[dict[str, Any], str]] = []
    for channel in channels:
        reason = _channel_exclusion_reason(
            channel,
            categories_by_id=categories_by_id,
            excluded_ids=excluded_ids,
            excluded_channel_patterns=excluded_channel_patterns,
            excluded_category_patterns=excluded_category_patterns,
            allowed_category_ids=allowed_category_ids,
            allowed_category_patterns=allowed_category_patterns,
            typical_category_signatures=typical_category_signatures,
            permission_mode=permission_mode,
        )
        if reason:
            skipped.append((channel, reason))
        else:
            syncable.append(channel)
    return syncable, skipped


def _message_history_job_key(channel_id: str, before_id: str | None = None) -> str:
    return f"message_history:{channel_id}:{before_id or ''}"


def _thread_discovery_job_key(channel_id: str, before: str | None = None) -> str:
    return f"thread_discovery:{channel_id}:{before or ''}"


async def _enqueue_message_backfill(
    pool,
    *,
    channel_id: str,
    guild_id: str,
    parent_channel_id: str,
    is_thread_channel: bool,
    before_id: str | None,
    run_id: str,
    priority: int = 100,
) -> None:
    await enqueue_backfill_job(
        pool,
        job_key=_message_history_job_key(channel_id, before_id),
        job_type=BACKFILL_JOB_MESSAGE_HISTORY,
        channel_id=channel_id,
        payload={
            "before_id": before_id,
            "guild_id": guild_id,
            "parent_channel_id": parent_channel_id,
            "is_thread_channel": is_thread_channel,
        },
        run_id=run_id,
        priority=priority,
        refresh_completed=False,
    )


async def _sync_recent_messages(
    *,
    pool,
    api_client,
    channel: dict[str, Any],
    guild_id: str,
    run_id: str,
    limit: int,
    pages_per_channel: int,
    excluded_ids: set[str],
    excluded_channel_patterns: list[str],
) -> tuple[int, int, str | None, str | None]:
    channel_id = str(channel.get("id") or "")
    parent_channel_id = str(channel.get("parent_id") or "")
    channel_type = int(channel.get("type") or 0)
    is_thread_channel = channel_type in THREAD_TYPES
    checkpoint = await load_checkpoint(pool, channel_id)
    after_id = str((checkpoint or {}).get("newest_message_id") or "") or None
    newest_seen = after_id
    oldest_seen: str | None = None
    total_fetched = 0
    total_upserted = 0
    seen_page_before: str | None = None
    full_page_seen = False
    reached_checkpoint = False

    for page_index in range(max(1, pages_per_channel)):
        page = await asyncio.to_thread(
            api_client.get_messages_page,
            channel_id,
            limit=limit,
            before=seen_page_before,
        )
        if not page:
            break
        if after_id:
            filtered_page = [
                message
                for message in page
                if snowflake_int(str(message.get("id") or "")) > snowflake_int(after_id)
            ]
        else:
            filtered_page = page
        if not filtered_page:
            reached_checkpoint = bool(after_id)
            break
        filtered_page = await _filter_messages_for_sync_scope(
            pool,
            filtered_page,
            is_thread_channel=is_thread_channel,
            guild_id=guild_id,
            excluded_ids=excluded_ids,
            excluded_channel_patterns=excluded_channel_patterns,
        )
        if not filtered_page:
            page_oldest_id = oldest_snowflake(
                [str(message.get("id") or "") for message in page]
            )
            if page_oldest_id:
                seen_page_before = page_oldest_id
            if len(page) < limit:
                break
            continue
        rows = [
            message_row(
                message,
                run_id=run_id,
                guild_id=guild_id,
                channel_id=channel_id,
                parent_channel_id=parent_channel_id,
                is_thread_channel=is_thread_channel,
            )
            for message in filtered_page
        ]
        total_fetched += len(rows)
        await upsert_users(pool, users_from_messages(filtered_page))
        upserted = await upsert_messages(pool, rows)
        total_upserted += upserted
        page_ids = [str(message.get("id") or "") for message in filtered_page]
        newest_page_id = newest_snowflake(page_ids)
        oldest_page_id = oldest_snowflake(page_ids)
        if newest_page_id and snowflake_int(newest_page_id) > snowflake_int(
            newest_seen
        ):
            newest_seen = newest_page_id
        if oldest_page_id:
            oldest_seen = oldest_snowflake([oldest_seen, oldest_page_id])
        page_oldest_id = oldest_snowflake(
            [str(message.get("id") or "") for message in page]
        )
        if page_oldest_id:
            seen_page_before = page_oldest_id
        full_page_seen = full_page_seen or len(page) >= limit
        if after_id and len(filtered_page) < len(page):
            reached_checkpoint = True
            break
        if len(page) < limit:
            break

    seed_backfill_before_id = (
        oldest_seen
        if (not after_id or (full_page_seen and not reached_checkpoint))
        else None
    )
    return total_fetched, total_upserted, newest_seen, seed_backfill_before_id


async def handler(inp: Input, ctx: WorkflowContext) -> dict[str, Any]:
    """Sync Discord channels whose permissions inherit from their category."""
    if not env_flag_enabled("DISCORD_ETL_ENABLED", default=False):
        ctx.log("discord_sync_skipped_disabled")
        return {"status": "skipped", "reason": "discord_etl_disabled"}

    guild_id = _guild_id(inp)
    limit = bounded_discord_limit(
        inp.limit or os.getenv("DISCORD_SYNC_RECENT_LIMIT"),
        DEFAULT_RECENT_LIMIT,
    )
    pages_per_channel = positive_int(
        inp.pages_per_channel or os.getenv("DISCORD_SYNC_PAGES_PER_CHANNEL"),
        DEFAULT_PAGES_PER_CHANNEL,
    )
    thread_discovery_limit = bounded_discord_limit(
        inp.thread_discovery_limit or os.getenv("DISCORD_THREAD_DISCOVERY_LIMIT"),
        DEFAULT_THREAD_DISCOVERY_LIMIT,
    )
    permission_mode = (
        (os.getenv("DISCORD_ETL_PERMISSION_MODE") or PERMISSION_MODE_CATEGORY_DEFAULT)
        .strip()
        .lower()
    )
    if permission_mode not in {
        PERMISSION_MODE_CATEGORY_DEFAULT,
        PERMISSION_MODE_ALL_VISIBLE,
    }:
        permission_mode = PERMISSION_MODE_CATEGORY_DEFAULT

    api_client = shared_client()
    all_channels = await asyncio.to_thread(api_client.list_guild_channels, guild_id)
    categories_by_id = {
        str(channel.get("id") or ""): channel
        for channel in all_channels
        if int(channel.get("type") or 0) == DISCORD_CHANNEL_GUILD_CATEGORY
    }
    allowed_category_ids = _csv_set(os.getenv("DISCORD_ETL_ALLOWED_CATEGORY_IDS"))
    allowed_category_patterns = _glob_patterns(
        os.getenv("DISCORD_ETL_ALLOWED_CATEGORY_PATTERNS")
    )
    typical_category_min_count = positive_int(
        os.getenv("DISCORD_ETL_TYPICAL_CATEGORY_MIN_COUNT"),
        DEFAULT_TYPICAL_CATEGORY_MIN_COUNT,
    )
    typical_category_signatures = _typical_category_signatures(
        categories_by_id,
        min_count=typical_category_min_count,
    )
    candidate_parents = [
        channel
        for channel in all_channels
        if int(channel.get("type") or 0) in SYNCABLE_PARENT_TYPES
    ]
    excluded_ids = _csv_set(os.getenv("DISCORD_ETL_EXCLUDED_CHANNEL_IDS"))
    excluded_channel_patterns = _glob_patterns(
        os.getenv("DISCORD_ETL_EXCLUDED_CHANNEL_PATTERNS")
    )
    excluded_category_patterns = _glob_patterns(
        os.getenv("DISCORD_ETL_EXCLUDED_CATEGORY_PATTERNS")
    )

    syncable_parents, skipped_parent_rows = _split_syncable_channels(
        candidate_parents,
        categories_by_id=categories_by_id,
        excluded_ids=excluded_ids,
        excluded_channel_patterns=excluded_channel_patterns,
        excluded_category_patterns=excluded_category_patterns,
        allowed_category_ids=allowed_category_ids,
        allowed_category_patterns=allowed_category_patterns,
        typical_category_signatures=typical_category_signatures,
        permission_mode=permission_mode,
    )
    syncable_parent_ids = {str(channel.get("id") or "") for channel in syncable_parents}
    syncable_category_ids = {
        str(channel.get("parent_id") or "")
        for channel in syncable_parents
        if str(channel.get("parent_id") or "")
    }

    current_category_ids: set[str] = set()
    channel_rows: list[dict[str, Any]] = []
    for channel in all_channels:
        if int(channel.get("type") or 0) != DISCORD_CHANNEL_GUILD_CATEGORY:
            continue
        category_id = str(channel.get("id") or "")
        current_category_ids.add(category_id)
        if category_id not in syncable_category_ids:
            continue
        channel_rows.append(channel_row(channel, guild_id=guild_id, is_syncable=False))
    channel_rows.extend(
        channel_row(channel, guild_id=guild_id, is_syncable=True)
        for channel in syncable_parents
    )
    await upsert_channels(ctx._pool, channel_rows)
    record_etl_items_seen("discord", "channel", "channel", len(candidate_parents))
    record_etl_items_upserted("discord", "channel", "channel", len(syncable_parents))
    stored_out_of_scope_category_ids = [
        str(row["channel_id"])
        for row in await ctx._pool.fetch(
            "SELECT channel_id FROM discord_sync_channels "
            "WHERE guild_id = $1 "
            "  AND is_category = TRUE "
            "  AND NOT (channel_id = ANY($2::text[]))",
            guild_id,
            sorted(syncable_category_ids),
        )
    ]
    legacy_skipped_channel_ids = [
        str(row["channel_id"])
        for row in await ctx._pool.fetch(
            "SELECT channel_id FROM discord_sync_channels "
            "WHERE guild_id = $1 "
            "  AND is_category = FALSE "
            "  AND is_syncable = FALSE",
            guild_id,
        )
    ]
    category_ids_to_purge = sorted(
        (current_category_ids - syncable_category_ids)
        | set(stored_out_of_scope_category_ids)
    )
    stored_excluded_thread_ids = await _stored_excluded_thread_ids(
        ctx._pool,
        guild_id=guild_id,
        excluded_ids=excluded_ids,
        excluded_channel_patterns=excluded_channel_patterns,
    )

    active_thread_candidates = [
        thread
        for thread in await asyncio.to_thread(api_client.list_active_threads, guild_id)
        if str(thread.get("parent_id") or "") in syncable_parent_ids
    ]
    active_threads: list[dict[str, Any]] = []
    skipped_active_thread_rows: list[tuple[dict[str, Any], str]] = []
    for thread in active_thread_candidates:
        reason = _thread_exclusion_reason(
            thread,
            excluded_ids=excluded_ids,
            excluded_channel_patterns=excluded_channel_patterns,
        )
        if reason:
            skipped_active_thread_rows.append((thread, reason))
        else:
            active_threads.append(thread)
    await upsert_channels(
        ctx._pool,
        [
            channel_row(thread, guild_id=guild_id, is_syncable=True)
            for thread in active_threads
        ],
    )
    active_thread_ids = {str(thread.get("id") or "") for thread in active_threads}
    stale_channel_ids = await stale_syncable_channel_ids(
        ctx._pool,
        guild_id=guild_id,
        current_scope_ids=syncable_parent_ids | active_thread_ids,
        syncable_parent_ids=syncable_parent_ids,
    )
    purged_scope = await purge_channels_from_sync_scope(
        ctx._pool,
        category_ids_to_purge
        + legacy_skipped_channel_ids
        + stored_excluded_thread_ids
        + sorted(stale_channel_ids)
        + [
            str(channel.get("id") or "")
            for channel, reason in skipped_parent_rows
            if reason
        ]
        + [
            str(thread.get("id") or "")
            for thread, reason in skipped_active_thread_rows
            if reason
        ],
        delete_channel_rows=True,
    )
    record_etl_items_seen(
        "discord", "channel", "active_thread", len(active_thread_candidates)
    )
    record_etl_items_upserted(
        "discord", "channel", "active_thread", len(active_threads)
    )

    message_containers = [
        channel
        for channel in syncable_parents
        if int(channel.get("type") or 0) in MESSAGE_CONTAINER_TYPES
    ]
    message_containers.extend(active_threads)

    run_id = workflow_run_id_to_sync_run_id(ctx.run_id)
    await record_run_start(
        ctx._pool,
        run_id=run_id,
        workflow_run_id=ctx.run_id,
        mode="incremental",
        requested=[channel_ref(channel) for channel in message_containers],
        skipped=[
            _redacted_channel_ref(channel, reason)
            for channel, reason in skipped_parent_rows
        ],
        metadata={
            **inp.metadata,
            "guild_id": guild_id,
            "permission_mode": permission_mode,
            "configured_category_allowlist": _configured_category_allowlist_enabled(
                allowed_category_ids=allowed_category_ids,
                allowed_category_patterns=allowed_category_patterns,
            ),
            "typical_category_signature_count": len(typical_category_signatures),
            "typical_category_min_count": typical_category_min_count,
            "syncable_parent_channels": len(syncable_parents),
            "active_threads": len(active_threads),
            "skipped_active_threads": len(skipped_active_thread_rows),
            "purged_scope": purged_scope,
        },
    )

    synced: list[dict[str, str]] = []
    skipped: list[dict[str, str]] = [
        _redacted_channel_ref(channel, reason)
        for channel, reason in skipped_parent_rows
    ]
    skipped.extend(
        _redacted_channel_ref(thread, reason)
        for thread, reason in skipped_active_thread_rows
    )
    failed: list[dict[str, str]] = []
    counts = {
        "messages_fetched": 0,
        "messages_upserted": 0,
        "threads_fetched": len(active_thread_candidates),
        "threads_upserted": len(active_threads),
    }

    for parent in syncable_parents:
        if int(parent.get("type") or 0) in THREAD_PARENT_TYPES:
            await enqueue_backfill_job(
                ctx._pool,
                job_key=_thread_discovery_job_key(str(parent.get("id") or "")),
                job_type=BACKFILL_JOB_THREAD_DISCOVERY,
                channel_id=str(parent.get("id") or ""),
                payload={
                    "before": None,
                    "guild_id": guild_id,
                    "limit": thread_discovery_limit,
                },
                run_id=run_id,
                priority=150,
                refresh_completed=True,
            )
            record_etl_items_enqueued("discord", "channel", "thread_discovery_job", 1)

    for channel in message_containers:
        channel_id = str(channel.get("id") or "")
        try:
            fetched, upserted, newest_id, oldest_id = await _sync_recent_messages(
                pool=ctx._pool,
                api_client=api_client,
                channel=channel,
                guild_id=guild_id,
                run_id=run_id,
                limit=limit,
                pages_per_channel=pages_per_channel,
                excluded_ids=excluded_ids,
                excluded_channel_patterns=excluded_channel_patterns,
            )
            counts["messages_fetched"] += fetched
            counts["messages_upserted"] += upserted
            record_etl_items_seen("discord", "channel", "message", fetched)
            record_etl_items_upserted("discord", "channel", "message", upserted)
            await update_checkpoint_success(
                ctx._pool,
                channel_id=channel_id,
                newest_message_id=newest_id,
                run_id=run_id,
            )
            if oldest_id:
                await _enqueue_message_backfill(
                    ctx._pool,
                    channel_id=channel_id,
                    guild_id=guild_id,
                    parent_channel_id=str(channel.get("parent_id") or ""),
                    is_thread_channel=int(channel.get("type") or 0) in THREAD_TYPES,
                    before_id=oldest_id,
                    run_id=run_id,
                    priority=100,
                )
                record_etl_items_enqueued(
                    "discord", "channel", "message_history_job", 1
                )
            synced.append(channel_ref(channel))
            ctx.log(
                "discord_sync_channel_completed",
                channel_id=channel_id,
                channel_name=str(channel.get("name") or ""),
                messages=fetched,
                newest_message_id=newest_id,
                backfill_seeded=bool(oldest_id),
            )
        except DiscordApiError as exc:
            if exc.status_code in {403, 404}:
                purged_scope = await purge_channels_from_sync_scope(
                    ctx._pool,
                    [channel_id],
                    delete_channel_rows=True,
                )
                reason = f"discord_api_{exc.status_code}"
                skipped.append(_redacted_channel_ref(channel, reason))
                ctx.log(
                    "discord_sync_channel_purged_inaccessible",
                    channel_id=channel_id,
                    reason=reason,
                    purged_scope=purged_scope,
                )
                continue
            error = str(exc)
            ctx.log(
                "discord_sync_channel_failed",
                channel_id=channel_id,
                channel_name=str(channel.get("name") or ""),
                error=error,
            )
            failed.append(channel_ref(channel, error))
            record_etl_items_failed(
                "discord", "channel", "channel", failure_reason(error)
            )
            await update_checkpoint_failure(
                ctx._pool,
                channel_id=channel_id,
                run_id=run_id,
                error=error,
            )
        except Exception as exc:
            error = str(exc)
            ctx.log(
                "discord_sync_channel_failed",
                channel_id=channel_id,
                channel_name=str(channel.get("name") or ""),
                error=error,
            )
            failed.append(channel_ref(channel, error))
            record_etl_items_failed(
                "discord", "channel", "channel", failure_reason(error)
            )
            await update_checkpoint_failure(
                ctx._pool,
                channel_id=channel_id,
                run_id=run_id,
                error=error,
            )

    status = "completed"
    error_text = ""
    if failed and synced:
        status = "partial_failed"
        error_text = f"{len(failed)} channel(s) failed"
    elif failed:
        status = "failed"
        error_text = f"{len(failed)} channel(s) failed"

    await record_run_finish(
        ctx._pool,
        run_id=run_id,
        status=status,
        synced=synced,
        skipped=skipped,
        failed=failed,
        counts=counts,
        error_text=error_text,
    )

    return {
        "status": status,
        "run_id": run_id,
        "channels_synced": len(synced),
        "channels_skipped": len(skipped),
        "channels_failed": len(failed),
        **counts,
    }
