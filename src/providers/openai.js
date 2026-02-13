const https = require('https');

const DEFAULT_MODEL = 'gpt-4o';

/**
 * OpenAI provider — calls the chat completions API directly.
 * Requires OPENAI_API_KEY env var or config.
 */
async function complete(prompt, opts = {}) {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) {
    throw new Error('OPENAI_API_KEY not set');
  }

  const model = opts.model || DEFAULT_MODEL;

  const messages = [];
  if (opts.systemPrompt) {
    messages.push({ role: 'system', content: opts.systemPrompt });
  }
  messages.push({ role: 'user', content: prompt });

  const body = JSON.stringify({ model, messages });

  return new Promise((resolve, reject) => {
    const req = https.request(
      {
        hostname: 'api.openai.com',
        path: '/v1/chat/completions',
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${apiKey}`,
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
            const content = json.choices?.[0]?.message?.content;
            if (!content) {
              reject(new Error('empty response from OpenAI'));
              return;
            }
            resolve(content.trim());
          } catch (err) {
            reject(new Error(`failed to parse response: ${err.message}`));
          }
        });
      }
    );

    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

module.exports = { name: 'openai', complete };
