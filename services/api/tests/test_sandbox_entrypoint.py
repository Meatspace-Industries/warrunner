from __future__ import annotations

import json
import os
import subprocess
import tomllib
from pathlib import Path

import pytest


ENTRYPOINT_SH = Path(__file__).resolve().parents[2] / "sandbox" / "entrypoint.sh"


def _write_codex_harness_config(home: Path) -> Path:
    harness_dir = home / "harness"
    codex_dir = harness_dir / "codex"
    codex_dir.mkdir(parents=True)
    (codex_dir / "config.toml").write_text(
        "\n".join(
            [
                'model = "gpt-5.5"',
                'model_reasoning_effort = "low"',
                'plan_mode_reasoning_effort = "high"',
                'approval_policy = "on-request"',
                'approvals_reviewer = "user"',
                'web_search = "live"',
                'personality = "pragmatic"',
                'sandbox_mode = "workspace-write"',
                "check_for_update_on_startup = true",
                "suppress_unstable_features_warning = true",
                'service_tier = "fast"',
                "",
                "[tools]",
                "view_image = true",
                "",
                "[features]",
                "goals = true",
                "memories = true",
                "code_mode = true",
                "hooks = true",
                "browser_use = true",
                "computer_use = true",
                "enable_fanout = true",
                "runtime_metrics = true",
                "",
                "[features.multi_agent_v2]",
                "enabled = true",
                "max_concurrent_threads_per_session = 6",
                "",
                "[agents]",
                "max_depth = 2",
                "job_max_runtime_seconds = 1800",
                "",
            ]
        )
    )
    return harness_dir


def _valid_codex_auth_payload() -> dict[str, object]:
    return {
        "auth_mode": "chatgpt",
        "OPENAI_API_KEY": None,
        "tokens": {
            "access_token": "access-token",
            "refresh_token": "refresh-token",
            "id_token": "id-token",
            "account_id": "account-id",
        },
        "last_refresh": "2026-05-24T00:00:00.000Z",
    }


def _write_codex_app_wrapper(bin_dir: Path, body: str | None = None) -> Path:
    wrapper = bin_dir / "codex-app-wrapper"
    wrapper.write_text(
        body
        or "\n".join(
            [
                "#!/bin/sh",
                "printf 'wrapper-ran\\n'",
                'cat "$HOME/.codex/auth.json"',
                "",
            ]
        )
    )
    wrapper.chmod(0o755)
    return wrapper


def test_sandbox_entrypoint_bootstraps_mock_google_adc(tmp_path: Path) -> None:
    home = tmp_path / "home"
    (home / ".config" / "amp").mkdir(parents=True)
    harness_dir = _write_codex_harness_config(home)

    result = subprocess.run(
        [
            "bash",
            str(ENTRYPOINT_SH),
            "sh",
            "-lc",
            'printf \'%s\n\' "$GOOGLE_APPLICATION_CREDENTIALS" && cat "$GOOGLE_APPLICATION_CREDENTIALS"',
        ],
        check=False,
        capture_output=True,
        text=True,
        env={
            "HOME": str(home),
            "PATH": os.environ.get("PATH", "/usr/bin:/bin"),
            "CENTAUR_HARNESS_CONFIG_DIR": str(harness_dir),
        },
    )

    assert result.returncode == 0, result.stderr or result.stdout
    adc_path, adc_json = result.stdout.split("\n", 1)
    assert adc_path == str(
        home / ".config" / "gcloud" / "application_default_credentials.json"
    )
    assert Path(adc_path).is_file()
    adc = json.loads(adc_json)
    assert adc == {
        "type": "service_account",
        "project_id": "centaur-sandbox",
        "private_key_id": "0000000000000000000000000000000000000000",
        "private_key": adc["private_key"],
        "client_email": "mock@creds.com",
        "client_id": "100000000000000000000",
        "auth_uri": "https://accounts.google.com/o/oauth2/auth",
        "token_uri": "https://oauth2.googleapis.com/token",
        "auth_provider_x509_cert_url": "https://www.googleapis.com/oauth2/v1/certs",
        "client_x509_cert_url": "https://www.googleapis.com/robot/v1/metadata/x509/mock%40creds.com",
        "universe_domain": "googleapis.com",
    }
    assert adc["private_key"].startswith("-----BEGIN PRIVATE KEY-----\n")
    assert adc["private_key"].endswith("-----END PRIVATE KEY-----\n")

    codex_config = (home / ".codex" / "config.toml").read_text()
    assert 'model = "gpt-5.5"' in codex_config
    assert 'model_reasoning_effort = "low"' in codex_config
    assert 'plan_mode_reasoning_effort = "high"' in codex_config
    assert 'approval_policy = "on-request"' in codex_config
    assert 'sandbox_mode = "workspace-write"' in codex_config
    assert 'service_tier = "fast"' in codex_config
    assert "max_concurrent_threads_per_session = 6" in codex_config


def test_sandbox_entrypoint_installs_codex_harness_config(tmp_path: Path) -> None:
    home = tmp_path / "home"
    harness_dir = _write_codex_harness_config(home)

    result = subprocess.run(
        [
            "bash",
            str(ENTRYPOINT_SH),
            "sh",
            "-lc",
            'cat "$HOME/.codex/config.toml"',
        ],
        check=False,
        capture_output=True,
        text=True,
        env={
            "HOME": str(home),
            "PATH": os.environ.get("PATH", "/usr/bin:/bin"),
            "CENTAUR_HARNESS_CONFIG_DIR": str(harness_dir),
        },
    )

    assert result.returncode == 0, result.stderr or result.stdout
    assert result.stdout == (harness_dir / "codex" / "config.toml").read_text()


def test_sandbox_entrypoint_installs_mounted_codex_auth_json(tmp_path: Path) -> None:
    home = tmp_path / "home"
    harness_dir = _write_codex_harness_config(home)
    auth_src = tmp_path / "codex-auth" / "auth.json"
    auth_src.parent.mkdir()
    auth_payload = _valid_codex_auth_payload()
    auth_src.write_text(json.dumps(auth_payload))

    bin_dir = tmp_path / "bin"
    bin_dir.mkdir()
    codex = bin_dir / "codex"
    codex.write_text("#!/bin/sh\necho 'codex login should not run' >&2\nexit 42\n")
    codex.chmod(0o755)

    result = subprocess.run(
        [
            "bash",
            str(ENTRYPOINT_SH),
            "sh",
            "-lc",
            'cat "$HOME/.codex/auth.json"',
        ],
        check=False,
        capture_output=True,
        text=True,
        env={
            "HOME": str(home),
            "PATH": f"{bin_dir}:{os.environ.get('PATH', '/usr/bin:/bin')}",
            "CENTAUR_HARNESS_CONFIG_DIR": str(harness_dir),
            "CENTAUR_CODEX_AUTH_JSON": str(auth_src),
        },
    )

    assert result.returncode == 0, result.stderr or result.stdout
    assert json.loads(result.stdout) == auth_payload
    assert "codex login should not run" not in result.stderr


def test_sandbox_entrypoint_runs_codex_wrapper_with_mounted_chatgpt_auth(
    tmp_path: Path,
) -> None:
    home = tmp_path / "home"
    harness_dir = _write_codex_harness_config(home)
    auth_src = tmp_path / "codex-auth" / "auth.json"
    auth_src.parent.mkdir()
    auth_payload = _valid_codex_auth_payload()
    auth_src.write_text(json.dumps(auth_payload))

    bin_dir = tmp_path / "bin"
    bin_dir.mkdir()
    _write_codex_app_wrapper(bin_dir)
    codex = bin_dir / "codex"
    codex.write_text("#!/bin/sh\necho 'codex login should not run' >&2\nexit 42\n")
    codex.chmod(0o755)

    result = subprocess.run(
        [
            "bash",
            str(ENTRYPOINT_SH),
            "codex-app-wrapper",
        ],
        check=False,
        capture_output=True,
        text=True,
        env={
            "HOME": str(home),
            "PATH": f"{bin_dir}:{os.environ.get('PATH', '/usr/bin:/bin')}",
            "CENTAUR_HARNESS_CONFIG_DIR": str(harness_dir),
            "CENTAUR_CODEX_AUTH_JSON": str(auth_src),
        },
    )

    assert result.returncode == 0, result.stderr or result.stdout
    prefix, auth_json = result.stdout.split("\n", 1)
    assert prefix == "wrapper-ran"
    assert json.loads(auth_json) == auth_payload
    assert (home / ".ready").is_file()
    assert "codex login should not run" not in result.stderr


def test_sandbox_entrypoint_requires_mounted_chatgpt_auth_for_codex_wrapper(
    tmp_path: Path,
) -> None:
    home = tmp_path / "home"
    harness_dir = _write_codex_harness_config(home)

    bin_dir = tmp_path / "bin"
    bin_dir.mkdir()
    marker = tmp_path / "wrapper-ran"
    _write_codex_app_wrapper(
        bin_dir,
        "\n".join(
            [
                "#!/bin/sh",
                f"touch {marker}",
                "echo wrapper-ran",
                "",
            ]
        ),
    )

    result = subprocess.run(
        [
            "bash",
            str(ENTRYPOINT_SH),
            "codex-app-wrapper",
        ],
        check=False,
        capture_output=True,
        text=True,
        env={
            "HOME": str(home),
            "PATH": f"{bin_dir}:{os.environ.get('PATH', '/usr/bin:/bin')}",
            "CENTAUR_HARNESS_CONFIG_DIR": str(harness_dir),
        },
    )

    assert result.returncode == 1
    assert "fatal: codex_chatgpt_auth_required" in result.stderr
    assert not (home / ".ready").exists()
    assert not marker.exists()


@pytest.mark.parametrize("api_key_env", ["OPENAI_API_KEY", "CODEX_API_KEY"])
def test_sandbox_entrypoint_rejects_api_key_env_for_codex_wrapper(
    tmp_path: Path, api_key_env: str
) -> None:
    home = tmp_path / "home"
    harness_dir = _write_codex_harness_config(home)
    auth_src = tmp_path / "codex-auth" / "auth.json"
    auth_src.parent.mkdir()
    auth_src.write_text(json.dumps(_valid_codex_auth_payload()))

    bin_dir = tmp_path / "bin"
    bin_dir.mkdir()
    marker = tmp_path / "wrapper-ran"
    _write_codex_app_wrapper(
        bin_dir,
        "\n".join(
            [
                "#!/bin/sh",
                f"touch {marker}",
                "echo wrapper-ran",
                "",
            ]
        ),
    )

    env = {
        "HOME": str(home),
        "PATH": f"{bin_dir}:{os.environ.get('PATH', '/usr/bin:/bin')}",
        "CENTAUR_HARNESS_CONFIG_DIR": str(harness_dir),
        "CENTAUR_CODEX_AUTH_JSON": str(auth_src),
        api_key_env: "sk-should-not-be-used",
    }
    result = subprocess.run(
        [
            "bash",
            str(ENTRYPOINT_SH),
            "codex-app-wrapper",
        ],
        check=False,
        capture_output=True,
        text=True,
        env=env,
    )

    assert result.returncode == 1
    assert "fatal: codex_api_key_login_disabled" in result.stderr
    assert not (home / ".ready").exists()
    assert not marker.exists()


@pytest.mark.parametrize(
    ("auth_payload", "error"),
    [
        (
            {
                "auth_mode": "api_key",
                "OPENAI_API_KEY": "sk-test",
            },
            "configured Codex auth JSON must have auth_mode=chatgpt",
        ),
        (
            {
                "auth_mode": "chatgpt",
                "tokens": {},
            },
            "configured Codex auth JSON is missing tokens.refresh_token",
        ),
        (
            {
                "auth_mode": "chatgpt",
                "OPENAI_API_KEY": "sk-test",
                "tokens": {"refresh_token": "refresh-token"},
            },
            "configured Codex auth JSON must not contain OPENAI_API_KEY",
        ),
    ],
)
def test_sandbox_entrypoint_rejects_non_chatgpt_codex_auth_json(
    tmp_path: Path, auth_payload: dict[str, object], error: str
) -> None:
    home = tmp_path / "home"
    harness_dir = _write_codex_harness_config(home)
    auth_src = tmp_path / "codex-auth" / "auth.json"
    auth_src.parent.mkdir()
    auth_src.write_text(json.dumps(auth_payload))

    bin_dir = tmp_path / "bin"
    bin_dir.mkdir()
    codex = bin_dir / "codex"
    codex.write_text("#!/bin/sh\necho 'codex login should not run' >&2\nexit 42\n")
    codex.chmod(0o755)

    result = subprocess.run(
        [
            "bash",
            str(ENTRYPOINT_SH),
            "sh",
            "-lc",
            "true",
        ],
        check=False,
        capture_output=True,
        text=True,
        env={
            "HOME": str(home),
            "PATH": f"{bin_dir}:{os.environ.get('PATH', '/usr/bin:/bin')}",
            "CENTAUR_HARNESS_CONFIG_DIR": str(harness_dir),
            "CENTAUR_CODEX_AUTH_JSON": str(auth_src),
        },
    )

    assert result.returncode == 1
    assert error in result.stderr
    assert "codex login should not run" not in result.stderr
    assert not (home / ".codex" / "auth.json").exists()


def test_sandbox_entrypoint_appends_codex_laminar_otel_config(tmp_path: Path) -> None:
    home = tmp_path / "home"
    harness_dir = _write_codex_harness_config(home)

    result = subprocess.run(
        [
            "bash",
            str(ENTRYPOINT_SH),
            "sh",
            "-lc",
            'cat "$HOME/.codex/config.toml"',
        ],
        check=False,
        capture_output=True,
        text=True,
        env={
            "HOME": str(home),
            "PATH": os.environ.get("PATH", "/usr/bin:/bin"),
            "CENTAUR_HARNESS_CONFIG_DIR": str(harness_dir),
            "CENTAUR_THREAD_KEY": "slack:C123:1700000000.000100",
            "CENTAUR_TRACE_ID": "00000000-0000-0000-0000-000000000123",
            "CODEX_OTEL_ENVIRONMENT": "staging",
            "LMNR_BASE_URL": "http://stg-laminar-app-server.stg-laminar.svc.cluster.local:8000",
            "LMNR_PROJECT_API_KEY": "lmnr-key",
        },
    )

    assert result.returncode == 0, result.stderr or result.stdout
    assert result.stdout.startswith((harness_dir / "codex" / "config.toml").read_text())
    parsed = tomllib.loads(result.stdout)
    assert "exporter" not in parsed["otel"]
    assert (
        parsed["otel"]["trace_exporter"]["otlp-http"]["endpoint"]
        == "http://stg-laminar-app-server.stg-laminar.svc.cluster.local:8000/v1/traces"
    )
    assert "\nexporter = { otlp-http = {" not in result.stdout
    assert "trace_exporter = { otlp-http = {" in result.stdout
    assert (
        'endpoint = "http://stg-laminar-app-server.stg-laminar.svc.cluster.local:8000/v1/traces"'
        in result.stdout
    )
    assert '"x-trace-id" = "00000000-0000-0000-0000-000000000123"' in result.stdout
    assert '"x-centaur-thread-key" = "slack:C123:1700000000.000100"' in result.stdout
    assert '"authorization" = "Bearer lmnr-key"' in result.stdout
    assert 'environment = "staging"' in result.stdout
