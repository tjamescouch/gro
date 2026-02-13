function parseArgs(argv) {
  const result = {
    provider: null,
    model: null,
    systemPrompt: null,
    pipe: false,
    help: false,
    prompt: null,
    configCmd: null,
    configArgs: [],
  };

  // handle "config" subcommand
  if (argv[0] === 'config') {
    result.configCmd = argv[1] || 'get';
    result.configArgs = argv.slice(2);
    return result;
  }

  const positional = [];

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    switch (arg) {
      case '--provider':
      case '-P':
        result.provider = argv[++i];
        break;
      case '--model':
      case '-m':
        result.model = argv[++i];
        break;
      case '--system-prompt':
        result.systemPrompt = argv[++i];
        break;
      case '-p':
        result.pipe = true;
        break;
      case '--help':
      case '-h':
        result.help = true;
        break;
      default:
        if (arg.startsWith('-')) {
          console.error(`gro: unknown flag "${arg}"`);
          process.exit(1);
        }
        positional.push(arg);
    }
  }

  if (positional.length > 0) {
    result.prompt = positional.join(' ');
  }

  return result;
}

module.exports = { parseArgs };
