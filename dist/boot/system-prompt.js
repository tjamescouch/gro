/**
 * Boot layer system prompt assembly.
 *
 * Layer 1: Runtime (gro runtime.md — always first, non-negotiable)
 * Layer 2: Extensions (repo _base.md, _learn.md, SKILL.md, --append-system-prompt-file)
 * Layer 3: Role/Personality (WAKE.md, --system-prompt, --system-prompt-file)
 */
import { readFileSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { Logger } from "../logger.js";
const __dirname_resolved = dirname(fileURLToPath(import.meta.url));
/** Load Layer 1 runtime.md from the gro package (bundled). */
export function loadRuntimeBoot() {
    // In dist/ after build: dist/boot/runtime.md (same dir as this file)
    // In src/ during dev: src/boot/runtime.md (same dir as this file)
    const candidates = [
        join(__dirname_resolved, "runtime.md"),
        join(__dirname_resolved, "..", "boot", "runtime.md"),
        // Fallback for when main.ts resolves __dirname differently
        join(__dirname_resolved, "..", "src", "boot", "runtime.md"),
    ];
    for (const p of candidates) {
        if (existsSync(p)) {
            return readFileSync(p, "utf-8").trim();
        }
    }
    Logger.warn("runtime.md not found — Layer 1 boot missing");
    return "";
}
export function assembleSystemPrompt(layers) {
    const sections = [];
    // Layer 1: Runtime (always first, non-negotiable)
    if (layers.runtime) {
        sections.push(`<!-- LAYER 1: RUNTIME -->\n${layers.runtime}`);
    }
    // Layer 2: Extensions (additive)
    for (const ext of layers.extensions) {
        if (ext.trim()) {
            sections.push(`<!-- LAYER 2: EXTENSION -->\n${ext.trim()}`);
        }
    }
    // Layer 3: Role/Personality
    for (const role of layers.role) {
        if (role.trim()) {
            sections.push(`<!-- LAYER 3: ROLE -->\n${role.trim()}`);
        }
    }
    return sections.join("\n\n---\n\n");
}
/** Discover Layer 2 extension files from repo root and known locations. */
export function discoverExtensions(mcpConfigPaths) {
    const extensions = [];
    // Check repo root for _base.md
    const repoBase = join(process.cwd(), "_base.md");
    if (existsSync(repoBase)) {
        try {
            extensions.push(readFileSync(repoBase, "utf-8").trim());
        }
        catch {
            Logger.warn(`Failed to read _base.md at ${repoBase}`);
        }
    }
    else {
        // Fallback: check the gro package directory (for global installs where CWD != package dir).
        const pkgBase = join(__dirname_resolved, "..", "_base.md");
        if (existsSync(pkgBase)) {
            try {
                extensions.push(readFileSync(pkgBase, "utf-8").trim());
            }
            catch {
                Logger.warn(`Failed to read _base.md at ${pkgBase}`);
            }
        }
    }
    // Check for _learn.md (persistent learned facts)
    const learnFile = join(process.cwd(), "_learn.md");
    if (existsSync(learnFile)) {
        try {
            const learned = readFileSync(learnFile, "utf-8").trim();
            if (learned) {
                extensions.push(`<!-- LEARNED FACTS -->\n${learned}`);
            }
        }
        catch {
            Logger.warn(`Failed to read _learn.md at ${learnFile}`);
        }
    }
    // Check for SKILL.md in repo root
    const skillCandidates = [
        join(process.cwd(), "SKILL.md"),
    ];
    for (const p of skillCandidates) {
        if (existsSync(p)) {
            try {
                extensions.push(readFileSync(p, "utf-8").trim());
            }
            catch {
                Logger.warn(`Failed to read SKILL.md at ${p}`);
            }
            break;
        }
    }
    return extensions;
}
