const { makeWASocket, useMultiFileAuthState, DisconnectReason } = require('baileys');
const pino = require('pino');
const chalk = require('chalk');
const qrcode = require('qrcode-terminal');
const handleLenwyCommand = require('./lenwy'); // Akan dimodifikasi
const agentAI = require('./scrape/agentAI');
require('dotenv').config();
const db = require('./db');
// const lenwyHandler = require('./lenwy'); // lenwyHandler tidak digunakan, handleLenwyCommand yang dipakai

// Untuk melacak tiket aktif per pengguna { "sender_jid": ticket_id }
const activeUserTickets = {};

let sock;
async function startBot() {
    const { state, saveCreds } = await useMultiFileAuthState('./session');

    sock = makeWASocket({
        logger: pino({ level: 'silent' }),
        auth: state,
        browser: ['Ubuntu', 'Chrome', '119.0.0.0'], // Contoh browser
    });

    async function listJoinedGroups(sockInstance) {
        try {
            const groups = await sockInstance.groupFetchAllParticipating();
            const groupIds = Object.keys(groups);
            console.log(chalk.blue('\n📋 Bot saat ini ada di grup-grup berikut:\n'));
            for (let i = 0; i < groupIds.length; i++) {
                const id = groupIds[i];
                const group = groups[id];
                const name = group.subject;
                console.log(`${i + 1}. ${name} (${id})`);
                await db.query(
                    `INSERT INTO wa_groups (group_id, location_code, group_name)
                     VALUES (?, ?, ?)
                     ON DUPLICATE KEY UPDATE group_name = VALUES(group_name)`,
                    [id, '', name] // location_code default kosong
                );
            }
        } catch (error) {
            console.error('❌ Gagal mengambil atau menyimpan daftar grup:', error);
        }
    }

    sock.ev.on('connection.update', async (update) => {
        const { connection, qr, lastDisconnect } = update;
        if (qr) {
            console.log(chalk.yellow('📱 Scan QR berikut dengan WhatsApp kamu:'));
            qrcode.generate(qr, { small: true });
        }
        if (connection === 'open') {
            console.log(chalk.green('✅ Bot berhasil terhubung ke WhatsApp!'));
            await listJoinedGroups(sock);
        } else if (connection === 'close') {
            const shouldReconnect = (lastDisconnect?.error)?.output?.statusCode !== DisconnectReason.loggedOut;
            console.log(chalk.red(`❌ Koneksi terputus. Reconnect: ${shouldReconnect}`), lastDisconnect?.error);
            if (shouldReconnect) startBot();
        }
    });

    sock.ev.on('creds.update', saveCreds);

    sock.ev.on('messages.upsert', async ({ messages }) => {
        const msg = messages[0];
        if (!msg.message || msg.key.fromMe) return;

        const sender = msg.key.remoteJid;
        const text = msg.message.conversation || msg.message.extendedTextMessage?.text || '';
        const name = msg.pushName || 'User'; // Nama pengguna dari WhatsApp

        console.log(chalk.cyan(`[Pesan dari: ${name} (${sender})] ${text}`));

        // 1. Cek apakah pengguna memiliki tiket aktif dan pesan bukan perintah
        if (activeUserTickets[sender] && !text.startsWith('!')) {
            const ticketId = activeUserTickets[sender];
            try {
                // Pastikan tiket masih berstatus 'open' di database
                const [ticketRows] = await db.query('SELECT status FROM tickets WHERE id = ?', [ticketId]);
                if (ticketRows.length > 0 && ticketRows[0].status === 'open') {
                    // Simpan pesan ke tabel messages
                    await db.query(
                        'INSERT INTO messages (ticket_id, sender, name, message, is_from_user, created_at) VALUES (?, ?, ?, ?, 1, ?)',
                        [ticketId, sender, name, text, new Date()]
                    );
                    console.log(chalk.greenBright(`📝 Pesan dari ${name} disimpan ke tiket #${ticketId}`));
                    // Opsional: kirim konfirmasi kecil ke pengguna, atau biarkan silent
                    // await sock.sendMessage(sender, { text: `✓ Pesan Anda telah ditambahkan ke tiket #${ticketId}` });
                    return; // Pesan sudah ditangani sebagai bagian dari tiket aktif
                } else {
                    // Jika tiket sudah tidak 'open' atau tidak ditemukan, hapus dari activeUserTickets
                    console.log(chalk.yellow(`Tiket #${ticketId} untuk ${sender} tidak lagi aktif atau tidak ditemukan. Menghapus dari pelacakan.`));
                    delete activeUserTickets[sender];
                }
            } catch (dbError) {
                console.error(`❌ Gagal menyimpan pesan ke tiket #${ticketId} untuk ${sender}:`, dbError);
            }
        }

        // 2. Jika pesan adalah perintah (dimulai dengan '!')
        if (text.startsWith('!')) {
            try {
                // Kirim activeUserTickets agar bisa dimodifikasi oleh !tiket
                await handleLenwyCommand(sock, { messages }, activeUserTickets, db);
            } catch (err) {
                console.error('❌ Gagal menjalankan perintah Lenwy:', err);
                await sock.sendMessage(sender, { text: `❌ Gagal menjalankan perintah: ${err.message}` });
            }
        }
        // 3. Jika bukan perintah dan tidak ada tiket aktif (logika AI atau balasan default)
        else if (!activeUserTickets[sender]) { // Tambahan kondisi untuk memastikan tidak ada tiket aktif
            try {
                const response = await agentAI(text);
                await sock.sendPresenceUpdate('composing', sender);
                await new Promise(resolve => setTimeout(resolve, 1500)); // Delay
                await sock.sendPresenceUpdate('paused', sender);
                await sock.sendMessage(sender, { text: response });
            } catch (err) {
                console.error("❌ Error ProAI:", err);
                await sock.sendMessage(sender, { text: `❌ Terjadi kesalahan saat menghubungi ProAI: ${err.message}` });
            }
        }
    });
}

startBot();

// Server Express untuk API
const express = require('express');
const cors = require('cors');
const app = express();
const PORT = process.env.PORT || 4000; // Gunakan env variable untuk port jika ada

app.use(cors());
app.use(express.json());

app.get('/', (req, res) => {
    res.send('🤖 WhatsApp bot dan API Helpdesk berjalan!');
});

app.get('/tickets', async (req, res) => {
    try {
        const [rows] = await db.query('SELECT * FROM tickets ORDER BY updated_at DESC, created_at DESC');
        res.json({ success: true, data: rows });
    } catch (error) {
        console.error('❌ Gagal mengambil daftar tiket:', error.message);
        res.status(500).json({ success: false, error: 'Gagal mengambil daftar tiket', message: error.message });
    }
});

app.post('/send-message', async (req, res) => {
    const { ticket_id, message } = req.body;

    if (!ticket_id || !message) {
        return res.status(400).json({ success: false, error: 'ticket_id dan message wajib diisi' });
    }

    try {
        const [ticketRows] = await db.query(
            'SELECT sender, status FROM tickets WHERE id = ?',
            [ticket_id]
        );

        if (ticketRows.length === 0) {
            return res.status(404).json({ success: false, error: 'Tiket tidak ditemukan' });
        }

        const recipient = ticketRows[0].sender;
        const ticketStatus = ticketRows[0].status;

        if (!recipient) {
            return res.status(400).json({ success: false, error: 'Nomor pengirim pada tiket tidak valid' });
        }

        if (ticketStatus === 'closed') {
             await db.query( // Tetap simpan pesan admin meskipun tiket ditutup, tapi beri info
                `INSERT INTO messages (ticket_id, sender, name, message, is_from_user, created_at)
                 VALUES (?, ?, ?, ?, 0, ?)`,
                [ticket_id, 'admin', 'Agen Helpdesk', `(Info) Pesan saat tiket ditutup: ${message}`, new Date()]
            );
            return res.status(400).json({ success: false, error: 'Tidak dapat mengirim pesan, tiket sudah ditutup. Pesan dicatat sebagai info internal.' });
        }

        // Kirim pesan via WhatsApp
        await sock.sendMessage(recipient, { text: message });

        // Simpan log pesan dari admin
        await db.query(
            `INSERT INTO messages (ticket_id, sender, name, message, is_from_user, created_at)
             VALUES (?, ?, ?, ?, 0, ?)`, // is_from_user: 0 untuk admin
            [ticket_id, 'admin', 'Agen Helpdesk', message, new Date()]
        );
        
        // Update `updated_at` pada tiket
        await db.query('UPDATE tickets SET updated_at = ? WHERE id = ?', [new Date(), ticket_id]);

        res.json({ success: true, message: 'Pesan berhasil dikirim dan dicatat' });

    } catch (err) {
        console.error('❌ Gagal mengirim pesan admin:', err);
        res.status(500).json({ success: false, error: 'Gagal mengirim pesan', message: err.message });
    }
});

app.get('/ticket/:id', async (req, res) => {
    const ticketId = req.params.id;
    if (isNaN(parseInt(ticketId))) {
        return res.status(400).json({ error: 'ID Tiket tidak valid' });
    }

    try {
        const [ticketRows] = await db.query('SELECT * FROM tickets WHERE id = ?', [ticketId]);
        if (ticketRows.length === 0) {
            return res.status(404).json({ error: 'Tiket tidak ditemukan' });
        }
        const ticket = ticketRows[0];

        const [messageRows] = await db.query('SELECT * FROM messages WHERE ticket_id = ? ORDER BY created_at ASC', [ticketId]);

        const formattedMessages = messageRows.map(msg => ({
            id: msg.id, // Menggunakan ID asli dari database
            sender_id: msg.sender, // JID atau 'admin'
            sender: msg.name || (msg.is_from_user ? ticket.name : 'Agen Helpdesk'), // Nama yang ditampilkan
            text: msg.message,
            timestamp: msg.created_at.toISOString(),
            type: msg.is_from_user ? 'user' : 'agent' // Menggunakan is_from_user
        }));
        
        const createdAtDate = new Date(ticket.created_at);
        const displayTicketId = `TICKET-${createdAtDate.getFullYear()}${String(createdAtDate.getMonth() + 1).padStart(2, '0')}${String(createdAtDate.getDate()).padStart(2, '0')}-${String(ticket.id).padStart(3, '0')}`;

        const response = {
            db_id: ticket.id,
            id: displayTicketId,
            subject: ticket.message?.split('\n')[0] || 'Tanpa Subjek',
            user: ticket.name, // Nama pelapor tiket
            email: ticket.sender, // JID pelapor tiket
            status: ticket.status === 'open' ? 'Open' : 'Close', // Konsisten dengan App.jsx
            createdAt: ticket.created_at.toISOString(),
            updatedAt: ticket.updated_at.toISOString(),
            // 'agent' bisa diambil dari pesan pertama yang bukan dari user, atau default
            agent: formattedMessages.find(m => m.type === 'agent')?.sender || 'Belum ada balasan agen',
            messages: formattedMessages,
            location_code: ticket.location_code
        };
        res.json(response);
    } catch (error) {
        console.error(`❌ Error mengambil detail tiket ${ticketId}:`, error);
        res.status(500).json({ error: 'Internal server error', message: error.message });
    }
});

app.patch('/ticket/status/:id', async (req, res) => {
    const ticketId = req.params.id;
    const { status } = req.body; // status harus 'open' atau 'closed' (lowercase)

    if (!status || (status !== 'open' && status !== 'closed')) {
        return res.status(400).json({ success: false, error: 'Status harus "open" atau "closed"' });
    }
     if (isNaN(parseInt(ticketId))) {
        return res.status(400).json({ error: 'ID Tiket tidak valid' });
    }

    try {
        const [ticketCheck] = await db.query('SELECT sender, status FROM tickets WHERE id = ?', [ticketId]);
        if (ticketCheck.length === 0) {
            return res.status(404).json({ success: false, error: 'Tiket tidak ditemukan' });
        }
        
        const currentTicketStatus = ticketCheck[0].status;
        if (currentTicketStatus === status) {
             return res.json({ success: true, message: `Status tiket sudah ${status}` });
        }

        const [result] = await db.query('UPDATE tickets SET status = ?, updated_at = ? WHERE id = ?', [status, new Date(), ticketId]);

        if (result.affectedRows === 0) {
            // Seharusnya tidak terjadi karena sudah dicek di atas
            return res.status(404).json({ success: false, error: 'Tiket tidak ditemukan saat update' });
        }

        const userJid = ticketCheck[0].sender;

        if (status === 'closed') {
            // Hapus dari activeUserTickets jika tiket ditutup
            if (activeUserTickets[userJid] && activeUserTickets[userJid] === parseInt(ticketId)) {
                delete activeUserTickets[userJid];
                console.log(chalk.blue(`🗑️ Tiket aktif untuk ${userJid} (ID: ${ticketId}) telah dihapus karena status diubah menjadi 'closed'.`));
            }
            // Kirim notifikasi ke pengguna bahwa tiketnya ditutup
            if (userJid && sock) {
                await sock.sendMessage(userJid, { text: `ℹ️ Tiket Anda dengan ID #${ticketId} telah ditutup.` });
            }
        } else if (status === 'open') {
            // Jika tiket dibuka kembali, tambahkan kembali ke activeUserTickets agar pengguna bisa lanjut membalas
             activeUserTickets[userJid] = parseInt(ticketId);
             console.log(chalk.blue(` Tiket untuk ${userJid} (ID: ${ticketId}) dibuka kembali dan ditambahkan ke pelacakan aktif.`));
             if (userJid && sock) {
                await sock.sendMessage(userJid, { text: `ℹ️ Tiket Anda dengan ID #${ticketId} telah dibuka kembali. Anda dapat melanjutkan percakapan.` });
            }
        }

        res.json({ success: true, message: `Status tiket #${ticketId} berhasil diperbarui menjadi ${status}` });
    } catch (error) {
        console.error(`❌ Error memperbarui status tiket ${ticketId}:`, error);
        res.status(500).json({ success: false, error: 'Internal server error', message: error.message });
    }
});

app.listen(PORT, () => {
    console.log(chalk.magentaBright(`🚀 Server Express berjalan di http://localhost:${PORT}`));
});
