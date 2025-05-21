const { makeWASocket, useMultiFileAuthState, DisconnectReason } = require('baileys');
const pino = require('pino');
const chalk = require('chalk');
const qrcode = require('qrcode-terminal'); 
const handleLenwyCommand = require('./lenwy');
async function startBot() {
    const { state, saveCreds } = await useMultiFileAuthState('./session');

    const sock = makeWASocket({
        logger: pino({ level: 'silent' }),
        auth: state,
        browser: ['Ubuntu', 'Chrome', '119.0.0.0'],
    });

    // Tampilkan QR code saat tersedia
    sock.ev.on('connection.update', (update) => {
        const { connection, qr, lastDisconnect } = update;

        if (qr) {
            console.log(chalk.yellow('📱 Scan QR berikut dengan WhatsApp kamu:'));
            qrcode.generate(qr, { small: true }); // 👉 Tampilkan QR di terminal
        }

        if (connection === 'open') {
            console.log(chalk.green('✅ Bot berhasil terhubung ke WhatsApp!'));
        } else if (connection === 'close') {
            const shouldReconnect = (lastDisconnect?.error)?.output?.statusCode !== DisconnectReason.loggedOut;
            console.log(chalk.red('❌ Koneksi terputus. Reconnect?'), shouldReconnect);
            if (shouldReconnect) startBot();
        }
    });

    sock.ev.on('creds.update', saveCreds);

    sock.ev.on('messages.upsert', async ({ messages }) => {
    const msg = messages[0];
    if (!msg.message || msg.key.fromMe) return;

    const sender = msg.key.remoteJid;
    const text = msg.message.conversation || msg.message.extendedTextMessage?.text || '';
    const name = msg.pushName || 'User';

    console.log(chalk.cyan(`[${name}] ${text}`));

    // Balasan default (jika ingin tetap ada)
    // await sock.sendMessage(sender, { text: `Halo ${name}, kamu mengirim: ${text}` });

    // 👉 Panggil handler perintah dari lenwy.js
    try {
        await handleLenwyCommand(sock, { messages });
    } catch (err) {
        console.error('❌ Gagal menjalankan perintah Lenwy:', err);
    }
});
}

startBot();
