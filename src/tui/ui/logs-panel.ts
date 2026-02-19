import blessed from "blessed";

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
}
