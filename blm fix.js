const { makeWASocket, useMultiFileAuthState, DisconnectReason } = require('baileys');
const pino = require('pino');
const chalk = require('chalk');
const qrcode = require('qrcode-terminal');
const handleLenwyCommand = require('./lenwy'); // Handler untuk perintah di lenwy.js
const agentAI = require('./scrape/agentAI'); // Asumsi ini untuk AI
require('dotenv').config();
const db = require('./db'); // Koneksi database Anda
const express = require('express');
const cors = require('cors');

let sock; // Deklarasi sock di scope global

// Objek untuk melacak tiket aktif yang pesannya sedang dicatat
// Format: { 'senderJid': { ticketId: 123, status: 'open' } }
let activeUserTickets = {};

async function startBot() {
    const { state, saveCreds } = await useMultiFileAuthState('./session');

    sock = makeWASocket({
        logger: pino({ level: 'silent' }),
        auth: state,
        browser: ['Ubuntu', 'Chrome', '119.0.0.0'], // Contoh browser
    });

    async function listJoinedGroups(currentSock) {
        try {
            const groups = await currentSock.groupFetchAllParticipating();
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
                    [id, '', name] // location_code bisa diupdate manual atau via perintah lain
                );
            }
        } catch (error) {
            console.error(chalk.red('❌ Gagal mengambil atau menyimpan daftar grup:'), error);
        }
    }

    // Fungsi untuk inisialisasi activeUserTickets dari DB saat bot start/restart
    async function initializeActiveTickets() {
        try {
            const [openTickets] = await db.query("SELECT id, sender FROM tickets WHERE status = 'open'");
            activeUserTickets = {}; // Reset dulu
            openTickets.forEach(ticket => {
                if (ticket.sender && ticket.id) {
                    activeUserTickets[ticket.sender] = { ticketId: ticket.id, status: 'open' };
                }
            });
            console.log(chalk.cyan(`[INIT] Inisialisasi pencatatan tiket aktif untuk ${Object.keys(activeUserTickets).length} pengguna.`));
        } catch (error) {
            console.error(chalk.red('[INIT] Gagal inisialisasi tiket aktif dari DB:'), error);
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
            await initializeActiveTickets(); // Panggil inisialisasi tiket aktif
        } else if (connection === 'close') {
            const shouldReconnect = (lastDisconnect?.error)?.output?.statusCode !== DisconnectReason.loggedOut;
            console.log(chalk.red(`❌ Koneksi terputus. Mencoba menghubungkan kembali: ${shouldReconnect}`));
            if (shouldReconnect) {
                setTimeout(startBot, 5000); // Coba lagi setelah 5 detik
            } else {
                console.log(chalk.red('❌ Tidak dapat terhubung, keluar...'));
            }
        }
    });

    sock.ev.on('creds.update', saveCreds);

    sock.ev.on('messages.upsert', async ({ messages }) => {
        const msg = messages[0];
        if (!msg.message || msg.key.fromMe) return;

        const sender = msg.key.remoteJid;
        let textContent = ''; // Pastikan textContent selalu string

        // Ekstraksi teks dari berbagai jenis pesan
        if (msg.message.conversation) {
            textContent = msg.message.conversation;
        } else if (msg.message.extendedTextMessage && msg.message.extendedTextMessage.text) {
            textContent = msg.message.extendedTextMessage.text;
        } else if (msg.message.buttonsResponseMessage && msg.message.buttonsResponseMessage.selectedDisplayText) {
            textContent = msg.message.buttonsResponseMessage.selectedDisplayText; // Untuk button response
        } else if (msg.message.listResponseMessage && msg.message.listResponseMessage.title) {
            textContent = msg.message.listResponseMessage.title; // Untuk list response
        }
        // Tambahkan jenis pesan lain jika perlu (misal: image caption)

        const name = msg.pushName || 'User'; // Nama pengguna
        const body = textContent.trim(); // Gunakan 'body' untuk konten teks yang sudah diproses

        console.log(chalk.cyan(`[MSG IN] Dari: ${name} (${sender}), Isi: "${body}"`));

        if (body.startsWith('!')) {
            // Tangani perintah
            try {
                // Kirim objek msg utuh jika lenwy.js butuh lebih dari sekadar teks (misal untuk quote)
                // dan kirim activeUserTickets untuk diupdate oleh command handler
                await handleLenwyCommand(sock, msg, body, activeUserTickets);
            } catch (err) {
                console.error(chalk.red('❌ Gagal menjalankan perintah Lenwy:'), err);
                // await sock.sendMessage(sender, { text: "Maaf, ada kesalahan internal saat memproses perintah Anda." });
            }
        } else {
            // Tangani pesan non-perintah
            // 1. Cek tiket aktif dan simpan pesan jika ada
            if (activeUserTickets[sender] && activeUserTickets[sender].status === 'open') {
                const activeInfo = activeUserTickets[sender];
                const activeTicketId = activeInfo.ticketId;

                // Verifikasi status tiket langsung dari DB sebelum mencatat (lebih aman)
                try {
                    const [ticketRows] = await db.query('SELECT status FROM tickets WHERE id = ? AND sender = ?', [activeTicketId, sender]);
                    if (ticketRows.length > 0 && ticketRows[0].status === 'open') {
                        await db.query(
                            'INSERT INTO messages (ticket_id, sender, name, message, is_from_user, created_at) VALUES (?, ?, ?, ?, ?, NOW())',
                            [activeTicketId, sender, name, body, 1] // is_from_user = 1
                        );
                        console.log(chalk.blueBright(`[TIKET ${activeTicketId}] Pesan dari ${name} ("${body}") berhasil disimpan.`));
                    } else {
                        // Tiket tidak lagi 'open' di DB atau ketidaksesuaian sender
                        console.log(chalk.yellow(`[TIKET] Tiket ${activeTicketId} untuk ${sender} tidak lagi aktif di DB. Menonaktifkan pencatatan.`));
                        delete activeUserTickets[sender]; // Hapus dari pelacakan aktif
                    }
                } catch (dbError) {
                     console.error(chalk.red(`[TIKET ${activeTicketId}] Error DB saat menyimpan pesan atau cek status:`), dbError);
                }
            }

            // 2. Proses dengan AI (jika ada dan pesan tidak kosong)
            if (body.length > 0) { // Hindari mengirim pesan kosong ke AI
                try {
                    const response = await agentAI(body); // Panggil AI Anda
                    await sock.sendPresenceUpdate('composing', sender);
                    await new Promise(resolve => setTimeout(resolve, 1000)); // Delay singkat
                    await sock.sendPresenceUpdate('paused', sender);
                    await sock.sendMessage(sender, { text: response });
                } catch (err) {
                    console.error(chalk.red("❌ Error ProAI:"), err);
                    // await sock.sendMessage(sender, { text: `❌ Terjadi kesalahan saat menghubungi ProAI.` });
                }
            } else {
                console.log(chalk.grey(`[MSG IN] Pesan kosong dari ${name}, tidak dikirim ke AI.`));
            }
        }
    });
}

startBot().catch(err => console.error("❌ Gagal memulai bot:", err));

// --- Konfigurasi Server Express untuk API ---
const app = express();
const PORT = process.env.PORT || 4000;
app.use(cors());
app.use(express.json());

app.get('/', (req, res) => {
    res.send('🤖 WhatsApp bot ticketing system is running!');
});

// GET semua tiket (contoh)
app.get('/tickets', async (req, res) => {
    try {
        const [rows] = await db.query('SELECT * FROM tickets ORDER BY created_at DESC');
        res.json({ success: true, data: rows });
    } catch (error) {
        console.error('❌ Gagal mengambil tiket:', error.message);
        res.status(500).json({ success: false, message: 'Gagal mengambil tiket' });
    }
});

// GET detail tiket dan pesannya (contoh)
app.get('/ticket/:id', async (req, res) => {
    const ticketId = req.params.id;
    try {
        const [ticketRows] = await db.query('SELECT * FROM tickets WHERE id = ?', [ticketId]);
        if (ticketRows.length === 0) {
            return res.status(404).json({ success: false, message: 'Tiket tidak ditemukan' });
        }
        const ticket = ticketRows[0];
        const [messageRows] = await db.query('SELECT * FROM messages WHERE ticket_id = ? ORDER BY created_at ASC', [ticketId]);
        res.json({ success: true, ticket, messages: messageRows });
    } catch (error) {
        console.error(`❌ Gagal mengambil detail tiket ${ticketId}:`, error.message);
        res.status(500).json({ success: false, message: 'Gagal mengambil detail tiket' });
    }
});


// PATCH untuk update status tiket (misal: closed)
app.patch('/ticket/status/:id', async (req, res) => {
    const ticketId = req.params.id;
    const { status } = req.body;

    if (!status || (status !== 'open' && status !== 'closed')) {
        return res.status(400).json({ success: false, message: 'Status harus "open" atau "closed"' });
    }

    try {
        const [result] = await db.query(
            'UPDATE tickets SET status = ?, updated_at = NOW() WHERE id = ?',
            [status, ticketId]
        );

        if (result.affectedRows === 0) {
            return res.status(404).json({ success: false, message: 'Tiket tidak ditemukan' });
        }

        // Jika status diubah menjadi 'closed'
        if (status === 'closed') {
            const [[ticketDetails]] = await db.query('SELECT id, sender FROM tickets WHERE id = ?', [ticketId]);
            if (ticketDetails && ticketDetails.sender) {
                const userJid = ticketDetails.sender;
                // Hapus dari activeUserTickets jika tiket yang ditutup adalah yang sedang dilacak
                if (activeUserTickets[userJid] && activeUserTickets[userJid].ticketId == ticketDetails.id) { // Gunakan == karena tipe bisa berbeda
                    delete activeUserTickets[userJid];
                    console.log(chalk.magenta(`[API] Pencatatan pesan untuk pengguna ${userJid} pada tiket ${ticketDetails.id} dihentikan (tiket ditutup).`));
                }
                // Kirim notifikasi ke pengguna jika bot terhubung
                if (sock) {
                    await sock.sendMessage(userJid, { text: `Pemberitahuan: Tiket Anda #${ticketDetails.id} telah ditutup. Sesi pencatatan pesan untuk tiket ini telah berakhir.` });
                }
            } else {
                console.log(chalk.yellow(`[API] Tiket ${ticketId} ditutup, tetapi sender tidak ditemukan atau tidak ada sesi pencatatan aktif untuk dibersihkan.`));
            }
        }
        res.json({ success: true, message: `Status tiket ${ticketId} berhasil diubah menjadi ${status}` });
    } catch (error) {
        console.error(`❌ Gagal update status tiket ${ticketId}:`, error);
        res.status(500).json({ success: false, message: 'Gagal update status tiket' });
    }
});

// POST untuk mengirim pesan balasan dari admin/dashboard ke pengguna via WhatsApp
app.post('/send-message', async (req, res) => {
    const { ticket_id, message, sender_admin_name = 'Admin' } = req.body; // sender_admin_name opsional

    if (!ticket_id || !message) {
        return res.status(400).json({ success: false, message: 'ticket_id dan message wajib diisi' });
    }
    if (!sock) {
        return res.status(503).json({ success: false, message: 'Bot WhatsApp tidak terhubung.' });
    }

    try {
        const [ticketRows] = await db.query('SELECT sender FROM tickets WHERE id = ? AND status = "open"', [ticket_id]);
        if (ticketRows.length === 0) {
            return res.status(404).json({ success: false, message: 'Tiket tidak ditemukan atau sudah ditutup.' });
        }
        const recipient = ticketRows[0].sender;

        // Kirim pesan via WhatsApp
        await sock.sendMessage(recipient, { text: `Balasan untuk tiket #${ticket_id}:\n\n${message}` });

        // Simpan pesan dari admin ke tabel messages
        await db.query(
            `INSERT INTO messages (ticket_id, sender, name, message, is_from_user, created_at)
             VALUES (?, ?, ?, ?, ?, NOW())`,
            [ticket_id, 'admin_dashboard', sender_admin_name, message, 0] // is_from_user = 0 untuk admin
        );
        res.json({ success: true, message: 'Pesan berhasil dikirim dan dicatat' });
    } catch (err) {
        console.error('❌ Gagal mengirim pesan balasan:', err);
        res.status(500).json({ success: false, message: 'Gagal mengirim pesan balasan' });
    }
});


app.listen(PORT, () => {
    console.log(chalk.inverse(`🚀 Server Express berjalan di http://localhost:${PORT}`));
});
