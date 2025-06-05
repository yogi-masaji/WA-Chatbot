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
            const ticketId = activeUserTickets[sender]; // This is the auto-incremented 'id'
            const userMessage = body.trim();

            if (userMessage) { // Hanya proses jika ada pesan
                try {
                    // Cek apakah tiket masih 'open'
                    const [ticketStatusRows] = await db.query("SELECT status, name, id_ticket FROM tickets WHERE id = ? AND sender = ?", [ticketId, sender]);
                    if (ticketStatusRows.length === 0 || ticketStatusRows[0].status !== 'open') {
                        // Attempt to get the id_ticket for the message even if closed
                        const closedTicketIdTicket = ticketStatusRows.length > 0 ? ticketStatusRows[0].id_ticket : `TICKET-...-${String(ticketId).padStart(3, '0')}`;
                        await lenwy.sendMessage(sender, { text: `Tiket Anda ${closedTicketIdTicket} sudah tidak aktif atau ditutup. Silakan buat tiket baru jika perlu.` });
                        delete activeUserTickets[sender];
                        return;
                    }
                    const ticketName = ticketStatusRows[0].name || pushname; // Gunakan nama dari tiket jika ada
                    const currentIdTicket = ticketStatusRows[0].id_ticket || `TICKET-...-${String(ticketId).padStart(3, '0')}`;


                    // Simpan balasan ke tabel messages
                    await db.query(
                        "INSERT INTO messages (ticket_id, sender, name, message, is_from_user, created_at) VALUES (?, ?, ?, ?, 1, ?)",
                        [ticketId, sender, ticketName, userMessage, new Date()]
                    );
                    // Perbarui updated_at di tabel tickets
                    await db.query("UPDATE tickets SET updated_at = ? WHERE id = ?", [new Date(), ticketId]);

                    await lenwy.sendMessage(sender, { text: `Pesan Anda telah ditambahkan ke tiket ${currentIdTicket}. Tim kami akan segera merespons.` });
                    
                    // Optional: Notifikasi ke admin/grup bahwa ada balasan baru
                    const [ticketDetails] = await db.query("SELECT location_code, id_ticket FROM tickets WHERE id = ?", [ticketId]);
                    const ticketLocationCode = ticketDetails.length > 0 ? ticketDetails[0].location_code : null;
                    const ticketIdForNotification = ticketDetails.length > 0 ? ticketDetails[0].id_ticket : currentIdTicket;

                    if (ticketLocationCode) {
                        const [groupRowsReply] = await db.query("SELECT group_id FROM wa_groups WHERE location_code = ?", [ticketLocationCode]);
                        if (groupRowsReply.length > 0) {
                            const replyNotification = `💬 Balasan baru pada Tiket ${ticketIdForNotification} (${ticketName}):\n\n"${userMessage.substring(0,100)}..."`;
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
                // Ensure response is a string before sending
                const responseText = (typeof response === 'object' && response !== null && response.choices && response.choices[0] && response.choices[0].message && response.choices[0].message.content)
                                     ? response.choices[0].message.content
                                     : (typeof response === 'string' ? response : "Maaf, saya tidak dapat memproses permintaan Anda saat ini.");

                await lenwy.sendMessage(sender, { text: responseText });
            } catch (err) {
                console.error("Error ProAI:", err);
                await lenwy.sendMessage(sender, { text: `Terjadi kesalahan saat menghubungi ProAI: ${err.message}` });
            }
            break;

        case "ticket":
            // Cek apakah user sudah punya tiket aktif sebelum memproses pembuatan tiket baru
            if (activeUserTickets[sender]) {
                const existingTicketId = activeUserTickets[sender]; // This is the auto-incremented 'id'
                try {
                    const [ticketCheck] = await db.query('SELECT status, id_ticket FROM tickets WHERE id = ? AND sender = ?', [existingTicketId, sender]);
                    if (ticketCheck.length > 0 && ticketCheck[0].status === 'open') {
                        const existingIdTicket = ticketCheck[0].id_ticket || `TICKET-...-${String(existingTicketId).padStart(3, '0')}`;
                        await lenwy.sendMessage(sender, { text: `Anda sudah memiliki tiket aktif ${existingIdTicket}. Balas chat ini untuk melanjutkan, atau tutup tiket tersebut terlebih dahulu dengan perintah !closeticket.` });
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
            // Regex diupdate untuk menangkap field Lokasi
            const ticketMatch = body.match(/^!ticket\s*\r?\nNama\s*:\s*(.+)\s*\r?\nGM\s*:\s*(.+)\s*\r?\nLokasi\s*:\s*(.+)\s*\r?\nKendala\s*:\s*([\s\S]+)/im);

            if (!ticketMatch) {
               await lenwy.sendMessage(sender, { 
    text: `Mohon gunakan format berikut (pastikan setiap field di baris baru setelah !ticket dan isi semua field).\n
kode GM: 
- MSR (M Soleh)
- EKA (Endro)
- DA (Dian)
- DL (Dolly)`
});

                // Pesan contoh format diperbarui
                await lenwy.sendMessage(sender, { 
                    text: "!ticket\nNama : [Nama Anda]\nGM: [Kode GM]\nLokasi: [Lokasi Anda]\nKendala: [Deskripsi Kendala Anda]" 
                });
                return;
            }
            
            const namaInput = ticketMatch[1].trim();
            const gmInput = ticketMatch[2].trim().toUpperCase(); // Tetap sebagai location_code
            const lokasiInput = ticketMatch[3].trim(); // Input untuk location_name
            const kendalaInput = ticketMatch[4].trim(); // Kendala sekarang di group 4

            if (!namaInput || !gmInput || !lokasiInput || !kendalaInput) {
                await lenwy.sendMessage(sender, { text: "Nama, Kode GM, Lokasi, dan Kendala tidak boleh kosong. Mohon lengkapi semua field." });
                return;
            }

            try {
                const createdAt = new Date();
                // 1. Buat entri di tabel 'tickets'
                // Query INSERT diupdate untuk menyertakan location_name
                const [ticketResult] = await db.query(
                    "INSERT INTO tickets (sender, name, message, status, created_at, updated_at, location_code, location_name) VALUES (?, ?, ?, 'open', ?, ?, ?, ?)",
                    [sender, namaInput, kendalaInput, createdAt, createdAt, gmInput, lokasiInput]
                );
                const newTicketDbId = ticketResult.insertId; 

                if (!newTicketDbId) {
                    throw new Error("Gagal mendapatkan ID tiket baru dari database.");
                }

                // 2. Generate id_ticket sesuai format yang diinginkan
                const formattedIdTicket = `TICKET-${createdAt.getFullYear()}${String(createdAt.getMonth() + 1).padStart(2, "0")}${String(createdAt.getDate()).padStart(2, "0")}-${String(newTicketDbId).padStart(3, "0")}`;

                // 3. Update record tiket dengan id_ticket yang sudah diformat
                await db.query(
                    "UPDATE tickets SET id_ticket = ? WHERE id = ?",
                    [formattedIdTicket, newTicketDbId]
                );

                // 4. Simpan pesan awal di tabel 'messages'
                await db.query(
                    "INSERT INTO messages (ticket_id, sender, name, message, is_from_user, created_at) VALUES (?, ?, ?, ?, 1, ?)",
                    [newTicketDbId, sender, namaInput, kendalaInput, createdAt]
                );

                // 5. Tandai pengguna ini memiliki tiket aktif
                activeUserTickets[sender] = newTicketDbId;

                // Pesan sukses diupdate dengan field Lokasi
                await lenwy.sendMessage(sender, { text: `🎫 Tiket Anda (${formattedIdTicket}) berhasil dibuat.\nNama: ${namaInput}\nGM: ${gmInput}\nLokasi: ${lokasiInput}\nKendala: ${kendalaInput}\n\nSilakan balas chat ini untuk menambahkan detail atau pesan lain terkait tiket ini. Agent akan segera menghubungi anda` });

                // 6. Lakukan Broadcast ke grup berdasarkan kode lokasi (gmInput)
                const [groupRows] = await db.query(
                    "SELECT group_id FROM wa_groups WHERE location_code = ?",
                    [gmInput] // Menggunakan gmInput sebagai location_code untuk broadcast
                );

                if (groupRows.length > 0) {
                    // Pesan broadcast diupdate dengan field Lokasi
                    const broadcastMessage = `🎫 Tiket Baru dari ${namaInput} (${sender.split('@')[0]}):\n\nID Tiket: ${formattedIdTicket}\nNama Pelapor: ${namaInput}\nGM: ${gmInput}\nLokasi: ${lokasiInput}\nKendala: ${kendalaInput}`;
                    for (const row of groupRows) {
                        await lenwy.sendMessage(row.group_id, {
                            text: broadcastMessage
                        });
                    }
                } else {
                    await lenwy.sendMessage(sender, { text: `Catatan: Tidak ada grup WhatsApp yang terdaftar untuk me-broadcast tiket dari GM/Kode Lokasi "${gmInput}". Tiket Anda tetap tersimpan dan akan ditangani.` });
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
            const ticketToCloseDbId = activeUserTickets[sender]; 
            try {
                const [ticketInfo] = await db.query("SELECT id_ticket FROM tickets WHERE id = ? AND sender = ? AND status = 'open'", [ticketToCloseDbId, sender]);
                const idTicketToDisplay = (ticketInfo.length > 0 && ticketInfo[0].id_ticket) 
                                          ? ticketInfo[0].id_ticket 
                                          : `TICKET-...-${String(ticketToCloseDbId).padStart(3, '0')}`;

                const [updateResult] = await db.query("UPDATE tickets SET status = 'closed', updated_at = ? WHERE id = ? AND sender = ? AND status = 'open'", [new Date(), ticketToCloseDbId, sender]);
                
                if (updateResult.affectedRows > 0) {
                    delete activeUserTickets[sender];
                    await lenwy.sendMessage(sender, { text: `Tiket ${idTicketToDisplay} telah berhasil ditutup.` });
                } else {
                    await lenwy.sendMessage(sender, { text: `Tiket ${idTicketToDisplay} tidak ditemukan atau sudah ditutup.` });
                    const [checkAgain] = await db.query("SELECT status FROM tickets WHERE id = ? AND sender = ?", [ticketToCloseDbId, sender]);
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
                // Ambil juga location_name
                const [rows] = await db.query(
                    "SELECT id, id_ticket, name, message, created_at, status, location_code, location_name FROM tickets WHERE sender = ? ORDER BY created_at DESC LIMIT 5",
                    [sender]
                );

                if (rows.length === 0) {
                    await lenwy.sendMessage(sender, { text: "Anda belum memiliki tiket apa pun." });
                    return;
                }

                let ticketList = "🎫 *5 Tiket Terakhir Anda:*\n\n";
                rows.forEach((row) => {
                    const displayId = row.id_ticket ? row.id_ticket : `TICKET-${new Date(row.created_at).getFullYear()}${String(new Date(row.created_at).getMonth() + 1).padStart(2, '0')}${String(new Date(row.created_at).getDate()).padStart(2, '0')}-${String(row.id).padStart(3, '0')}`;
                    
                    ticketList += `*ID: ${displayId}*\n` +
                                  `Nama: ${row.name}\n` +
                                  `GM: ${row.location_code || '-'}\n` +
                                  `Lokasi: ${row.location_name || '-'}\n` + // Tampilkan location_name
                                  `Kendala Awal: ${row.message.substring(0, 50)}...\n` + 
                                  `🕒 Dibuat: ${new Date(row.created_at).toLocaleString('id-ID', { timeZone: 'Asia/Jakarta' })}\n` +
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

                // Ambil juga location_name
                const [ticketRows] = await db.query(
                    "SELECT id, id_ticket, name, message, created_at, status, location_name FROM tickets WHERE location_code = ? ORDER BY created_at DESC LIMIT 10",
                    [locationCode]
                );

                if (ticketRows.length === 0) {
                    await lenwy.sendMessage(sender, { text: `Belum ada tiket untuk lokasi ${locationCode}.` });
                    return;
                }

                let ticketListMsg = `🎫 *Daftar Tiket untuk GM/Kode Lokasi ${locationCode} (10 Terbaru):*\n\n`;
                ticketRows.forEach((ticket) => {
                    const displayIdGroup = ticket.id_ticket ? ticket.id_ticket : `TICKET-${new Date(ticket.created_at).getFullYear()}${String(new Date(ticket.created_at).getMonth() + 1).padStart(2, '0')}${String(new Date(ticket.created_at).getDate()).padStart(2, '0')}-${String(ticket.id).padStart(3, '0')}`;
                    ticketListMsg += `*ID: ${displayIdGroup}*\n` +
                                     `Pelapor: ${ticket.name}\n` +
                                     `Lokasi: ${ticket.location_name || '-'}\n` + // Tampilkan location_name
                                     `Kendala Awal: ${ticket.message.substring(0, 50)}...\n` +
                                     `🕒 Dibuat: ${new Date(ticket.created_at).toLocaleString('id-ID', { timeZone: 'Asia/Jakarta' })}\n` +
                                     `Status: ${ticket.status === 'open' ? 'Dibuka' : (ticket.status === 'closed' ? 'Ditutup' : ticket.status)}\n\n`;
                });
                await lenwy.sendMessage(sender, { text: ticketListMsg });
            } catch (err) {
                console.error("Error saat mengambil daftar tiket grup:", err);
                await lenwy.sendMessage(sender, { text: "Terjadi kesalahan saat mengambil daftar tiket untuk lokasi ini." });
            }
            break;
        
        case "help":
            // Teks bantuan diupdate untuk format !ticket
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
  GM: [Kode GM Anda]
  Lokasi: [Lokasi Anda]
  Kendala: [Deskripsi Kendala Anda]
  \`\`\`
• *!ticketstatus* - Melihat status 5 tiket terakhir Anda.
• *!closeticket* - Menutup tiket aktif Anda.

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
