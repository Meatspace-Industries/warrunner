#!/usr/bin/env bash
set -euo pipefail

NAMESPACE="centaur-system"
RELEASE_NAME="warrunner"
ENV_FILE="${WARRUNNER_DEPLOY_ENV_FILE:-$HOME/.config/warrunner/deploy.env}"
CODEX_AUTH_FILE="${CODEX_AUTH_FILE:-$HOME/.codex/auth.json}"
INFRA_SECRET_NAME="centaur-infra-env"
CODEX_AUTH_SECRET_NAME="warrunner-codex-auth"
FORCE=0

usage() {
  cat <<'EOF'
Usage: meatspace/scripts/warrunner-bootstrap-k8s-secrets.sh [options]

Creates the Kubernetes Secrets needed by the Warrunner GKE deployment.
Codex uses ChatGPT login auth from ~/.codex/auth.json; this script does not
require or install OPENAI_API_KEY.

Options:
  --namespace <name>        Kubernetes namespace. Default: centaur-system
  --release-name <name>     Helm release name. Default: warrunner
  --env-file <path>         Deploy env file. Default: ~/.config/warrunner/deploy.env
  --codex-auth-file <path>  Codex auth JSON. Default: ~/.codex/auth.json
  --force                   Recreate managed Secrets
  -h, --help                Show this help
EOF
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --namespace|-n)
      NAMESPACE="${2:?--namespace requires a value}"
      shift 2
      ;;
    --release-name)
      RELEASE_NAME="${2:?--release-name requires a value}"
      shift 2
      ;;
    --env-file)
      ENV_FILE="${2:?--env-file requires a value}"
      shift 2
      ;;
    --codex-auth-file)
      CODEX_AUTH_FILE="${2:?--codex-auth-file requires a value}"
      shift 2
      ;;
    --force)
      FORCE=1
      shift
      ;;
    --help|-h)
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

require_cmd() {
  if ! command -v "$1" >/dev/null 2>&1; then
    echo "FATAL: required command not found: $1" >&2
    exit 1
  fi
}

require_env_value() {
  local name="$1"
  if [[ -z "${!name:-}" ]]; then
    echo "FATAL: $name is required in $ENV_FILE" >&2
    exit 1
  fi
}

secret_exists() {
  kubectl -n "$NAMESPACE" get secret "$1" >/dev/null 2>&1
}

delete_if_forced() {
  local name="$1"
  if [[ "$FORCE" == "1" ]]; then
    kubectl -n "$NAMESPACE" delete secret "$name" --ignore-not-found >/dev/null
  fi
}

rand_hex() {
  openssl rand -hex 32
}

validate_codex_auth() {
  python3 - "$CODEX_AUTH_FILE" <<'PY'
import json
import sys

path = sys.argv[1]
with open(path, encoding="utf-8") as f:
    data = json.load(f)

if data.get("auth_mode") != "chatgpt":
    raise SystemExit("FATAL: Codex auth JSON must have auth_mode=chatgpt")

tokens = data.get("tokens")
if not isinstance(tokens, dict) or not tokens.get("refresh_token"):
    raise SystemExit("FATAL: Codex auth JSON is missing tokens.refresh_token")
PY
}

require_cmd kubectl
require_cmd openssl
require_cmd python3

if [[ ! -r "$ENV_FILE" ]]; then
  echo "FATAL: deploy env file is not readable: $ENV_FILE" >&2
  exit 1
fi
if [[ ! -r "$CODEX_AUTH_FILE" ]]; then
  echo "FATAL: Codex auth JSON is not readable: $CODEX_AUTH_FILE" >&2
  echo "Run 'codex login' locally with ChatGPT login, then retry." >&2
  exit 1
fi

set -a
# shellcheck disable=SC1090
. "$ENV_FILE"
set +a

require_env_value DISCORD_BOT_TOKEN
require_env_value DISCORD_GUILD_ID
if [[ -z "${WARRUNNER_HOME_FORUM_CHANNEL_ID:-}" && -z "${WARRUNNER_HOME_CHANNEL_IDS:-}" ]]; then
  echo "FATAL: WARRUNNER_HOME_FORUM_CHANNEL_ID or WARRUNNER_HOME_CHANNEL_IDS is required in $ENV_FILE" >&2
  exit 1
fi

validate_codex_auth

kubectl create namespace "$NAMESPACE" --dry-run=client -o yaml | kubectl apply -f - >/dev/null

delete_if_forced "$INFRA_SECRET_NAME"
delete_if_forced "$CODEX_AUTH_SECRET_NAME"
delete_if_forced centaur-firewall-ca
delete_if_forced centaur-firewall-ca-key

if secret_exists "$INFRA_SECRET_NAME"; then
  echo "Secret $INFRA_SECRET_NAME already exists in namespace $NAMESPACE; leaving unchanged"
else
  POSTGRES_PASSWORD="$(rand_hex)"
  DATABASE_URL="postgresql://tempo:${POSTGRES_PASSWORD}@${RELEASE_NAME}-centaur-postgres:5432/ai_v2"
  DISCORDBOT_API_KEY="$(rand_hex)"
  SLACKBOT_API_KEY="${SLACKBOT_API_KEY:-$(rand_hex)}"
  SLACK_SIGNING_SECRET="${SLACK_SIGNING_SECRET:-$(rand_hex)}"
  SLACK_BOT_TOKEN="${SLACK_BOT_TOKEN:-xoxb-warrunner-slack-disabled}"
  LMNR_PROJECT_API_KEY="${LMNR_PROJECT_API_KEY:-}"
  LMNR_BASE_URL="${LMNR_BASE_URL:-}"

  secret_args=(
    -n "$NAMESPACE" create secret generic "$INFRA_SECRET_NAME"
    --from-literal=POSTGRES_PASSWORD="$POSTGRES_PASSWORD"
    --from-literal=DATABASE_URL="$DATABASE_URL"
    --from-literal=IRON_MANAGEMENT_API_KEY="$(rand_hex)"
    --from-literal=SANDBOX_SIGNING_KEY="$(rand_hex)"
    --from-literal=DISCORD_BOT_TOKEN="$DISCORD_BOT_TOKEN"
    --from-literal=DISCORDBOT_API_KEY="$DISCORDBOT_API_KEY"
    --from-literal=SLACK_BOT_TOKEN="$SLACK_BOT_TOKEN"
    --from-literal=SLACK_SIGNING_SECRET="$SLACK_SIGNING_SECRET"
    --from-literal=SLACKBOT_API_KEY="$SLACKBOT_API_KEY"
    --from-literal=LMNR_PROJECT_API_KEY="$LMNR_PROJECT_API_KEY"
    --from-literal=LMNR_BASE_URL="$LMNR_BASE_URL"
  )
  if [[ -n "${ANTHROPIC_API_KEY:-}" ]]; then
    secret_args+=(--from-literal=ANTHROPIC_API_KEY="$ANTHROPIC_API_KEY")
  fi
  if [[ -n "${AMP_API_KEY:-}" ]]; then
    secret_args+=(--from-literal=AMP_API_KEY="$AMP_API_KEY")
  fi
  if [[ -n "${GITHUB_TOKEN:-}" ]]; then
    secret_args+=(--from-literal=GITHUB_TOKEN="$GITHUB_TOKEN")
  fi
  kubectl "${secret_args[@]}" >/dev/null
  echo "Created Secret $INFRA_SECRET_NAME in namespace $NAMESPACE"
fi

if secret_exists "$CODEX_AUTH_SECRET_NAME"; then
  echo "Secret $CODEX_AUTH_SECRET_NAME already exists in namespace $NAMESPACE; leaving unchanged"
else
  kubectl -n "$NAMESPACE" create secret generic "$CODEX_AUTH_SECRET_NAME" \
    --from-file=auth.json="$CODEX_AUTH_FILE" >/dev/null
  echo "Created Secret $CODEX_AUTH_SECRET_NAME in namespace $NAMESPACE"
fi

if secret_exists centaur-firewall-ca && secret_exists centaur-firewall-ca-key; then
  echo "Firewall CA Secrets already exist in namespace $NAMESPACE; leaving unchanged"
else
  TMPDIR="$(mktemp -d)"
  trap 'rm -rf "$TMPDIR"' EXIT
  CA_KEY="$TMPDIR/ca-key.pem"
  CA_CERT="$TMPDIR/ca-cert.pem"

  openssl genrsa -out "$CA_KEY" 4096 >/dev/null 2>&1
  openssl req -x509 -new -nodes \
    -key "$CA_KEY" -sha256 -days 3650 \
    -subj "/CN=centaur iron-proxy CA" \
    -addext "basicConstraints=critical,CA:TRUE" \
    -addext "keyUsage=critical,keyCertSign" \
    -out "$CA_CERT" >/dev/null 2>&1

  kubectl -n "$NAMESPACE" create secret generic centaur-firewall-ca \
    --from-file=ca-cert.pem="$CA_CERT" >/dev/null
  kubectl -n "$NAMESPACE" create secret generic centaur-firewall-ca-key \
    --from-file=ca-cert.pem="$CA_CERT" \
    --from-file=ca-key.pem="$CA_KEY" >/dev/null
  echo "Created firewall CA Secrets in namespace $NAMESPACE"
fi
