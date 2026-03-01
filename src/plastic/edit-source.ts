/**
 * edit_source tool — surgical search-and-replace edits to overlay files.
 *
 * Unlike write_source (which requires full file content), edit_source
 * takes an old_string and new_string for targeted edits. Much faster
 * for models since they only output the changed portion.
 *
 * Only registered when GRO_PLASTIC=1.
 * Training-only infrastructure — never active in production.
 */

import { existsSync, mkdirSync, writeFileSync, copyFileSync, readFileSync } from "node:fs";
import { join, dirname, normalize } from "node:path";
import { homedir } from "node:os";
import { exportChanges } from "./export.js";

const PLASTIC_DIR = join(homedir(), ".gro", "plastic");
const OVERLAY_DIR = join(PLASTIC_DIR, "overlay");

export const editSourceToolDefinition = {
  type: "function" as const,
  function: {
    name: "edit_source",
    description:
      "Edit a file in the PLASTIC overlay using search-and-replace. " +
      "Much faster than write_source for targeted changes — only send the old and new text. " +
      "Path is relative to overlay/ (e.g. 'main.js', 'memory/virtual-memory.js'). " +
      "The old_string must match exactly one location in the file. " +
      "Use @@reboot@@ after editing to restart with your changes.",
    parameters: {
      type: "object",
      properties: {
        path: {
          type: "string",
          description: "File path relative to overlay/ (e.g. 'main.js', 'memory/virtual-memory.js')",
        },
        old_string: {
          type: "string",
          description: "Exact string to find in the file (must match exactly one location)",
        },
        new_string: {
          type: "string",
          description: "Replacement string",
        },
      },
      required: ["path", "old_string", "new_string"],
    },
  },
};

export function handleEditSource(args: { path: string; old_string: string; new_string: string }): string {
  const normalizedPath = normalize(args.path);
  if (normalizedPath.startsWith("..") || normalizedPath.startsWith("/")) {
    return "ERROR: path must be relative and cannot escape the overlay";
  }

  if (!args.old_string) {
    return "ERROR: old_string is empty";
  }

  if (args.old_string === args.new_string) {
    return "ERROR: old_string and new_string are identical — nothing to change";
  }

  const targetPath = join(OVERLAY_DIR, normalizedPath);
  if (!targetPath.startsWith(OVERLAY_DIR)) {
    return "ERROR: path escape attempt blocked";
  }

  if (!existsSync(targetPath)) {
    return `ERROR: file not found: overlay/${normalizedPath}`;
  }

  // Read current content
  let content: string;
  try {
    content = readFileSync(targetPath, "utf-8");
  } catch (err) {
    return `ERROR: failed to read file: ${err}`;
  }

  // Count occurrences
  const occurrences = content.split(args.old_string).length - 1;
  if (occurrences === 0) {
    // Show a preview of the file around where they might have intended
    const lines = content.split("\n");
    const preview = lines.length > 20
      ? `File has ${lines.length} lines. First 5:\n${lines.slice(0, 5).join("\n")}`
      : "";
    return `ERROR: old_string not found in overlay/${normalizedPath}. ${preview}`;
  }
  if (occurrences > 1) {
    return `ERROR: old_string matches ${occurrences} locations in overlay/${normalizedPath}. Provide more context to match exactly one location.`;
  }

  // Backup
  try {
    copyFileSync(targetPath, targetPath + ".bak");
  } catch {
    // Best effort backup
  }

  // Apply replacement
  const newContent = content.replace(args.old_string, args.new_string);
  try {
    writeFileSync(targetPath, newContent);
  } catch (err) {
    return `ERROR: failed to write file: ${err}`;
  }

  // Auto-export patch
  let patchMsg = "";
  try {
    const { fileCount } = exportChanges();
    if (fileCount > 0) patchMsg = `. Patch updated (${fileCount} file${fileCount > 1 ? "s" : ""})`;
  } catch {}

  const byteDelta = args.new_string.length - args.old_string.length;
  const deltaStr = byteDelta >= 0 ? `+${byteDelta}` : `${byteDelta}`;
  return `OK: edited overlay/${normalizedPath} (${deltaStr} bytes, 1 replacement)${patchMsg}. Use @@reboot@@ to restart with changes.`;
}
