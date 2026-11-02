'use strict';
/**
 * Emergency restore wrapper.
 * Pulls the last known-good connection.js body from this repo (commit 0d274d9)
 * on first boot, then re-exports it. Once the body is on disk, later boots
 * just require it locally.
 */
const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

const BODY = path.join(__dirname, '_connection_body.js');
const SOURCE =
  'https://raw.githubusercontent.com/CodexABQ/CODEX-AI/0d274d96fc59984c8d5576f27c9d787dd8517ce3/lib/connection.js';

if (!fs.existsSync(BODY) || fs.statSync(BODY).size < 10000) {
  try {
    execSync('curl -fsSL "' + SOURCE + '" -o "' + BODY + '"', { stdio: 'inherit', timeout: 60000 });
  } catch (e) {
    console.error('Failed to restore connection.js body:', e.message);
    throw e;
  }
  // Marketplace: cache incoming album children as soon as the socket is up.
  try {
    let text = fs.readFileSync(BODY, 'utf8');
    const needle =
      '  bot._msgUpsertChain = Promise.resolve();\n  bot._pipeQueued = 0;\n  _pipeMark(bot, "idle");';
    const insert =
      '  bot._msgUpsertChain = Promise.resolve();\n' +
      '  bot._pipeQueued = 0;\n' +
      '  // Marketplace: start caching incoming album children immediately.\n' +
      '  try { require("./marketplace").ensureAlbumListener(bot.sock); } catch (e) { console.log("marketplace album listener:", e.message); }\n' +
      '  _pipeMark(bot, "idle");';
    if (text.includes(needle) && text.indexOf('ensureAlbumListener') === -1) {
      text = text.replace(needle, insert);
      fs.writeFileSync(BODY, text);
    }
  } catch (e) {
    console.log('marketplace album listener patch skipped:', e.message);
  }
}

module.exports = require('./_connection_body.js');
