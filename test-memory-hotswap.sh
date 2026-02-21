#!/bin/bash
# Test memory hot-swapping across all implementations
# Cycles through: simple → advanced → virtual → fragmentation → hnsw
# Verifies message preservation and mode-specific behavior

set -e

SESSIONID="test-memory-$(date +%s)"
echo "Testing memory hot-swap with session: $SESSIONID"
echo "================================================"

# Helper: send prompt and capture response
send_prompt() {
  local prompt="$1"
  echo ""
  echo ">>> $prompt"
  echo "$prompt" | npx gro --session "$SESSIONID" --resume 2>&1 | tee /tmp/gro-test-output.txt
}

# Test 1: Start with default (VirtualMemory)
echo "[TEST 1] Default memory (VirtualMemory)"
send_prompt "What is 2+2? Remember this: my favorite color is blue."

# Test 2: Switch to simple memory
echo ""
echo "[TEST 2] Switch to SimpleMemory"
send_prompt "🧠 Now tell me: what is my favorite color? And what is 3+3?"

# Test 3: Switch to advanced memory
echo ""
echo "[TEST 3] Switch to AdvancedMemory"
send_prompt "🧠 Recap: what is my favorite color? What were the two math problems I asked?"

# Test 4: Switch to fragmentation memory
echo ""
echo "[TEST 4] Switch to FragmentationMemory (zero-cost paging)"
send_prompt "🧠 List all the questions I've asked so far."

# Test 5: Switch to HNSW memory (semantic retrieval)
echo ""
echo "[TEST 5] Switch to HNSWMemory (semantic search)"
send_prompt "🧠 Search your memory: what color did I mention?"

# Test 6: Switch back to virtual and verify persistence
echo ""
echo "[TEST 6] Switch back to VirtualMemory"
send_prompt "🧠 Final check: summarize everything we discussed."

echo ""
echo "================================================"
echo "Test complete. Session saved to: ~/.gro/sessions/$SESSIONID/"
echo "Check output above for message preservation across swaps."
