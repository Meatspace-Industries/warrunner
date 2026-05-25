from __future__ import annotations

import os
import subprocess
from pathlib import Path


ENTRYPOINT_SH = Path(__file__).resolve().parents[1] / "entrypoint.sh"


def test_entrypoint_allows_overlay_tools_with_no_extra_dependencies(tmp_path: Path) -> None:
    tool_dir = tmp_path / "overlay" / "tools" / "empty_tool"
    tool_dir.mkdir(parents=True)
    (tool_dir / "pyproject.toml").write_text(
        "[project]\n"
        'name = "empty-tool"\n'
        'version = "0.1.0"\n'
        "dependencies = []\n"
    )

    env = os.environ.copy()
    env.update(
        {
            "DATABASE_URL": "postgresql://example.invalid/db",
            "SLACK_SIGNING_SECRET": "test-signing-secret",
            "SLACKBOT_API_KEY": "test-api-key",
            "TOOL_DIRS": f"/app/tools:{tmp_path / 'overlay' / 'tools'}",
        }
    )
    env.pop("CENTAUR_ENABLE_GCLOUD_BOOTSTRAP", None)

    result = subprocess.run(
        ["bash", str(ENTRYPOINT_SH), "true"],
        env=env,
        capture_output=True,
        text=True,
        check=False,
    )

    assert result.returncode == 0, result.stderr + result.stdout
