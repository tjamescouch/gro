const { spawnSync, execSync } = require('child_process');
const https = require('https');

const DEFAULT_MODEL = 'claude-sonnet-4-20250514';

/**
 * Claude provider — tries `claude` CLI first, falls back to Anthropic HTTP API.
 */
async function complete(prompt, opts = {}) {
  // try CLI first
  if (hasClaude()) {
    return completeCLI(prompt, opts);
  }

  // fallback to HTTP API
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (apiKey) {
    return completeHTTP(prompt, opts, apiKey);
  }

  throw new Error('neither `claude` CLI nor ANTHROPIC_API_KEY available');
}

function hasClaude() {
  try {
    execSync('which claude', { stdio: 'pipe' });
    return true;
  } catch {
    return false;
  }
}

function completeCLI(prompt, opts) {
  const args = ['-p'];
  if (opts.model) args.push('--model', opts.model);
  if (opts.systemPrompt) args.push('--system-prompt', opts.systemPrompt);

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

function completeHTTP(prompt, opts, apiKey) {
  const model = opts.model || DEFAULT_MODEL;
  const messages = [{ role: 'user', content: prompt }];

  const body = { model, max_tokens: 4096, messages };
  if (opts.systemPrompt) {
    body.system = opts.systemPrompt;
  }

  const payload = JSON.stringify(body);

  return new Promise((resolve, reject) => {
    const req = https.request(
      {
        hostname: 'api.anthropic.com',
        path: '/v1/messages',
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-api-key': apiKey,
          'anthropic-version': '2023-06-01',
        },
      },
      (res) => {
        let data = '';
        res.on('data', (chunk) => (data += chunk));
        res.on('end', () => {
          try {
            const json = JSON.parse(data);
            if (json.error) {
              reject(new Error(json.error.message));
              return;
            }
            const text = json.content?.[0]?.text;
            if (!text) {
              reject(new Error('empty response from Anthropic API'));
              return;
            }
            resolve(text.trim());
          } catch (err) {
            reject(new Error(`failed to parse response: ${err.message}`));
          }
        });
      }
    );

    req.on('error', reject);
    req.write(payload);
    req.end();
  });
}

module.exports = { name: 'claude', complete };
