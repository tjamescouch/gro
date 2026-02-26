export function parseConfig(argv) {
    const config = {
        command: "gro",
        args: ["--bash"],
        panelRatios: [50, 25, 25],
    };
    const passthrough = [];
    for (let i = 0; i < argv.length; i++) {
        const arg = argv[i];
        if ((arg === "--command" || arg === "-C") && argv[i + 1]) {
            config.command = argv[++i];
        }
        else if (arg === "--args" && argv[i + 1]) {
            config.args = argv[++i].split(" ");
        }
        else if (arg === "--layout" && argv[i + 1]) {
            const parts = argv[++i].split(":").map(Number);
            if (parts.length === 3 && parts.every((n) => n > 0)) {
                config.panelRatios = parts;
            }
        }
        else {
            // Pass through unknown args to gro subprocess
            passthrough.push(arg);
        }
    }
    if (passthrough.length > 0) {
        config.args = [...config.args, ...passthrough];
    }
    return config;
}
