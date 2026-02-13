const { spawnSync } = require('child_process');

/**
 * Claude provider — delegates to the `claude` CLI.
 * This is the simplest path: just shell out to `claude -p`.
 */
async function complete(prompt, opts = {}) {
  const args = ['-p'];

  if (opts.model) {
    args.push('--model', opts.model);
  }
  if (opts.systemPrompt) {
    args.push('--system-prompt', opts.systemPrompt);
  }

  const result = spawnSync('claude', args, {
    input: prompt,
    encoding: 'utf-8',
    timeout: 120000,
    stdio: ['pipe', 'pipe', 'pipe'],
  });

  if (result.status !== 0) {
    const stderr = (result.stderr || '').trim();
    throw new Error(stderr || `claude exited with code ${result.status}`);
  }

  return (result.stdout || '').trim();
}

module.exports = { name: 'claude', complete };
