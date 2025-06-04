const { makeWASocket, useMultiFileAuthState, DisconnectReason, isJidGroup } = require('baileys');
const pino = require('pino');
const chalk =require('chalk');
const qrcode = require('qrcode-terminal');
const handleLenwyCommand = require('./lenwy');
const agentAI = require('./scrape/agentAI');
require('dotenv').config();
const { db, db2 } = require('./db'); // Pastikan db dan db2 dikonfigurasi dengan benar
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');

// Server Express untuk API
const express = require('express');
const cors = require('cors');
const app = express();
const PORT = process.env.PORT || 4000;
const JWT_SECRET = process.env.JWT_SECRET;
const COMPLAINT_REPORT_URL_BASE = process.env.COMPLAINT_REPORT_URL_BASE;


// Tambahan untuk POST complaint
const multer = require('multer');
const path = require('path');
const fs = require('fs');

if (!JWT_SECRET) {
    console.error(chalk.red('FATAL ERROR: JWT_SECRET is not defined in .env file.'));
    process.exit(1);
}

app.use(cors());
app.use(express.json());

// Middleware Autentikasi JWT
function authenticateToken(req, res, next) {
    const authHeader = req.headers['authorization'];
    const token = authHeader && authHeader.split(' ')[1];
    if (token == null) {
        return res.status(401).json({ success: false, error: 'No token provided' });
    }
    jwt.verify(token, JWT_SECRET, (err, user) => {
        if (err) {
            console.error(chalk.yellow('⚠️ JWT Verification Error:'), err.message);
            return res.status(403).json({ success: false, error: 'Token is not valid' });
        }
        req.user = user;
        next();
    });
}

// --- Multer Setup untuk Upload File Komplain ---
const complaintUploadsDir = path.join(__dirname, 'uploads');
if (!fs.existsSync(complaintUploadsDir)){
    fs.mkdirSync(complaintUploadsDir, { recursive: true });
    console.log(chalk.blue(`📁 Created directory for complaint uploads: ${complaintUploadsDir}`));
}

const complaintStorage = multer.diskStorage({
    destination: function (req, file, cb) {
        cb(null, complaintUploadsDir);
    },
    filename: function (req, file, cb) {
        const uniqueSuffix = Date.now() + '-' + Math.round(Math.random() * 1E9);
        const originalName = file.originalname.replace(/\s+/g, '_');
        cb(null, uniqueSuffix + '-' + originalName);
    }
});

const complaintUpload = multer({
    storage: complaintStorage,
    limits: { fileSize: 10 * 1024 * 1024 }, // Batas ukuran file 10MB
    fileFilter: function (req, file, cb) {
        const allowedTypes = /pdf|jpeg|jpg|png|doc|docx|xls|xlsx|txt/;
        const mimetype = allowedTypes.test(file.mimetype);
        const extname = allowedTypes.test(path.extname(file.originalname).toLowerCase());
        if (mimetype && extname) {
            cb(null, true);
        } else {
            cb(new Error('Format file tidak sesuai. Hanya mendukung: pdf, jpeg, jpg, png, doc, docx, xls, xlsx, txt.'));
        }
    }
});
// --- Akhir Multer Setup ---

const activeUserTickets = {};
let sock;

async function startBot() {
    const { state, saveCreds } = await useMultiFileAuthState('./session');
    sock = makeWASocket({
        logger: pino({ level: 'silent' }),
        auth: state,
        browser: ['Ubuntu', 'Chrome', '119.0.0.0'], // Contoh User Agent
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
                     ON DUPLICATE KEY UPDATE group_name = VALUES(group_name), location_code = IF(location_code IS NULL OR location_code = '', VALUES(location_code), location_code)`,
                    [id, '', name]
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

        const senderJid = msg.key.remoteJid;
        const text = msg.message.conversation || msg.message.extendedTextMessage?.text || '';
        const name = msg.pushName || 'User';

        console.log(chalk.cyan(`[Pesan dari: ${name} (${senderJid})] ${text}`));

        try {
            const [activeOrPendingTickets] = await db.query(
                'SELECT id, status FROM tickets WHERE sender = ? AND (status = ? OR status = ?)',
                [senderJid, 'open', 'pending']
            );

            if (activeOrPendingTickets.length > 0 && !text.startsWith('!')) {
                const currentTicket = activeOrPendingTickets[0];
                await db.query(
                    'INSERT INTO messages (ticket_id, sender, name, message, is_from_user, created_at) VALUES (?, ?, ?, ?, 1, ?)',
                    [currentTicket.id, senderJid, name, text, new Date()]
                );
                await db.query('UPDATE tickets SET updated_at = ? WHERE id = ?', [new Date(), currentTicket.id]);
                console.log(chalk.greenBright(`📝 Pesan dari ${name} disimpan ke tiket #${currentTicket.id} (status: ${currentTicket.status})`));
                return;
            }
        } catch (dbError) {
            console.error(`❌ Gagal menyimpan/memeriksa pesan untuk tiket ${senderJid}:`, dbError);
        }


        if (text.startsWith('!')) {
            try {
                await handleLenwyCommand(sock, { messages }, activeUserTickets, db);
            } catch (err) {
                console.error('❌ Gagal menjalankan perintah Lenwy:', err);
                await sock.sendMessage(senderJid, { text: `❌ Gagal menjalankan perintah: ${err.message}` });
            }
        }
        else if (!isJidGroup(senderJid)) {
             const [existingTickets] = await db.query(
                'SELECT id FROM tickets WHERE sender = ? AND (status = ? OR status = ?)',
                [senderJid, 'open', 'pending']
            );
            if (existingTickets.length === 0) {
                try {
                    const aiResponseObject = await agentAI(text);
                    let originalContent = "";

                    if (aiResponseObject && aiResponseObject.choices && aiResponseObject.choices[0] && aiResponseObject.choices[0].message && aiResponseObject.choices[0].message.content) {
                        originalContent = aiResponseObject.choices[0].message.content;
                    } else if (typeof aiResponseObject === 'string') {
                        originalContent = aiResponseObject;
                    } else {
                        console.error("❌ Error ProAI: Struktur respons tidak dikenal dari agentAI", aiResponseObject);
                        await sock.sendMessage(senderJid, { text: `❌ Terjadi kesalahan: Struktur respons AI tidak dikenali.` });
                        return;
                    }

                    const cleanContent = originalContent
                        .replace(/\[\d+(?:,\s*(?:pp\.|p\.)\s*[\d-]+)?\]/g, '')
                        .replace(/References:[\s\S]*$/, "Untuk panduan troubleshooting lebih lanjut, silakan kunjungi: https://bit.ly/Handbook-Panduan-Troubleshooting")
                        .trim();

                    await sock.sendPresenceUpdate('composing', senderJid);
                    await new Promise(resolve => setTimeout(resolve, 1500)); // Jeda untuk simulasi mengetik
                    await sock.sendPresenceUpdate('paused', senderJid);
                    await sock.sendMessage(senderJid, { text: cleanContent });

                } catch (err) {
                    console.error("❌ Error ProAI:", err);
                    await sock.sendMessage(senderJid, { text: `Maaf, terjadi kesalahan saat memproses permintaan Anda. Silakan coba lagi nanti.` });
                }
            }
        }
    });
}
startBot();

// --- Routes ---
const authRouter = express.Router();
authRouter.post('/signup', async (req, res) => {
    const { username, email, password } = req.body;
    if (!username || !email || !password) {
        return res.status(400).json({ success: false, error: 'Username, email, and password are required' });
    }
    if (email && !/\S+@\S+\.\S+/.test(email)) {
        return res.status(400).json({ success: false, error: 'Invalid email format' });
    }
    if (password.length < 6) {
        return res.status(400).json({ success: false, error: 'Password must be at least 6 characters long' });
    }
    try {
        const [existingUsers] = await db.query('SELECT id FROM users WHERE username = ? OR email = ?', [username, email || '']);
        if (existingUsers.length > 0) {
            return res.status(409).json({ success: false, error: 'Username or email already exists' });
        }
        const salt = await bcrypt.genSalt(10);
        const passwordHash = await bcrypt.hash(password, salt);
        const [result] = await db.query(
            'INSERT INTO users (username, email, password_hash) VALUES (?, ?, ?)',
            [username, email || '', passwordHash]
        );
        const userId = result.insertId;
        const token = jwt.sign({ id: userId, username: username, email: email || '' }, JWT_SECRET, { expiresIn: '1h' });
        res.status(201).json({ success: true, message: 'User registered successfully', userId: userId, token: token });
    } catch (error) {
        console.error('❌ Error during sign up:', error);
        res.status(500).json({ success: false, error: 'Server error during sign up', message: error.message });
    }
});

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
        const token = jwt.sign({ id: user.id, username: user.username, email: user.email, name: user.name }, JWT_SECRET, { expiresIn: '1h' }); 
        res.json({
            success: true,
            message: 'Signed in successfully',
            token: token,
            user: { id: user.id, username: user.username, email: user.email, name: user.name } 
        });
    } catch (error) {
        console.error('❌ Error during sign in:', error);
        res.status(500).json({ success: false, error: 'Server error during sign in', message: error.message });
    }
});
app.use('/auth', authRouter);

app.get('/', (req, res) => {
    res.send('🤖 WhatsApp bot dan API Helpdesk berjalan!');
});

app.get('/tickets', authenticateToken, async (req, res) => {
    try {
        // Mengambil complaint_ticket_id_ref dan complaint_category_ref
        const [rows] = await db.query('SELECT *, complaint_ticket_id_ref, complaint_category_ref FROM tickets ORDER BY updated_at DESC, created_at DESC');
        res.json({ success: true, data: rows });
    } catch (error) {
        console.error('❌ Gagal mengambil daftar tiket:', error.message);
        res.status(500).json({ success: false, error: 'Gagal mengambil daftar tiket', message: error.message });
    }
});

app.post('/send-message', authenticateToken, async (req, res) => {
    const { ticket_id, message } = req.body;
    const agentName = req.user.name || req.user.username || 'Agent'; 
    if (!ticket_id || !message) {
        return res.status(400).json({ success: false, error: 'ticket_id dan message wajib diisi' });
    }
    try {
        const [ticketRows] = await db.query('SELECT sender, status FROM tickets WHERE id = ?', [ticket_id]);
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
                [ticket_id, 'admin', agentName, `(Info) Pesan saat tiket ditutup: ${message}`, new Date()]
            );
            return res.status(400).json({ success: false, error: 'Tidak dapat mengirim pesan, tiket sudah ditutup. Pesan dicatat sebagai info internal.' });
        }

        await sock.sendMessage(recipient, { text: message });
        await db.query(
            `INSERT INTO messages (ticket_id, sender, name, message, is_from_user, created_at)
             VALUES (?, ?, ?, ?, 0, ?)`,
            [ticket_id, 'admin', agentName, message, new Date()]
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
        // Mengambil complaint_ticket_id_ref dan complaint_category_ref
        const [ticketRows] = await db.query('SELECT *, complaint_ticket_id_ref, complaint_category_ref FROM tickets WHERE id = ?', [ticketId]);
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
        const displayTicketId = ticket.id_ticket || `TICKET-${createdAtDate.getFullYear()}${String(createdAtDate.getMonth() + 1).padStart(2, '0')}${String(createdAtDate.getDate()).padStart(2, '0')}-${String(ticket.id).padStart(3, '0')}`;
        
        const response = {
            db_id: ticket.id,
            id: displayTicketId,
            subject: ticket.message?.split('\n')[0] || 'Tanpa Subjek',
            user: ticket.name,
            email: ticket.sender,
            status: ticket.status,
            createdAt: ticket.created_at.toISOString(),
            updatedAt: ticket.updated_at.toISOString(),
            agent: formattedMessages.find(m => m.type === 'agent')?.sender || 'Belum ada balasan agen',
            messages: formattedMessages,
            location_code: ticket.location_code,
            location_name: ticket.location_name, // Menambahkan location_name
            solusi: ticket.solusi,
            complaint_ticket_id_ref: ticket.complaint_ticket_id_ref, 
            complaint_category_ref: ticket.complaint_category_ref // Menyertakan kategori komplain
        };
        res.json(response);
    } catch (error) {
        console.error(`❌ Error mengambil detail tiket ${ticketId}:`, error);
        res.status(500).json({ error: 'Internal server error', message: error.message });
    }
});

app.patch('/ticket/status/:id', authenticateToken, async (req, res) => {
    const ticketDbId = req.params.id;
    const { status, solusi } = req.body;
    const adminUsername = req.user.name || req.user.username || 'Admin'; 

    if (!status || (status !== 'open' && status !== 'closed' && status !== 'pending')) { 
        return res.status(400).json({ success: false, error: 'Status baru harus "open", "closed", atau "pending"' });
    }
    if (isNaN(parseInt(ticketDbId))) {
        return res.status(400).json({ success: false, error: 'ID Tiket tidak valid' });
    }

    try {
        const [ticketDetailsRows] = await db.query(
            'SELECT sender, status as current_status, name, message AS kendala, location_code, location_name, id_ticket, created_at FROM tickets WHERE id = ?', // Menambahkan location_name
            [ticketDbId]
        );
        if (ticketDetailsRows.length === 0) {
            return res.status(404).json({ success: false, error: 'Tiket tidak ditemukan' });
        }
        const ticketInfo = ticketDetailsRows[0];
        const userJid = ticketInfo.sender;
        const currentTicketStatus = ticketInfo.current_status;
        const displayTicketId = ticketInfo.id_ticket || `TICKET-${new Date(ticketInfo.created_at).getFullYear()}${String(new Date(ticketInfo.created_at).getMonth() + 1).padStart(2, "0")}${String(new Date(ticketInfo.created_at).getDate()).padStart(2, "0")}-${String(ticketDbId).padStart(3, "0")}`;

        if (currentTicketStatus === status) {
            return res.status(400).json({ success: false, error: `Tiket sudah dalam status '${status}'. Tidak ada perubahan.` });
        }
        
        let updateQuerySql = 'UPDATE tickets SET status = ?, updated_at = ?';
        const queryParams = [status, new Date()];
        const actionTimestamp = new Date();

        if (status === 'closed') {
            updateQuerySql += ', solusi = ?';
            queryParams.push(solusi === undefined ? null : solusi);
        }
        updateQuerySql += ' WHERE id = ?';
        queryParams.push(ticketDbId);

        await db.query(updateQuerySql, queryParams);

        let logMessageText = `Status tiket diubah dari '${currentTicketStatus}' menjadi '${status}' oleh ${adminUsername}`;
        const options = { year: 'numeric', month: 'long', day: 'numeric', hour: '2-digit', minute: '2-digit', second: '2-digit', timeZoneName: 'short' };
        const formattedActionTime = actionTimestamp.toLocaleString('id-ID', options);

        if (status === 'closed') {
            if (activeUserTickets[userJid] && activeUserTickets[userJid] === parseInt(ticketDbId)) {
                delete activeUserTickets[userJid];
                 console.log(chalk.blue(`🗑️ Tiket aktif (via !ticket) untuk ${userJid} (${displayTicketId}) telah dihapus karena status diubah menjadi 'closed' oleh ${adminUsername}.`));
            }

            const solusiTextUser = (solusi !== undefined && solusi !== null && String(solusi).trim() !== "") ? String(solusi).trim() : "Tidak ada ringkasan solusi yang diberikan.";
            const kendalaTextUser = ticketInfo.kendala ? ticketInfo.kendala.split('\n')[0] : "Tidak ada deskripsi kendala.";
            const locationCodeUser = ticketInfo.location_code || "N/A";
            const locationNameUser = ticketInfo.location_name || "N/A"; // Mengambil location_name
            const namaPelangganUser = ticketInfo.name || "Pengguna";
            const waMessageToUser = `ℹ️ *Informasi Penutupan Tiket* ℹ️\n\nNomor Tiket: *${displayTicketId}*\nNama Pelapor: *${namaPelangganUser}*\nGM: *${locationCodeUser}*\nLokasi: *${locationNameUser}*\nKendala Awal: *${kendalaTextUser}*\n\nSolusi:\n*${solusiTextUser}*\n\nDitutup pada: *${formattedActionTime}*\nOleh: *${adminUsername}*\n\nTerima kasih telah menghubungi kami.`;
            
            if (userJid && sock) {
                try {
                    await sock.sendMessage(userJid, { text: waMessageToUser });
                    console.log(chalk.green(`Pesan notifikasi penutupan tiket ${displayTicketId} berhasil dikirim ke ${userJid}`));
                } catch (waError) {
                    console.error(chalk.red(`❌ Gagal mengirim notifikasi WhatsApp untuk tiket ${displayTicketId} ke ${userJid}:`), waError);
                }
            }
            logMessageText += `. Solusi: ${solusiTextUser}`;

            const locationCodeForGroup = ticketInfo.location_code;
            if (locationCodeForGroup && sock) {
                try {
                    const [groupRows] = await db.query('SELECT group_id FROM wa_groups WHERE location_code = ?', [locationCodeForGroup]);
                    if (groupRows.length > 0) {
                        const groupId = groupRows[0].group_id;
                        if (groupId) {
                            const groupBroadcastMessage = `🔔 *Update Tiket ${displayTicketId}* 🔔\n\nID Tiket: *${displayTicketId}*\nPelapor: *${namaPelangganUser}*\nGM: *${locationCodeUser}*\nLokasi: *${locationNameUser}*\nKendala: *${kendalaTextUser}*\nSolusi:\n*${solusiTextUser}*\n\nDitutup oleh: *${adminUsername}*\nPada: *${formattedActionTime}*\n\nTerimakasih.`;
                            await sock.sendMessage(groupId, { text: groupBroadcastMessage });
                            console.log(chalk.greenBright(`📢 Broadcast penutupan tiket ${displayTicketId} berhasil dikirim ke grup ${locationCodeForGroup} (${groupId})`));
                        }
                    }
                } catch (groupError) {
                    console.error(chalk.red(`❌ Gagal mengirim broadcast ke grup untuk tiket ${displayTicketId} (lokasi: ${locationCodeForGroup}):`), groupError);
                }
            }
        } else if (status === 'open' && currentTicketStatus !== 'open') { 
            console.log(chalk.blue(`ℹ️ Tiket ${userJid} (${displayTicketId}) statusnya diubah menjadi 'open' oleh ${adminUsername} dari '${currentTicketStatus}'.`));
            if (userJid && sock) {
                try {
                    await sock.sendMessage(userJid, { text: `ℹ️ Tiket Anda ${displayTicketId} telah dibuka kembali oleh agen ${adminUsername} pada ${formattedActionTime}. Anda dapat melanjutkan percakapan.` });
                } catch (waError) {
                    console.error(chalk.red(`❌ Gagal mengirim notifikasi pembukaan kembali tiket ${displayTicketId} ke ${userJid}:`), waError);
                }
            }
        }
        
        await db.query(
            `INSERT INTO messages (ticket_id, sender, name, message, is_from_user, created_at)
             VALUES (?, ?, ?, ?, 0, ?)`,
            [ticketDbId, 'admin', adminUsername, logMessageText, actionTimestamp]
        );
        res.json({ success: true, message: `Status tiket ${displayTicketId} berhasil diperbarui menjadi ${status}${status === 'closed' && solusi !== undefined ? ' dengan solusi.' : '.'}` });

    } catch (error) {
        const errDisplayTicketId = req.params.id;
        console.error(`❌ Error memperbarui status tiket dengan ID DB ${errDisplayTicketId}:`, error);
        res.status(500).json({ success: false, error: 'Internal server error', message: error.message });
    }
});


app.post('/complaints', authenticateToken, (req, res) => {
    complaintUpload.single('file')(req, res, async function (err) {
        if (err) {
            if (err.message && err.message.startsWith('Format file tidak sesuai')) {
                return res.status(400).json({ success: false, error: err.message });
            }
            if (err instanceof multer.MulterError) {
                 return res.status(400).json({ success: false, error: `Kesalahan unggah file: ${err.message}` });
            }
            console.error(chalk.red('❌ Error tidak terduga saat upload file komplain:'), err);
            return res.status(500).json({ success: false, error: 'Terjadi kesalahan saat mengunggah file.' });
        }

        const uploadedFile = req.file;
        const userUpdate = req.user.name || req.user.username || 'Admin'; 

        const {
            id_ticket_chat, 
            reporter_name, 
            reporter_phone,
            issue_date,
            category, 
            troubleshoot,
            location, // Ini adalah variabel untuk Lokasi (Komplain)
            priority,
            issue_title,
            issue_description
        } = req.body;
        const reporter_email = req.body.reporter_email || "";

        const requiredFields = {
            id_ticket_chat, reporter_name, reporter_phone, issue_date,
            category, troubleshoot, location, priority, issue_title, issue_description
        };
        for (const [key, value] of Object.entries(requiredFields)) {
            if (!value || String(value).trim() === "") {
                if (uploadedFile && fs.existsSync(uploadedFile.path)) fs.unlinkSync(uploadedFile.path);
                return res.status(400).json({ success: false, error: `Field '${key.replace(/_/g, ' ')}' wajib diisi.` });
            }
        }
        if (reporter_email && !/\S+@\S+\.\S+/.test(reporter_email)) {
            if (uploadedFile && fs.existsSync(uploadedFile.path)) fs.unlinkSync(uploadedFile.path);
            return res.status(400).json({ success: false, error: 'Format reporter_email tidak valid.' });
        }

        let originalTicketDbId;
        let originalTicketDetails;
        try {
            const [ticketRows] = await db.query('SELECT id, status, location_code, name, sender, location_name FROM tickets WHERE id_ticket = ?', [id_ticket_chat]); // Menambahkan location_name
            if (ticketRows.length === 0) {
                if (uploadedFile && fs.existsSync(uploadedFile.path)) fs.unlinkSync(uploadedFile.path);
                return res.status(400).json({ success: false, error: `ID Tiket Chat tidak valid: Tiket ${id_ticket_chat} tidak ditemukan.` });
            }
            originalTicketDbId = ticketRows[0].id; 
            originalTicketDetails = ticketRows[0]; 

            if (originalTicketDetails.status !== 'open') {
                 if (uploadedFile && fs.existsSync(uploadedFile.path)) fs.unlinkSync(uploadedFile.path);
                return res.status(400).json({ success: false, error: `Hanya tiket dengan status 'open' yang bisa dibuatkan komplain. Status tiket ${id_ticket_chat} saat ini adalah '${originalTicketDetails.status}'.` });
            }

        } catch (dbError) {
            console.error(chalk.red('❌ Error validasi id_ticket_chat:'), dbError);
            if (uploadedFile && fs.existsSync(uploadedFile.path)) fs.unlinkSync(uploadedFile.path);
            return res.status(500).json({ success: false, error: 'Terjadi kesalahan server saat validasi ID Tiket Chat.' });
        }

        let newComplaintIdTicket; 
        try {
            const [maxIdRows] = await db2.query('SELECT MAX(id) as lastId FROM tb_complaint');
            let nextIdValue = 1;
            if (maxIdRows.length > 0 && maxIdRows[0].lastId !== null) {
                nextIdValue = parseInt(maxIdRows[0].lastId) + 1;
            }
            newComplaintIdTicket = `HD-${nextIdValue}`;
        } catch (idError) {
            console.error(chalk.red('❌ Error generating new complaint ID ticket:'), idError);
            if (uploadedFile && fs.existsSync(uploadedFile.path)) fs.unlinkSync(uploadedFile.path);
            return res.status(500).json({ success: false, error: 'Terjadi kesalahan server saat membuat ID komplain.' });
        }

        let daysToAdd = 0;
        const priorityClean = String(priority).toLowerCase();
        if (priorityClean.includes('high')) daysToAdd = 2;
        else if (priorityClean.includes('medium')) daysToAdd = 4;
        else if (priorityClean.includes('low')) daysToAdd = 6;
        else {
            if (uploadedFile && fs.existsSync(uploadedFile.path)) fs.unlinkSync(uploadedFile.path);
            return res.status(400).json({ success: false, error: 'Nilai priority tidak valid.' });
        }
        const issueDateObj = new Date(issue_date);
        if (isNaN(issueDateObj.getTime())) {
            if (uploadedFile && fs.existsSync(uploadedFile.path)) fs.unlinkSync(uploadedFile.path);
            return res.status(400).json({ success: false, error: 'Format issue_date tidak valid.' });
        }
        const deadlineDateObj = new Date(issueDateObj);
        deadlineDateObj.setDate(issueDateObj.getDate() + daysToAdd);
        const deadline_date_formatted = deadlineDateObj.toISOString().split('T')[0];
        const fileNameForDb = uploadedFile ? uploadedFile.filename : null;
        const initialComplaintStatus = 'no action yet'; 

        const complaintDataForDb = {
            id_ticket: newComplaintIdTicket, 
            id_ticket_chat, 
            reporter_name: req.body.reporter_name, 
            reporter_email, 
            reporter_phone, 
            issue_date,
            deadline_date: deadline_date_formatted, 
            category, 
            troubleshoot, 
            location: req.body.location, // Ini adalah lokasi komplain
            priority,
            issue_title, 
            issue_description, 
            status: initialComplaintStatus, 
            user_update: userUpdate,
            executor_name: null, 
            reason_execute: null, 
            file_name: fileNameForDb
        };

        const insertSql = `
            INSERT INTO tb_complaint (
                id_ticket, id_ticket_chat, reporter_name, reporter_email, reporter_phone,
                issue_date, deadline_date, category, troubleshoot, location, priority,
                issue_title, issue_description, status, user_update, executor_name,
                reason_execute, file_name
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `;
        const values = Object.values(complaintDataForDb);

        try {
            const [result] = await db2.query(insertSql, values); 
            console.log(chalk.greenBright(`✅ Komplain baru ${newComplaintIdTicket} berhasil dibuat (ID internal: ${result.insertId})`));

            const newOriginalTicketStatus = 'pending';
            // Memperbarui tiket di db1 untuk menyertakan complaint_ticket_id_ref DAN complaint_category_ref
            await db.query(
                'UPDATE tickets SET status = ?, updated_at = ?, complaint_ticket_id_ref = ?, complaint_category_ref = ? WHERE id = ?',
                [newOriginalTicketStatus, new Date(), newComplaintIdTicket, category, originalTicketDbId]
            );
            console.log(chalk.blue(`🔄 Status tiket original ${id_ticket_chat} (DB ID: ${originalTicketDbId}) diubah menjadi '${newOriginalTicketStatus}'. Referensi komplain ${newComplaintIdTicket} dan kategori ${category} disimpan.`));
            
            if (activeUserTickets[originalTicketDetails.sender] && activeUserTickets[originalTicketDetails.sender] === originalTicketDbId) {
                delete activeUserTickets[originalTicketDetails.sender];
                console.log(chalk.yellow(`🗑️ Tiket ${id_ticket_chat} dihapus dari activeUserTickets karena status berubah menjadi 'pending'.`));
            }

            const userJid = originalTicketDetails.sender; 
            const originalReporterName = originalTicketDetails.name || "Pelapor"; 
            const complaintLocationInput = req.body.location; // Menggunakan req.body.location untuk broadcast
            const complaintIssueTitle = req.body.issue_title; 
            const complaintPriority = req.body.priority;
            const complaintCategory = req.body.category; 
            const gmLocationCode = originalTicketDetails.location_code || "N/A"; // GM dari tiket original
            const ticketOriginalLocationName = originalTicketDetails.location_name || "N/A"; // Lokasi dari tiket original (jika ada)
            const complaintCategoryURL = encodeURIComponent(req.body.category);

            if (userJid && sock) {
                try {
                    const userNotificationMessage = `📢 *Komplain Baru Dibuat (Status Tiket Pending)* 📢\n\nID Komplain: *${newComplaintIdTicket}*\nUntuk Tiket: *${id_ticket_chat}*\nPelapor (Komplain): *${req.body.reporter_name}*\nLokasi (Komplain): *${complaintLocationInput}*\nIssue: *${complaintIssueTitle}*\nPrioritas (Komplain): *${complaintPriority}*\n\nStatus tiket *${id_ticket_chat}* telah diubah menjadi *OUTSTANDING* dan sudah dieskalasi ke *${complaintCategory}*.\n\nProgress bisa dilihat dilink bawah ini:\n${COMPLAINT_REPORT_URL_BASE}/helpdesk-system/complaint/report/${newComplaintIdTicket}/${complaintCategoryURL}\n `;
                    await sock.sendMessage(userJid, { text: userNotificationMessage });
                    console.log(chalk.blueBright(`📬 Notifikasi komplain ${newComplaintIdTicket} berhasil dikirim ke pengguna ${userJid}`));
                } catch (userNotifyError) {
                    console.error(chalk.red(`❌ Gagal mengirim notifikasi komplain ke pengguna ${userJid} untuk tiket ${id_ticket_chat}:`), userNotifyError);
                }
            }
            
            const locationCodeForBroadcast = originalTicketDetails.location_code; 
            if (locationCodeForBroadcast && sock) {
                try {
                    const [groupRows] = await db.query('SELECT group_id FROM wa_groups WHERE location_code = ?', [locationCodeForBroadcast]);
                    if (groupRows.length > 0) {
                        const groupId = groupRows[0].group_id;
                        if (groupId) {
                            // Pesan broadcast diupdate untuk menyertakan Lokasi (Komplain) dan GM
                            const complaintBroadcastMessage = `📢 *Komplain Baru Dibuat (Status Tiket Pending)* 📢\n\nID Komplain: *${newComplaintIdTicket}*\nUntuk Tiket: *${id_ticket_chat}*\nPelapor (Komplain): *${req.body.reporter_name}*\nGM (Tiket): *${gmLocationCode}*\nLokasi (Tiket): *${ticketOriginalLocationName}*\nLokasi (Komplain): *${complaintLocationInput}*\nIssue: *${complaintIssueTitle}*\nPrioritas (Komplain): *${complaintPriority}*\n\nStatus tiket *${id_ticket_chat}* telah diubah menjadi *OUTSTANDING* dan sudah dieskalasi ke *${complaintCategory}*.\n\nProgress bisa dilihat dilink bawah ini:\n${COMPLAINT_REPORT_URL_BASE}/helpdesk-system/complaint/report/${newComplaintIdTicket}/${complaintCategoryURL}\n `;
                            await sock.sendMessage(groupId, { text: complaintBroadcastMessage });
                            console.log(chalk.magentaBright(`📢 Broadcast komplain ${newComplaintIdTicket} berhasil dikirim ke grup ${locationCodeForBroadcast} (${groupId}) dengan link laporan.`));
                        }
                    }
                } catch (broadcastError) {
                    console.error(chalk.red(`❌ Gagal mengirim broadcast komplain untuk ${newComplaintIdTicket} (lokasi: ${locationCodeForBroadcast}):`), broadcastError);
                }
            }

            res.status(201).json({
                success: true,
                message: `Komplain ${newComplaintIdTicket} berhasil dibuat. Status tiket ${id_ticket_chat} diubah menjadi 'pending'. Referensi komplain disimpan.`,
                complaintInternalId: result.insertId,
                complaintTicketId: newComplaintIdTicket,
                id_ticket_chat_original: id_ticket_chat 
            });

        } catch (dbError) {
            console.error(chalk.red('❌ Error saat menyimpan komplain ke DB2 atau update tiket original:'), dbError);
            if (uploadedFile && fs.existsSync(uploadedFile.path)) fs.unlinkSync(uploadedFile.path);
            if (dbError.code === 'ER_DUP_ENTRY' && dbError.sqlMessage.includes("for key 'id_ticket'")) {
                 return res.status(409).json({ success: false, error: 'Gagal membuat komplain: ID Tiket Komplain sudah ada.', details: dbError.message });
            }
            res.status(500).json({ success: false, error: 'Terjadi kesalahan server saat menyimpan komplain.', details: dbError.message });
        }
    });
});

app.listen(PORT, () => {
    console.log(chalk.magentaBright(`🚀 Server Express berjalan di http://localhost:${PORT}`));
});
