#!/usr/bin/env bash
set -euo pipefail

usage() {
  cat <<'USAGE'
Usage: meatspace/scripts/warrunner-live-dogfood.sh [preflight|smoke|live|session|chat] [options] [--] [dogfood args...]

Runs Warrunner's live Discord dogfood commands against the Meatspace host env
file without copying secrets into the repo.

Commands:
  preflight   Verify Discord, Gateway, Centaur, and route configuration.
  smoke       Post a Discord smoke message or create a forum smoke thread.
  live        Run one live Discord-window turn.
  session     Run a multi-turn live Discord-window session. Default.
  chat        Run an open-ended one-hour Discord-window session.

Options:
  --env-file <path>          Env file to load. Default: /var/lib/meepo/hermes/.env
  --env-file=<path>          Same as --env-file <path>.
  --dogfood-env-file <path>  Alias for --env-file.
  --dogfood-env-file=<path>  Alias for --env-file=<path>.
  --transcript-dir <path>    Directory for live/session/chat JSON transcripts.
                            Default: /var/lib/meepo/warrunner/dogfood-transcripts
  --transcript-dir=<path>    Same as --transcript-dir <path>.
  --no-transcript            Disable live/session/chat transcript writing.
  --open                    Open the printed Discord URL for live/session/chat.
  --no-open                 Do not open Discord automatically.
  -h, --help                Show this help.

Examples:
  meatspace/scripts/warrunner-live-dogfood.sh preflight
  meatspace/scripts/warrunner-live-dogfood.sh session
  meatspace/scripts/warrunner-live-dogfood.sh session -- 123456789012345678
  meatspace/scripts/warrunner-live-dogfood.sh session -- --turns 12 --timeout-ms 600000 123456789012345678
  meatspace/scripts/warrunner-live-dogfood.sh session -- --until-timeout --timeout-ms 3600000 123456789012345678
  meatspace/scripts/warrunner-live-dogfood.sh session -- --attach --turns 12 123456789012345678
  meatspace/scripts/warrunner-live-dogfood.sh chat -- 123456789012345678
  meatspace/scripts/warrunner-live-dogfood.sh chat -- --attach 123456789012345678
USAGE
}

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
env_file="${WARRUNNER_DOGFOOD_ENV_FILE:-/var/lib/meepo/hermes/.env}"
transcript_dir="${WARRUNNER_DOGFOOD_TRANSCRIPT_DIR:-/var/lib/meepo/warrunner/dogfood-transcripts}"
command=""
open_discord=1
open_explicit=0
passthrough=()

require_value() {
  local flag="$1"
  local value="${2:-}"
  if [[ -z "$value" || "$value" == --* ]]; then
    echo "$flag requires a path" >&2
    exit 2
  fi
}

ensure_transcript_dir_writable() {
  local dir="$1"
  local probe
  if ! mkdir -p -m 700 "$dir"; then
    echo "Warrunner dogfood transcript dir is not writable: $dir" >&2
    exit 1
  fi
  if ! probe="$(mktemp "$dir/.warrunner-transcript-probe.XXXXXX")"; then
    echo "Warrunner dogfood transcript dir is not writable: $dir" >&2
    exit 1
  fi
  if ! printf 'ok\n' > "$probe"; then
    rm -f "$probe"
    echo "Warrunner dogfood transcript dir is not writable: $dir" >&2
    exit 1
  fi
  rm -f "$probe"
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    preflight|smoke|live|session|chat)
      if [[ -n "$command" ]]; then
        passthrough+=("$1")
      else
        command="$1"
      fi
      shift
      ;;
    --env-file|--dogfood-env-file)
      require_value "$1" "${2:-}"
      env_file="$2"
      shift 2
      ;;
    --env-file=*|--dogfood-env-file=*)
      env_file="${1#*=}"
      require_value "${1%%=*}" "$env_file"
      shift
      ;;
    --transcript-dir|--dogfood-transcript-dir)
      require_value "$1" "${2:-}"
      transcript_dir="$2"
      shift 2
      ;;
    --transcript-dir=*|--dogfood-transcript-dir=*)
      transcript_dir="${1#*=}"
      require_value "${1%%=*}" "$transcript_dir"
      shift
      ;;
    --no-transcript)
      transcript_dir=""
      shift
      ;;
    --open|--open-discord)
      open_discord=1
      open_explicit=1
      passthrough+=("$1")
      shift
      ;;
    --no-open|--no-open-discord)
      open_discord=0
      open_explicit=1
      passthrough+=("$1")
      shift
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    --)
      shift
      passthrough+=("$@")
      break
      ;;
    *)
      passthrough+=("$1")
      shift
      ;;
  esac
done

command="${command:-session}"
case "$env_file" in
  /*) ;;
  *) env_file="$repo_root/$env_file" ;;
esac
if [[ -n "$transcript_dir" ]]; then
  case "$transcript_dir" in
    /*) ;;
    *) transcript_dir="$repo_root/$transcript_dir" ;;
  esac
fi

if [[ ! -r "$env_file" ]]; then
  cat >&2 <<EOF
Warrunner dogfood env file is not readable: $env_file

Pass --env-file <path> or set WARRUNNER_DOGFOOD_ENV_FILE.
The Meatspace host default is /var/lib/meepo/hermes/.env.
EOF
  exit 1
fi
if [[ ( "$command" == "live" || "$command" == "session" || "$command" == "chat" ) && -n "$transcript_dir" ]]; then
  ensure_transcript_dir_writable "$transcript_dir"
fi

script="dogfood:$command"
dogfood_args=(--dogfood-env-file="$env_file")
if [[ ( "$command" == "live" || "$command" == "session" || "$command" == "chat" ) && -n "$transcript_dir" ]]; then
  dogfood_args+=(--transcript-dir="$transcript_dir")
fi
if [[ ( "$command" == "live" || "$command" == "session" ) && "$open_discord" == 1 && "$open_explicit" == 0 ]]; then
  dogfood_args+=(--open)
fi

cd "$repo_root"
echo "==> Warrunner live dogfood command: $command"
echo "==> Warrunner dogfood script: $script"
echo "==> Warrunner dogfood env file: $env_file"
if [[ ( "$command" == "live" || "$command" == "session" || "$command" == "chat" ) && -n "$transcript_dir" ]]; then
  echo "==> Warrunner dogfood transcript dir: $transcript_dir"
fi
exec pnpm --filter discordbot "$script" -- "${dogfood_args[@]}" "${passthrough[@]+"${passthrough[@]}"}"
