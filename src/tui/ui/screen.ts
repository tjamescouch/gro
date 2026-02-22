import blessed from "blessed";
import { execSync } from "node:child_process";

// ─── Clipboard helpers ────────────────────────────────────────────────────────
function readClipboard(): string {
  try {
    if (process.platform === "darwin") return execSync("pbpaste").toString();
    try { return execSync("xclip -selection clipboard -o").toString(); } catch { /* fall through */ }
    return execSync("xsel --clipboard --output").toString();
  } catch { return ""; }
}

// ─── Mouse passthrough state ──────────────────────────────────────────────────
// Blessed grabs mouse events at the terminal level, which blocks the terminal's
// native text-selection machinery.  Ctrl+M suspends blessed mouse so you can
// select and copy freely; Ctrl+M / Esc re-engages it.
let _mousePassthrough = false;
export function isMousePassthrough(): boolean { return _mousePassthrough; }

function disableMouseTracking(): void {
  process.stdout.write("\x1b[?1000l"); // normal mouse off
  process.stdout.write("\x1b[?1002l"); // button-event mouse off
  process.stdout.write("\x1b[?1003l"); // any-event mouse off
  process.stdout.write("\x1b[?1006l"); // SGR mouse off
}

function enableMouseTracking(): void {
  process.stdout.write("\x1b[?1000h");
  process.stdout.write("\x1b[?1002h");
  process.stdout.write("\x1b[?1006h");
}

// ─── Help bar content ─────────────────────────────────────────────────────────
const HELP_NORMAL =
  " {bold}Enter{/bold}: Send/Load Log  {bold}Tab{/bold}: Focus  {bold}Esc{/bold}: Input" +
  "  {bold}Ctrl+L{/bold}: Load Log  {bold}↑↓/jk{/bold}: Scroll  {bold}Ctrl+M{/bold}: Copy Mode  {bold}Ctrl+V{/bold}: Paste  {bold}Ctrl+C{/bold}: Quit";

const HELP_PASSTHROUGH =
  " {bold}{yellow-fg}COPY MODE — select freely.  Ctrl+M or Esc to return.{/yellow-fg}{/bold}";

function setHelpBarContent(screen: blessed.Widgets.Screen, passthrough: boolean): void {
  const helpBar = (screen as any).children?.find(
    (c: any) => c.position?.bottom === 0 && c.position?.height === 1,
  ) as blessed.Widgets.BoxElement | undefined;
  if (helpBar) {
    helpBar.setContent(passthrough ? HELP_PASSTHROUGH : HELP_NORMAL);
    screen.render();
  }
}

// ─── Screen factory ───────────────────────────────────────────────────────────
export function createScreen(): blessed.Widgets.Screen {
  const screen = blessed.screen({
    smartCSR: true,
    title: "grotui",
    fullUnicode: true,
    // Enable bracketed paste so Ctrl+V paste events fire
    // (blessed exposes them as a 'paste' event on the screen)
  });

  return screen;
}

// ─── Global key bindings ──────────────────────────────────────────────────────
export function setupGlobalKeys(
  screen: blessed.Widgets.Screen,
  focusables: blessed.Widgets.BlessedElement[],
  inputBox: blessed.Widgets.TextareaElement,
  onQuit: () => void,
  onPaste?: (text: string) => void,
): void {
  let focusIndex = 0;

  // Quit
  screen.key(["C-c"], () => { onQuit(); });

  // ── Ctrl+M: toggle mouse passthrough ─────────────────────────────────────
  screen.key(["C-m"], () => {
    _mousePassthrough = !_mousePassthrough;
    if (_mousePassthrough) {
      disableMouseTracking();
    } else {
      enableMouseTracking();
    }
    setHelpBarContent(screen, _mousePassthrough);
  });

  // ── Ctrl+V: paste clipboard into focused element ──────────────────────────
  screen.key(["C-v"], () => {
    const text = readClipboard();
    if (text && onPaste) onPaste(text);
  });

  // ── Bracketed-paste event (terminal sends it automatically) ───────────────
  (screen as any).on("paste", (text: string) => {
    if (text && onPaste) onPaste(text);
  });

  // ── Tab / Shift+Tab: cycle focus ──────────────────────────────────────────
  screen.key(["tab"], () => {
    if (_mousePassthrough) return;
    focusIndex = (focusIndex + 1) % focusables.length;
    focusables[focusIndex].focus();
    screen.render();
  });

  screen.key(["S-tab"], () => {
    if (_mousePassthrough) return;
    focusIndex = (focusIndex - 1 + focusables.length) % focusables.length;
    focusables[focusIndex].focus();
    screen.render();
  });

  // ── Escape: exit passthrough OR return focus to input ────────────────────
  screen.key(["escape"], () => {
    if (_mousePassthrough) {
      _mousePassthrough = false;
      enableMouseTracking();
      setHelpBarContent(screen, false);
      screen.render();
    } else {
      focusIndex = 0;
      inputBox.focus();
      inputBox.readInput();
      screen.render();
    }
  });
}