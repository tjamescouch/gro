/**
 * Session persistence — save/load conversation state to .gro/context/.
 */

import { mkdirSync, writeFileSync, readFileSync, existsSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import type { ChatMessage } from "./drivers/types.js";

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

export interface SessionMeta {
  provider?: string;
  model?: string;
  createdAt?: string;
  updatedAt?: string;
  [key: string]: any;
}

export interface Session {
  messages: ChatMessage[];
  meta: SessionMeta;
}

/** Ensure the .gro/context directory exists. */
export function ensureGroDir(): void {
  const dir = contextDir();
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }
}

/** Generate a new session ID (short UUID prefix for readability). */
export function newSessionId(): string {
  return randomUUID().split("-")[0];
}

/** Save a session to disk. */
export function saveSession(id: string, messages: ChatMessage[], meta: SessionMeta): void {
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

/** Load a session from disk. Returns null if not found. */
export function loadSession(id: string): Session | null {
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
  } catch {
    return null;
  }
}

/** Find the most recent session (for --continue). */
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
