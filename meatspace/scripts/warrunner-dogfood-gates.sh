#!/usr/bin/env bash
set -euo pipefail

docker_mode="auto"

usage() {
  cat <<'USAGE'
Usage: meatspace/scripts/warrunner-dogfood-gates.sh [--docker|--skip-docker]

Runs the local Warrunner Discord dogfood verification gates:
  - Discordbot test suite
  - Discordbot type check
  - emulated Discord Gateway-to-final-delivery dogfood loop
  - Discordbot API config tests
  - Warrunner Helm lint/template/render assertions
  - optional Docker image builds for Discordbot and the Meatspace overlay

By default Docker builds run only when the Docker daemon is available.
Use --docker in CI to require Docker builds.
USAGE
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --docker)
      docker_mode="require"
      shift
      ;;
    --skip-docker)
      docker_mode="skip"
      shift
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    *)
      echo "unknown argument: $1" >&2
      usage >&2
      exit 2
      ;;
  esac
done

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$repo_root"

run() {
  echo
  echo "==> $*"
  "$@"
}

run pnpm --filter discordbot test
run pnpm --filter discordbot check:types
run pnpm --filter discordbot dogfood:emulated
echo
echo "==> meatspace/scripts/warrunner-live-dogfood.sh preflight --env-file services/discordbot/.env.example"
if host_preflight_output="$(
  meatspace/scripts/warrunner-live-dogfood.sh preflight \
    --env-file services/discordbot/.env.example 2>&1
)"; then
  echo "$host_preflight_output"
  echo "Expected host dogfood preflight to fail with blank live credentials." >&2
  exit 1
fi
echo "$host_preflight_output"
grep -q "PASS DISCORD_GATEWAY_ENABLED: enabled" <<<"$host_preflight_output"
grep -q "FAIL DISCORD_BOT_TOKEN: missing" <<<"$host_preflight_output"
run uv run --project services/api pytest -q services/api/tests/test_discordbot_service_config.py
run helm repo add 1password https://1password.github.io/connect-helm-charts --force-update
run helm dependency build contrib/chart
run helm lint contrib/chart -f meatspace/infra/helm/values.warrunner.yaml

rendered_manifest="${TMPDIR:-/tmp}/warrunner-rendered.yaml"
echo
echo "==> helm template warrunner contrib/chart -f meatspace/infra/helm/values.warrunner.yaml --namespace centaur-system"
helm template warrunner contrib/chart \
  -f meatspace/infra/helm/values.warrunner.yaml \
  --namespace centaur-system > "$rendered_manifest"

run grep -q "app.kubernetes.io/component: discordbot" "$rendered_manifest"
run grep -q "path: /health/ready" "$rendered_manifest"
if grep -q "app.kubernetes.io/component: slackbot" "$rendered_manifest"; then
  echo "Slackbot should not render in the Warrunner values overlay" >&2
  exit 1
fi

docker_available() {
  command -v docker >/dev/null 2>&1 && docker info >/dev/null 2>&1
}

case "$docker_mode" in
  require)
    if ! docker_available; then
      echo "Docker daemon is required for --docker but is not available." >&2
      exit 1
    fi
    ;;
  auto)
    if ! docker_available; then
      echo
      echo "==> skipping Docker image builds; Docker daemon is not available"
      echo "    rerun with --docker to require them"
      exit 0
    fi
    ;;
  skip)
    echo
    echo "==> skipping Docker image builds by request"
    exit 0
    ;;
esac

run docker build -f services/discordbot/Dockerfile .
run docker build -f meatspace/overlay/Dockerfile meatspace/overlay
