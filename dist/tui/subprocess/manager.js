import { spawn } from "node:child_process";
export class SubprocessManager {
    constructor(config, handlers) {
        this.config = config;
        this.handlers = handlers;
        this.proc = null;
        this.busy = false;
    }
    isBusy() {
        return this.busy;
    }
    sendPrompt(text) {
        if (this.busy)
            return;
        this.busy = true;
        const args = [...this.config.args, text];
        this.proc = spawn(this.config.command, args, {
            stdio: ["pipe", "pipe", "pipe"],
            env: { ...process.env },
        });
        this.proc.stdout.on("data", (chunk) => {
            this.handlers.onStdout(chunk.toString("utf-8"));
        });
        this.proc.stderr.on("data", (chunk) => {
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
    kill() {
        if (this.proc) {
            this.proc.kill("SIGTERM");
            this.proc = null;
            this.busy = false;
        }
    }
}
