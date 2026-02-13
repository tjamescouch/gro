#!/usr/bin/env node

const { run } = require('../src/index.js');

run(process.argv.slice(2)).then(
  (code) => process.exit(code),
  (err) => {
    console.error(`gro: ${err.message}`);
    process.exit(1);
  }
);
