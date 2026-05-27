"""Search local Discord history exports mounted into a Warrunner sandbox."""

from __future__ import annotations

import json
import os
from pathlib import Path
from typing import Any

DEFAULT_LIMIT = 10
MAX_LIMIT = 50


class DiscordHistoryClient:
    def search(self, query: str, limit: int = DEFAULT_LIMIT) -> dict[str, Any]:
        """Search a local JSONL export for messages containing every query term."""
        export_path = Path(os.getenv("DISCORD_HISTORY_JSONL_PATH", "")).expanduser()
        if not export_path or not export_path.exists():
            return {
                "configured": False,
                "results": [],
                "hint": "Set DISCORD_HISTORY_JSONL_PATH to a mounted Discord JSONL export.",
            }

        terms = [term.lower() for term in query.split() if term.strip()]
        bounded_limit = max(1, min(int(limit), MAX_LIMIT))
        results: list[dict[str, Any]] = []
        with export_path.open("r", encoding="utf-8") as handle:
            for line in handle:
                if len(results) >= bounded_limit:
                    break
                try:
                    item = json.loads(line)
                except json.JSONDecodeError:
                    continue
                content = str(item.get("content") or item.get("text") or "")
                haystack = content.lower()
                if terms and not all(term in haystack for term in terms):
                    continue
                results.append(
                    {
                        "message_id": item.get("id") or item.get("message_id"),
                        "channel_id": item.get("channel_id"),
                        "thread_id": item.get("thread_id"),
                        "author_id": item.get("author_id") or item.get("user_id"),
                        "created_at": item.get("created_at") or item.get("timestamp"),
                        "content": content[:1000],
                    }
                )

        return {"configured": True, "results": results}


def _client() -> DiscordHistoryClient:
    return DiscordHistoryClient()
