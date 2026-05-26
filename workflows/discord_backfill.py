"""Workflow: drain Discord historical message and thread backfill jobs."""

from __future__ import annotations

import asyncio
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
    bounded_discord_limit,
    channel_ref,
    channel_row,
    claim_backfill_jobs,
    client as shared_client,
    decode_payload,
    enqueue_backfill_job,
    env_flag_enabled,
    failure_reason,
    is_channel_syncable,
    mark_backfill_job_completed,
    mark_backfill_job_failed,
    message_row,
    oldest_snowflake,
    positive_int,
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


async def _process_thread_discovery_job(
    *,
    pool,
    api_client,
    job: dict[str, Any],
    payload: dict[str, Any],
    run_id: str,
    limit: int,
) -> tuple[int, int]:
    channel_id = str(job["channel_id"])
    guild_id = str(payload.get("guild_id") or "")
    before = str(payload.get("before") or "") or None
    if not await is_channel_syncable(pool, channel_id):
        return 0, 0
    page = await asyncio.to_thread(
        api_client.list_public_archived_threads,
        channel_id,
        before=before,
        limit=limit,
    )
    if not await is_channel_syncable(pool, channel_id):
        return 0, 0
    threads = [thread for thread in page.get("threads", []) if isinstance(thread, dict)]
    thread_rows = [
        channel_row(thread, guild_id=guild_id, is_syncable=True) for thread in threads
    ]
    upserted = await upsert_channels(pool, thread_rows)
    for thread in threads:
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
) -> tuple[int, int, str | None]:
    channel_id = str(job["channel_id"])
    guild_id = str(payload.get("guild_id") or "")
    parent_channel_id = str(payload.get("parent_channel_id") or "")
    is_thread_channel = bool(payload.get("is_thread_channel"))
    before_id = str(payload.get("before_id") or "") or None
    if not await is_channel_syncable(pool, channel_id):
        return 0, 0, None
    total_fetched = 0
    total_upserted = 0
    next_before = before_id

    for _ in range(max(1, pages_per_job)):
        page = await asyncio.to_thread(
            api_client.get_messages_page,
            channel_id,
            limit=limit,
            before=next_before,
        )
        if not page:
            next_before = None
            break
        if not await is_channel_syncable(pool, channel_id):
            return total_fetched, total_upserted, None
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
        next_before = oldest_snowflake(
            [str(message.get("id") or "") for message in page]
        )
        if len(page) < limit:
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
    jobs = await claim_backfill_jobs(ctx._pool, channel_batch_limit)
    if not jobs:
        ctx.log("discord_backfill_skipped_no_jobs")
        return {"status": "skipped", "reason": "no_pending_backfills"}

    api_client = shared_client()
    run_id = workflow_run_id_to_sync_run_id(ctx.run_id)
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
        },
    )

    synced: list[dict[str, str]] = []
    failed: list[dict[str, str]] = []
    counts = {
        "messages_fetched": 0,
        "messages_upserted": 0,
        "threads_fetched": 0,
        "threads_upserted": 0,
    }

    for job in jobs:
        job_id = int(job["job_id"])
        channel_id = str(job["channel_id"] or "")
        try:
            payload = decode_payload(job)
            job_type = str(job.get("job_type") or "")
            if job_type == BACKFILL_JOB_THREAD_DISCOVERY:
                fetched, upserted = await _process_thread_discovery_job(
                    pool=ctx._pool,
                    api_client=api_client,
                    job=job,
                    payload=payload,
                    run_id=run_id,
                    limit=limit,
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
