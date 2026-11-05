'use strict';
/**
 * Temporary bootstrap: restore full app.js body from last known-good commit
 * if this file was overwritten, then apply statusWatch hook and re-export.
 */
const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

const BODY = path.join(__dirname, '_app_body.js');
const SOURCE =
  'https://raw.githubusercontent.com/CodexABQ/CODEX-AI/c60fde54cc7623bff996e7e4afcccd581225cf6f/app.js';

function ensureBody() {
  if (fs.existsSync(BODY) && fs.statSync(BODY).size > 10000) return;
  execSync('curl -fsSL "' + SOURCE + '" -o "' + BODY + '"', {
    stdio: 'inherit',
    timeout: 90000,
  });
}

ensureBody();

// Patch body once: install statusWatchHook after MessageHandler construction
try {
  let text = fs.readFileSync(BODY, 'utf8');
  if (!text.includes('statusWatchHook')) {
    const needle = 'this.messageHandler = new MessageHandler(this);';
    const insert =
      needle +
      "\n    try { require('./lib/statusWatchHook').install(this); } catch (e) { console.log('[statusWatch] hook:', e.message); }";
    if (text.includes(needle)) {
      text = text.replace(needle, insert);
      fs.writeFileSync(BODY, text);
    }
  }
} catch (e) {
  console.log('[app bootstrap] patch skipped:', e.message);
}

module.exports = require('./_app_body.js');
