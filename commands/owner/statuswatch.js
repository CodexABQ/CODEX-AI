'use strict';

const sw = require('../../lib/statusWatch');

module.exports = {
  name: 'statuswatch',
  aliases: ['swatch', 'watchstatus', 'statussave'],
  category: 'owner',
  ownerOnly: true,
  reactions: { start: '📸' },
  description: 'Auto-save specific contacts\' status updates to your DM',

  async execute(bot, m, args) {
    const prefix = bot.prefix || '.';
    const sub = String(args[0] || '').toLowerCase();
    const rest = args.slice(1).join(' ').trim();

    const help =
      `*Status Watch*\n` +
      `_Auto-saves watched contacts' statuses to your DM as soon as they post._\n\n` +
      `• *${prefix}statuswatch add <number>*\n` +
      `• *${prefix}statuswatch remove <number>*\n` +
      `• *${prefix}statuswatch list*\n` +
      `• *${prefix}statuswatch clear*\n\n` +
      `_Number example: 2348065300209_`;

    if (!sub || sub === 'help') {
      return m.reply(help);
    }

    if (sub === 'list' || sub === 'ls') {
      const contacts = sw.list();
      if (!contacts.length) return m.reply('_No contacts watched._\n_Use statuswatch add <number>_');
      let msg = `*Watching ${contacts.length} contact(s)*\n\n`;
      contacts.forEach((c, i) => {
        msg += `${i + 1}. \`+${c}\`\n`;
      });
      return m.reply(msg.trim());
    }

    if (sub === 'clear') {
      sw.clear();
      return m.reply('✓ Status watch list cleared');
    }

    if (sub === 'add' || sub === 'set') {
      let num = rest;
      if (!num && m.quoted?.sender) num = m.quoted.sender;
      if (!num && m.mentions?.[0]) num = m.mentions[0];
      if (!num) return m.reply(`_Usage: *${prefix}statuswatch add 234xxxxxxxxxx*_`);
      const res = sw.add(num);
      if (!res.ok) return m.reply(`❌ ${res.error}`);
      if (res.already) return m.reply(`_Already watching_ \`+${res.number}\`\n_Total: ${res.total}_`);
      return m.reply(`✓ Now watching \`+${res.number}\`\n_Their status will be saved to your DM automatically._\n_Total: ${res.total}_`);
    }

    if (sub === 'remove' || sub === 'rm' || sub === 'del' || sub === 'delete') {
      let num = rest;
      if (!num && m.quoted?.sender) num = m.quoted.sender;
      if (!num && m.mentions?.[0]) num = m.mentions[0];
      if (!num) return m.reply(`_Usage: *${prefix}statuswatch remove 234xxxxxxxxxx*_`);
      const res = sw.remove(num);
      if (!res.removed) return m.reply(`_Not in watch list:_ \`${num}\``);
      return m.reply(`✓ Removed. Watching *${res.total}* contact(s) now.`);
    }

    return m.reply(help);
  },
};
