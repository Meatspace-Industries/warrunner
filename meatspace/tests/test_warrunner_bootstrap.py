from __future__ import annotations

import base64
import json
import os
import subprocess
from pathlib import Path


def _jwt(payload: dict[str, object]) -> str:
    encoded = base64.urlsafe_b64encode(json.dumps(payload).encode()).decode()
    return f"header.{encoded.rstrip('=')}.sig"


def test_bootstrap_builds_codex_broker_blob_from_auth_json(
    tmp_path: Path,
) -> None:
    env_file = tmp_path / "deploy.env"
    env_file.write_text(
        "\n".join(
            [
                "DISCORD_BOT_TOKEN=discord-token",
                "DISCORD_GUILD_ID=guild-1",
                "WARRUNNER_HOME_CHANNEL_IDS=home-1",
                "GITHUB_APP_ID=123",
                "GITHUB_APP_INSTALLATION_ID=456",
                "GITHUB_APP_PRIVATE_KEY=dummy-private-key",
            ]
        )
        + "\n",
        encoding="utf-8",
    )
    auth_file = tmp_path / "auth.json"
    auth_file.write_text(
        json.dumps(
            {
                "auth_mode": "chatgpt",
                "tokens": {
                    "access_token": _jwt(
                        {"client_id": "codex-client", "exp": 1_800_000_000}
                    ),
                    "id_token": _jwt({"aud": "unused-client"}),
                    "refresh_token": "refresh-token",
                    "account_id": "account-1",
                },
                "last_refresh": "2026-05-28T00:00:00Z",
            }
        ),
        encoding="utf-8",
    )
    stub_bin = tmp_path / "bin"
    stub_bin.mkdir()
    log_file = tmp_path / "kubectl.log"
    secret_json = json.dumps(
        {
            "data": {
                "GITHUB_APP_ID": base64.b64encode(b"123").decode(),
                "GITHUB_APP_INSTALLATION_ID": base64.b64encode(b"456").decode(),
                "GITHUB_APP_PRIVATE_KEY": base64.b64encode(
                    b"dummy-private-key"
                ).decode(),
            }
        }
    )
    (stub_bin / "kubectl").write_text(
        f"""#!/usr/bin/env bash
set -euo pipefail
printf '%s\\n' "$*" >> "{log_file}"
if [[ "$*" == *"get secret centaur-infra-env -o json"* ]]; then
  cat <<'JSON'
{secret_json}
JSON
  exit 0
fi
if [[ "$*" == *"get secret centaur-infra-env"* ]]; then
  exit 0
fi
if [[ "$*" == *"get secret centaur-firewall-ca"* ]]; then
  exit 0
fi
if [[ "$*" == *"get secret centaur-firewall-ca-key"* ]]; then
  exit 0
fi
if [[ "$*" == *"create namespace"* ]]; then
  cat
  exit 0
fi
if [[ "$*" == *"create secret generic"* ]]; then
  cat
  exit 0
fi
if [[ "$*" == *"apply"* ]]; then
  cat >/dev/null
  exit 0
fi
if [[ "$*" == *"patch secret"* ]]; then
  exit 0
fi
exit 0
""",
        encoding="utf-8",
    )
    (stub_bin / "openssl").write_text(
        """#!/usr/bin/env bash
set -euo pipefail
if [[ "${1:-}" == "rand" ]]; then
  printf 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'
  exit 0
fi
exit 0
""",
        encoding="utf-8",
    )
    (stub_bin / "kubectl").chmod(0o755)
    (stub_bin / "openssl").chmod(0o755)

    env = {
        **os.environ,
        "WARRUNNER_DEPLOY_ENV_FILE": str(env_file),
        "CODEX_AUTH_FILE": str(auth_file),
        "PATH": f"{stub_bin}{os.pathsep}{os.environ['PATH']}",
    }
    result = subprocess.run(
        [
            "bash",
            "meatspace/scripts/warrunner-bootstrap-k8s-secrets.sh",
        ],
        cwd=Path(__file__).resolve().parents[2],
        env=env,
        text=True,
        capture_output=True,
        check=False,
    )

    assert result.returncode == 0, result.stderr
    assert "Applied Secret centaur-infra-env" in result.stdout
