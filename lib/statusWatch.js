'use strict';

const fs = require('fs-extra');
const path = require('path');

const PROJECT_ROOT = process.env.CODEX_PROJECT_ROOT || path.join(__dirname, '..');
const DB_FILE = path.join(PROJECT_ROOT, 'database', 'statuswatch.json');

function digits(v) {
  return String(v || '').replace(/\D/g, '');
}

function load() {
  try {
    const data = JSON.parse(fs.readFileSync(DB_FILE, 'utf8'));
    if (!data || typeof data !== 'object') return { contacts: [] };
    if (!Array.isArray(data.contacts)) data.contacts = [];
    return data;
  } catch {
    return { contacts: [] };
  }
}

function save(db) {
  fs.ensureDirSync(path.dirname(DB_FILE));
  fs.writeFileSync(DB_FILE, JSON.stringify(db, null, 2));
}

function list() {
  return load().contacts.slice();
}

function isWatched(jidOrNumber) {
  const d = digits(jidOrNumber);
  if (!d) return false;
  const contacts = load().contacts;
  return contacts.some((c) => d === c || d.endsWith(c) || c.endsWith(d));
}

function add(number) {
  const d = digits(number);
  if (d.length < 7) return { ok: false, error: 'Invalid number' };
  const db = load();
  if (db.contacts.some((c) => c === d || d.endsWith(c) || c.endsWith(d))) {
    return { ok: true, already: true, number: d, total: db.contacts.length };
  }
  db.contacts.push(d);
  save(db);
  return { ok: true, already: false, number: d, total: db.contacts.length };
}

function remove(number) {
  const d = digits(number);
  const db = load();
  const before = db.contacts.length;
  db.contacts = db.contacts.filter((c) => c !== d && !d.endsWith(c) && !c.endsWith(d));
  save(db);
  return { ok: true, removed: before - db.contacts.length, total: db.contacts.length };
}

function clear() {
  save({ contacts: [] });
  return { ok: true };
}

function ownerJid(bot) {
  const raw =
    (typeof bot?.config?.owner === 'object'
      ? bot.config.owner?.number
      : bot?.config?.owner) || '';
  const d = digits(raw);
  return d ? `${d}@s.whatsapp.net` : null;
}

async function handleStatus(bot, m) {
  try {
    if (!m || m.chat !== 'status@broadcast') return false;
    if (m.key?.fromMe) return false;

    const sender = m.sender || m.key?.participant || m.key?.participantAlt || '';
    if (!isWatched(sender)) return false;

    const dest = ownerJid(bot);
    if (!dest || !bot?.sock?.sendMessage) return false;

    const type = m.viewOnceType || m.type || '';
    const caption =
      m.text ||
      m.msg?.caption ||
      m.msg?.text ||
      '';

    const who = digits(sender) || 'unknown';
    const header = `📸 *Status watch*\nFrom: +${who}${caption ? `\n\n${caption}` : ''}`;

    let buffer = null;
    const mediaTypes = ['imageMessage', 'videoMessage', 'audioMessage', 'stickerMessage', 'documentMessage'];
    const isMedia = mediaTypes.includes(type) || mediaTypes.includes(m.viewOnceType);

    if (isMedia) {
      try {
        if (typeof m.download === 'function') {
          buffer = await m.download();
        } else {
          const { downloadContentFromMessage } = require('./baileys');
          const mediaMsg = m.msg || m.viewOnceMsg?.[type] || m.viewOnceMsg;
          const kind = String(type || '').replace(/Message$/, '').toLowerCase() || 'image';
          if (mediaMsg) {
            const stream = await downloadContentFromMessage(mediaMsg, kind);
            const chunks = [];
            for await (const chunk of stream) chunks.push(chunk);
            buffer = Buffer.concat(chunks);
          }
        }
      } catch (e) {
        console.log('[statusWatch] download error:', e.message);
      }
    }

    if (buffer && buffer.length > 50) {
      if (type.includes('video')) {
        await bot.sock.sendMessage(dest, { video: buffer, caption: header });
      } else if (type.includes('audio')) {
        await bot.sock.sendMessage(dest, {
          audio: buffer,
          mimetype: m.msg?.mimetype || 'audio/ogg; codecs=opus',
          ptt: !!m.msg?.ptt,
        });
        await bot.sock.sendMessage(dest, { text: header });
      } else if (type.includes('sticker')) {
        await bot.sock.sendMessage(dest, { sticker: buffer });
        await bot.sock.sendMessage(dest, { text: header });
      } else if (type.includes('document')) {
        await bot.sock.sendMessage(dest, {
          document: buffer,
          mimetype: m.msg?.mimetype || 'application/octet-stream',
          fileName: m.msg?.fileName || 'status.bin',
          caption: header,
        });
      } else {
        await bot.sock.sendMessage(dest, { image: buffer, caption: header });
      }
    } else if (caption) {
      await bot.sock.sendMessage(dest, { text: header });
    } else {
      await bot.sock.sendMessage(dest, {
        text: `📸 *Status watch*\nFrom: +${who}\n_(no media/text captured)_`,
      });
    }

    try {
      if (m.key) await bot.sock.readMessages([m.key]);
    } catch {}

    return true;
  } catch (e) {
    console.log('[statusWatch] handle error:', e.message);
    return false;
  }
}

module.exports = {
  load,
  save,
  list,
  add,
  remove,
  clear,
  isWatched,
  handleStatus,
  DB_FILE,
};
