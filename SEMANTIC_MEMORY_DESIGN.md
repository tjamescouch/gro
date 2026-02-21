# SemanticMemory — Cross-Session Episodic Memory with Semantic Retrieval

## Problem Statement

Current gro memory implementations have gaps:

1. **VirtualMemory** (paged, swimlane-based):
   - ✅ Scales to long conversations via paging
   - ✅ Importance weighting
   - ❌ Pages loaded only via explicit `🧠` markers (agent must know page ID)
   - ❌ No semantic search — can't find relevant past context automatically
   - ❌ Session-scoped — no cross-session memory
   - ❌ Role-based partitioning (assistant/user/system) — not task/topic-based

2. **AdvancedMemory** (swimlane summarization):
   - ✅ Per-lane budgets
   - ❌ Summaries are lossy black boxes (no drill-down)
   - ❌ Session-scoped only

3. **SimpleMemory** (unbounded buffer):
   - ✅ Trivial implementation
   - ❌ No context management → OOM

**What's missing:** An agent can't remember "what it worked on last week" or "how it solved a similar bug before" without explicit page refs. No episodic memory across sessions.

---

## Design: SemanticMemory

A hybrid memory system that combines:
- **VirtualMemory's paging** (immutable pages on disk)
- **Semantic retrieval** (vector embeddings for relevance-based recall)
- **Episodic indexing** (cross-session task/conversation chunking)

### Key Innovations

1. **Automatic Semantic Retrieval**
   - Every page gets a vector embedding (via cheap embedding API: OpenAI `text-embedding-3-small`, Voyage, Cohere)
   - On each user message, query the vector index to find top-K relevant pages from *all sessions*
   - Auto-inject relevant pages into the working context (below system prompt, above recent messages)
   - Agent doesn't need to emit `🧠` — the system infers what's relevant

2. **Episodic Chunking (Task-Based Partitioning)**
   - Detect **episode boundaries** in the conversation (task transitions, major context shifts)
   - Partition by topic/task, not by role (assistant/user/system)
   - Episodes = chunks of conversation about a single task (e.g., "debug wormhole pipeline", "design memory module")
   - Each episode becomes a page with metadata: tags, task name, outcome, timestamp

3. **Cross-Session Memory**
   - Pages persist across sessions in a global store (`~/.gro/semantic-pages/`)
   - Each page has metadata:
     - `sessionId`: where it originated
     - `episodeName`: human-readable task/topic
     - `tags`: extracted keywords (repos, filenames, error messages)
     - `outcome`: success/fail/blocked
     - `embedding`: vector representation for similarity search
     - `createdAt`, `tokens`, `importance`

4. **Hybrid Retrieval**
   - **Recent context** (VirtualMemory-style): keep last N messages in working memory
   - **Semantic recall**: query vector index on each user message, load top-3 relevant pages
   - **Importance boost**: high-importance pages (0.7+) get a relevance bonus
   - **Recency decay**: older pages need higher relevance scores to surface

---

## Architecture

```
SemanticMemory extends AgentMemory
  ├── VirtualMemory (for paging recent messages)
  ├── VectorIndex (HNSW in-memory, persisted to disk)
  ├── EpisodeDetector (heuristic + optional LLM)
  └── EmbeddingClient (OpenAI/Voyage/Cohere API)
```

### Data Model

#### Page
```typescript
interface SemanticPage extends ContextPage {
  sessionId: string;
  episodeName: string;
  tags: string[];  // ["gro", "wormhole", "pipeline.sh", "NetworkError"]
  outcome: "success" | "failure" | "blocked" | "ongoing";
  embedding: Float32Array;  // 1536-dim for text-embedding-3-small
  importance: number;  // max importance across messages
  createdAt: string;
  tokens: number;
}
```

#### Vector Index
- **Storage**: HNSW (Hierarchical Navigable Small World) graph
- **Persistence**: JSON dump of graph + embeddings to `~/.gro/semantic-index.json`
- **Query**: cosine similarity, return top-K with score > threshold
- **Dimension**: 1536 (OpenAI `text-embedding-3-small`) or 1024 (Voyage)

#### Episode Detection
Heuristics for task boundaries:
- Long pauses (>5 minutes between messages)
- Explicit markers: "CLAIM:", "ENDEX:", "next task"
- Topic shift detection (optional LLM call): compare last 3 user messages

---

## Implementation Plan

### Phase 1: Semantic Retrieval on Top of VirtualMemory
1. Extend `VirtualMemory` to call `EmbeddingClient.embed(pageContent)` when creating pages
2. Store embeddings in page metadata
3. Build a persistent HNSW index (`~/.gro/semantic-index.json`)
4. On each user message:
   - Embed the user message
   - Query index for top-3 pages (cosine similarity > 0.75)
   - Load pages into the page slot (like `🧠` but automatic)

### Phase 2: Episodic Chunking
1. Add `EpisodeDetector` to detect task boundaries
2. When boundary detected:
   - Flush current episode to a page
   - Extract tags (filenames, repo names, error types)
   - Classify outcome (success/failure/blocked)
   - Generate embedding
3. Store episode metadata in index

### Phase 3: Cross-Session Recall
1. Pages stored in global dir (`~/.gro/semantic-pages/`)
2. Index spans all sessions
3. On wake, query index with: "What was I working on last?" (embed recent system prompt)
4. Auto-inject top-2 recent episodes into working context

---

## API Additions

### Config
```typescript
interface SemanticMemoryConfig extends VirtualMemoryConfig {
  embeddingProvider?: "openai" | "voyage" | "cohere";
  embeddingModel?: string;  // default: "text-embedding-3-small"
  embeddingDimension?: number;  // 1536
  semanticThreshold?: number;  // 0.75 (min cosine similarity to inject)
  maxSemanticPages?: number;  // 3 (max auto-injected pages per turn)
  episodeDetection?: "heuristic" | "llm";  // default: heuristic
  globalPagesDir?: string;  // default: ~/.gro/semantic-pages/
  indexPath?: string;  // default: ~/.gro/semantic-index.json
}
```

### Stream Markers
- `🧠` — manually mark episode boundary
- `🧠` — hint tags for current episode
- `🧠` — classify task result

### Tools
- `semantic_search(query: string)` — explicit semantic search (for agent use)
- `list_episodes()` — show recent episode history

---

## Cost Analysis

### Embedding Costs
- **OpenAI `text-embedding-3-small`**: $0.02 / 1M tokens
- Average page: 2000 tokens → $0.00004 per page
- 1000 pages embedded: $0.04
- **Negligible cost** compared to LLM inference

### Latency
- Embedding API call: ~50ms (cached after first call)
- HNSW query: <1ms for 10K pages
- **No perceivable latency** in the execution loop

### Storage
- 1536-dim float32 embedding: 6KB per page
- 1000 pages: 6MB index
- **Trivial disk usage**

---

## Why This Matters

Current memory systems are **amnesiacs**. After a session ends or context is paged out, the agent forgets everything unless you explicitly `🧠` a page ID.

**With SemanticMemory:**
- Agent remembers "how I fixed the wormhole pipeline last time"
- On similar tasks, relevant past solutions auto-surface
- Cross-session continuity — agent builds up knowledge over time
- Episodic structure mirrors human memory (tasks, not raw messages)

**Use cases:**
- Debugging: "This error looks familiar" → semantic search → find solution from 2 weeks ago
- Onboarding: New agent instance queries "what were we working on?" → gets recent episode summaries
- Planning: "What blockers did we hit before?" → episodic recall of failed attempts

---

## Comparison to VirtualMemory

| Feature | VirtualMemory | SemanticMemory |
|---------|---------------|----------------|
| Paging | ✅ Swimlane-based | ✅ Episode-based |
| Importance weighting | ✅ | ✅ |
| Cross-session | ❌ | ✅ |
| Semantic retrieval | ❌ (manual `🧠`) | ✅ (automatic) |
| Episodic structure | ❌ (role-based) | ✅ (task-based) |
| Cost overhead | $0 | ~$0.04 per 1000 pages |
| Latency overhead | 0ms | ~50ms per turn (embedding) |

---

## Next Steps

1. **Prototype** in `src/memory/semantic-memory.ts`
2. **Integrate** HNSW library (e.g., `hnswlib-node`)
3. **Wire up** OpenAI embeddings API
4. **Test** on multi-session workflow (e.g., work on gro repo across 3 sessions)
5. **Tune** relevance threshold + recency decay weights
6. **Document** in gro README

---

## Alternative: Hybrid Approach (Low-Hanging Fruit)

If full SemanticMemory is too heavy, a **simpler first step**:

**Auto-Tagging VirtualMemory**
- Keep VirtualMemory as-is
- On page creation, extract tags (filenames, repo names, errors) via regex
- Store tags in page metadata
- Add `search_pages(tags: string[])` tool for agent to query by tag
- **No embeddings, no vector index, no cross-session recall**
- Still session-scoped but better than manual `🧠`

This is a 50-line addition to VirtualMemory. Ship it first, then build full SemanticMemory later.

---

## Open Questions

1. **Episode detection accuracy?**
   - Heuristic (keyword-based) vs. LLM (expensive but accurate)
   - Can we train a small classifier (DistilBERT) offline?

2. **Index size scaling?**
   - 10K pages = 60MB index. Acceptable?
   - Do we need disk-backed HNSW (e.g., FAISS)?

3. **Embedding model choice?**
   - OpenAI: cheap, fast, 1536-dim
   - Voyage: optimized for retrieval, 1024-dim, $0.08/1M tokens (4x more expensive)
   - Local model (sentence-transformers): free, slower, 384-dim

4. **Privacy concerns?**
   - Sending page content to embedding API → data leaves local machine
   - Option: local embeddings (e.g., `all-MiniLM-L6-v2` via ONNX)
   - Trade-off: quality vs. privacy

---

## Conclusion

SemanticMemory turns gro from a **stateless conversational executor** into a **learning agent** with persistent episodic memory. It's the difference between:

> "Run this command" (stateless)

vs.

> "Remember how we debugged this last time? Let me try that approach again." (episodic)

The cost is negligible (<$0.10 per 1000 pages), the latency is low (<50ms), and the UX improvement is massive.

**This is the memory system agents need to feel like persistent collaborators, not fresh instances every time.**
