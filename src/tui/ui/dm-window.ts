import blessed from "blessed";

export interface DMWindowConfig {
  agentId: string;
  title?: string;
  width?: number | string;
  height?: number | string;
}

export class DMWindow {
  private box: blessed.Widgets.BoxElement | null = null;
  private isOpen = false;

  constructor(
    private screen: blessed.Widgets.Screen,
    private config: DMWindowConfig,
  ) {}

  /**
   * Open the DM window overlay
   */
  open(): void {
    if (this.isOpen) return;

    this.box = blessed.box({
      parent: this.screen,
      top: "center",
      left: "center",
      width: this.config.width || "60%",
      height: this.config.height || "80%",
      border: { type: "line" },
      shadow: true,
      tags: true,
      scrollable: true,
      mouse: true,
      keys: true,
      style: {
        border: { fg: "cyan", bg: "blue" },
        bg: "blue",
        fg: "white",
      },
    });

    // Add header with agent ID
    const header = `{bold}DM: ${this.config.agentId}{/bold} [Press ESC to close]`;
    this.box.setContent(header);

    this.isOpen = true;

    // Attach ESC key handler to dismiss window
    this.attachEscHandler();

    this.screen.render();
  }

  /**
   * Close the DM window and clean up
   */
  close(): void {
    if (!this.isOpen || !this.box) return;

    // Remove ESC handler
    if (this.box) {
      this.box.key(["escape"], () => {}); // unbind
    }

    // Remove from screen
    this.box.destroy();
    this.box = null;
    this.isOpen = false;

    this.screen.render();
  }

  /**
   * Attach ESC key handler to dismiss window
   */
  private attachEscHandler(): void {
    if (!this.box) return;

    this.box.key(["escape"], () => {
      this.close();
    });
  }

  /**
   * Check if window is open
   */
  isWindowOpen(): boolean {
    return this.isOpen;
  }

  /**
   * Append a message to the DM window
   */
  appendMessage(sender: string, text: string): void {
    if (!this.box) return;

    const timestamp = new Date().toLocaleTimeString();
    const line = `{cyan-fg}[${timestamp}] {bold}${sender}:{/bold}{/cyan-fg} ${blessed.escape(text)}`;
    this.box.pushLine(line);
    this.box.setScrollPerc(100);
    this.screen.render();
  }

  /**
   * Focus the DM window
   */
  focus(): void {
    if (this.box) {
      this.box.focus();
      this.screen.render();
    }
  }
}
