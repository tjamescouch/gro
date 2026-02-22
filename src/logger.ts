export const C = {
  reset: "\x1b[0m",
  bold: (s: string) => `\x1b[1m${s}\x1b[0m`,
  red: (s: string) => `\x1b[31m${s}\x1b[0m`,
  green: (s: string) => `\x1b[32m${s}\x1b[0m`,
  yellow: (s: string) => `\x1b[33m${s}\x1b[0m`,
  blue: (s: string) => `\x1b[34m${s}\x1b[0m`,
  magenta: (s: string) => `\x1b[35m${s}\x1b[0m`,
  cyan: (s: string) => `\x1b[36m${s}\x1b[0m`,
  gray: (s: string) => `\x1b[90m${s}\x1b[0m`,
};

function writeRaw(s: string) {
  const g: any = globalThis as any;
  if (g?.Bun?.stdout?.write) { g.Bun.stdout.write(s); return; }
  g?.process?.stdout?.write?.(s);
}

export class Logger {
  private static _verbose = false;

  static setVerbose(v: boolean) { Logger._verbose = v; }
  static isVerbose() { return Logger._verbose; }

  static info(...args: any[]) {
    console.log(...args);
  }

  static warn(...args: any[]) { console.warn(...args); }
  static error(...args: any[]) { console.error(...args); }

  static debug(...args: any[]) {
    // Debug requires BOTH verbose mode AND GRO_LOG_LEVEL=DEBUG
    const debugLevel = (process.env.GRO_LOG_LEVEL ?? "").toUpperCase() === "DEBUG";
    if (Logger._verbose && debugLevel) console.log(...args);
  }

  static streamInfo(s: string) { writeRaw(s); }
  static endStreamLine(suffix = "") { writeRaw(suffix + "\n"); }
}
