import blessed from "blessed";
import { ChatPanel } from "./chat-panel.js";
import { ToolsPanel } from "./tools-panel.js";
import { LogsPanel } from "./logs-panel.js";
export function createLayout(screen, config) {
    const [chatPct, toolsPct, logsPct] = config.panelRatios;
    const total = chatPct + toolsPct + logsPct;
    const chatWidth = Math.round((chatPct / total) * 100);
    const toolsWidth = Math.round((toolsPct / total) * 100);
    // Chat history box (top portion of left panel)
    const chatBox = blessed.box({
        parent: screen,
        label: " Chat ",
        left: 0,
        top: 0,
        width: `${chatWidth}%`,
        height: "100%-3",
        border: { type: "line" },
        scrollable: true,
        alwaysScroll: true,
        scrollbar: { ch: "│", style: { fg: "cyan" } },
        keys: true,
        vi: true,
        mouse: true,
        tags: true,
        style: {
            border: { fg: "cyan" },
            label: { fg: "cyan", bold: true },
        },
    });
    // Input box (bottom of left panel)
    const inputBox = blessed.textarea({
        parent: screen,
        label: " > ",
        left: 0,
        bottom: 0,
        width: `${chatWidth}%`,
        height: 3,
        border: { type: "line" },
        inputOnFocus: true,
        mouse: true,
        keys: true,
        style: {
            border: { fg: "green" },
            label: { fg: "green", bold: true },
        },
    });
    // Tools panel (middle)
    const toolsBox = blessed.box({
        parent: screen,
        label: " Tools ",
        left: `${chatWidth}%`,
        top: 0,
        width: `${toolsWidth}%`,
        height: "100%",
        border: { type: "line" },
        scrollable: true,
        alwaysScroll: true,
        scrollbar: { ch: "│", style: { fg: "yellow" } },
        keys: true,
        vi: true,
        mouse: true,
        tags: true,
        style: {
            border: { fg: "yellow" },
            label: { fg: "yellow", bold: true },
        },
    });
    // Logs panel (right)
    const logsBox = blessed.log({
        parent: screen,
        label: " Logs ",
        left: `${chatWidth + toolsWidth}%`,
        top: 0,
        width: `${100 - chatWidth - toolsWidth}%`,
        height: "100%",
        border: { type: "line" },
        scrollable: true,
        alwaysScroll: true,
        scrollbar: { ch: "│", style: { fg: "magenta" } },
        keys: true,
        vi: true,
        mouse: true,
        tags: true,
        style: {
            border: { fg: "magenta" },
            label: { fg: "magenta", bold: true },
        },
    });
    const chatPanel = new ChatPanel(chatBox, screen);
    const toolsPanel = new ToolsPanel(toolsBox, screen);
    const logsPanel = new LogsPanel(logsBox, screen);
    return {
        chatPanel,
        toolsPanel,
        logsPanel,
        inputBox,
        focusables: [inputBox, chatBox, toolsBox, logsBox],
    };
}
