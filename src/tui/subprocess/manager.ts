import { spawn, type ChildProcess } from "node:child_process";
import type { GrotuiConfig, SubprocessHandlers } from "../types.js";

export class SubprocessManager {
  private proc: ChildProcess | null = null;
  private busy = false;

  constructor(
    private config: GrotuiConfig,
    private handlers: SubprocessHandlers,
  ) {}

  isBusy(): boolean {
    return this.busy;
  }

  sendPrompt(text: string): void {
    if (this.busy) return;
    this.busy = true;

    const args = [...this.config.args, text];
    this.proc = spawn(this.config.command, args, {
      stdio: ["pipe", "pipe", "pipe"],
      env: { ...process.env },
    });

    this.proc.stdout!.on("data", (chunk: Buffer) => {
      this.handlers.onStdout(chunk.toString("utf-8"));
    });

    this.proc.stderr!.on("data", (chunk: Buffer) => {
      this.handlers.onStderr(chunk.toString("utf-8"));
    });

    this.proc.on("exit", (code) => {
      this.busy = false;
      this.proc = null;
      this.handlers.onExit(code);
    });

    this.proc.on("error", (err) => {
      this.busy = false;
      this.proc = null;
      this.handlers.onStderr(`Subprocess error: ${err.message}\n`);
      this.handlers.onExit(1);
    });
  }

  kill(): void {
    if (this.proc) {
      this.proc.kill("SIGTERM");
      this.proc = null;
      this.busy = false;
    }
  }
}
