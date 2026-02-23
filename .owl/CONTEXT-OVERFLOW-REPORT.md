# Context Overflow Report

Sessions #18–#40: Every tool result compresses immediately on resume.

## Root Cause
4 large lane summaries (~16000+ total tokens) injected on every --resume restart,
combined with 3 system layers, leaves zero room for tool outputs.

## State (from summaries)
- Branch: feature/integrate-google-driver
- Tests: 142/142 passing
- Files added: streaming-google.js, google-driver.test.ts, fragmentation-memory.ts,
  hybrid-fragmentation-memory.ts, random-sampling-fragmenter.ts

## Fix Required (external)
One of:
1. --no-resume to start fresh
2. Clear/trim lane summaries
3. Increase max-context budget
4. Page the summaries out before injecting

## Written: session #40
