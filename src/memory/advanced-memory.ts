import type { ChatDriver, ChatMessage } from "../drivers/types.js";
import { AgentMemory } from "./agent-memory.js";

/**
 * AdvancedMemory — swim-lane summarization with token budgeting.
 *
 * Maintains three lanes (assistant / system / user) and summarizes independently.
 * Uses character-based token estimation with high/low watermark hysteresis.
 * Background summarization never blocks the caller.
 */
export class AdvancedMemory extends AgentMemory {
  private readonly driver: ChatDriver;
  private readonly model: string;

  private readonly contextTokens: number;
  private readonly reserveHeaderTokens: number;
  private readonly reserveResponseTokens: number;
  private readonly highRatio: number;
  private readonly lowRatio: number;
  private readonly summaryRatio: number;
  private readonly avgCharsPerToken: number;
  private readonly keepRecentPerLane: number;
  private readonly keepRecentTools: number;

  constructor(args: {
    driver: ChatDriver;
    model: string;
    systemPrompt?: string;
    contextTokens?: number;
    reserveHeaderTokens?: number;
    reserveResponseTokens?: number;
    highRatio?: number;
    lowRatio?: number;
    summaryRatio?: number;
    avgCharsPerToken?: number;
    keepRecentPerLane?: number;
    keepRecentTools?: number;
  }) {
    super(args.systemPrompt);
    this.driver = args.driver;
    this.model = args.model;

    this.contextTokens = Math.max(2048, Math.floor(args.contextTokens ?? 8192));
    this.reserveHeaderTokens = Math.max(0, Math.floor(args.reserveHeaderTokens ?? 1200));
    this.reserveResponseTokens = Math.max(0, Math.floor(args.reserveResponseTokens ?? 800));
    this.highRatio = Math.min(0.95, Math.max(0.55, args.highRatio ?? 0.70));
    this.lowRatio = Math.min(this.highRatio - 0.05, Math.max(0.35, args.lowRatio ?? 0.50));
    this.summaryRatio = Math.min(0.50, Math.max(0.15, args.summaryRatio ?? 0.35));
    this.avgCharsPerToken = Math.max(1.5, Number(args.avgCharsPerToken ?? 4));
    this.keepRecentPerLane = Math.max(1, Math.floor(args.keepRecentPerLane ?? 4));
    this.keepRecentTools = Math.max(0, Math.floor(args.keepRecentTools ?? 3));
  }

  async load(_id: string): Promise<void> {
    // TODO: load from persistence
  }

  async save(_id: string): Promise<void> {
    // TODO: save to persistence
  }

  protected async onAfterAdd(): Promise<void> {
    const budget = this.budgetTokens();
    const estTok = this.estimateTokens(this.messagesBuffer);
    if (estTok <= Math.floor(this.highRatio * budget)) return;

    await this.runOnce(async () => {
      const budget2 = this.budgetTokens();
      const estTok2 = this.estimateTokens(this.messagesBuffer);
      if (estTok2 <= Math.floor(this.highRatio * budget2)) return;

      const { firstSystemIndex, assistant, user, system, tool, other } = this.partition();
      const tailN = this.keepRecentPerLane;

      const olderAssistant = assistant.slice(0, Math.max(0, assistant.length - tailN));
      const keepAssistant = assistant.slice(Math.max(0, assistant.length - tailN));

      const sysHead = firstSystemIndex === 0 ? [this.messagesBuffer[0]] : [];
      const remainingSystem = firstSystemIndex === 0 ? system.slice(1) : system.slice(0);
      const olderSystem = remainingSystem.slice(0, Math.max(0, remainingSystem.length - tailN));
      const keepSystem = remainingSystem.slice(Math.max(0, remainingSystem.length - tailN));

      const olderUser = user.slice(0, Math.max(0, user.length - tailN));
      const keepUser = user.slice(Math.max(0, user.length - tailN));

      const keepTools = tool.slice(Math.max(0, tool.length - this.keepRecentTools));

      const preserved: ChatMessage[] = [
        ...sysHead, ...keepAssistant, ...keepSystem, ...keepUser, ...keepTools, ...other,
      ];
      const preservedTok = this.estimateTokens(preserved);
      const lowTarget = Math.floor(this.lowRatio * budget2);
      const maxSummaryTok = Math.floor(this.summaryRatio * budget2);

      if (preservedTok <= lowTarget) {
        const rebuilt = this.ordered([], sysHead, keepAssistant, keepSystem, keepUser, keepTools, other);
        this.messagesBuffer.splice(0, this.messagesBuffer.length, ...rebuilt);
        return;
      }

      const removedCharA = this.totalChars(olderAssistant);
      const removedCharS = this.totalChars(olderSystem);
      const removedCharU = this.totalChars(olderUser);
      const removedTotal = Math.max(1, removedCharA + removedCharS + removedCharU);

      const totalSummaryBudget = Math.max(64, Math.min(maxSummaryTok, lowTarget - preservedTok));
      const budgetA = Math.max(48, Math.floor(totalSummaryBudget * (removedCharA / removedTotal)));
      const budgetS = Math.max(48, Math.floor(totalSummaryBudget * (removedCharS / removedTotal)));
      const budgetU = Math.max(48, Math.floor(totalSummaryBudget * (removedCharU / removedTotal)));

      const [sumA, sumS, sumU] = await Promise.all([
        olderAssistant.length ? this.summarizeLane("assistant", olderAssistant, budgetA) : "",
        olderSystem.length ? this.summarizeLane("system", olderSystem, budgetS) : "",
        olderUser.length ? this.summarizeLane("user", olderUser, budgetU) : "",
      ]);

      const summaries: ChatMessage[] = [];
      if (sumA) summaries.push({ from: "Me", role: "assistant", content: `ASSISTANT SUMMARY:\n${sumA}` });
      if (sumS) summaries.push({ from: "System", role: "system", content: `SYSTEM SUMMARY:\n${sumS}` });
      if (sumU) summaries.push({ from: "Memory", role: "user", content: `USER SUMMARY:\n${sumU}` });

      const rebuilt = this.ordered(summaries, sysHead, keepAssistant, keepSystem, keepUser, keepTools, other);
      this.messagesBuffer.splice(0, this.messagesBuffer.length, ...rebuilt);

      // Final clamp
      let finalTok = this.estimateTokens(this.messagesBuffer);
      if (finalTok > lowTarget) {
        const pruned: ChatMessage[] = [];
        for (const m of this.messagesBuffer) {
          pruned.push(m);
          finalTok = this.estimateTokens(pruned);
          if (finalTok > lowTarget && m.role !== "system") {
            pruned.pop();
          }
        }
        this.messagesBuffer.splice(0, this.messagesBuffer.length, ...pruned);
      }
    });
  }

  private budgetTokens(): number {
    return Math.max(512, this.contextTokens - this.reserveHeaderTokens - this.reserveResponseTokens);
  }

  private estimateTokens(msgs: ChatMessage[]): number {
    return Math.ceil(this.totalChars(msgs) / this.avgCharsPerToken);
  }

  private totalChars(msgs: ChatMessage[]): number {
    let c = 0;
    for (const m of msgs) {
      const s = String((m as any).content ?? "");
      if (m.role === "tool" && s.length > 24_000) c += 24_000;
      else c += s.length;
      c += 32;
    }
    return c;
  }

  private partition() {
    const assistant: ChatMessage[] = [];
    const user: ChatMessage[] = [];
    const system: ChatMessage[] = [];
    const tool: ChatMessage[] = [];
    const other: ChatMessage[] = [];

    for (const m of this.messagesBuffer) {
      switch (m.role) {
        case "assistant": assistant.push(m); break;
        case "user": user.push(m); break;
        case "system": system.push(m); break;
        case "tool": tool.push(m); break;
        default: other.push(m); break;
      }
    }
    const firstSystemIndex = this.messagesBuffer.findIndex(x => x.role === "system");
    return { firstSystemIndex, assistant, user, system, tool, other };
  }

  private ordered(
    summaries: ChatMessage[],
    sysHead: ChatMessage[],
    keepA: ChatMessage[],
    keepS: ChatMessage[],
    keepU: ChatMessage[],
    keepT: ChatMessage[],
    other: ChatMessage[],
  ): ChatMessage[] {
    const keepSet = new Set([...sysHead, ...keepA, ...keepS, ...keepU, ...keepT, ...other]);
    const rest: ChatMessage[] = [];
    for (const m of this.messagesBuffer) {
      if (keepSet.has(m)) rest.push(m);
    }
    const orderedSummaries = [
      ...summaries.filter(s => s.role === "assistant"),
      ...summaries.filter(s => s.role === "system"),
      ...summaries.filter(s => s.role === "user"),
    ];
    return [...orderedSummaries, ...rest];
  }

  private async summarizeLane(
    laneName: "assistant" | "system" | "user",
    messages: ChatMessage[],
    tokenBudget: number,
  ): Promise<string> {
    if (messages.length === 0 || tokenBudget <= 0) return "";
    const approxChars = Math.max(120, Math.floor(tokenBudget * this.avgCharsPerToken));

    const header = (() => {
      switch (laneName) {
        case "assistant": return "Summarize prior ASSISTANT replies (decisions, plans, code edits, shell commands and outcomes).";
        case "system": return "Summarize SYSTEM instructions (rules, goals, constraints) without changing their intent.";
        case "user": return "Summarize USER requests, feedback, constraints, and acceptance criteria.";
      }
    })();

    let acc = "";
    for (const m of messages) {
      let c = String((m as any).content ?? "");
      if (c.length > 4000) c = c.slice(0, 4000) + "\n…(truncated)…";
      const next = `- ${laneName.toUpperCase()}: ${c}\n\n`;
      if (acc.length + next.length > approxChars * 3) break;
      acc += next;
    }

    const sys: ChatMessage = {
      role: "system",
      from: "System",
      content: [
        "You are a precise summarizer.",
        "Output concise bullet points; preserve facts, tasks, file paths, commands, constraints.",
        `Hard limit: ~${approxChars} characters total.`,
        "Avoid fluff; keep actionable details.",
      ].join(" "),
    };

    const usr: ChatMessage = {
      role: "user",
      from: "User",
      content: `${header}\n\nTranscript:\n${acc}`,
    };

    const out = await this.driver.chat([sys, usr], { model: this.model });
    return String((out as any)?.text ?? "").trim();
  }
}
