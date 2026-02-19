import blessed from "blessed";
import { ChatPanel } from "./chat-panel.js";
import { ToolsPanel } from "./tools-panel.js";
import { LogsPanel } from "./logs-panel.js";
export function createLayout(screen, config) {
    const [chatPct, toolsPct, logsPct] = config.panelRatios;
    const total = chatPct + toolsPct + logsPct;
    const chatWidth = Math.round((chatPct / total) * 100);
    const toolsWidth = Math.round((toolsPct / total) * 100);
    // Help bar at very bottom
    const helpBar = blessed.box({
        parent: screen,
        bottom: 0,
        left: 0,
        width: "100%",
        height: 1,
        tags: true,
        style: { bg: "blue", fg: "white" },
        content: " {bold}Enter{/bold}: Send  {bold}Tab{/bold}: Switch Panel  {bold}Esc{/bold}: Focus Input  {bold}Ctrl+C{/bold}: Quit  {bold}Up/Down{/bold}: Scroll",
    });
    // Chat history box
    const chatBox = blessed.box({
        parent: screen,
        label: " Chat ",
        left: 0,
        top: 0,
        width: `${chatWidth}%`,
        height: "100%-4",
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
    // Input box above help bar
    const inputBox = blessed.textarea({
        parent: screen,
        label: " Type here > ",
        left: 0,
        bottom: 1,
        width: `${chatWidth}%`,
        height: 3,
        border: { type: "line" },
        inputOnFocus: true,
        mouse: true,
        keys: true,
        style: {
            border: { fg: "green" },
            label: { fg: "green", bold: true },
            focus: {
                border: { fg: "white" },
            },
        },
    });
    // Tools panel
    const toolsBox = blessed.box({
        parent: screen,
        label: " Tools ",
        left: `${chatWidth}%`,
        top: 0,
        width: `${toolsWidth}%`,
        height: "100%-1",
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
    // Logs panel
    const logsBox = blessed.log({
        parent: screen,
        label: " Logs ",
        left: `${chatWidth + toolsWidth}%`,
        top: 0,
        width: `${100 - chatWidth - toolsWidth}%`,
        height: "100%-1",
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
        helpBar,
        focusables: [inputBox, chatBox, toolsBox, logsBox],
    };
}
