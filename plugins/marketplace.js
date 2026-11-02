/**
 * Marketplace commands for CODEX-AI
 * Owner-only product listing / group posting system
 *
 * Place this file at: plugins/marketplace.js
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
  try {
    await sock.sendMessage(message.chat, { react: { text: emoji, key: message.key } });
  } catch {}
  try {
    await sock.sendMessage(message.sender, { text: fullText });
  } catch {
    return reply(sock, message, fullText);
  }
}

let mpPosting = false;
let mpCancelRequested = false;

const NO_MEDIA_MSG =
  '_No photo/video found to save._\n' +
  '_Reply to a single photo or video with the command._';

const commands = [];

function add(def) {
  commands.push({
    category: 'business',
    permission: 'owner',
    group: true,
    private: true,
    ...def,
  });
}

add({
  commands: ['mphelp', 'mp'],
  description: 'List all marketplace commands',
  async run(sock, message) {
    const prefix = '.';
    const msg = `*Marketplace Commands*\n\n*Products*\n• *${prefix}mpsell* — reply to media → new product\n• *${prefix}mpsell ID* — add media to that product\n• *${prefix}mpadd* — add media to latest product\n• *${prefix}mpedit ID caption* — set caption\n• *${prefix}mpowner ID* — get/set owner number\n• *${prefix}mpdelete* — reply to a post OR use ID\n• *${prefix}mpremove ID* — mark inactive\n• *${prefix}mpview ID* — view details + media\n\n*Requests*\n• *${prefix}mprequest text* — create request\n• *${prefix}mprequest* — reply to media → request\n\n*List*\n• *${prefix}mplist* — summary\n• *${prefix}mplist sell|request|owner*\n\n*Groups*\n• *${prefix}mpgadd* — add current group\n• *${prefix}mpgremove* — remove current group\n• *${prefix}mpgroup list|clear*\n• *${prefix}mpgroup add JID...*\n• *${prefix}mpgroup remove JID...*\n\n*Post*\n• *${prefix}mppost* — preview\n• *${prefix}mppost go* — post all\n• *${prefix}mppost go ID* — post one item\n• *${prefix}mppost cancel* / *${prefix}mpcancel*\n\n*Broadcast*\n• *${prefix}mpbroadcast text*\n• *${prefix}mpbroadcast ID*\n• reply to media with *${prefix}mpbroadcast caption*`;
    return reply(sock, message, msg);
  },
});

add({
  commands: ['mpsell'],
  description: 'Create product or add media to ID',
  async run(sock, message, args) {
    try {
      const text = (args || []).join(' ').trim();
      const argId = mp.cleanId(text);
      const listings = await mp.loadListings();
      const existing = text ? listings[argId] : null;

      if (existing) {
        if (existing.type !== 'sell') {
          return reply(sock, message, `_#${argId} is a request. Use mprequest ${argId}_`);
        }
        if (!mp.hasMediaInput(message)) {
          return reply(sock, message, `_Reply to a photo/video with *mpsell ${argId}*_`);
        }
        const mediaFiles = await mp.downloadMedia(null, message);
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

        if (res.missing) return reply(sock, message, `_No item found with ID *#${argId}*_`);
        return reply(sock, message, `✓ Added *${res.count}* media to *#${argId}*\n_Total media: ${res.total}_`);
      }

      if (!mp.hasMediaInput(message)) {
        return reply(
          sock,
          message,
          `_Reply to a photo/video with *mpsell*_\n_Or *mpsell ID* to add to existing_\n_Or *mpadd* to add to latest product_`
        );
      }

      const mediaFiles = await mp.downloadMedia(null, message);
      if (!mediaFiles.length) return reply(sock, message, NO_MEDIA_MSG);

      let ownerNumber = mp.cleanNumber(text);
      if (!ownerNumber && message.quoted?.participant) ownerNumber = mp.cleanNumber(message.quoted.participant);
      if (!ownerNumber && message.quoted?.sender) ownerNumber = mp.cleanNumber(message.quoted.sender);

      const res = await mp.mutateListings(async (list) => {
        let id = mp.generateId('sell');
        while (list[id]) id = mp.generateId('sell');
        const saved = await mp.saveMediaFiles(id, mediaFiles);
        const item = {
          id,
          type: 'sell',
          caption: '',
          ownerNumber: ownerNumber || '',
          mediaCount: saved.length,
          media: [],
          status: 'active',
          createdAt: Date.now(),
          updatedAt: Date.now(),
          inactiveAt: null,
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
      return reply(sock, message, res.id);
    } catch (e) {
      console.log('mpsell error', e);
      return reply(sock, message, `❌ ${e.message}`);
    }
  },
});

add({
  commands: ['mpadd'],
  description: 'Add media to the latest product',
  async run(sock, message) {
    try {
      const latestNow = mp.getLatestProduct(await mp.loadListings());
      if (!latestNow) {
        return reply(sock, message, `_No active product found._\n_Create one with *mpsell*_`);
      }
      if (!mp.hasMediaInput(message)) {
        return reply(sock, message, `_Reply to a photo/video with *mpadd*_\n_Latest product: *#${latestNow.id}*_`);
      }
      const mediaFiles = await mp.downloadMedia(null, message);
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

      if (res.none) return reply(sock, message, `_No active product found._`);
      return reply(sock, message, `✓ Added *${res.count}* media to *#${res.id}*\n_Total media: ${res.total}_`);
    } catch (e) {
      console.log('mpadd error', e);
      return reply(sock, message, `❌ ${e.message}`);
    }
  },
});

add({
  commands: ['mprequest'],
  description: 'Create request or add media to request',
  async run(sock, message, args) {
    try {
      const arg = (args || []).join(' ').trim();
      const argId = mp.cleanId(arg);
      const existing = arg ? (await mp.loadListings())[argId] : null;

      if (existing) {
        if (existing.type !== 'request') {
          return reply(sock, message, `_#${argId} is a sell product. Use mpsell ${argId}_`);
        }
        if (!mp.hasMediaInput(message)) {
          return reply(sock, message, `_Reply to a photo/video with *mprequest ${argId}*_`);
        }
        const mediaFiles = await mp.downloadMedia(null, message);
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
        if (res.missing) return reply(sock, message, `_No item found with ID *#${argId}*_`);
        return reply(sock, message, `✓ Added *${res.count}* media to request *#${argId}*\n_Total: ${res.total}_`);
      }

      const hasMedia = mp.hasMediaInput(message);
      const captionText = arg || message.quoted?.text || message.quoted?.caption || '';

      if (!hasMedia && !captionText) {
        return reply(
          sock,
          message,
          `_Usage:_\n*mprequest Looking for PS5*\n_Or reply to media with *mprequest*_`
        );
      }

      const mediaFiles = hasMedia ? await mp.downloadMedia(null, message) : [];
      let ownerNumber = '';
      if (message.quoted?.participant) ownerNumber = mp.cleanNumber(message.quoted.participant);
      else if (message.quoted?.sender) ownerNumber = mp.cleanNumber(message.quoted.sender);

      const res = await mp.mutateListings(async (listings) => {
        let id = mp.generateId('request');
        while (listings[id]) id = mp.generateId('request');
        const item = {
          id,
          type: 'request',
          caption: captionText || '',
          ownerNumber: ownerNumber || '',
          mediaCount: 0,
          media: [],
          status: 'active',
          createdAt: Date.now(),
          updatedAt: Date.now(),
          inactiveAt: null,
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
      if (!captionText) msg += `\n\n_Set caption:_ *mpedit ${res.id} Looking for ...*`;
      await reply(sock, message, msg);
      return reply(sock, message, res.id);
    } catch (e) {
      console.log('mprequest error', e);
      return reply(sock, message, `❌ ${e.message}`);
    }
  },
});

add({
  commands: ['mpedit'],
  description: 'Set or update caption',
  async run(sock, message, args) {
    try {
      const trimmed = (args || []).join(' ').trim();
      const parts = trimmed.split(/\s+/);
      const maybeId = mp.cleanId(parts[0] || '');
      const listings = await mp.loadListings();

      let id = null;
      let caption = null;

      if (maybeId && listings[maybeId]) {
        id = maybeId;
        caption = parts.slice(1).join(' ').trim();
        if (!caption) return reply(sock, message, `_Usage: *mpedit ${maybeId} Your new caption*_`);
      } else if (message.quoted) {
        const qId = await mp.findIdFromReply(message);
        if (qId) {
          id = qId;
          caption = trimmed;
        }
      }

      if (!id || !caption) {
        return reply(
          sock,
          message,
          `_Usage:_\n*mpedit SUSYY iPhone 13 for sale*\n_Or reply to that product with_\n*mpedit Your new caption*`
        );
      }

      const res = await mp.mutateListings(async (list) => {
        if (!list[id]) return { missing: true, skipSave: true };
        list[id].caption = caption;
        list[id].updatedAt = Date.now();
        return { ok: true };
      });
      if (res.missing) return reply(sock, message, `_No item found with ID *#${id}*_`);
      return reply(sock, message, `✓ Caption updated for *#${id}*\n\n${caption}`);
    } catch (e) {
      console.log('mpedit error', e);
      return reply(sock, message, `❌ ${e.message}`);
    }
  },
});

add({
  commands: ['mpowner'],
  description: 'Get or set owner number',
  async run(sock, message, args) {
    try {
      const trimmed = (args || []).join(' ').trim();
      const parts = trimmed.split(/\s+/).filter(Boolean);
      const maybeId = mp.cleanId(parts[0] || '');
      const listings = await mp.loadListings();

      let id = null;
      let numberArg = '';

      if (maybeId && listings[maybeId]) {
        id = maybeId;
        numberArg = parts.slice(1).join(' ');
      } else if (message.quoted) {
        const qId = await mp.findIdFromReply(message);
        if (qId) {
          id = qId;
          numberArg = trimmed;
        }
      }

      if (!id) {
        return reply(
          sock,
          message,
          `_Usage:_\n*mpowner SUSYY*\n*mpowner SUSYY 234xxxxxxxxxx*\n_Or reply to product with *mpowner*_`
        );
      }

      const number = mp.cleanNumber(numberArg);
      if (number) {
        const res = await mp.mutateListings(async (list) => {
          if (!list[id]) return { missing: true, skipSave: true };
          list[id].ownerNumber = number;
          list[id].updatedAt = Date.now();
          return { ok: true };
        });
        if (res.missing) return reply(sock, message, `_No item found with ID *#${id}*_`);
        return reply(sock, message, `✓ Owner set for *#${id}*\n\`${number}\``);
      }

      const listingsNow = await mp.loadListings();
      if (!listingsNow[id]) return reply(sock, message, `_No item found with ID *#${id}*_`);
      const owner = listingsNow[id].ownerNumber;
      if (!owner) {
        return reply(sock, message, `_No owner saved for *#${id}*_\n_Set with: *mpowner ${id} 234xxxxxxxxxx*_`);
      }
      return reply(sock, message, `*Owner of #${id}:*\n\`${owner}\``);
    } catch (e) {
      console.log('mpowner error', e);
      return reply(sock, message, `❌ ${e.message}`);
    }
  },
});

add({
  commands: ['mpremove'],
  description: 'Mark item inactive',
  async run(sock, message, args) {
    try {
      const id = mp.cleanId((args || []).join(' '));
      if (!id) return reply(sock, message, `_Usage: *mpremove SUSYY*_`);
      const res = await mp.mutateListings(async (listings) => {
        if (!listings[id]) return { missing: true, skipSave: true };
        listings[id].status = 'inactive';
        listings[id].inactiveAt = Date.now();
        listings[id].updatedAt = Date.now();
        return { ok: true };
      });
      if (res.missing) return replyDiscreet(sock, message, `_No item found with ID *#${id}*_`, '⚠️');
      return replyDiscreet(
        sock,
        message,
        `✓ *#${id}* marked inactive\n_Auto-deleted after ${mp.INACTIVE_DAYS} days_`
      );
    } catch (e) {
      console.log('mpremove error', e);
      return reply(sock, message, `❌ ${e.message}`);
    }
  },
});

add({
  commands: ['mpdelete'],
  description: 'Remove product by ID or by replying to a post',
  async run(sock, message, args) {
    try {
      let id = mp.cleanId((args || []).join(' '));
      if (!id && message.quoted) id = await mp.findIdFromReply(message);
      if (!id) {
        return reply(
          sock,
          message,
          `_Reply to that product's post with *mpdelete*_\n_Or use *mpdelete SUSYY*_`
        );
      }
      const res = await mp.mutateListings(async (listings) => {
        if (!listings[id]) return { missing: true, skipSave: true };
        listings[id].status = 'inactive';
        listings[id].inactiveAt = Date.now();
        listings[id].updatedAt = Date.now();
        return { ok: true };
      });
      if (res.missing) return replyDiscreet(sock, message, `_No item found with ID *#${id}*_`, '⚠️');
      return replyDiscreet(
        sock,
        message,
        `✓ *#${id}* removed\n_Will be auto-deleted after ${mp.INACTIVE_DAYS} days_`
      );
    } catch (e) {
      console.log('mpdelete error', e);
      return reply(sock, message, `❌ ${e.message}`);
    }
  },
});

add({
  commands: ['mplist'],
  description: 'List marketplace items',
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
          const typeLabel = item.type === 'sell' ? 'SELL' : 'REQ';
          msg += `*#${item.id}* [${typeLabel}]\n`;
          msg += `${item.caption || '_No caption_'}\n`;
          msg += `Owner: ${item.ownerNumber || '_not set_'}\n`;
          msg += `Media: ${item.mediaCount || 0}\n\n`;
        }
        return reply(sock, message, msg.trim());
      }

      let msg = `*Marketplace* — ${filtered.length} active`;
      if (filter === 'sell') msg += ' (sell)';
      if (filter === 'request') msg += ' (requests)';
      msg += '\n\n';
      for (const item of filtered) {
        const typeLabel = item.type === 'sell' ? 'S' : 'R';
        const cap = item.caption
          ? item.caption.length > 40
            ? item.caption.slice(0, 40) + '…'
            : item.caption
          : '_no caption_';
        msg += `*#${item.id}* [${typeLabel}] ${cap} · ${item.mediaCount || 0} media\n`;
      }
      msg += `\n_Use *mplist owner* for full details + numbers_`;
      return reply(sock, message, msg.trim());
    } catch (e) {
      console.log('mplist error', e);
      return reply(sock, message, `❌ ${e.message}`);
    }
  },
});

add({
  commands: ['mpview'],
  description: 'View full details + media',
  async run(sock, message, args) {
    try {
      const id = mp.cleanId((args || []).join(' '));
      if (!id) return reply(sock, message, `_Usage: *mpview SUSYY*_`);
      const listings = await mp.loadListings();
      const item = listings[id];
      if (!item) return reply(sock, message, `_No item found with ID *#${id}*_`);

      const typeLabel = item.type === 'sell' ? 'FOR SALE' : 'REQUEST';
      let msg = `*#${item.id}* — ${typeLabel}\n`;
      msg += `Status: ${item.status}\n`;
      msg += `Caption: ${item.caption || '_none_'}\n`;
      msg += `Owner: ${item.ownerNumber || '_not set_'}\n`;
      msg += `Media: ${item.mediaCount || 0}\n`;
      msg += `Created: ${new Date(item.createdAt).toLocaleString()}`;
      await reply(sock, message, msg);

      const files = await mp.resolveItemMedia(item);
      for (const file of files) {
        try {
          const content =
            file.kind === 'video'
              ? { video: file.buffer, mimetype: file.mimetype, caption: `#${id}` }
              : { image: file.buffer, mimetype: file.mimetype, caption: `#${id}` };
          await sock.sendMessage(message.chat, content, { quoted: message });
        } catch (e) {
          console.log('mpview media error', e.message);
        }
      }
    } catch (e) {
      console.log('mpview error', e);
      return reply(sock, message, `❌ ${e.message}`);
    }
  },
});

add({
  commands: ['mpgadd'],
  description: 'Add current group to marketplace',
  async run(sock, message) {
    try {
      if (!message.chat.endsWith('@g.us')) {
        return reply(sock, message, '_Use this *inside* the group_');
      }
      const res = await mp.mutateGroups(async (groups) => {
        if (groups.includes(message.chat)) return { exists: true, skipSave: true };
        groups.push(message.chat);
        return { total: groups.length };
      });
      if (res.exists) {
        try {
          await sock.sendMessage(message.chat, { react: { text: '⚠️', key: message.key } });
        } catch {}
        return;
      }
      let gName = message.chat;
      try {
        const meta = await sock.groupMetadata(message.chat);
        gName = meta.subject || message.chat;
      } catch {}
      try {
        await sock.sendMessage(message.chat, { react: { text: '✅', key: message.key } });
      } catch {}
      try {
        await sock.sendMessage(message.sender, {
          text: `✓ Group added\n*${gName}*\n\`${message.chat}\`\n\nTotal: ${res.total}`,
        });
      } catch {}
    } catch (e) {
      console.log('mpgadd error', e);
      return reply(sock, message, `❌ ${e.message}`);
    }
  },
});

add({
  commands: ['mpgremove'],
  description: 'Remove current group from marketplace',
  async run(sock, message) {
    try {
      if (!message.chat.endsWith('@g.us')) {
        return reply(sock, message, '_Use this *inside* the group_');
      }
      const res = await mp.mutateGroups(async (groups) => {
        const idx = groups.indexOf(message.chat);
        if (idx === -1) return { missing: true, skipSave: true };
        groups.splice(idx, 1);
        return { total: groups.length };
      });
      try {
        await sock.sendMessage(message.chat, {
          react: { text: res.missing ? '⚠️' : '✅', key: message.key },
        });
      } catch {}
      try {
        await sock.sendMessage(message.sender, {
          text: res.missing
            ? `⚠ Group not in list\n\`${message.chat}\``
            : `✓ Group removed\n\`${message.chat}\`\n\nTotal: ${res.total}`,
        });
      } catch {}
    } catch (e) {
      console.log('mpgremove error', e);
      return reply(sock, message, `❌ ${e.message}`);
    }
  },
});

add({
  commands: ['mpgroup'],
  description: 'Manage marketplace groups: add, remove, list, clear',
  async run(sock, message, args) {
    try {
      const rawArg = (args || []).join(' ').trim();
      const arg = rawArg.toLowerCase();

      if (arg === 'add') {
        if (!message.chat.endsWith('@g.us')) return reply(sock, message, '_Use this *inside* the group_');
        const res = await mp.mutateGroups(async (groups) => {
          if (groups.includes(message.chat)) return { exists: true, skipSave: true };
          groups.push(message.chat);
          return { total: groups.length };
        });
        if (res.exists) return reply(sock, message, '_Group already in list_');
        return reply(sock, message, `✓ Group added\nTotal: ${res.total}`);
      }

      if (arg.startsWith('add ')) {
        const jids = [...new Set(mp.extractJids(rawArg.slice(4)))];
        if (!jids.length) {
          return reply(sock, message, `_No valid group JIDs found._\n_Usage: *mpgroup add 1203xxx@g.us*_`);
        }
        const res = await mp.mutateGroups(async (groups) => {
          const added = [];
          for (const jid of jids) {
            if (groups.includes(jid)) continue;
            groups.push(jid);
            added.push(jid);
          }
          return { skipSave: !added.length, added, total: groups.length };
        });
        return reply(sock, message, `✓ Added *${res.added.length}* group(s)\n_Total: ${res.total}_`);
      }

      if (arg === 'remove') {
        if (!message.chat.endsWith('@g.us')) return reply(sock, message, '_Use this *inside* the group_');
        const res = await mp.mutateGroups(async (groups) => {
          const idx = groups.indexOf(message.chat);
          if (idx === -1) return { missing: true, skipSave: true };
          groups.splice(idx, 1);
          return { total: groups.length };
        });
        if (res.missing) return reply(sock, message, '_Group not in list_');
        return reply(sock, message, `✓ Group removed\nTotal: ${res.total}`);
      }

      if (arg.startsWith('remove ')) {
        const jids = [...new Set(mp.extractJids(rawArg.slice(7)))];
        if (!jids.length) return reply(sock, message, `_Usage: *mpgroup remove JID1 JID2 ...*_`);
        const res = await mp.mutateGroups(async (groups) => {
          let removedCount = 0;
          for (const jid of jids) {
            const idx = groups.indexOf(jid);
            if (idx !== -1) {
              groups.splice(idx, 1);
              removedCount++;
            }
          }
          return { skipSave: !removedCount, removedCount, total: groups.length };
        });
        return reply(sock, message, `✓ Removed *${res.removedCount}* group(s)\n_Total: ${res.total}_`);
      }

      if (arg === 'list' || !arg) {
        const groups = await mp.loadGroups();
        if (!groups.length) return reply(sock, message, '_No groups added yet_');
        let msg = `*Marketplace Groups (${groups.length})*\n\n`;
        for (let i = 0; i < groups.length; i++) {
          let name = groups[i];
          try {
            const meta = await sock.groupMetadata(groups[i]);
            name = meta.subject || groups[i];
          } catch {}
          msg += `${i + 1}. ${name}\n\`${groups[i]}\`\n\n`;
        }
        return reply(sock, message, msg.trim());
      }

      if (arg === 'clear') {
        const path = require('path');
        const fs = require('fs-extra');
        const PROJECT_ROOT = process.env.CODEX_PROJECT_ROOT || path.join(__dirname, '..');
        fs.ensureDirSync(path.join(PROJECT_ROOT, 'database'));
        fs.writeFileSync(path.join(PROJECT_ROOT, 'database', 'marketplace_groups.json'), '[]');
        return reply(sock, message, '_All marketplace groups cleared_');
      }

      return reply(
        sock,
        message,
        `*mpgroup* usage:\n• *mpgadd* / *mpgroup add*\n• *mpgroup add JID1 JID2 ...*\n• *mpgremove* / *mpgroup remove*\n• *mpgroup list*\n• *mpgroup clear*`
      );
    } catch (e) {
      console.log('mpgroup error', e);
      return reply(sock, message, `❌ ${e.message}`);
    }
  },
});

add({
  commands: ['mppost'],
  description: 'Post items to saved (or targeted) groups',
  async run(sock, message, args) {
    try {
      const fullText = (args || []).join(' ');
      const { text: cleanedText, groups: targetGroups } = await mp.extractTargetClause(sock, fullText);
      const arg = cleanedText.trim().toLowerCase();

      if (arg === 'cancel' || arg === 'stop') {
        if (!mpPosting) return reply(sock, message, '_No posting run in progress_');
        mpCancelRequested = true;
        return reply(sock, message, '_Cancelling after the current send finishes..._');
      }

      const listings = await mp.loadListings();
      const groups = targetGroups || (await mp.loadGroups());
      const active = Object.values(listings).filter((i) => i.status === 'active');

      if (!active.length) return reply(sock, message, '_No active items to post_');
      if (!groups.length) {
        return reply(
          sock,
          message,
          targetGroups ? "_Couldn't resolve a group from that JID/link_" : '_No groups saved. Use *mpgadd* first_'
        );
      }

      if (!arg || arg === 'preview') {
        let msg = `*Ready to post*\n\n`;
        msg += `Active items: *${active.length}*\n`;
        msg += `Groups: *${groups.length}*${targetGroups ? ' (targeted)' : ''}\n\n`;
        msg += `Items:\n`;
        for (const item of active.slice(0, 15)) {
          const t = item.type === 'sell' ? 'S' : 'R';
          const cap = item.caption ? item.caption.slice(0, 30) : '_no caption_';
          msg += `• #${item.id} [${t}] ${cap}\n`;
        }
        if (active.length > 15) msg += `... +${active.length - 15} more\n`;
        msg += `\n_Max ${mp.MAX_ITEMS_PER_RUN} items per run_\n`;
        msg += `_Reply *mppost go* to post all_\n`;
        msg += `_Or *mppost go SUSYY* for one item_\n`;
        msg += `_*mppost cancel* stops a run in progress_`;
        return reply(sock, message, msg);
      }

      let toPost = active;
      let explicitIds = false;
      if (arg.startsWith('go')) {
        const parts = arg.split(/\s+/).slice(1);
        if (parts.length) {
          explicitIds = true;
          toPost = parts.map((p) => listings[mp.cleanId(p)]).filter((i) => i && i.status === 'active');
          if (!toPost.length) return reply(sock, message, '_None of those IDs are active_');
        }
      } else {
        return reply(sock, message, `_Use *mppost* or *mppost go*_`);
      }

      if (mpPosting) {
        return reply(sock, message, '_A posting run is already in progress. Use *mppost cancel*._');
      }

      if (!explicitIds) {
        toPost = [...toPost].sort((a, b) => (a.lastPostedAt || 0) - (b.lastPostedAt || 0));
      }

      let leftover = 0;
      if (toPost.length > mp.MAX_ITEMS_PER_RUN) {
        leftover = toPost.length - mp.MAX_ITEMS_PER_RUN;
        toPost = toPost.slice(0, mp.MAX_ITEMS_PER_RUN);
      }

      mpPosting = true;
      mpCancelRequested = false;
      try {
        await reply(
          sock,
          message,
          `_Posting *${toPost.length}* item(s) to *${groups.length}* group(s)... this is slow on purpose to avoid bans._`
        );

        let success = 0;
        let fail = 0;
        let skipped = 0;
        let consecutiveFails = 0;
        let aborted = false;
        let cancelled = false;

        for (let ii = 0; ii < toPost.length; ii++) {
          if (mpCancelRequested) {
            cancelled = true;
            break;
          }
          const item = toPost[ii];
          const caption = mp.buildPostCaption(item);
          const files = await mp.resolveItemMedia(item);

          if (!files.length && !caption) {
            skipped++;
            await mp.markItemPosted(item.id);
            continue;
          }

          const isPlainTextRequest = item.type === 'request' && !files.length && !!caption;
          let groupAttempted = false;
          let itemAborted = false;

          for (let gi = 0; gi < groups.length; gi++) {
            if (mpCancelRequested) {
              cancelled = true;
              break;
            }
            groupAttempted = true;
            const groupJid = groups[gi];
            try {
              if (isPlainTextRequest) {
                const sentIds = [];
                for (let r = 0; r < mp.REQUEST_REPEAT_COUNT; r++) {
                  const res = await sock.sendMessage(groupJid, { text: caption });
                  sentIds.push(res?.key?.id);
                  if (r < mp.REQUEST_REPEAT_COUNT - 1) await mp.sleep(mp.randomBetween(mp.REQUEST_REPEAT_DELAY));
                }
                await mp.recordSent(item.id, sentIds);
              } else {
                const sentIds = await mp.sendPost(sock, groupJid, files, caption);
                await mp.recordSent(item.id, sentIds);
              }
              success++;
              consecutiveFails = 0;
            } catch (e) {
              console.log(`mppost fail ${groupJid}:`, e.message);
              fail++;
              consecutiveFails++;
              if (consecutiveFails >= mp.MAX_CONSECUTIVE_FAILS) {
                aborted = true;
                itemAborted = true;
                break;
              }
            }
            const isLastGroup = gi === groups.length - 1;
            const isLastItem = ii === toPost.length - 1;
            if (!(isLastGroup && isLastItem)) {
              await mp.sleep(mp.randomBetween(isLastGroup ? mp.ITEM_DELAY : mp.GROUP_DELAY));
            }
          }

          if (groupAttempted) await mp.markItemPosted(item.id);
          if (cancelled || itemAborted) break;
        }

        let msg = `✓ Posting done\n_Success: ${success}_\n_Failed: ${fail}_`;
        if (skipped) msg += `\n_Skipped (nothing to send): ${skipped}_`;
        if (cancelled) msg += `\n\n⏹ _Cancelled by request._`;
        if (aborted) msg += `\n\n⚠ _Stopped early after ${mp.MAX_CONSECUTIVE_FAILS} failures in a row._`;
        if (leftover) msg += `\n\n_${leftover} item(s) left for next time (max ${mp.MAX_ITEMS_PER_RUN} per run)._`;
        return reply(sock, message, msg);
      } finally {
        mpPosting = false;
        mpCancelRequested = false;
      }
    } catch (e) {
      console.log('mppost error', e);
      return reply(sock, message, `❌ ${e.message}`);
    }
  },
});

add({
  commands: ['mpcancel'],
  description: 'Cancel a posting run in progress',
  async run(sock, message) {
    if (!mpPosting) return reply(sock, message, '_No posting run in progress_');
    mpCancelRequested = true;
    return reply(sock, message, '_Cancelling after the current send finishes..._');
  },
});

add({
  commands: ['mpbroadcast', 'mpbc'],
  description: 'Broadcast one message to saved groups',
  async run(sock, message, args) {
    try {
      const fullText = (args || []).join(' ');
      const { text: cleanedText, groups: targetGroups } = await mp.extractTargetClause(sock, fullText);
      const arg = cleanedText.trim();

      const groups = targetGroups || (await mp.loadGroups());
      if (!groups.length) {
        return reply(
          sock,
          message,
          targetGroups ? "_Couldn't resolve a group from that JID/link_" : '_No groups saved. Use *mpgadd* first_'
        );
      }

      const listings = await mp.loadListings();
      const maybeId = mp.cleanId(arg);
      const existing = arg && listings[maybeId] ? listings[maybeId] : null;

      let files = [];
      let caption = '';

      if (existing) {
        files = await mp.resolveItemMedia(existing);
        caption = existing.caption || '';
      } else if (mp.hasMediaInput(message)) {
        files = await mp.downloadMedia(null, message);
        caption = arg || message.quoted?.text || message.quoted?.caption || '';
      } else {
        caption = arg;
      }

      if (!files.length && !caption) {
        return reply(
          sock,
          message,
          `_Usage:_\n*mpbroadcast Your text*\n_Reply to media with *mpbroadcast caption*_\n*mpbroadcast SUSYY*`
        );
      }

      await reply(sock, message, `_Broadcasting to *${groups.length}* group(s)..._`);

      let msgOk = 0;
      let msgFail = 0;
      for (let gi = 0; gi < groups.length; gi++) {
        const groupJid = groups[gi];
        try {
          const sentIds = await mp.sendPost(sock, groupJid, files, caption);
          if (existing) await mp.recordSent(existing.id, sentIds);
          msgOk++;
        } catch (e) {
          console.log(`mpbroadcast fail ${groupJid}:`, e.message);
          msgFail++;
        }
        if (gi < groups.length - 1) await mp.sleep(mp.randomBetween(mp.GROUP_DELAY));
      }

      return reply(sock, message, `✓ Broadcast done\n_Sent: ${msgOk}, failed: ${msgFail}_`);
    } catch (e) {
      console.log('mpbroadcast error', e);
      return reply(sock, message, `❌ ${e.message}`);
    }
  },
});

module.exports = commands;
