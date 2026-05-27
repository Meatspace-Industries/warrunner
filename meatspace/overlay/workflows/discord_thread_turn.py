"""Workflow: single agent turn in a Discord forum thread."""

from __future__ import annotations

from dataclasses import dataclass, field
import re
from typing import Any

from api.github_repos import (
    configured_github_repo_aliases,
    configured_github_repo_list,
    resolve_github_repo_alias,
)
from api.runtime_control import ControlPlaneError
from api.workflow_engine import WorkflowContext

WORKFLOW_NAME = "discord_thread_turn"

_EXECUTION_HARNESSES = frozenset({"amp", "claude-code", "codex", "pi-mono"})
_PROMPT_FLAG_ALIASES = {
    "claude": "claude-code",
    "pi": "pi-mono",
}
_PROMPT_FLAG_SKIP = frozenset({"engine", "model", "opus", "sonnet", "haiku"})
_PROMPT_FLAG_VALUE_SKIP = frozenset({"engine", "model"})
_REPO_FLAG_RE = re.compile(
    r"(^|\s)(`?)(?:--repo(?:=|\s+)|repo\s*[:=]\s*)"
    r"([A-Za-z0-9_.:/-]+)(`?)",
    re.IGNORECASE,
)
_PROMPT_FLAG_RE = re.compile(
    r"(^|\s)(`?)(--|[\u2013\u2014])([a-z][a-z0-9-]*)(?=\s|`|$)",
    re.IGNORECASE,
)
_BARE_PERSONA_PROMPT = (
    "Briefly introduce yourself using your active persona instructions and ask "
    "what we should work on."
)


@dataclass(frozen=True)
class PromptSelection:
    harness: str | None
    persona: str | None
    repo: str | None
    ambiguous_repos: tuple[str, ...]
    parts: list[dict[str, Any]]


@dataclass
class Input:
    thread_key: str = ""
    parts: list[dict[str, Any]] = field(default_factory=list)
    text: str | None = None
    message_id: str | None = None
    user_id: str | None = None
    metadata: dict[str, Any] = field(default_factory=dict)
    history_messages: list[dict[str, Any]] = field(default_factory=list)
    delivery: dict[str, Any] = field(default_factory=dict)
    harness: str | None = None
    persona: str | None = None
    agents_md_override: str | None = None
    repo: str | None = None

    @property
    def effective_parts(self) -> list[dict[str, Any]]:
        if self.parts:
            return [p for p in self.parts if isinstance(p, dict)]
        if self.text and self.text.strip():
            return [{"type": "text", "text": self.text.strip()}]
        raise ControlPlaneError(
            "INVALID_WORKFLOW_INPUT",
            "workflow input must include non-empty parts or text",
            422,
        )


def _known_personas() -> set[str]:
    try:
        from api.app import get_tool_manager

        return set(get_tool_manager().personas)
    except Exception:
        return set()


def _strip_ranges(text: str, ranges: list[tuple[int, int]]) -> str:
    cleaned = text
    for start, end in sorted(ranges, reverse=True):
        cleaned = f"{cleaned[:start]} {cleaned[end:]}"
    return re.sub(r"\s+", " ", cleaned).strip()


def _extract_repo_selection_from_text(
    text: str,
    *,
    aliases: dict[str, str],
) -> tuple[str | None, tuple[str, ...], str]:
    selected_repo: str | None = None
    ranges: list[tuple[int, int]] = []

    for match in _REPO_FLAG_RE.finditer(text):
        leading = match.group(1) or ""
        opening_tick = match.group(2) or ""
        candidate = match.group(3) or ""
        closing_tick = match.group(4) or ""
        strip_start = match.start() + len(leading)
        if opening_tick:
            strip_start += len(opening_tick)
        strip_end = match.end() - len(closing_tick)
        resolved = resolve_github_repo_alias(candidate, aliases)
        if resolved:
            selected_repo = resolved
            ranges.append((strip_start, strip_end))

    cleaned = _strip_ranges(text, ranges) if ranges else text.strip()
    if selected_repo:
        return selected_repo, (), cleaned

    mentioned: set[str] = set()
    for alias, repo in aliases.items():
        pattern = rf"(?<![A-Za-z0-9_.-]){re.escape(alias)}(?![A-Za-z0-9_.-])"
        if re.search(pattern, cleaned, flags=re.IGNORECASE):
            mentioned.add(repo)

    if len(mentioned) == 1:
        return next(iter(mentioned)), (), cleaned
    if len(mentioned) > 1:
        return None, tuple(sorted(mentioned)), cleaned
    return None, (), cleaned


def _parts_look_like_repo_work(parts: list[dict[str, Any]]) -> bool:
    text = " ".join(
        part.get("text", "")
        for part in parts
        if part.get("type") == "text" and isinstance(part.get("text"), str)
    ).lower()
    return bool(
        re.search(
            r"\b(code|repo|github|branch|pr|pull request|implement|fix|test|"
            r"debug|deploy|diff|commit)\b",
            text,
        )
    )


def _with_repo_routing_note(
    parts: list[dict[str, Any]],
    *,
    repo: str | None,
    ambiguous_repos: tuple[str, ...],
    configured_repos: tuple[str, ...],
) -> list[dict[str, Any]]:
    note: str | None = None
    if repo:
        note = f"Target GitHub repository for this turn: {repo}."
    elif ambiguous_repos:
        note = (
            "Multiple configured GitHub repositories were mentioned "
            f"({', '.join(ambiguous_repos)}). Ask the user which one to use "
            "before doing code work."
        )
    elif configured_repos and _parts_look_like_repo_work(parts):
        note = (
            "No target GitHub repository was selected. Ask the user to specify "
            f"one of: {', '.join(configured_repos)} before doing code work."
        )
    if not note:
        return parts
    return [{"type": "text", "text": note}, *parts]


async def _release_for_repo_scope_change(
    ctx: WorkflowContext,
    *,
    thread_key: str,
    message_id: str | None,
    repo: str | None,
) -> None:
    if not repo or not hasattr(ctx, "_pool"):
        return

    from api.runtime_control import (
        get_active_assignment,
        release_assignment,
        reset_sandbox_session_for_repo_scope_change,
    )

    active = await get_active_assignment(ctx._pool, thread_key)
    if not active:
        return
    active_repo = (active.get("repo") or "").strip() or None
    if active_repo == repo:
        return

    release_id = f"repo-switch:{message_id or ctx.run_id}"
    await release_assignment(
        ctx._pool,
        thread_key=thread_key,
        release_id=release_id,
        cancel_inflight=True,
        stop_runtime_background=True,
    )
    await reset_sandbox_session_for_repo_scope_change(ctx._pool, thread_key)


def _extend_value_skip(text: str, end: int) -> int:
    match = re.match(r"\s+[A-Za-z0-9._/-]+", text[end:])
    return end + match.end() if match else end


def _classify_flag(flag: str, personas: set[str]) -> tuple[str | None, str | None]:
    resolved = _PROMPT_FLAG_ALIASES.get(flag, flag)
    if resolved in _EXECUTION_HARNESSES:
        return resolved, None
    if resolved in personas or flag in personas:
        return None, resolved
    return None, None


def _extract_prompt_selection_from_text(
    text: str,
    *,
    personas: set[str],
) -> tuple[str | None, str | None, str]:
    harness: str | None = None
    persona: str | None = None
    ranges: list[tuple[int, int]] = []

    for match in _PROMPT_FLAG_RE.finditer(text):
        leading = match.group(1) or ""
        opening_tick = match.group(2) or ""
        marker = match.group(3) or ""
        flag = match.group(4).lower()

        flag_start = match.start() + len(leading) + len(opening_tick)
        flag_end = flag_start + len(marker) + len(flag)
        strip_start = flag_start - len(opening_tick) if opening_tick else flag_start
        strip_end = flag_end + 1 if flag_end < len(text) and text[flag_end] == "`" else flag_end
        if flag in _PROMPT_FLAG_VALUE_SKIP:
            strip_end = _extend_value_skip(text, strip_end)

        is_skip = flag in _PROMPT_FLAG_SKIP
        classified_harness, classified_persona = _classify_flag(flag, personas)
        if not (is_skip or classified_harness or classified_persona):
            continue

        ranges.append((strip_start, strip_end))
        if classified_harness:
            harness = classified_harness
        if classified_persona:
            persona = classified_persona

    cleaned = _strip_ranges(text, ranges) if ranges else text.strip()
    return harness, persona, cleaned


def _extract_prompt_selection(
    parts: list[dict[str, Any]],
    *,
    explicit_harness: str | None = None,
    explicit_persona: str | None = None,
    explicit_repo: str | None = None,
) -> PromptSelection:
    known_personas = _known_personas()
    repo_aliases = configured_github_repo_aliases()
    harness: str | None = None
    persona: str | None = None
    repo: str | None = resolve_github_repo_alias(explicit_repo or "", repo_aliases)
    ambiguous_repos: tuple[str, ...] = ()
    cleaned_parts: list[dict[str, Any]] = []
    has_non_text_part = False

    for part in parts:
        if part.get("type") != "text" or not isinstance(part.get("text"), str):
            cleaned_parts.append(part)
            has_non_text_part = True
            continue

        part_repo, part_ambiguous, repo_cleaned_text = _extract_repo_selection_from_text(
            part["text"],
            aliases=repo_aliases,
        )
        repo = repo or part_repo
        ambiguous_repos = ambiguous_repos or part_ambiguous

        part_harness, part_persona, cleaned_text = _extract_prompt_selection_from_text(
            repo_cleaned_text,
            personas=known_personas,
        )
        harness = part_harness or harness
        persona = part_persona or persona
        if cleaned_text:
            cleaned_parts.append({**part, "text": cleaned_text})

    harness = (explicit_harness or harness or "").strip().lower() or None
    persona = (explicit_persona or persona or "").strip().lower() or None
    if harness:
        harness = _PROMPT_FLAG_ALIASES.get(harness, harness)

    if persona and not harness and not cleaned_parts and not has_non_text_part:
        cleaned_parts.append({"type": "text", "text": _BARE_PERSONA_PROMPT})
    if not cleaned_parts:
        cleaned_parts = parts
    cleaned_parts = _with_repo_routing_note(
        cleaned_parts,
        repo=repo,
        ambiguous_repos=ambiguous_repos,
        configured_repos=configured_github_repo_list(repo_aliases),
    )

    return PromptSelection(
        harness=harness,
        persona=persona,
        repo=repo,
        ambiguous_repos=ambiguous_repos,
        parts=cleaned_parts,
    )


async def handler(inp: Input, ctx: WorkflowContext) -> dict[str, Any]:
    """Spawn -> message -> execute -> wait for a terminal agent result."""
    from api.workflow_engine import do_agent_turn

    thread_key = inp.thread_key.strip()
    if not thread_key:
        raise ControlPlaneError(
            "INVALID_WORKFLOW_INPUT",
            "discord_thread_turn requires thread_key",
            422,
        )

    selection = _extract_prompt_selection(
        inp.effective_parts,
        explicit_harness=inp.harness,
        explicit_persona=inp.persona,
        explicit_repo=inp.repo,
    )
    metadata = dict(inp.metadata or {})
    metadata.setdefault("source", "discordbot")
    metadata.setdefault("platform", "discord")

    await _release_for_repo_scope_change(
        ctx,
        thread_key=thread_key,
        message_id=inp.message_id,
        repo=selection.repo,
    )

    return await do_agent_turn(
        ctx,
        thread_key=thread_key,
        parts=selection.parts,
        history_messages=inp.history_messages,
        message_id=inp.message_id,
        user_id=inp.user_id,
        metadata=metadata,
        delivery=inp.delivery,
        harness=selection.harness,
        persona=selection.persona,
        agents_md_override=inp.agents_md_override,
        repo=selection.repo,
    )
