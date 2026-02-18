# SPIKE: Batch Summarization for Virtual Memory

**Author:** Samantha  
**Date:** 2026-02-18  
**Status:** Proposal

## Context

gro's VirtualMemory currently summarizes old messages synchronously during page compaction. Each summarization blocks the agent turn and costs full API price. Anthropic's Batch API offers 50% discount on input/output tokens for async processing. This SPIKE evaluates moving summarization to batch mode.

## Current Architecture

### Synchronous Summarization Flow
1. `compact()` detects working memory exceeds high watermark
2. Messages partitioned by swimlane (assistant/user/system/tool)
3. Older messages from each lane saved as immutable `ContextPage` on disk
4. **BLOCKING:** `summarizeWithRef()` calls Anthropic API synchronously
5. Summary with embedded `` ref replaces paged messages
6. Agent turn resumes

**Pain points:**
- Summarization blocks turn completion (~1-3s per lane)
- Full API cost (no batch discount)
- Multiple lanes = multiple sequential API calls

### `summarizeWithRef()` Implementation
```typescript
private async summarizeWithRef(
  messages: ChatMessage[],
  pageId: string,
  label: string,
  lane?: "assistant" | "user" | "system",
): Promise<string>
```
- Takes messages + page metadata
- Sends summarization prompt to `cfg.driver` (Anthropic)
- Returns compact summary with inline ref
- **Timing:** synchronous, blocks `compact()`, blocks agent turn

## Batch API Overview

### Anthropic Message Batches
- **Endpoint:** `POST https://api.anthropic.com/v1/messages/batches`
- **Cost:** 50% off input + output tokens
- **Latency:** 5min–24hr (depends on queue)
- **Max:** 10k requests/batch, 32MB total
- **Polling:** check status via `GET /v1/messages/batches/{batch_id}`
- **Results:** download JSONL file when complete

### Request Format
```jsonl
{"custom_id": "page-abc123", "params": {"model": "claude-haiku-4-5", "max_tokens": 1024, "messages": [...]}}
{"custom_id": "page-def456", "params": {...}}
```

### Response Format
```jsonl
{"custom_id": "page-abc123", "result": {"type": "succeeded", "message": {"content": [{"type": "text", "text": "Summary here"}]}}}
```

## Proposed Architecture

### Async Batch Summarization Flow

**Phase 1: Queueing (in `compact()`)**
1. Detect high watermark exceeded
2. Partition messages into swimlanes
3. Save pages to disk as before
4. **NEW:** Push page IDs to summarization queue
5. **NEW:** Insert placeholder summary (e.g., `[Pending summary for 42 messages] `)
6. Continue agent turn immediately (no blocking)

**Phase 2: Batch Submission (background worker)**
1. Batch worker polls queue every N seconds
2. Collects pending page IDs (up to batch limit)
3. For each page, load messages from disk and construct summarization request
4. Submit batch to Anthropic Batch API
5. Store `batch_id` + `custom_id` → `page_id` mapping

**Phase 3: Polling & Completion (background worker)**
1. Worker polls each active batch for status
2. When batch completes, download results JSONL
3. Parse results, extract summaries
4. **Update pages on disk:** replace placeholder summary with final summary
5. Optionally notify via log or callback

**Phase 4: Lazy Loading (on ref)**
1. Model encounters `` in context
2. VirtualMemory loads page from disk
3. If summary is still placeholder → model sees crude summary
4. If summary is finalized → model sees high-quality LLM summary

### Components

#### 1. **SummarizationQueue** (in-memory + disk persistence)
```typescript
interface QueuedSummarization {
  pageId: string;
  label: string;
  lane?: "assistant" | "user" | "system";
  queuedAt: number;
}

class SummarizationQueue {
  private queue: QueuedSummarization[] = [];
  private queuePath: string;
  
  enqueue(item: QueuedSummarization): void;
  dequeue(limit: number): QueuedSummarization[];
  persist(): void;
  load(): void;
}
```

#### 2. **AnthropicBatchClient** (new driver)
```typescript
interface BatchRequest {
  custom_id: string;
  params: {
    model: string;
    max_tokens: number;
    messages: any[];
  };
}

interface BatchStatus {
  id: string;
  processing_status: "in_progress" | "ended";
  ended_at?: string;
  results_url?: string;
}

class AnthropicBatchClient {
  constructor(apiKey: string, baseUrl?: string);
  
  async submitBatch(requests: BatchRequest[]): Promise<string>; // returns batch_id
  async getBatchStatus(batchId: string): Promise<BatchStatus>;
  async downloadResults(resultsUrl: string): Promise<any[]>; // parsed JSONL
}
```

#### 3. **BatchWorker** (background process)
```typescript
class BatchWorker {
  private queue: SummarizationQueue;
  private client: AnthropicBatchClient;
  private activeBatches: Map<string, { pageIds: string[], submittedAt: number }>;
  
  async run(): Promise<void> {
    while (true) {
      await this.submitPendingBatches();
      await this.pollActiveBatches();
      await sleep(60_000); // 1min cycle
    }
  }
  
  private async submitPendingBatches(): Promise<void>;
  private async pollActiveBatches(): Promise<void>;
  private async updatePageSummaries(results: any[]): Promise<void>;
}
```

#### 4. **Modified VirtualMemory**
```typescript
// In VirtualMemory constructor:
private summaryQueue: SummarizationQueue;

// In createPage():
if (this.cfg.driver && this.cfg.enableBatchSummarization) {
  // Queue for async summarization
  this.summaryQueue.enqueue({ pageId: page.id, label, lane });
  summary = `[Pending summary for ${messages.length} messages] `;
} else {
  // Fallback: synchronous summarization
  summary = await this.summarizeWithRef(messages, page.id, label, lane);
}
```

## Trade-offs

### Benefits
- **50% cost savings** on all summarization (both input + output)
- **Non-blocking compaction** — agent continues immediately
- **Batch parallelism** — multiple lanes/pages summarized in one batch
- **Graceful degradation** — placeholder summaries allow continued operation

### Costs
- **Latency:** summaries take 5min–24hr to finalize
- **Complexity:** new background worker process
- **State management:** track pending batches, handle failures
- **Crude summaries:** model sees placeholder until batch completes

### Failure Modes
- **Batch submission fails:** retry logic + fallback to sync
- **Batch never completes:** timeout + fallback regeneration
- **Worker dies:** persist queue to disk, resume on restart
- **Partial results:** handle per-request errors in batch

## Implementation Plan

### Phase 1: Batch Client (2-3 hours)
- [ ] Implement `AnthropicBatchClient` (submit/poll/download)
- [ ] Unit tests for batch API wrapper
- [ ] Add to gro drivers

### Phase 2: Queue + Persistence (1-2 hours)
- [ ] Implement `SummarizationQueue` (enqueue/dequeue/persist)
- [ ] Store queue at `~/.gro/summarization-queue.jsonl`
- [ ] Add queue to VirtualMemory constructor

### Phase 3: VirtualMemory Integration (2 hours)
- [ ] Add `enableBatchSummarization` config flag
- [ ] Modify `createPage()` to queue instead of blocking
- [ ] Generate placeholder summaries

### Phase 4: Background Worker (3-4 hours)
- [ ] Implement `BatchWorker` (submit/poll/update loop)
- [ ] Add worker lifecycle to gro runtime (start/stop)
- [ ] Handle batch submission + polling

### Phase 5: Result Processing (2 hours)
- [ ] Parse batch results JSONL
- [ ] Update pages on disk with finalized summaries
- [ ] Add logging for batch completion

### Phase 6: Error Handling + Fallbacks (2-3 hours)
- [ ] Retry logic for failed submissions
- [ ] Timeout detection for stalled batches
- [ ] Fallback to sync summarization on critical failures

### Phase 7: Testing + Polish (3 hours)
- [ ] Integration test: trigger compaction → queue → batch → results
- [ ] Load test: 100+ pages queued simultaneously
- [ ] Monitor logs for batch savings
- [ ] Documentation

**Total estimate:** 15-19 hours

## Open Questions

1. **Worker process lifecycle:** standalone daemon or embedded in gro?
   - Embedded: simpler, single process
   - Daemon: survives gro restarts, shared across agents

2. **Batch size tuning:** how many pages per batch?
   - Start with 50 (leaves headroom for 10k limit)
   - Monitor latency vs. throughput

3. **Polling frequency:** how often check batch status?
   - Start with 1min (Anthropic docs suggest 60s minimum)

4. **Placeholder quality:** crude vs. simple heuristic?
   - Option A: `[Pending summary] `
   - Option B: first/last message snippet + ref

5. **Failure threshold:** when give up and re-summarize sync?
   - 24hr timeout (Anthropic max) + 1 retry

## Success Metrics

- [ ] **Cost reduction:** 40-50% savings on summarization (measured via logs)
- [ ] **Latency reduction:** compaction < 100ms (down from 1-3s)
- [ ] **Queue throughput:** 100+ pages/day processed without backlog
- [ ] **Failure rate:** < 1% batch failures

## Next Steps

1. **Get approval** from jc + team
2. **Create feature branch:** `samantha/batch-summarization`
3. **Implement Phase 1-2** (batch client + queue)
4. **Demo** with single-agent test case
5. **Roll out** to production agents incrementally

---

**End of SPIKE**
