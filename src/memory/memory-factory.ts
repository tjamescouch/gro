/**
 * Memory instance creation and sensory memory wiring.
 */

import { Logger, C } from "../logger.js";
import { createDriverForModel, defaultBaseUrl, resolveApiKey } from "../drivers/driver-factory.js";
import { inferProvider } from "../model-config.js";
import { SimpleMemory } from "./simple-memory.js";
import { VirtualMemory } from "./virtual-memory.js";
import { SensoryMemory } from "./sensory-memory.js";
import { createDefaultFactory } from "./sensory-view-factory.js";
import { spendMeter } from "../spend-meter.js";
import { injectSourcePages } from "../plastic/init.js";
import { saveSensoryState, loadSensoryState } from "../session.js";
import { SelfSource } from "./self-source.js";
import type { AgentMemory } from "./agent-memory.js";
import type { AwarenessSource } from "./awareness-source.js";
import type { ChatDriver } from "../drivers/types.js";
import type { GroConfig } from "../gro-types.js";
import type { FamiliarityTracker } from "../runtime/familiarity.js";
import type { DejaVuTracker } from "../runtime/deja-vu.js";

export async function createMemory(cfg: GroConfig, driver: ChatDriver, requestedMode?: string, sessionId?: string): Promise<AgentMemory> {
  const memoryMode = requestedMode ?? process.env.GRO_MEMORY ?? "virtual";

  // Opt-out: SimpleMemory only if explicitly requested
  if (memoryMode === "simple") {
    Logger.telemetry(`${C.cyan("MemoryMode=Simple")} ${C.gray("(GRO_MEMORY=simple)")}`);
    const mem = new SimpleMemory(cfg.systemPrompt || undefined);
    mem.setMeta(cfg.provider, cfg.model);
    return mem;
  }

  // Default: VirtualMemory (safe, cost-controlled)
  // Default summarizer: Groq llama-3.3-70b-versatile (free tier).
  // Falls back to main driver if no Groq key is available.
  const DEFAULT_SUMMARIZER_MODEL = "llama-3.3-70b-versatile";
  const summarizerModel = cfg.summarizerModel ?? DEFAULT_SUMMARIZER_MODEL;
  const summarizerProvider = inferProvider(undefined, summarizerModel);
  const summarizerApiKey = resolveApiKey(summarizerProvider);

  let summarizerDriver: ChatDriver | undefined;
  let effectiveSummarizerModel = summarizerModel;
  if (summarizerApiKey) {
    summarizerDriver = createDriverForModel(
      summarizerProvider,
      summarizerModel,
      summarizerApiKey,
      defaultBaseUrl(summarizerProvider),
    );
    Logger.telemetry(`Summarizer: ${summarizerProvider}/${summarizerModel}`);
  } else {
    // No key for the desired summarizer provider — fall back to main driver.
    // Use the main model name so the driver doesn't reject an incompatible model name.
    effectiveSummarizerModel = cfg.model;
    Logger.telemetry(`Summarizer: no ${summarizerProvider} key — using main driver (${cfg.provider}/${cfg.model})`);
  }

  // Fragmentation memory (stochastic sampling)
  if (memoryMode === "fragmentation") {
    Logger.telemetry(`${C.cyan("MemoryMode=Fragmentation")} ${C.gray(`workingMemory=${cfg.contextTokens} tokens`)}`);
    const { FragmentationMemory } = await import("./experimental/fragmentation-memory.js");
    const fm = new FragmentationMemory({
      systemPrompt: cfg.systemPrompt || undefined,
      workingMemoryTokens: cfg.contextTokens,
    });
    fm.setProvider(cfg.provider);
    fm.setModel(cfg.model);
    return fm;
  }

  // HNSW memory (semantic similarity retrieval)
  if (memoryMode === "hnsw") {
    Logger.telemetry(`${C.cyan("MemoryMode=HNSW")} ${C.gray(`workingMemory=${cfg.contextTokens} tokens, semantic retrieval`)}`);
    const { HNSWMemory } = await import("./experimental/hnsw-memory.js");
    const hm = new HNSWMemory({
      driver: summarizerDriver ?? driver,
      summarizerModel: effectiveSummarizerModel,
      systemPrompt: cfg.systemPrompt || undefined,
      workingMemoryTokens: cfg.contextTokens,
    });
    hm.setProvider(cfg.provider);
    hm.setModel(cfg.model);
    return hm;
  }

  // PerfectMemory (fork-based persistent recall)
  if (memoryMode === "perfect") {
    Logger.telemetry(`${C.cyan("MemoryMode=Perfect")} ${C.gray(`workingMemory=${cfg.contextTokens} tokens, fork-based recall`)}`);
    const { PerfectMemory } = await import("./experimental/perfect-memory.js");
    const pm = new PerfectMemory({
      driver: summarizerDriver ?? driver,
      summarizerModel: effectiveSummarizerModel,
      systemPrompt: cfg.systemPrompt || undefined,
      workingMemoryTokens: cfg.contextTokens,
      enableBatchSummarization: cfg.batchSummarization,
    });
    pm.setProvider(cfg.provider);
    pm.setModel(cfg.model);
    return pm;
  }

    Logger.telemetry(`${C.cyan("MemoryMode=Virtual")} ${C.gray(`(default) workingMemory=${cfg.contextTokens} tokens`)}`);
  const vm = new VirtualMemory({
    driver: summarizerDriver ?? driver,
    summarizerModel: effectiveSummarizerModel,
    systemPrompt: cfg.systemPrompt || undefined,
    workingMemoryTokens: cfg.contextTokens,
    enableBatchSummarization: cfg.batchSummarization,
    sessionId,
  });
  vm.setProvider(cfg.provider);
  vm.setModel(cfg.model);
  return vm;
}

/** Dependencies for sensory memory wiring. */
export interface SensoryDeps {
  familiarityTracker: FamiliarityTracker;
  dejaVuTracker: DejaVuTracker;
}

/**
 * Wrap an AgentMemory with SensoryMemory decorator + ContextMapSource.
 * Three-slot camera system:
 *   slot0 = "context" (fill bars, runtime health)
 *   slot1 = "time"    (wall clock, uptime, channel staleness)
 *   slot2 = "awareness" (familiarity, deja vu)
 * Both slots are agent-switchable via <view:X> marker.
 * Returns the wrapped memory. If wrapping fails, returns the original.
 */
export function wrapWithSensory(inner: AgentMemory, deps: SensoryDeps): AgentMemory {
  try {
    const sensory = new SensoryMemory(inner, { totalBudget: 1200 });
    const factory = createDefaultFactory();
    const memDeps = { memory: inner, spendMeter };

    for (const spec of factory.specs()) {
      sensory.addChannel({
        name: spec.name,
        maxTokens: spec.maxTokens,
        updateMode: spec.updateMode,
        content: "",
        enabled: spec.enabled,
        source: factory.create(spec.name, memDeps),
        width: spec.width,
        height: spec.height,
        viewable: spec.viewable,
      });
    }

    // Wire awareness trackers
    const awarenessSource = sensory.getChannelSource("awareness") as AwarenessSource | undefined;
    if (awarenessSource) {
      awarenessSource.setFamiliarity(deps.familiarityTracker);
      awarenessSource.setDejaVu(deps.dejaVuTracker);
    }

    // Default camera slots
    sensory.setSlot(0, "context");
    sensory.setSlot(1, "time");
    sensory.setSlot(2, "awareness");
    return sensory;
  } catch (err) {
    Logger.warn(`Failed to initialize sensory memory: ${err}`);
    return inner;
  }
}

/** Unwrap SensoryMemory decorator to get the underlying memory for duck-typed method calls. */
export function unwrapMemory(mem: AgentMemory): AgentMemory {
  return mem instanceof SensoryMemory ? (mem as SensoryMemory).getInner() : mem;
}

/** In PLASTIC mode, inject source pages into VirtualMemory so the agent can @@ref@@ them. */
export function injectPlasticSourcePages(mem: AgentMemory): void {
  if (!process.env.GRO_PLASTIC) return;
  const inner = unwrapMemory(mem);
  if (inner instanceof VirtualMemory) {
    const count = injectSourcePages(inner);
    if (count > 0) Logger.telemetry(`[PLASTIC] Injected ${count} source pages into virtual memory`);
  }
}

/** Capture and save sensory channel state alongside session data. */
export function saveSensorySnapshot(mem: AgentMemory, sessionId: string): void {
  if (!(mem instanceof SensoryMemory)) return;
  const sensory = mem as SensoryMemory;
  const selfSrc = sensory.getChannelSource("self");
  const selfContent = selfSrc && "getContent" in selfSrc
    ? (selfSrc as SelfSource).getContent()
    : "";
  saveSensoryState(sessionId, {
    selfContent,
    channelDimensions: sensory.getChannelDimensions(),
    slotAssignments: [sensory.getSlot(0), sensory.getSlot(1), sensory.getSlot(2)],
  });
}

/** Restore sensory channel state after session load. */
export function restoreSensorySnapshot(mem: AgentMemory, sessionId: string): void {
  if (!(mem instanceof SensoryMemory)) return;
  const state = loadSensoryState(sessionId);
  if (!state) return;
  const sensory = mem as SensoryMemory;
  // Restore self content
  if (state.selfContent) {
    const selfSrc = sensory.getChannelSource("self");
    if (selfSrc && "setContent" in selfSrc) {
      (selfSrc as SelfSource).setContent(state.selfContent);
    }
  }
  // Restore channel dimensions
  if (state.channelDimensions) {
    sensory.restoreChannelDimensions(state.channelDimensions);
  }
  // Restore slot assignments
  if (state.slotAssignments) {
    state.slotAssignments.forEach((ch, i) => {
      if (ch) sensory.setSlot(i as 0 | 1 | 2, ch);
    });
  }
  Logger.debug(`Restored sensory state for session ${sessionId}`);
}
