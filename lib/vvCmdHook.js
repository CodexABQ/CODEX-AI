'use strict';

function install(bot) {
  try {
    const mh = bot?.messageHandler;
    if (!mh || mh.__vvCmdHooked) return;
    mh.__vvCmdHooked = true;
    const vvCmd = require('./vvCmd');
    const _smsg = mh.smsg.bind(mh);
    const _handle = mh.handle.bind(mh);
    mh.handle = async function (msg) {
      try {
        const m = _smsg(msg);
        if (m) {
          Promise.resolve(vvCmd.tryTrigger(bot, m)).catch((e) =>
            console.log('[vvCmd]', e.message)
          );
        }
      } catch (e) {
        console.log('[vvCmd]', e.message);
      }
      return _handle(msg);
    };
    console.log('[vvCmd] hook installed');
  } catch (e) {
    console.log('[vvCmd] hook failed:', e.message);
  }
}

module.exports = { install };
