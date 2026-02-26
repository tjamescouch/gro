export const C = {
    reset: "\x1b[0m",
    bold: (s) => `\x1b[1m${s}\x1b[0m`,
    red: (s) => `\x1b[31m${s}\x1b[0m`,
    green: (s) => `\x1b[32m${s}\x1b[0m`,
    yellow: (s) => `\x1b[33m${s}\x1b[0m`,
    blue: (s) => `\x1b[34m${s}\x1b[0m`,
    magenta: (s) => `\x1b[35m${s}\x1b[0m`,
    cyan: (s) => `\x1b[36m${s}\x1b[0m`,
    gray: (s) => `\x1b[90m${s}\x1b[0m`,
};
function writeRaw(s) {
    const g = globalThis;
    if (g?.Bun?.stdout?.write) {
        g.Bun.stdout.write(s);
        return;
    }
    g?.process?.stdout?.write?.(s);
}
export class Logger {
    static setVerbose(v) { Logger._verbose = v; }
    static isVerbose() { return Logger._verbose; }
    static info(...args) {
        console.log(...args);
    }
    static telemetry(...args) {
        if (Logger._verbose)
            console.log(...args);
    }
    static warn(...args) { console.warn(...args); }
    static error(...args) { console.error(...args); }
    static debug(...args) {
        // Debug requires BOTH verbose mode AND GRO_LOG_LEVEL=DEBUG
        const debugLevel = (process.env.GRO_LOG_LEVEL ?? "").toUpperCase() === "DEBUG";
        if (Logger._verbose && debugLevel)
            console.log(...args);
    }
    static streamInfo(s) { writeRaw(s); }
    static endStreamLine(suffix = "") { writeRaw(suffix + "\n"); }
}
Logger._verbose = false;
