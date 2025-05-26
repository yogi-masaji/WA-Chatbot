const { makeWASocket, useMultiFileAuthState, DisconnectReason } = require('baileys');
const pino = require('pino');
const chalk = require('chalk');
const qrcode = require('qrcode-terminal'); 
const handleLenwyCommand = require('./lenwy');
  const agentAI = require('./scrape/agentAI');
require('dotenv').config();
const db = require('./db');
const lenwyHandler = require('./lenwy');

let sock; // Deklarasikan sock di scope global
async function startBot() {
    const { state, saveCreds } = await useMultiFileAuthState('./session');

     sock = makeWASocket({
        logger: pino({ level: 'silent' }),
        auth: state,
        browser: ['Ubuntu', 'Chrome', '119.0.0.0'],
    });
    async function listJoinedGroups(sock) {
    try {
        const groups = await sock.groupFetchAllParticipating();
        const groupIds = Object.keys(groups);

        console.log(chalk.blue('\n📋 Bot saat ini ada di grup-grup berikut:\n'));

        for (let i = 0; i < groupIds.length; i++) {
            const id = groupIds[i];
            const group = groups[id];
            const name = group.subject;

            console.log(`${i + 1}. ${name} (${id})`);

            // Default: masukkan dengan location_code NULL dulu
            await db.query(
                `INSERT INTO wa_groups (group_id, location_code, group_name)
                 VALUES (?, ?, ?)
                 ON DUPLICATE KEY UPDATE group_name = VALUES(group_name)`,
                [id, '', name]
            );
        }
    } catch (error) {
        console.error('❌ Gagal mengambil atau menyimpan daftar grup:', error);
    }
}



    // Tampilkan QR code saat tersedia
    sock.ev.on('connection.update', async (update) => {
    const { connection, qr, lastDisconnect } = update;

    if (qr) {
        console.log(chalk.yellow('📱 Scan QR berikut dengan WhatsApp kamu:'));
        qrcode.generate(qr, { small: true });
    }

    if (connection === 'open') {
        console.log(chalk.green('✅ Bot berhasil terhubung ke WhatsApp!'));
        await listJoinedGroups(sock); // ✅ Ini sekarang boleh karena dalam async function
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


    const body = msg.message.conversation || msg.message.extendedTextMessage?.text || ""
    if (!body.startsWith('!')) {
        try {
            const response = await agentAI(body); // langsung kirim body sebagai prompt
            await sock.sendPresenceUpdate('composing', sender); // Mulai typing
await new Promise(resolve => setTimeout(resolve, 2000)); // Delay 3 detik
await sock.sendPresenceUpdate('paused', sender); // Hentikan typing
            await sock.sendMessage(sender, { text: response });
        } catch (err) {
            console.error("❌ Error ProAI:", err);
            await sock.sendMessage(sender, { text: `❌ Terjadi kesalahan saat menghubungi ProAI: ${err.message}` });
        }
        return; // Hentikan di sini, agar tidak lanjut ke bawah
    }

    try {
        

        await handleLenwyCommand(sock, { messages });
    } catch (err) {
        console.error('❌ Gagal menjalankan perintah Lenwy:', err);
    }
});
}



startBot();



// Tambah server HTTP untuk ngecek port aktif
const express = require('express');
const cors = require('cors');
const app = express();
const PORT = 4000;
app.use(cors());
app.use(express.json());

app.get('/', (req, res) => {
    res.send('🤖 WhatsApp bot is running!');
});

app.get('/tickets', async (req, res) => {
    try {
        const [rows] = await db.query('SELECT * FROM tickets ORDER BY created_at DESC');
        res.json({ success: true, data: rows });
    } catch (error) {
        console.error('❌ Failed to fetch tickets:', error.message);
        res.status(500).json({ success: false, message: 'Failed to fetch tickets' });
    }
});

app.post('/send-message', async (req, res) => {
    const { ticket_id, message } = req.body;

    if (!ticket_id || !message) {
        return res.status(400).json({ success: false, message: 'ticket_id dan message wajib diisi' });
    }

    try {
        // Ambil nomor user (sender) dari tiket
        const [ticketRows] = await db.query(
            'SELECT sender FROM tickets WHERE id = ?',
            [ticket_id]
        );

        if (ticketRows.length === 0) {
            return res.status(404).json({ success: false, message: 'Tiket tidak ditemukan' });
        }

        const recipient = ticketRows[0].sender;
        if (!recipient) {
            return res.status(400).json({ success: false, message: 'Nomor pengirim pada tiket tidak ditemukan' });
        }

        // Kirim pesan lewat WhatsApp dengan Baileys
        await sock.sendMessage(recipient, { text: message });

        // Simpan log pesan dari admin di tabel messages
        await db.query(
            `INSERT INTO messages (ticket_id, sender, message, created_at)
             VALUES (?, ?, ?, ?)`,
            [ticket_id, 'admin', message, new Date()]
        );

        res.json({ success: true, message: 'Pesan berhasil dikirim dan dicatat' });

    } catch (err) {
        console.error('❌ Gagal mengirim pesan:', err);
        res.status(500).json({ success: false, message: 'Gagal mengirim pesan' });
    }
});

// get all tickets
app.get('/tickets', async (req, res) => {
    try {
        const [rows] = await db.query('SELECT * FROM tickets ORDER BY created_at DESC');
        res.json({ success: true, data: rows });
    } catch (error) {
        console.error('❌ Failed to fetch tickets:', error.message);
        res.status(500).json({ success: false, message: 'Failed to fetch tickets' });
    }
});

// get ticket by ID
app.get('/ticket/:id', async (req, res) => {
const ticketId = req.params.id;

  try {
    const [ticketRows] = await db.query('SELECT * FROM tickets WHERE id = ?', [ticketId]);
    if (ticketRows.length === 0) {
      return res.status(404).json({ error: 'Ticket not found' });
    }

    const ticket = ticketRows[0];

    const [messageRows] = await db.query('SELECT * FROM messages WHERE ticket_id = ? ORDER BY created_at ASC', [ticketId]);

    const formattedMessages = messageRows.map(msg => ({
      id: 'msg' + msg.id,
      sender: msg.sender,
      text: msg.message,
      timestamp: msg.created_at.toISOString(),
      type: msg.sender === ticket.name ? 'user' : 'agent'
    }));

    const response = {
      id: `TICKET-${ticket.created_at.getFullYear()}${String(ticket.created_at.getMonth() + 1).padStart(2, '0')}${String(ticket.created_at.getDate()).padStart(2, '0')}-${String(ticket.id).padStart(3, '0')}`,
      subject: ticket.message?.split('\n')[0] || 'Tanpa Subjek',
      user: ticket.name,
      email: ticket.sender,
      status: ticket.status === 'open' ? 'Open' : 'Closed',
      createdAt: ticket.created_at.toISOString(),
      updatedAt: ticket.updated_at.toISOString(),
      priority: 'Medium', // placeholder, tambahkan kolom jika ingin dinamis
      agent: messageRows.find(m => m.sender !== ticket.name)?.sender || 'Belum ditugaskan',
      messages: formattedMessages
    };

    res.json(response);
  } catch (error) {
    console.error('Error fetching ticket:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});


app.listen(PORT, () => {
    console.log(chalk.green(`🚀 Server is listening on http://localhost:${PORT}`));
});
