import { parseConfig } from "./config.js";
import { createScreen, setupGlobalKeys } from "./ui/screen.js";
import { createLayout } from "./ui/layout.js";
import { SubprocessManager } from "./subprocess/manager.js";
import { OutputParser } from "./subprocess/output-parser.js";
function main() {
    const config = parseConfig(process.argv.slice(2));
    const screen = createScreen();
    const { chatPanel, toolsPanel, logsPanel, inputBox, helpBar, focusables } = createLayout(screen, config);
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
            for (const event of parser.flushStdout()) {
                if (event.type === "token") {
                    chatPanel.appendToken(event.content);
                }
            }
            chatPanel.finalizeResponse();
            logsPanel.appendLog(`Process exited (code ${code})`, "debug");
            inputBox.style.border = { fg: "green" };
            inputBox.setLabel(" Type here > ");
            screen.render();
            // Re-activate input
            inputBox.readInput();
        },
    });
    function submitInput() {
        const text = inputBox.getValue().trim();
        if (!text)
            return;
        if (subprocess.isBusy())
            return;
        chatPanel.appendUserMessage(text);
        inputBox.clearValue();
        screen.render();
        inputBox.style.border = { fg: "yellow" };
        inputBox.setLabel(" Waiting... ");
        screen.render();
        subprocess.sendPrompt(text);
    }
    // Handle enter key for submission
    inputBox.key("enter", () => {
        submitInput();
    });
    // When textarea submits or cancels, re-activate it
    inputBox.on("submit", () => {
        inputBox.readInput();
    });
    inputBox.on("cancel", () => {
        inputBox.readInput();
    });
    // Click on input box should activate it
    inputBox.on("click", () => {
        inputBox.focus();
        inputBox.readInput();
    });
    setupGlobalKeys(screen, focusables, inputBox, () => {
        subprocess.kill();
        screen.destroy();
        process.exit(0);
    });
    // Start with input active
    inputBox.focus();
    inputBox.readInput();
    logsPanel.appendLog(`grotui v0.1.0`, "info");
    logsPanel.appendLog(`cmd: ${config.command} ${config.args.join(" ")}`, "info");
    logsPanel.appendLog("", "info");
    logsPanel.appendLog("Enter: send | Tab: switch panel", "info");
    logsPanel.appendLog("Ctrl+C: quit", "info");
    screen.render();
}
main();
