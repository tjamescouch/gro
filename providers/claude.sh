#!/usr/bin/env bash
set -euo pipefail

# gro adapter: claude
# reads prompt from stdin, outputs completion to stdout
# env: GRO_MODEL, GRO_SYSTEM_PROMPT

prompt=$(cat)

# try CLI first
if command -v claude &>/dev/null; then
  args=(-p)
  [[ -n "${GRO_MODEL:-}" ]] && args+=(--model "$GRO_MODEL")
  [[ -n "${GRO_SYSTEM_PROMPT:-}" ]] && args+=(--system-prompt "$GRO_SYSTEM_PROMPT")
  echo "$prompt" | claude "${args[@]}"
  exit
fi

# fallback to HTTP API
api_key="${ANTHROPIC_API_KEY:-}"
if [[ -z "$api_key" && -f "${GRO_CONFIG_FILE:-}" ]]; then
  api_key=$(grep "^anthropic.api-key=" "$GRO_CONFIG_FILE" 2>/dev/null | cut -d= -f2- || true)
fi

if [[ -z "$api_key" ]]; then
  echo "gro/claude: neither \`claude\` CLI nor ANTHROPIC_API_KEY available" >&2
  exit 1
fi

model="${GRO_MODEL:-claude-sonnet-4-20250514}"

if [[ -n "${GRO_SYSTEM_PROMPT:-}" ]]; then
  body=$(jq -nc \
    --arg model "$model" \
    --arg prompt "$prompt" \
    --arg sys "$GRO_SYSTEM_PROMPT" \
    '{model: $model, max_tokens: 4096, system: $sys, messages: [{role: "user", content: $prompt}]}')
else
  body=$(jq -nc \
    --arg model "$model" \
    --arg prompt "$prompt" \
    '{model: $model, max_tokens: 4096, messages: [{role: "user", content: $prompt}]}')
fi

curl -sS https://api.anthropic.com/v1/messages \
  -H "Content-Type: application/json" \
  -H "x-api-key: ${api_key}" \
  -H "anthropic-version: 2023-06-01" \
  -d "$body" \
| jq -r '.content[0].text // error(.error.message // "empty response")'
