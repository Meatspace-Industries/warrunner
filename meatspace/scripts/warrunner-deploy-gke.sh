#!/usr/bin/env bash
set -euo pipefail

NAMESPACE="centaur-system"
RELEASE_NAME="warrunner"
EGRESS_NAMESPACE="${WARRUNNER_EGRESS_NAMESPACE:-centaur-egress}"
PROJECT_ID="${GOOGLE_CLOUD_PROJECT:-dapp-455423}"
LOCATION="us-west1"
REPOSITORY="warrunner"
IMAGE_TAG="${WARRUNNER_IMAGE_TAG:-263a6e84}"
ENV_FILE="${WARRUNNER_DEPLOY_ENV_FILE:-$HOME/.config/warrunner/deploy.env}"
RENDER_ONLY=0
SKIP_IMAGE_CHECK=0

DEFAULT_DISCORD_GUILD_ID="1435290709363130390"
DEFAULT_DISCORD_BOT_USER_ID="1508581976779657369"
DEFAULT_HOME_CHANNEL_IDS="1508220472569888950"
DEFAULT_ALLOWED_ROLE_IDS="1494022319855894579,1494022320438902886,1494022325862137876"

usage() {
  cat <<'EOF'
Usage: meatspace/scripts/warrunner-deploy-gke.sh [options]

Deploys Warrunner to the dapp GKE cluster with the built Artifact Registry
images and the Discord forum/home-channel routing. Live deploys require the Kubernetes
Secrets created by warrunner-bootstrap-k8s-secrets.sh.

Options:
  --namespace <name>        Kubernetes namespace. Default: centaur-system
  --release-name <name>     Helm release name. Default: warrunner
  WARRUNNER_EGRESS_NAMESPACE may override the egress namespace. Default: centaur-egress
  --project <id>            Google Cloud project. Default: dapp-455423
  --location <name>         Artifact Registry location. Default: us-west1
  --repository <name>       Artifact Registry repository. Default: warrunner
  --image-tag <tag>         Image tag. Default: 263a6e84
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

require_secret_one_key() {
  local name="$1"
  shift
  if ! kubectl -n "$NAMESPACE" get secret "$name" -o json \
    | python3 -c 'import json,sys; data=json.load(sys.stdin).get("data", {}); sys.exit(0 if any(k in data and data[k] for k in sys.argv[1:]) else 1)' "$@"; then
    echo "FATAL: Kubernetes Secret $name is missing one of: $*" >&2
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
  python3 - "$rendered" <<'PY'
import re
import sys

text = open(sys.argv[1], encoding="utf-8").read()
def require_env(name, value):
    pattern = (
        r"name:\s*" + re.escape(name) + r"\s*\n"
        r"\s*value:\s*[\"']?" + re.escape(value) + r"[\"']?"
    )
    if not re.search(pattern, text):
        raise SystemExit(
            f"FATAL: rendered deployment is missing {name}={value}"
        )

require_env("FIREWALL_MANAGER_SECRET_SOURCE", "env")
require_env("KUBERNETES_FIREWALL_MANAGER_SECRET_SOURCE", "env")
require_env("KUBERNETES_TOOL_SERVER_PORT", "8001")
require_env("KUBERNETES_WORKFLOW_RUN_SECRET_ENV_KEYS", "DISCORD_BOT_TOKEN")
require_env("CENTAUR_REQUIRE_GITHUB_APP_AUTH", "true")
if "name: DISCORD_BOT_TOKEN" not in text:
    raise SystemExit("FATAL: rendered deployment does not inject DISCORD_BOT_TOKEN")
if re.search(r"name:\s*GITHUB_TOKEN\b", text):
    raise SystemExit("FATAL: rendered deployment still injects GITHUB_TOKEN")

postgres_policy = re.search(
    r"kind:\s*NetworkPolicy\s*\n"
    r"metadata:\s*\n"
    r"\s*name:\s*[\"']?[^\"'\n]*-centaur-postgres[\"']?\s*\n"
    r"(?P<body>.*?)(?:\n---|\Z)",
    text,
    re.S,
)
if not postgres_policy or not re.search(
    r"centaur\.ai/iron-proxy:\s*[\"']?true[\"']?",
    postgres_policy.group("body"),
):
    raise SystemExit(
        "FATAL: rendered Postgres NetworkPolicy does not admit iron-proxy pods"
    )

if re.search(
    r"name:\s*KUBERNETES_SANDBOX_EXTRA_ENV\s*\n\s*value:\s*.*OPENAI_API_KEY",
    text,
):
    raise SystemExit(
        "FATAL: rendered sandbox extra env still injects OPENAI_API_KEY"
    )
PY
}

require_cmd helm
require_cmd kubectl
if [[ "$SKIP_IMAGE_CHECK" != "1" ]]; then
  require_cmd gcloud
fi

DISCORD_GUILD_ID="${DISCORD_GUILD_ID:-$(env_value DISCORD_GUILD_ID)}"
DISCORD_GUILD_ID="${DISCORD_GUILD_ID:-$DEFAULT_DISCORD_GUILD_ID}"
DISCORD_BOT_USER_ID="${DISCORD_BOT_USER_ID:-$(env_value DISCORD_BOT_USER_ID)}"
DISCORD_BOT_USER_ID="${DISCORD_BOT_USER_ID:-$DEFAULT_DISCORD_BOT_USER_ID}"
HOME_FORUM_CHANNEL_ID="${WARRUNNER_HOME_FORUM_CHANNEL_ID:-$(env_value WARRUNNER_HOME_FORUM_CHANNEL_ID)}"
HOME_CHANNEL_IDS="${WARRUNNER_HOME_CHANNEL_IDS:-$(env_value WARRUNNER_HOME_CHANNEL_IDS)}"
HOME_CHANNEL_ID="${WARRUNNER_HOME_CHANNEL_ID:-$(env_value WARRUNNER_HOME_CHANNEL_ID)}"
if [[ -z "$HOME_CHANNEL_IDS" && -n "$HOME_CHANNEL_ID" ]]; then
  HOME_CHANNEL_IDS="$HOME_CHANNEL_ID"
fi
if [[ "$HOME_FORUM_CHANNEL_ID" == "$DEFAULT_HOME_CHANNEL_IDS" ]]; then
  HOME_CHANNEL_IDS="${HOME_CHANNEL_IDS:-$HOME_FORUM_CHANNEL_ID}"
  HOME_FORUM_CHANNEL_ID=""
fi
HOME_CHANNEL_IDS="${HOME_CHANNEL_IDS:-$DEFAULT_HOME_CHANNEL_IDS}"
ALLOWED_ROLE_IDS="${WARRUNNER_ALLOWED_ROLE_IDS:-$(env_value WARRUNNER_ALLOWED_ROLE_IDS)}"
ALLOWED_ROLE_IDS="${ALLOWED_ROLE_IDS:-$DEFAULT_ALLOWED_ROLE_IDS}"
HELM_ALLOWED_ROLE_IDS="${ALLOWED_ROLE_IDS//,/\\,}"
HELM_HOME_CHANNEL_IDS="${HOME_CHANNEL_IDS//,/\\,}"
MENTION_USER_ALIASES="${WARRUNNER_MENTION_USER_ALIASES:-$(env_value WARRUNNER_MENTION_USER_ALIASES)}"
HELM_MENTION_USER_ALIASES="${MENTION_USER_ALIASES//,/\\,}"
DNS_IP_BLOCKS="${WARRUNNER_DNS_IP_BLOCKS:-$(env_value WARRUNNER_DNS_IP_BLOCKS)}"
if [[ -z "$DNS_IP_BLOCKS" && "$RENDER_ONLY" != "1" ]]; then
  DNS_SERVICE_IP="$(kubectl -n kube-system get svc kube-dns -o jsonpath='{.spec.clusterIP}' 2>/dev/null || true)"
  if [[ -n "$DNS_SERVICE_IP" && "$DNS_SERVICE_IP" != "None" ]]; then
    DNS_IP_BLOCKS="${DNS_SERVICE_IP}/32"
  fi
fi

REGISTRY="${LOCATION}-docker.pkg.dev/${PROJECT_ID}/${REPOSITORY}"
helm_args=(
  "$RELEASE_NAME" contrib/chart
  -n "$NAMESPACE" --create-namespace
  -f meatspace/infra/helm/values.warrunner.yaml
  --set secretManager.existingSecretName=centaur-infra-env
  --set ironProxy.secretSource=env
  --set api.egressDiscovery.namespace="$EGRESS_NAMESPACE"
  --set api.image.repository="$REGISTRY/centaur-api"
  --set-string api.image.tag="$IMAGE_TAG"
  --set sandbox.image.repository="$REGISTRY/centaur-agent"
  --set-string sandbox.image.tag="$IMAGE_TAG"
  --set ironProxy.image.repository="$REGISTRY/centaur-iron-proxy"
  --set-string ironProxy.image.tag="$IMAGE_TAG"
  --set discordbot.image.repository="$REGISTRY/warrunner-discordbot"
  --set-string discordbot.image.tag="$IMAGE_TAG"
  --set overlay.image.repository="$REGISTRY/warrunner-overlay"
  --set-string overlay.image.tag="$IMAGE_TAG"
  --set-string "api.discordGuildId=$DISCORD_GUILD_ID"
  --set-string "discordbot.guildId=$DISCORD_GUILD_ID"
  --set-string "discordbot.botUserId=$DISCORD_BOT_USER_ID"
  --set-string "discordbot.homeForumChannelId=$HOME_FORUM_CHANNEL_ID"
  --set-string "discordbot.homeChannelIds=$HELM_HOME_CHANNEL_IDS"
  --set-string "discordbot.allowedRoleIds=$HELM_ALLOWED_ROLE_IDS"
)

if [[ -n "$MENTION_USER_ALIASES" ]]; then
  helm_args+=(--set-string "discordbot.mentionUserAliases=$HELM_MENTION_USER_ALIASES")
fi

if [[ -n "$DNS_IP_BLOCKS" ]]; then
  IFS=',' read -r -a dns_ip_blocks <<< "$DNS_IP_BLOCKS"
  for i in "${!dns_ip_blocks[@]}"; do
    cidr="${dns_ip_blocks[$i]}"
    cidr="${cidr//[[:space:]]/}"
    if [[ -n "$cidr" ]]; then
      helm_args+=(--set-string "networkPolicy.dnsIpBlocks[$i]=$cidr")
    fi
  done
fi

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
require_cmd python3
require_secret_key centaur-infra-env GITHUB_APP_ID
require_secret_key centaur-infra-env GITHUB_APP_INSTALLATION_ID
require_secret_one_key centaur-infra-env GITHUB_APP_PRIVATE_KEY GITHUB_APP_PRIVATE_KEY_BASE64
require_secret_key warrunner-codex-auth auth.json
reject_secret_key centaur-infra-env OPENAI_API_KEY
reject_secret_key centaur-infra-env GITHUB_TOKEN
validate_codex_auth_secret warrunner-codex-auth auth.json

kubectl create namespace "$EGRESS_NAMESPACE" --dry-run=client -o yaml | kubectl apply -f - >/dev/null

helm upgrade --install --force-conflicts "${helm_args[@]}"
