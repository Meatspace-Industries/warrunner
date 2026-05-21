"""Workflow: single agent turn in a Discord forum thread."""

from __future__ import annotations

from dataclasses import dataclass, field
import re
from typing import Any

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
) -> PromptSelection:
    known_personas = _known_personas()
    harness: str | None = None
    persona: str | None = None
    cleaned_parts: list[dict[str, Any]] = []
    has_non_text_part = False

    for part in parts:
        if part.get("type") != "text" or not isinstance(part.get("text"), str):
            cleaned_parts.append(part)
            has_non_text_part = True
            continue

        part_harness, part_persona, cleaned_text = _extract_prompt_selection_from_text(
            part["text"],
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

    return PromptSelection(harness=harness, persona=persona, parts=cleaned_parts)


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
    )
    metadata = dict(inp.metadata or {})
    metadata.setdefault("source", "discordbot")
    metadata.setdefault("platform", "discord")

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
    )
