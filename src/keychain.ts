/**
 * keychain — macOS Keychain integration for secure API key storage.
 *
 * Keys are stored as generic passwords:
 *   account: "gro"
 *   service: "gro-<provider>"  (e.g. "gro-anthropic", "gro-groq")
 *
 * Falls back to environment variables on non-macOS platforms.
 */

import { spawnSync } from "node:child_process";

const ACCOUNT = "gro";

function service(provider: string): string {
  return `gro-${provider}`;
}

/** Read an API key from macOS Keychain. Returns null if not found or not on macOS. */
export function getKey(provider: string): string | null {
  if (process.platform !== "darwin") return null;
  const r = spawnSync("security", [
    "find-generic-password", "-a", ACCOUNT, "-s", service(provider), "-w",
  ], { encoding: "utf8" });
  if (r.status !== 0) return null;
  const key = r.stdout.trim();
  return key || null;
}

/** Store an API key in macOS Keychain. Throws on failure or non-macOS. */
export function setKey(provider: string, key: string): void {
  if (process.platform !== "darwin") {
    throw new Error(`Keychain is only supported on macOS. Set ${envVarName(provider)} instead.`);
  }
  // -U = update if the entry already exists
  const r = spawnSync("security", [
    "add-generic-password", "-a", ACCOUNT, "-s", service(provider), "-w", key, "-U",
  ], { encoding: "utf8" });
  if (r.status !== 0) {
    throw new Error(`Failed to store key in Keychain: ${r.stderr.trim()}`);
  }
}

/** Delete an API key from macOS Keychain. Silent no-op if not found. */
export function deleteKey(provider: string): void {
  if (process.platform !== "darwin") return;
  spawnSync("security", [
    "delete-generic-password", "-a", ACCOUNT, "-s", service(provider),
  ], { encoding: "utf8" });
}

/** The environment variable name used as a fallback for a given provider. */
export function envVarName(provider: string): string {
  switch (provider) {
    case "anthropic": return "ANTHROPIC_API_KEY";
    case "openai":    return "OPENAI_API_KEY";
    case "groq":      return "GROQ_API_KEY";
    default:          return `${provider.toUpperCase()}_API_KEY`;
  }
}

/**
 * Resolve an API key: Keychain first, then env var fallback.
 * Returns empty string if neither is set.
 */
export function resolveKey(provider: string): string {
  return getKey(provider) || process.env[envVarName(provider)] || "";
}
