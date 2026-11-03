/**
 * Marketplace core for CODEX-AI
 * JSON storage + media helpers (local disk) + WhatsApp album support
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
const ALBUM_CHILD_DELAY = [1200, 2000];
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

const albumCache = new Map();
const ALBUM_CACHE_MAX = 300;

const silentLogger = {
  level: 'silent',
  info() {}, debug() {}, warn() {}, error() {}, trace() {}, fatal() {},
  child() { return silentLogger; },
};

function unwrapContent(content) {
  if (!content) return {};
  return (
    content.ephemeralMessage?.message ||
    content.viewOnceMessage?.message ||
    content.viewOnceMessageV2?.message ||
    content.documentWithCaptionMessage?.message ||
    content
  );
}

function trackAlbumChild(msg) {
  try {
    const content = msg?.message;
    if (!content) return;
    const inner = unwrapContent(content);
    if (!(inner.imageMessage || inner.videoMessage)) return;
    const assoc =
      content.messageContextInfo?.messageAssociation ||
      inner.messageContextInfo?.messageAssociation;
    const parentId = assoc?.parentMessageKey?.id;
    if (!parentId) return;
    const list = albumCache.get(parentId) || [];
    if (list.some((x) => x.key?.id === msg.key?.id)) return;
    list.push(msg);
    albumCache.set(parentId, list);
    if (albumCache.size > ALBUM_CACHE_MAX) {
      albumCache.delete(albumCache.keys().next().value);
    }
  } catch (e) {
    console.log('marketplace album track error:', e.message);
  }
}

function ensureAlbumListener(sock) {
  try {
    if (!sock || !sock.ev || sock.__mpAlbumListener) return;
    sock.__mpAlbumListener = true;
    sock.ev.on('messages.upsert', ({ messages }) => {
      for (const msg of messages || []) trackAlbumChild(msg);
    });
    console.log('marketplace: album listener attached');
  } catch (e) {
    console.log('marketplace album listener error:', e.message);
  }
}

function quotedIds(m) {
  return [
    m.quoted?.id,
    m.quoted?.key?.id,
    m.quoted?.stanzaId,
    m.msg?.contextInfo?.stanzaId,
    m.message?.extendedTextMessage?.contextInfo?.stanzaId,
  ].filter(Boolean);
}

async function downloadAlbumChildren(sock, parentIds) {
  const { dlBuffer } = require('./dlmedia');
  let baileys = null;
  try { baileys = require('./baileys'); } catch {}
  for (const pid of parentIds) {
    const children = albumCache.get(pid);
    if (!children || !children.length) continue;
    const files = [];
    for (const msg of children) {
      try {
        let buffer = null;
        const inner = unwrapContent(msg.message);
        const kind = inner.videoMessage ? 'video' : 'image';
        const mime = (inner.videoMessage || inner.imageMessage)?.mimetype;
        if (baileys && typeof baileys.downloadMediaMessage === 'function') {
          try {
            buffer = await baileys.downloadMediaMessage(
              msg, 'buffer', {},
              { logger: silentLogger, reuploadRequest: sock?.updateMediaMessage?.bind(sock) }
            );
          } catch {}
        }
        if ((!buffer || buffer.length < 100) && (inner.imageMessage || inner.videoMessage)) {
          try { buffer = await dlBuffer(msg, kind); } catch (e) {
            console.log('marketplace album dlBuffer error:', e.message);
          }
        }
        if (buffer && buffer.length > 100) {
          const ext = extFromMime(mime, kind);
          files.push({ buffer, ext, kind, mimetype: MIME_BY_EXT[ext] });
        }
      } catch (e) {
        console.log('marketplace album download error:', e.message);
      }
    }
    if (files.length) return files;
  }
  return [];
}

function readJson(file, fallback) {
  let raw;
  try { raw = fs.readFileSync(file, 'utf8'); } catch { return fallback; }
  try { return JSON.parse(raw); } catch (e) {
    try { fs.copyFileSync(file, `${file}.corrupt-${Date.now()}`); } catch {}
    console.log(`marketplace: ${path.basename(file)} unreadable (${e.message}); backup saved`);
    return fallback;
  }
}
function writeJson(file, data) {
  fs.ensureDirSync(path.dirname(file));
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2));
  fs.renameSync(tmp, file);
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

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }
function randomBetween([min, max]) { return Math.floor(min + Math.random() * (max - min)); }
function generateId(type) {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let id = '';
  for (let i = 0; i < 4; i++) id += chars[Math.floor(Math.random() * chars.length)];
  return (type === 'request' ? 'R' : 'S') + id;
}
function cleanNumber(num) { return num ? String(num).replace(/\D/g, '') : ''; }
function cleanId(text) { return String(text || '').trim().replace(/^#/, '').toUpperCase(); }

async function loadListings() {
  const data = readJson(DATA_FILE, {});
  return data && typeof data === 'object' ? data : {};
}
async function saveListings(listings) { writeJson(DATA_FILE, listings); }
async function loadGroups() {
  const data = readJson(GROUPS_FILE, []);
  return Array.isArray(data) ? data : [];
}
async function saveGroups(groups) { writeJson(GROUPS_FILE, groups); }
async function loadMsgMap() {
  const data = readJson(MSGMAP_FILE, {});
  return data && typeof data === 'object' ? data : {};
}
async function saveMsgMap(map) { writeJson(MSGMAP_FILE, map); }

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
  } catch (e) { console.log('marketplace markItemPosted error:', e.message); }
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
  } catch (e) { console.log('marketplace msgmap error:', e.message); }
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

async function downloadMedia(sock, m) {
  const { dlBuffer } = require('./dlmedia');
  const files = [];
  if (sock) ensureAlbumListener(sock);
  const tryOne = async (msgNode, kind) => {
    try {
      const buffer = await dlBuffer(msgNode, kind);
      if (buffer && buffer.length > 100) {
        const node =
          msgNode?.message?.[`${kind}Message`] ||
          msgNode?.[`${kind}Message`] ||
          msgNode?.message?.viewOnceMessage?.message?.[`${kind}Message`] ||
          msgNode?.message?.ephemeralMessage?.message?.[`${kind}Message`];
        const mime = node?.mimetype;
        const ext = extFromMime(mime, kind);
        files.push({ buffer, ext, kind, mimetype: MIME_BY_EXT[ext] });
      }
    } catch (e) { console.log('marketplace media download error:', e.message); }
  };
  if (m.quoted) {
    const q = m.quoted;
    const qMsg = q.message || q;
    const hasSingle = q.image || q.video || qMsg?.imageMessage || qMsg?.videoMessage;
    if (!hasSingle) {
      files.push(...(await downloadAlbumChildren(sock, quotedIds(m))));
    } else if (q.image || qMsg?.imageMessage) await tryOne(q, 'image');
    else if (q.video || qMsg?.videoMessage) await tryOne(q, 'video');
  }
  if (m.key && m.message) trackAlbumChild(m);
  if (m.image || m.message?.imageMessage) await tryOne(m, 'image');
  else if (m.video || m.message?.videoMessage) await tryOne(m, 'video');
  return files.slice(0, MAX_MEDIA_PER_POST);
}

function hasMediaInput(m) {
  if (m.image || m.video || m.message?.imageMessage || m.message?.videoMessage) return true;
  const q = m.quoted;
  if (!q) return false;
  const qMsg = q.message || q;
  if (q.image || q.video || qMsg?.imageMessage || qMsg?.videoMessage) return true;
  if (qMsg?.albumMessage || q.albumMessage) return true;
  for (const id of quotedIds(m)) {
    const kids = albumCache.get(id);
    if (kids && kids.length) return true;
  }
  return false;
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
    fs.writeFileSync(path.join(dir, filename), f.buffer);
    saved.push({ path: path.join(dir, filename), filename, mimetype: f.mimetype, ext: f.ext, kind: f.kind, url: null, publicId: null });
  }
  return saved;
}

function attachMediaEntries(item, saved) {
  if (!Array.isArray(item.media)) item.media = [];
  for (const s of saved) {
    item.media.push({ filename: s.filename, kind: s.kind, mimetype: s.mimetype, url: s.url || null, publicId: s.publicId || null });
  }
  return 0;
}

function getMediaList(id) {
  const dir = path.join(MEDIA_DIR, id);
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir).filter((f) => !f.startsWith('.')).sort()
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
          if (fs.existsSync(localPath)) { try { buffer = fs.readFileSync(localPath); } catch {} }
        }
        if (buffer && buffer.length > 100) result.push({ buffer, kind: entry.kind, mimetype: entry.mimetype });
      } catch (e) { console.log('marketplace media resolve error:', e.message); }
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
        result.push({ buffer, kind, mimetype: MIME_BY_EXT[path.extname(f.filename).toLowerCase()] });
      }
    } catch (e) { console.log('marketplace media read error:', e.message); }
  }
  return result;
}

function getLatestProduct(listings) {
  return Object.values(listings)
    .filter((i) => i.status === 'active' && i.type === 'sell')
    .sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0))[0] || null;
}
function buildPostCaption(item) { return item.caption || ''; }
function mediaContent(file, caption) {
  const content = file.kind === 'video'
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
  try {
    const album = files.map((f, i) => {
      const item = f.kind === 'video'
        ? { video: f.buffer, mimetype: f.mimetype }
        : { image: f.buffer, mimetype: f.mimetype };
      if (i === 0 && caption) item.caption = caption;
      return item;
    });
    ensureAlbumListener(sock);
    const r = await sock.sendMessage(jid, { album }, { delayMs: randomBetween(ALBUM_CHILD_DELAY) });
    const id = r?.key?.id;
    if (id) {
      const kids = (albumCache.get(id) || []).map((m) => m.key?.id).filter(Boolean);
      return [id, ...kids];
    }
  } catch (e) {
    console.log('marketplace native album failed, sequential fallback:', e.message);
  }
  const ids = [];
  for (let i = 0; i < files.length; i++) {
    const r = await sock.sendMessage(jid, mediaContent(files[i], i === 0 ? caption : ''));
    ids.push(r?.key?.id);
    if (i < files.length - 1) await sleep(randomBetween(MEDIA_DELAY));
  }
  return ids;
}

function extractIdFromText(text) {
  const t = String(text || '').trim();
  if (!t) return null;
  if (/^[SR][A-HJ-NP-Z2-9]{4}$/i.test(t)) return t.toUpperCase();
  let m = t.match(/#([SR][A-HJ-NP-Z2-9]{4})\b/i);
  if (m) return m[1].toUpperCase();
  m = t.match(/\bID[:\s*]*([SR][A-HJ-NP-Z2-9]{4})\b/i);
  if (m) return m[1].toUpperCase();
  m = t.match(/\b([SR][A-HJ-NP-Z2-9]{4})\b/);
  if (m) return m[1].toUpperCase();
  return null;
}

function quotedText(m) {
  const q = m.quoted;
  if (!q) return '';
  return [
    q.text, q.caption, q.body,
    q.message?.conversation,
    q.message?.extendedTextMessage?.text,
    q.message?.imageMessage?.caption,
    q.message?.videoMessage?.caption,
    q.msg?.conversation,
    q.msg?.extendedTextMessage?.text,
    q.msg?.imageMessage?.caption,
    q.msg?.videoMessage?.caption,
  ].filter(Boolean).join('\n');
}

async function findIdFromReply(m) {
  if (!m.quoted) return null;
  const qids = [
    m.quoted.id,
    m.quoted.key?.id,
    m.quoted.stanzaId,
    m.msg?.contextInfo?.stanzaId,
    m.message?.extendedTextMessage?.contextInfo?.stanzaId,
  ].filter(Boolean);
  if (qids.length) {
    const map = await loadMsgMap();
    for (const q of qids) {
      if (map[q]) return map[q];
    }
  }
  return extractIdFromText(quotedText(m));
}

function normalizeJid(piece) {
  const s = String(piece || '').trim();
  if (!s) return null;
  if (s.endsWith('@g.us')) return s;
  if (/^\d{8,}$/.test(s)) return s + '@g.us';
  return null;
}

function extractJids(text) {
  const out = [];
  for (const piece of String(text || '').split(/[\s,]+/)) {
    const jid = normalizeJid(piece);
    if (jid) out.push(jid);
  }
  return [...new Set(out)];
}

async function resolveGroupPieces(sock, pieces) {
  const resolved = [];
  for (const piece of pieces) {
    const jid = normalizeJid(piece);
    if (jid) { resolved.push(jid); continue; }
    const linkMatch = String(piece || '').match(/chat\.whatsapp\.com\/([A-Za-z0-9]+)/i);
    if (linkMatch && sock?.groupGetInviteInfo) {
      try {
        const info = await sock.groupGetInviteInfo(linkMatch[1]);
        const id = info?.id || info?.jid;
        if (id) resolved.push(id);
      } catch (e) { console.log('marketplace invite resolve error:', e.message); }
    }
  }
  return [...new Set(resolved)];
}

async function extractTargetClause(sock, text) {
  const raw = text || '';
  const exceptMatch = raw.match(/\bexcept\s+(.+)$/i);
  if (exceptMatch) {
    const pieces = exceptMatch[1].trim().split(/[\s,]+/).map((s) => s.trim()).filter(Boolean);
    const except = await resolveGroupPieces(sock, pieces);
    return {
      text: raw.slice(0, exceptMatch.index).trim(),
      groups: null,
      except: except.length ? except : null,
    };
  }
  const match = raw.match(/\bto\s+(.+)$/i);
  if (!match) return { text: raw, groups: null, except: null };
  const pieces = match[1].trim().split(/[\s,]+/).map((s) => s.trim()).filter(Boolean);
  const resolved = await resolveGroupPieces(sock, pieces);
  if (!resolved.length) return { text: raw, groups: null, except: null };
  return { text: raw.slice(0, match.index).trim(), groups: resolved, except: null };
}

async function groupNames(sock, force = false) {
  try {
    if (!sock?.groupFetchAllParticipating) return {};
    const all = await sock.groupFetchAllParticipating();
    const map = {};
    for (const [jid, meta] of Object.entries(all || {})) {
      map[jid] = meta?.subject || jid;
    }
    return map;
  } catch (e) {
    console.log('marketplace groupNames error:', e.message);
    return {};
  }
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

const NO_ALBUM_HINT =
  '_No photo/video found to save._\n' +
  '_If you replied to an album: the bot only sees albums that arrived *after* it started, and after a marketplace command was run once (try *.mp*, then resend the album). Or reply to a single photo._';

module.exports = {
  MEDIA_DIR, MAX_ITEMS_PER_RUN, MAX_MEDIA_PER_POST, MEDIA_DELAY, GROUP_DELAY, ITEM_DELAY,
  MAX_CONSECUTIVE_FAILS, REQUEST_REPEAT_COUNT, REQUEST_REPEAT_DELAY, INACTIVE_DAYS, NO_ALBUM_HINT,
  sleep, randomBetween, generateId, cleanNumber, cleanId,
  loadListings, saveListings, loadGroups, saveGroups, mutateListings, mutateGroups,
  markItemPosted, recordSent, downloadMedia, hasMediaInput, ensureAlbumListener,
  saveMediaFiles, attachMediaEntries, resolveItemMedia, getLatestProduct, buildPostCaption,
  sendPost, findIdFromReply, extractJids, extractTargetClause, groupNames, cleanupInactive,
};
