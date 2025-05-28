// Panggil Scrape (jika masih digunakan untuk perintah lain)
const Ai4Chat = require('./scrape/Ai4Chat'); // Pastikan path ini benar
const agentAI = require('./scrape/agentAI'); // Pastikan path ini benar
// db tidak perlu di-require lagi di sini jika sudah di-pass sebagai argumen
// const db = require('./db');

// const pendingTickets = {}; // Tidak digunakan lagi di alur ini

module.exports = async (lenwy, m, activeUserTickets, db) => { // Tambahkan activeUserTickets dan db sebagai parameter
    const msg = m.messages[0];
    if (!msg.message) return;

    const body = msg.message.conversation || msg.message.extendedTextMessage?.text || "";
    const sender = msg.key.remoteJid;
    const pushname = msg.pushName || "Pengguna WhatsApp"; // Default name

    // Logika untuk pendingTickets yang lama sudah dihapus.

    // Cek apakah pesan adalah perintah atau balasan tiket
    if (!body.startsWith("!")) {
        // Jika ada tiket aktif dan pesan bukan perintah, anggap sebagai balasan tiket
        if (activeUserTickets && activeUserTickets[sender]) {
            const ticketId = activeUserTickets[sender];
            const userMessage = body.trim();

            if (userMessage) { // Hanya proses jika ada pesan
                try {
                    // Cek apakah tiket masih 'open'
                    const [ticketStatusRows] = await db.query("SELECT status, name FROM tickets WHERE id = ? AND sender = ?", [ticketId, sender]);
                    if (ticketStatusRows.length === 0 || ticketStatusRows[0].status !== 'open') {
                        await lenwy.sendMessage(sender, { text: `Tiket Anda dengan ID TICKET-...-${String(ticketId).padStart(3, '0')} sudah tidak aktif atau ditutup. Silakan buat tiket baru jika perlu.` });
                        delete activeUserTickets[sender];
                        return;
                    }
                    const ticketName = ticketStatusRows[0].name || pushname; // Gunakan nama dari tiket jika ada

                    // Simpan balasan ke tabel messages
                    await db.query(
                        "INSERT INTO messages (ticket_id, sender, name, message, is_from_user, created_at) VALUES (?, ?, ?, ?, 1, ?)",
                        [ticketId, sender, ticketName, userMessage, new Date()]
                    );
                    // Perbarui updated_at di tabel tickets
                    await db.query("UPDATE tickets SET updated_at = ? WHERE id = ?", [new Date(), ticketId]);

                    const displayTicketIdReply = `TICKET-...-${String(ticketId).padStart(3, '0')}`;
                    await lenwy.sendMessage(sender, { text: `Pesan Anda telah ditambahkan ke tiket ${displayTicketIdReply}. Tim kami akan segera merespons.` });
                    
                    // Optional: Notifikasi ke admin/grup bahwa ada balasan baru
                    const [ticketDetails] = await db.query("SELECT location_code FROM tickets WHERE id = ?", [ticketId]);
                    const ticketLocationCode = ticketDetails.length > 0 ? ticketDetails[0].location_code : null;
                    if (ticketLocationCode) {
                        const [groupRowsReply] = await db.query("SELECT group_id FROM wa_groups WHERE location_code = ?", [ticketLocationCode]);
                        if (groupRowsReply.length > 0) {
                            const replyNotification = `💬 Balasan baru pada Tiket ID ${displayTicketIdReply} (${ticketName}):\n\n"${userMessage.substring(0,100)}..."`;
                            for (const group of groupRowsReply) {
                                await lenwy.sendMessage(group.group_id, { text: replyNotification });
                            }
                        }
                    }

                } catch (replyError) {
                    console.error("❌ Gagal menyimpan balasan tiket:", replyError);
                    await lenwy.sendMessage(sender, { text: `Terjadi kesalahan saat menambahkan balasan Anda ke tiket. (${replyError.message})` });
                }
            }
        }
        return; // Jika bukan perintah dan tidak ada tiket aktif (atau pesan kosong), abaikan.
    }

    // --- AWAL PERUBAHAN PARSING PERINTAH ---
    let command;
    let currentCommandArgs = []; // Untuk menyimpan argumen dari baris pertama perintah

    const lines = body.split(/\r?\n/); // Pisahkan body menjadi beberapa baris
    const firstLine = lines[0].trim(); // Ambil baris pertama dan hilangkan spasi

    if (firstLine.startsWith("!")) {
        // Ekstrak perintah dan argumen dari baris pertama
        const commandParts = firstLine.slice(1).trim().split(" ");
        command = commandParts.shift()?.toLowerCase(); // Ambil perintah (kata pertama setelah '!')
        currentCommandArgs = commandParts; // Sisa kata di baris pertama adalah argumennya
    }

    if (!command) {
        // Jika tidak ada perintah yang valid (misalnya body hanya "!" atau format aneh)
        // Seharusnya tidak terjadi jika body.startsWith("!") sudah benar, tapi untuk keamanan
        await lenwy.sendMessage(sender, { text: "Format perintah tidak valid." });
        return;
    }
    // --- AKHIR PERUBAHAN PARSING PERINTAH ---

    switch (command) {
        case "halo":
            await lenwy.sendMessage(sender, { text: "Halo Juga!" });
            break;

        case "ping":
            await lenwy.sendMessage(sender, { text: "Pong!" });
            break;

        case "ai":
            if (currentCommandArgs.length === 0) { // Gunakan currentCommandArgs
                await lenwy.sendMessage(sender, { text: "Mau Tanya Apa Sama Ai?" });
                return;
            }
            try {
                const prompt = currentCommandArgs.join(" "); // Gunakan currentCommandArgs
                const response = await Ai4Chat(prompt); 
                let resultText = typeof response === 'string' ? response : (response.result || JSON.stringify(response));
                await lenwy.sendMessage(sender, { text: resultText });
            } catch (error) {
                console.error("Kesalahan AI:", error);
                await lenwy.sendMessage(sender, { text: `Terjadi Kesalahan AI: ${error.message}` });
            }
            break;

        case "proai":
            if (currentCommandArgs.length === 0) { // Gunakan currentCommandArgs
                await lenwy.sendMessage(sender, { text: "Mau tanya apa ke ProAI?" });
                return;
            }
            try {
                const prompt = currentCommandArgs.join(" "); // Gunakan currentCommandArgs
                const response = await agentAI(prompt);
                await lenwy.sendMessage(sender, { text: response });
            } catch (err) {
                console.error("Error ProAI:", err);
                await lenwy.sendMessage(sender, { text: `Terjadi kesalahan saat menghubungi ProAI: ${err.message}` });
            }
            break;

        case "ticket":
            // Cek apakah user sudah punya tiket aktif sebelum memproses pembuatan tiket baru
            if (activeUserTickets[sender]) {
                const existingTicketId = activeUserTickets[sender];
                try {
                    const [ticketCheck] = await db.query('SELECT status FROM tickets WHERE id = ? AND sender = ?', [existingTicketId, sender]);
                    if (ticketCheck.length > 0 && ticketCheck[0].status === 'open') {
                        await lenwy.sendMessage(sender, { text: `Anda sudah memiliki tiket aktif dengan ID TICKET-...-${String(existingTicketId).padStart(3, '0')}. Balas chat ini untuk melanjutkan, atau tutup tiket tersebut terlebih dahulu dengan perintah !closeticket.` });
                        return; // Hentikan proses jika sudah ada tiket aktif
                    } else {
                        // Tiket lama sudah closed atau tidak valid, bisa buat baru
                        delete activeUserTickets[sender];
                    }
                } catch (checkError) {
                    console.error("Error cek tiket aktif:", checkError);
                    // Lanjutkan pembuatan tiket baru jika ada error pengecekan
                }
            }

            // Regex untuk mem-parsing format tiket baru multi-baris
            // Perintah !ticket harus di baris pertama, diikuti oleh detailnya.
            // 'body' digunakan di sini karena mengandung seluruh input multi-baris.
            const ticketMatch = body.match(/^!ticket\s*\r?\nNama\s*:\s*(.+)\s*\r?\nKode Lokasi\s*:\s*(.+)\s*\r?\nKendala\s*:\s*([\s\S]+)/im);

            if (!ticketMatch) {
                await lenwy.sendMessage(sender, { 
                    text: "Mohon gunakan format berikut (pastikan setiap field di baris baru setelah `!ticket`)" 
                });
                await lenwy.sendMessage(sender, { 
                    text: "!ticket\nNama : [Nama Anda]\nKode Lokasi: [Kode Lokasi Anda]\nKendala: [Deskripsi Kendala Anda]" 
                });
                return;
            }
            
            const namaInput = ticketMatch[1].trim();
            const locationCodeInput = ticketMatch[2].trim().toUpperCase();
            const kendalaInput = ticketMatch[3].trim();

            if (!namaInput || !locationCodeInput || !kendalaInput) {
                await lenwy.sendMessage(sender, { text: "Nama, Kode Lokasi, dan Kendala tidak boleh kosong. Mohon lengkapi semua field." });
                return;
            }

            try {
                // 1. Buat entri di tabel 'tickets'
                const createdAt = new Date();
                const [ticketResult] = await db.query(
                    "INSERT INTO tickets (sender, name, message, status, created_at, updated_at, location_code) VALUES (?, ?, ?, 'open', ?, ?, ?)",
                    [sender, namaInput, kendalaInput, createdAt, createdAt, locationCodeInput]
                );
                const newTicketId = ticketResult.insertId;

                if (!newTicketId) {
                    throw new Error("Gagal mendapatkan ID tiket baru dari database.");
                }

                // 2. Simpan pesan awal di tabel 'messages'
                await db.query(
                    "INSERT INTO messages (ticket_id, sender, name, message, is_from_user, created_at) VALUES (?, ?, ?, ?, 1, ?)",
                    [newTicketId, sender, namaInput, kendalaInput, createdAt]
                );

                // 3. Tandai pengguna ini memiliki tiket aktif
                activeUserTickets[sender] = newTicketId;

                const displayTicketId = `TICKET-${createdAt.getFullYear()}${String(createdAt.getMonth() + 1).padStart(2, '0')}${String(createdAt.getDate()).padStart(2, '0')}-${String(newTicketId).padStart(3, '0')}`;

                await lenwy.sendMessage(sender, { text: `🎫 Tiket Anda (${displayTicketId}) berhasil dibuat.\nNama: ${namaInput}\nKode Lokasi: ${locationCodeInput}\nKendala: ${kendalaInput}\n\nSilakan balas chat ini untuk menambahkan detail atau pesan lain terkait tiket ini. Agent akan segera menghubungi anda` });

                // 4. Lakukan Broadcast ke grup berdasarkan kode lokasi
                const [groupRows] = await db.query(
                    "SELECT group_id FROM wa_groups WHERE location_code = ?",
                    [locationCodeInput]
                );

                if (groupRows.length > 0) {
                    const broadcastMessage = `🎫 Tiket Baru dari ${namaInput} (${sender.split('@')[0]}):\n\nID Tiket: ${displayTicketId}\nNama Pelapor: ${namaInput}\nKode Lokasi: ${locationCodeInput}\nKendala: ${kendalaInput}`;
                    for (const row of groupRows) {
                        await lenwy.sendMessage(row.group_id, {
                            text: broadcastMessage
                        });
                    }
                    // await lenwy.sendMessage(sender, { text: `Pesan tiket Anda juga telah di-broadcast ke grup terkait lokasi ${locationCodeInput}.` });
                } else {
                    await lenwy.sendMessage(sender, { text: `Catatan: Tidak ada grup WhatsApp yang terdaftar untuk me-broadcast tiket dari lokasi "${locationCodeInput}". Tiket Anda tetap tersimpan dan akan ditangani.` });
                }

            } catch (error) {
                console.error("❌ Gagal membuat tiket baru:", error);
                await lenwy.sendMessage(sender, { text: `Terjadi kesalahan teknis saat membuat tiket Anda. Silakan coba lagi nanti. (${error.message})` });
            }
            break;
        
        case "closeticket": 
            if (!activeUserTickets[sender]) {
                await lenwy.sendMessage(sender, { text: "Anda tidak memiliki tiket aktif yang bisa ditutup." });
                return;
            }
            const ticketToCloseId = activeUserTickets[sender];
            try {
                const [updateResult] = await db.query("UPDATE tickets SET status = 'closed', updated_at = ? WHERE id = ? AND sender = ? AND status = 'open'", [new Date(), ticketToCloseId, sender]);
                
                if (updateResult.affectedRows > 0) {
                    delete activeUserTickets[sender];
                    const displayCloseTicketId = `TICKET-...-${String(ticketToCloseId).padStart(3, '0')}`;
                    await lenwy.sendMessage(sender, { text: `Tiket ${displayCloseTicketId} telah berhasil ditutup.` });
                } else {
                    await lenwy.sendMessage(sender, { text: `Tiket dengan ID TICKET-...-${String(ticketToCloseId).padStart(3, '0')} tidak ditemukan atau sudah ditutup.` });
                    // Hapus dari activeUserTickets jika ternyata sudah tidak valid di DB
                    const [checkAgain] = await db.query("SELECT status FROM tickets WHERE id = ? AND sender = ?", [ticketToCloseId, sender]);
                    if (checkAgain.length === 0 || checkAgain[0].status !== 'open') {
                        delete activeUserTickets[sender];
                    }
                }
            } catch (closeError) {
                console.error("Error menutup tiket:", closeError);
                await lenwy.sendMessage(sender, { text: `Gagal menutup tiket. (${closeError.message})` });
            }
            break;


        case "ticketstatus":
            try {
                const [rows] = await db.query(
                    "SELECT id, name, message, created_at, status, location_code FROM tickets WHERE sender = ? ORDER BY created_at DESC LIMIT 5",
                    [sender]
                );

                if (rows.length === 0) {
                    await lenwy.sendMessage(sender, { text: "Anda belum memiliki tiket apa pun." });
                    return;
                }

                let ticketList = "🎫 *5 Tiket Terakhir Anda:*\n\n";
                rows.forEach((row) => {
                    const createdAtDate = new Date(row.created_at);
                    const displayTicketId = `TICKET-${createdAtDate.getFullYear()}${String(createdAtDate.getMonth() + 1).padStart(2, '0')}${String(createdAtDate.getDate()).padStart(2, '0')}-${String(row.id).padStart(3, '0')}`;
                    ticketList += `*ID: ${displayTicketId}*\n` +
                                  `Nama: ${row.name}\n` +
                                  `Lokasi: ${row.location_code || '-'}\n` +
                                  `Kendala Awal: ${row.message.substring(0, 50)}...\n` + 
                                  `🕒 Dibuat: ${createdAtDate.toLocaleString('id-ID', { timeZone: 'Asia/Jakarta' })}\n` +
                                  `Status: ${row.status === 'open' ? 'Dibuka' : (row.status === 'closed' ? 'Ditutup' : row.status)}\n\n`;
                });
                await lenwy.sendMessage(sender, { text: ticketList });
            } catch (err) {
                console.error("Gagal mengambil status tiket:", err);
                await lenwy.sendMessage(sender, { text: "Terjadi kesalahan saat mengambil status tiket Anda." });
            }
            break;

        case "listtickets": 
            if (!sender.endsWith("@g.us")) {
                await lenwy.sendMessage(sender, { text: "Perintah ini hanya bisa digunakan di dalam grup yang terdaftar." });
                return;
            }
            try {
                const [groupRows] = await db.query(
                    "SELECT location_code FROM wa_groups WHERE group_id = ? LIMIT 1",
                    [sender] 
                );

                if (groupRows.length === 0 || !groupRows[0].location_code) {
                    await lenwy.sendMessage(sender, { text: "Grup ini belum terdaftar dengan kode lokasi atau kode lokasi kosong." });
                    return;
                }
                const locationCode = groupRows[0].location_code;

                const [ticketRows] = await db.query(
                    "SELECT id, name, message, created_at, status FROM tickets WHERE location_code = ? ORDER BY created_at DESC LIMIT 10",
                    [locationCode]
                );

                if (ticketRows.length === 0) {
                    await lenwy.sendMessage(sender, { text: `Belum ada tiket untuk lokasi ${locationCode}.` });
                    return;
                }

                let ticketListMsg = `🎫 *Daftar Tiket untuk Lokasi ${locationCode} (10 Terbaru):*\n\n`;
                ticketRows.forEach((ticket) => {
                    const createdAtDate = new Date(ticket.created_at);
                    const displayTicketId = `TICKET-${createdAtDate.getFullYear()}${String(createdAtDate.getMonth() + 1).padStart(2, '0')}${String(createdAtDate.getDate()).padStart(2, '0')}-${String(ticket.id).padStart(3, '0')}`;
                    ticketListMsg += `*ID: ${displayTicketId}*\n` +
                                     `Pelapor: ${ticket.name}\n` +
                                     `Kendala Awal: ${ticket.message.substring(0, 50)}...\n` +
                                     `🕒 Dibuat: ${createdAtDate.toLocaleString('id-ID', { timeZone: 'Asia/Jakarta' })}\n` +
                                     `Status: ${ticket.status === 'open' ? 'Dibuka' : (ticket.status === 'closed' ? 'Ditutup' : ticket.status)}\n\n`;
                });
                await lenwy.sendMessage(sender, { text: ticketListMsg });
            } catch (err) {
                console.error("Error saat mengambil daftar tiket grup:", err);
                await lenwy.sendMessage(sender, { text: "Terjadi kesalahan saat mengambil daftar tiket untuk lokasi ini." });
            }
            break;
        
        case "help":
            const helpText =
`🤖 *Daftar Perintah Bot Helpdesk:*

• *!halo* - Menyapa bot.
• *!ping* - Cek respons bot.
• *!ai [pertanyaan]* - Bertanya kepada AI (model standar).
• *!proai [pertanyaan]* - Bertanya kepada AI (model pro).
• *!ticket* - Membuat tiket bantuan baru dengan format:
  \`\`\`
  !ticket
  Nama : [Nama Anda]
  Kode Lokasi: [Kode Lokasi Anda]
  Kendala: [Deskripsi Kendala Anda]
  \`\`\`
• *!ticketstatus* - Melihat status 5 tiket terakhir Anda.
• *!closeticket* - Menutup tiket Anda yang sedang aktif.
• *!listtickets* - (Khusus Admin di Grup) Melihat tiket berdasarkan lokasi grup.

Anda dapat membalas chat ini untuk melanjutkan percakapan pada tiket yang aktif.`;

            await lenwy.sendMessage(sender, {
                text: helpText,
            });
            break;

        default:
            await lenwy.sendMessage(sender, { text: `Perintah \`!${command}\` tidak dikenali. Ketik \`!help\` untuk daftar perintah.` });
    }
};
