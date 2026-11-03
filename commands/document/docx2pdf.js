const fs = require('fs');
const path = require('path');
const { execFile } = require('child_process');
const { promisify } = require('util');
const execFileAsync = promisify(execFile);

const PROJECT_ROOT = process.env.CODEX_PROJECT_ROOT || path.join(__dirname, '..', '..');

const DOCX_MIME = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';
const DOC_MIME = 'application/msword';

function isWordDoc(quoted) {
    if (!quoted) return false;
    const mtype = quoted.mtype || quoted.type || '';
    const mime = String(quoted.mimetype || quoted.mime || '').toLowerCase();
    const name = String(quoted.fileName || quoted.filename || '').toLowerCase();

    if (name.endsWith('.docx') || name.endsWith('.doc')) return true;
    if (mime.includes('wordprocessingml') || mime === DOC_MIME || mime.includes('msword')) return true;
    if (mtype === 'documentMessage' && (name.endsWith('.docx') || name.endsWith('.doc'))) return true;
    return false;
}

function findLibreOffice() {
    const candidates = [
        process.env.LIBREOFFICE_PATH,
        'libreoffice',
        'soffice',
        '/usr/bin/libreoffice',
        '/usr/bin/soffice',
        '/usr/lib/libreoffice/program/soffice',
        '/Applications/LibreOffice.app/Contents/MacOS/soffice',
    ].filter(Boolean);

    for (const bin of candidates) {
        try {
            if (bin.includes('/') || bin.includes('\\')) {
                if (fs.existsSync(bin)) return bin;
            } else {
                return bin;
            }
        } catch {}
    }
    return 'libreoffice';
}

module.exports = {
    name: 'docx2pdf',
    aliases: ['doctopdf', 'word2pdf', 'doc2pdf'],
    category: 'documents',
    reactions: { start: '📄' },
    description: 'Convert a replied .docx / .doc file to PDF.',

    async execute(bot, m, args) {
        const prefix = bot.prefix || '.';
        const quoted = m.quoted;

        if (!quoted || !isWordDoc(quoted)) {
            return await m.reply(
                `_Reply to a Word file (.docx / .doc) with *${prefix}docx2pdf*_\n` +
                `_Aliases: doc2pdf, word2pdf, doctopdf_`
            );
        }

        const srcName = quoted.fileName || quoted.filename || 'document.docx';
        const lower = srcName.toLowerCase();
        const ext = lower.endsWith('.doc') && !lower.endsWith('.docx') ? '.doc' : '.docx';
        const base = path.basename(srcName, path.extname(srcName)).replace(/[^\w.\-()+ ]+/g, '_') || 'document';
        const outName = `${base}.pdf`;

        const tempDir = path.join(PROJECT_ROOT, 'temp', 'docx2pdf');
        fs.mkdirSync(tempDir, { recursive: true });

        const stamp = `${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
        const workDir = path.join(tempDir, stamp);
        fs.mkdirSync(workDir, { recursive: true });

        const inPath = path.join(workDir, `input${ext}`);
        const outPath = path.join(workDir, `input.pdf`);

        const cleanup = () => {
            try { fs.rmSync(workDir, { recursive: true, force: true }); } catch {}
        };

        try {
            await m.reply('📄 Converting Word → PDF…');

            const buffer = await quoted.download();
            if (!buffer || buffer.length < 50) {
                cleanup();
                return await m.reply('❌ Failed to download the document.');
            }

            fs.writeFileSync(inPath, buffer);

            const bin = findLibreOffice();
            try {
                await execFileAsync(
                    bin,
                    [
                        '--headless',
                        '--nologo',
                        '--nofirststartwizard',
                        '--norestore',
                        '--convert-to', 'pdf',
                        '--outdir', workDir,
                        inPath,
                    ],
                    { timeout: 120000, maxBuffer: 8 * 1024 * 1024 }
                );
            } catch (e) {
                cleanup();
                const msg = String(e?.message || e);
                if (/ENOENT|not found|spawn/i.test(msg)) {
                    return await m.reply(
                        '❌ LibreOffice is not installed on this server.\n' +
                        '_Install `libreoffice` (or set LIBREOFFICE_PATH) then try again._'
                    );
                }
                console.error('[DOCX2PDF] convert error:', msg);
                return await m.reply(`❌ Conversion failed.\n_${msg.slice(0, 180)}_`);
            }

            if (!fs.existsSync(outPath)) {
                const alt = fs.readdirSync(workDir).find((f) => f.toLowerCase().endsWith('.pdf'));
                if (!alt) {
                    cleanup();
                    return await m.reply('❌ Conversion finished but no PDF was produced.');
                }
                const altPath = path.join(workDir, alt);
                const pdfBuffer = fs.readFileSync(altPath);
                const sizeKB = (pdfBuffer.length / 1024).toFixed(1);
                await bot.sendMessage(m.chat, {
                    document: pdfBuffer,
                    mimetype: 'application/pdf',
                    fileName: outName,
                    caption: `*📄 DOCX → PDF*\n*File:* ${outName}\n*Size:* ${sizeKB} KB`,
                }, { quoted: m });
                cleanup();
                return;
            }

            const pdfBuffer = fs.readFileSync(outPath);
            if (!pdfBuffer.length) {
                cleanup();
                return await m.reply('❌ PDF file is empty.');
            }

            const sizeKB = (pdfBuffer.length / 1024).toFixed(1);
            await bot.sendMessage(m.chat, {
                document: pdfBuffer,
                mimetype: 'application/pdf',
                fileName: outName,
                caption: `*📄 DOCX → PDF*\n*File:* ${outName}\n*Size:* ${sizeKB} KB`,
            }, { quoted: m });

            cleanup();
        } catch (err) {
            cleanup();
            console.error('[DOCX2PDF ERROR]', err.message);
            await m.reply(`❌ ${err.message || 'Conversion failed.'}`);
        }
    },
};
