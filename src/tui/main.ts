import { parseConfig } from "./config.js";
import { createScreen, setupGlobalKeys } from "./ui/screen.js";
import { createLayout } from "./ui/layout.js";
import { SubprocessManager } from "./subprocess/manager.js";
import { OutputParser } from "./subprocess/output-parser.js";

function main(): void {
  const config = parseConfig(process.argv.slice(2));
  const screen = createScreen();
  const { chatPanel, toolsPanel, logsPanel, inputBox, focusables } =
    createLayout(screen, config);
  const parser = new OutputParser();

  let isLogMode = false;

  const subprocess = new SubprocessManager(config, {
    onStdout(chunk: string) {
      for (const event of parser.parseStdout(chunk)) {
        if (event.type === "token") {
          chatPanel.appendToken(event.content);
        } else if (event.type === "result") {
          chatPanel.finalizeResponse();
        }
      }
    },
    onStderr(chunk: string) {
      for (const event of parser.parseStderr(chunk)) {
        if (event.type === "tool_call") {
          toolsPanel.addToolCall(
            event.metadata!.toolName!,
            event.metadata!.toolArgs!,
          );
          logsPanel.appendLog(event.content, "info");
        } else if (event.type === "tool_result") {
          toolsPanel.addToolResult(
            event.metadata!.toolName!,
            event.metadata!.toolResult!,
          );
          logsPanel.appendLog(event.content, "info");
        } else {
          logsPanel.appendLog(event.content, event.metadata?.logLevel);
        }
      }
    },
    onExit(code: number | null) {
      for (const event of parser.flushStdout()) {
        if (event.type === "token") {
          chatPanel.appendToken(event.content);
        }
      }
      chatPanel.finalizeResponse();
      logsPanel.appendLog(`Process exited (code ${code})`, "debug");
      inputBox.style.border = { fg: "green" } as any;
      (inputBox as any).setLabel(" Type here > ");
      screen.render();
      inputBox.readInput();
    },
  });

  function submitInput() {
    const text = inputBox.getValue().trim();
    if (!text) return;
    if (subprocess.isBusy()) return;

    chatPanel.appendUserMessage(text);
    inputBox.clearValue();
    screen.render();

    inputBox.style.border = { fg: "yellow" } as any;
    (inputBox as any).setLabel(" Waiting... ");
    screen.render();

    subprocess.sendPrompt(text);
  }

  function handleEnter() {
    const text = inputBox.getValue().trim();
    if (isLogMode) {
      if (text) {
        logsPanel.loadLogFile(text);
      }
      isLogMode = false;
      inputBox.clearValue();
      inputBox.style.border = { fg: "green" } as any;
      (inputBox as any).setLabel(" Type here > ");
      inputBox.readInput();
      screen.render();
      return;
    }
    submitInput();
  }

  // ── Enter: submit or load log ────────────────────────────────────────────
  inputBox.key("enter", () => { handleEnter(); });

  // ── Paste handler: insert clipboard text at cursor ────────────────────────
  function handlePaste(text: string): void {
    const current = inputBox.getValue();
    inputBox.setValue(current + text);
    screen.render();
    inputBox.focus();
    inputBox.readInput();
  }

  // Re-activate textarea after submit/cancel
  inputBox.on("submit", () => { inputBox.readInput(); });
  inputBox.on("cancel", () => { inputBox.readInput(); });

  // Click to focus input
  inputBox.on("click", () => {
    inputBox.focus();
    inputBox.readInput();
  });

  setupGlobalKeys(
    screen,
    focusables,
    inputBox,
    () => {
      subprocess.kill();
      screen.destroy();
      process.exit(0);
    },
    handlePaste,
  );

  // ── Ctrl+L: enter log file load mode ─────────────────────────────────────
  screen.key(["C-l"], () => {
    isLogMode = true;
    inputBox.clearValue();
    inputBox.style.border = { fg: "cyan" } as any;
    (inputBox as any).setLabel(" Log path > ");
    inputBox.focus();
    inputBox.readInput();
    screen.render();
  });

  // Start with input active
  inputBox.focus();
  inputBox.readInput();

  logsPanel.appendLog("grotui v0.1.0", "info");
  logsPanel.appendLog(`cmd: ${config.command} ${config.args.join(" ")}`, "info");
  logsPanel.appendLog("", "info");
  logsPanel.appendLog("↑↓/jk: scroll  Tab: focus  Ctrl+M: copy mode  Ctrl+V: paste", "info");
  logsPanel.appendLog(" Ctrl+L: load log  Ctrl+C: quit", "info");
  screen.render();
}

main();