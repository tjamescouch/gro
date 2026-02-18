/**
 * test/owl — VirtualMemory swimlane smoke test
 *
 * Exercises compaction with realistic mixed-lane traffic.
 * Runs one full paging cycle and reports buffer state.
 */

import { VirtualMemory } from "../src/memory/virtual-memory.js";
import type { ChatDriver, ChatMessage, ChatOutput } from "../src/drivers/types.js";
import { tmpdir } from "node:os";
import { join } from "node:path";

const RESET = "\x1b[0m";
const GREEN = "\x1b[32m";
const YELLOW = "\x1b[33m";
const CYAN  = "\x1b[36m";
const RED   = "\x1b[31m";
const BOLD  = "\x1b[1m";

let calls = 0;
const mockDriver: ChatDriver = {
  async chat(_msgs: ChatMessage[], _opts?: any): Promise<ChatOutput> {
    calls++;
    return { text: `• Summarized context.\n• Key decisions preserved.\n• Context compressed.`, toolCalls: [] };
  },
};

const pagesDir = join(tmpdir(), `owl-test-${Date.now()}`);

const mem = new VirtualMemory({
  pagesDir,
  driver: mockDriver,
  workingMemoryTokens: 800,
  pageSlotTokens: 2_000,
  avgCharsPerToken: 4,
  minRecentPerLane: 2,
  highRatio: 0.70,
  lowRatio: 0.50,
  systemPrompt: "You are a helpful assistant with swimlane memory.",
});

console.log(`\n${BOLD}${CYAN}owl — VirtualMemory swimlane test${RESET}\n`);
console.log(`${YELLOW}config:${RESET} workingMemory=800 tokens | minRecentPerLane=2 | highRatio=0.70\n`);

const t0 = Date.now();

// Feed mixed-lane traffic
for (let i = 0; i < 24; i++) {
  await mem.add({ role: "user",      content: `User msg ${i}: requesting something substantive that takes up token budget.`,     from: "user" });
  await mem.add({ role: "assistant", content: `Assistant reply ${i}: providing a detailed response with context and reasoning.`, from: "assistant" });

  if (i % 4 === 0) {
    await mem.add({ role: "system", content: `System update ${i}: new instruction or constraint from the environment.`, from: "system" });
  }
  if (i % 6 === 0) {
    await mem.add({ role: "tool", content: `Tool result ${i}: { "status": "ok", "data": [1,2,3] }`, from: "tool", tool_call_id: `tc${i}` } as ChatMessage);
  }
}

const elapsed = Date.now() - t0;
const msgs = mem.messages();

// Analyse buffer
const byRole: Record<string, number> = {};
for (const m of msgs) byRole[m.role] = (byRole[m.role] ?? 0) + 1;

const summaries    = msgs.filter(m => typeof m.content === "string" && m.content.includes("LANE SUMMARY"));
const sysPreserved = msgs.some(m => m.role === "system" && m.content?.toString().includes("swimlane memory"));
const pages        = mem.getPageCount();

// Report
console.log(`${YELLOW}results:${RESET}`);
console.log(`  elapsed         ${elapsed}ms`);
console.log(`  final msgs      ${msgs.length}`);
console.log(`  pages on disk   ${pages}`);
console.log(`  summ calls      ${calls}`);
console.log(`  lane summaries  ${summaries.length}`);
console.log(`  breakdown       ${JSON.stringify(byRole)}`);
console.log();

// Assertions
let pass = true;
const check = (label: string, ok: boolean) => {
  console.log(`  ${ok ? `${GREEN}✔${RESET}` : `${RED}✘${RESET}`}  ${label}`);
  if (!ok) pass = false;
};

check("buffer compacted (< 80 msgs)",  msgs.length < 80);
check("buffer not empty",              msgs.length > 0);
check("system prompt preserved",       sysPreserved);
check("summarization fired",           calls > 0);
check("swimlane summaries in buffer",  summaries.length > 0);
check("pages written to disk",         pages > 0);

console.log();
if (pass) {
  console.log(`${GREEN}${BOLD}all checks passed${RESET}\n`);
  process.exit(0);
} else {
  console.log(`${RED}${BOLD}some checks failed${RESET}\n`);
  process.exit(1);
}
