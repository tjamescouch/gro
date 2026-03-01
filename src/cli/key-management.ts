/**
 * CLI utilities — key management and interactive input.
 */

import { createInterface } from "node:readline";
import { getKey, setKey } from "../keychain.js";
import { Logger } from "../logger.js";

export async function runSetKey(provider: string): Promise<void> {
  const known = ["anthropic", "openai", "groq", "google", "xai"];
  if (!known.includes(provider)) {
    throw new Error(`Unknown provider "${provider}". Valid: ${known.join(", ")}`);
  }

  const current = getKey(provider);
  if (current) {
    process.stdout.write(`Keychain already has a key for ${provider} (${current.slice(0, 8)}…). Overwrite? [y/N] `);
    const answer = await readLine();
    if (!answer.toLowerCase().startsWith("y")) {
      Logger.info("Aborted.");
      return;
    }
  }

  process.stdout.write(`Enter API key for ${provider}: `);
  const key = await readLineHidden();
  process.stdout.write("\n");

  if (!key.trim()) {
    throw new Error("No key entered — aborted.");
  }

  setKey(provider, key.trim());
  console.log(`✓ Key stored in Keychain for provider "${provider}"`);
}

export function readLine(): Promise<string> {
  return new Promise(resolve => {
    const rl = createInterface({ input: process.stdin, output: process.stdout });
    rl.once("line", line => { rl.close(); resolve(line); });
  });
}

export function readLineHidden(): Promise<string> {
  return new Promise(resolve => {
    if (process.stdin.isTTY) process.stdin.setRawMode(true);
    process.stdin.resume();
    let buf = "";
    const onData = (chunk: Buffer) => {
      const s = chunk.toString("utf8");
      for (const ch of s) {
        if (ch === "\r" || ch === "\n") {
          process.stdin.removeListener("data", onData);
          if (process.stdin.isTTY) process.stdin.setRawMode(false);
          process.stdin.pause();
          resolve(buf);
          return;
        }
        if (ch === "\x03") { if (process.stdin.isTTY) process.stdin.setRawMode(false); process.exit(1); }
        if (ch === "\x7f" || ch === "\b") { buf = buf.slice(0, -1); }
        else { buf += ch; }
      }
    };
    process.stdin.on("data", onData);
  });
}
