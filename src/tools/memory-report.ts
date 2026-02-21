/**
 * Built-in memory-report tool for gro — generates performance metrics report.
 * Shows recall rates, lane-specific metrics, compression ratios, and tuning recommendations.
 */
import type { AgentMemory } from "../memory/agent-memory.js";
import { VirtualMemory } from "../memory/virtual-memory.js";

export function memoryReportToolDefinition(): any {
  return {
    type: "function",
    function: {
      name: "memory_report",
      description: "Generate a memory performance report showing recall rates, lane metrics, compression ratios, and tuning recommendations. Use this to analyze VirtualMemory behavior and identify optimization opportunities.",
      parameters: {
        type: "object",
        properties: {},
        required: [],
      },
    },
  };
}

export function executeMemoryReport(args: Record<string, any>, memory: AgentMemory): string {
  if (!(memory instanceof VirtualMemory)) {
    return "Error: memory system is not VirtualMemory";
  }

  const vm = memory as VirtualMemory;
  const report = vm.generateMetricsReport();
  
  if (!report) {
    return "Memory metrics not available. The metrics collector may not be initialized, or no data has been collected yet.";
  }

  return report;
}
