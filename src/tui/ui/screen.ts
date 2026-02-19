import blessed from "blessed";

export function createScreen(): blessed.Widgets.Screen {
  const screen = blessed.screen({
    smartCSR: true,
    title: "grotui",
    fullUnicode: true,
  });

  return screen;
}

export function setupGlobalKeys(
  screen: blessed.Widgets.Screen,
  focusables: blessed.Widgets.BlessedElement[],
  inputBox: blessed.Widgets.TextareaElement,
  onQuit: () => void,
): void {
  let focusIndex = 0;

  screen.key(["C-c"], () => {
    onQuit();
  });

  screen.key(["tab"], () => {
    focusIndex = (focusIndex + 1) % focusables.length;
    focusables[focusIndex].focus();
    screen.render();
  });

  screen.key(["S-tab"], () => {
    focusIndex = (focusIndex - 1 + focusables.length) % focusables.length;
    focusables[focusIndex].focus();
    screen.render();
  });

  screen.key(["escape"], () => {
    focusIndex = 0;
    inputBox.focus();
    screen.render();
  });
}
