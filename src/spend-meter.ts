import { spawn } from "node:child_process";
import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { C } from "./logger.js";

// Pricing per million tokens (input / output) in USD
const PRICING: Record<string, { in: number; out: number }> = {
  // Haiku
  "claude-haiku-4-5":           { in: 0.80,  out: 4.00  },
  "claude-haiku-4-5-20251001":  { in: 0.80,  out: 4.00  },
  // Sonnet
  "claude-sonnet-4-5":                   { in: 3.00,  out: 15.00 },
  "claude-sonnet-4-5-20250929":          { in: 3.00,  out: 15.00 },
  "claude-sonnet-4-20250514":            { in: 3.00,  out: 15.00 },
  // Opus
  "claude-opus-4-6":            { in: 15.00, out: 75.00 },
  // OpenAI
  "gpt-4o":                     { in: 5.00,  out: 15.00 },
  "gpt-4o-mini":                { in: 0.15,  out: 0.60  },
  "gpt-4-turbo":                { in: 10.00, out: 30.00 },
  "o1":                         { in: 15.00, out: 60.00 },
  "o3-mini":                    { in: 1.10,  out: 4.40  },
  // Groq
  "llama-3.3-70b-versatile":    { in: 0.59,  out: 0.79  },
  "llama-3.1-70b-versatile":    { in: 0.59,  out: 0.79  },
  "llama-3.1-8b-instant":       { in: 0.05,  out: 0.08  },
  "llama3-70b-8192":            { in: 0.59,  out: 0.79  },
  "llama3-8b-8192":             { in: 0.05,  out: 0.08  },
  "gemma2-9b-it":               { in: 0.20,  out: 0.20  },
  "mixtral-8x7b-32768":         { in: 0.24,  out: 0.24  },
};

const DEFAULT_PRICING = { in: 3.00, out: 15.00 }; // sonnet fallback

const POST_INTERVAL_MS = 10 * 60 * 1000; // 10 minutes

const AGENTCHAT_SERVER = process.env.AGENTCHAT_SERVER ?? "ws://localhost:6667";
const AGENTCHAT_CHANNEL = process.env.AGENTCHAT_SPEND_CHANNEL ?? "#spend";

function findIdentity(): string | null {
  const candidates = [
    process.env.AGENTCHAT_IDENTITY,
    join(process.cwd(), ".agentchat", "identities", "gro.json"),
    join(homedir(), ".agentchat", "identities", "gro.json"),
  ];
  for (const p of candidates) {
    if (p && existsSync(p)) return p;
  }
  // Last resort: first identity found in cwd .agentchat dir
  const dir = join(process.cwd(), ".agentchat", "identities");
  if (existsSync(dir)) {
    const files = readdirSync(dir).filter(f => f.endsWith(".json"));
    if (files.length) return join(dir, files[0]);
  }
  return null;
}

function priceFor(model: string): { in: number; out: number } {
  if (PRICING[model]) return PRICING[model];
  // Fuzzy match prefix (e.g. "claude-haiku" matches "claude-haiku-4-5")
  for (const [key, val] of Object.entries(PRICING)) {
    if (model.startsWith(key) || key.startsWith(model)) return val;
  }
  return DEFAULT_PRICING;
}

export class SpendMeter {
  private startMs: number | null = null;
  private totalIn  = 0;
  private totalOut = 0;
  private model    = "";
  private lastPostMs: number | null = null;
  private lastCumulativeCost = 0;

  setModel(model: string) { this.model = model; }

  record(inputTokens: number, outputTokens: number) {
    if (this.startMs === null) this.startMs = Date.now();
    this.totalIn  += inputTokens;
    this.totalOut += outputTokens;
    this.maybePostToChat();
  }

  private maybePostToChat(): void {
    const now = Date.now();
    const due = this.lastPostMs === null || (now - this.lastPostMs) >= POST_INTERVAL_MS;
    if (!due) return;
    this.lastPostMs = now;

    const identity = findIdentity();
    if (!identity) return;

    const cumulativeCost = this.cost();
    const turnCost       = cumulativeCost - this.lastCumulativeCost;
    this.lastCumulativeCost = cumulativeCost;

    const hrs     = this.elapsedHours();
    const perHour = hrs > 0 ? cumulativeCost / hrs : 0;
    const tokTotal = this.totalIn + this.totalOut;
    const tokPerHr = hrs > 0 ? tokTotal / hrs : 0;

    const msg = [
      `💸 [${this.model || "unknown"}]`,
      `  turn:       $${turnCost.toFixed(4)}`,
      `  cumulative: $${cumulativeCost.toFixed(4)}`,
      `  rate:       $${perHour.toFixed(2)}/hr`,
      `  tokens:     ${fmtK(tokTotal)} total  ${fmtK(tokPerHr)}/hr`,
    ].join("\n");

    spawn("agentchat", [
      "send",
      "--identity", identity,
      AGENTCHAT_SERVER,
      AGENTCHAT_CHANNEL,
      msg,
    ], { detached: true, stdio: "ignore" }).unref();
  }

  private cost(): number {
    const p = priceFor(this.model);
    return (this.totalIn * p.in + this.totalOut * p.out) / 1_000_000;
  }

  private elapsedHours(): number {
    if (this.startMs === null) return 0;
    return (Date.now() - this.startMs) / 3_600_000;
  }

  /** Format a one-line spend summary for the status log. */
  format(): string {
    const cost     = this.cost();
    const hrs      = this.elapsedHours();
    const tokTotal = this.totalIn + this.totalOut;

    const costStr = `$${cost.toFixed(4)}`;

    // Suppress rate until at least 60 seconds have elapsed — avoids absurd $/hr on first call
    const minHrsForRate = 1 / 60;
    if (hrs < minHrsForRate) {
      return C.gray(`[spend] ${costStr}`);
    }

    const perHour  = cost / hrs;
    const tokPerHr = tokTotal / hrs;
    const rateStr  = `$${perHour.toFixed(2)}/hr`;
    const tokStr   = `${fmtK(tokPerHr)} tok/hr`;

    return C.gray(`[spend] ${costStr}  ${C.yellow(rateStr)}  ${tokStr}`);
  }

  get tokens() { return { in: this.totalIn, out: this.totalOut }; }
}

function fmtK(n: number): string {
  if (n >= 1_000_000) return (n / 1_000_000).toFixed(1) + "M";
  if (n >= 1_000)     return (n / 1_000).toFixed(1) + "K";
  return n.toFixed(0);
}

/** Singleton for the session. */
export const spendMeter = new SpendMeter();
