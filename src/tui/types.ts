export interface GrotuiConfig {
  command: string;
  args: string[];
  panelRatios: [number, number, number];
}

export interface ParsedEvent {
  type: "token" | "result" | "tool_call" | "tool_result" | "log";
  content: string;
  metadata?: {
    toolName?: string;
    toolArgs?: string;
    toolResult?: string;
    logLevel?: "debug" | "info" | "warn" | "error";
  };
}

export interface SubprocessHandlers {
  onStdout: (chunk: string) => void;
  onStderr: (chunk: string) => void;
  onExit: (code: number | null) => void;
}

export interface ToolCallEntry {
  name: string;
  args: string;
  result: string | null;
  status: "running" | "done";
}
