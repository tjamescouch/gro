const https = require('https');

const DEFAULT_MODEL = 'gemini-2.0-flash';

/**
 * Gemini provider — calls Google's Generative Language API.
 * Requires GEMINI_API_KEY env var or config.
 */
async function complete(prompt, opts = {}) {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) {
    throw new Error('GEMINI_API_KEY not set');
  }

  const model = opts.model || DEFAULT_MODEL;

  const contents = [];
  if (opts.systemPrompt) {
    // Gemini uses systemInstruction at top level
  }
  contents.push({ role: 'user', parts: [{ text: prompt }] });

  const body = {
    contents,
  };

  if (opts.systemPrompt) {
    body.systemInstruction = { parts: [{ text: opts.systemPrompt }] };
  }

  const payload = JSON.stringify(body);
  const path = `/v1beta/models/${model}:generateContent?key=${apiKey}`;

  return new Promise((resolve, reject) => {
    const req = https.request(
      {
        hostname: 'generativelanguage.googleapis.com',
        path,
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
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
            const content =
              json.candidates?.[0]?.content?.parts?.[0]?.text;
            if (!content) {
              reject(new Error('empty response from Gemini'));
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
    req.write(payload);
    req.end();
  });
}

module.exports = { name: 'gemini', complete };
