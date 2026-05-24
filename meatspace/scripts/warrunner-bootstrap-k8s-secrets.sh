#!/usr/bin/env bash
set -euo pipefail

NAMESPACE="centaur-system"
RELEASE_NAME="warrunner"
ENV_FILE="${WARRUNNER_DEPLOY_ENV_FILE:-$HOME/.config/warrunner/deploy.env}"
CODEX_AUTH_FILE="${CODEX_AUTH_FILE:-$HOME/.codex/auth.json}"
INFRA_SECRET_NAME="centaur-infra-env"
CODEX_AUTH_SECRET_NAME="warrunner-codex-auth"
FORCE=0
CODEX_AUTH_ONLY=0
CHECK_ONLY=0

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
  --codex-auth-only         Only validate and apply the Codex auth Secret
  --check-only              Validate local inputs without changing Kubernetes
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
    --codex-auth-only)
      CODEX_AUTH_ONLY=1
      shift
      ;;
    --check-only)
      CHECK_ONLY=1
      shift
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

apply_kubectl_yaml() {
  kubectl apply --server-side --field-manager=warrunner-bootstrap --force-conflicts -f - >/dev/null
}

rand_hex() {
  openssl rand -hex 32
}

secret_data_value() {
  local secret_name="$1"
  local key="$2"
  kubectl -n "$NAMESPACE" get secret "$secret_name" -o json \
    | python3 -c 'import base64,json,sys; value=json.load(sys.stdin).get("data",{}).get(sys.argv[1],""); sys.stdout.write(base64.b64decode(value).decode() if value else "")' "$key"
}

existing_secret_value() {
  local key="$1"
  if secret_exists "$INFRA_SECRET_NAME"; then
    secret_data_value "$INFRA_SECRET_NAME" "$key"
  fi
}

existing_or_generated() {
  local key="$1"
  local value
  value="$(existing_secret_value "$key")"
  if [[ -n "$value" ]]; then
    printf '%s' "$value"
  else
    rand_hex
  fi
}

existing_or_default() {
  local key="$1"
  local default="$2"
  local value
  value="$(existing_secret_value "$key")"
  if [[ -n "$value" ]]; then
    printf '%s' "$value"
  else
    printf '%s' "$default"
  fi
}

env_or_existing() {
  local key="$1"
  local value="${!key:-}"
  if [[ -n "$value" ]]; then
    printf '%s' "$value"
    return
  fi
  existing_secret_value "$key"
}

env_or_existing_or_generated() {
  local key="$1"
  local value="${!key:-}"
  if [[ -n "$value" ]]; then
    printf '%s' "$value"
    return
  fi
  existing_or_generated "$key"
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

require_cmd python3
if [[ "$CHECK_ONLY" != "1" ]]; then
  require_cmd kubectl
fi

if [[ ! -r "$CODEX_AUTH_FILE" ]]; then
  echo "FATAL: Codex auth JSON is not readable: $CODEX_AUTH_FILE" >&2
  echo "Run 'codex login' locally with ChatGPT login, then retry." >&2
  exit 1
fi

if [[ "$CODEX_AUTH_ONLY" != "1" ]]; then
  if [[ "$CHECK_ONLY" != "1" ]]; then
    require_cmd openssl
  fi
  if [[ ! -r "$ENV_FILE" ]]; then
    echo "FATAL: deploy env file is not readable: $ENV_FILE" >&2
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
fi

validate_codex_auth

if [[ "$CHECK_ONLY" == "1" ]]; then
  echo "Local Warrunner secret inputs are valid; no Kubernetes Secrets were changed."
  exit 0
fi

kubectl create namespace "$NAMESPACE" --dry-run=client -o yaml | kubectl apply -f - >/dev/null

delete_if_forced "$CODEX_AUTH_SECRET_NAME"

kubectl -n "$NAMESPACE" create secret generic "$CODEX_AUTH_SECRET_NAME" \
  --from-file=auth.json="$CODEX_AUTH_FILE" \
  --dry-run=client -o yaml | apply_kubectl_yaml
echo "Applied Secret $CODEX_AUTH_SECRET_NAME in namespace $NAMESPACE"

if [[ "$CODEX_AUTH_ONLY" == "1" ]]; then
  exit 0
fi

delete_if_forced "$INFRA_SECRET_NAME"
delete_if_forced centaur-firewall-ca
delete_if_forced centaur-firewall-ca-key

POSTGRES_PASSWORD="$(existing_or_generated POSTGRES_PASSWORD)"
DATABASE_URL="$(existing_or_default DATABASE_URL "postgresql://tempo:${POSTGRES_PASSWORD}@${RELEASE_NAME}-centaur-postgres:5432/ai_v2")"
DISCORDBOT_API_KEY="$(existing_or_generated DISCORDBOT_API_KEY)"
SLACKBOT_API_KEY="$(env_or_existing_or_generated SLACKBOT_API_KEY)"
SLACK_SIGNING_SECRET="$(env_or_existing_or_generated SLACK_SIGNING_SECRET)"
SLACK_BOT_TOKEN="${SLACK_BOT_TOKEN:-$(existing_or_default SLACK_BOT_TOKEN "xoxb-warrunner-slack-disabled")}"
LMNR_PROJECT_API_KEY="$(env_or_existing LMNR_PROJECT_API_KEY)"
LMNR_BASE_URL="$(env_or_existing LMNR_BASE_URL)"

secret_args=(
  -n "$NAMESPACE" create secret generic "$INFRA_SECRET_NAME"
  --from-literal=POSTGRES_PASSWORD="$POSTGRES_PASSWORD"
  --from-literal=DATABASE_URL="$DATABASE_URL"
  --from-literal=IRON_MANAGEMENT_API_KEY="$(existing_or_generated IRON_MANAGEMENT_API_KEY)"
  --from-literal=SANDBOX_SIGNING_KEY="$(existing_or_generated SANDBOX_SIGNING_KEY)"
  --from-literal=DISCORD_BOT_TOKEN="$DISCORD_BOT_TOKEN"
  --from-literal=DISCORDBOT_API_KEY="$DISCORDBOT_API_KEY"
  --from-literal=SLACK_BOT_TOKEN="$SLACK_BOT_TOKEN"
  --from-literal=SLACK_SIGNING_SECRET="$SLACK_SIGNING_SECRET"
  --from-literal=SLACKBOT_API_KEY="$SLACKBOT_API_KEY"
  --from-literal=LMNR_PROJECT_API_KEY="$LMNR_PROJECT_API_KEY"
  --from-literal=LMNR_BASE_URL="$LMNR_BASE_URL"
  --dry-run=client -o yaml
)
ANTHROPIC_API_KEY="$(env_or_existing ANTHROPIC_API_KEY)"
AMP_API_KEY="$(env_or_existing AMP_API_KEY)"
GITHUB_TOKEN="$(env_or_existing GITHUB_TOKEN)"
if [[ -n "$ANTHROPIC_API_KEY" ]]; then
  secret_args+=(--from-literal=ANTHROPIC_API_KEY="$ANTHROPIC_API_KEY")
fi
if [[ -n "$AMP_API_KEY" ]]; then
  secret_args+=(--from-literal=AMP_API_KEY="$AMP_API_KEY")
fi
if [[ -n "$GITHUB_TOKEN" ]]; then
  secret_args+=(--from-literal=GITHUB_TOKEN="$GITHUB_TOKEN")
fi
kubectl "${secret_args[@]}" | apply_kubectl_yaml
echo "Applied Secret $INFRA_SECRET_NAME in namespace $NAMESPACE"

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
    --from-file=ca-cert.pem="$CA_CERT" \
    --dry-run=client -o yaml | apply_kubectl_yaml
  kubectl -n "$NAMESPACE" create secret generic centaur-firewall-ca-key \
    --from-file=ca-cert.pem="$CA_CERT" \
    --from-file=ca-key.pem="$CA_KEY" \
    --dry-run=client -o yaml | apply_kubectl_yaml
  echo "Applied firewall CA Secrets in namespace $NAMESPACE"
fi
