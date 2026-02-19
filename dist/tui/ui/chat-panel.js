import blessed from "blessed";
export class ChatPanel {
    constructor(box, screen) {
        this.box = box;
        this.screen = screen;
        this.streamingBuffer = "";
        this.isStreaming = false;
        this.renderTimer = null;
        this.dirty = false;
        this.baseLineCount = null;
    }
    appendUserMessage(text) {
        this.box.pushLine(`{bold}{green-fg}You:{/green-fg}{/bold} ${blessed.escape(text)}`);
        this.box.pushLine("");
        this.scrollToBottom();
        this.scheduleRender();
    }
    appendToken(token) {
        if (!this.isStreaming) {
            this.isStreaming = true;
            this.streamingBuffer = "";
            this.box.pushLine("{bold}{cyan-fg}Assistant:{/cyan-fg}{/bold}");
        }
        this.streamingBuffer += token;
        this.updateStreamingContent();
        this.scheduleRender();
    }
    finalizeResponse() {
        if (this.isStreaming) {
            this.updateStreamingContent();
            this.box.pushLine("");
            this.isStreaming = false;
            this.streamingBuffer = "";
            this.scrollToBottom();
            this.scheduleRender();
        }
    }
    updateStreamingContent() {
        // Split the streaming buffer into lines and display them
        const lines = this.streamingBuffer.split("\n");
        // Remove previously pushed streaming lines (we track via dirty flag)
        // Simpler approach: just set the last lines
        // Since blessed doesn't support partial line updates well,
        // we rebuild the streaming portion
        const baseLineCount = this.getBaseLineCount();
        // Remove old streaming lines
        while (this.box.getLines().length > baseLineCount) {
            this.box.popLine(0); // removes last line
        }
        // Push new streaming lines
        for (const line of lines) {
            this.box.pushLine("  " + blessed.escape(line));
        }
        this.scrollToBottom();
    }
    getBaseLineCount() {
        if (!this.isStreaming) {
            this.baseLineCount = null;
            return this.box.getLines().length;
        }
        if (this.baseLineCount === null) {
            // Set when streaming starts (after the "Assistant:" header is pushed)
            this.baseLineCount = this.box.getLines().length;
        }
        return this.baseLineCount;
    }
    scrollToBottom() {
        this.box.setScrollPerc(100);
    }
    scheduleRender() {
        if (this.renderTimer)
            return;
        this.renderTimer = setTimeout(() => {
            this.renderTimer = null;
            this.screen.render();
        }, 33); // ~30fps
    }
}
