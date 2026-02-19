/**
 * Built-in version/identity tool for gro.
 *
 * Lets agents (and humans) introspect the gro runtime — version, provider,
 * model, uptime, process info. This is the canonical way to confirm an
 * agent is running on gro.
 */
import { readFileSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
const startTime = Date.now();
/** Read version from package.json — single source of truth. */
function readVersion() {
    // In ESM, __dirname isn't available — derive from import.meta.url
    let selfDir;
    try {
        selfDir = dirname(fileURLToPath(import.meta.url));
    }
    catch {
        selfDir = process.cwd();
    }
    const candidates = [
        join(selfDir, "..", "package.json"), // from dist/tools/ or src/tools/
        join(selfDir, "..", "..", "package.json"), // from deeper nesting
        join(process.cwd(), "package.json"),
    ];
    for (const p of candidates) {
        if (existsSync(p)) {
            try {
                const pkg = JSON.parse(readFileSync(p, "utf-8"));
                if (pkg.name === "@tjamescouch/gro" && pkg.version) {
                    return pkg.version;
                }
            }
            catch {
                // try next candidate
            }
        }
    }
    return "unknown";
}
// Cache version at module load
const GRO_VERSION = readVersion();
export function getGroVersion() {
    return GRO_VERSION;
}
export function groVersionToolDefinition() {
    return {
        type: "function",
        function: {
            name: "gro_version",
            description: "Report gro runtime identity and version. Returns runtime name, version, provider, model, uptime, and process info. Use this to confirm an agent is running on gro.",
            parameters: {
                type: "object",
                properties: {},
            },
        },
    };
}
/**
 * Execute the version tool. Requires runtime config to report provider/model.
 */
export function executeGroVersion(cfg) {
    const info = {
        runtime: "gro",
        version: GRO_VERSION,
        provider: cfg.provider,
        model: cfg.model,
        thinking_budget: cfg.thinkingBudget ?? 0,
        active_model: cfg.activeModel ?? cfg.model,
        pid: process.pid,
        uptime_seconds: Math.floor((Date.now() - startTime) / 1000),
        node_version: process.version,
        platform: process.platform,
        persistent: cfg.persistent,
        memory_mode: cfg.memoryMode ?? "simple",
    };
    return JSON.stringify(info, null, 2);
}
