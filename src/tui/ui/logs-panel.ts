import blessed from "blessed";
import * as fs from "node:fs";

export class LogsPanel {
  constructor(
    private logWidget: blessed.Widgets.Log,
    private screen: blessed.Widgets.Screen,
  ) {}

  appendLog(line: string, level?: string): void {
    let prefix = "";
    if (level) {
      const colorMap: Record<string, string> = {
        debug: "gray",
        info: "blue",
        warn: "yellow",
        error: "red",
      };
      const color = colorMap[level] || "white";
      prefix = `{${color}-fg}[${level}]{/${color}-fg} `;
    }
    this.logWidget.log(prefix + blessed.escape(line));
    this.screen.render();
  }

  loadLogFile(path: string): void {
    try {
      const content = fs.readFileSync(path, "utf8");
      const lines = content.split(/\r?\n/);
      let loaded = 0;
      lines.forEach((line) => {
        if (line.trim()) {
          this.appendLog(line, "debug");
          loaded++;
        }
      });
      this.appendLog(`Loaded ${loaded} lines from ${path}`, "info");
    } catch (e: any) {
      this.appendLog(`Error loading ${path}: ${e.message}`, "error");
    }
    this.screen.render();
  }
}