"""Workflow: daily company brief posted to the warrunner home Discord channel.

Summarizes yesterday's Discord conversations and GitHub activity (PRs landed,
issues moved) from the synced company context documents, and posts the brief
into a Discord channel via the final-delivery outbox.
"""

from __future__ import annotations

import datetime as dt
import os
import re
from typing import Any
from zoneinfo import ZoneInfo

from api.workflow_engine import WorkflowContext
from workflows.discord_sync_shared import env_flag_enabled

WORKFLOW_NAME = "daily_brief"

DEFAULT_CRON = "0 8 * * *"
DEFAULT_TIMEZONE = "America/Los_Angeles"
NO_SIGNAL_SENTINEL = "NO_SIGNAL"

SCHEDULE = {
    "schedule_id": "daily_brief",
    "cron": os.getenv("DAILY_BRIEF_CRON", DEFAULT_CRON),
    "timezone": os.getenv("DAILY_BRIEF_TIMEZONE", DEFAULT_TIMEZONE),
    "enabled": env_flag_enabled("DAILY_BRIEF_ENABLED", default=True),
    "no_delivery": True,
}


def _brief_channel_id() -> str | None:
    explicit = (os.getenv("WARRUNNER_DAILY_BRIEF_CHANNEL_ID") or "").strip()
    if explicit:
        return explicit
    home = (os.getenv("WARRUNNER_HOME_CHANNEL_IDS") or "").strip()
    if home:
        first = re.split(r"[\s,;]+", home)[0].strip()
        return first or None
    return None


def _brief_window(now: dt.datetime | None = None) -> tuple[dt.date, str, str]:
    """Yesterday's date in the brief timezone plus its UTC bounds."""
    tz = ZoneInfo(os.getenv("DAILY_BRIEF_TIMEZONE", DEFAULT_TIMEZONE))
    local_now = (now or dt.datetime.now(dt.timezone.utc)).astimezone(tz)
    yesterday = (local_now - dt.timedelta(days=1)).date()
    start = dt.datetime.combine(yesterday, dt.time.min, tzinfo=tz)
    end = start + dt.timedelta(days=1)
    return (
        yesterday,
        start.astimezone(dt.timezone.utc).isoformat(),
        end.astimezone(dt.timezone.utc).isoformat(),
    )


def _build_prompt(brief_date: dt.date, window_start: str, window_end: str) -> str:
    return (
        "Write today's internal daily brief covering what happened in the "
        f"company yesterday, {brief_date.isoformat()} "
        f"(UTC window {window_start} to {window_end}).\n\n"
        "Source your material from the synced company context documents using "
        "the `company_context` tool's `search` method:\n"
        "- Discord activity: search documents with source `discord` "
        "(source types `discord_channel_day` and `discord_thread`) dated "
        "yesterday. These contain the full conversation logs per channel and "
        "thread.\n"
        "- GitHub activity: search documents with source `github` (source "
        "types `github_pr` and `github_issue`). Report pull requests merged "
        "or opened yesterday and notable issue movement. If no GitHub "
        "documents exist yet, omit the section.\n\n"
        "Output a concise brief in Discord-flavored markdown with these "
        "sections, including a section only when it has real signal:\n"
        "- **Key discussions & decisions** — what was discussed where, and "
        "any decisions made or directions chosen\n"
        "- **PRs landed** — merged PRs with one-line descriptions\n"
        "- **In progress** — notable open PRs and active work\n"
        "- **Open questions / blocked** — unanswered questions and blockers "
        "that need an owner\n\n"
        "Write clean, specific prose attributed to people and channels — not "
        "a vague rollup and not a raw link dump. Keep the whole brief under "
        "1800 characters when possible. Do not invent activity; if a source "
        "has no signal, leave its section out. If there was no meaningful "
        f"activity at all, reply with exactly `{NO_SIGNAL_SENTINEL}` and "
        "nothing else."
    )


async def handler(inp: dict[str, Any], ctx: WorkflowContext) -> dict[str, Any]:
    channel_id = str(
        (inp.get("channel_id") if isinstance(inp, dict) else None)
        or _brief_channel_id()
        or ""
    ).strip()
    if not channel_id:
        ctx.log("daily_brief_skipped_no_channel")
        return {"status": "skipped", "reason": "daily_brief_channel_unconfigured"}

    brief_date, window_start, window_end = _brief_window()
    result = await ctx.agent_turn(
        _build_prompt(brief_date, window_start, window_end)
    )
    text = str(result.get("result_text") or "").strip()
    if not text or text == NO_SIGNAL_SENTINEL:
        ctx.log("daily_brief_no_signal", brief_date=brief_date.isoformat())
        return {
            "status": "completed",
            "brief_date": brief_date.isoformat(),
            "posted": False,
        }

    header = f"**Daily brief — {brief_date.isoformat()}**\n\n"
    await ctx.enqueue_final_delivery(
        "daily_brief_post",
        thread_key=f"workflow:{ctx.run_id}",
        delivery={"platform": "discord", "channel_id": channel_id},
        final_payload={
            "result_text": f"{header}{text}",
            "workflow_run_id": ctx.run_id,
        },
        delivery_id=f"workflow:{ctx.run_id}:daily-brief",
    )
    return {
        "status": "completed",
        "brief_date": brief_date.isoformat(),
        "posted": True,
        "channel_id": channel_id,
        "brief_text": text,
    }
