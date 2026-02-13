#!/usr/bin/env python3
"""gro adapter: openai
Reads prompt from stdin, outputs completion to stdout.
Env: GRO_MODEL, GRO_SYSTEM_PROMPT, OPENAI_API_KEY, GRO_CONFIG_FILE
"""

import sys
import os
import json
import urllib.request
import urllib.error


def load_config_value(key):
    config_file = os.environ.get("GRO_CONFIG_FILE", "")
    if not config_file or not os.path.exists(config_file):
        return ""
    with open(config_file) as f:
        for line in f:
            line = line.strip()
            if line.startswith(f"{key}="):
                return line.split("=", 1)[1]
    return ""


def main():
    prompt = sys.stdin.read().strip()
    if not prompt:
        print("gro/openai: empty prompt", file=sys.stderr)
        sys.exit(1)

    api_key = os.environ.get("OPENAI_API_KEY") or load_config_value("openai.api-key")
    if not api_key:
        print("gro/openai: OPENAI_API_KEY not set", file=sys.stderr)
        sys.exit(1)

    model = os.environ.get("GRO_MODEL") or "gpt-4o"
    system_prompt = os.environ.get("GRO_SYSTEM_PROMPT", "")

    messages = []
    if system_prompt:
        messages.append({"role": "system", "content": system_prompt})
    messages.append({"role": "user", "content": prompt})

    body = json.dumps({"model": model, "messages": messages}).encode()

    req = urllib.request.Request(
        "https://api.openai.com/v1/chat/completions",
        data=body,
        headers={
            "Content-Type": "application/json",
            "Authorization": f"Bearer {api_key}",
        },
    )

    try:
        with urllib.request.urlopen(req) as resp:
            data = json.loads(resp.read())
    except urllib.error.HTTPError as e:
        error_body = e.read().decode()
        try:
            err = json.loads(error_body)
            print(f"gro/openai: {err.get('error', {}).get('message', error_body)}", file=sys.stderr)
        except json.JSONDecodeError:
            print(f"gro/openai: HTTP {e.code}: {error_body[:200]}", file=sys.stderr)
        sys.exit(1)

    content = data.get("choices", [{}])[0].get("message", {}).get("content", "")
    if not content:
        print("gro/openai: empty response", file=sys.stderr)
        sys.exit(1)

    print(content.strip())


if __name__ == "__main__":
    main()
