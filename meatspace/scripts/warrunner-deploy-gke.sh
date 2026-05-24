#!/usr/bin/env bash
set -euo pipefail

NAMESPACE="centaur-system"
RELEASE_NAME="warrunner"
PROJECT_ID="${GOOGLE_CLOUD_PROJECT:-dapp-455423}"
LOCATION="us-west1"
REPOSITORY="warrunner"
IMAGE_TAG="${WARRUNNER_IMAGE_TAG:-230dbad2}"
ENV_FILE="${WARRUNNER_DEPLOY_ENV_FILE:-$HOME/.config/warrunner/deploy.env}"
RENDER_ONLY=0
SKIP_IMAGE_CHECK=0

DEFAULT_DISCORD_GUILD_ID="1435290709363130390"
DEFAULT_HOME_FORUM_CHANNEL_ID="1508220472569888950"
DEFAULT_ALLOWED_ROLE_IDS="1494022320438902886,1494022325862137876"

usage() {
  cat <<'EOF'
Usage: meatspace/scripts/warrunner-deploy-gke.sh [options]

Deploys Warrunner to the dapp GKE cluster with the built Artifact Registry
images and the Discord forum-thread routing. Live deploys require the Kubernetes
Secrets created by warrunner-bootstrap-k8s-secrets.sh.

Options:
  --namespace <name>        Kubernetes namespace. Default: centaur-system
  --release-name <name>     Helm release name. Default: warrunner
  --project <id>            Google Cloud project. Default: dapp-455423
  --location <name>         Artifact Registry location. Default: us-west1
  --repository <name>       Artifact Registry repository. Default: warrunner
  --image-tag <tag>         Image tag. Default: 230dbad2
  --env-file <path>         Deploy env file. Default: ~/.config/warrunner/deploy.env
  --render-only             Render Helm manifests and verify invariants; do not deploy
  --skip-image-check        Do not verify image tags in Artifact Registry
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
    --project)
      PROJECT_ID="${2:?--project requires a value}"
      shift 2
      ;;
    --location)
      LOCATION="${2:?--location requires a value}"
      shift 2
      ;;
    --repository)
      REPOSITORY="${2:?--repository requires a value}"
      shift 2
      ;;
    --image-tag)
      IMAGE_TAG="${2:?--image-tag requires a value}"
      shift 2
      ;;
    --env-file)
      ENV_FILE="${2:?--env-file requires a value}"
      shift 2
      ;;
    --render-only)
      RENDER_ONLY=1
      shift
      ;;
    --skip-image-check)
      SKIP_IMAGE_CHECK=1
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

env_value() {
  local key="$1"
  if [[ ! -r "$ENV_FILE" ]]; then
    return
  fi
  awk -F= -v key="$key" '
    $0 !~ /^[[:space:]]*#/ && $1 == key {
      sub(/^[^=]*=/, "")
      print
      exit
    }
  ' "$ENV_FILE"
}

require_secret() {
  local name="$1"
  if ! kubectl -n "$NAMESPACE" get secret "$name" >/dev/null 2>&1; then
    echo "FATAL: missing Kubernetes Secret $name in namespace $NAMESPACE" >&2
    echo "Run meatspace/scripts/warrunner-bootstrap-k8s-secrets.sh first." >&2
    exit 1
  fi
}

require_secret_key() {
  local name="$1"
  local key="$2"
  local jsonpath_key="${key//./\\.}"
  if ! kubectl -n "$NAMESPACE" get secret "$name" -o jsonpath="{.data.${jsonpath_key}}" | grep -q .; then
    echo "FATAL: Kubernetes Secret $name is missing key $key" >&2
    exit 1
  fi
}

reject_secret_key() {
  local name="$1"
  local key="$2"
  if kubectl -n "$NAMESPACE" get secret "$name" -o json \
    | python3 -c 'import json,sys; sys.exit(0 if sys.argv[1] in json.load(sys.stdin).get("data", {}) else 1)' "$key"; then
    echo "FATAL: Kubernetes Secret $name must not contain forbidden key $key" >&2
    exit 1
  fi
}

validate_codex_auth_secret() {
  local name="$1"
  local key="$2"
  kubectl -n "$NAMESPACE" get secret "$name" -o json \
    | python3 -c '
import base64
import json
import sys

key = sys.argv[1]
secret = json.load(sys.stdin)
encoded = secret.get("data", {}).get(key)
if not encoded:
    raise SystemExit(f"FATAL: Kubernetes Secret is missing key {key}")

data = json.loads(base64.b64decode(encoded).decode())
if data.get("auth_mode") != "chatgpt":
    raise SystemExit("FATAL: Codex auth Secret must have auth_mode=chatgpt")

tokens = data.get("tokens")
if not isinstance(tokens, dict) or not tokens.get("refresh_token"):
    raise SystemExit("FATAL: Codex auth Secret is missing tokens.refresh_token")

if data.get("OPENAI_API_KEY"):
    raise SystemExit("FATAL: Codex auth Secret must not contain OPENAI_API_KEY")
' "$key"
}

image_exists() {
  local image="$1"
  gcloud artifacts docker tags list "$image" \
    --project "$PROJECT_ID" \
    --format="value(tag)" 2>/dev/null \
    | awk -v tag="$IMAGE_TAG" '$0 == tag { found=1 } END { exit found ? 0 : 1 }'
}

require_image_tag() {
  local name="$1"
  local image="${LOCATION}-docker.pkg.dev/${PROJECT_ID}/${REPOSITORY}/${name}"
  if ! image_exists "$image"; then
    echo "FATAL: image tag not found: ${image}:${IMAGE_TAG}" >&2
    exit 1
  fi
}

verify_rendered_invariants() {
  local rendered="$1"
  grep -q 'name: KUBERNETES_CODEX_AUTH_SECRET_NAME' "$rendered"
  grep -q 'value: "warrunner-codex-auth"' "$rendered"
  grep -q 'name: CENTAUR_DISABLED_INFRA_SECRETS' "$rendered"
  grep -q 'value: "OPENAI_API_KEY"' "$rendered"
  if grep -q 'name: OPENAI_API_KEY' "$rendered"; then
    echo "FATAL: rendered deployment still injects OPENAI_API_KEY" >&2
    exit 1
  fi
}

require_cmd helm
require_cmd kubectl
if [[ "$SKIP_IMAGE_CHECK" != "1" ]]; then
  require_cmd gcloud
fi

DISCORD_GUILD_ID="${DISCORD_GUILD_ID:-$(env_value DISCORD_GUILD_ID)}"
DISCORD_GUILD_ID="${DISCORD_GUILD_ID:-$DEFAULT_DISCORD_GUILD_ID}"
HOME_FORUM_CHANNEL_ID="${WARRUNNER_HOME_FORUM_CHANNEL_ID:-$(env_value WARRUNNER_HOME_FORUM_CHANNEL_ID)}"
HOME_FORUM_CHANNEL_ID="${HOME_FORUM_CHANNEL_ID:-$DEFAULT_HOME_FORUM_CHANNEL_ID}"
ALLOWED_ROLE_IDS="${WARRUNNER_ALLOWED_ROLE_IDS:-$(env_value WARRUNNER_ALLOWED_ROLE_IDS)}"
ALLOWED_ROLE_IDS="${ALLOWED_ROLE_IDS:-$DEFAULT_ALLOWED_ROLE_IDS}"
HELM_ALLOWED_ROLE_IDS="${ALLOWED_ROLE_IDS//,/\\,}"

REGISTRY="${LOCATION}-docker.pkg.dev/${PROJECT_ID}/${REPOSITORY}"
helm_args=(
  "$RELEASE_NAME" contrib/chart
  -n "$NAMESPACE" --create-namespace
  -f meatspace/infra/helm/values.warrunner.yaml
  --set secretManager.existingSecretName=centaur-infra-env
  --set ironProxy.secretSource=env
  --set api.image.repository="$REGISTRY/centaur-api"
  --set api.image.tag="$IMAGE_TAG"
  --set sandbox.image.repository="$REGISTRY/centaur-agent"
  --set sandbox.image.tag="$IMAGE_TAG"
  --set ironProxy.image.repository="$REGISTRY/centaur-iron-proxy"
  --set ironProxy.image.tag="$IMAGE_TAG"
  --set discordbot.image.repository="$REGISTRY/warrunner-discordbot"
  --set discordbot.image.tag="$IMAGE_TAG"
  --set overlay.image.repository="$REGISTRY/warrunner-overlay"
  --set overlay.image.tag="$IMAGE_TAG"
  --set-string "discordbot.guildId=$DISCORD_GUILD_ID"
  --set-string "discordbot.homeForumChannelId=$HOME_FORUM_CHANNEL_ID"
  --set-string "discordbot.allowedRoleIds=$HELM_ALLOWED_ROLE_IDS"
)

if [[ "$SKIP_IMAGE_CHECK" != "1" ]]; then
  require_image_tag centaur-api
  require_image_tag centaur-agent
  require_image_tag centaur-iron-proxy
  require_image_tag warrunner-discordbot
  require_image_tag warrunner-overlay
fi

rendered="$(mktemp)"
trap 'rm -f "$rendered"' EXIT
helm template "${helm_args[@]}" > "$rendered"
verify_rendered_invariants "$rendered"

if [[ "$RENDER_ONLY" == "1" ]]; then
  cat "$rendered"
  exit 0
fi

require_secret centaur-infra-env
require_secret warrunner-codex-auth
require_secret centaur-firewall-ca
require_secret centaur-firewall-ca-key
require_secret_key warrunner-codex-auth auth.json
require_cmd python3
reject_secret_key centaur-infra-env OPENAI_API_KEY
validate_codex_auth_secret warrunner-codex-auth auth.json

helm upgrade --install "${helm_args[@]}"
