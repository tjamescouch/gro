import blessed from "blessed";
import type { GrotuiConfig } from "../types.js";
import { ChatPanel } from "./chat-panel.js";
import { ToolsPanel } from "./tools-panel.js";
import { LogsPanel } from "./logs-panel.js";

export interface Layout {
  chatPanel: ChatPanel;
  toolsPanel: ToolsPanel;
  logsPanel: LogsPanel;
  inputBox: blessed.Widgets.TextareaElement;
  helpBar: blessed.Widgets.BoxElement;
  focusables: blessed.Widgets.BlessedElement[];
}

// ─── Arrow-key scroll helper ──────────────────────────────────────────────────
// Each scrollable box gets arrow-key + vim bindings when focused.
// The input box keeps its own arrow-key behaviour (cursor movement) so we
// only attach to the read-only panels.
function bindScrollKeys(
  box: blessed.Widgets.BlessedElement,
  screen: blessed.Widgets.Screen,
  scrollLines = 3,
): void {
  const el = box as blessed.Widgets.ScrollableBoxElement;

  box.key(["up", "k"], () => {
    el.scroll(-scrollLines);
    screen.render();
  });

  box.key(["down", "j"], () => {
    el.scroll(scrollLines);
    screen.render();
  });

  box.key(["pageup", "b"], () => {
    el.scroll(-(el.height as number));
    screen.render();
  });

  box.key(["pagedown", "f"], () => {
    el.scroll(el.height as number);
    screen.render();
  });

  box.key(["g"], () => { el.setScrollPerc(0); screen.render(); }); // top
  box.key(["G", "S-g"], () => { el.setScrollPerc(100); screen.render(); }); // bottom
}

// ─── Layout factory ───────────────────────────────────────────────────────────
export function createLayout(
  screen: blessed.Widgets.Screen,
  config: GrotuiConfig,
): Layout {
  const [chatPct, toolsPct, logsPct] = config.panelRatios;
  const total = chatPct + toolsPct + logsPct;
  const chatWidth = Math.round((chatPct / total) * 100);
  const toolsWidth = Math.round((toolsPct / total) * 100);

  // ── Help bar ────────────────────────────────────────────────────────────────
  const helpBar = blessed.box({
    parent: screen,
    bottom: 0,
    left: 0,
    width: "100%",
    height: 1,
    tags: true,
    style: { bg: "blue", fg: "white" },
    content:
      " {bold}Enter{/bold}: Send  {bold}Tab{/bold}: Focus  {bold}Esc{/bold}: Input" +
      "  {bold}↑↓/jk{/bold}: Scroll  {bold}Ctrl+M{/bold}: Copy Mode  {bold}Ctrl+V{/bold}: Paste  {bold}Ctrl+C{/bold}: Quit",
  });

  // ── Chat history ────────────────────────────────────────────────────────────
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
    wrap: true,
    style: {
      border: { fg: "cyan" },
      label: { fg: "cyan", bold: true },
    },
  });
  bindScrollKeys(chatBox, screen);

  // ── Input box ───────────────────────────────────────────────────────────────
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
  }) as blessed.Widgets.TextareaElement;

  // ── Tools panel ─────────────────────────────────────────────────────────────
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
  bindScrollKeys(toolsBox, screen);

  // ── Logs panel ──────────────────────────────────────────────────────────────
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
  }) as blessed.Widgets.Log;
  bindScrollKeys(logsBox, screen);

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
