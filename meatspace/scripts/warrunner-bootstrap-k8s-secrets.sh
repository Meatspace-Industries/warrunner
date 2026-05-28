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
TMPDIRS_TO_CLEAN=()

cleanup_tmpdirs() {
  local dir
  if [[ ${#TMPDIRS_TO_CLEAN[@]} -eq 0 ]]; then
    return
  fi
  for dir in "${TMPDIRS_TO_CLEAN[@]}"; do
    if [[ -n "$dir" ]]; then
      rm -rf "$dir"
    fi
  done
}
trap cleanup_tmpdirs EXIT

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

require_env_or_existing_value() {
  local name="$1"
  if [[ -n "${!name:-}" ]]; then
    return
  fi
  if [[ -n "$(existing_secret_value "$name")" ]]; then
    return
  fi
  echo "FATAL: $name is required in $ENV_FILE or existing Secret $INFRA_SECRET_NAME" >&2
  exit 1
}

has_existing_secret_key() {
  local key="$1"
  secret_has_key "$INFRA_SECRET_NAME" "$key"
}

secret_exists() {
  command -v kubectl >/dev/null 2>&1 || return 1
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

add_secret_file_arg() {
  local dir="$1"
  local key="$2"
  local value="$3"
  local file="$dir/$key"
  printf '%s' "$value" > "$file"
  chmod 600 "$file"
  secret_file_args+=(--from-file="$key=$file")
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

secret_has_key() {
  local secret_name="$1"
  local key="$2"
  command -v kubectl >/dev/null 2>&1 || return 1
  kubectl -n "$NAMESPACE" get secret "$secret_name" -o json 2>/dev/null \
    | python3 -c 'import json,sys; sys.exit(0 if sys.argv[1] in json.load(sys.stdin).get("data", {}) else 1)' "$key"
}

remove_secret_key_if_present() {
  local secret_name="$1"
  local key="$2"
  if secret_has_key "$secret_name" "$key"; then
    kubectl -n "$NAMESPACE" patch secret "$secret_name" \
      --type=json \
      -p="[{\"op\":\"remove\",\"path\":\"/data/${key}\"}]" >/dev/null
    echo "Removed forbidden key $key from Secret $secret_name in namespace $NAMESPACE"
  fi
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
import base64
import datetime as dt
import json
import sys

def decode_payload(token):
    parts = str(token or "").split(".")
    if len(parts) < 2:
        return {}
    payload = parts[1]
    payload += "=" * ((4 - len(payload) % 4) % 4)
    try:
        return json.loads(base64.urlsafe_b64decode(payload))
    except Exception:
        return {}

def codex_client_id(data, tokens):
    access_payload = decode_payload(tokens.get("access_token"))
    if access_payload.get("client_id"):
        return str(access_payload["client_id"]).strip()
    if access_payload.get("azp"):
        return str(access_payload["azp"]).strip()
    id_payload = decode_payload(tokens.get("id_token"))
    aud = id_payload.get("aud")
    if isinstance(aud, str):
        return aud.strip()
    if isinstance(aud, list):
        for item in aud:
            if isinstance(item, str) and item.strip():
                return item.strip()
    return ""

path = sys.argv[1]
with open(path, encoding="utf-8") as f:
    data = json.load(f)

if data.get("auth_mode") != "chatgpt":
    raise SystemExit("FATAL: Codex auth JSON must have auth_mode=chatgpt")

tokens = data.get("tokens")
if not isinstance(tokens, dict) or not tokens.get("refresh_token"):
    raise SystemExit("FATAL: Codex auth JSON is missing tokens.refresh_token")

if not tokens.get("account_id"):
    raise SystemExit("FATAL: Codex auth JSON is missing tokens.account_id")

if not codex_client_id(data, tokens):
    raise SystemExit("FATAL: Codex auth JSON is missing a recoverable client id")

if data.get("OPENAI_API_KEY"):
    raise SystemExit("FATAL: Codex auth JSON must not contain OPENAI_API_KEY")
PY
}

codex_auth_value() {
  local field="$1"
  python3 - "$CODEX_AUTH_FILE" "$field" <<'PY'
import base64
import datetime as dt
import json
import sys

def decode_payload(token):
    parts = str(token or "").split(".")
    if len(parts) < 2:
        return {}
    payload = parts[1]
    payload += "=" * ((4 - len(payload) % 4) % 4)
    try:
        return json.loads(base64.urlsafe_b64decode(payload))
    except Exception:
        return {}

def client_id(tokens):
    access_payload = decode_payload(tokens.get("access_token"))
    for key in ("client_id", "azp"):
        value = access_payload.get(key)
        if isinstance(value, str) and value.strip():
            return value.strip()
    id_payload = decode_payload(tokens.get("id_token"))
    aud = id_payload.get("aud")
    if isinstance(aud, str) and aud.strip():
        return aud.strip()
    if isinstance(aud, list):
        for item in aud:
            if isinstance(item, str) and item.strip():
                return item.strip()
    return ""

def token_expiry_iso(token):
    payload = decode_payload(token)
    exp = payload.get("exp")
    if not isinstance(exp, (int, float)):
        return ""
    return dt.datetime.fromtimestamp(exp, dt.timezone.utc).isoformat().replace("+00:00", "Z")

path, field = sys.argv[1], sys.argv[2]
with open(path, encoding="utf-8") as f:
    data = json.load(f)
tokens = data.get("tokens")
if not isinstance(tokens, dict):
    raise SystemExit(f"FATAL: Codex auth JSON has no tokens object")

if field == "refresh_token":
    value = tokens.get("refresh_token")
elif field == "account_id":
    value = tokens.get("account_id")
elif field == "client_id":
    value = client_id(tokens)
elif field == "broker_blob":
    refresh_token = tokens.get("refresh_token")
    if not isinstance(refresh_token, str) or not refresh_token.strip():
        raise SystemExit("FATAL: Codex auth JSON is missing refresh_token")
    value = json.dumps(
        {
            "access_token": tokens.get("access_token") or "",
            "refresh_token": refresh_token,
            "expires_at": token_expiry_iso(tokens.get("access_token")),
            "last_refresh": data.get("last_refresh") or "",
        },
        separators=(",", ":"),
    )
else:
    raise SystemExit(f"unknown Codex auth field: {field}")

if not isinstance(value, str) or not value.strip():
    raise SystemExit(f"FATAL: Codex auth JSON is missing {field}")
sys.stdout.write(value.strip())
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
  require_env_or_existing_value GITHUB_APP_ID
  require_env_or_existing_value GITHUB_APP_INSTALLATION_ID
  if [[ -n "${OPENAI_API_KEY:-}" ]]; then
    echo "FATAL: OPENAI_API_KEY must not be set for Warrunner; use Codex ChatGPT login auth instead" >&2
    exit 1
  fi
  if [[ -z "${WARRUNNER_HOME_FORUM_CHANNEL_ID:-}" && -z "${WARRUNNER_HOME_CHANNEL_IDS:-}" ]]; then
    echo "FATAL: WARRUNNER_HOME_FORUM_CHANNEL_ID or WARRUNNER_HOME_CHANNEL_IDS is required in $ENV_FILE" >&2
    exit 1
  fi
  if [[ -z "${GITHUB_APP_PRIVATE_KEY:-}" && -z "${GITHUB_APP_PRIVATE_KEY_BASE64:-}" && -z "${GITHUB_APP_PRIVATE_KEY_FILE:-}" ]] \
    && ! has_existing_secret_key GITHUB_APP_PRIVATE_KEY \
    && ! has_existing_secret_key GITHUB_APP_PRIVATE_KEY_BASE64; then
    echo "FATAL: GITHUB_APP_PRIVATE_KEY, GITHUB_APP_PRIVATE_KEY_BASE64, or GITHUB_APP_PRIVATE_KEY_FILE is required in $ENV_FILE or existing Secret $INFRA_SECRET_NAME" >&2
    exit 1
  fi
  if [[ -n "${GITHUB_APP_PRIVATE_KEY_FILE:-}" && ! -r "${GITHUB_APP_PRIVATE_KEY_FILE:-}" ]]; then
    echo "FATAL: GITHUB_APP_PRIVATE_KEY_FILE is not readable: $GITHUB_APP_PRIVATE_KEY_FILE" >&2
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

SECRET_TMPDIR="$(mktemp -d)"
TMPDIRS_TO_CLEAN+=("$SECRET_TMPDIR")
secret_file_args=(
  -n "$NAMESPACE" create secret generic "$INFRA_SECRET_NAME"
  --dry-run=client -o yaml
)
add_secret_file_arg "$SECRET_TMPDIR" POSTGRES_PASSWORD "$POSTGRES_PASSWORD"
add_secret_file_arg "$SECRET_TMPDIR" DATABASE_URL "$DATABASE_URL"
add_secret_file_arg "$SECRET_TMPDIR" IRON_MANAGEMENT_API_KEY "$(existing_or_generated IRON_MANAGEMENT_API_KEY)"
add_secret_file_arg "$SECRET_TMPDIR" IRON_BROKER_TOKEN "$(env_or_existing_or_generated IRON_BROKER_TOKEN)"
add_secret_file_arg "$SECRET_TMPDIR" SANDBOX_SIGNING_KEY "$(existing_or_generated SANDBOX_SIGNING_KEY)"
add_secret_file_arg "$SECRET_TMPDIR" DISCORD_BOT_TOKEN "$DISCORD_BOT_TOKEN"
add_secret_file_arg "$SECRET_TMPDIR" DISCORDBOT_API_KEY "$DISCORDBOT_API_KEY"
add_secret_file_arg "$SECRET_TMPDIR" SLACK_BOT_TOKEN "$SLACK_BOT_TOKEN"
add_secret_file_arg "$SECRET_TMPDIR" SLACK_SIGNING_SECRET "$SLACK_SIGNING_SECRET"
add_secret_file_arg "$SECRET_TMPDIR" SLACKBOT_API_KEY "$SLACKBOT_API_KEY"
add_secret_file_arg "$SECRET_TMPDIR" LMNR_PROJECT_API_KEY "$LMNR_PROJECT_API_KEY"
add_secret_file_arg "$SECRET_TMPDIR" LMNR_BASE_URL "$LMNR_BASE_URL"
OPENAI_CODEX_CLIENT_ID="${OPENAI_CODEX_CLIENT_ID:-$(codex_auth_value client_id)}"
OPENAI_CODEX_BLOB="${OPENAI_CODEX_BLOB:-$(codex_auth_value broker_blob)}"
OPENAI_CODEX_ACCOUNT_ID="${OPENAI_CODEX_ACCOUNT_ID:-$(codex_auth_value account_id)}"
add_secret_file_arg "$SECRET_TMPDIR" OPENAI_CODEX_CLIENT_ID "$OPENAI_CODEX_CLIENT_ID"
add_secret_file_arg "$SECRET_TMPDIR" OPENAI_CODEX_BLOB "$OPENAI_CODEX_BLOB"
add_secret_file_arg "$SECRET_TMPDIR" OPENAI_CODEX_ACCOUNT_ID "$OPENAI_CODEX_ACCOUNT_ID"
ANTHROPIC_API_KEY="$(env_or_existing ANTHROPIC_API_KEY)"
AMP_API_KEY="$(env_or_existing AMP_API_KEY)"
GITHUB_APP_ID="$(env_or_existing GITHUB_APP_ID)"
GITHUB_APP_INSTALLATION_ID="$(env_or_existing GITHUB_APP_INSTALLATION_ID)"
GITHUB_APP_PRIVATE_KEY="$(env_or_existing GITHUB_APP_PRIVATE_KEY)"
GITHUB_APP_PRIVATE_KEY_BASE64="$(env_or_existing GITHUB_APP_PRIVATE_KEY_BASE64)"
if [[ -z "$GITHUB_APP_PRIVATE_KEY" && -z "$GITHUB_APP_PRIVATE_KEY_BASE64" && -n "${GITHUB_APP_PRIVATE_KEY_FILE:-}" ]]; then
  GITHUB_APP_PRIVATE_KEY="$(< "$GITHUB_APP_PRIVATE_KEY_FILE")"
fi
if [[ -n "$ANTHROPIC_API_KEY" ]]; then
  add_secret_file_arg "$SECRET_TMPDIR" ANTHROPIC_API_KEY "$ANTHROPIC_API_KEY"
fi
if [[ -n "$AMP_API_KEY" ]]; then
  add_secret_file_arg "$SECRET_TMPDIR" AMP_API_KEY "$AMP_API_KEY"
fi
if [[ -n "$GITHUB_APP_ID" ]]; then
  add_secret_file_arg "$SECRET_TMPDIR" GITHUB_APP_ID "$GITHUB_APP_ID"
fi
if [[ -n "$GITHUB_APP_INSTALLATION_ID" ]]; then
  add_secret_file_arg "$SECRET_TMPDIR" GITHUB_APP_INSTALLATION_ID "$GITHUB_APP_INSTALLATION_ID"
fi
if [[ -n "$GITHUB_APP_PRIVATE_KEY" ]]; then
  add_secret_file_arg "$SECRET_TMPDIR" GITHUB_APP_PRIVATE_KEY "$GITHUB_APP_PRIVATE_KEY"
fi
if [[ -n "$GITHUB_APP_PRIVATE_KEY_BASE64" ]]; then
  add_secret_file_arg "$SECRET_TMPDIR" GITHUB_APP_PRIVATE_KEY_BASE64 "$GITHUB_APP_PRIVATE_KEY_BASE64"
fi
kubectl "${secret_file_args[@]}" | apply_kubectl_yaml
remove_secret_key_if_present "$INFRA_SECRET_NAME" OPENAI_API_KEY
remove_secret_key_if_present "$INFRA_SECRET_NAME" GITHUB_TOKEN
echo "Applied Secret $INFRA_SECRET_NAME in namespace $NAMESPACE"

if secret_exists centaur-firewall-ca && secret_exists centaur-firewall-ca-key; then
  echo "Firewall CA Secrets already exist in namespace $NAMESPACE; leaving unchanged"
else
  TMPDIR="$(mktemp -d)"
  TMPDIRS_TO_CLEAN+=("$TMPDIR")
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
