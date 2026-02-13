import { mkdirSync, writeFileSync, readFileSync, existsSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
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
  return join(process.cwd(), GRO_DIR);
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
 * Load a session from disk. Returns null if not found.
 */
export function loadSession(id: string): { messages: ChatMessage[]; meta: SessionMeta } | null {
  const dir = sessionDir(id);
  const msgPath = join(dir, "messages.json");
  const metaPath = join(dir, "meta.json");

  if (!existsSync(msgPath) || !existsSync(metaPath)) {
    return null;
  }

  try {
    const messages = JSON.parse(readFileSync(msgPath, "utf-8"));
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
