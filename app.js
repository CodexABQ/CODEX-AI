'use strict';
/**
 * Bootstrap: restore full app.js body from last known-good commit,
 * then install statusWatch + vvCmd hooks and re-export.
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

function patchHooks() {
  let text = fs.readFileSync(BODY, 'utf8');
  let dirty = false;

  const needle = 'this.messageHandler = new MessageHandler(this);';
  if (text.includes(needle) && !text.includes("statusWatchHook').install")) {
    text = text.replace(
      needle,
      needle +
        "\n    try { require('./lib/statusWatchHook').install(this); } catch (e) { console.log('[statusWatch] hook:', e.message); }" +
        "\n    try { require('./lib/vvCmdHook').install(this); } catch (e) { console.log('[vvCmd] hook:', e.message); }"
    );
    dirty = true;
  } else if (text.includes("statusWatchHook').install") && !text.includes("vvCmdHook').install")) {
    text = text.replace(
      "try { require('./lib/statusWatchHook').install(this); } catch (e) { console.log('[statusWatch] hook:', e.message); }",
      "try { require('./lib/statusWatchHook').install(this); } catch (e) { console.log('[statusWatch] hook:', e.message); }\n    try { require('./lib/vvCmdHook').install(this); } catch (e) { console.log('[vvCmd] hook:', e.message); }"
    );
    dirty = true;
  }

  if (dirty) fs.writeFileSync(BODY, text);
}

try {
  patchHooks();
} catch (e) {
  console.log('[app bootstrap] hook patch skipped:', e.message);
}

module.exports = require('./_app_body.js');
