#!/usr/bin/env node
/**
 * gro supervisor — forks main.ts and maintains warm state snapshots.
 *
 * On child crash or @@reboot@@ reload: restarts with last snapshot via IPC.
 * State never touches disk — lives in supervisor's heap.
 *
 * Exit codes from child:
 *   0  = clean exit (don't restart)
 *   75 = reload request (@@reboot@@, restart with warm state)
 *   96 = PLASTIC rollback (restart cold, discard warm state)
 *   *  = crash (restart with warm state if available)
 */
import { fork } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
const __dirname = dirname(fileURLToPath(import.meta.url));
const MAIN_SCRIPT = join(__dirname, "main.js");
const EXIT_RELOAD = 75;
const EXIT_ROLLBACK = 96;
class Supervisor {
    constructor(args) {
        this.child = null;
        this.lastSnapshot = null;
        this.shuttingDown = false;
        this.restartCount = 0;
        this.maxRestarts = 50;
        // Crash loop detection
        this.crashTimestamps = [];
        this.RAPID_CRASH_WINDOW_MS = 5000;
        this.RAPID_CRASH_THRESHOLD = 3;
        this.childArgs = [...args.filter(a => a !== "--supervisor"), "--supervised"];
    }
    start() {
        this.spawnChild();
        this.setupSignalHandlers();
    }
    setupSignalHandlers() {
        for (const sig of ["SIGINT", "SIGTERM", "SIGHUP"]) {
            process.on(sig, () => {
                if (this.shuttingDown)
                    return;
                this.shuttingDown = true;
                this.log(`received ${sig}, shutting down worker`);
                if (this.child && this.child.connected) {
                    const msg = { type: "shutdown" };
                    try {
                        this.child.send(msg);
                    }
                    catch { }
                    // Grace period then force kill
                    setTimeout(() => {
                        if (this.child && !this.child.killed) {
                            this.child.kill("SIGKILL");
                        }
                        process.exit(0);
                    }, 5000);
                }
                else {
                    process.exit(0);
                }
            });
        }
    }
    spawnChild() {
        this.child = fork(MAIN_SCRIPT, this.childArgs, {
            stdio: ["inherit", "inherit", "inherit", "ipc"],
            env: { ...process.env },
        });
        this.child.on("message", (msg) => {
            if (msg.type === "state_snapshot") {
                this.lastSnapshot = msg.payload;
            }
            else if (msg.type === "reload_request") {
                this.lastSnapshot = msg.payload;
                this.log("reload requested, restarting worker with warm state");
                // Child will exit(75) itself; the exit handler will restart
            }
            else if (msg.type === "ready") {
                // Child is initialized — send warm state if available
                if (this.lastSnapshot && this.child?.connected) {
                    const msg = { type: "warm_state", payload: this.lastSnapshot };
                    try {
                        this.child.send(msg);
                    }
                    catch { }
                    this.log(`sent warm state (${this.lastSnapshot.messages.length} messages, session ${this.lastSnapshot.sessionId})`);
                }
            }
        });
        this.child.on("exit", (code, signal) => {
            this.child = null;
            if (this.shuttingDown) {
                process.exit(code ?? 0);
                return;
            }
            // Clean exit — don't restart
            if (code === 0) {
                this.log("worker exited cleanly");
                process.exit(0);
                return;
            }
            // PLASTIC rollback — discard warm state
            if (code === EXIT_ROLLBACK) {
                this.log("PLASTIC rollback — discarding warm state, restarting cold");
                this.lastSnapshot = null;
            }
            // Crash loop detection — skip for intentional reloads (exit 75)
            if (code !== EXIT_RELOAD) {
                const now = Date.now();
                this.crashTimestamps.push(now);
                this.crashTimestamps = this.crashTimestamps.filter(t => now - t < this.RAPID_CRASH_WINDOW_MS);
                if (this.crashTimestamps.length >= this.RAPID_CRASH_THRESHOLD) {
                    this.log(`rapid crash loop detected (${this.crashTimestamps.length} crashes in ${this.RAPID_CRASH_WINDOW_MS}ms), giving up`);
                    process.exit(1);
                }
            }
            this.restartCount++;
            if (this.restartCount > this.maxRestarts) {
                this.log(`max restarts (${this.maxRestarts}) exceeded, giving up`);
                process.exit(1);
            }
            const hasState = this.lastSnapshot !== null;
            this.log(`worker exited (code=${code}, signal=${signal}), restarting ` +
                `(${hasState ? "warm" : "cold"}, restart #${this.restartCount})`);
            // Brief delay to avoid tight restart loops
            setTimeout(() => this.spawnChild(), 500);
        });
        this.child.on("error", (err) => {
            this.log(`child process error: ${err.message}`);
        });
    }
    log(msg) {
        process.stderr.write(`[supervisor] ${msg}\n`);
    }
}
// --- Entry point ---
const args = process.argv.slice(2);
const supervisor = new Supervisor(args);
supervisor.start();
