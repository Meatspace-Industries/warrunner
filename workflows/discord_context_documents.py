"""Workflow: project synced Discord messages into company context documents."""

from __future__ import annotations

import datetime as dt
import hashlib
import os
import re
from dataclasses import dataclass, field
from typing import Any

from api.runtime_control import canonical_json, decode_jsonb
from api.vm_metrics import (
    observe_company_context_document_size,
    record_company_context_documents_changed,
)
from api.workflow_engine import WorkflowContext
from workflows.discord_sync_shared import env_flag_enabled, positive_int

WORKFLOW_NAME = "discord_context_documents"

DEFAULT_SYNC_INTERVAL_SECONDS = 4 * 60 * 60
DEFAULT_WATERMARK_OVERLAP_SECONDS = 60
DISCORD_MENTION_RE = re.compile(r"<@!?([0-9]+)>")
DISCORD_CHANNEL_RE = re.compile(r"<#([0-9]+)>")


SCHEDULE = {
    "schedule_id": "discord_context_documents",
    "interval_seconds": positive_int(
        os.getenv("DISCORD_CONTEXT_DOCUMENTS_INTERVAL_SECONDS")
        or os.getenv("COMPANY_CONTEXT_DOCUMENTS_INTERVAL_SECONDS"),
        DEFAULT_SYNC_INTERVAL_SECONDS,
    ),
    "enabled": (
        env_flag_enabled("DISCORD_ETL_ENABLED", default=False)
        and env_flag_enabled("DISCORD_CONTEXT_DOCUMENTS_ENABLED", default=True)
    ),
    "no_delivery": True,
}


@dataclass
class Input:
    """Runtime options for projecting Discord sync rows into context documents."""

    since: str | None = None
    watermark_overlap_seconds: int = DEFAULT_WATERMARK_OVERLAP_SECONDS
    metadata: dict[str, Any] = field(default_factory=dict)


def _nonnegative_int(value: int | str | None, default: int) -> int:
    try:
        parsed = int(value) if value is not None else default
    except (TypeError, ValueError):
        return default
    return parsed if parsed >= 0 else default


def _parse_datetime(value: str | None) -> dt.datetime | None:
    if not value:
        return None
    try:
        parsed = dt.datetime.fromisoformat(value.replace("Z", "+00:00"))
    except ValueError:
        return None
    if parsed.tzinfo is None:
        parsed = parsed.replace(tzinfo=dt.timezone.utc)
    return parsed.astimezone(dt.timezone.utc)


def _format_time(value: dt.datetime | None) -> str:
    if not value:
        return "unknown time"
    return value.astimezone(dt.timezone.utc).strftime("%Y-%m-%d %H:%M:%S UTC")


def _display_name(row: Any) -> str:
    for key in ("display_name", "global_name", "username", "author_id", "user_id"):
        value = row.get(key) if hasattr(row, "get") else row[key]
        if value:
            return str(value)
    return "Unknown"


def _sanitize_heading(text: str, limit: int = 90) -> str:
    cleaned = re.sub(r"\s+", " ", text).strip()
    return (cleaned or "Discord thread")[:limit]


def _content_hash(*parts: Any) -> str:
    return hashlib.sha256(canonical_json(parts).encode("utf-8")).hexdigest()


def _message_text(
    row: Any, *, users_by_id: dict[str, str], channels_by_id: dict[str, str]
) -> str:
    text = str(row["content"] or "")

    def user_repl(match: re.Match[str]) -> str:
        user_id = match.group(1)
        return f"@{users_by_id.get(user_id, user_id)}"

    def channel_repl(match: re.Match[str]) -> str:
        channel_id = match.group(1)
        return f"#{channels_by_id.get(channel_id, channel_id)}"

    resolved = DISCORD_MENTION_RE.sub(user_repl, text)
    resolved = DISCORD_CHANNEL_RE.sub(channel_repl, resolved)
    parts = [resolved.strip()] if resolved.strip() else []
    attachment_count = int(row["attachment_count"] or 0)
    embed_count = int(row["embed_count"] or 0)
    if attachment_count:
        parts.append(
            f"[{attachment_count} attachment{'s' if attachment_count != 1 else ''}]"
        )
    if embed_count:
        parts.append(f"[{embed_count} embed{'s' if embed_count != 1 else ''}]")
    return " ".join(parts).strip()


async def _latest_successful_watermark(pool, current_run_id: str) -> dt.datetime | None:
    row = await pool.fetchrow(
        "SELECT output_json FROM workflow_runs "
        "WHERE workflow_name = $1 "
        "  AND run_id <> $2 "
        "  AND status = 'completed' "
        "  AND output_json IS NOT NULL "
        "ORDER BY completed_at DESC NULLS LAST, updated_at DESC "
        "LIMIT 1",
        WORKFLOW_NAME,
        current_run_id,
    )
    if not row:
        return None
    output = decode_jsonb(row["output_json"], {})
    return _parse_datetime(str(output.get("watermark") or ""))


async def _load_lookup_maps(pool) -> tuple[dict[str, str], dict[str, str]]:
    users = await pool.fetch(
        "SELECT user_id, username, global_name, display_name FROM discord_sync_users",
    )
    channels = await pool.fetch(
        "SELECT channel_id, channel_name FROM discord_sync_channels",
    )
    users_by_id = {str(row["user_id"]): _display_name(row) for row in users}
    channels_by_id = {
        str(row["channel_id"]): str(row["channel_name"] or row["channel_id"])
        for row in channels
    }
    return users_by_id, channels_by_id


async def _load_changed_keys(pool, since: dt.datetime | None) -> dict[str, Any]:
    if since is None:
        where_sql = ""
        args: list[Any] = []
    else:
        where_sql = "WHERE m.updated_at > $1"
        args = [since]

    channel_day_rows = await pool.fetch(
        "SELECT DISTINCT m.channel_id, (m.occurred_at AT TIME ZONE 'UTC')::date AS day "
        "FROM discord_sync_messages m "
        "JOIN discord_sync_channels c ON c.channel_id = m.channel_id "
        f"{where_sql} "
        f"{'AND' if where_sql else 'WHERE'} m.occurred_at IS NOT NULL "
        "  AND c.is_syncable = TRUE "
        "  AND c.is_thread = FALSE "
        "ORDER BY m.channel_id, day",
        *args,
    )
    thread_rows = await pool.fetch(
        "SELECT DISTINCT COALESCE(m.thread_id, m.channel_id) AS thread_id "
        "FROM discord_sync_messages m "
        "JOIN discord_sync_channels c ON c.channel_id = m.channel_id "
        "LEFT JOIN discord_sync_channels tc ON tc.channel_id = COALESCE(m.thread_id, m.channel_id) "
        f"{where_sql} "
        f"{'AND' if where_sql else 'WHERE'} (c.is_thread = TRUE OR m.thread_id IS NOT NULL) "
        "  AND c.is_syncable = TRUE "
        "  AND COALESCE(tc.is_syncable, c.is_syncable) = TRUE "
        "ORDER BY thread_id",
        *args,
    )
    stats = await pool.fetchrow(
        "SELECT COUNT(*) AS changed_messages, MAX(m.updated_at) AS max_updated_at "
        f"FROM discord_sync_messages m {where_sql}",
        *args,
    )
    max_updated_at = stats["max_updated_at"] if stats else None
    if isinstance(max_updated_at, dt.datetime):
        max_updated_at = max_updated_at.astimezone(dt.timezone.utc)
    return {
        "channel_days": [
            (str(row["channel_id"]), row["day"])
            for row in channel_day_rows
            if isinstance(row["day"], dt.date)
        ],
        "threads": [str(row["thread_id"]) for row in thread_rows if row["thread_id"]],
        "changed_messages": int(stats["changed_messages"] or 0) if stats else 0,
        "max_updated_at": max_updated_at,
    }


async def _load_channel_day_messages(pool, channel_id: str, day: dt.date) -> list[Any]:
    start = dt.datetime.combine(day, dt.time.min, tzinfo=dt.timezone.utc)
    end = start + dt.timedelta(days=1)
    return list(
        await pool.fetch(
            "SELECT m.channel_id, c.channel_name, m.message_id, m.occurred_at, "
            "m.thread_id, m.author_id, u.username, u.global_name, u.display_name, "
            "m.content, m.attachment_count, m.embed_count, m.updated_at "
            "FROM discord_sync_messages m "
            "LEFT JOIN discord_sync_channels c ON c.channel_id = m.channel_id "
            "LEFT JOIN discord_sync_users u ON u.user_id = m.author_id "
            "WHERE m.channel_id = $1 "
            "  AND c.is_syncable = TRUE "
            "  AND m.occurred_at >= $2 "
            "  AND m.occurred_at < $3 "
            "ORDER BY m.occurred_at, m.message_id",
            channel_id,
            start,
            end,
        )
    )


async def _load_thread_messages(pool, thread_id: str) -> list[Any]:
    return list(
        await pool.fetch(
            "SELECT m.channel_id, m.guild_id, c.channel_name, "
            "tc.channel_name AS thread_name, tc.parent_id AS thread_parent_id, "
            "pc.channel_name AS parent_name, "
            "m.message_id, m.occurred_at, m.thread_id, m.is_thread_root, "
            "m.author_id, u.username, u.global_name, u.display_name, m.content, "
            "m.attachment_count, m.embed_count, m.updated_at "
            "FROM discord_sync_messages m "
            "LEFT JOIN discord_sync_channels c ON c.channel_id = m.channel_id "
            "LEFT JOIN discord_sync_channels tc ON tc.channel_id = COALESCE(m.thread_id, m.channel_id) "
            "LEFT JOIN discord_sync_channels pc ON pc.channel_id = tc.parent_id "
            "LEFT JOIN discord_sync_users u ON u.user_id = m.author_id "
            "WHERE (m.channel_id = $1 OR m.thread_id = $1) "
            "  AND c.is_syncable = TRUE "
            "  AND COALESCE(tc.is_syncable, c.is_syncable) = TRUE "
            "ORDER BY m.occurred_at, m.message_id",
            thread_id,
        )
    )


def _channel_day_document(
    *,
    channel_id: str,
    day: dt.date,
    messages: list[Any],
    users_by_id: dict[str, str],
    channels_by_id: dict[str, str],
) -> dict[str, Any] | None:
    if not messages:
        return None
    channel_name = str(
        messages[0]["channel_name"] or channels_by_id.get(channel_id) or channel_id
    )
    title = f"#{channel_name} - {day.isoformat()}"
    lines = [f"# {title}", ""]
    last_updated = max(
        row["updated_at"].astimezone(dt.timezone.utc) for row in messages
    )
    occurred_at = messages[0]["occurred_at"]
    for row in messages:
        text = _message_text(
            row, users_by_id=users_by_id, channels_by_id=channels_by_id
        )
        if not text:
            continue
        lines.extend(
            [
                f"### {_display_name(row)} - {_format_time(row['occurred_at'])}",
                "",
                text,
                "",
            ]
        )
    body = "\n".join(lines).strip()
    metadata = {
        "channel_id": channel_id,
        "channel_name": channel_name,
        "date": day.isoformat(),
        "message_count": len(messages),
        "aggregation": "channel_day",
    }
    return {
        "document_id": f"discord:channel_day:{channel_id}:{day.isoformat()}",
        "source": "discord",
        "source_type": "discord_channel_day",
        "source_document_id": f"{channel_id}:{day.isoformat()}",
        "source_chunk_id": "",
        "parent_document_id": None,
        "title": title,
        "body": body,
        "url": "",
        "author_id": "",
        "author_name": "",
        "access_scope": "company",
        "occurred_at": occurred_at,
        "source_updated_at": last_updated,
        "content_hash": _content_hash(title, body, "", metadata),
        "metadata": metadata,
    }


def _thread_document(
    *,
    thread_id: str,
    messages: list[Any],
    users_by_id: dict[str, str],
    channels_by_id: dict[str, str],
) -> dict[str, Any] | None:
    if not messages:
        return None
    first = messages[0]
    thread_name = str(
        first["thread_name"]
        or first["channel_name"]
        or channels_by_id.get(thread_id)
        or "Discord thread"
    )
    parent_name = str(first["parent_name"] or "")
    first_text = _message_text(
        first, users_by_id=users_by_id, channels_by_id=channels_by_id
    )
    title = (
        thread_name
        if thread_name and thread_name != thread_id
        else _sanitize_heading(first_text)
    )
    participants = sorted({_display_name(row) for row in messages if row["author_id"]})
    last_updated = max(
        row["updated_at"].astimezone(dt.timezone.utc) for row in messages
    )
    guild_id = str(first["guild_id"] or "")
    url = f"https://discord.com/channels/{guild_id}/{thread_id}/{first['message_id']}"
    lines = [
        f"# {title}",
        "",
        f"- Started: {_format_time(first['occurred_at'])}",
        f"- Participants: {', '.join(participants)}",
        f"- Messages: {len(messages)}",
        "",
        "---",
        "",
    ]
    if parent_name:
        lines.insert(2, f"- Parent channel: #{parent_name}")
    for row in messages:
        text = _message_text(
            row, users_by_id=users_by_id, channels_by_id=channels_by_id
        )
        if not text:
            continue
        lines.extend(
            [
                f"### {_display_name(row)} - {_format_time(row['occurred_at'])}",
                "",
                text,
                "",
            ]
        )
    body = "\n".join(lines).strip()
    metadata = {
        "thread_id": thread_id,
        "channel_name": thread_name,
        "parent_channel_name": parent_name,
        "message_count": len(messages),
        "participants": participants,
        "aggregation": "thread",
    }
    return {
        "document_id": f"discord:thread:{thread_id}",
        "source": "discord",
        "source_type": "discord_thread",
        "source_document_id": thread_id,
        "source_chunk_id": "",
        "parent_document_id": None,
        "title": title,
        "body": body,
        "url": url,
        "author_id": str(first["author_id"] or ""),
        "author_name": _display_name(first),
        "access_scope": "company",
        "occurred_at": first["occurred_at"],
        "source_updated_at": last_updated,
        "content_hash": _content_hash(title, body, url, metadata),
        "metadata": metadata,
    }


async def _upsert_document(pool, document: dict[str, Any]) -> str:
    existing_hash = await pool.fetchval(
        "SELECT content_hash FROM company_context_documents WHERE document_id = $1",
        document["document_id"],
    )
    if existing_hash == document["content_hash"]:
        return "noop"
    status = await pool.execute(
        "INSERT INTO company_context_documents ("
        "document_id, source, source_type, source_document_id, source_chunk_id, "
        "parent_document_id, title, body, url, author_id, author_name, access_scope, "
        "occurred_at, source_updated_at, content_hash, metadata, updated_at"
        ") VALUES ("
        "$1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, "
        "$15, $16::jsonb, NOW()"
        ") ON CONFLICT (document_id) DO UPDATE SET "
        "source = EXCLUDED.source, "
        "source_type = EXCLUDED.source_type, "
        "source_document_id = EXCLUDED.source_document_id, "
        "source_chunk_id = EXCLUDED.source_chunk_id, "
        "parent_document_id = EXCLUDED.parent_document_id, "
        "title = EXCLUDED.title, "
        "body = EXCLUDED.body, "
        "url = EXCLUDED.url, "
        "author_id = EXCLUDED.author_id, "
        "author_name = EXCLUDED.author_name, "
        "access_scope = EXCLUDED.access_scope, "
        "occurred_at = EXCLUDED.occurred_at, "
        "source_updated_at = EXCLUDED.source_updated_at, "
        "content_hash = EXCLUDED.content_hash, "
        "metadata = EXCLUDED.metadata, "
        "updated_at = NOW() "
        "WHERE company_context_documents.content_hash IS DISTINCT FROM EXCLUDED.content_hash",
        document["document_id"],
        document["source"],
        document["source_type"],
        document["source_document_id"],
        document["source_chunk_id"],
        document["parent_document_id"],
        document["title"],
        document["body"],
        document["url"],
        document["author_id"],
        document["author_name"],
        document["access_scope"],
        document["occurred_at"],
        document["source_updated_at"],
        document["content_hash"],
        canonical_json(document["metadata"]),
    )
    if not status.endswith(" 1"):
        return "noop"
    return "updated" if existing_hash else "inserted"


async def _delete_document(pool, document_id: str) -> bool:
    status = await pool.execute(
        "DELETE FROM company_context_documents WHERE document_id = $1",
        document_id,
    )
    return status.endswith(" 1")


async def handler(inp: Input, ctx: WorkflowContext) -> dict[str, Any]:
    """Project changed Discord sync rows into searchable company context documents."""
    if not (
        env_flag_enabled("DISCORD_ETL_ENABLED", default=False)
        and env_flag_enabled("DISCORD_CONTEXT_DOCUMENTS_ENABLED", default=True)
    ):
        ctx.log("discord_context_documents_skipped_disabled")
        return {"status": "skipped", "reason": "discord_context_documents_disabled"}

    explicit_since = _parse_datetime(inp.since)
    last_watermark = explicit_since or await _latest_successful_watermark(
        ctx._pool, ctx.run_id
    )
    overlap_seconds = _nonnegative_int(
        inp.watermark_overlap_seconds,
        DEFAULT_WATERMARK_OVERLAP_SECONDS,
    )
    since = (
        last_watermark - dt.timedelta(seconds=overlap_seconds)
        if last_watermark is not None
        else None
    )

    users_by_id, channels_by_id = await _load_lookup_maps(ctx._pool)
    changed = await _load_changed_keys(ctx._pool, since)
    documents_upserted = 0
    documents_deleted = 0

    for channel_id, day in changed["channel_days"]:
        messages = await _load_channel_day_messages(ctx._pool, channel_id, day)
        document = _channel_day_document(
            channel_id=channel_id,
            day=day,
            messages=messages,
            users_by_id=users_by_id,
            channels_by_id=channels_by_id,
        )
        if document is None:
            if await _delete_document(
                ctx._pool,
                f"discord:channel_day:{channel_id}:{day.isoformat()}",
            ):
                documents_deleted += 1
            continue
        observe_company_context_document_size(
            "discord",
            str(document["source_type"]),
            len(str(document["body"] or "")),
        )
        action = await _upsert_document(ctx._pool, document)
        record_company_context_documents_changed(
            "discord", str(document["source_type"]), action
        )
        if action in {"inserted", "updated"}:
            documents_upserted += 1

    for thread_id in changed["threads"]:
        messages = await _load_thread_messages(ctx._pool, thread_id)
        document = _thread_document(
            thread_id=thread_id,
            messages=messages,
            users_by_id=users_by_id,
            channels_by_id=channels_by_id,
        )
        if document is None:
            if await _delete_document(ctx._pool, f"discord:thread:{thread_id}"):
                documents_deleted += 1
            continue
        observe_company_context_document_size(
            "discord",
            str(document["source_type"]),
            len(str(document["body"] or "")),
        )
        action = await _upsert_document(ctx._pool, document)
        record_company_context_documents_changed(
            "discord", str(document["source_type"]), action
        )
        if action in {"inserted", "updated"}:
            documents_upserted += 1

    watermark = changed["max_updated_at"] or last_watermark
    result = {
        "status": "completed",
        "changed_messages": changed["changed_messages"],
        "channel_day_documents": len(changed["channel_days"]),
        "thread_candidates": len(changed["threads"]),
        "documents_upserted": documents_upserted,
        "documents_deleted": documents_deleted,
        "watermark": watermark.isoformat() if watermark else None,
    }
    ctx.log("discord_context_documents_completed", **result)
    return result
