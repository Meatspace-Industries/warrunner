"""Shared helpers for Discord history sync and backfill workflows."""

from __future__ import annotations

import datetime as dt
import json
import os
import time
from typing import Any, Protocol
from urllib.parse import quote

import httpx

from api.runtime_control import canonical_json

FALSE_ENV_VALUES = {"0", "false", "no", "off"}

DISCORD_CHANNEL_GUILD_TEXT = 0
DISCORD_CHANNEL_GUILD_ANNOUNCEMENT = 5
DISCORD_CHANNEL_GUILD_CATEGORY = 4
DISCORD_CHANNEL_ANNOUNCEMENT_THREAD = 10
DISCORD_CHANNEL_PUBLIC_THREAD = 11
DISCORD_CHANNEL_PRIVATE_THREAD = 12
DISCORD_CHANNEL_GUILD_FORUM = 15
DISCORD_CHANNEL_GUILD_MEDIA = 16

MESSAGE_CONTAINER_TYPES = {
    DISCORD_CHANNEL_GUILD_TEXT,
    DISCORD_CHANNEL_GUILD_ANNOUNCEMENT,
    DISCORD_CHANNEL_PUBLIC_THREAD,
    DISCORD_CHANNEL_ANNOUNCEMENT_THREAD,
}
THREAD_PARENT_TYPES = {
    DISCORD_CHANNEL_GUILD_TEXT,
    DISCORD_CHANNEL_GUILD_ANNOUNCEMENT,
    DISCORD_CHANNEL_GUILD_FORUM,
    DISCORD_CHANNEL_GUILD_MEDIA,
}
SYNCABLE_PARENT_TYPES = THREAD_PARENT_TYPES
THREAD_TYPES = {
    DISCORD_CHANNEL_PUBLIC_THREAD,
    DISCORD_CHANNEL_ANNOUNCEMENT_THREAD,
    DISCORD_CHANNEL_PRIVATE_THREAD,
}

BACKFILL_JOB_MESSAGE_HISTORY = "message_history"
BACKFILL_JOB_THREAD_DISCOVERY = "thread_discovery"
BACKFILL_JOB_PAYLOAD_VERSION = 1

DISCORD_EPOCH_MS = 1_420_070_400_000


class DiscordSyncClient(Protocol):
    """Small protocol for the Discord REST methods used by ETL workflows."""

    def list_guild_channels(self, guild_id: str) -> list[dict[str, Any]]: ...

    def list_active_threads(self, guild_id: str) -> list[dict[str, Any]]: ...

    def list_public_archived_threads(
        self,
        channel_id: str,
        *,
        before: str | None = None,
        limit: int = 100,
    ) -> dict[str, Any]: ...

    def get_messages_page(
        self,
        channel_id: str,
        *,
        limit: int = 100,
        before: str | None = None,
        after: str | None = None,
    ) -> list[dict[str, Any]]: ...


class DiscordApiError(RuntimeError):
    """Discord REST API failure with enough context for workflow logs."""

    def __init__(self, status_code: int, method: str, path: str, body: str) -> None:
        self.status_code = status_code
        self.method = method
        self.path = path
        self.body = body
        super().__init__(
            f"discord_api_error:{status_code}:{method}:{path}:{body[:200]}"
        )


def env_flag_enabled(name: str, default: bool = True) -> bool:
    """Read a boolean feature flag where common false strings opt out."""
    value = os.getenv(name)
    if value is None:
        return default
    return value.strip().lower() not in FALSE_ENV_VALUES


def positive_int(value: int | str | None, default: int) -> int:
    """Coerce positive integer config values with a safe default."""
    try:
        parsed = int(value) if value is not None else default
    except (TypeError, ValueError):
        return default
    return parsed if parsed > 0 else default


def bounded_discord_limit(value: int | str | None, default: int) -> int:
    """Clamp Discord page sizes to the documented 1-100 message/thread range."""
    return max(1, min(100, positive_int(value, default)))


def snowflake_int(value: str | None) -> int:
    """Parse a Discord snowflake as an integer, returning zero on bad input."""
    try:
        return int(str(value or "").strip())
    except (TypeError, ValueError):
        return 0


def newest_snowflake(values: list[str | None]) -> str | None:
    """Return the newest snowflake id from a sparse list."""
    parsed = [snowflake_int(value) for value in values if snowflake_int(value) > 0]
    return str(max(parsed)) if parsed else None


def oldest_snowflake(values: list[str | None]) -> str | None:
    """Return the oldest snowflake id from a sparse list."""
    parsed = [snowflake_int(value) for value in values if snowflake_int(value) > 0]
    return str(min(parsed)) if parsed else None


def discord_timestamp_to_datetime(value: str | None) -> dt.datetime | None:
    """Parse a Discord ISO timestamp into an aware UTC datetime."""
    if not value:
        return None
    try:
        parsed = dt.datetime.fromisoformat(value.replace("Z", "+00:00"))
    except ValueError:
        return None
    if parsed.tzinfo is None:
        parsed = parsed.replace(tzinfo=dt.timezone.utc)
    return parsed.astimezone(dt.timezone.utc)


def snowflake_to_datetime(value: str | None) -> dt.datetime | None:
    """Approximate a Discord object's creation time from its snowflake id."""
    snowflake = snowflake_int(value)
    if snowflake <= 0:
        return None
    timestamp_ms = (snowflake >> 22) + DISCORD_EPOCH_MS
    return dt.datetime.fromtimestamp(timestamp_ms / 1000, tz=dt.timezone.utc)


def _authorization_token() -> str:
    token = os.getenv("DISCORD_BOT_TOKEN", "").strip()
    if not token:
        raise RuntimeError("DISCORD_BOT_TOKEN is required for Discord ETL")
    return token


class HttpDiscordSyncClient:
    """Small blocking Discord REST client for scheduled ETL workflows."""

    def __init__(
        self,
        *,
        token: str | None = None,
        base_url: str | None = None,
        max_rate_limit_sleep_seconds: int = 60,
    ) -> None:
        self.token = token or _authorization_token()
        self.base_url = (
            base_url or os.getenv("DISCORD_API_URL") or "https://discord.com/api/v10"
        ).rstrip("/")
        self.max_rate_limit_sleep_seconds = max_rate_limit_sleep_seconds
        self._client = httpx.Client(timeout=30, follow_redirects=False, trust_env=True)

    def _request(
        self, method: str, path: str, params: dict[str, Any] | None = None
    ) -> Any:
        url = f"{self.base_url}{path}"
        headers = {
            "Authorization": f"Bot {self.token}",
            "User-Agent": "WarrunnerDiscordETL/1.0",
        }
        while True:
            response = self._client.request(method, url, headers=headers, params=params)
            if response.status_code == 429:
                retry_after = _retry_after_seconds(response)
                time.sleep(min(retry_after, self.max_rate_limit_sleep_seconds))
                continue
            if 200 <= response.status_code < 300:
                if not response.content:
                    return None
                return response.json()
            raise DiscordApiError(response.status_code, method, path, response.text)

    def list_guild_channels(self, guild_id: str) -> list[dict[str, Any]]:
        data = self._request("GET", f"/guilds/{quote(guild_id)}/channels")
        return data if isinstance(data, list) else []

    def list_active_threads(self, guild_id: str) -> list[dict[str, Any]]:
        data = self._request("GET", f"/guilds/{quote(guild_id)}/threads/active")
        threads = data.get("threads") if isinstance(data, dict) else []
        return threads if isinstance(threads, list) else []

    def list_public_archived_threads(
        self,
        channel_id: str,
        *,
        before: str | None = None,
        limit: int = 100,
    ) -> dict[str, Any]:
        params: dict[str, Any] = {"limit": bounded_discord_limit(limit, 100)}
        if before:
            params["before"] = before
        data = self._request(
            "GET",
            f"/channels/{quote(channel_id)}/threads/archived/public",
            params=params,
        )
        return data if isinstance(data, dict) else {"threads": [], "has_more": False}

    def get_messages_page(
        self,
        channel_id: str,
        *,
        limit: int = 100,
        before: str | None = None,
        after: str | None = None,
    ) -> list[dict[str, Any]]:
        params: dict[str, Any] = {"limit": bounded_discord_limit(limit, 100)}
        if before:
            params["before"] = before
        if after:
            params["after"] = after
        data = self._request(
            "GET", f"/channels/{quote(channel_id)}/messages", params=params
        )
        return data if isinstance(data, list) else []


def _retry_after_seconds(response: httpx.Response) -> float:
    try:
        body = response.json()
    except ValueError:
        body = {}
    retry_after = body.get("retry_after") if isinstance(body, dict) else None
    try:
        return max(float(retry_after), 0.1)
    except (TypeError, ValueError):
        return 1.0


def client() -> DiscordSyncClient:
    """Construct the live Discord REST client."""
    return HttpDiscordSyncClient()


def permission_signature(channel: dict[str, Any]) -> str:
    """Canonicalize Discord permission overwrites for category inheritance checks."""
    overwrites = channel.get("permission_overwrites")
    if not isinstance(overwrites, list):
        overwrites = []
    normalized = []
    for item in overwrites:
        if not isinstance(item, dict):
            continue
        normalized.append(
            {
                "id": str(item.get("id") or ""),
                "type": int(item.get("type") or 0),
                "allow": str(item.get("allow") or "0"),
                "deny": str(item.get("deny") or "0"),
            }
        )
    normalized.sort(
        key=lambda item: (item["type"], item["id"], item["allow"], item["deny"])
    )
    return canonical_json(normalized)


def channel_ref(channel: dict[str, Any], reason: str | None = None) -> dict[str, str]:
    """Return a compact channel reference for run summaries."""
    result = {
        "channel_id": str(channel.get("id") or ""),
        "channel_name": str(channel.get("name") or ""),
    }
    if reason:
        result["reason"] = reason
    return result


def failure_reason(error: str) -> str:
    """Map Discord/client errors to low-cardinality metric reasons."""
    lowered = error.lower()
    if "429" in lowered or "rate" in lowered:
        return "rate_limited"
    if "403" in lowered or "permission" in lowered or "forbidden" in lowered:
        return "permission_error"
    if "404" in lowered or "not_found" in lowered:
        return "not_found"
    if "discord_api_error" in lowered:
        return "api_error"
    if "write" in lowered or "database" in lowered or "postgres" in lowered:
        return "write_error"
    return "unknown_error"


def author_from_message(message: dict[str, Any]) -> dict[str, Any] | None:
    """Return a Discord user shape enriched with member display name when present."""
    author = message.get("author")
    if not isinstance(author, dict) or not author.get("id"):
        return None
    member = message.get("member") if isinstance(message.get("member"), dict) else {}
    merged = dict(author)
    if member.get("nick"):
        merged["display_name"] = member["nick"]
    elif author.get("global_name"):
        merged["display_name"] = author["global_name"]
    else:
        merged["display_name"] = author.get("username") or author.get("id")
    return merged


def users_from_messages(messages: list[dict[str, Any]]) -> list[dict[str, Any]]:
    """Extract unique authors from Discord message payloads."""
    seen: set[str] = set()
    users: list[dict[str, Any]] = []
    for message in messages:
        user = author_from_message(message)
        if not user:
            continue
        user_id = str(user.get("id") or "")
        if not user_id or user_id in seen:
            continue
        seen.add(user_id)
        users.append(user)
    return users


def channel_row(
    channel: dict[str, Any], *, guild_id: str, is_syncable: bool, reason: str = ""
) -> dict[str, Any]:
    """Project a Discord channel or thread into the DB upsert shape."""
    channel_type = int(channel.get("type") or 0)
    return {
        "channel_id": str(channel.get("id") or ""),
        "guild_id": str(channel.get("guild_id") or guild_id),
        "parent_id": str(channel.get("parent_id") or ""),
        "channel_name": str(channel.get("name") or ""),
        "channel_type": channel_type,
        "is_category": channel_type == DISCORD_CHANNEL_GUILD_CATEGORY,
        "is_thread": channel_type in THREAD_TYPES,
        "is_archived": bool((channel.get("thread_metadata") or {}).get("archived")),
        "is_syncable": is_syncable,
        "exclusion_reason": reason,
        "permission_signature": permission_signature(channel),
        "category_permission_signature": "",
        "raw_payload": channel,
    }


def message_row(
    message: dict[str, Any],
    *,
    run_id: str,
    guild_id: str,
    channel_id: str,
    parent_channel_id: str = "",
    is_thread_channel: bool = False,
) -> dict[str, Any]:
    """Project a Discord message into the DB upsert shape."""
    author = author_from_message(message)
    author_id = str(author.get("id") or "") if author else ""
    message_id = str(message.get("id") or "")
    thread_payload = (
        message.get("thread") if isinstance(message.get("thread"), dict) else {}
    )
    thread_id = (
        channel_id if is_thread_channel else str(thread_payload.get("id") or "") or None
    )
    content = str(message.get("content") or "")
    mentions = (
        message.get("mentions") if isinstance(message.get("mentions"), list) else []
    )
    return {
        "channel_id": channel_id,
        "message_id": message_id,
        "guild_id": guild_id,
        "parent_channel_id": parent_channel_id,
        "thread_id": thread_id,
        "occurred_at": discord_timestamp_to_datetime(
            str(message.get("timestamp") or "")
        )
        or snowflake_to_datetime(message_id),
        "edited_at": discord_timestamp_to_datetime(message.get("edited_timestamp")),
        "is_thread_root": bool(thread_id and thread_id == message_id),
        "author_id": author_id,
        "message_type": str(message.get("type") or "message"),
        "content": content,
        "attachment_count": len(message.get("attachments") or []),
        "embed_count": len(message.get("embeds") or []),
        "mention_user_ids": [
            str(item.get("id") or "")
            for item in mentions
            if isinstance(item, dict) and item.get("id")
        ],
        "raw_payload": message,
        "source_run_id": run_id,
    }


async def upsert_channels(pool, rows: list[dict[str, Any]]) -> int:
    """Upsert Discord channels and threads discovered by the ETL."""
    if not rows:
        return 0
    async with pool.acquire() as conn:
        async with conn.transaction():
            for row in rows:
                if not row["channel_id"]:
                    continue
                await conn.execute(
                    "INSERT INTO discord_sync_channels ("
                    "channel_id, guild_id, parent_id, channel_name, channel_type, "
                    "is_category, is_thread, is_archived, is_syncable, exclusion_reason, "
                    "permission_signature, category_permission_signature, raw_payload, "
                    "last_seen_at, updated_at"
                    ") VALUES ("
                    "$1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13::jsonb, NOW(), NOW()"
                    ") ON CONFLICT (channel_id) DO UPDATE SET "
                    "guild_id = EXCLUDED.guild_id, "
                    "parent_id = EXCLUDED.parent_id, "
                    "channel_name = EXCLUDED.channel_name, "
                    "channel_type = EXCLUDED.channel_type, "
                    "is_category = EXCLUDED.is_category, "
                    "is_thread = EXCLUDED.is_thread, "
                    "is_archived = EXCLUDED.is_archived, "
                    "is_syncable = EXCLUDED.is_syncable, "
                    "exclusion_reason = EXCLUDED.exclusion_reason, "
                    "permission_signature = EXCLUDED.permission_signature, "
                    "category_permission_signature = EXCLUDED.category_permission_signature, "
                    "raw_payload = EXCLUDED.raw_payload, "
                    "last_seen_at = NOW(), "
                    "updated_at = NOW()",
                    row["channel_id"],
                    row["guild_id"],
                    row["parent_id"],
                    row["channel_name"],
                    row["channel_type"],
                    row["is_category"],
                    row["is_thread"],
                    row["is_archived"],
                    row["is_syncable"],
                    row["exclusion_reason"],
                    row["permission_signature"],
                    row["category_permission_signature"],
                    canonical_json(row["raw_payload"]),
                )
    return len([row for row in rows if row.get("channel_id")])


async def upsert_users(pool, users: list[dict[str, Any]]) -> int:
    """Upsert Discord users seen in message payloads."""
    if not users:
        return 0
    async with pool.acquire() as conn:
        async with conn.transaction():
            for user in users:
                user_id = str(user.get("id") or "")
                if not user_id:
                    continue
                await conn.execute(
                    "INSERT INTO discord_sync_users ("
                    "user_id, username, global_name, display_name, is_bot, raw_payload, "
                    "last_seen_at, updated_at"
                    ") VALUES ($1, $2, $3, $4, $5, $6::jsonb, NOW(), NOW()) "
                    "ON CONFLICT (user_id) DO UPDATE SET "
                    "username = EXCLUDED.username, "
                    "global_name = EXCLUDED.global_name, "
                    "display_name = EXCLUDED.display_name, "
                    "is_bot = EXCLUDED.is_bot, "
                    "raw_payload = EXCLUDED.raw_payload, "
                    "last_seen_at = NOW(), "
                    "updated_at = NOW()",
                    user_id,
                    str(user.get("username") or ""),
                    str(user.get("global_name") or ""),
                    str(user.get("display_name") or ""),
                    bool(user.get("bot")),
                    canonical_json(user),
                )
    return len({str(user.get("id") or "") for user in users if user.get("id")})


async def upsert_messages(pool, rows: list[dict[str, Any]]) -> int:
    """Upsert Discord messages by their channel-scoped message id."""
    if not rows:
        return 0
    written = 0
    async with pool.acquire() as conn:
        async with conn.transaction():
            for row in rows:
                if not row["channel_id"] or not row["message_id"]:
                    continue
                status = await conn.execute(
                    "INSERT INTO discord_sync_messages ("
                    "channel_id, message_id, guild_id, parent_channel_id, thread_id, "
                    "occurred_at, edited_at, is_thread_root, author_id, message_type, "
                    "content, attachment_count, embed_count, mention_user_ids, raw_payload, "
                    "source_run_id, last_seen_at, updated_at"
                    ") SELECT "
                    "$1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, "
                    "$14::jsonb, $15::jsonb, $16, NOW(), NOW() "
                    "WHERE EXISTS ("
                    "    SELECT 1 FROM discord_sync_channels "
                    "    WHERE channel_id = $1 AND is_syncable = TRUE"
                    ") ON CONFLICT (channel_id, message_id) DO UPDATE SET "
                    "guild_id = EXCLUDED.guild_id, "
                    "parent_channel_id = EXCLUDED.parent_channel_id, "
                    "thread_id = EXCLUDED.thread_id, "
                    "occurred_at = EXCLUDED.occurred_at, "
                    "edited_at = EXCLUDED.edited_at, "
                    "is_thread_root = EXCLUDED.is_thread_root, "
                    "author_id = EXCLUDED.author_id, "
                    "message_type = EXCLUDED.message_type, "
                    "content = EXCLUDED.content, "
                    "attachment_count = EXCLUDED.attachment_count, "
                    "embed_count = EXCLUDED.embed_count, "
                    "mention_user_ids = EXCLUDED.mention_user_ids, "
                    "raw_payload = EXCLUDED.raw_payload, "
                    "source_run_id = EXCLUDED.source_run_id, "
                    "last_seen_at = NOW(), "
                    "updated_at = NOW()",
                    row["channel_id"],
                    row["message_id"],
                    row["guild_id"],
                    row["parent_channel_id"],
                    row["thread_id"],
                    row["occurred_at"],
                    row["edited_at"],
                    row["is_thread_root"],
                    row["author_id"],
                    row["message_type"],
                    row["content"],
                    row["attachment_count"],
                    row["embed_count"],
                    canonical_json(row["mention_user_ids"]),
                    canonical_json(row["raw_payload"]),
                    row["source_run_id"],
                )
                written += _status_row_count(status)
    return written


async def load_checkpoint(pool, channel_id: str) -> dict[str, Any] | None:
    """Load the current per-channel newest-message checkpoint."""
    row = await pool.fetchrow(
        "SELECT newest_message_id, last_error FROM discord_sync_checkpoints WHERE channel_id = $1",
        channel_id,
    )
    return dict(row) if row else None


async def update_checkpoint_success(
    pool,
    *,
    channel_id: str,
    newest_message_id: str | None,
    run_id: str,
) -> None:
    """Advance a channel checkpoint after writes for that channel succeed."""
    await pool.execute(
        "INSERT INTO discord_sync_checkpoints ("
        "channel_id, newest_message_id, last_run_id, last_success_at, last_error, updated_at"
        ") VALUES ($1, $2, $3, NOW(), '', NOW()) "
        "ON CONFLICT (channel_id) DO UPDATE SET "
        "newest_message_id = COALESCE(EXCLUDED.newest_message_id, discord_sync_checkpoints.newest_message_id), "
        "last_run_id = EXCLUDED.last_run_id, "
        "last_success_at = NOW(), "
        "last_error = '', "
        "updated_at = NOW()",
        channel_id,
        newest_message_id,
        run_id,
    )


async def update_checkpoint_failure(
    pool, *, channel_id: str, run_id: str, error: str
) -> None:
    """Record channel failure details without advancing the checkpoint."""
    await pool.execute(
        "INSERT INTO discord_sync_checkpoints ("
        "channel_id, last_run_id, last_error, updated_at"
        ") VALUES ($1, $2, $3, NOW()) "
        "ON CONFLICT (channel_id) DO UPDATE SET "
        "last_run_id = EXCLUDED.last_run_id, "
        "last_error = EXCLUDED.last_error, "
        "updated_at = NOW()",
        channel_id,
        run_id,
        error,
    )


async def stale_syncable_channel_ids(
    pool,
    *,
    guild_id: str,
    current_scope_ids: set[str],
    syncable_parent_ids: set[str],
) -> set[str]:
    """Return previously syncable channels no longer visible or parented by sync scope."""
    rows = await pool.fetch(
        "SELECT channel_id, parent_id, is_thread FROM discord_sync_channels "
        "WHERE guild_id = $1 AND is_syncable = TRUE",
        guild_id,
    )
    stale_ids: set[str] = set()
    for row in rows:
        channel_id = str(row["channel_id"] or "")
        parent_id = str(row["parent_id"] or "")
        if channel_id in current_scope_ids:
            continue
        if bool(row["is_thread"]) and parent_id in syncable_parent_ids:
            continue
        stale_ids.add(channel_id)
    return stale_ids


async def is_channel_syncable(pool, channel_id: str) -> bool:
    """Return whether a channel/thread is still in the current Discord sync scope."""
    row = await pool.fetchrow(
        "SELECT is_syncable FROM discord_sync_channels WHERE channel_id = $1",
        channel_id,
    )
    return bool(row and row["is_syncable"])


def _status_row_count(status: str) -> int:
    """Parse asyncpg command statuses like ``DELETE 3`` into row counts."""
    try:
        return int(str(status).rsplit(" ", 1)[1])
    except (IndexError, TypeError, ValueError):
        return 0


async def purge_channels_from_sync_scope(
    pool,
    channel_ids: list[str],
) -> dict[str, int]:
    """Delete stored Discord content derived from channels that left sync scope."""
    scoped_ids = sorted(
        {str(channel_id or "") for channel_id in channel_ids if channel_id}
    )
    if not scoped_ids:
        return {
            "channels": 0,
            "documents_deleted": 0,
            "messages_deleted": 0,
            "backfill_jobs_deleted": 0,
            "checkpoints_deleted": 0,
        }
    async with pool.acquire() as conn:
        async with conn.transaction():
            descendant_thread_ids = [
                str(row["channel_id"])
                for row in await conn.fetch(
                    "SELECT channel_id FROM discord_sync_channels "
                    "WHERE parent_id = ANY($1::text[])",
                    scoped_ids,
                )
            ]
            affected_ids = sorted(set(scoped_ids + descendant_thread_ids))
            message_thread_ids = [
                str(row["thread_id"])
                for row in await conn.fetch(
                    "SELECT DISTINCT thread_id FROM discord_sync_messages "
                    "WHERE (channel_id = ANY($1::text[]) "
                    "   OR parent_channel_id = ANY($1::text[]) "
                    "   OR thread_id = ANY($1::text[])) "
                    "  AND thread_id IS NOT NULL",
                    affected_ids,
                )
            ]
            affected_ids = sorted(set(affected_ids + message_thread_ids))
            await conn.execute(
                "UPDATE discord_sync_channels SET "
                "is_syncable = FALSE, "
                "exclusion_reason = COALESCE(NULLIF(exclusion_reason, ''), 'parent_excluded'), "
                "updated_at = NOW() "
                "WHERE channel_id = ANY($1::text[])",
                affected_ids,
            )
            deleted_docs = await conn.execute(
                "DELETE FROM company_context_documents "
                "WHERE source = 'discord' "
                "  AND (metadata->>'channel_id' = ANY($1::text[]) "
                "    OR metadata->>'thread_id' = ANY($1::text[]))",
                affected_ids,
            )
            deleted_messages = await conn.execute(
                "DELETE FROM discord_sync_messages "
                "WHERE channel_id = ANY($1::text[]) "
                "   OR parent_channel_id = ANY($1::text[]) "
                "   OR thread_id = ANY($1::text[])",
                affected_ids,
            )
            deleted_jobs = await conn.execute(
                "DELETE FROM discord_sync_backfill_jobs "
                "WHERE channel_id = ANY($1::text[])",
                affected_ids,
            )
            deleted_checkpoints = await conn.execute(
                "DELETE FROM discord_sync_checkpoints "
                "WHERE channel_id = ANY($1::text[])",
                affected_ids,
            )
    return {
        "channels": len(affected_ids),
        "documents_deleted": _status_row_count(deleted_docs),
        "messages_deleted": _status_row_count(deleted_messages),
        "backfill_jobs_deleted": _status_row_count(deleted_jobs),
        "checkpoints_deleted": _status_row_count(deleted_checkpoints),
    }


async def record_run_start(
    pool,
    *,
    run_id: str,
    workflow_run_id: str,
    mode: str,
    requested: list[dict[str, str]],
    skipped: list[dict[str, str]],
    metadata: dict[str, Any],
) -> None:
    """Insert or reset the Discord ETL run row."""
    await pool.execute(
        "INSERT INTO discord_sync_runs ("
        "run_id, workflow_run_id, mode, status, channels_requested, channels_skipped, metadata"
        ") VALUES ($1, $2, $3, 'running', $4::jsonb, $5::jsonb, $6::jsonb) "
        "ON CONFLICT (run_id) DO UPDATE SET "
        "workflow_run_id = EXCLUDED.workflow_run_id, "
        "mode = EXCLUDED.mode, "
        "status = 'running', "
        "channels_requested = EXCLUDED.channels_requested, "
        "channels_synced = '[]'::jsonb, "
        "channels_skipped = EXCLUDED.channels_skipped, "
        "channels_failed = '[]'::jsonb, "
        "messages_fetched = 0, "
        "messages_upserted = 0, "
        "threads_fetched = 0, "
        "threads_upserted = 0, "
        "finished_at = NULL, "
        "error_text = '', "
        "metadata = EXCLUDED.metadata",
        run_id,
        workflow_run_id,
        mode,
        canonical_json(requested),
        canonical_json(skipped),
        canonical_json(metadata),
    )


async def record_run_finish(
    pool,
    *,
    run_id: str,
    status: str,
    synced: list[dict[str, str]],
    skipped: list[dict[str, str]],
    failed: list[dict[str, str]],
    counts: dict[str, int],
    error_text: str = "",
) -> None:
    """Finalize a Discord sync run with channel outcomes and row counts."""
    await pool.execute(
        "UPDATE discord_sync_runs SET "
        "status = $2, channels_synced = $3::jsonb, channels_skipped = $4::jsonb, "
        "channels_failed = $5::jsonb, messages_fetched = $6, messages_upserted = $7, "
        "threads_fetched = $8, threads_upserted = $9, finished_at = NOW(), error_text = $10 "
        "WHERE run_id = $1",
        run_id,
        status,
        canonical_json(synced),
        canonical_json(skipped),
        canonical_json(failed),
        counts.get("messages_fetched", 0),
        counts.get("messages_upserted", 0),
        counts.get("threads_fetched", 0),
        counts.get("threads_upserted", 0),
        error_text,
    )


def workflow_run_id_to_sync_run_id(workflow_run_id: str) -> str:
    """Derive a stable Discord sync run id from a workflow run id."""
    safe_run_id = "".join(char if char.isalnum() else "_" for char in workflow_run_id)
    return f"discord_sync_{safe_run_id}"


async def enqueue_backfill_job(
    pool,
    *,
    job_key: str,
    job_type: str,
    channel_id: str,
    payload: dict[str, Any],
    run_id: str,
    priority: int = 100,
    refresh_completed: bool = True,
) -> None:
    """Store or refresh a queued Discord backfill job."""
    if not payload:
        return
    completion_guard = (
        ""
        if refresh_completed
        else " WHERE discord_sync_backfill_jobs.status <> 'completed'"
    )
    await pool.execute(
        "INSERT INTO discord_sync_backfill_jobs ("
        "job_key, job_type, payload_version, channel_id, status, payload_json, "
        "priority, next_attempt_at, last_run_id, last_enqueued_at, last_error, updated_at"
        ") VALUES ($1, $2, $3, $4, 'pending', $5::jsonb, $6, NOW(), $7, NOW(), '', NOW()) "
        "ON CONFLICT (job_key) DO UPDATE SET "
        "job_type = EXCLUDED.job_type, "
        "payload_version = EXCLUDED.payload_version, "
        "channel_id = EXCLUDED.channel_id, "
        "status = CASE "
        "    WHEN discord_sync_backfill_jobs.status = 'running' THEN discord_sync_backfill_jobs.status "
        "    ELSE 'pending' "
        "END, "
        "payload_json = CASE "
        "    WHEN discord_sync_backfill_jobs.status = 'running' THEN discord_sync_backfill_jobs.payload_json "
        "    ELSE EXCLUDED.payload_json "
        "END, "
        "priority = CASE "
        "    WHEN discord_sync_backfill_jobs.status = 'running' THEN discord_sync_backfill_jobs.priority "
        "    ELSE EXCLUDED.priority "
        "END, "
        "next_attempt_at = CASE "
        "    WHEN discord_sync_backfill_jobs.status = 'running' THEN discord_sync_backfill_jobs.next_attempt_at "
        "    ELSE NOW() "
        "END, "
        "attempt_count = CASE "
        "    WHEN discord_sync_backfill_jobs.status = 'running' THEN discord_sync_backfill_jobs.attempt_count "
        "    ELSE 0 "
        "END, "
        "last_run_id = EXCLUDED.last_run_id, "
        "last_enqueued_at = NOW(), "
        "last_completed_at = NULL, "
        "last_error = '', "
        "updated_at = NOW()" + completion_guard,
        job_key,
        job_type,
        BACKFILL_JOB_PAYLOAD_VERSION,
        channel_id,
        canonical_json(payload),
        priority,
        run_id,
    )


async def claim_backfill_jobs(pool, limit: int) -> list[dict[str, Any]]:
    """Claim a bounded batch of pending Discord backfill jobs."""
    async with pool.acquire() as conn:
        async with conn.transaction():
            rows = await conn.fetch(
                "WITH claimed AS ("
                "    SELECT jobs.job_id "
                "    FROM discord_sync_backfill_jobs jobs "
                "    JOIN discord_sync_channels channels "
                "      ON channels.channel_id = jobs.channel_id "
                "     AND channels.is_syncable = TRUE "
                "    WHERE jobs.status IN ('pending', 'failed') "
                "      AND (jobs.next_attempt_at IS NULL OR jobs.next_attempt_at <= NOW()) "
                "      AND jobs.attempt_count < 10 "
                "    ORDER BY jobs.priority, jobs.updated_at, jobs.job_id "
                "    LIMIT $1 "
                "    FOR UPDATE SKIP LOCKED"
                ") "
                "UPDATE discord_sync_backfill_jobs backfills "
                "SET status = 'running', "
                "    attempt_count = backfills.attempt_count + 1, "
                "    last_started_at = NOW(), "
                "    updated_at = NOW() "
                "FROM claimed "
                "WHERE backfills.job_id = claimed.job_id "
                "RETURNING backfills.job_id, backfills.job_key, backfills.job_type, "
                "backfills.payload_version, backfills.channel_id, backfills.payload_json, "
                "backfills.priority, backfills.attempt_count",
                limit,
            )
    return [dict(row) for row in rows]


async def mark_backfill_job_failed(
    pool, *, job_id: int, run_id: str, error: str
) -> None:
    """Return a claimed Discord backfill job to the queue as failed."""
    await pool.execute(
        "UPDATE discord_sync_backfill_jobs SET "
        "status = 'failed', last_run_id = $2, last_error = $3, "
        "next_attempt_at = NOW() + ((LEAST(POWER(2, LEAST(attempt_count, 6))::int, 60)::text || ' minutes')::interval), "
        "updated_at = NOW() "
        "WHERE job_id = $1",
        job_id,
        run_id,
        error,
    )


async def mark_backfill_job_completed(
    pool,
    *,
    job_id: int,
    run_id: str,
    payload: dict[str, Any] | None = None,
) -> None:
    """Mark a Discord backfill job as completed."""
    if payload is None:
        await pool.execute(
            "UPDATE discord_sync_backfill_jobs SET "
            "status = 'completed', last_run_id = $2, last_completed_at = NOW(), "
            "next_attempt_at = NULL, last_error = '', updated_at = NOW() "
            "WHERE job_id = $1",
            job_id,
            run_id,
        )
        return
    await pool.execute(
        "UPDATE discord_sync_backfill_jobs SET "
        "status = 'completed', last_run_id = $2, payload_json = $3::jsonb, "
        "last_completed_at = NOW(), next_attempt_at = NULL, last_error = '', updated_at = NOW() "
        "WHERE job_id = $1",
        job_id,
        run_id,
        canonical_json(payload),
    )


def decode_payload(job: dict[str, Any]) -> dict[str, Any]:
    """Decode a backfill job payload from asyncpg or JSON test doubles."""
    if int(job.get("payload_version") or 0) != BACKFILL_JOB_PAYLOAD_VERSION:
        raise RuntimeError(
            f"unsupported payload version for {job.get('job_key')}: {job.get('payload_version')}"
        )
    payload = job.get("payload_json")
    if isinstance(payload, str):
        try:
            payload = json.loads(payload)
        except json.JSONDecodeError as exc:
            raise RuntimeError(f"invalid payload for {job.get('job_key')}") from exc
    if not isinstance(payload, dict):
        raise RuntimeError(f"invalid payload for {job.get('job_key')}")
    return payload
