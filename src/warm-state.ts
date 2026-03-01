/**
 * WarmState — serializable snapshot of all gro runtime state.
 *
 * Transferred via IPC between supervisor and worker process.
 * Never touches disk. Preserves everything that cold storage loses:
 * spend meter, violations, familiarity/deja-vu trackers, thinking budget.
 */

import type { ChatMessage } from "./drivers/types.js";
import type { ContextPage } from "./memory/virtual-memory.js";
import type { SensoryState } from "./session.js";
import type { SpendSnapshot } from "./spend-meter.js";
import type { ViolationSnapshot } from "./violations.js";
import type { ActionSignature } from "./runtime/deja-vu.js";
import type { McpServerConfig } from "./mcp/index.js";

export const WARM_STATE_VERSION = 1;

export interface WarmState {
  version: typeof WARM_STATE_VERSION;
  timestamp: string;
  sessionId: string;

  // --- Memory ---
  memoryType: string;
  messages: ChatMessage[];
  /** VirtualMemory page state (null for SimpleMemory). */
  pageState?: {
    pages: Record<string, ContextPage>;
    activePageIds: string[];
    loadOrder: string[];
    pinnedPageIds: string[];
    pageRefCount: Record<string, number>;
    unrefHistory: string[];
  };

  // --- Sensory ---
  sensoryState: SensoryState | null;

  // --- Runtime Config ---
  runtime: {
    model: string;
    provider: string;
    activeModel: string;
    thinkingBudget: number;
    temperature?: number;
    topK?: number;
    topP?: number;
  };

  // --- Metrics ---
  spend: SpendSnapshot;
  violations: ViolationSnapshot | null;

  // --- Awareness Trackers ---
  familiarity: {
    scores: Record<string, number>;
    labels: Record<string, string>;
  };
  dejaVu: {
    history: Record<string, ActionSignature>;
    insertOrder: string[];
  };

  // --- Module-level state ---
  lastChatSendTarget: string | null;

  // --- MCP configs (for reconnection, not live handles) ---
  mcpConfigs: Record<string, McpServerConfig>;
}

/** IPC messages: worker → supervisor */
export type WorkerMessage =
  | { type: "state_snapshot"; payload: WarmState }
  | { type: "reload_request"; payload: WarmState }
  | { type: "ready" }
  | { type: "heartbeat" };

/** IPC messages: supervisor → worker */
export type SupervisorMessage =
  | { type: "warm_state"; payload: WarmState }
  | { type: "shutdown" };
