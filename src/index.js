const { parseArgs } = require('./args.js');
const { loadConfig } = require('./config.js');
const { getProvider } = require('./providers/index.js');

async function run(argv) {
  const args = parseArgs(argv);

  if (args.help) {
    printUsage();
    return 0;
  }

  if (args.configCmd) {
    return handleConfig(args);
  }

  const config = loadConfig();
  const providerName = args.provider || config.defaultProvider || 'claude';
  const model = args.model || config.providers?.[providerName]?.model;

  const provider = getProvider(providerName);
  if (!provider) {
    console.error(`gro: unknown provider "${providerName}"`);
    console.error(`available: claude, openai, gemini`);
    return 1;
  }

  // read prompt from args or stdin
  let prompt = args.prompt;
  if (!prompt && args.pipe) {
    prompt = await readStdin();
  }
  if (!prompt) {
    console.error('gro: no prompt provided');
    return 1;
  }

  const opts = {
    model,
    systemPrompt: args.systemPrompt,
    pipe: args.pipe,
  };

  try {
    const result = await provider.complete(prompt, opts);
    process.stdout.write(result);
    if (!result.endsWith('\n')) process.stdout.write('\n');
    return 0;
  } catch (err) {
    console.error(`gro: ${providerName} error: ${err.message}`);
    return 1;
  }
}

function readStdin() {
  return new Promise((resolve) => {
    let data = '';
    process.stdin.setEncoding('utf-8');
    process.stdin.on('data', (chunk) => (data += chunk));
    process.stdin.on('end', () => resolve(data.trim()));
    // if stdin is a TTY, resolve immediately with null
    if (process.stdin.isTTY) resolve(null);
  });
}

function handleConfig(args) {
  const { loadConfig, saveConfig } = require('./config.js');
  const config = loadConfig();

  if (args.configCmd === 'set') {
    const [key, value] = args.configArgs;
    if (!key || !value) {
      console.error('usage: gro config set <key> <value>');
      return 1;
    }
    setNestedKey(config, key, value);
    saveConfig(config);
    console.log(`${key} = ${value}`);
    return 0;
  }

  if (args.configCmd === 'get') {
    const [key] = args.configArgs;
    if (!key) {
      console.log(JSON.stringify(config, null, 2));
    } else {
      const val = getNestedKey(config, key);
      console.log(val !== undefined ? val : `(not set)`);
    }
    return 0;
  }

  console.error(`gro config: unknown subcommand "${args.configCmd}"`);
  return 1;
}

function setNestedKey(obj, key, value) {
  // support dot-notation: "openai.model" -> obj.providers.openai.model
  if (key === 'default-provider' || key === 'defaultProvider') {
    obj.defaultProvider = value;
    return;
  }
  const parts = key.split('.');
  if (parts.length === 2) {
    // assume provider.setting, e.g. "openai.model"
    obj.providers = obj.providers || {};
    obj.providers[parts[0]] = obj.providers[parts[0]] || {};
    obj.providers[parts[0]][parts[1]] = value;
    return;
  }
  obj[key] = value;
}

function getNestedKey(obj, key) {
  if (key === 'default-provider' || key === 'defaultProvider') {
    return obj.defaultProvider;
  }
  const parts = key.split('.');
  if (parts.length === 2) {
    return obj.providers?.[parts[0]]?.[parts[1]];
  }
  return obj[key];
}

function printUsage() {
  console.log(`gro — provider-agnostic LLM CLI

usage:
  gro [options] "prompt"
  echo "prompt" | gro -p [options]
  gro config set <key> <value>
  gro config get [key]

options:
  --provider, -P   claude | openai | gemini (default: claude)
  --model, -m      model name (provider-specific)
  --system-prompt  system prompt text
  -p               pipe mode (read prompt from stdin)
  --help, -h       show this help

config keys:
  default-provider       default provider name
  <provider>.model       default model for a provider
  <provider>.api-key     API key (or use env vars)

examples:
  gro "explain quicksort"
  gro -P openai -m gpt-4o "explain quicksort"
  gro config set default-provider openai
  echo "summarize this" | gro -p --system-prompt "Be concise"
`);
}

module.exports = { run };
