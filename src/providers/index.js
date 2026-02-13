const claude = require('./claude.js');
const openai = require('./openai.js');
const gemini = require('./gemini.js');

const providers = { claude, openai, gemini };

function getProvider(name) {
  return providers[name] || null;
}

module.exports = { getProvider };
