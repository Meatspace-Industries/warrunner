"""GitHub repository allowlist and alias helpers."""

from __future__ import annotations

import os
import re


def split_repo_config(value: str) -> list[str]:
    return [item.strip() for item in re.split(r"[\s,;]+", value) if item.strip()]


def canonical_github_repo(value: str) -> str | None:
    raw = value.strip().strip("<>`.,")
    raw = re.sub(r"^https://github\.com/", "", raw, flags=re.IGNORECASE)
    raw = re.sub(r"^git@github\.com:", "", raw, flags=re.IGNORECASE)
    raw = re.sub(r"\.git$", "", raw, flags=re.IGNORECASE)
    if not re.fullmatch(r"[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+", raw):
        return None
    owner, name = raw.split("/", 1)
    return f"{owner}/{name}"


def configured_github_repo_aliases(
    *,
    allowed_env: str = "WARRUNNER_ALLOWED_GITHUB_REPOS",
    aliases_env: str = "WARRUNNER_GITHUB_REPO_ALIASES",
) -> dict[str, str]:
    allowed: dict[str, str] = {}
    for item in split_repo_config(os.getenv(allowed_env, "")):
        canonical = canonical_github_repo(item)
        if canonical:
            allowed[canonical.lower()] = canonical

    aliases: dict[str, str] = {}
    for canonical in allowed.values():
        aliases[canonical.lower()] = canonical
        aliases[canonical.rsplit("/", 1)[-1].lower()] = canonical

    for item in split_repo_config(os.getenv(aliases_env, "")):
        if "=" not in item:
            continue
        alias, target = item.split("=", 1)
        canonical = canonical_github_repo(target)
        if not canonical or canonical.lower() not in allowed:
            continue
        aliases[alias.strip().lower()] = canonical
    return aliases


def resolve_github_repo_alias(value: str, aliases: dict[str, str]) -> str | None:
    canonical = canonical_github_repo(value)
    if canonical and canonical.lower() in aliases:
        return aliases[canonical.lower()]
    return aliases.get(value.strip().strip("<>`.,").lower())


def configured_github_repo_list(aliases: dict[str, str]) -> tuple[str, ...]:
    return tuple(dict.fromkeys(sorted(aliases.values())))
