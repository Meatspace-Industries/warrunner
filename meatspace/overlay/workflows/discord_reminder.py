"""Workflow: durable Discord reminder delivery."""

from __future__ import annotations

import datetime as dt
import re
from dataclasses import dataclass, field
from typing import Any

from api.runtime_control import ControlPlaneError
from api.workflow_engine import WorkflowContext

WORKFLOW_NAME = "discord_reminder"
_DISCORD_USER_ID_RE = re.compile(r"^\d{1,32}$")


@dataclass
class Input:
    thread_key: str = ""
    delivery: dict[str, Any] = field(default_factory=dict)
    message_id: str | None = None
    user_id: str | None = None
    reminder_text: str = ""
    due_at: str = ""
    requested_delay_seconds: int | None = None
    metadata: dict[str, Any] = field(default_factory=dict)


def _parse_due_at(raw: str) -> dt.datetime:
    value = raw.strip()
    if not value:
        raise ControlPlaneError(
            "INVALID_REMINDER_INPUT",
            "discord_reminder requires due_at",
            422,
        )
    try:
        parsed = dt.datetime.fromisoformat(value.replace("Z", "+00:00"))
    except ValueError as exc:
        raise ControlPlaneError(
            "INVALID_REMINDER_INPUT",
            f"invalid reminder due_at: {value}",
            422,
        ) from exc
    if parsed.tzinfo is None:
        parsed = parsed.replace(tzinfo=dt.timezone.utc)
    return parsed.astimezone(dt.timezone.utc)


def _reminder_user_id(user_id: str | None) -> str | None:
    value = (user_id or "").strip()
    if not value or not _DISCORD_USER_ID_RE.fullmatch(value):
        return None
    return value


def _reminder_message(reminder_text: str, *, user_id: str | None = None) -> str:
    text = reminder_text.strip() or "you asked me to remind you"
    prefix = f"<@{user_id}> " if user_id else ""
    return f"{prefix}Reminder: {text}"


def _delivery_with_discord_defaults(delivery: dict[str, Any]) -> dict[str, Any]:
    result = dict(delivery or {})
    result.setdefault("platform", "discord")
    return result


async def handler(inp: Input, ctx: WorkflowContext) -> dict[str, Any]:
    thread_key = inp.thread_key.strip()
    if not thread_key:
        raise ControlPlaneError(
            "INVALID_REMINDER_INPUT",
            "discord_reminder requires thread_key",
            422,
        )
    due_at = _parse_due_at(inp.due_at)
    reminder_text = inp.reminder_text.strip() or "you asked me to remind you"
    reminder_user_id = _reminder_user_id(inp.user_id)
    delivery = _delivery_with_discord_defaults(inp.delivery)

    await ctx.sleep_until("wait_until_due", due_at)
    final_payload = {
        "result_text": _reminder_message(reminder_text, user_id=reminder_user_id),
        "workflow_run_id": ctx.run_id,
        "reminder_due_at": due_at.isoformat(),
        "reminder_text": reminder_text,
        "requested_delay_seconds": inp.requested_delay_seconds,
        "metadata": {
            **dict(inp.metadata or {}),
            "workflow_name": WORKFLOW_NAME,
            "message_id": inp.message_id,
            "user_id": inp.user_id,
        },
    }
    if reminder_user_id:
        final_payload["allowed_mention_user_ids"] = [reminder_user_id]
    queued = await ctx.enqueue_final_delivery(
        "deliver_discord_reminder",
        thread_key=thread_key,
        delivery=delivery,
        final_payload=final_payload,
        delivery_id=f"workflow:{ctx.run_id}:discord-reminder",
    )
    return {
        "ok": True,
        "kind": "discord_reminder_delivered",
        "due_at": due_at.isoformat(),
        "reminder_text": reminder_text,
        "delivery": queued,
    }
