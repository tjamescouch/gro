import blessed from "blessed";
import type { ToolCallEntry } from "../types.js";

export class ToolsPanel {
  private toolCalls: ToolCallEntry[] = [];

  constructor(
    private box: blessed.Widgets.BoxElement,
    private screen: blessed.Widgets.Screen,
  ) {}

  addToolCall(name: string, args: string): void {
    this.toolCalls.push({ name, args, result: null, status: "running" });
    this.renderToolCalls();
  }

  addToolResult(name: string, result: string): void {
    const entry = [...this.toolCalls]
      .reverse()
      .find((t) => t.name === name && t.status === "running");
    if (entry) {
      entry.result = result.slice(0, 500);
      entry.status = "done";
    }
    this.renderToolCalls();
  }

  private renderToolCalls(): void {
    const lines: string[] = [];
    for (const tc of this.toolCalls) {
      const icon =
        tc.status === "running"
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
