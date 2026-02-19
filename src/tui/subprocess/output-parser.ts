import type { ParsedEvent } from "../types.js";

export class OutputParser {
  private stdoutBuffer = "";

  parseStdout(chunk: string): ParsedEvent[] {
    this.stdoutBuffer += chunk;
    const events: ParsedEvent[] = [];
    const lines = this.stdoutBuffer.split("\n");
    this.stdoutBuffer = lines.pop() ?? "";

    for (const line of lines) {
      if (!line.trim()) continue;
      try {
        const obj = JSON.parse(line);
        if (obj.type === "token") {
          events.push({ type: "token", content: obj.token });
        } else if (obj.type === "result") {
          events.push({ type: "result", content: obj.result });
        }
      } catch {
        // Plain text mode fallback - treat as token
        events.push({ type: "token", content: line + "\n" });
      }
    }
    return events;
  }

  flushStdout(): ParsedEvent[] {
    const events: ParsedEvent[] = [];
    if (this.stdoutBuffer.trim()) {
      try {
        const obj = JSON.parse(this.stdoutBuffer);
        if (obj.type === "token") {
          events.push({ type: "token", content: obj.token });
        } else if (obj.type === "result") {
          events.push({ type: "result", content: obj.result });
        }
      } catch {
        events.push({ type: "token", content: this.stdoutBuffer });
      }
    }
    this.stdoutBuffer = "";
    return events;
  }

  parseStderr(chunk: string): ParsedEvent[] {
    const events: ParsedEvent[] = [];
    const lines = chunk.split("\n");

    for (const line of lines) {
      if (!line.trim()) continue;

      // Detect tool call patterns
      const toolCallMatch = line.match(
        /(?:Tool call|Calling tool|tool_use):\s*(\w+)\s*\((.+)\)/i,
      );
      if (toolCallMatch) {
        events.push({
          type: "tool_call",
          content: line,
          metadata: { toolName: toolCallMatch[1], toolArgs: toolCallMatch[2] },
        });
        continue;
      }

      // Detect tool result patterns
      const toolResultMatch = line.match(
        /(?:Tool result|tool_result):\s*(\w+)\s*[:\-]\s*(.+)/i,
      );
      if (toolResultMatch) {
        events.push({
          type: "tool_result",
          content: line,
          metadata: {
            toolName: toolResultMatch[1],
            toolResult: toolResultMatch[2],
          },
        });
        continue;
      }

      // Generic log line with level inference
      events.push({
        type: "log",
        content: line,
        metadata: { logLevel: inferLogLevel(line) },
      });
    }
    return events;
  }
}

function inferLogLevel(
  line: string,
): "debug" | "info" | "warn" | "error" {
  const lower = line.toLowerCase();
  if (lower.includes("[error]") || lower.includes("error:")) return "error";
  if (lower.includes("[warn]") || lower.includes("warning:")) return "warn";
  if (lower.includes("[debug]")) return "debug";
  return "info";
}
