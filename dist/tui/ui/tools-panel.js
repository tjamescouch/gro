import blessed from "blessed";
export class ToolsPanel {
    constructor(box, screen) {
        this.box = box;
        this.screen = screen;
        this.toolCalls = [];
    }
    addToolCall(name, args) {
        this.toolCalls.push({ name, args, result: null, status: "running" });
        this.renderToolCalls();
    }
    addToolResult(name, result) {
        const entry = [...this.toolCalls]
            .reverse()
            .find((t) => t.name === name && t.status === "running");
        if (entry) {
            entry.result = result.slice(0, 500);
            entry.status = "done";
        }
        this.renderToolCalls();
    }
    renderToolCalls() {
        const lines = [];
        for (const tc of this.toolCalls) {
            const icon = tc.status === "running"
                ? "{yellow-fg}*{/yellow-fg}"
                : "{green-fg}+{/green-fg}";
            lines.push(`${icon} {bold}${blessed.escape(tc.name)}{/bold}`);
            if (tc.args) {
                lines.push(`  args: ${blessed.escape(tc.args.slice(0, 80))}`);
            }
            if (tc.result) {
                lines.push(`  result: ${blessed.escape(tc.result.slice(0, 200))}`);
            }
            lines.push("");
        }
        this.box.setContent(lines.join("\n"));
        this.box.setScrollPerc(100);
        this.screen.render();
    }
}
