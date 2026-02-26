import { spawn, type ChildProcess } from "node:child_process";
import type { GrotuiConfig, SubprocessHandlers } from "../types.js";

/**
 * Manages a persistent gro subprocess in interactive mode.
 * Sends prompts via stdin and detects response completion from stderr signals.
 */
export class SubprocessManager {
  private proc: ChildProcess | null = null;
  private busy = false;
  private started = false;

  constructor(
    private config: GrotuiConfig,
    private handlers: SubprocessHandlers,
  ) {}

  isBusy(): boolean {
    return this.busy;
  }

  /** Start the persistent gro process in interactive mode. */
  start(): void {
    if (this.started) return;
    this.started = true;

    // Replace -p with -i for interactive mode, add stream-json output
    const args = this.config.args
      .filter(a => a !== "-p" && a !== "--print")
      .concat(["-i", "--output-format", "stream-json"]);

    this.proc = spawn(this.config.command, args, {
      stdio: ["pipe", "pipe", "pipe"],
      env: { ...process.env },
    });

    this.proc.stdout!.on("data", (chunk: Buffer) => {
      this.handlers.onStdout(chunk.toString("utf-8"));
    });

    this.proc.stderr!.on("data", (chunk: Buffer) => {
      const text = chunk.toString("utf-8");
      this.handlers.onStderr(text);

      // Detect the readline prompt (may include ANSI color codes) which signals response completion
      const stripped = text.replace(/\x1b\[[0-9;]*m/g, "");
      if (/you > /m.test(stripped)) {
        if (this.busy) {
          this.busy = false;
          this.handlers.onExit(0);
        }
      }
    });

    this.proc.on("exit", (code) => {
      this.busy = false;
      this.started = false;
      this.proc = null;
      this.handlers.onExit(code);
    });

    this.proc.on("error", (err) => {
      this.busy = false;
      this.started = false;
      this.proc = null;
      this.handlers.onStderr(`Subprocess error: ${err.message}\n`);
      this.handlers.onExit(1);
    });
  }

  sendPrompt(text: string): void {
    if (this.busy) return;
    if (!this.started) this.start();
    this.busy = true;

    if (this.proc?.stdin?.writable) {
      this.proc.stdin.write(text + "\n");
    }
  }

  kill(): void {
    if (this.proc) {
      this.proc.kill("SIGTERM");
      this.proc = null;
      this.busy = false;
      this.started = false;
    }
  }
}
