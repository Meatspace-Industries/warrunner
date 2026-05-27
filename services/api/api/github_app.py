"""GitHub App installation-token helpers."""

from __future__ import annotations

import base64
import contextlib
import datetime as dt
import os
import time
from dataclasses import dataclass
from pathlib import Path
from typing import Any

import httpx
import jwt


@dataclass(frozen=True)
class GitHubAppConfig:
    app_id: str
    installation_id: str
    private_key: str
    api_url: str = "https://api.github.com"


@dataclass(frozen=True)
class GitHubInstallationToken:
    token: str
    expires_at: dt.datetime | None = None


def _env(name: str) -> str:
    return (os.getenv(name) or "").strip()


def _env_bool(name: str, default: bool = False) -> bool:
    raw = _env(name).lower()
    if not raw:
        return default
    return raw not in {"0", "false", "no", "off"}


def github_app_auth_required() -> bool:
    return _env_bool("CENTAUR_REQUIRE_GITHUB_APP_AUTH")


def _private_key_from_env() -> str:
    raw = os.getenv("GITHUB_APP_PRIVATE_KEY") or ""
    if raw.strip():
        return raw.replace("\\n", "\n").strip()

    encoded = _env("GITHUB_APP_PRIVATE_KEY_BASE64")
    if encoded:
        return base64.b64decode(encoded).decode("utf-8").strip()

    path = _env("GITHUB_APP_PRIVATE_KEY_PATH")
    if path:
        return Path(path).read_text(encoding="utf-8").strip()

    return ""


def github_app_config_from_env() -> GitHubAppConfig | None:
    """Return configured GitHub App auth or None when the feature is absent."""
    app_id = _env("GITHUB_APP_ID")
    installation_id = _env("GITHUB_APP_INSTALLATION_ID")
    private_key = _private_key_from_env()
    api_url = _env("GITHUB_API_URL") or "https://api.github.com"

    configured_values = {
        "GITHUB_APP_ID": app_id,
        "GITHUB_APP_INSTALLATION_ID": installation_id,
        "GITHUB_APP_PRIVATE_KEY": private_key,
    }
    if not any(configured_values.values()):
        if github_app_auth_required():
            raise ValueError("GitHub App auth is required but not configured")
        return None

    missing = [name for name, value in configured_values.items() if not value]
    if missing:
        raise ValueError(
            "GitHub App auth is partially configured; missing "
            + ", ".join(sorted(missing))
        )

    return GitHubAppConfig(
        app_id=app_id,
        installation_id=installation_id,
        private_key=private_key,
        api_url=api_url.rstrip("/"),
    )


def build_github_app_jwt(
    config: GitHubAppConfig,
    *,
    now: int | None = None,
) -> str:
    issued_at = int(time.time() if now is None else now) - 60
    payload = {
        "iat": issued_at,
        "exp": issued_at + 600,
        "iss": config.app_id,
    }
    return jwt.encode(payload, config.private_key, algorithm="RS256")


def _parse_github_timestamp(value: Any) -> dt.datetime | None:
    if not isinstance(value, str) or not value:
        return None
    with contextlib.suppress(ValueError):
        return dt.datetime.fromisoformat(value.replace("Z", "+00:00"))
    return None


async def mint_github_app_installation_token_details(
    config: GitHubAppConfig | None = None,
    *,
    repository: str | None = None,
    require_repository: bool = False,
) -> GitHubInstallationToken | None:
    """Mint a short-lived installation token with expiry metadata."""
    resolved = config if config is not None else github_app_config_from_env()
    if resolved is None:
        return None

    repo_name = (repository or "").rsplit("/", 1)[-1].strip()
    if require_repository and not repo_name:
        raise ValueError(
            "GitHub App installation token requires a repository scope"
        )

    app_jwt = build_github_app_jwt(resolved)
    timeout = httpx.Timeout(10.0, connect=2.0)
    request_body: dict[str, Any] | None = None
    if repo_name:
        request_body = {"repositories": [repo_name]}

    request_kwargs: dict[str, Any] = {}
    if request_body is not None:
        request_kwargs["json"] = request_body

    async with httpx.AsyncClient(timeout=timeout) as client:
        response = await client.post(
            f"{resolved.api_url}/app/installations/"
            f"{resolved.installation_id}/access_tokens",
            headers={
                "Accept": "application/vnd.github+json",
                "Authorization": f"Bearer {app_jwt}",
                "X-GitHub-Api-Version": "2022-11-28",
            },
            **request_kwargs,
        )
    response.raise_for_status()
    payload: dict[str, Any] = response.json()
    token = payload.get("token")
    if not isinstance(token, str) or not token:
        raise RuntimeError("GitHub App installation token response did not include a token")
    return GitHubInstallationToken(
        token=token,
        expires_at=_parse_github_timestamp(payload.get("expires_at")),
    )


async def mint_github_app_installation_token(
    config: GitHubAppConfig | None = None,
    *,
    repository: str | None = None,
    require_repository: bool = False,
) -> str | None:
    """Mint a short-lived installation token, or None when unconfigured."""
    details = await mint_github_app_installation_token_details(
        config,
        repository=repository,
        require_repository=require_repository,
    )
    return details.token if details else None
