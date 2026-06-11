"""Workflow: project GitHub PRs and issues into company context documents."""

from __future__ import annotations

import datetime as dt
import hashlib
import os
from dataclasses import dataclass, field
from typing import Any

import httpx

from api.github_app import mint_github_app_installation_token
from api.github_repos import (
    configured_github_repo_aliases,
    configured_github_repo_list,
)
from api.runtime_control import canonical_json, decode_jsonb
from api.vm_metrics import (
    observe_company_context_document_size,
    record_company_context_documents_changed,
)
from api.workflow_engine import WorkflowContext
from workflows.discord_sync_shared import env_flag_enabled, positive_int

WORKFLOW_NAME = "github_context_documents"

DEFAULT_SYNC_INTERVAL_SECONDS = 15 * 60
DEFAULT_WATERMARK_OVERLAP_SECONDS = 60
DEFAULT_PAGE_LIMIT = 100
DEFAULT_MAX_PAGES_PER_REPO = 10
MAX_DOCUMENT_BODY_CHARS = 20_000

SCHEDULE = {
    "schedule_id": "github_context_documents",
    "interval_seconds": positive_int(
        os.getenv("GITHUB_CONTEXT_DOCUMENTS_INTERVAL_SECONDS"),
        DEFAULT_SYNC_INTERVAL_SECONDS,
    ),
    "enabled": (
        env_flag_enabled("GITHUB_ETL_ENABLED", default=False)
        and env_flag_enabled("GITHUB_CONTEXT_DOCUMENTS_ENABLED", default=True)
    ),
    "no_delivery": True,
}


@dataclass
class Input:
    """Runtime options for projecting GitHub PRs/issues into context documents."""

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


def _content_hash(*parts: Any) -> str:
    return hashlib.sha256(canonical_json(parts).encode("utf-8")).hexdigest()


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


async def _github_token(repo: str) -> str | None:
    token = await mint_github_app_installation_token(repository=repo)
    if token:
        return token
    return (os.getenv("GITHUB_TOKEN") or "").strip() or None


async def _fetch_changed_items(
    client: httpx.AsyncClient,
    *,
    repo: str,
    token: str,
    since: dt.datetime | None,
    max_pages: int,
) -> list[dict[str, Any]]:
    """Fetch issues + PRs (the issues API covers both) updated after ``since``."""
    items: list[dict[str, Any]] = []
    headers = {
        "Accept": "application/vnd.github+json",
        "Authorization": f"Bearer {token}",
        "X-GitHub-Api-Version": "2022-11-28",
    }
    params: dict[str, Any] = {
        "state": "all",
        "sort": "updated",
        "direction": "desc",
        "per_page": DEFAULT_PAGE_LIMIT,
    }
    if since is not None:
        params["since"] = (
            since.astimezone(dt.timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")
        )
    api_url = (os.getenv("GITHUB_API_URL") or "https://api.github.com").rstrip("/")
    for page in range(1, max_pages + 1):
        response = await client.get(
            f"{api_url}/repos/{repo}/issues",
            headers=headers,
            params={**params, "page": page},
        )
        response.raise_for_status()
        batch = response.json()
        if not isinstance(batch, list) or not batch:
            break
        items.extend(item for item in batch if isinstance(item, dict))
        if len(batch) < DEFAULT_PAGE_LIMIT:
            break
    return items


def _item_document(repo: str, item: dict[str, Any]) -> dict[str, Any] | None:
    number = item.get("number")
    if not isinstance(number, int):
        return None
    pull_request = item.get("pull_request")
    is_pr = isinstance(pull_request, dict)
    kind = "pr" if is_pr else "issue"
    title = str(item.get("title") or "").strip() or f"{repo}#{number}"
    state = str(item.get("state") or "unknown")
    merged_at = _parse_datetime(
        str((pull_request or {}).get("merged_at") or "") if is_pr else None
    )
    if is_pr and state == "closed":
        state = "merged" if merged_at else "closed (unmerged)"
    author = str((item.get("user") or {}).get("login") or "")
    labels = sorted(
        str(label.get("name") or "")
        for label in item.get("labels") or []
        if isinstance(label, dict) and label.get("name")
    )
    created_at = _parse_datetime(str(item.get("created_at") or ""))
    updated_at = _parse_datetime(str(item.get("updated_at") or ""))
    closed_at = _parse_datetime(str(item.get("closed_at") or ""))
    url = str(item.get("html_url") or "")
    body_text = str(item.get("body") or "").strip()

    header_lines = [
        f"# {repo}#{number}: {title}",
        "",
        f"- Type: {'pull request' if is_pr else 'issue'}",
        f"- State: {state}",
        f"- Author: {author or 'unknown'}",
    ]
    if labels:
        header_lines.append(f"- Labels: {', '.join(labels)}")
    if created_at:
        header_lines.append(f"- Opened: {created_at:%Y-%m-%d %H:%M:%S UTC}")
    if merged_at:
        header_lines.append(f"- Merged: {merged_at:%Y-%m-%d %H:%M:%S UTC}")
    elif closed_at:
        header_lines.append(f"- Closed: {closed_at:%Y-%m-%d %H:%M:%S UTC}")
    comment_count = item.get("comments")
    if isinstance(comment_count, int) and comment_count:
        header_lines.append(f"- Comments: {comment_count}")
    if url:
        header_lines.append(f"- URL: {url}")
    body_lines = [*header_lines, ""]
    if body_text:
        body_lines.extend(["---", "", body_text])
    body = "\n".join(body_lines).strip()[:MAX_DOCUMENT_BODY_CHARS]

    metadata = {
        "repo": repo,
        "number": number,
        "kind": kind,
        "state": state,
        "author": author,
        "labels": labels,
        "merged_at": merged_at.isoformat() if merged_at else None,
        "comment_count": comment_count if isinstance(comment_count, int) else 0,
    }
    doc_title = f"{repo}#{number} [{state}]: {title}"
    return {
        "document_id": f"github:{kind}:{repo}#{number}",
        "source": "github",
        "source_type": f"github_{kind}",
        "source_document_id": f"{repo}#{number}",
        "source_chunk_id": "",
        "parent_document_id": None,
        "title": doc_title,
        "body": body,
        "url": url,
        "author_id": author,
        "author_name": author,
        "access_scope": "company",
        "occurred_at": created_at,
        "source_updated_at": updated_at,
        "content_hash": _content_hash(doc_title, body, url, metadata),
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


async def handler(inp: Input, ctx: WorkflowContext) -> dict[str, Any]:
    """Project changed GitHub PRs/issues into searchable company context documents."""
    if not (
        env_flag_enabled("GITHUB_ETL_ENABLED", default=False)
        and env_flag_enabled("GITHUB_CONTEXT_DOCUMENTS_ENABLED", default=True)
    ):
        ctx.log("github_context_documents_skipped_disabled")
        return {"status": "skipped", "reason": "github_context_documents_disabled"}

    repos = configured_github_repo_list(configured_github_repo_aliases())
    if not repos:
        ctx.log("github_context_documents_skipped_no_repos")
        return {"status": "skipped", "reason": "no_configured_github_repos"}

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
    max_pages = positive_int(
        os.getenv("GITHUB_CONTEXT_DOCUMENTS_MAX_PAGES_PER_REPO"),
        DEFAULT_MAX_PAGES_PER_REPO,
    )

    documents_upserted = 0
    items_seen = 0
    repos_synced: list[str] = []
    repos_failed: list[str] = []
    max_updated_at: dt.datetime | None = None

    timeout = httpx.Timeout(30.0, connect=5.0)
    async with httpx.AsyncClient(timeout=timeout) as client:
        for repo in repos:
            token = await _github_token(repo)
            if not token:
                repos_failed.append(repo)
                ctx.log("github_context_documents_no_token", repo=repo)
                continue
            try:
                items = await _fetch_changed_items(
                    client,
                    repo=repo,
                    token=token,
                    since=since,
                    max_pages=max_pages,
                )
            except httpx.HTTPError as exc:
                repos_failed.append(repo)
                ctx.log(
                    "github_context_documents_fetch_failed",
                    repo=repo,
                    error=str(exc),
                )
                continue
            for item in items:
                document = _item_document(repo, item)
                if document is None:
                    continue
                items_seen += 1
                updated_at = document["source_updated_at"]
                if isinstance(updated_at, dt.datetime) and (
                    max_updated_at is None or updated_at > max_updated_at
                ):
                    max_updated_at = updated_at
                observe_company_context_document_size(
                    "github",
                    str(document["source_type"]),
                    len(str(document["body"] or "")),
                )
                action = await _upsert_document(ctx._pool, document)
                record_company_context_documents_changed(
                    "github", str(document["source_type"]), action
                )
                if action in {"inserted", "updated"}:
                    documents_upserted += 1
            repos_synced.append(repo)

    # Never advance the watermark past a failed repo's data: keep retrying
    # from the previous watermark until every configured repo syncs.
    watermark = last_watermark if repos_failed else (max_updated_at or last_watermark)
    result = {
        "status": "completed" if not repos_failed else "partial",
        "repos_synced": repos_synced,
        "repos_failed": repos_failed,
        "items_seen": items_seen,
        "documents_upserted": documents_upserted,
        "watermark": watermark.isoformat() if watermark else None,
    }
    ctx.log("github_context_documents_completed", **result)
    return result
