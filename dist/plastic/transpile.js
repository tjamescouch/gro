/**
 * TS → JS transpilation for PLASTIC mode.
 *
 * gro's TypeScript is purely type-level (no enums, decorators, or namespaces),
 * so simple type-stripping is sufficient. We try Node's built-in amaro first,
 * then fall back to the full TypeScript compiler if installed.
 *
 * Training-only infrastructure — never active in production.
 */
/** Attempt transpilation via Node's built-in amaro (available since Node 22.7+). */
function tryAmaro(tsSource) {
    try {
        // amaro is bundled with Node and used internally for --experimental-strip-types.
        // It exposes transformSync which strips type annotations.
        const amaro = require("amaro");
        const result = amaro.transformSync(tsSource, { mode: "strip-only" });
        return typeof result === "string" ? result : result?.code ?? null;
    }
    catch {
        return null;
    }
}
/** Attempt transpilation via the TypeScript compiler (if installed). */
function tryTypeScript(tsSource) {
    try {
        const ts = require("typescript");
        const result = ts.transpileModule(tsSource, {
            compilerOptions: {
                module: 199, // ts.ModuleKind.NodeNext
                target: 8, // ts.ScriptTarget.ES2021
                moduleResolution: 99, // ts.ModuleResolutionKind.NodeNext
                esModuleInterop: true,
                skipLibCheck: true,
            },
        });
        return result.outputText ?? null;
    }
    catch {
        return null;
    }
}
/**
 * Transpile TypeScript source to JavaScript.
 * Tries amaro (Node built-in), then TypeScript compiler.
 * Throws if neither is available.
 */
export function transpileTS(tsSource) {
    const fromAmaro = tryAmaro(tsSource);
    if (fromAmaro !== null)
        return fromAmaro;
    const fromTS = tryTypeScript(tsSource);
    if (fromTS !== null)
        return fromTS;
    throw new Error("No TypeScript transpiler available. " +
        "Need Node 22.7+ (for amaro) or 'typescript' package installed. " +
        "As a workaround, write compiled .js directly via write_source('file.js', ...).");
}
