module.exports = {
    name: 'ping',
    alias: ['speed', 'latency', 'test'],
    desc: 'Check bot response speed',
    category: 'Bot',
    reactions: { start: '⏳' },

    execute: async (sock, m, { reply }) => {
        const start = Date.now();

        // Send initial "PINGING..." message
        const pingMsg = await reply('_dex is checking speed..._');

        const ms = Date.now() - start;

        // Distinctive reply — unique to CodexABQ fork so you know updates landed
        await sock.sendMessage(m.chat, {
            edit: pingMsg.key,
            text: `_dex online_ ⚡ *${ms}ms*\n_no stress, we dey sharp_ `
        });
    }
};
