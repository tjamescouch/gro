/**
 * memory_report — Generate a performance report from VirtualMemory metrics
 */
export const memoryReportTool = {
    name: "memory_report",
    description: "Generate a memory performance report showing recall rates, lane metrics, compression ratios, and tuning recommendations. Use this to analyze VirtualMemory behavior and identify optimization opportunities.",
    input_schema: {
        type: "object",
        properties: {
            format: {
                type: "string",
                enum: ["markdown", "json"],
                description: "Output format (default: markdown)",
            },
        },
    },
};
export const memoryReportHandler = async (args, { memory }) => {
    const format = args.format || "markdown";
    if (!memory) {
        return {
            success: false,
            error: "Memory subsystem not available",
        };
    }
    // Access the metrics collector via a new method on VirtualMemory
    const metricsReport = memory.generateMetricsReport?.();
    if (!metricsReport) {
        return {
            success: false,
            error: "Memory metrics not available. Metrics collector may not be initialized.",
        };
    }
    if (format === "json") {
        return {
            success: true,
            metrics: metricsReport,
        };
    }
    // Return markdown report
    return {
        success: true,
        report: metricsReport,
    };
};
