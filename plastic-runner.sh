#!/bin/bash
# plastic-runner.sh — PLASTIC mode wrapper for gro.
# Restarts the agent on exit code 75 (@@reboot@@ marker).
# Training-only infrastructure — never used in production.
#
# Usage: ./plastic-runner.sh [gro args...]
# Example: ./plastic-runner.sh -i -c "Modify your own memory system"

MAX_REBOOTS=20
COUNT=0

while [ $COUNT -lt $MAX_REBOOTS ]; do
  GRO_PLASTIC=1 gro "$@"
  EXIT=$?
  if [ $EXIT -ne 75 ]; then
    exit $EXIT
  fi
  COUNT=$((COUNT + 1))
  echo "[plastic-runner] Reboot $COUNT/$MAX_REBOOTS"
done

echo "[plastic-runner] Max reboots ($MAX_REBOOTS) reached"
exit 1
