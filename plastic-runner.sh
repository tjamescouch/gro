#!/bin/bash
# plastic-runner.sh — PLASTIC mode wrapper for gro.
# Uses the supervisor for warm-state preservation across @@reboot@@ cycles.
# The supervisor holds runtime state (spend, violations, familiarity, deja-vu)
# in its heap and sends it back to each new worker via IPC — no cold-storage
# fallback needed.
#
# Training-only infrastructure — never used in production.
#
# Usage: ./plastic-runner.sh [gro args...]
# Example: ./plastic-runner.sh -i -c "Modify your own memory system"

# The supervisor handles restart-on-exit-75 internally (with warm state),
# so this script just launches it and propagates the exit code.
GRO_PLASTIC=1 exec gro-supervised "$@"
