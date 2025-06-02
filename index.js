const { makeWASocket, useMultiFileAuthState, DisconnectReason, isJidGroup } = require('baileys');
const pino = require('pino');
const chalk = require('chalk');
const qrcode = require('qrcode-terminal');
const handleLenwyCommand = require('./lenwy'); // Akan dimodifikasi
const agentAI = require('./scrape/agentAI');
require('dotenv').config(); // Make sure this is at the top
const db = require('./db');
const bcrypt = require('bcryptjs'); // For password hashing
const jwt = require('jsonwebtoken'); // For JWT

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
                // Asumsi Anda memiliki kolom 'group_id' dan 'group_name' di tabel wa_groups.
                // 'location_code' mungkin perlu diisi manual atau melalui mekanisme lain jika diperlukan.
                await db.query(
                    `INSERT INTO wa_groups (group_id, location_code, group_name)
                     VALUES (?, ?, ?)
                     ON DUPLICATE KEY UPDATE group_name = VALUES(group_name), location_code = IF(location_code IS NULL OR location_code = '', VALUES(location_code), location_code)`,
                    [id, '', name] // location_code default kosong, bisa diupdate nanti
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
        if (isJidGroup(sender)) {
            // Cek apakah pesan dari grup adalah perintah yang diizinkan atau relevan
            // Untuk saat ini, kita abaikan pesan dari grup kecuali ada logika khusus
            // console.log(chalk.yellow(`[Group Message Ignored] From: ${sender}`));
            // return; // Jika ingin mengabaikan semua pesan grup
        }

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
                    return; // Pesan sudah ditangani sebagai bagian dari tiket aktif
                } else {
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
                await handleLenwyCommand(sock, { messages }, activeUserTickets, db);
            } catch (err) {
                console.error('❌ Gagal menjalankan perintah Lenwy:', err);
                await sock.sendMessage(sender, { text: `❌ Gagal menjalankan perintah: ${err.message}` });
            }
        }
        // 3. Jika bukan perintah dan tidak ada tiket aktif (logika AI atau balasan default)
        else if (!activeUserTickets[sender] && !isJidGroup(sender)) { // Tambahan kondisi untuk memastikan tidak ada tiket aktif dan bukan dari grup
            try {
                const aiResponseObject = await agentAI(text);
                let originalContent = "";

                if (aiResponseObject && aiResponseObject.choices && aiResponseObject.choices[0] && aiResponseObject.choices[0].message && aiResponseObject.choices[0].message.content) {
                    originalContent = aiResponseObject.choices[0].message.content;
                } else if (typeof aiResponseObject === 'string') {
                    originalContent = aiResponseObject;
                } else {
                    console.error("❌ Error ProAI: Struktur respons tidak dikenal dari agentAI", aiResponseObject);
                    await sock.sendMessage(sender, { text: `❌ Terjadi kesalahan: Struktur respons AI tidak dikenali.` });
                    return;
                }

                const cleanContent = originalContent
                    .replace(/\[\d+(?:,\s*(?:pp\.|p\.)\s*[\d-]+)?\]/g, '')
                    .replace(/References:[\s\S]*$/, "Untuk panduan troubleshooting lebih lanjut, silakan kunjungi: https://bit.ly/Handbook-Panduan-Troubleshooting")
                    .trim();

                await sock.sendPresenceUpdate('composing', sender);
                await new Promise(resolve => setTimeout(resolve, 1500)); // Delay
                await sock.sendPresenceUpdate('paused', sender);
                await sock.sendMessage(sender, { text: cleanContent });

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
const PORT = process.env.PORT || 4000;
const JWT_SECRET = process.env.JWT_SECRET;

if (!JWT_SECRET) {
    console.error(chalk.red('FATAL ERROR: JWT_SECRET is not defined in .env file.'));
    process.exit(1);
}

app.use(cors());
app.use(express.json());


// JWT Authentication Middleware
function authenticateToken(req, res, next) {
    const authHeader = req.headers['authorization'];
    const token = authHeader && authHeader.split(' ')[1]; // Format: Bearer TOKEN

    if (token == null) {
        return res.status(401).json({ success: false, error: 'No token provided' });
    }

    jwt.verify(token, JWT_SECRET, (err, user) => {
        if (err) {
            console.error(chalk.yellow('⚠️ JWT Verification Error:'), err.message);
            return res.status(403).json({ success: false, error: 'Token is not valid' });
        }
        req.user = user; // Add payload to request object
        next();
    });
}


// Authentication Routes
const authRouter = express.Router();

// SIGN UP
authRouter.post('/signup', async (req, res) => {
    const { username, email, password } = req.body;

    if (!username || !email || !password) {
        return res.status(400).json({ success: false, error: 'Username, email, and password are required' });
    }
    if (!/\S+@\S+\.\S+/.test(email)) {
        return res.status(400).json({ success: false, error: 'Invalid email format' });
    }
    if (password.length < 6) {
        return res.status(400).json({ success: false, error: 'Password must be at least 6 characters long' });
    }

    try {
        const [existingUsers] = await db.query('SELECT id FROM users WHERE username = ? OR email = ?', [username, email]);
        if (existingUsers.length > 0) {
            return res.status(409).json({ success: false, error: 'Username or email already exists' });
        }

        const salt = await bcrypt.genSalt(10);
        const passwordHash = await bcrypt.hash(password, salt);

        const [result] = await db.query(
            'INSERT INTO users (username, email, password_hash) VALUES (?, ?, ?)',
            [username, email, passwordHash]
        );
        const userId = result.insertId;

        // Generate JWT
        const token = jwt.sign({ id: userId, username: username, email: email }, JWT_SECRET, { expiresIn: '1h' });

        res.status(201).json({ success: true, message: 'User registered successfully', userId: userId, token: token });

    } catch (error) {
        console.error('❌ Error during sign up:', error);
        res.status(500).json({ success: false, error: 'Server error during sign up', message: error.message });
    }
});

// SIGN IN
authRouter.post('/signin', async (req, res) => {
    const { email, password } = req.body;

    if (!email || !password) {
        return res.status(400).json({ success: false, error: 'Email and password are required' });
    }

    try {
        const [users] = await db.query('SELECT id, username, email, password_hash FROM users WHERE email = ?', [email]);
        if (users.length === 0) {
            return res.status(401).json({ success: false, error: 'Invalid credentials (email not found)' });
        }

        const user = users[0];
        const isMatch = await bcrypt.compare(password, user.password_hash);
        if (!isMatch) {
            return res.status(401).json({ success: false, error: 'Invalid credentials (password incorrect)' });
        }

        // Generate JWT
        const token = jwt.sign({ id: user.id, username: user.username, email: user.email }, JWT_SECRET, { expiresIn: '1h' });

        res.json({
            success: true,
            message: 'Signed in successfully',
            token: token,
            user: { id: user.id, username: user.username, email: user.email }
        });

    } catch (error) {
        console.error('❌ Error during sign in:', error);
        res.status(500).json({ success: false, error: 'Server error during sign in', message: error.message });
    }
});

app.use('/auth', authRouter); // Prefix auth routes with /auth

// Existing Routes
app.get('/', (req, res) => {
    res.send('🤖 WhatsApp bot dan API Helpdesk berjalan!');
});

// Protected Routes (require JWT)
app.get('/tickets', authenticateToken, async (req, res) => {
    try {
        const [rows] = await db.query('SELECT * FROM tickets ORDER BY updated_at DESC, created_at DESC');
        res.json({ success: true, data: rows });
    } catch (error) {
        console.error('❌ Gagal mengambil daftar tiket:', error.message);
        res.status(500).json({ success: false, error: 'Gagal mengambil daftar tiket', message: error.message });
    }
});

app.post('/send-message', authenticateToken, async (req, res) => {
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
            await db.query(
                `INSERT INTO messages (ticket_id, sender, name, message, is_from_user, created_at)
                 VALUES (?, ?, ?, ?, 0, ?)`,
                [ticket_id, 'admin', `${req.user.username}`, `(Info) Pesan saat tiket ditutup: ${message}`, new Date()]
            );
            return res.status(400).json({ success: false, error: 'Tidak dapat mengirim pesan, tiket sudah ditutup. Pesan dicatat sebagai info internal.' });
        }

        await sock.sendMessage(recipient, { text: message });

        await db.query(
            `INSERT INTO messages (ticket_id, sender, name, message, is_from_user, created_at)
             VALUES (?, ?, ?, ?, 0, ?)`,
            [ticket_id, 'admin', `${req.user.username}`, message, new Date()]
        );

        await db.query('UPDATE tickets SET updated_at = ? WHERE id = ?', [new Date(), ticket_id]);

        res.json({ success: true, message: 'Pesan berhasil dikirim dan dicatat' });

    } catch (err) {
        console.error('❌ Gagal mengirim pesan admin:', err);
        res.status(500).json({ success: false, error: 'Gagal mengirim pesan', message: err.message });
    }
});

app.get('/ticket/:id', authenticateToken, async (req, res) => {
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
            id: msg.id,
            sender_id: msg.sender,
            sender: msg.name || (msg.is_from_user ? ticket.name : 'Agen Helpdesk'),
            text: msg.message,
            timestamp: msg.created_at.toISOString(),
            type: msg.is_from_user ? 'user' : 'agent'
        }));

        const createdAtDate = new Date(ticket.created_at);
        const displayTicketId = `TICKET-${createdAtDate.getFullYear()}${String(createdAtDate.getMonth() + 1).padStart(2, '0')}${String(createdAtDate.getDate()).padStart(2, '0')}-${String(ticket.id).padStart(3, '0')}`;

        const response = {
            db_id: ticket.id,
            id: displayTicketId,
            subject: ticket.message?.split('\n')[0] || 'Tanpa Subjek',
            user: ticket.name,
            email: ticket.sender, // Ini adalah JID WhatsApp, bukan email
            status: ticket.status === 'open' ? 'Open' : 'Close',
            createdAt: ticket.created_at.toISOString(),
            updatedAt: ticket.updated_at.toISOString(),
            agent: formattedMessages.find(m => m.type === 'agent')?.sender || 'Belum ada balasan agen',
            messages: formattedMessages,
            location_code: ticket.location_code,
            solusi: ticket.solusi // Tambahkan field solusi di response
        };
        res.json(response);
    } catch (error) {
        console.error(`❌ Error mengambil detail tiket ${ticketId}:`, error);
        res.status(500).json({ error: 'Internal server error', message: error.message });
    }
});

// Endpoint untuk memperbarui status tiket dan menambahkan solusi jika ditutup
app.patch('/ticket/status/:id', authenticateToken, async (req, res) => {
    const ticketId = req.params.id;
    const { status, solusi } = req.body; // Ambil 'solusi' dari body request
    const adminUsername = req.user.username || 'Admin';

    if (!status || (status !== 'open' && status !== 'closed')) {
        return res.status(400).json({ success: false, error: 'Status harus "open" atau "closed"' });
    }
    if (isNaN(parseInt(ticketId))) {
        return res.status(400).json({ success: false, error: 'ID Tiket tidak valid' });
    }

    try {
        // Ambil detail tiket yang lebih lengkap untuk notifikasi
        const [ticketDetailsRows] = await db.query('SELECT sender, status, name, message AS kendala, location_code FROM tickets WHERE id = ?', [ticketId]);
        if (ticketDetailsRows.length === 0) {
            return res.status(404).json({ success: false, error: 'Tiket tidak ditemukan' });
        }
        const ticketInfo = ticketDetailsRows[0];
        const userJid = ticketInfo.sender;
        const currentTicketStatus = ticketInfo.status;


        // Bangun query SQL secara dinamis
        let updateQuerySql = 'UPDATE tickets SET status = ?, updated_at = ?';
        const queryParams = [status, new Date()];
        const closingTimestamp = new Date(); // Waktu tiket ditutup/diupdate

        if (status === 'closed') {
            updateQuerySql += ', solusi = ?';
            queryParams.push(solusi === undefined ? null : solusi);
        } else if (status === 'open' && currentTicketStatus === 'closed') {
            // updateQuerySql += ', solusi = NULL'; // Opsional: hapus solusi saat reopen
        }

        updateQuerySql += ' WHERE id = ?';
        queryParams.push(ticketId);

        const [result] = await db.query(updateQuerySql, queryParams);

        if (result.affectedRows === 0 && currentTicketStatus === status && status !== 'closed') {
            console.log(chalk.yellow(`Tidak ada perubahan status atau solusi untuk tiket #${ticketId}.`));
        } else if (result.affectedRows === 0 && currentTicketStatus === status && status === 'closed' && solusi === undefined) {
            console.log(chalk.yellow(`Tiket #${ticketId} sudah closed dan tidak ada solusi baru yang diberikan.`));
        }

        let logMessageText = `Status tiket diubah menjadi: ${status}`;
        // Format tanggal dan waktu penutupan/update tiket
        const options = { year: 'numeric', month: 'long', day: 'numeric', hour: '2-digit', minute: '2-digit', second: '2-digit', timeZoneName: 'short' };
        const formattedClosingTime = closingTimestamp.toLocaleString('id-ID', options);


        if (status === 'closed') {
            if (activeUserTickets[userJid] && activeUserTickets[userJid] === parseInt(ticketId)) {
                delete activeUserTickets[userJid];
                console.log(chalk.blue(`🗑️ Tiket aktif untuk ${userJid} (ID: ${ticketId}) telah dihapus karena status diubah menjadi 'closed' oleh ${adminUsername}.`));
            }

            // Format pesan notifikasi WhatsApp ke pengguna
            const solusiTextUser = (solusi !== undefined && solusi !== null && String(solusi).trim() !== "") ? String(solusi).trim() : "Tidak ada ringkasan solusi yang diberikan.";
            const kendalaTextUser = ticketInfo.kendala ? ticketInfo.kendala.split('\n')[0] : "Tidak ada deskripsi kendala.";
            const locationCodeUser = ticketInfo.location_code || "N/A";
            const namaPelangganUser = ticketInfo.name || "Pengguna";

            const waMessageToUser = `ℹ️ *Informasi Penutupan Tiket* ℹ️

Nomor Tiket: *#${ticketId}*
Nama Pelapor: *${namaPelangganUser}*
GM/Kode Lokasi: *${locationCodeUser}*
Kendala Awal: *${kendalaTextUser}*

Solusi:
*${solusiTextUser}*

Ditutup pada: *${formattedClosingTime}*
Oleh: *${adminUsername}*

Terima kasih telah menghubungi kami.`;

            if (userJid && sock) {
                try {
                    await sock.sendMessage(userJid, { text: waMessageToUser });
                    console.log(chalk.green(`Pesan notifikasi penutupan tiket #${ticketId} berhasil dikirim ke ${userJid}`));
                } catch (waError) {
                    console.error(chalk.red(`❌ Gagal mengirim notifikasi WhatsApp untuk tiket #${ticketId} ke ${userJid}:`), waError);
                }
            }

            logMessageText += `. Solusi: ${solusiTextUser}`;

            // --- START: Broadcast to group ---
            const locationCodeForGroup = ticketInfo.location_code;
            if (locationCodeForGroup && sock) {
                try {
                    // Ambil group_id (nomorhp grup) dari tabel wa_groups berdasarkan location_code
                    const [groupRows] = await db.query('SELECT group_id FROM wa_groups WHERE location_code = ?', [locationCodeForGroup]);
                    if (groupRows.length > 0) {
                        const groupId = groupRows[0].group_id;
                        if (groupId) {
                            const solusiTextGroup = (solusi !== undefined && solusi !== null && String(solusi).trim() !== "") ? String(solusi).trim() : "Belum ada solusi.";
                            const kendalaTextGroup = ticketInfo.kendala ? ticketInfo.kendala.split('\n')[0] : "Tidak ada deskripsi kendala.";
                            const namaPelangganTextGroup = ticketInfo.name || "Pengguna";

                            const groupBroadcastMessage = `🔔 *Update Tiket #${ticketId}* 🔔

ID Tiket: *#${ticketId}*
Pelapor: *${namaPelangganTextGroup}*
Kendala: *${kendalaTextGroup}*
Solusi:
*${solusiTextGroup}*

Ditutup oleh: *${adminUsername}*
Pada: *${formattedClosingTime}*

Terimakasih.`;

                            await sock.sendMessage(groupId, { text: groupBroadcastMessage });
                            console.log(chalk.greenBright(`📢 Broadcast penutupan tiket #${ticketId} berhasil dikirim ke grup ${locationCodeForGroup} (${groupId})`));
                        } else {
                            console.log(chalk.yellow(`⚠️ Tidak ada group_id (nomorhp grup) yang valid untuk location_code: ${locationCodeForGroup} pada tiket #${ticketId} di tabel wa_groups.`));
                        }
                    } else {
                        console.log(chalk.yellow(`⚠️ Grup untuk location_code: ${locationCodeForGroup} tidak ditemukan di tabel wa_groups untuk tiket #${ticketId}. Broadcast dibatalkan.`));
                    }
                } catch (groupError) {
                    console.error(chalk.red(`❌ Gagal mengirim broadcast ke grup untuk tiket #${ticketId} (lokasi: ${locationCodeForGroup}):`), groupError);
                }
            } else if (!locationCodeForGroup) {
                 console.log(chalk.yellow(`ℹ️ Tiket #${ticketId} tidak memiliki location_code. Broadcast ke grup dilewati.`));
            }
            // --- END: Broadcast to group ---

        } else if (status === 'open') {
            if (currentTicketStatus === 'closed') {
                 activeUserTickets[userJid] = parseInt(ticketId);
                 console.log(chalk.blue(` Tiket untuk ${userJid} (ID: ${ticketId}) dibuka kembali oleh ${adminUsername} dan ditambahkan ke pelacakan aktif.`));
                 if (userJid && sock) {
                    try {
                        await sock.sendMessage(userJid, { text: `ℹ️ Tiket Anda ID #${ticketId} telah dibuka kembali oleh agen ${adminUsername} pada ${formattedClosingTime}. Anda dapat melanjutkan percakapan.` });
                    } catch (waError) {
                        console.error(chalk.red(`❌ Gagal mengirim notifikasi pembukaan kembali tiket #${ticketId} ke ${userJid}:`), waError);
                    }
                }
            }
        }

        await db.query(
            `INSERT INTO messages (ticket_id, sender, name, message, is_from_user, created_at)
             VALUES (?, ?, ?, ?, 0, ?)`,
            [ticketId, 'admin', `${adminUsername}`, logMessageText, closingTimestamp] // Gunakan closingTimestamp untuk created_at log
        );

        res.json({ success: true, message: `Status tiket #${ticketId} berhasil diperbarui menjadi ${status}${status === 'closed' && solusi !== undefined ? ' dengan solusi.' : '.'}` });
    } catch (error) {
        console.error(`❌ Error memperbarui status tiket ${ticketId}:`, error);
        res.status(500).json({ success: false, error: 'Internal server error', message: error.message });
    }
});


app.listen(PORT, () => {
    console.log(chalk.magentaBright(`🚀 Server Express berjalan di http://localhost:${PORT}`));
});
