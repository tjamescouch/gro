import blessed from "blessed";
export class LogsPanel {
    constructor(logWidget, screen) {
        this.logWidget = logWidget;
        this.screen = screen;
    }
    appendLog(line, level) {
        let prefix = "";
        if (level) {
            const colorMap = {
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
