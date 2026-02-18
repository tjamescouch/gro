# Batch Summarization

**Status:** Phase 4 complete (background worker implemented)

## Overview

Batch summarization uses Anthropic's Message Batches API to process page summaries asynchronously at 50% cost reduction. Instead of blocking gro execution while waiting for summary API calls, pages are queued and processed in the background.

## Architecture

### Components

1. **SummarizationQueue** (`src/memory/summarization-queue.ts`)
   - Persistent queue for pages awaiting summarization
   - Stores pageId, label, lane, queuedAt timestamp
   - Survives gro restarts

2. **AnthropicBatchClient** (`src/drivers/batch/anthropic-batch.ts`)
   - API client for Anthropic Batch API
   - Submit batches, poll status, download results
   - Handles up to 10,000 requests per batch

3. **BatchWorker** (`src/memory/batch-worker.ts`)
   - Background worker that:
     - Polls queue for pending pages
     - Submits batch requests to Anthropic
     - Polls batch status until complete (5min-24hr)
     - Updates page summaries on disk when results arrive

4. **VirtualMemory Integration** (`src/memory/virtual-memory.ts`)
   - `enableBatchSummarization` flag (default: false)
   - When enabled, pages are enqueued instead of summarized inline
   - No breaking changes — synchronous path still works

### Workflow

```
[Page full] → Enqueue → Queue persists to disk
                            ↓
                    BatchWorker polls queue
                            ↓
                    Submit batch to Anthropic
                            ↓
                    Poll status every 5min
                            ↓
                    Download results when ready
                            ↓
                    Update page.summary on disk
                            ↓
                    VirtualMemory loads updated summary on next @@ref
```

## Usage

### Option 1: Integrated Worker (Not Yet Implemented)

Future: VirtualMemory spawns BatchWorker as a background thread/process automatically.

### Option 2: Standalone Worker Process

Run the worker as an independent process:

```bash
# From host
node dist/batch-worker-standalone.js \
  --queue-path /path/to/queue.json \
  --pages-dir /path/to/pages \
  --api-key $ANTHROPIC_API_KEY \
  --poll-interval 60000 \
  --batch-poll-interval 300000 \
  --model claude-haiku-4-5
```

Or via environment:

```bash
export ANTHROPIC_API_KEY=sk-ant-...
export QUEUE_PATH=/tmp/gro-queue.json
export PAGES_DIR=/tmp/gro-pages
node dist/batch-worker-standalone.js
```

### Enable in VirtualMemory

```typescript
const vm = new VirtualMemory({
  // ...
  enableBatchSummarization: true,
  summarizationQueuePath: "/tmp/gro-queue.json",
});
```

Or via gro CLI (when flag is added):

```bash
gro --enable-batch-summarization --queue-path /tmp/gro-queue.json ...
```

## Cost Savings

- **Synchronous (current default):** Full API cost, blocks execution
- **Batch (async):** 50% discount on input+output tokens, non-blocking
- **Latency:** 5min-24hr (acceptable for page summaries — they're loaded on-demand)

## Deployment

### Local Testing

1. Enable batch mode in gro config
2. Run standalone worker in separate terminal:
   ```bash
   node dist/batch-worker-standalone.js
   ```
3. Monitor queue: `cat /tmp/gro-queue.json`
4. Check page summaries update after batch completes

### Production (Podman/systemd)

Create systemd unit for batch worker:

```ini
[Unit]
Description=Gro Batch Worker
After=network.target

[Service]
Type=simple
User=agent
WorkingDirectory=/home/agent
ExecStart=/usr/local/bin/node /usr/local/lib/node_modules/@tjamescouch/gro/dist/batch-worker-standalone.js
Environment=ANTHROPIC_API_KEY=<from-keychain>
Environment=QUEUE_PATH=/home/agent/.gro/queue.json
Environment=PAGES_DIR=/home/agent/.gro/pages
Restart=always
RestartSec=10

[Install]
WantedBy=multi-user.target
```

Enable and start:

```bash
systemctl --user enable gro-batch-worker
systemctl --user start gro-batch-worker
systemctl --user status gro-batch-worker
```

## Implementation Phases

- ✅ **Phase 1:** AnthropicBatchClient (submit, poll, download)
- ✅ **Phase 2:** SummarizationQueue (persistent queue)
- ✅ **Phase 3:** VirtualMemory integration (enqueue on page full)
- ✅ **Phase 4:** BatchWorker (background processing loop)
- ⏳ **Phase 5:** Auto-spawn worker from VirtualMemory (optional)
- ⏳ **Phase 6:** CLI flags + environment defaults

## Caveats

- Queue persists across restarts — old items will be processed eventually
- If worker crashes, in-progress batches may be lost (need to track batch state)
- No retry logic yet for failed batch submissions
- Page summaries update asynchronously — may lag behind page creation

## Future Enhancements

- Batch state persistence (track in-progress batches)
- Retry failed submissions with exponential backoff
- Metrics: queue depth, batch processing latency, cost savings
- Dashboard: visualize queue size, active batches, success rate
