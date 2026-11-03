/**
 * Marketplace commands for CODEX-AI
 * Requires: lib/marketplace.js
 */
'use strict';

const mp = require('../lib/marketplace');

function reply(sock, message, text) {
  return sock.sendMessage(message.chat, { text: String(text) }, { quoted: message });
}

async function replyDiscreet(sock, message, fullText, emoji = '✅') {
  const isGroup = message.chat?.endsWith('@g.us');
  if (!isGroup) return reply(sock, message, fullText);
  try { await sock.sendMessage(message.chat, { react: { text: emoji, key: message.key } }); } catch {}
  try { await sock.sendMessage(message.sender, { text: fullText }); } catch { return reply(sock, message, fullText); }
}

let mpPosting = false;
let mpCancelRequested = false;

const NO_MEDIA_MSG = mp.NO_ALBUM_HINT || (
  '_No photo/video found to save._\n' +
  '_If you replied to an album: try *.mp* once, then resend the album and reply with the command. Or reply to a single photo._'
);

const commands = [];
function add(def) {
  commands.push({ category: 'business', permission: 'owner', group: true, private: true, ...def });
}

add({
  commands: ['mphelp', 'mp'],
  description: 'List all marketplace commands',
  async run(sock, message) {
    try { mp.ensureAlbumListener(sock); } catch {}
    const p = '.';
    return reply(sock, message, `*Marketplace Commands*\n\n*Products*\n• *${p}mpsell* — reply to media/album\n• *${p}mpsell ID* — add media\n• *${p}mpadd* — add to latest\n• *${p}mpedit ID caption* (or reply)\n• *${p}mpowner ID* (or reply)\n• *${p}mpdelete* / *${p}mpremove* (or reply)\n• *${p}mpview ID* (or reply)\n\n*Requests*\n• *${p}mprequest*\n\n*List*\n• *${p}mplist* [sell|request|owner]\n\n*Groups*\n• *${p}mpgadd* [JID…] — current or bulk JIDs\n• *${p}mpgremove* [JID…]\n• *${p}mpgroup list* — name + JID\n• *${p}mpgid* — DM group JID (silent in group)\n\n*Post*\n• *${p}mppost go*\n• *${p}mppost go except JID1 JID2*\n• *${p}mppost go to JID*\n• *${p}mpcancel*\n\n*Broadcast*\n• *${p}mpbroadcast*`);
  },
});

add({
  commands: ['mpsell'],
  description: 'Create product or add media (supports albums)',
  async run(sock, message, args) {
    try {
      try { mp.ensureAlbumListener(sock); } catch {}
      const text = (args || []).join(' ').trim();
      const argId = mp.cleanId(text);
      const listings = await mp.loadListings();
      const existing = text ? listings[argId] : null;
      if (existing) {
        if (existing.type !== 'sell') return reply(sock, message, `_#${argId} is a request. Use mprequest ${argId}_`);
        if (!mp.hasMediaInput(message)) return reply(sock, message, `_Reply to a photo/video/album with *mpsell ${argId}*_`);
        const mediaFiles = await mp.downloadMedia(sock, message);
        if (!mediaFiles.length) return reply(sock, message, NO_MEDIA_MSG);
        const res = await mp.mutateListings(async (list) => {
          const item = list[argId];
          if (!item) return { missing: true, skipSave: true };
          const saved = await mp.saveMediaFiles(argId, mediaFiles);
          mp.attachMediaEntries(item, saved);
          item.mediaCount = (item.mediaCount || 0) + saved.length;
          item.updatedAt = Date.now();
          return { count: saved.length, total: item.mediaCount };
        });
        if (res.missing) return reply(sock, message, `_No item *#${argId}*_`);
        return reply(sock, message, `✓ Added *${res.count}* media to *#${argId}*\n_Total: ${res.total}_`);
      }
      if (!mp.hasMediaInput(message)) {
        return reply(sock, message, `_Reply to a photo/video/**album** with *mpsell*_\n_Or *mpsell ID* / *mpadd*_`);
      }
      const mediaFiles = await mp.downloadMedia(sock, message);
      if (!mediaFiles.length) return reply(sock, message, NO_MEDIA_MSG);
      let ownerNumber = mp.cleanNumber(text);
      if (ownerNumber.length < 7) ownerNumber = '';
      if (!ownerNumber && message.quoted?.participant) ownerNumber = mp.cleanNumber(message.quoted.participant);
      if (!ownerNumber && message.quoted?.sender) ownerNumber = mp.cleanNumber(message.quoted.sender);
      const res = await mp.mutateListings(async (list) => {
        let id = mp.generateId('sell');
        while (list[id]) id = mp.generateId('sell');
        const saved = await mp.saveMediaFiles(id, mediaFiles);
        const item = {
          id, type: 'sell', caption: '', ownerNumber: ownerNumber || '',
          mediaCount: saved.length, media: [], status: 'active',
          createdAt: Date.now(), updatedAt: Date.now(), inactiveAt: null,
        };
        mp.attachMediaEntries(item, saved);
        list[id] = item;
        return { id, count: saved.length };
      });
      let msg = `✓ Product added\n\n*ID:* ${res.id}\n_Media: ${res.count}_`;
      if (ownerNumber) msg += `\n_Owner: ${ownerNumber}_`;
      msg += `\n\n_Set caption:_ *mpedit ${res.id} Your caption*`;
      if (!ownerNumber) msg += `\n_Set owner:_ *mpowner ${res.id} 234xxxxxxxxxx*`;
      msg += `\n\n_Add more media with *mpadd*_`;
      await reply(sock, message, msg);
      const idMsg = await reply(sock, message, res.id);
      try { const mid = idMsg?.key?.id; if (mid) await mp.recordSent(res.id, [mid]); } catch {}
      return idMsg;
    } catch (e) {
      console.log('mpsell error', e);
      return reply(sock, message, `❌ ${e.message}`);
    }
  },
});

add({
  commands: ['mpadd'],
  description: 'Add media to latest product (supports albums)',
  async run(sock, message) {
    try {
      try { mp.ensureAlbumListener(sock); } catch {}
      const latestNow = mp.getLatestProduct(await mp.loadListings());
      if (!latestNow) return reply(sock, message, `_No active product. Use *mpsell*_`);
      if (!mp.hasMediaInput(message)) return reply(sock, message, `_Reply to photo/video/album with *mpadd*_\n_Latest: *#${latestNow.id}*_`);
      const mediaFiles = await mp.downloadMedia(sock, message);
      if (!mediaFiles.length) return reply(sock, message, NO_MEDIA_MSG);
      const res = await mp.mutateListings(async (listings) => {
        const latest = mp.getLatestProduct(listings);
        if (!latest) return { none: true, skipSave: true };
        const saved = await mp.saveMediaFiles(latest.id, mediaFiles);
        mp.attachMediaEntries(latest, saved);
        latest.mediaCount = (latest.mediaCount || 0) + saved.length;
        latest.updatedAt = Date.now();
        return { id: latest.id, count: saved.length, total: latest.mediaCount };
      });
      if (res.none) return reply(sock, message, `_No active product._`);
      return reply(sock, message, `✓ Added *${res.count}* media to *#${res.id}*\n_Total: ${res.total}_`);
    } catch (e) {
      console.log('mpadd error', e);
      return reply(sock, message, `❌ ${e.message}`);
    }
  },
});

add({
  commands: ['mprequest'],
  description: 'Create request or add media',
  async run(sock, message, args) {
    try {
      try { mp.ensureAlbumListener(sock); } catch {}
      const arg = (args || []).join(' ').trim();
      const argId = mp.cleanId(arg);
      const existing = arg ? (await mp.loadListings())[argId] : null;
      if (existing) {
        if (existing.type !== 'request') return reply(sock, message, `_#${argId} is a sell product_`);
        if (!mp.hasMediaInput(message)) return reply(sock, message, `_Reply to media with *mprequest ${argId}*_`);
        const mediaFiles = await mp.downloadMedia(sock, message);
        if (!mediaFiles.length) return reply(sock, message, NO_MEDIA_MSG);
        const res = await mp.mutateListings(async (listings) => {
          const item = listings[argId];
          if (!item) return { missing: true, skipSave: true };
          const saved = await mp.saveMediaFiles(argId, mediaFiles);
          mp.attachMediaEntries(item, saved);
          item.mediaCount = (item.mediaCount || 0) + saved.length;
          item.updatedAt = Date.now();
          return { count: saved.length, total: item.mediaCount };
        });
        if (res.missing) return reply(sock, message, `_No item *#${argId}*_`);
        return reply(sock, message, `✓ Added *${res.count}* media to *#${argId}*`);
      }
      const hasMedia = mp.hasMediaInput(message);
      const captionText = arg || message.quoted?.text || message.quoted?.caption || '';
      if (!hasMedia && !captionText) return reply(sock, message, `_Usage: *mprequest Looking for PS5*_`);
      const mediaFiles = hasMedia ? await mp.downloadMedia(sock, message) : [];
      let ownerNumber = '';
      if (message.quoted?.participant) ownerNumber = mp.cleanNumber(message.quoted.participant);
      else if (message.quoted?.sender) ownerNumber = mp.cleanNumber(message.quoted.sender);
      const res = await mp.mutateListings(async (listings) => {
        let id = mp.generateId('request');
        while (listings[id]) id = mp.generateId('request');
        const item = {
          id, type: 'request', caption: captionText || '', ownerNumber: ownerNumber || '',
          mediaCount: 0, media: [], status: 'active',
          createdAt: Date.now(), updatedAt: Date.now(), inactiveAt: null,
        };
        if (mediaFiles.length) {
          const saved = await mp.saveMediaFiles(id, mediaFiles);
          mp.attachMediaEntries(item, saved);
          item.mediaCount = saved.length;
        }
        listings[id] = item;
        return { id, mediaCount: item.mediaCount };
      });
      let msg = `✓ Request added\n\n*ID:* ${res.id}`;
      if (captionText) msg += `\n_${captionText}_`;
      if (res.mediaCount) msg += `\n_Media: ${res.mediaCount}_`;
      await reply(sock, message, msg);
      const idMsg = await reply(sock, message, res.id);
      try { const mid = idMsg?.key?.id; if (mid) await mp.recordSent(res.id, [mid]); } catch {}
      return idMsg;
    } catch (e) {
      console.log('mprequest error', e);
      return reply(sock, message, `❌ ${e.message}`);
    }
  },
});

add({
  commands: ['mpedit'],
  description: 'Set caption (ID arg or reply)',
  async run(sock, message, args) {
    try {
      const trimmed = (args || []).join(' ').trim();
      const parts = trimmed.split(/\s+/);
      const maybeId = mp.cleanId(parts[0] || '');
      const listings = await mp.loadListings();
      let id = null, caption = null;
      if (maybeId && listings[maybeId]) {
        id = maybeId; caption = parts.slice(1).join(' ').trim();
        if (!caption) return reply(sock, message, `_Usage: *mpedit ${maybeId} caption*_`);
      } else if (message.quoted) {
        id = await mp.findIdFromReply(message); caption = trimmed;
      }
      if (!id || !caption) return reply(sock, message, `_Usage: *mpedit ID caption*_ or reply`);
      const res = await mp.mutateListings(async (list) => {
        if (!list[id]) return { missing: true, skipSave: true };
        list[id].caption = caption; list[id].updatedAt = Date.now();
        return { ok: true };
      });
      if (res.missing) return reply(sock, message, `_No item *#${id}*_`);
      return reply(sock, message, `✓ Caption updated for *#${id}*\n\n${caption}`);
    } catch (e) { return reply(sock, message, `❌ ${e.message}`); }
  },
});

add({
  commands: ['mpowner'],
  description: 'Get/set owner (ID or reply)',
  async run(sock, message, args) {
    try {
      const trimmed = (args || []).join(' ').trim();
      const parts = trimmed.split(/\s+/).filter(Boolean);
      const maybeId = mp.cleanId(parts[0] || '');
      const listings = await mp.loadListings();
      let id = null, numberArg = '';
      if (maybeId && listings[maybeId]) { id = maybeId; numberArg = parts.slice(1).join(' '); }
      else if (message.quoted) { id = await mp.findIdFromReply(message); numberArg = trimmed; }
      if (!id) return reply(sock, message, `_Usage: *mpowner ID [number]*_`);
      const number = mp.cleanNumber(numberArg);
      if (number) {
        const res = await mp.mutateListings(async (list) => {
          if (!list[id]) return { missing: true, skipSave: true };
          list[id].ownerNumber = number; list[id].updatedAt = Date.now();
          return { ok: true };
        });
        if (res.missing) return reply(sock, message, `_No item *#${id}*_`);
        return reply(sock, message, `✓ Owner set for *#${id}*\n\`${number}\``);
      }
      const now = await mp.loadListings();
      if (!now[id]) return reply(sock, message, `_No item *#${id}*_`);
      const owner = now[id].ownerNumber;
      if (!owner) return reply(sock, message, `_No owner for *#${id}*_`);
      return reply(sock, message, `*Owner of #${id}:*\n\`${owner}\``);
    } catch (e) { return reply(sock, message, `❌ ${e.message}`); }
  },
});

add({
  commands: ['mpremove'],
  description: 'Mark inactive (ID or reply)',
  async run(sock, message, args) {
    try {
      let id = mp.cleanId((args || []).join(' '));
      if (!id && message.quoted) id = await mp.findIdFromReply(message);
      if (!id) return reply(sock, message, `_Reply to product or *mpremove ID*_`);
      const res = await mp.mutateListings(async (listings) => {
        if (!listings[id]) return { missing: true, skipSave: true };
        listings[id].status = 'inactive';
        listings[id].inactiveAt = Date.now();
        listings[id].updatedAt = Date.now();
        return { ok: true };
      });
      if (res.missing) return replyDiscreet(sock, message, `_No item *#${id}*_`, '⚠️');
      return replyDiscreet(sock, message, `✓ *#${id}* inactive (auto-delete after ${mp.INACTIVE_DAYS}d)`);
    } catch (e) { return reply(sock, message, `❌ ${e.message}`); }
  },
});

add({
  commands: ['mpdelete'],
  description: 'Remove by ID or reply',
  async run(sock, message, args) {
    try {
      let id = mp.cleanId((args || []).join(' '));
      if (!id && message.quoted) id = await mp.findIdFromReply(message);
      if (!id) return reply(sock, message, `_Reply to post or *mpdelete ID*_`);
      const res = await mp.mutateListings(async (listings) => {
        if (!listings[id]) return { missing: true, skipSave: true };
        listings[id].status = 'inactive';
        listings[id].inactiveAt = Date.now();
        listings[id].updatedAt = Date.now();
        return { ok: true };
      });
      if (res.missing) return replyDiscreet(sock, message, `_No item *#${id}*_`, '⚠️');
      return replyDiscreet(sock, message, `✓ *#${id}* removed`);
    } catch (e) { return reply(sock, message, `❌ ${e.message}`); }
  },
});

add({
  commands: ['mplist'],
  description: 'List items',
  async run(sock, message, args) {
    try {
      const filter = ((args || [])[0] || '').toLowerCase();
      const listings = await mp.loadListings();
      const items = Object.values(listings).filter((i) => i.status === 'active');
      let filtered = items;
      if (filter === 'sell') filtered = items.filter((i) => i.type === 'sell');
      else if (filter === 'request') filtered = items.filter((i) => i.type === 'request');
      if (!filtered.length) return reply(sock, message, '_No active items_');
      if (filter === 'owner') {
        let msg = `*Marketplace — Active (${items.length})*\n\n`;
        for (const item of items) {
          msg += `*#${item.id}* [${item.type === 'sell' ? 'SELL' : 'REQ'}]\n${item.caption || '_No caption_'}\nOwner: ${item.ownerNumber || '_not set_'}\nMedia: ${item.mediaCount || 0}\n\n`;
        }
        return reply(sock, message, msg.trim());
      }
      let msg = `*Marketplace* — ${filtered.length} active\n\n`;
      for (const item of filtered) {
        const cap = item.caption ? (item.caption.length > 40 ? item.caption.slice(0, 40) + '…' : item.caption) : '_no caption_';
        msg += `*#${item.id}* [${item.type === 'sell' ? 'S' : 'R'}] ${cap} · ${item.mediaCount || 0} media\n`;
      }
      return reply(sock, message, msg.trim());
    } catch (e) { return reply(sock, message, `❌ ${e.message}`); }
  },
});

add({
  commands: ['mpview'],
  description: 'View item + media (ID or reply)',
  async run(sock, message, args) {
    try {
      let id = mp.cleanId((args || []).join(' '));
      if (!id && message.quoted) id = await mp.findIdFromReply(message);
      if (!id) return reply(sock, message, `_Reply to product or *mpview ID*_`);
      const item = (await mp.loadListings())[id];
      if (!item) return reply(sock, message, `_No item *#${id}*_`);
      let msg = `*#${item.id}* — ${item.type === 'sell' ? 'FOR SALE' : 'REQUEST'}\nStatus: ${item.status}\nCaption: ${item.caption || '_none_'}\nOwner: ${item.ownerNumber || '_not set_'}\nMedia: ${item.mediaCount || 0}`;
      await reply(sock, message, msg);
      for (const file of await mp.resolveItemMedia(item)) {
        try {
          const content = file.kind === 'video'
            ? { video: file.buffer, mimetype: file.mimetype, caption: `#${id}` }
            : { image: file.buffer, mimetype: file.mimetype, caption: `#${id}` };
          await sock.sendMessage(message.chat, content, { quoted: message });
        } catch (e) { console.log('mpview media', e.message); }
      }
    } catch (e) { return reply(sock, message, `❌ ${e.message}`); }
  },
});

add({
  commands: ['mpgadd'],
  description: 'Add group(s) by JID or current group (bulk ok)',
  async run(sock, message, args) {
    try {
      const raw = (args || []).join(' ').trim();
      let jids = mp.extractJids(raw);
      if (!jids.length && message.chat?.endsWith('@g.us')) jids = [message.chat];
      if (!jids.length) {
        return reply(sock, message, `_Usage:_\n*mpgadd* — add current group\n*mpgadd JID1 JID2 …* — bulk add by JID`);
      }
      const res = await mp.mutateGroups(async (groups) => {
        const added = [];
        const skipped = [];
        for (const jid of jids) {
          if (groups.includes(jid)) skipped.push(jid);
          else { groups.push(jid); added.push(jid); }
        }
        return { skipSave: !added.length, added, skipped, total: groups.length };
      });
      const isGroup = message.chat?.endsWith('@g.us');
      if (isGroup) {
        try { await sock.sendMessage(message.chat, { react: { text: res.added.length ? '✅' : '⚠️', key: message.key } }); } catch {}
      }
      let msg = `✓ Groups\n_Added: ${res.added.length}_ · _Already: ${(res.skipped || []).length}_ · _Total: ${res.total}_\n`;
      for (const j of res.added || []) msg += `+ \`${j}\`\n`;
      for (const j of res.skipped || []) msg += `· \`${j}\` (already)\n`;
      try { await sock.sendMessage(message.sender, { text: msg.trim() }); } catch {
        if (!isGroup) return reply(sock, message, msg.trim());
      }
    } catch (e) { return reply(sock, message, `❌ ${e.message}`); }
  },
});

add({
  commands: ['mpgremove'],
  description: 'Remove group(s) by JID or current group (bulk ok)',
  async run(sock, message, args) {
    try {
      const raw = (args || []).join(' ').trim();
      let jids = mp.extractJids(raw);
      if (!jids.length && message.chat?.endsWith('@g.us')) jids = [message.chat];
      if (!jids.length) {
        return reply(sock, message, `_Usage:_\n*mpgremove* — remove current group\n*mpgremove JID1 JID2 …*`);
      }
      const res = await mp.mutateGroups(async (groups) => {
        let n = 0;
        for (const jid of jids) {
          const i = groups.indexOf(jid);
          if (i !== -1) { groups.splice(i, 1); n++; }
        }
        return { skipSave: !n, removedCount: n, total: groups.length };
      });
      const isGroup = message.chat?.endsWith('@g.us');
      if (isGroup) {
        try { await sock.sendMessage(message.chat, { react: { text: res.removedCount ? '✅' : '⚠️', key: message.key } }); } catch {}
      }
      const msg = `✓ Removed *${res.removedCount}* — total ${res.total}`;
      try { await sock.sendMessage(message.sender, { text: msg }); } catch {
        if (!isGroup) return reply(sock, message, msg);
      }
    } catch (e) { return reply(sock, message, `❌ ${e.message}`); }
  },
});

add({
  commands: ['mpgroup', 'mpgroups'],
  description: 'List / manage marketplace groups (name + JID)',
  async run(sock, message, args) {
    try {
      const rawArg = (args || []).join(' ').trim();
      const arg = rawArg.toLowerCase();
      if (arg === 'list' || !arg) {
        const groups = await mp.loadGroups();
        if (!groups.length) return reply(sock, message, '_No groups saved_');
        let msg = `*Posting groups (${groups.length})*\n\n`;
        for (let i = 0; i < groups.length; i++) {
          let name = groups[i];
          try { name = (await sock.groupMetadata(groups[i])).subject || groups[i]; } catch {}
          msg += `*${i + 1}. ${name}*\n\`${groups[i]}\`\n\n`;
        }
        msg += `_Copy JIDs for *mppost go except …* or *mpgremove …*_`;
        return reply(sock, message, msg.trim());
      }
      if (arg === 'clear') {
        await mp.mutateGroups(async (groups) => { groups.length = 0; return {}; });
        return reply(sock, message, '_Groups cleared_');
      }
      if (arg.startsWith('add ')) {
        const jids = mp.extractJids(rawArg.slice(4));
        if (!jids.length) return reply(sock, message, `_Usage: *mpgroup add JID1 JID2*_`);
        const res = await mp.mutateGroups(async (groups) => {
          const added = [];
          for (const jid of jids) { if (!groups.includes(jid)) { groups.push(jid); added.push(jid); } }
          return { skipSave: !added.length, added, total: groups.length };
        });
        return reply(sock, message, `✓ Added *${res.added.length}* — total ${res.total}`);
      }
      if (arg.startsWith('remove ')) {
        const jids = mp.extractJids(rawArg.slice(7));
        const res = await mp.mutateGroups(async (groups) => {
          let n = 0;
          for (const jid of jids) { const i = groups.indexOf(jid); if (i !== -1) { groups.splice(i, 1); n++; } }
          return { skipSave: !n, removedCount: n, total: groups.length };
        });
        return reply(sock, message, `✓ Removed *${res.removedCount}* — total ${res.total}`);
      }
      return reply(sock, message, `_Usage: *mpgroup list|clear|add JID|remove JID*_`);
    } catch (e) { return reply(sock, message, `❌ ${e.message}`); }
  },
});

add({
  commands: ['mpgid', 'getgid', 'groupjid'],
  description: 'DM you this group JID (silent in group)',
  async run(sock, message) {
    try {
      if (!message.chat?.endsWith('@g.us')) {
        return reply(sock, message, '_Run this inside a group_');
      }
      const jid = message.chat;
      let name = jid;
      try { name = (await sock.groupMetadata(jid)).subject || jid; } catch {}
      try { await sock.sendMessage(message.chat, { react: { text: '📎', key: message.key } }); } catch {}
      const body = `*Group JID*\n*${name}*\n\`${jid}\`\n\n_Use with *mpgadd* / *mppost go except*…_`;
      try {
        await sock.sendMessage(message.sender, { text: body });
      } catch (e) {
        return reply(sock, message, body);
      }
    } catch (e) { return reply(sock, message, `❌ ${e.message}`); }
  },
});

add({
  commands: ['mppost'],
  description: 'Preview or post (supports except / to JID)',
  async run(sock, message, args) {
    try {
      try { mp.ensureAlbumListener(sock); } catch {}
      const fullText = (args || []).join(' ').trim();
      const parsed = await mp.extractTargetClause(sock, fullText);
      const cleanedText = parsed.text || '';
      const targetGroups = parsed.groups || null;
      const exceptGroups = parsed.except || null;
      const arg = cleanedText.trim().toLowerCase();

      const listings = await mp.loadListings();
      const active = Object.values(listings).filter((i) => i.status === 'active');
      let groups = targetGroups || (await mp.loadGroups());
      if (exceptGroups && exceptGroups.length) {
        const ex = new Set(exceptGroups);
        groups = groups.filter((g) => !ex.has(g));
      }

      if (!arg || arg === 'preview') {
        if (!active.length) return reply(sock, message, '_No active items_');
        let msg = `*Preview — ${active.length} item(s), ${groups.length} group(s)*\n\n`;
        for (const item of active.slice(0, mp.MAX_ITEMS_PER_RUN)) {
          msg += `*#${item.id}* [${item.type}] ${item.caption || '_no caption_'} · ${item.mediaCount || 0} media\n`;
        }
        if (active.length > mp.MAX_ITEMS_PER_RUN) msg += `\n_…and ${active.length - mp.MAX_ITEMS_PER_RUN} more_`;
        if (exceptGroups && exceptGroups.length) msg += `\n_Excluding ${exceptGroups.length} group(s)_`;
        if (targetGroups && targetGroups.length) msg += `\n_Only ${targetGroups.length} target group(s)_`;
        msg += `\n\n_*mppost go*_\n_*mppost go except JID1 JID2*_\n_*mppost go to JID*_`;
        return reply(sock, message, msg.trim());
      }

      if (arg === 'cancel' || arg === 'stop') {
        if (!mpPosting) return reply(sock, message, '_Nothing posting_');
        mpCancelRequested = true;
        return reply(sock, message, '_Cancel requested_');
      }

      let toPost = active;
      if (/^go(\s|$)/.test(arg)) {
        const parts = arg.split(/\s+/).slice(1);
        if (parts.length) {
          toPost = parts.map((p) => listings[mp.cleanId(p)]).filter((i) => i && i.status === 'active');
          if (!toPost.length) return reply(sock, message, '_No matching active items_');
        }
      } else if (arg !== 'go') {
        return reply(sock, message, `_Usage:_\n*mppost* — preview\n*mppost go*\n*mppost go except JID1 JID2*\n*mppost go to JID*\n*mppost go ID*\n*mpcancel*`);
      }

      if (!groups.length) return reply(sock, message, '_No groups left to post to (check list / except)_');
      if (!toPost.length) return reply(sock, message, '_Nothing to post_');
      if (mpPosting) return reply(sock, message, '_Already posting — *mpcancel* to stop_');

      toPost = toPost.slice(0, mp.MAX_ITEMS_PER_RUN);
      mpPosting = true; mpCancelRequested = false;
      try {
        let head = `_Posting ${toPost.length} item(s) to ${groups.length} group(s)..._`;
        if (exceptGroups && exceptGroups.length) head += `\n_Except ${exceptGroups.length} excluded_`;
        await reply(sock, message, head);
        let success = 0, fail = 0, streak = 0, aborted = false;
        for (let n = 0; n < toPost.length; n++) {
          const item = toPost[n];
          if (mpCancelRequested || aborted) break;
          const caption = mp.buildPostCaption(item);
          const files = await mp.resolveItemMedia(item);
          if (!files.length && !caption) { await mp.markItemPosted(item.id); continue; }
          let itemOk = 0;
          for (const groupJid of groups) {
            if (mpCancelRequested) break;
            try {
              const sentIds = await mp.sendPost(sock, groupJid, files, caption);
              await mp.recordSent(item.id, sentIds);
              success++; itemOk++; streak = 0;
            } catch (e) {
              fail++; streak++; console.log('mppost', e.message);
              if (streak >= mp.MAX_CONSECUTIVE_FAILS) { aborted = true; break; }
            }
            await mp.sleep(mp.randomBetween(mp.GROUP_DELAY));
          }
          if (itemOk) await mp.markItemPosted(item.id);
          if (n < toPost.length - 1 && !mpCancelRequested && !aborted) await mp.sleep(mp.randomBetween(mp.ITEM_DELAY));
        }
        if (aborted) return reply(sock, message, `⚠️ Stopped after ${mp.MAX_CONSECUTIVE_FAILS} failures in a row — ok ${success}, fail ${fail}\n_Check connection / group membership, then run *mppost go* again._`);
        return reply(sock, message, `✓ Done — ok ${success}, fail ${fail}`);
      } finally { mpPosting = false; mpCancelRequested = false; }
    } catch (e) { return reply(sock, message, `❌ ${e.message}`); }
  },
});

add({
  commands: ['mpcancel'],
  description: 'Cancel posting',
  async run(sock, message) {
    if (!mpPosting) return reply(sock, message, '_No run in progress_');
    mpCancelRequested = true;
    return reply(sock, message, '_Cancelling..._');
  },
});

add({
  commands: ['mpbroadcast', 'mpbc'],
  description: 'Broadcast to groups',
  async run(sock, message, args) {
    try {
      const fullText = (args || []).join(' ');
      const { text: cleanedText, groups: targetGroups } = await mp.extractTargetClause(sock, fullText);
      const arg = cleanedText.trim();
      const groups = targetGroups || (await mp.loadGroups());
      if (!groups.length) return reply(sock, message, '_No groups_');
      const listings = await mp.loadListings();
      const maybeId = mp.cleanId(arg);
      const existing = arg && listings[maybeId] ? listings[maybeId] : null;
      let files = [], caption = '';
      if (existing) { files = await mp.resolveItemMedia(existing); caption = existing.caption || ''; }
      else if (mp.hasMediaInput(message)) {
        files = await mp.downloadMedia(sock, message);
        caption = arg || message.quoted?.text || '';
      } else caption = arg;
      if (!files.length && !caption) return reply(sock, message, `_Usage: *mpbroadcast text*_`);
      await reply(sock, message, `_Broadcasting to ${groups.length} group(s)..._`);
      let ok = 0, fail = 0;
      for (const g of groups) {
        try {
          const ids = await mp.sendPost(sock, g, files, caption);
          if (existing) await mp.recordSent(existing.id, ids);
          ok++;
        } catch { fail++; }
        await mp.sleep(mp.randomBetween(mp.GROUP_DELAY));
      }
      return reply(sock, message, `✓ Sent ${ok}, failed ${fail}`);
    } catch (e) { return reply(sock, message, `❌ ${e.message}`); }
  },
});

module.exports = commands;
