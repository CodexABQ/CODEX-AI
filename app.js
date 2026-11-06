'use strict';
/**
 * Bootstrap: ensure full app body, patch private-mode (fromMe), install hooks.
 */
const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

const ROOT = __dirname;
const BODY = path.join(ROOT, '_app_body.js');
const MH = path.join(ROOT, 'lib', 'messageHandler.js');
const SOURCE =
  'https://raw.githubusercontent.com/CodexABQ/CODEX-AI/c60fde54cc7623bff996e7e4afcccd581225cf6f/app.js';

function ensureBody() {
  if (fs.existsSync(BODY) && fs.statSync(BODY).size > 10000) return;
  execSync('curl -fsSL "' + SOURCE + '" -o "' + BODY + '"', {
    stdio: 'inherit',
    timeout: 90000,
  });
}

function patchPrivateModeFromMe() {
  try {
    if (!fs.existsSync(MH)) return;
    let text = fs.readFileSync(MH, 'utf8');
    if (text.includes('fromMe must be allowed')) return;
    const old = `      if (_mode === "private") {\n        const allowed =\n          isOwner ||\n          this.bot.permission.isSudo(sender, m._participantRaw) ||\n          this.bot.permission.isMod(sender, m._participantRaw);\n        if (!allowed) {`;
    const neu = `      if (_mode === "private") {\n        // fromMe must be allowed: self-chat / linked-device messages often\n        // fail isOwner (LID vs phone JID) even though they are the owner.\n        const allowed =\n          isOwner ||\n          m.key?.fromMe ||\n          this.bot.permission.isSudo(sender, m._participantRaw) ||\n          this.bot.permission.isMod(sender, m._participantRaw);\n        if (!allowed) {`;
    if (text.includes(old)) {
      text = text.replace(old, neu);
      fs.writeFileSync(MH, text);
      console.log('[bootstrap] private-mode fromMe patch applied');
    }
  } catch (e) {
    console.log('[bootstrap] private-mode patch skipped:', e.message);
  }
}

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
  } else if (
    text.includes("statusWatchHook').install") &&
    !text.includes("vvCmdHook').install")
  ) {
    text = text.replace(
      "try { require('./lib/statusWatchHook').install(this); } catch (e) { console.log('[statusWatch] hook:', e.message); }",
      "try { require('./lib/statusWatchHook').install(this); } catch (e) { console.log('[statusWatch] hook:', e.message); }\n    try { require('./lib/vvCmdHook').install(this); } catch (e) { console.log('[vvCmd] hook:', e.message); }"
    );
    dirty = true;
  }

  if (dirty) fs.writeFileSync(BODY, text);
}

ensureBody();
try { patchPrivateModeFromMe(); } catch (e) { console.log('[bootstrap]', e.message); }
try { patchHooks(); } catch (e) { console.log('[bootstrap] hooks:', e.message); }

module.exports = require('./_app_body.js');
