/**
 * PLASTIC overlay initializer.
 *
 * Creates ~/.gro/plastic/overlay/ as a symlink mirror of the stock dist/ tree.
 * Also generates source code pages for virtual memory injection so the agent
 * can read its own source via @@ref('pg_src_...')@@.
 *
 * Training-only infrastructure — never active in production.
 */

import { existsSync, mkdirSync, readdirSync, copyFileSync, writeFileSync, readFileSync, lstatSync } from "node:fs";
import { join, dirname, resolve } from "node:path";
import { homedir } from "node:os";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";

const PLASTIC_DIR = join(homedir(), ".gro", "plastic");
const OVERLAY_DIR = join(PLASTIC_DIR, "overlay");

/** Resolve the stock dist/ directory from this module's location. */
function getStockDistDir(): string {
  // This file compiles to dist/plastic/init.js
  // Stock dist is one level up: dist/
  const thisFile = fileURLToPath(import.meta.url);
  return resolve(dirname(thisFile), "..");
}

/** Recursively mirror a directory tree with file copies (not symlinks).
 *  Copies are used instead of symlinks because Node's ESM loader resolves
 *  symlinks to their real path before resolving relative imports — which
 *  means overlay symlinks would still load from the stock dist/ directory. */
function mirrorWithCopies(src: string, dest: string): void {
  mkdirSync(dest, { recursive: true });
  for (const entry of readdirSync(src, { withFileTypes: true })) {
    const srcPath = join(src, entry.name);
    const destPath = join(dest, entry.name);
    if (entry.isDirectory()) {
      mirrorWithCopies(srcPath, destPath);
    } else {
      if (!existsSync(destPath)) {
        copyFileSync(srcPath, destPath);
      }
    }
  }
}

/** Generate a page ID from content. */
function pageId(prefix: string, content: string): string {
  const hash = createHash("sha256").update(content).digest("hex").slice(0, 8);
  return `pg_src_${prefix}_${hash}`;
}

/**
 * Source file definitions for memory page injection.
 * Each entry defines a source file to chunk into pages.
 */
interface SourceChunk {
  /** Page label prefix (e.g., "main_core") */
  label: string;
  /** Relative path from project root to the source .ts file */
  srcPath: string;
  /** Optional line ranges to extract. If omitted, uses entire file. */
  lines?: [number, number];
  /** Human-readable description for the page summary. */
  description: string;
}

const SOURCE_CHUNKS: SourceChunk[] = [
  // main.ts — split into logical sections
  { label: "main_entry", srcPath: "src/main.ts", lines: [2630, 2830], description: "Entry point: main(), signal handlers, process bootstrap" },
  { label: "main_config", srcPath: "src/main.ts", lines: [357, 545], description: "Config loading: CLI flags, env vars, system prompt assembly" },
  { label: "main_memory", srcPath: "src/main.ts", lines: [740, 930], description: "Memory creation, sensory wrapping, save/restore snapshots" },
  { label: "main_turn", srcPath: "src/main.ts", lines: [1091, 1280], description: "executeTurn(): driver.chat loop, retry logic, tool dispatch" },
  { label: "main_markers", srcPath: "src/main.ts", lines: [1280, 1660], description: "handleMarker(): model-change, ref, unref, importance, sense, view, reboot" },
  { label: "main_tools", srcPath: "src/main.ts", lines: [1660, 2330], description: "Tool definitions: bash, write_self, write_source, yield, built-in tool handling" },
  { label: "main_interactive", srcPath: "src/main.ts", lines: [2475, 2630], description: "interactive(): readline loop, session management, MCP" },

  // Key memory files
  { label: "sensory_memory", srcPath: "src/memory/sensory-memory.ts", description: "SensoryMemory: channels, slots, grid enforcement, buffer rendering" },
  { label: "stream_markers", srcPath: "src/stream-markers.ts", description: "Stream marker parser: @@name('arg')@@ pattern matching" },
  { label: "context_map", srcPath: "src/memory/context-map-source.ts", description: "ContextMapSource: 6-section page viewer, lanes, anchors, histogram" },
  { label: "view_factory", srcPath: "src/memory/sensory-view-factory.ts", description: "SensoryViewFactory: channel specs, view creation" },
  { label: "box_drawing", srcPath: "src/memory/box.ts", description: "Box-drawing helpers: borders, rows, bars, padding" },
  // PLASTIC mode files
  { label: "plastic_bootstrap", srcPath: "src/plastic/bootstrap.ts", description: "PLASTIC bootstrap: overlay loader, crash fallback" },
  { label: "plastic_init", srcPath: "src/plastic/init.ts", description: "PLASTIC init: overlay symlinks, source page generation" },
  { label: "plastic_write", srcPath: "src/plastic/write-source.ts", description: "write_source tool: overlay file modification" },
];

/** Read a source chunk, extracting line range if specified. */
function readChunk(chunk: SourceChunk, projectRoot: string): string | null {
  const fullPath = join(projectRoot, chunk.srcPath);
  if (!existsSync(fullPath)) return null;
  const content = readFileSync(fullPath, "utf-8");
  if (!chunk.lines) return content;
  const lines = content.split("\n");
  const [start, end] = chunk.lines;
  return lines.slice(start - 1, end).join("\n");
}

/**
 * Generate source pages and write them to the pages directory.
 * Also writes a source map index for the system prompt.
 */
function generateSourcePages(projectRoot: string): { pages: Array<{ id: string; label: string; tokens: number; description: string }> } {
  const pages: Array<{ id: string; label: string; tokens: number; description: string }> = [];

  for (const chunk of SOURCE_CHUNKS) {
    const content = readChunk(chunk, projectRoot);
    if (!content) continue;

    const id = pageId(chunk.label, content);
    const tokens = Math.ceil(content.length / 2.8);

    // Write page file to plastic/source-pages/ (not directly to session pages — those get injected at boot)
    const pageDir = join(PLASTIC_DIR, "source-pages");
    mkdirSync(pageDir, { recursive: true });

    const pageData = {
      id,
      label: `source: ${chunk.label}`,
      content: `// Source: ${chunk.srcPath}${chunk.lines ? ` (lines ${chunk.lines[0]}-${chunk.lines[1]})` : ""}\n\n${content}`,
      createdAt: new Date().toISOString(),
      messageCount: 0,
      tokens,
      lane: "system",
      summary: chunk.description,
      maxImportance: 0,
    };

    writeFileSync(join(pageDir, `${id}.json`), JSON.stringify(pageData, null, 2));
    pages.push({ id, label: chunk.label, tokens, description: chunk.description });
  }

  return { pages };
}

/** Resolve project root from stock dist dir. */
function getProjectRoot(stockDir: string): string {
  // Stock dist is at <project>/dist/ or <global>/node_modules/@tjamescouch/gro/dist/
  // Look for package.json to find root
  let dir = stockDir;
  for (let i = 0; i < 5; i++) {
    if (existsSync(join(dir, "package.json"))) return dir;
    dir = dirname(dir);
  }
  // Fallback: assume dist is one level below root
  return dirname(stockDir);
}

export async function init(): Promise<void> {
  const stockDir = getStockDistDir();

  // Create overlay with copies of stock dist files
  mirrorWithCopies(stockDir, OVERLAY_DIR);

  // Resolve project root for source file access
  const projectRoot = getProjectRoot(stockDir);

  // Generate source pages
  const { pages } = generateSourcePages(projectRoot);

  // Write manifest
  const manifest = {
    created: new Date().toISOString(),
    stockDir,
    projectRoot,
    modified: [] as string[],
    sourcePages: pages,
  };
  writeFileSync(join(PLASTIC_DIR, "manifest.json"), JSON.stringify(manifest, null, 2));

  // Write source map for system prompt injection
  const sourceMapLines = [
    "## PLASTIC Mode — Active",
    "",
    "You are running in PLASTIC mode. You can read and modify your own source code.",
    "Your code lives in the overlay at ~/.gro/plastic/overlay/ (mirrors dist/).",
    "",
    "### Workflow",
    "1. Read source: use `@@ref('page_id')@@` to load source pages, or `Read` overlay files directly",
    "2. Modify: write to ~/.gro/plastic/overlay/ using any tool (Write, write_source, apply_patch, bash)",
    "3. Reboot: emit `@@reboot@@` — runtime saves state and restarts with your changes",
    "",
    "Tip: `write_source` tool takes path relative to dist/ (e.g. 'main.js') and handles backup automatically.",
    "Do NOT modify /usr/local/... directly — write to the overlay instead.",
    "",
    "### Available source pages:",
  ];
  for (const p of pages) {
    sourceMapLines.push(`  ${p.id}  ${p.label.padEnd(20)}  ~${p.tokens}t  ${p.description}`);
  }
  writeFileSync(join(PLASTIC_DIR, "source-map.txt"), sourceMapLines.join("\n"));
}

/**
 * Inject pre-generated source pages into a VirtualMemory instance.
 * Called at boot when PLASTIC mode is active.
 */
export function injectSourcePages(vm: { importPage(page: any): void; hasPage(id: string): boolean }): number {
  const sourcePageDir = join(PLASTIC_DIR, "source-pages");
  if (!existsSync(sourcePageDir)) return 0;

  let count = 0;
  for (const entry of readdirSync(sourcePageDir, { withFileTypes: true })) {
    if (!entry.isFile() || !entry.name.endsWith(".json")) continue;
    try {
      const page = JSON.parse(readFileSync(join(sourcePageDir, entry.name), "utf-8"));
      if (page.id && !vm.hasPage(page.id)) {
        vm.importPage(page);
        count++;
      }
    } catch {
      // Skip malformed page files
    }
  }
  return count;
}
