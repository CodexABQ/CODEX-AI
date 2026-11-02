/**
 * Marketplace core for CODEX-AI
 * JSON storage + media helpers (local disk)
 */
'use strict';

const fs = require('fs-extra');
const path = require('path');

const PROJECT_ROOT = process.env.CODEX_PROJECT_ROOT || path.join(__dirname, '..');
const DB_DIR = path.join(PROJECT_ROOT, 'database');
const MEDIA_DIR = path.join(PROJECT_ROOT, 'media', 'marketplace');

const DATA_FILE = path.join(DB_DIR, 'marketplace_listings.json');
const GROUPS_FILE = path.join(DB_DIR, 'marketplace_groups.json');
const MSGMAP_FILE = path.join(DB_DIR, 'marketplace_msgmap.json');

const MSGMAP_MAX = 3000;
const INACTIVE_DAYS = 3;
const CLEANUP_INTERVAL_MS = 60 * 60 * 1000;

const MAX_ITEMS_PER_RUN = 40;
const MAX_MEDIA_PER_POST = 10;
const MEDIA_DELAY = [2500, 4500];
const GROUP_DELAY = [8000, 15000];
const ITEM_DELAY = [15000, 30000];
const MAX_CONSECUTIVE_FAILS = 3;
const REQUEST_REPEAT_COUNT = 3;
const REQUEST_REPEAT_DELAY = [1500, 3000];

const IMAGE_EXTS = ['.jpg', '.jpeg', '.png', '.webp'];
const MIME_BY_EXT = {
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.png': 'image/png',
  '.webp': 'image/webp',
  '.mp4': 'video/mp4',
};

fs.ensureDirSync(MEDIA_DIR);
fs.ensureDirSync(DB_DIR);

function readJson(file, fallback) {
  try {
    const raw = fs.readFileSync(file, 'utf8');
    return JSON.parse(raw);
  } catch {
    return fallback;
  }
}

function writeJson(file, data) {
  fs.ensureDirSync(path.dirname(file));
  fs.writeFileSync(file, JSON.stringify(data, null, 2));
}

function createLock() {
  let chain = Promise.resolve();
  return (fn) => {
    const run = chain.then(() => fn());
    chain = run.catch(() => {});
    return run;
  };
}

const listingsLock = createLock();
const groupsLock = createLock();
const msgMapLock = createLock();

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function randomBetween([min, max]) {
  return Math.floor(min + Math.random() * (max - min));
}

function generateId(type) {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let id = '';
  for (let i = 0; i < 4; i++) id += chars[Math.floor(Math.random() * chars.length)];
  return (type === 'request' ? 'R' : 'S') + id;
}

function cleanNumber(num) {
  if (!num) return '';
  return String(num).replace(/\D/g, '');
}

function cleanId(text) {
  return String(text || '').trim().replace(/^#/, '').toUpperCase();
}

async function loadListings() {
  const data = readJson(DATA_FILE, {});
  return data && typeof data === 'object' ? data : {};
}

async function saveListings(listings) {
  writeJson(DATA_FILE, listings);
}

async function loadGroups() {
  const data = readJson(GROUPS_FILE, []);
  return Array.isArray(data) ? data : [];
}

async function saveGroups(groups) {
  writeJson(GROUPS_FILE, groups);
}

async function loadMsgMap() {
  const data = readJson(MSGMAP_FILE, {});
  return data && typeof data === 'object' ? data : {};
}

async function saveMsgMap(map) {
  writeJson(MSGMAP_FILE, map);
}

function mutateListings(mutator) {
  return listingsLock(async () => {
    const listings = await loadListings();
    const result = await mutator(listings);
    if (!(result && result.skipSave)) await saveListings(listings);
    return result;
  });
}

function mutateGroups(mutator) {
  return groupsLock(async () => {
    const groups = await loadGroups();
    const result = await mutator(groups);
    if (!(result && result.skipSave)) await saveGroups(groups);
    return result;
  });
}

function mutateMsgMap(mutator) {
  return msgMapLock(async () => {
    const map = await loadMsgMap();
    await mutator(map);
    await saveMsgMap(map);
  });
}

async function markItemPosted(itemId) {
  try {
    await mutateListings(async (listings) => {
      if (!listings[itemId]) return { skipSave: true };
      listings[itemId].lastPostedAt = Date.now();
      return { ok: true };
    });
  } catch (e) {
    console.log('marketplace markItemPosted error:', e.message);
  }
}

async function recordSent(itemId, ids) {
  ids = (ids || []).filter(Boolean);
  if (!ids.length) return;
  try {
    await mutateMsgMap(async (map) => {
      for (const id of ids) map[id] = itemId;
      const keys = Object.keys(map);
      if (keys.length > MSGMAP_MAX) {
        for (const k of keys.slice(0, keys.length - MSGMAP_MAX)) delete map[k];
      }
    });
  } catch (e) {
    console.log('marketplace msgmap error:', e.message);
  }
}

function extFromMime(mime, kind) {
  if (kind === 'video') return '.mp4';
  const mt = String(mime || '').toLowerCase();
  if (mt.includes('png')) return '.png';
  if (mt.includes('webp')) return '.webp';
  return '.jpg';
}

function getFileKind(filename) {
  const ext = path.extname(filename).toLowerCase();
  if (ext === '.mp4') return 'video';
  if (IMAGE_EXTS.includes(ext)) return 'image';
  return null;
}

async function downloadMedia(bot, m) {
  const { dlBuffer } = require('./dlmedia');
  const files = [];

  const tryOne = async (msgNode, kind) => {
    try {
      const buffer = await dlBuffer(msgNode, kind);
      if (buffer && buffer.length > 100) {
        const node = msgNode?.message?.[`${kind}Message`] ||
          msgNode?.[`${kind}Message`] ||
          msgNode?.message?.viewOnceMessage?.message?.[`${kind}Message`] ||
          msgNode?.message?.ephemeralMessage?.message?.[`${kind}Message`];
        const mime = node?.mimetype;
        const ext = extFromMime(mime, kind);
        files.push({ buffer, ext, kind, mimetype: MIME_BY_EXT[ext] });
      }
    } catch (e) {
      console.log('marketplace media download error:', e.message);
    }
  };

  const q = m.quoted;
  if (q) {
    const qMsg = q.message || q;
    if (q.image || qMsg?.imageMessage) await tryOne(q, 'image');
    else if (q.video || qMsg?.videoMessage) await tryOne(q, 'video');
  }

  if (m.image || m.message?.imageMessage) await tryOne(m, 'image');
  else if (m.video || m.message?.videoMessage) await tryOne(m, 'video');

  return files;
}

function hasMediaInput(m) {
  if (m.image || m.video || m.message?.imageMessage || m.message?.videoMessage) return true;
  const q = m.quoted;
  if (!q) return false;
  const qMsg = q.message || q;
  return !!(q.image || q.video || qMsg?.imageMessage || qMsg?.videoMessage);
}

async function saveMediaFiles(id, mediaFiles) {
  const dir = path.join(MEDIA_DIR, id);
  fs.ensureDirSync(dir);
  const saved = [];
  const existing = fs.readdirSync(dir).filter((f) => !f.startsWith('.')).length;

  for (let i = 0; i < mediaFiles.length; i++) {
    const f = mediaFiles[i];
    if (!f.buffer || f.buffer.length < 100) continue;
    const filename = `${Date.now()}_${existing + i + 1}${f.ext}`;
    const filepath = path.join(dir, filename);
    fs.writeFileSync(filepath, f.buffer);
    saved.push({
      path: filepath,
      filename,
      mimetype: f.mimetype,
      ext: f.ext,
      kind: f.kind,
      url: null,
      publicId: null,
    });
  }
  return saved;
}

function attachMediaEntries(item, saved) {
  if (!Array.isArray(item.media)) item.media = [];
  for (const s of saved) {
    item.media.push({
      filename: s.filename,
      kind: s.kind,
      mimetype: s.mimetype,
      url: s.url || null,
      publicId: s.publicId || null,
    });
  }
  return 0;
}

function getMediaList(id) {
  const dir = path.join(MEDIA_DIR, id);
  if (!fs.existsSync(dir)) return [];
  return fs
    .readdirSync(dir)
    .filter((f) => !f.startsWith('.'))
    .sort()
    .map((f) => ({ path: path.join(dir, f), filename: f }));
}

async function resolveItemMedia(item) {
  const result = [];
  const id = item.id;

  if (Array.isArray(item.media) && item.media.length) {
    for (const entry of item.media) {
      if (result.length >= MAX_MEDIA_PER_POST) break;
      try {
        let buffer = null;
        if (entry.filename) {
          const localPath = path.join(MEDIA_DIR, id, entry.filename);
          if (fs.existsSync(localPath)) {
            try {
              buffer = fs.readFileSync(localPath);
            } catch {}
          }
        }
        if (buffer && buffer.length > 100) {
          result.push({ buffer, kind: entry.kind, mimetype: entry.mimetype });
        }
      } catch (e) {
        console.log('marketplace media resolve error:', e.message);
      }
    }
    if (result.length) return result;
  }

  for (const f of getMediaList(id)) {
    if (result.length >= MAX_MEDIA_PER_POST) break;
    const kind = getFileKind(f.filename);
    if (!kind) continue;
    try {
      const buffer = fs.readFileSync(f.path);
      if (buffer && buffer.length > 100) {
        result.push({
          buffer,
          kind,
          mimetype: MIME_BY_EXT[path.extname(f.filename).toLowerCase()],
        });
      }
    } catch (e) {
      console.log('marketplace media read error:', e.message);
    }
  }
  return result;
}

function getLatestProduct(listings) {
  const active = Object.values(listings)
    .filter((i) => i.status === 'active' && i.type === 'sell')
    .sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));
  return active[0] || null;
}

function buildPostCaption(item) {
  return item.caption || '';
}

function mediaContent(file, caption) {
  const content =
    file.kind === 'video'
      ? { video: file.buffer, mimetype: file.mimetype }
      : { image: file.buffer, mimetype: file.mimetype };
  if (caption) content.caption = caption;
  return content;
}

async function sendPost(sock, jid, files, caption) {
  if (!files.length) {
    const r = await sock.sendMessage(jid, { text: caption });
    return [r?.key?.id];
  }

  if (files.length === 1) {
    const r = await sock.sendMessage(jid, mediaContent(files[0], caption));
    return [r?.key?.id];
  }

  const ids = [];
  for (let i = 0; i < files.length; i++) {
    const r = await sock.sendMessage(jid, mediaContent(files[i], i === 0 ? caption : ''));
    ids.push(r?.key?.id);
    if (i < files.length - 1) await sleep(randomBetween(MEDIA_DELAY));
  }
  return ids;
}

async function findIdFromReply(m) {
  if (!m.quoted) return null;
  const qids = [m.quoted.id, m.quoted.key?.id, m.quoted.stanzaId].filter(Boolean);
  if (qids.length) {
    const map = await loadMsgMap();
    for (const q of qids) {
      if (map[q]) return map[q];
    }
  }
  const qText = (m.quoted.text || m.quoted.caption || m.quoted.body || '').trim();
  if (/^[SR][A-HJ-NP-Z2-9]{4}$/i.test(qText)) return qText.toUpperCase();
  const matches = [...qText.matchAll(/#([SR][A-HJ-NP-Z2-9]{4})\b/gi)];
  if (matches.length) return matches[matches.length - 1][1].toUpperCase();
  return null;
}

function extractJids(text) {
  return (text || '')
    .split(/[\s,]+/)
    .map((s) => s.trim())
    .filter(Boolean)
    .filter((s) => s.endsWith('@g.us'));
}

async function extractTargetClause(sock, text) {
  const raw = text || '';
  const match = raw.match(/\bto\s+(.+)$/i);
  if (!match) return { text: raw, groups: null };

  const pieces = match[1]
    .trim()
    .split(/[\s,]+/)
    .map((s) => s.trim())
    .filter(Boolean);
  const resolved = [];

  for (const piece of pieces) {
    if (piece.endsWith('@g.us')) {
      resolved.push(piece);
      continue;
    }
    const linkMatch = piece.match(/chat\.whatsapp\.com\/([A-Za-z0-9]+)/i);
    if (linkMatch && sock.groupGetInviteInfo) {
      try {
        const info = await sock.groupGetInviteInfo(linkMatch[1]);
        const jid = info?.id || info?.jid;
        if (jid) resolved.push(jid);
      } catch (e) {
        console.log('marketplace invite resolve error:', e.message);
      }
    }
  }

  if (!resolved.length) return { text: raw, groups: null };
  return { text: raw.slice(0, match.index).trim(), groups: [...new Set(resolved)] };
}

async function cleanupInactive() {
  const res = await mutateListings(async (listings) => {
    const now = Date.now();
    const limit = INACTIVE_DAYS * 24 * 60 * 60 * 1000;
    const deleted = [];
    for (const id of Object.keys(listings)) {
      const item = listings[id];
      if (item.status === 'inactive' && item.inactiveAt && now - item.inactiveAt > limit) {
        const dir = path.join(MEDIA_DIR, id);
        if (fs.existsSync(dir)) fs.rmSync(dir, { recursive: true, force: true });
        delete listings[id];
        deleted.push(id);
      }
    }
    return { skipSave: !deleted.length, deleted };
  });

  if (res.deleted?.length) {
    await mutateMsgMap(async (map) => {
      for (const k of Object.keys(map)) {
        if (res.deleted.includes(map[k])) delete map[k];
      }
    });
  }
}

function startCleanupScheduler() {
  if (global.__mpCleanupTimer) clearInterval(global.__mpCleanupTimer);
  if (global.__mpCleanupBoot) clearTimeout(global.__mpCleanupBoot);
  const run = () => cleanupInactive().catch((e) => console.log('marketplace cleanup error:', e.message));
  global.__mpCleanupBoot = setTimeout(run, 30 * 1000);
  global.__mpCleanupTimer = setInterval(run, CLEANUP_INTERVAL_MS);
  if (global.__mpCleanupBoot.unref) global.__mpCleanupBoot.unref();
  if (global.__mpCleanupTimer.unref) global.__mpCleanupTimer.unref();
}

startCleanupScheduler();

module.exports = {
  MEDIA_DIR,
  MAX_ITEMS_PER_RUN,
  MAX_MEDIA_PER_POST,
  MEDIA_DELAY,
  GROUP_DELAY,
  ITEM_DELAY,
  MAX_CONSECUTIVE_FAILS,
  REQUEST_REPEAT_COUNT,
  REQUEST_REPEAT_DELAY,
  INACTIVE_DAYS,
  sleep,
  randomBetween,
  generateId,
  cleanNumber,
  cleanId,
  loadListings,
  saveListings,
  loadGroups,
  saveGroups,
  mutateListings,
  mutateGroups,
  markItemPosted,
  recordSent,
  downloadMedia,
  hasMediaInput,
  saveMediaFiles,
  attachMediaEntries,
  resolveItemMedia,
  getLatestProduct,
  buildPostCaption,
  sendPost,
  findIdFromReply,
  extractJids,
  extractTargetClause,
  cleanupInactive,
};
