import { mkdirSync, writeFileSync, readFileSync, existsSync, readdirSync, statSync, accessSync, constants } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { randomUUID } from "node:crypto";
import type { ChatMessage } from "./drivers/types.js";
import { Logger } from "./logger.js";
import { groError, asError, errorLogFields } from "./errors.js";

/**
 * Session persistence for gro.
 *
 * Layout:
 *   .gro/
 *     context/
 *       <session-id>/
 *         messages.json   — full message history
 *         meta.json       — session metadata (model, provider, timestamps)
 */

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
  const cwdBased = join(process.cwd(), GRO_DIR);
  try {
    accessSync(process.cwd(), constants.W_OK);
    return cwdBased;
  } catch {
    // cwd isn't writable (e.g. Lima's /home workdir) — use $HOME/.gro
    return join(homedir(), GRO_DIR);
  }
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

  writeFileSync(join(dir, "messages.json"), JSON.stringify(messages, null, 2));
  writeFileSync(join(dir, "meta.json"), JSON.stringify(fullMeta, null, 2));
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
  const result: ChatMessage[] = [];
  for (const m of messages) {
    if (m.role === "tool" && m.tool_call_id && !toolUseIds.has(m.tool_call_id)) {
      Logger.warn(`Session repair: dropping orphaned tool_result for missing call ${m.tool_call_id}`);
      continue;
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
