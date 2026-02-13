#!/usr/bin/env bash
set -euo pipefail

# gro adapter: gemini
# reads prompt from stdin, outputs completion to stdout
# env: GRO_MODEL, GRO_SYSTEM_PROMPT, GEMINI_API_KEY

prompt=$(cat)

api_key="${GEMINI_API_KEY:-}"
if [[ -z "$api_key" && -f "${GRO_CONFIG_FILE:-}" ]]; then
  api_key=$(grep "^gemini.api-key=" "$GRO_CONFIG_FILE" 2>/dev/null | cut -d= -f2- || true)
fi

if [[ -z "$api_key" ]]; then
  echo "gro/gemini: GEMINI_API_KEY not set" >&2
  exit 1
fi

model="${GRO_MODEL:-gemini-2.0-flash}"

if [[ -n "${GRO_SYSTEM_PROMPT:-}" ]]; then
  body=$(jq -nc \
    --arg prompt "$prompt" \
    --arg sys "$GRO_SYSTEM_PROMPT" \
    '{systemInstruction: {parts: [{text: $sys}]}, contents: [{role: "user", parts: [{text: $prompt}]}]}')
else
  body=$(jq -nc \
    --arg prompt "$prompt" \
    '{contents: [{role: "user", parts: [{text: $prompt}]}]}')
fi

curl -sS "https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${api_key}" \
  -H "Content-Type: application/json" \
  -d "$body" \
| jq -r '.candidates[0].content.parts[0].text // error(.error.message // "empty response")'
