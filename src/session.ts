import { mkdirSync, writeFileSync, readFileSync, existsSync, readdirSync, statSync, rmSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { randomUUID } from "node:crypto";
import type { ChatMessage } from "./drivers/types.js";
import { Logger } from "./logger.js";
import { groError, asError, errorLogFields } from "./errors.js";

/**
 * Clean up orphaned sessions older than the given age in milliseconds.
 * @param maxAgeMs Milliseconds (default: 48 hours = 172,800,000 ms)
 * @returns Number of sessions deleted
 */
export function cleanupOldSessions(maxAgeMs: number = 48 * 60 * 60 * 1000): number {
  const dir = contextDir();
  if (!existsSync(dir)) return 0;

  const now = Date.now();
  let deleted = 0;

  for (const entry of readdirSync(dir)) {
    const sessionPath = join(dir, entry);
    const metaPath = join(sessionPath, "meta.json");
    
    if (existsSync(metaPath)) {
      try {
        const meta = JSON.parse(readFileSync(metaPath, "utf-8"));
        const createdMs = meta.createdAt ? new Date(meta.createdAt).getTime() : 0;
        // Fall back to mtime if createdAt is missing or unparseable
        const age = createdMs > 0
          ? now - createdMs
          : now - statSync(metaPath).mtimeMs;

        if (age > maxAgeMs) {
          // Delete the entire session directory
          rmSync(sessionPath, { recursive: true, force: true });
          Logger.info(`Cleanup: removed orphaned session ${entry} (age: ${Math.round(age / 1000 / 60)}m)`);
          deleted++;
        }
      } catch (err) {
        Logger.warn(`Cleanup: failed to process session ${entry}: ${asError(err).message}`);
      }
    }
  }

  return deleted;
}

/**
 * Session persistence for gro.
 *
 * Layout:
 *   .gro/
 *     context/
 *       <session-id>/
 *         messages.json       — full message history
 *         meta.json           — session metadata (model, provider, timestamps)
 *         sensory-state.json  — sensory channel state (self content, dimensions, slots)
 */

/** Persisted sensory channel state. */
export interface SensoryState {
  selfContent: string;
  channelDimensions: Record<string, { width: number; height: number }>;
  slots: [string | null, string | null, string | null];
}

export interface SessionMeta {
  id: string;
  provider: string;
  model: string;
  createdAt: string;
  updatedAt: string;
}

const GRO_DIR = ".gro";
const CONTEXT_DIR = "context";

function groDir(): string {
  return join(homedir(), GRO_DIR);
}

function contextDir(): string {
  return join(groDir(), CONTEXT_DIR);
}

function sessionDir(id: string): string {
  return join(contextDir(), id);
}

/**
 * Ensure the .gro/context directory exists.
 */
export function ensureGroDir(): void {
  const dir = contextDir();
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }
}

/**
 * Generate a new session ID (short UUID prefix for readability).
 */
export function newSessionId(): string {
  return randomUUID().split("-")[0];
}

/**
 * Save a session to disk.
 */
export function saveSession(
  id: string,
  messages: ChatMessage[],
  meta: Omit<SessionMeta, "updatedAt">,
): void {
  const dir = sessionDir(id);
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }

  const fullMeta: SessionMeta = {
    ...meta,
    updatedAt: new Date().toISOString(),
  };

  try {
    writeFileSync(join(dir, "messages.json"), JSON.stringify(messages, null, 2));
    writeFileSync(join(dir, "meta.json"), JSON.stringify(fullMeta, null, 2));
  } catch (e: any) {
    const ge = groError(
      "session_error",
      `Failed to save session ${id}: ${asError(e).message}`,
      { cause: e },
    );
    Logger.error("Session save failed:", errorLogFields(ge));
    throw ge;
  }
}

/**
 * Sanitize a message array so every assistant tool_use has a matching tool_result.
 * When a session is killed mid-tool-call (e.g. SIGTERM from niki), the assistant
 * message with tool_calls is saved but the tool result messages are not.
 * The Anthropic API rejects this with a 400 error, causing an infinite crash loop.
 *
 * Strategy: walk backwards from the end. If we find an assistant message with
 * tool_calls that have no matching tool-role responses, inject synthetic
 * tool_result placeholders so the API accepts the history.
 */
function sanitizeToolPairs(messages: ChatMessage[]): ChatMessage[] {
  if (messages.length === 0) return messages;

  // Collect all tool_use IDs from assistant messages
  const toolUseIds = new Set<string>();
  for (const m of messages) {
    if (m.role === "assistant") {
      const toolCalls = (m as any).tool_calls as Array<{ id: string }> | undefined;
      if (Array.isArray(toolCalls)) {
        for (const tc of toolCalls) {
          if (tc.id) toolUseIds.add(tc.id);
        }
      }
    }
  }

  // Collect all tool_call IDs that have results
  const answeredIds = new Set<string>();
  for (const m of messages) {
    if (m.role === "tool" && m.tool_call_id) {
      answeredIds.add(m.tool_call_id);
    }
  }

  // Find assistant messages with unanswered tool_calls and inject placeholders.
  // Also drop tool_result messages whose tool_use was removed from history
  // (e.g. by context truncation) — the API rejects orphaned tool_results with 400.
  // Also deduplicate tool_results — the API rejects multiple results for the same tool_use.
  const seenToolResults = new Set<string>();
  const result: ChatMessage[] = [];
  for (const m of messages) {
    if (m.role === "tool" && m.tool_call_id && !toolUseIds.has(m.tool_call_id)) {
      Logger.debug(`Session repair: dropping orphaned tool_result for missing call ${m.tool_call_id}`);
      continue;
    }
    if (m.role === "tool" && m.tool_call_id && seenToolResults.has(m.tool_call_id)) {
      Logger.debug(`Session repair: dropping duplicate tool_result for call ${m.tool_call_id}`);
      continue;
    }
    if (m.role === "tool" && m.tool_call_id) {
      seenToolResults.add(m.tool_call_id);
    }
    result.push(m);
    const toolCalls = (m as any).tool_calls as Array<{ id: string; function?: { name?: string } }> | undefined;
    if (m.role === "assistant" && Array.isArray(toolCalls)) {
      for (const tc of toolCalls) {
        if (!answeredIds.has(tc.id)) {
          result.push({
            role: "tool",
            from: "system",
            content: "[Session interrupted — tool call was not completed. The agent was terminated before this tool could return a result.]",
            tool_call_id: tc.id,
            name: tc.function?.name,
          });
          answeredIds.add(tc.id);
          Logger.warn(`Session repair: injected placeholder tool_result for orphaned call ${tc.id} (${tc.function?.name ?? "unknown"})`);
        }
      }
    }
  }

  return result;
}

/**
 * Load a session from disk. Returns null if not found.
 * Automatically repairs orphaned tool_use blocks from interrupted sessions.
 */
export function loadSession(id: string): { messages: ChatMessage[]; meta: SessionMeta } | null {
  const dir = sessionDir(id);
  const msgPath = join(dir, "messages.json");
  const metaPath = join(dir, "meta.json");

  if (!existsSync(msgPath) || !existsSync(metaPath)) {
    return null;
  }

  try {
    const messages = sanitizeToolPairs(JSON.parse(readFileSync(msgPath, "utf-8")));
    const meta = JSON.parse(readFileSync(metaPath, "utf-8"));
    return { messages, meta };
  } catch (e: unknown) {
    const ge = groError("session_error", `Failed to load session ${id}: ${asError(e).message}`, { cause: e });
    Logger.warn(ge.message, errorLogFields(ge));
    return null;
  }
}

/**
 * Find the most recent session (for --continue).
 */
export function findLatestSession(): string | null {
  const dir = contextDir();
  if (!existsSync(dir)) return null;

  let latest: { id: string; mtime: number } | null = null;

  for (const entry of readdirSync(dir)) {
    const metaPath = join(dir, entry, "meta.json");
    if (existsSync(metaPath)) {
      const stat = statSync(metaPath);
      if (!latest || stat.mtimeMs > latest.mtime) {
        latest = { id: entry, mtime: stat.mtimeMs };
      }
    }
  }

  return latest?.id ?? null;
}

/**
 * List all sessions, sorted by most recent first.
 */
export function listSessions(): SessionMeta[] {
  const dir = contextDir();
  if (!existsSync(dir)) return [];

  const sessions: (SessionMeta & { mtime: number })[] = [];

  for (const entry of readdirSync(dir)) {
    const metaPath = join(dir, entry, "meta.json");
    if (existsSync(metaPath)) {
      try {
        const meta = JSON.parse(readFileSync(metaPath, "utf-8"));
        const stat = statSync(metaPath);
        sessions.push({ ...meta, mtime: stat.mtimeMs });
      } catch {
        // skip corrupt sessions
      }
    }
  }

  sessions.sort((a, b) => b.mtime - a.mtime);
  return sessions.map(({ mtime: _, ...rest }) => rest);
}

/**
 * Save sensory channel state for a session.
 */
export function saveSensoryState(id: string, state: SensoryState): void {
  const dir = sessionDir(id);
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }
  try {
    writeFileSync(join(dir, "sensory-state.json"), JSON.stringify(state, null, 2));
  } catch (e: unknown) {
    Logger.warn(`Failed to save sensory state for session ${id}: ${asError(e).message}`);
  }
}

/** Channels that are valid camera slot targets (excludes canvas-only channels like 'self'). */
const VALID_SLOT_CHANNELS = new Set([
  "context", "time", "config", "tasks", "spend", "violations", "social",
]);

/** Default slot assignments. */
const DEFAULT_SLOTS: [string, string, string] = ["context", "time", "config"];

/**
 * Load sensory channel state for a session. Returns null if not found.
 * Validates and heals slot assignments — invalid or null slots are replaced with defaults.
 */
export function loadSensoryState(id: string): SensoryState | null {
  const path = join(sessionDir(id), "sensory-state.json");
  if (!existsSync(path)) return null;
  try {
    const state = JSON.parse(readFileSync(path, "utf-8")) as SensoryState;
    // Validate and heal slots
    if (state.slots && Array.isArray(state.slots)) {
      const seen = new Set<string>();
      for (let i = 0; i < 3; i++) {
        const name = state.slots[i];
        if (name === null || name === undefined || !VALID_SLOT_CHANNELS.has(name) || seen.has(name)) {
          state.slots[i] = null;
        } else {
          seen.add(name);
        }
      }
      // Backfill nulls from defaults
      for (let i = 0; i < 3; i++) {
        if (state.slots[i] === null) {
          const fallback = DEFAULT_SLOTS[i];
          if (!seen.has(fallback)) {
            state.slots[i] = fallback;
            seen.add(fallback);
          }
        }
      }
    } else {
      state.slots = [...DEFAULT_SLOTS] as [string, string, string];
    }
    return state;
  } catch (e: unknown) {
    Logger.warn(`Failed to load sensory state for session ${id}: ${asError(e).message}`);
    return null;
  }
}
