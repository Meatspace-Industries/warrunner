"""Workflow: drain Discord historical message and thread backfill jobs."""

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
    SYNCABLE_PARENT_TYPES,
    THREAD_TYPES,
    bounded_discord_limit,
    channel_ref,
    channel_row,
    claim_backfill_jobs,
    client as shared_client,
    decode_payload,
    embedded_thread_id,
    enqueue_backfill_job,
    env_flag_enabled,
    failure_reason,
    mark_backfill_job_completed,
    mark_backfill_job_failed,
    message_row,
    oldest_snowflake,
    permission_signature,
    positive_int,
    purge_channels_from_sync_scope,
    record_run_finish,
    record_run_start,
    upsert_channels,
    upsert_messages,
    upsert_users,
    users_from_messages,
    workflow_run_id_to_sync_run_id,
)

WORKFLOW_NAME = "discord_backfill"

DEFAULT_SYNC_INTERVAL_SECONDS = 60
DEFAULT_CHANNEL_BATCH_LIMIT = 20
DEFAULT_PAGES_PER_JOB = 5
DEFAULT_PAGE_LIMIT = 100
DEFAULT_AUDIT_THREAD_LIMIT = 20
DEFAULT_TYPICAL_CATEGORY_MIN_COUNT = 2
PERMISSION_MODE_CATEGORY_DEFAULT = "category_default"
PERMISSION_MODE_ALL_VISIBLE = "all_visible"

SCHEDULE = {
    "schedule_id": "discord_backfill",
    "interval_seconds": positive_int(
        os.getenv("DISCORD_BACKFILL_INTERVAL_SECONDS"),
        DEFAULT_SYNC_INTERVAL_SECONDS,
    ),
    "enabled": (
        env_flag_enabled("DISCORD_ETL_ENABLED", default=False)
        and env_flag_enabled("DISCORD_BACKFILL_ENABLED", default=True)
    ),
    "no_delivery": True,
}


@dataclass
class Input:
    """Runtime options for Discord historical backfill draining."""

    limit: int | None = None
    channel_batch_limit: int | None = None
    pages_per_job: int | None = None
    metadata: dict[str, Any] = field(default_factory=dict)


def _message_history_job_key(channel_id: str, before_id: str | None = None) -> str:
    return f"message_history:{channel_id}:{before_id or ''}"


def _thread_discovery_job_key(channel_id: str, before: str | None = None) -> str:
    return f"thread_discovery:{channel_id}:{before or ''}"


def _next_thread_archive_before(threads: list[dict[str, Any]]) -> str | None:
    timestamps = [
        str((thread.get("thread_metadata") or {}).get("archive_timestamp") or "")
        for thread in threads
        if isinstance(thread.get("thread_metadata"), dict)
    ]
    timestamps = [value for value in timestamps if value]
    return min(timestamps) if timestamps else None


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


def _parent_channel_exclusion_reason(
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


@dataclass(frozen=True)
class FreshGuildScope:
    guild_id: str
    channels_by_id: dict[str, dict[str, Any]]
    syncable_parent_ids: set[str]
    parent_exclusion_reasons: dict[str, str]


async def _fresh_guild_scope(api_client, guild_id: str) -> FreshGuildScope:
    channels = await asyncio.to_thread(api_client.list_guild_channels, guild_id)
    channels_by_id = {
        str(channel.get("id") or ""): channel
        for channel in channels
        if isinstance(channel, dict) and channel.get("id")
    }
    categories_by_id = {
        channel_id: channel
        for channel_id, channel in channels_by_id.items()
        if int(channel.get("type") or 0) == DISCORD_CHANNEL_GUILD_CATEGORY
    }
    excluded_ids = _csv_set(os.getenv("DISCORD_ETL_EXCLUDED_CHANNEL_IDS"))
    excluded_channel_patterns = _glob_patterns(
        os.getenv("DISCORD_ETL_EXCLUDED_CHANNEL_PATTERNS")
    )
    excluded_category_patterns = _glob_patterns(
        os.getenv("DISCORD_ETL_EXCLUDED_CATEGORY_PATTERNS")
    )
    allowed_category_ids = _csv_set(os.getenv("DISCORD_ETL_ALLOWED_CATEGORY_IDS"))
    allowed_category_patterns = _glob_patterns(
        os.getenv("DISCORD_ETL_ALLOWED_CATEGORY_PATTERNS")
    )
    typical_category_signatures = _typical_category_signatures(
        categories_by_id,
        min_count=positive_int(
            os.getenv("DISCORD_ETL_TYPICAL_CATEGORY_MIN_COUNT"),
            DEFAULT_TYPICAL_CATEGORY_MIN_COUNT,
        ),
    )
    permission_mode = (
        os.getenv("DISCORD_ETL_PERMISSION_MODE") or PERMISSION_MODE_CATEGORY_DEFAULT
    ).strip()

    syncable_parent_ids: set[str] = set()
    parent_exclusion_reasons: dict[str, str] = {}
    for channel_id, channel in channels_by_id.items():
        if int(channel.get("type") or 0) not in SYNCABLE_PARENT_TYPES:
            continue
        reason = _parent_channel_exclusion_reason(
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
            parent_exclusion_reasons[channel_id] = reason
        else:
            syncable_parent_ids.add(channel_id)
    return FreshGuildScope(
        guild_id=guild_id,
        channels_by_id=channels_by_id,
        syncable_parent_ids=syncable_parent_ids,
        parent_exclusion_reasons=parent_exclusion_reasons,
    )


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


@dataclass(frozen=True)
class StoredChannelExclusion:
    reason: str
    purge_channel_id: str | None
    extra_purge_channel_ids: tuple[str, ...] = ()


async def _stored_channel_exclusion(
    pool,
    channel_id: str,
) -> StoredChannelExclusion | None:
    row = await pool.fetchrow(
        "SELECT channel_id, parent_id, channel_name, channel_type, is_syncable, is_category "
        "FROM discord_sync_channels WHERE channel_id = $1",
        channel_id,
    )
    if not row:
        return StoredChannelExclusion("missing_channel", None)
    if not bool(row["is_syncable"]):
        return StoredChannelExclusion("non_syncable", channel_id)
    if int(row["channel_type"] or 0) == DISCORD_CHANNEL_PRIVATE_THREAD:
        return StoredChannelExclusion("excluded_private_thread", channel_id)

    excluded_ids = _csv_set(os.getenv("DISCORD_ETL_EXCLUDED_CHANNEL_IDS"))
    excluded_channel_patterns = _glob_patterns(
        os.getenv("DISCORD_ETL_EXCLUDED_CHANNEL_PATTERNS")
    )
    excluded_category_patterns = _glob_patterns(
        os.getenv("DISCORD_ETL_EXCLUDED_CATEGORY_PATTERNS")
    )
    parent_id = str(row["parent_id"] or "")
    if channel_id in excluded_ids:
        return StoredChannelExclusion("excluded_by_id", channel_id)
    if parent_id in excluded_ids:
        return StoredChannelExclusion("excluded_by_parent_id", parent_id)
    channel_name = str(row["channel_name"] or "").strip().lower()
    pattern = _pattern_match(
        channel_name,
        excluded_channel_patterns,
    )
    if pattern:
        return StoredChannelExclusion(
            f"excluded_by_channel_pattern:{pattern}", channel_id
        )
    if bool(row["is_category"]):
        category_pattern = _pattern_match(channel_name, excluded_category_patterns)
        if category_pattern:
            return StoredChannelExclusion(
                f"excluded_by_category_pattern:{category_pattern}",
                channel_id,
            )

    ancestor_id = parent_id
    seen_ancestors: set[str] = set()
    while ancestor_id and ancestor_id not in seen_ancestors:
        seen_ancestors.add(ancestor_id)
        ancestor = await pool.fetchrow(
            "SELECT channel_id, parent_id, channel_name, is_category "
            "FROM discord_sync_channels WHERE channel_id = $1",
            ancestor_id,
        )
        if not ancestor:
            break
        ancestor_name = str(ancestor["channel_name"] or "").strip().lower()
        ancestor_channel_pattern = _pattern_match(
            ancestor_name,
            excluded_channel_patterns,
        )
        if ancestor_channel_pattern:
            return StoredChannelExclusion(
                f"excluded_by_ancestor_channel_pattern:{ancestor_channel_pattern}",
                str(ancestor["channel_id"] or ancestor_id),
            )
        if bool(ancestor["is_category"]):
            ancestor_category_pattern = _pattern_match(
                ancestor_name,
                excluded_category_patterns,
            )
            if ancestor_category_pattern:
                return StoredChannelExclusion(
                    f"excluded_by_ancestor_category_pattern:{ancestor_category_pattern}",
                    str(ancestor["channel_id"] or ancestor_id),
                )
        ancestor_id = str(ancestor["parent_id"] or "")
    return None


async def _purge_stored_exclusion(pool, exclusion: StoredChannelExclusion) -> None:
    purge_ids = [
        channel_id
        for channel_id in (
            [exclusion.purge_channel_id] if exclusion.purge_channel_id else []
        )
        + list(exclusion.extra_purge_channel_ids)
        if channel_id
    ]
    if not purge_ids:
        return
    await purge_channels_from_sync_scope(
        pool,
        purge_ids,
        delete_channel_rows=True,
    )


async def _fresh_channel_exclusion(
    pool,
    api_client,
    channel_id: str,
    *,
    fresh_scope: FreshGuildScope | None = None,
) -> StoredChannelExclusion | None:
    excluded_ids = _csv_set(os.getenv("DISCORD_ETL_EXCLUDED_CHANNEL_IDS"))
    excluded_channel_patterns = _glob_patterns(
        os.getenv("DISCORD_ETL_EXCLUDED_CHANNEL_PATTERNS")
    )
    excluded_category_patterns = _glob_patterns(
        os.getenv("DISCORD_ETL_EXCLUDED_CATEGORY_PATTERNS")
    )

    current_id = channel_id
    seen_ids: set[str] = set()
    is_target = True
    target_channel: dict[str, Any] | None = None
    while current_id and current_id not in seen_ids:
        seen_ids.add(current_id)
        try:
            channel = await asyncio.to_thread(api_client.get_channel, current_id)
        except DiscordApiError as exc:
            if exc.status_code in {403, 404}:
                return StoredChannelExclusion(
                    f"discord_api_{exc.status_code}",
                    current_id,
                    (() if current_id == channel_id else (channel_id,)),
                )
            raise
        if not channel:
            return StoredChannelExclusion(
                "missing_fresh_channel",
                current_id,
                (() if current_id == channel_id else (channel_id,)),
            )

        observed_id = str(channel.get("id") or current_id)
        if is_target:
            target_channel = channel
        parent_id = str(channel.get("parent_id") or "")
        channel_type = int(channel.get("type") or 0)
        extra_target_ids = () if observed_id == channel_id else (channel_id,)
        if observed_id in excluded_ids:
            return StoredChannelExclusion(
                "excluded_by_id" if is_target else "excluded_by_ancestor_id",
                observed_id,
                extra_target_ids,
            )
        if parent_id in excluded_ids:
            return StoredChannelExclusion(
                "excluded_by_parent_id",
                parent_id,
                (() if parent_id == channel_id else (channel_id,)),
            )
        if channel_type == DISCORD_CHANNEL_PRIVATE_THREAD:
            return StoredChannelExclusion(
                "excluded_private_thread",
                observed_id,
                extra_target_ids,
            )
        channel_pattern = _pattern_match(
            _channel_name(channel),
            excluded_channel_patterns,
        )
        if channel_pattern:
            return StoredChannelExclusion(
                (
                    f"excluded_by_channel_pattern:{channel_pattern}"
                    if is_target
                    else f"excluded_by_ancestor_channel_pattern:{channel_pattern}"
                ),
                observed_id,
                extra_target_ids,
            )
        if channel_type == DISCORD_CHANNEL_GUILD_CATEGORY:
            category_pattern = _pattern_match(
                _channel_name(channel),
                excluded_category_patterns,
            )
            if category_pattern:
                return StoredChannelExclusion(
                    (
                        f"excluded_by_category_pattern:{category_pattern}"
                        if is_target
                        else f"excluded_by_ancestor_category_pattern:{category_pattern}"
                    ),
                    observed_id,
                    extra_target_ids,
                )

        current_id = parent_id
        is_target = False

    if fresh_scope is not None:
        target = target_channel or {}
        target_id = str(target.get("id") or channel_id)
        target_type = int(target.get("type") or 0)
        if target_type in THREAD_TYPES:
            parent_id = str(target.get("parent_id") or "")
            if not parent_id:
                return StoredChannelExclusion("missing_fresh_parent", target_id)
            if parent_id not in fresh_scope.syncable_parent_ids:
                return StoredChannelExclusion(
                    "excluded_by_parent_scope:"
                    + fresh_scope.parent_exclusion_reasons.get(
                        parent_id,
                        "missing_parent_from_fresh_scope",
                    ),
                    parent_id,
                    (() if parent_id == target_id else (target_id,)),
                )
        elif target_type in SYNCABLE_PARENT_TYPES:
            if target_id not in fresh_scope.syncable_parent_ids:
                return StoredChannelExclusion(
                    "excluded_by_scope:"
                    + fresh_scope.parent_exclusion_reasons.get(
                        target_id,
                        "missing_parent_from_fresh_scope",
                    ),
                    target_id,
                )
        else:
            return StoredChannelExclusion("unsupported_fresh_channel_type", target_id)

    return await _stored_channel_exclusion(pool, channel_id)


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
    for message in messages:
        thread_id = embedded_thread_id(message)
        if not thread_id:
            kept.append(message)
            continue
        thread = (
            message.get("thread") if isinstance(message.get("thread"), dict) else {}
        )
        reason = _thread_exclusion_reason(
            {**thread, "guild_id": thread.get("guild_id") or guild_id},
            excluded_ids=_csv_set(os.getenv("DISCORD_ETL_EXCLUDED_CHANNEL_IDS")),
            excluded_channel_patterns=_glob_patterns(
                os.getenv("DISCORD_ETL_EXCLUDED_CHANNEL_PATTERNS")
            ),
        )
        if reason:
            await purge_channels_from_sync_scope(
                pool,
                [thread_id],
                delete_channel_rows=True,
            )
            continue
        exclusion = await _stored_channel_exclusion(pool, thread_id)
        if exclusion:
            await _purge_stored_exclusion(pool, exclusion)
            continue
        if thread_id not in allowed_thread_ids:
            continue
        kept.append(message)
    return kept


async def _audit_stored_thread_scope(pool, api_client, *, limit: int) -> dict[str, int]:
    rows = await pool.fetch(
        "SELECT channel_id, guild_id FROM discord_sync_channels "
        "WHERE is_thread = TRUE AND is_syncable = TRUE "
        "ORDER BY last_seen_at, channel_id "
        "LIMIT $1",
        limit,
    )
    audited = 0
    purged = 0
    scopes_by_guild_id: dict[str, FreshGuildScope] = {}
    for row in rows:
        channel_id = str(row["channel_id"] or "")
        guild_id = str(row["guild_id"] or os.getenv("DISCORD_GUILD_ID") or "")
        if not channel_id:
            continue
        if guild_id and guild_id not in scopes_by_guild_id:
            scopes_by_guild_id[guild_id] = await _fresh_guild_scope(
                api_client, guild_id
            )
        audited += 1
        exclusion = await _fresh_channel_exclusion(
            pool,
            api_client,
            channel_id,
            fresh_scope=scopes_by_guild_id.get(guild_id),
        )
        if exclusion:
            await _purge_stored_exclusion(pool, exclusion)
            purged += 1
            continue
        await pool.execute(
            "UPDATE discord_sync_channels SET last_seen_at = NOW(), updated_at = NOW() "
            "WHERE channel_id = $1",
            channel_id,
        )
    return {"threads_audited": audited, "threads_purged": purged}


async def _process_thread_discovery_job(
    *,
    pool,
    api_client,
    job: dict[str, Any],
    payload: dict[str, Any],
    run_id: str,
    limit: int,
    fresh_scope: FreshGuildScope | None,
) -> tuple[int, int]:
    channel_id = str(job["channel_id"])
    guild_id = str(payload.get("guild_id") or "")
    before = str(payload.get("before") or "") or None
    exclusion = await _fresh_channel_exclusion(
        pool,
        api_client,
        channel_id,
        fresh_scope=fresh_scope,
    )
    if exclusion:
        await _purge_stored_exclusion(pool, exclusion)
        return 0, 0
    try:
        page = await asyncio.to_thread(
            api_client.list_public_archived_threads,
            channel_id,
            before=before,
            limit=limit,
        )
    except DiscordApiError as exc:
        if exc.status_code in {403, 404}:
            await purge_channels_from_sync_scope(
                pool,
                [channel_id],
                delete_channel_rows=True,
            )
            return 0, 0
        raise
    exclusion = await _fresh_channel_exclusion(
        pool,
        api_client,
        channel_id,
        fresh_scope=fresh_scope,
    )
    if exclusion:
        await _purge_stored_exclusion(pool, exclusion)
        return 0, 0
    threads = [thread for thread in page.get("threads", []) if isinstance(thread, dict)]
    excluded_ids = _csv_set(os.getenv("DISCORD_ETL_EXCLUDED_CHANNEL_IDS"))
    excluded_channel_patterns = _glob_patterns(
        os.getenv("DISCORD_ETL_EXCLUDED_CHANNEL_PATTERNS")
    )
    syncable_threads: list[dict[str, Any]] = []
    skipped_threads: list[tuple[dict[str, Any], str]] = []
    for thread in threads:
        reason = _thread_exclusion_reason(
            thread,
            excluded_ids=excluded_ids,
            excluded_channel_patterns=excluded_channel_patterns,
        )
        if reason:
            skipped_threads.append((thread, reason))
        else:
            syncable_threads.append(thread)
    thread_rows = [
        channel_row(thread, guild_id=guild_id, is_syncable=True)
        for thread in syncable_threads
    ]
    upserted = await upsert_channels(pool, thread_rows)
    await purge_channels_from_sync_scope(
        pool,
        [str(thread.get("id") or "") for thread, reason in skipped_threads if reason],
        delete_channel_rows=True,
    )
    for thread in syncable_threads:
        thread_id = str(thread.get("id") or "")
        if not thread_id:
            continue
        await enqueue_backfill_job(
            pool,
            job_key=_message_history_job_key(thread_id),
            job_type=BACKFILL_JOB_MESSAGE_HISTORY,
            channel_id=thread_id,
            payload={
                "before_id": None,
                "guild_id": guild_id,
                "parent_channel_id": str(thread.get("parent_id") or channel_id),
                "is_thread_channel": True,
            },
            run_id=run_id,
            priority=100,
            refresh_completed=False,
        )
        record_etl_items_enqueued("discord", "channel", "message_history_job", 1)

    has_more = bool(page.get("has_more"))
    next_before = _next_thread_archive_before(threads)
    if has_more and next_before:
        await enqueue_backfill_job(
            pool,
            job_key=_thread_discovery_job_key(channel_id, next_before),
            job_type=BACKFILL_JOB_THREAD_DISCOVERY,
            channel_id=channel_id,
            payload={
                "before": next_before,
                "guild_id": guild_id,
                "limit": limit,
            },
            run_id=run_id,
            priority=int(job.get("priority") or 150),
            refresh_completed=False,
        )
    return len(threads), upserted


async def _process_message_history_job(
    *,
    pool,
    api_client,
    job: dict[str, Any],
    payload: dict[str, Any],
    run_id: str,
    limit: int,
    pages_per_job: int,
    fresh_scope: FreshGuildScope | None,
) -> tuple[int, int, str | None]:
    channel_id = str(job["channel_id"])
    guild_id = str(payload.get("guild_id") or "")
    parent_channel_id = str(payload.get("parent_channel_id") or "")
    is_thread_channel = bool(payload.get("is_thread_channel"))
    before_id = str(payload.get("before_id") or "") or None
    exclusion = await _fresh_channel_exclusion(
        pool,
        api_client,
        channel_id,
        fresh_scope=fresh_scope,
    )
    if exclusion:
        await _purge_stored_exclusion(pool, exclusion)
        return 0, 0, None
    total_fetched = 0
    total_upserted = 0
    next_before = before_id

    for _ in range(max(1, pages_per_job)):
        exclusion = await _fresh_channel_exclusion(
            pool,
            api_client,
            channel_id,
            fresh_scope=fresh_scope,
        )
        if exclusion:
            await _purge_stored_exclusion(pool, exclusion)
            return total_fetched, total_upserted, None
        try:
            page = await asyncio.to_thread(
                api_client.get_messages_page,
                channel_id,
                limit=limit,
                before=next_before,
            )
        except DiscordApiError as exc:
            if exc.status_code in {403, 404}:
                await purge_channels_from_sync_scope(
                    pool,
                    [channel_id],
                    delete_channel_rows=True,
                )
                return total_fetched, total_upserted, None
            raise
        if not page:
            next_before = None
            break
        exclusion = await _stored_channel_exclusion(pool, channel_id)
        if exclusion:
            await _purge_stored_exclusion(pool, exclusion)
            return total_fetched, total_upserted, None
        raw_page = page
        page = await _filter_messages_for_sync_scope(
            pool,
            raw_page,
            is_thread_channel=is_thread_channel,
            guild_id=guild_id,
        )
        next_before = oldest_snowflake(
            [str(message.get("id") or "") for message in raw_page]
        )
        if not page:
            if len(raw_page) < limit:
                next_before = None
                break
            if not next_before:
                break
            continue
        await upsert_users(pool, users_from_messages(page))
        rows = [
            message_row(
                message,
                run_id=run_id,
                guild_id=guild_id,
                channel_id=channel_id,
                parent_channel_id=parent_channel_id,
                is_thread_channel=is_thread_channel,
            )
            for message in page
        ]
        total_fetched += len(rows)
        total_upserted += await upsert_messages(pool, rows)
        if len(raw_page) < limit:
            next_before = None
            break

    return total_fetched, total_upserted, next_before


async def handler(inp: Input, ctx: WorkflowContext) -> dict[str, Any]:
    """Drain queued Discord historical backfill jobs in bounded batches."""
    if not (
        env_flag_enabled("DISCORD_ETL_ENABLED", default=False)
        and env_flag_enabled("DISCORD_BACKFILL_ENABLED", default=True)
    ):
        ctx.log("discord_backfill_skipped_disabled")
        return {"status": "skipped", "reason": "discord_backfill_disabled"}

    limit = bounded_discord_limit(
        inp.limit or os.getenv("DISCORD_BACKFILL_PAGE_LIMIT"),
        DEFAULT_PAGE_LIMIT,
    )
    channel_batch_limit = positive_int(
        inp.channel_batch_limit or os.getenv("DISCORD_BACKFILL_CHANNEL_BATCH_LIMIT"),
        DEFAULT_CHANNEL_BATCH_LIMIT,
    )
    pages_per_job = positive_int(
        inp.pages_per_job or os.getenv("DISCORD_BACKFILL_PAGES_PER_JOB"),
        DEFAULT_PAGES_PER_JOB,
    )
    audit_limit = positive_int(
        os.getenv("DISCORD_BACKFILL_AUDIT_THREAD_LIMIT"),
        DEFAULT_AUDIT_THREAD_LIMIT,
    )
    api_client = shared_client()
    audit_counts = await _audit_stored_thread_scope(
        ctx._pool,
        api_client,
        limit=audit_limit,
    )

    jobs = await claim_backfill_jobs(ctx._pool, channel_batch_limit)
    if not jobs:
        ctx.log("discord_backfill_skipped_no_jobs")
        return {
            "status": "skipped",
            "reason": "no_pending_backfills",
            **audit_counts,
        }

    run_id = workflow_run_id_to_sync_run_id(ctx.run_id)
    fresh_scopes_by_guild_id: dict[str, FreshGuildScope] = {}

    async def fresh_scope_for(payload: dict[str, Any]) -> FreshGuildScope | None:
        guild_id = str(payload.get("guild_id") or os.getenv("DISCORD_GUILD_ID") or "")
        if not guild_id:
            return None
        if guild_id not in fresh_scopes_by_guild_id:
            fresh_scopes_by_guild_id[guild_id] = await _fresh_guild_scope(
                api_client,
                guild_id,
            )
        return fresh_scopes_by_guild_id[guild_id]

    requested = [
        {
            "channel_id": str(job["channel_id"]),
            "channel_name": "",
            "reason": str(job["job_key"]),
        }
        for job in jobs
    ]
    await record_run_start(
        ctx._pool,
        run_id=run_id,
        workflow_run_id=ctx.run_id,
        mode="backfill",
        requested=requested,
        skipped=[],
        metadata={
            **inp.metadata,
            "channel_batch_limit": channel_batch_limit,
            "pages_per_job": pages_per_job,
            "audit_thread_limit": audit_limit,
        },
    )

    synced: list[dict[str, str]] = []
    failed: list[dict[str, str]] = []
    counts = {
        "messages_fetched": 0,
        "messages_upserted": 0,
        "threads_fetched": 0,
        "threads_upserted": 0,
        **audit_counts,
    }

    for job in jobs:
        job_id = int(job["job_id"])
        channel_id = str(job["channel_id"] or "")
        try:
            payload = decode_payload(job)
            fresh_scope = await fresh_scope_for(payload)
            job_type = str(job.get("job_type") or "")
            if job_type == BACKFILL_JOB_THREAD_DISCOVERY:
                fetched, upserted = await _process_thread_discovery_job(
                    pool=ctx._pool,
                    api_client=api_client,
                    job=job,
                    payload=payload,
                    run_id=run_id,
                    limit=limit,
                    fresh_scope=fresh_scope,
                )
                counts["threads_fetched"] += fetched
                counts["threads_upserted"] += upserted
                record_etl_items_seen("discord", "channel", "archived_thread", fetched)
                record_etl_items_upserted(
                    "discord", "channel", "archived_thread", upserted
                )
                await mark_backfill_job_completed(
                    ctx._pool, job_id=job_id, run_id=run_id
                )
                synced.append(channel_ref({"id": channel_id, "name": channel_id}))
                ctx.log(
                    "discord_backfill_thread_discovery_completed",
                    job_id=job_id,
                    job_key=str(job["job_key"]),
                    channel_id=channel_id,
                    threads=fetched,
                    threads_upserted=upserted,
                )
                continue

            if job_type != BACKFILL_JOB_MESSAGE_HISTORY:
                raise RuntimeError(f"unsupported backfill job type: {job_type}")

            fetched, upserted, next_before = await _process_message_history_job(
                pool=ctx._pool,
                api_client=api_client,
                job=job,
                payload=payload,
                run_id=run_id,
                limit=limit,
                pages_per_job=pages_per_job,
                fresh_scope=fresh_scope,
            )
            counts["messages_fetched"] += fetched
            counts["messages_upserted"] += upserted
            record_etl_items_seen("discord", "channel", "backfill_message", fetched)
            record_etl_items_upserted(
                "discord", "channel", "backfill_message", upserted
            )
            if next_before:
                await enqueue_backfill_job(
                    ctx._pool,
                    job_key=_message_history_job_key(channel_id, next_before),
                    job_type=BACKFILL_JOB_MESSAGE_HISTORY,
                    channel_id=channel_id,
                    payload={**payload, "before_id": next_before},
                    run_id=run_id,
                    priority=int(job.get("priority") or 100),
                )
                record_etl_items_enqueued(
                    "discord", "channel", "message_history_job", 1
                )
            await mark_backfill_job_completed(
                ctx._pool,
                job_id=job_id,
                run_id=run_id,
                payload={**payload, "before_id": next_before},
            )
            synced.append(channel_ref({"id": channel_id, "name": channel_id}))
            ctx.log(
                "discord_backfill_message_history_completed",
                job_id=job_id,
                job_key=str(job["job_key"]),
                channel_id=channel_id,
                messages=fetched,
                messages_upserted=upserted,
                has_more=bool(next_before),
            )
        except Exception as exc:
            error = str(exc)
            ctx.log(
                "discord_backfill_job_failed",
                job_id=job_id,
                job_key=str(job.get("job_key") or ""),
                job_type=str(job.get("job_type") or ""),
                channel_id=channel_id,
                error=error,
            )
            failed.append(channel_ref({"id": channel_id, "name": channel_id}, error))
            record_etl_items_failed(
                "discord",
                "channel",
                f"{str(job.get('job_type') or 'backfill')}_job",
                failure_reason(error),
            )
            await mark_backfill_job_failed(
                ctx._pool,
                job_id=job_id,
                run_id=run_id,
                error=error,
            )

    status = "completed"
    error_text = ""
    if failed and synced:
        status = "partial_failed"
        error_text = f"{len(failed)} job(s) failed"
    elif failed:
        status = "failed"
        error_text = f"{len(failed)} job(s) failed"

    await record_run_finish(
        ctx._pool,
        run_id=run_id,
        status=status,
        synced=synced,
        skipped=[],
        failed=failed,
        counts=counts,
        error_text=error_text,
    )

    return {
        "status": status,
        "run_id": run_id,
        "channels_synced": len(synced),
        "channels_failed": len(failed),
        **counts,
    }
