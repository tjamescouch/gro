import { parseConfig } from "./config.js";
import { createScreen, setupGlobalKeys } from "./ui/screen.js";
import { createLayout } from "./ui/layout.js";
import { SubprocessManager } from "./subprocess/manager.js";
import { OutputParser } from "./subprocess/output-parser.js";
function main() {
    const config = parseConfig(process.argv.slice(2));
    const screen = createScreen();
    const { chatPanel, toolsPanel, logsPanel, inputBox, focusables } = createLayout(screen, config);
    const parser = new OutputParser();
    const subprocess = new SubprocessManager(config, {
        onStdout(chunk) {
            for (const event of parser.parseStdout(chunk)) {
                if (event.type === "token") {
                    chatPanel.appendToken(event.content);
                }
                else if (event.type === "result") {
                    chatPanel.finalizeResponse();
                }
            }
        },
        onStderr(chunk) {
            for (const event of parser.parseStderr(chunk)) {
                if (event.type === "tool_call") {
                    toolsPanel.addToolCall(event.metadata.toolName, event.metadata.toolArgs);
                    logsPanel.appendLog(event.content, "info");
                }
                else if (event.type === "tool_result") {
                    toolsPanel.addToolResult(event.metadata.toolName, event.metadata.toolResult);
                    logsPanel.appendLog(event.content, "info");
                }
                else {
                    logsPanel.appendLog(event.content, event.metadata?.logLevel);
                }
            }
        },
        onExit(code) {
            // Flush any remaining stdout buffer
            for (const event of parser.flushStdout()) {
                if (event.type === "token") {
                    chatPanel.appendToken(event.content);
                }
            }
            chatPanel.finalizeResponse();
            logsPanel.appendLog(`Process exited (code ${code})`, "debug");
            // Re-enable input
            inputBox.style.border = { fg: "green" };
            inputBox.setLabel(" > ");
            screen.render();
        },
    });
    // Handle input submission
    inputBox.key("enter", () => {
        const text = inputBox.getValue().trim();
        if (!text)
            return;
        if (subprocess.isBusy())
            return;
        chatPanel.appendUserMessage(text);
        inputBox.clearValue();
        screen.render();
        // Show busy state
        inputBox.style.border = { fg: "yellow" };
        inputBox.setLabel(" ... ");
        screen.render();
        subprocess.sendPrompt(text);
    });
    // Keep input focused after clearing
    inputBox.on("submit", () => {
        inputBox.focus();
    });
    setupGlobalKeys(screen, focusables, inputBox, () => {
        subprocess.kill();
        screen.destroy();
        process.exit(0);
    });
    // Initial focus and render
    inputBox.focus();
    logsPanel.appendLog(`grotui v0.1.0 — command: ${config.command} ${config.args.join(" ")}`, "info");
    logsPanel.appendLog("Type a prompt and press Enter. Ctrl+C to quit.", "info");
    screen.render();
}
main();
