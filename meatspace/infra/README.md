# Warrunner GKE Deploy

Warrunner runs Codex from ChatGPT login auth, not OpenAI API billing. Do not add
`OPENAI_API_KEY` to the deploy env file, the shared Kubernetes Secret, or Helm
values. The bootstrap and deploy wrappers reject that key.

## Inputs

- GKE context: `gke_dapp-455423_us-west1-a_warrunner`
- Namespace: `centaur-system`
- Deploy env: `~/.config/warrunner/deploy.env`
- Codex auth: `~/.codex/auth.json` from a local `codex login`
- Images: `us-west1-docker.pkg.dev/dapp-455423/warrunner/*:c41aac82`

Create the deploy env from the template:

```bash
mkdir -p ~/.config/warrunner
cp meatspace/infra/warrunner.deploy.env.example ~/.config/warrunner/deploy.env
chmod 600 ~/.config/warrunner/deploy.env
```

Fill in `DISCORD_BOT_TOKEN`. The other Discord IDs in the template are the
current Meatspace Warrunner values.

Get the bot token from Discord Developer Portal:

1. Create or open the Warrunner application.
2. Go to Bot and reset/copy the token.
3. Enable Guilds, Guild Messages, and Message Content intents.
4. Invite the bot with permissions to view channels, read message history, send
   messages, create public threads, and send messages in threads.
5. Confirm it can access forum channel `1508220472569888950`.

## Bootstrap

Run the safe preflight first:

```bash
meatspace/scripts/warrunner-bootstrap-k8s-secrets.sh --check-only
```

The real bootstrap writes Kubernetes Secrets. It uploads local ChatGPT Codex auth
from `~/.codex/auth.json` into `warrunner-codex-auth`, so get explicit operator
approval before running it:

```bash
meatspace/scripts/warrunner-bootstrap-k8s-secrets.sh
```

Expected Secrets:

- `centaur-infra-env`
- `warrunner-codex-auth`
- `centaur-firewall-ca`
- `centaur-firewall-ca-key`

## Deploy

Render and verify invariants without changing the cluster:

```bash
meatspace/scripts/warrunner-deploy-gke.sh --render-only >/tmp/warrunner-render.yaml
rg -n "KUBERNETES_CODEX_AUTH_SECRET_NAME|CENTAUR_DISABLED_INFRA_SECRETS|name: OPENAI_API_KEY|OPENAI_API_KEY" /tmp/warrunner-render.yaml
```

The only `OPENAI_API_KEY` occurrence should be the disabled-secret marker:
`CENTAUR_DISABLED_INFRA_SECRETS=OPENAI_API_KEY`.

Deploy:

```bash
meatspace/scripts/warrunner-deploy-gke.sh
```

Then inspect rollout state:

```bash
kubectl -n centaur-system get pods
kubectl -n centaur-system logs deploy/warrunner-centaur-discordbot
```
