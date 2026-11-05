'use strict';

const vv = require('../../lib/vvCmd');

module.exports = {
  name: 'vvcmd',
  aliases: ['vvemoji', 'setvv', 'vvtrigger'],
  category: 'owner',
  ownerOnly: true,
  reactions: { start: '👁️' },
  description: 'Configure emoji/sticker trigger for view-once → DM',

  async execute(bot, m, args) {
    const prefix = bot.prefix || '.';
    const sub = String(args[0] || '').toLowerCase();
    const rest = args.slice(1).join(' ').trim();
    const cfg = vv.load();

    const help =
      `*VV CMD*\n` +
      `_Reply to a view-once with your trigger emoji (or a sticker) → media goes to your DM._\n\n` +
      `• *${prefix}vvcmd status*\n` +
      `• *${prefix}vvcmd set <emoji>* — e.g. ${prefix}vvcmd set 🔥\n` +
      `• *${prefix}vvcmd on* / *off*\n` +
      `• *${prefix}vvcmd sticker on|off* — sticker-reply trigger\n\n` +
      `Current: ${cfg.enabled ? 'ON' : 'OFF'} · emoji *${cfg.emoji}* · sticker ${cfg.sticker !== false ? 'ON' : 'OFF'}\n\n` +
      `_Still works: ${prefix}vv (here) · ${prefix}vvp (DM)_`;

    if (!sub || sub === 'help') return m.reply(help);

    if (sub === 'status' || sub === 'info') {
      return m.reply(
        `*VV CMD*\n` +
          `Status: *${cfg.enabled ? 'ON' : 'OFF'}*\n` +
          `Emoji: *${cfg.emoji}*\n` +
          `Sticker reply: *${cfg.sticker !== false ? 'ON' : 'OFF'}*\n\n` +
          `_Reply to view-once with ${cfg.emoji} or a sticker → DM_`
      );
    }

    if (sub === 'on') {
      cfg.enabled = true;
      vv.save(cfg);
      return m.reply(`✓ VV trigger *ON*\n_Emoji: ${cfg.emoji}_`);
    }

    if (sub === 'off') {
      cfg.enabled = false;
      vv.save(cfg);
      return m.reply('✓ VV trigger *OFF*');
    }

    if (sub === 'set' || sub === 'emoji') {
      let emoji = rest || '';
      if (!emoji && m.quoted?.text) emoji = m.quoted.text.trim();
      if (!emoji) {
        return m.reply(`_Usage: *${prefix}vvcmd set 👁️*_`);
      }
      cfg.emoji = emoji.split(/\s+/)[0];
      cfg.enabled = true;
      vv.save(cfg);
      return m.reply(`✓ VV emoji set to *${cfg.emoji}*\n_Reply to view-once with that emoji → DM_`);
    }

    if (sub === 'sticker' || sub === 'stickers') {
      const mode = String(args[1] || '').toLowerCase();
      if (mode === 'on') {
        cfg.sticker = true;
        vv.save(cfg);
        return m.reply('✓ Sticker-reply VV trigger *ON*');
      }
      if (mode === 'off') {
        cfg.sticker = false;
        vv.save(cfg);
        return m.reply('✓ Sticker-reply VV trigger *OFF*');
      }
      return m.reply(`_Usage: *${prefix}vvcmd sticker on|off*_`);
    }

    if (args[0] && !['on', 'off', 'set', 'emoji', 'status', 'info', 'help', 'sticker', 'stickers'].includes(sub)) {
      cfg.emoji = args[0];
      cfg.enabled = true;
      vv.save(cfg);
      return m.reply(`✓ VV emoji set to *${cfg.emoji}*`);
    }

    return m.reply(help);
  },
};
