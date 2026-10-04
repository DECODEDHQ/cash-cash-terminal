#!/usr/bin/env bash
set -euo pipefail

SERVICE_ID="srv-d82kd5jeo5us73f7qjrg"
RENDER_CONFIG="${RENDER_CLI_CONFIG_PATH:-$HOME/.render/cli.yaml}"

if [ ! -f "$RENDER_CONFIG" ]; then
  echo "Render CLI authentication is required first."
  exit 1
fi

IFS= read -r -s -p "Meta Model API key (hidden): " MODEL_API_KEY_INPUT
echo
trap 'unset MODEL_API_KEY_INPUT RENDER_API_TOKEN' EXIT

if [ -z "$MODEL_API_KEY_INPUT" ]; then
  echo "No key supplied. Nothing changed."
  exit 1
fi

VERIFY_BODY='{"model":"muse-spark-1.3","input":"Reply with the single word: ready"}'
VERIFY_RESULT="$({
  printf 'header = "Authorization: Bearer %s"\n' "$MODEL_API_KEY_INPUT"
  printf 'header = "Content-Type: application/json"\n'
} | curl --silent --show-error --fail-with-body --max-time 60 --config - \
  --request POST --data-binary "$VERIFY_BODY" https://api.meta.ai/v1/responses)"

if ! printf '%s' "$VERIFY_RESULT" | jq -e '(.output_text // "") | ascii_downcase | contains("ready")' >/dev/null; then
  echo "Meta Model API verification failed. Nothing changed."
  exit 1
fi
unset VERIFY_RESULT VERIFY_BODY

RENDER_API_TOKEN="$(awk '$1=="key:" { print $2; exit }' "$RENDER_CONFIG")"
if [ -z "$RENDER_API_TOKEN" ]; then
  echo "Render CLI credential was not found. Nothing changed."
  exit 1
fi

printf '%s' "$MODEL_API_KEY_INPUT" \
  | jq -Rs '{value:.}' \
  | curl --silent --show-error --fail-with-body --max-time 30 \
      --config <({
        printf 'header = "Authorization: Bearer %s"\n' "$RENDER_API_TOKEN"
        printf 'header = "Content-Type: application/json"\n'
      }) \
      --request PUT --data-binary @- \
      "https://api.render.com/v1/services/$SERVICE_ID/env-vars/MODEL_API_KEY" \
      >/dev/null

unset MODEL_API_KEY_INPUT RENDER_API_TOKEN

render restart "$SERVICE_ID" --confirm -o text >/dev/null
echo "Meta Model API key verified and installed in the existing Render service."
echo "Only the existing TOLA cloud service was restarted."
