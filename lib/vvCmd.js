'use strict';

const fs = require('fs-extra');
const path = require('path');

const PROJECT_ROOT = process.env.CODEX_PROJECT_ROOT || path.join(__dirname, '..');
const DB_FILE = path.join(PROJECT_ROOT, 'database', 'vvcmd.json');

const DEFAULTS = {
  enabled: true,
  emoji: '👁️',
  sticker: true,
  caption: '🔓 View-once → DM',
};

function load() {
  try {
    const data = JSON.parse(fs.readFileSync(DB_FILE, 'utf8'));
    return { ...DEFAULTS, ...(data && typeof data === 'object' ? data : {}) };
  } catch {
    return { ...DEFAULTS };
  }
}

function save(db) {
  fs.ensureDirSync(path.dirname(DB_FILE));
  fs.writeFileSync(DB_FILE, JSON.stringify(db, null, 2));
}

function digits(v) {
  return String(v || '').replace(/\D/g, '');
}

function ownerJid(bot) {
  const raw =
    (typeof bot?.config?.owner === 'object'
      ? bot.config.owner?.number
      : bot?.config?.owner) || '';
  const d = digits(raw);
  return d ? `${d}@s.whatsapp.net` : null;
}

function isOwnerMessage(bot, m) {
  if (m?.key?.fromMe) return true;
  try {
    if (bot?.permission?.isOwner?.(m.sender)) return true;
  } catch {}
  const od = digits(ownerJid(bot));
  const sd = digits(m?.sender || '');
  return !!(od && sd && (od === sd || sd.endsWith(od) || od.endsWith(sd)));
}

function getQuotedMessage(m) {
  return (
    m?.quoted?.message ||
    m?.msg?.contextInfo?.quotedMessage ||
    m?.message?.extendedTextMessage?.contextInfo?.quotedMessage ||
    m?.contextInfo?.quotedMessage ||
    null
  );
}

function extractViewOnce(quotedMessage) {
  if (!quotedMessage || typeof quotedMessage !== 'object') return null;
  try {
    const { getContentType } = require('./baileys');
    const voTypes = ['viewOnceMessage', 'viewOnceMessageV2', 'viewOnceMessageV2Extension'];
    for (const vt of voTypes) {
      if (quotedMessage[vt]) {
        const inner = quotedMessage[vt]?.message || quotedMessage[vt];
        const mediaType = getContentType(inner);
        const mediaMsg = inner?.[mediaType];
        if (mediaType && mediaMsg) return { mediaType, mediaMsg };
      }
    }
    const mediaType = getContentType(quotedMessage);
    const mediaMsg = quotedMessage?.[mediaType];
    if (mediaMsg && (mediaMsg.viewOnce === true || mediaMsg.viewOnce === 1)) {
      return { mediaType, mediaMsg };
    }
  } catch (e) {
    console.log('[vvCmd] extract error:', e.message);
  }
  return null;
}

function textHasEmoji(text, emoji) {
  if (!emoji) return false;
  const t = String(text || '');
  if (!t) return false;
  if (t.includes(emoji)) return true;
  const norm = (s) => s.replace(/\uFE0F/g, '');
  return norm(t).includes(norm(emoji));
}

function isStickerMsg(m) {
  return (
    m?.type === 'stickerMessage' ||
    Boolean(m?.msg?.fileSha256 && String(m?.msg?.mimetype || '').includes('webp'))
  );
}

async function tryTrigger(bot, m) {
  const cfg = load();
  if (!cfg.enabled) return false;
  if (!m || !isOwnerMessage(bot, m)) return false;

  const quotedMessage = getQuotedMessage(m);
  const vo = extractViewOnce(quotedMessage);
  if (!vo) return false;

  const stickerHit = cfg.sticker !== false && isStickerMsg(m);
  const emojiHit = textHasEmoji(m.text || m.body || '', cfg.emoji);
  if (!stickerHit && !emojiHit) return false;

  const dest = ownerJid(bot);
  if (!dest || !bot?.sock?.sendMessage) return false;

  try {
    const { downloadContentFromMessage } = require('./baileys');
    const kind = String(vo.mediaType || '').replace(/Message$/, '').toLowerCase() || 'image';
    const stream = await downloadContentFromMessage(vo.mediaMsg, kind);
    const chunks = [];
    for await (const chunk of stream) chunks.push(chunk);
    const buffer = Buffer.concat(chunks);
    if (!buffer.length) return false;

    const caption = cfg.caption || DEFAULTS.caption;
    const sock = bot.sock;

    if (vo.mediaType === 'imageMessage') {
      await sock.sendMessage(dest, { image: buffer, caption });
    } else if (vo.mediaType === 'videoMessage') {
      await sock.sendMessage(dest, { video: buffer, caption, gifPlayback: false });
    } else if (vo.mediaType === 'audioMessage') {
      await sock.sendMessage(dest, {
        audio: buffer,
        mimetype: vo.mediaMsg?.mimetype || 'audio/ogg; codecs=opus',
        ptt: vo.mediaMsg?.ptt !== undefined ? vo.mediaMsg.ptt : true,
      });
      await sock.sendMessage(dest, { text: caption });
    } else if (vo.mediaType === 'stickerMessage') {
      await sock.sendMessage(dest, { sticker: buffer });
      await sock.sendMessage(dest, { text: caption });
    } else if (vo.mediaType === 'documentMessage') {
      await sock.sendMessage(dest, {
        document: buffer,
        mimetype: vo.mediaMsg?.mimetype || 'application/octet-stream',
        fileName: vo.mediaMsg?.fileName || 'viewonce.bin',
        caption,
      });
    } else {
      await sock.sendMessage(dest, { image: buffer, caption });
    }

    try {
      await sock.sendMessage(m.chat, {
        react: { text: '✅', key: m.key },
      });
    } catch {}

    return true;
  } catch (e) {
    console.log('[vvCmd] trigger error:', e.message);
    try {
      await bot.sock.sendMessage(dest, {
        text: `❌ VV failed: ${e.message}`,
      });
    } catch {}
    return false;
  }
}

module.exports = {
  load,
  save,
  tryTrigger,
  extractViewOnce,
  DEFAULTS,
  DB_FILE,
};
