'use strict';
/**
 * Ships the full connection implementation as _connection_body.js
 * (from groups-update.zip). Falls back to downloading if body is missing.
 */
const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

const BODY = path.join(__dirname, '_connection_body.js');
const SOURCE =
  'https://raw.githubusercontent.com/CodexABQ/CODEX-AI/main/lib/_connection_body.js';

if (!fs.existsSync(BODY) || fs.statSync(BODY).size < 10000) {
  try {
    execSync('curl -fsSL "' + SOURCE + '" -o "' + BODY + '"', { stdio: 'inherit', timeout: 90000 });
  } catch (e) {
    console.error('Failed to restore connection body:', e.message);
    throw e;
  }
}
module.exports = require('./_connection_body.js');
