'use strict';
/**
 * Wraps MessageHandler.handle so status@broadcast from watched contacts
 * is forwarded to the owner DM. Safe to call once after MessageHandler is created.
 */
function install(bot) {
  try {
    const mh = bot?.messageHandler;
    if (!mh || mh.__statusWatchHooked) return;
    mh.__statusWatchHooked = true;
    const statusWatch = require('./statusWatch');
    const _smsg = mh.smsg.bind(mh);
    const _handle = mh.handle.bind(mh);
    mh.handle = async function (msg) {
      const result = await _handle(msg);
      try {
        const jid = msg?.key?.remoteJid || msg?.key?.remoteJidAlt || '';
        if (jid === 'status@broadcast') {
          const m = _smsg(msg);
          if (m) await statusWatch.handleStatus(bot, m);
        }
      } catch (e) {
        console.log('[statusWatch]', e.message);
      }
      return result;
    };
    console.log('[statusWatch] hook installed');
  } catch (e) {
    console.log('[statusWatch] hook failed:', e.message);
  }
}
module.exports = { install };
