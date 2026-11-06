/**
 * Marketplace core for CODEX-AI
 * JSON storage + media helpers (local disk) + WhatsApp album support
 */
'use strict';

const fs = require('fs-extra');
const path = require('path');
const { downloadContentFromMessage, getContentType } = require('./baileys');

const PROJECT_ROOT = process.env.CODEX_PROJECT_ROOT || path.join(__dirname, '..');
const MEDIA_DIR = path.join(PROJECT_ROOT, 'media', 'marketplace');
const DB_DIR = path.join(PROJECT_ROOT, 'database');
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
const GROUP_DELAY = [15000, 25000];
const ITEM_DELAY = [20000, 35000];
const MAX_CONSECUTIVE_FAILS = 5;
const SEND_RETRIES = 3;
const RECONNECT_WAIT = [12000, 20000];
const REQUEST_REPEAT_COUNT = 3;
const REQUEST_REPEAT_DELAY = [1500, 3000];

const IMAGE_EXTS = ['.jpg', '.jpeg', '.png', '.webp'];
const MIME_BY_EXT = {
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.png': 'image/png',
  '.webp': 'image/webp',
  '.mp4': 'video/mp4'
};

fs.ensureDirSync(MEDIA_DIR);
fs.ensureDirSync(DB_DIR);

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}
function randomBetween([a, b]) {
  return a + Math.floor(Math.random() * (b - a + 1));
}
function isConnError(e) {
  const msg = String(e?.message || e || '');
  return /connection closed|connection lost|timed out|not connected|socket closed|reset|ECONN|closed/i.test(msg);
}

// NOTE: full file continues in repo - this restore may be incomplete if truncated
module.exports = { MEDIA_DIR, GROUP_DELAY, ITEM_DELAY, MAX_CONSECUTIVE_FAILS, SEND_RETRIES, isConnError, sleep, randomBetween };
