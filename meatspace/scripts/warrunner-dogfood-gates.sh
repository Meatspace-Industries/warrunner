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
echo
host_chat_dir="$(mktemp -d)"
echo "==> meatspace/scripts/warrunner-live-dogfood.sh chat --env-file services/discordbot/.env.example --transcript-dir $host_chat_dir --no-open -- 123456789012345678"
if host_chat_output="$(
  meatspace/scripts/warrunner-live-dogfood.sh chat \
    --env-file services/discordbot/.env.example \
    --transcript-dir "$host_chat_dir" \
    --no-open \
    -- 123456789012345678 2>&1
)"; then
  echo "$host_chat_output"
  rm -rf "$host_chat_dir"
  echo "Expected host dogfood chat to fail with blank live credentials." >&2
  exit 1
fi
rm -rf "$host_chat_dir"
echo "$host_chat_output"
grep -q "Warrunner live dogfood command: chat" <<<"$host_chat_output"
grep -q "dogfood:chat" <<<"$host_chat_output"
if grep -q -- "--until-timeout" <<<"$host_chat_output"; then
  echo "Host chat should use dogfood:chat defaults instead of injecting session flags." >&2
  exit 1
fi
grep -q "FAIL DISCORD_BOT_TOKEN: missing" <<<"$host_chat_output"
echo
echo "==> meatspace/scripts/warrunner-live-dogfood.sh session --env-file services/discordbot/.env.example --transcript-dir /dev/null/warrunner --no-open"
if host_transcript_output="$(
  meatspace/scripts/warrunner-live-dogfood.sh session \
    --env-file services/discordbot/.env.example \
    --transcript-dir /dev/null/warrunner \
    --no-open 2>&1
)"; then
  echo "$host_transcript_output"
  echo "Expected host dogfood session to fail before pnpm with an unwritable transcript dir." >&2
  exit 1
fi
echo "$host_transcript_output"
grep -q "Warrunner dogfood transcript dir is not writable: /dev/null/warrunner" <<<"$host_transcript_output"
if grep -q "dogfood:session" <<<"$host_transcript_output"; then
  echo "Transcript dir validation should fail before pnpm starts dogfood:session." >&2
  exit 1
fi
echo
echo "==> pnpm --filter discordbot dogfood:session -- --dogfood-env-file=.env.example --transcript-dir=/dev/null/warrunner --no-open"
if direct_transcript_output="$(
  pnpm --filter discordbot dogfood:session -- \
    --dogfood-env-file=.env.example \
    --transcript-dir=/dev/null/warrunner \
    --no-open 2>&1
)"; then
  echo "$direct_transcript_output"
  echo "Expected direct dogfood session to fail before preflight with an unwritable transcript dir." >&2
  exit 1
fi
echo "$direct_transcript_output"
grep -q "FAIL dogfood transcript dir:" <<<"$direct_transcript_output"
if grep -q "FAIL DISCORD_BOT_TOKEN: missing" <<<"$direct_transcript_output"; then
  echo "Direct transcript dir validation should fail before dogfood preflight." >&2
  exit 1
fi
echo
echo "==> pnpm --filter discordbot dogfood:chat -- --dogfood-env-file=.env.example --transcript-dir=/dev/null/warrunner --no-open"
if direct_chat_transcript_output="$(
  pnpm --filter discordbot dogfood:chat -- \
    --dogfood-env-file=.env.example \
    --transcript-dir=/dev/null/warrunner \
    --no-open 2>&1
)"; then
  echo "$direct_chat_transcript_output"
  echo "Expected direct dogfood chat to fail before preflight with an unwritable transcript dir." >&2
  exit 1
fi
echo "$direct_chat_transcript_output"
grep -q "FAIL dogfood transcript dir:" <<<"$direct_chat_transcript_output"
if grep -q "FAIL DISCORD_BOT_TOKEN: missing" <<<"$direct_chat_transcript_output"; then
  echo "Direct chat transcript dir validation should fail before dogfood preflight." >&2
  exit 1
fi
echo
echo "==> pnpm --filter discordbot dogfood:session -- --dogfood-env-file=.env.example --turns=0 --no-open"
if invalid_turns_output="$(
  pnpm --filter discordbot dogfood:session -- \
    --dogfood-env-file=.env.example \
    --turns=0 \
    --no-open 2>&1
)"; then
  echo "$invalid_turns_output"
  echo "Expected direct dogfood session to reject invalid turn count before preflight." >&2
  exit 1
fi
echo "$invalid_turns_output"
grep -q -- "--turns must be a positive integer" <<<"$invalid_turns_output"
if grep -q "FAIL DISCORD_BOT_TOKEN: missing" <<<"$invalid_turns_output"; then
  echo "Direct session tuning validation should fail before dogfood preflight." >&2
  exit 1
fi
echo
echo "==> pnpm --filter discordbot dogfood:chat -- --dogfood-env-file=.env.example --turns=0 --no-open"
if invalid_chat_turns_output="$(
  pnpm --filter discordbot dogfood:chat -- \
    --dogfood-env-file=.env.example \
    --turns=0 \
    --no-open 2>&1
)"; then
  echo "$invalid_chat_turns_output"
  echo "Expected direct dogfood chat to reject invalid turn count before preflight." >&2
  exit 1
fi
echo "$invalid_chat_turns_output"
grep -q -- "--turns must be a positive integer" <<<"$invalid_chat_turns_output"
if grep -q "FAIL DISCORD_BOT_TOKEN: missing" <<<"$invalid_chat_turns_output"; then
  echo "Direct chat tuning validation should fail before dogfood preflight." >&2
  exit 1
fi
echo
echo "==> pnpm --filter discordbot dogfood:chat -- --dogfood-env-file=.env.example --operator-user-id --no-open"
if invalid_chat_operator_output="$(
  pnpm --filter discordbot dogfood:chat -- \
    --dogfood-env-file=.env.example \
    --operator-user-id \
    --no-open 2>&1
)"; then
  echo "$invalid_chat_operator_output"
  echo "Expected direct dogfood chat to reject a missing operator user id before preflight." >&2
  exit 1
fi
echo "$invalid_chat_operator_output"
grep -q -- "--operator-user-id requires a value" <<<"$invalid_chat_operator_output"
if grep -q "FAIL DISCORD_BOT_TOKEN: missing" <<<"$invalid_chat_operator_output"; then
  echo "Direct chat operator filtering validation should fail before dogfood preflight." >&2
  exit 1
fi
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
