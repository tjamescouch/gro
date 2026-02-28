/**
 * PLASTIC overlay initializer.
 *
 * Creates ~/.gro/plastic/overlay/ as a symlink mirror of the stock dist/ tree.
 * Also generates source code pages for virtual memory injection so the agent
 * can read its own source via @@ref('pg_src_...')@@.
 *
 * Training-only infrastructure — never active in production.
 */
import { existsSync, mkdirSync, readdirSync, symlinkSync, writeFileSync, readFileSync } from "node:fs";
import { join, dirname, resolve } from "node:path";
import { homedir } from "node:os";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";
const PLASTIC_DIR = join(homedir(), ".gro", "plastic");
const OVERLAY_DIR = join(PLASTIC_DIR, "overlay");
/** Resolve the stock dist/ directory from this module's location. */
function getStockDistDir() {
    // This file compiles to dist/plastic/init.js
    // Stock dist is one level up: dist/
    const thisFile = fileURLToPath(import.meta.url);
    return resolve(dirname(thisFile), "..");
}
/** Recursively mirror a directory tree with symlinks. */
function mirrorWithSymlinks(src, dest) {
    mkdirSync(dest, { recursive: true });
    for (const entry of readdirSync(src, { withFileTypes: true })) {
        const srcPath = join(src, entry.name);
        const destPath = join(dest, entry.name);
        if (entry.isDirectory()) {
            // Skip the plastic directory itself to avoid circular symlinks
            if (entry.name === "plastic")
                continue;
            mirrorWithSymlinks(srcPath, destPath);
        }
        else {
            if (!existsSync(destPath)) {
                symlinkSync(srcPath, destPath);
            }
        }
    }
}
/** Generate a page ID from content. */
function pageId(prefix, content) {
    const hash = createHash("sha256").update(content).digest("hex").slice(0, 8);
    return `pg_src_${prefix}_${hash}`;
}
const SOURCE_CHUNKS = [
    // main.ts — split into logical sections
    { label: "main_entry", srcPath: "src/main.ts", lines: [2595, 2772], description: "Entry point: main(), signal handlers, process bootstrap" },
    { label: "main_config", srcPath: "src/main.ts", lines: [354, 526], description: "Config loading: CLI flags, env vars, system prompt assembly" },
    { label: "main_memory", srcPath: "src/main.ts", lines: [735, 906], description: "Memory creation, sensory wrapping, save/restore snapshots" },
    { label: "main_turn", srcPath: "src/main.ts", lines: [1069, 1250], description: "executeTurn(): driver.chat loop, retry logic, tool dispatch" },
    { label: "main_markers", srcPath: "src/main.ts", lines: [1250, 1500], description: "handleMarker(): model-change, ref, unref, importance, sense, view" },
    { label: "main_tools", srcPath: "src/main.ts", lines: [1500, 1800], description: "Tool definitions: bash, write_self, yield, built-in tool handling" },
    { label: "main_interactive", srcPath: "src/main.ts", lines: [2441, 2594], description: "interactive(): readline loop, session management, MCP" },
    // Key memory files
    { label: "sensory_memory", srcPath: "src/memory/sensory-memory.ts", description: "SensoryMemory: channels, slots, grid enforcement, buffer rendering" },
    { label: "stream_markers", srcPath: "src/stream-markers.ts", description: "Stream marker parser: @@name('arg')@@ pattern matching" },
    { label: "context_map", srcPath: "src/memory/context-map-source.ts", description: "ContextMapSource: 6-section page viewer, lanes, anchors, histogram" },
    { label: "view_factory", srcPath: "src/memory/sensory-view-factory.ts", description: "SensoryViewFactory: channel specs, view creation" },
    { label: "box_drawing", srcPath: "src/memory/box.ts", description: "Box-drawing helpers: borders, rows, bars, padding" },
];
/** Read a source chunk, extracting line range if specified. */
function readChunk(chunk, projectRoot) {
    const fullPath = join(projectRoot, chunk.srcPath);
    if (!existsSync(fullPath))
        return null;
    const content = readFileSync(fullPath, "utf-8");
    if (!chunk.lines)
        return content;
    const lines = content.split("\n");
    const [start, end] = chunk.lines;
    return lines.slice(start - 1, end).join("\n");
}
/**
 * Generate source pages and write them to the pages directory.
 * Also writes a source map index for the system prompt.
 */
function generateSourcePages(projectRoot) {
    const pages = [];
    for (const chunk of SOURCE_CHUNKS) {
        const content = readChunk(chunk, projectRoot);
        if (!content)
            continue;
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
function getProjectRoot(stockDir) {
    // Stock dist is at <project>/dist/ or <global>/node_modules/@tjamescouch/gro/dist/
    // Look for package.json to find root
    let dir = stockDir;
    for (let i = 0; i < 5; i++) {
        if (existsSync(join(dir, "package.json")))
            return dir;
        dir = dirname(dir);
    }
    // Fallback: assume dist is one level below root
    return dirname(stockDir);
}
export async function init() {
    const stockDir = getStockDistDir();
    // Create overlay with symlinks
    mirrorWithSymlinks(stockDir, OVERLAY_DIR);
    // Resolve project root for source file access
    const projectRoot = getProjectRoot(stockDir);
    // Generate source pages
    const { pages } = generateSourcePages(projectRoot);
    // Write manifest
    const manifest = {
        created: new Date().toISOString(),
        stockDir,
        projectRoot,
        modified: [],
        sourcePages: pages,
    };
    writeFileSync(join(PLASTIC_DIR, "manifest.json"), JSON.stringify(manifest, null, 2));
    // Write source map for system prompt injection
    const sourceMapLines = [
        "## PLASTIC Mode — Source Reference",
        "You can view and modify your own source code.",
        "Use `@@ref('page_id')@@` to load a source page into context.",
        "Use the `write_source` tool to modify files in the overlay.",
        "Use `@@reboot@@` to restart with your changes.",
        "",
        "Available source pages:",
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
export function injectSourcePages(vm) {
    const sourcePageDir = join(PLASTIC_DIR, "source-pages");
    if (!existsSync(sourcePageDir))
        return 0;
    let count = 0;
    for (const entry of readdirSync(sourcePageDir, { withFileTypes: true })) {
        if (!entry.isFile() || !entry.name.endsWith(".json"))
            continue;
        try {
            const page = JSON.parse(readFileSync(join(sourcePageDir, entry.name), "utf-8"));
            if (page.id && !vm.hasPage(page.id)) {
                vm.importPage(page);
                count++;
            }
        }
        catch {
            // Skip malformed page files
        }
    }
    return count;
}
