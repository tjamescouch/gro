# Memory Module Design — Opus

Design goals:
1. **Modular** — composable primitives, not monoliths
2. **Observable** — every eviction/load/summarize is traceable
3. **Budget-aware** — explicit token accounting, no implicit overflow
4. **Semantic** — use meaning, not just recency
5. **Adaptive** — behavior shifts with thinking budget

## Core Abstractions

### 1. MemoryStore (persistence layer)
Interface for reading/writing immutable blocks.

```typescript
interface MemoryStore {
  write(id: string, content: string, metadata: Record<string, any>): Promise<void>;
  read(id: string): Promise<{ content: string; metadata: Record<string, any> }>;
  list(filter?: (meta: Record<string, any>) => boolean): Promise<string[]>;
}
```

**Implementations:**
- `FileStore` — `.gro/pages/` (current)
- `SQLiteStore` — structured queries, full-text search
- `VectorStore` — semantic similarity search

### 2. Compactor (context reduction)
Takes a sequence of messages, produces a smaller representation.

```typescript
interface Compactor {
  compact(messages: ChatMessage[], budget: number): Promise<CompactResult>;
}

interface CompactResult {
  /** Reduced messages (summaries, preserved, etc) */
  messages: ChatMessage[];
  /** Evicted blocks saved to store */
  archived: { id: string; messages: ChatMessage[] }[];
  /** Token count of result */
  tokens: number;
}
```

**Implementations:**
- `SummarizingCompactor` — LLM-based swim-lane summarization (current)
- `ImportanceCompactor` — preserve high-importance, summarize rest
- `SemanticCompactor` — cluster related messages, summarize clusters
- `HybridCompactor` — importance + recency + semantic similarity weighted
- `PassthroughCompactor` — no-op for SimpleMemory

### 3. Retriever (context expansion)
Pulls archived blocks back into working memory on demand.

```typescript
interface Retriever {
  retrieve(query: string, maxTokens: number): Promise<RetrievalResult>;
}

interface RetrievalResult {
  /** Blocks loaded from store */
  blocks: { id: string; content: string; score: number }[];
  /** Total tokens */
  tokens: number;
}
```

**Implementations:**
- `RefRetriever` — explicit `🧠` markers (current VirtualMemory inline refs)
- `SemanticRetriever` — vector similarity search
- `KeywordRetriever` — grep-style matching
- `HybridRetriever` — combine multiple strategies

### 4. Budget (token accounting)
Explicit allocation for different zones.

```typescript
interface Budget {
  total: number;
  pageSlot: number;
  workingMemory: number;
  system: number;
}
```

**Strategy:**
- Thinking budget 0.0–0.3 → conservative (small page slot, aggressive compaction)
- Thinking budget 0.3–0.7 → balanced (current defaults)
- Thinking budget 0.7–1.0 → expansive (large page slot, preserve more)

### 5. MemoryPolicy (orchestration)
Decides when/how to compact and retrieve.

```typescript
interface MemoryPolicy {
  shouldCompact(state: MemoryState): boolean;
  shouldRetrieve(state: MemoryState, markers: string[]): boolean;
  selectCompactor(state: MemoryState): Compactor;
  selectRetriever(state: MemoryState): Retriever;
}

interface MemoryState {
  messages: ChatMessage[];
  tokens: number;
  budget: Budget;
  thinkingBudget: number;
  loaded: Set<string>;
}
```

**Implementations:**
- `WatermarkPolicy` — high/low thresholds (current AdvancedMemory)
- `AdaptivePolicy` — adjust behavior based on thinking budget
- `EagerPolicy` — proactive retrieval on semantic triggers
- `ConservativePolicy` — minimize LLM calls, aggressive truncation

## Proposed Module: `AdaptiveMemory`

Combines all primitives with thinking-budget-driven behavior.

```typescript
class AdaptiveMemory extends AgentMemory {
  constructor(
    store: MemoryStore,
    policy: MemoryPolicy,
    compactors: Map<string, Compactor>,
    retrievers: Map<string, Retriever>,
    budget: Budget
  ) { ... }

  async add(msg: ChatMessage): Promise<void> {
    this.messagesBuffer.push(msg);
    
    const state = this.getState();
    
    // Check for retrieval markers (🧠, semantic triggers)
    const markers = this.extractMarkers(msg);
    if (this.policy.shouldRetrieve(state, markers)) {
      const retriever = this.policy.selectRetriever(state);
      const result = await retriever.retrieve(msg.content, this.budget.pageSlot);
      this.loadBlocks(result.blocks);
    }
    
    // Check if compaction needed
    if (this.policy.shouldCompact(state)) {
      const compactor = this.policy.selectCompactor(state);
      const result = await compactor.compact(
        this.messagesBuffer,
        this.budget.workingMemory
      );
      this.messagesBuffer = result.messages;
      for (const arch of result.archived) {
        await this.store.write(arch.id, JSON.stringify(arch.messages), {
          createdAt: new Date().toISOString(),
          messageCount: arch.messages.length
        });
      }
    }
  }
}
```

## Concrete Implementations

### ImportanceCompactor
Preserves messages by importance score, summarizes the rest.

```typescript
class ImportanceCompactor implements Compactor {
  constructor(
    private driver: ChatDriver,
    private summarizerModel: string,
    private importanceThreshold: number = 0.7
  ) {}

  async compact(messages: ChatMessage[], budget: number): Promise<CompactResult> {
    const { keep, summarize } = this.partition(messages);
    
    const summary = await this.summarize(summarize);
    const result = [...keep, summary];
    
    return {
      messages: result,
      archived: [{ id: this.hash(summarize), messages: summarize }],
      tokens: this.estimateTokens(result)
    };
  }

  private partition(messages: ChatMessage[]) {
    const keep: ChatMessage[] = [];
    const summarize: ChatMessage[] = [];
    
    for (const msg of messages) {
      const importance = this.extractImportance(msg);
      if (importance >= this.importanceThreshold) {
        keep.push(msg);
      } else {
        summarize.push(msg);
      }
    }
    
    return { keep, summarize };
  }

  private extractImportance(msg: ChatMessage): number {
    // Parse 🧠 markers
    const match = msg.content.match(/@@importance\(['"]?([\d.]+)['"]?\)@@/);
    if (match) return parseFloat(match[1]);
    
    // Check for 🧠 inline marker
    if (msg.content.includes("🧠")) return 1.0;
    
    // Check for 🧠 inline marker
    if (msg.content.includes("🧠")) return 0.0;
    
    // Default: moderate importance
    return 0.5;
  }
}
```

### SemanticRetriever
Uses vector embeddings to find relevant past context.

```typescript
class SemanticRetriever implements Retriever {
  constructor(
    private store: MemoryStore,
    private embeddings: EmbeddingProvider
  ) {}

  async retrieve(query: string, maxTokens: number): Promise<RetrievalResult> {
    const queryEmbed = await this.embeddings.embed(query);
    
    const allIds = await this.store.list();
    const scored: { id: string; score: number }[] = [];
    
    for (const id of allIds) {
      const { content, metadata } = await this.store.read(id);
      const embed = metadata.embedding || await this.embeddings.embed(content);
      const score = this.cosineSimilarity(queryEmbed, embed);
      scored.push({ id, score });
    }
    
    scored.sort((a, b) => b.score - a.score);
    
    const blocks: { id: string; content: string; score: number }[] = [];
    let tokens = 0;
    
    for (const { id, score } of scored) {
      const { content } = await this.store.read(id);
      const blockTokens = this.estimateTokens(content);
      if (tokens + blockTokens > maxTokens) break;
      blocks.push({ id, content, score });
      tokens += blockTokens;
    }
    
    return { blocks, tokens };
  }

  private cosineSimilarity(a: number[], b: number[]): number {
    let dot = 0, magA = 0, magB = 0;
    for (let i = 0; i < a.length; i++) {
      dot += a[i] * b[i];
      magA += a[i] * a[i];
      magB += b[i] * b[i];
    }
    return dot / (Math.sqrt(magA) * Math.sqrt(magB));
  }
}
```

### AdaptivePolicy
Switches strategies based on thinking budget.

```typescript
class AdaptivePolicy implements MemoryPolicy {
  shouldCompact(state: MemoryState): boolean {
    const ratio = state.tokens / state.budget.workingMemory;
    const threshold = state.thinkingBudget < 0.3 ? 0.6 : 0.75;
    return ratio > threshold;
  }

  shouldRetrieve(state: MemoryState, markers: string[]): boolean {
    // Always retrieve explicit 🧠 markers
    if (markers.some(m => m.startsWith('@@ref'))) return true;
    
    // High thinking budget → proactive semantic retrieval
    if (state.thinkingBudget > 0.7) {
      return markers.some(m => this.isSemantic Trigger(m));
    }
    
    return false;
  }

  selectCompactor(state: MemoryState): Compactor {
    if (state.thinkingBudget < 0.3) {
      // Low budget → aggressive importance-based eviction
      return new ImportanceCompactor(driver, 'haiku', 0.8);
    } else if (state.thinkingBudget > 0.7) {
      // High budget → semantic clustering for richer summaries
      return new SemanticCompactor(driver, 'sonnet');
    } else {
      // Balanced → swim-lane summarization (current default)
      return new SummarizingCompactor(driver, 'haiku');
    }
  }

  selectRetriever(state: MemoryState): Retriever {
    if (state.thinkingBudget > 0.7) {
      // High budget → semantic search
      return new SemanticRetriever(store, embeddings);
    } else {
      // Low/mid budget → explicit refs only
      return new RefRetriever(store);
    }
  }

  private isSemanticTrigger(marker: string): boolean {
    // Detect questions, uncertainty, references to past work
    return /\b(when|why|how|remember|earlier|previously|mentioned)\b/i.test(marker);
  }
}
```

## Migration Path

1. **Phase 1:** Extract interfaces from VirtualMemory
   - Create `MemoryStore`, `Compactor`, `Retriever` interfaces
   - Implement `FileStore`, `SummarizingCompactor`, `RefRetriever` as wrappers around existing code
   - No behavior change, just refactoring for testability

2. **Phase 2:** Implement new compactors/retrievers
   - `ImportanceCompactor` — preserve 🧠 messages
   - `SemanticRetriever` — vector search using AgentHNSW
   - Test alongside VirtualMemory

3. **Phase 3:** Build `AdaptivePolicy`
   - Switches behavior based on thinking budget
   - Start conservative (low budget → ImportanceCompactor, high budget → SemanticCompactor)

4. **Phase 4:** Release `AdaptiveMemory`
   - New memory module using all primitives
   - VirtualMemory still available as fallback
   - Gradual migration with A/B testing

## Key Improvements

1. **Composability** — mix/match compactors and retrievers
2. **Testability** — each primitive can be unit tested
3. **Transparency** — every compact/retrieve logs what was kept/evicted
4. **Adaptability** — thinking budget controls memory strategy
5. **Extensibility** — easy to add SQLiteStore, new compactors, etc.

## Open Questions

1. Should we standardize on importance markers (🧠) across all memory modules?
2. What's the right default thinking budget → compactor mapping?
3. Should semantic retrieval be opt-in or automatic at high thinking budgets?
4. How do we handle archived blocks that grow stale (outdated facts, obsolete tasks)?
5. Should we introduce a `MemoryObserver` interface for logging/metrics?

---

Next steps: @jc review this design, decide if we build AdaptiveMemory or iterate on VirtualMemory.
