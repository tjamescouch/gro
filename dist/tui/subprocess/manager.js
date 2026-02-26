import { spawn } from "node:child_process";
/**
 * Manages a persistent gro subprocess in interactive mode.
 * Sends prompts via stdin and detects response completion from stderr signals.
 */
export class SubprocessManager {
    constructor(config, handlers) {
        this.config = config;
        this.handlers = handlers;
        this.proc = null;
        this.busy = false;
        this.started = false;
    }
    isBusy() {
        return this.busy;
    }
    /** Start the persistent gro process in interactive mode. */
    start() {
        if (this.started)
            return;
        this.started = true;
        // Replace -p with -i for interactive mode, add stream-json output
        const args = this.config.args
            .filter(a => a !== "-p" && a !== "--print")
            .concat(["-i", "--output-format", "stream-json"]);
        this.proc = spawn(this.config.command, args, {
            stdio: ["pipe", "pipe", "pipe"],
            env: { ...process.env },
        });
        this.proc.stdout.on("data", (chunk) => {
            this.handlers.onStdout(chunk.toString("utf-8"));
        });
        this.proc.stderr.on("data", (chunk) => {
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
    sendPrompt(text) {
        if (this.busy)
            return;
        if (!this.started)
            this.start();
        this.busy = true;
        if (this.proc?.stdin?.writable) {
            this.proc.stdin.write(text + "\n");
        }
    }
    kill() {
        if (this.proc) {
            this.proc.kill("SIGTERM");
            this.proc = null;
            this.busy = false;
            this.started = false;
        }
    }
}
