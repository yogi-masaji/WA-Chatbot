// Panggil Scrape (jika masih digunakan untuk perintah lain)
const Ai4Chat = require('./scrape/Ai4Chat'); // Pastikan path ini benar
const agentAI = require('./scrape/agentAI'); // Pastikan path ini benar
// db tidak perlu di-require lagi di sini jika sudah di-pass sebagai argumen
// const db = require('./db');

// const pendingTickets = {}; // Hapus ini, tidak digunakan lagi

module.exports = async (lenwy, m, activeUserTickets, db) => { // Tambahkan activeUserTickets dan db sebagai parameter
    const msg = m.messages[0];
    if (!msg.message) return;

    const body = msg.message.conversation || msg.message.extendedTextMessage?.text || "";
    const sender = msg.key.remoteJid;
    const pushname = msg.pushName || "Pengguna WhatsApp"; // Default name

    // Logika untuk pendingTickets yang lama sudah dihapus karena !tiket sekarang langsung memproses.

    if (!body.startsWith("!")) return; // Hanya proses perintah

    const args = body.slice(1).trim().split(" ");
    const command = args.shift().toLowerCase();

    switch (command) {
        case "halo":
            await lenwy.sendMessage(sender, { text: "Halo Juga!" });
            break;

        case "ping":
            await lenwy.sendMessage(sender, { text: "Pong!" });
            break;

        case "ai":
            if (args.length === 0) {
                await lenwy.sendMessage(sender, { text: "Mau Tanya Apa Sama Ai?" });
                return;
            }
            try {
                const prompt = args.join(" ");
                const response = await Ai4Chat(prompt); // Pastikan Ai4Chat berfungsi
                await lenwy.sendMessage(sender, { text: response.result || response });
            } catch (error) {
                console.error("Kesalahan AI:", error);
                await lenwy.sendMessage(sender, { text: `Terjadi Kesalahan AI: ${error.message}` });
            }
            break;

        case "proai":
            if (args.length === 0) {
                await lenwy.sendMessage(sender, { text: "Mau tanya apa ke ProAI?" });
                return;
            }
            try {
                const prompt = args.join(" ");
                const response = await agentAI(prompt);
                await lenwy.sendMessage(sender, { text: response });
            } catch (err) {
                console.error("Error ProAI:", err);
                await lenwy.sendMessage(sender, { text: `Terjadi kesalahan saat menghubungi ProAI: ${err.message}` });
            }
            break;

        case "ticket":
            if (args.length === 0) {
                await lenwy.sendMessage(sender, { text: "Mohon sertakan isi pesan untuk tiket Anda.\nContoh: `!tiket Tolong bantu perbaiki printer saya.`" });
                return;
            }
            const initialTicketMessage = args.join(" ");

            // Cek apakah user sudah punya tiket aktif
            if (activeUserTickets[sender]) {
                const existingTicketId = activeUserTickets[sender];
                 try {
                    const [ticketCheck] = await db.query('SELECT status FROM tickets WHERE id = ? AND sender = ?', [existingTicketId, sender]);
                    if (ticketCheck.length > 0 && ticketCheck[0].status === 'open') {
                        await lenwy.sendMessage(sender, { text: `Anda sudah memiliki tiket aktif dengan ID #${existingTicketId}. Balas chat ini untuk melanjutkan, atau tutup tiket tersebut terlebih dahulu.` });
                        return;
                    } else {
                        // Tiket lama sudah closed atau tidak valid, bisa buat baru
                        delete activeUserTickets[sender];
                    }
                } catch (checkError) {
                    console.error("Error cek tiket aktif:", checkError);
                    // Lanjutkan pembuatan tiket baru jika ada error
                }
            }


            try {
                // 1. Buat entri di tabel 'tickets'
                const [ticketResult] = await db.query(
                    "INSERT INTO tickets (sender, name, message, status, created_at, updated_at, location_code) VALUES (?, ?, ?, 'open', ?, ?, NULL)",
                    [sender, pushname, initialTicketMessage, new Date(), new Date()]
                );
                const newTicketId = ticketResult.insertId;

                if (!newTicketId) {
                    throw new Error("Gagal mendapatkan ID tiket baru dari database.");
                }

                // 2. Simpan pesan awal di tabel 'messages'
                await db.query(
                    "INSERT INTO messages (ticket_id, sender, name, message, is_from_user, created_at) VALUES (?, ?, ?, ?, 1, ?)",
                    [newTicketId, sender, pushname, initialTicketMessage, new Date()]
                );

                // 3. Tandai pengguna ini memiliki tiket aktif
                activeUserTickets[sender] = newTicketId;

                const createdAtDate = new Date();
                const displayTicketId = `TICKET-${createdAtDate.getFullYear()}${String(createdAtDate.getMonth() + 1).padStart(2, '0')}${String(createdAtDate.getDate()).padStart(2, '0')}-${String(newTicketId).padStart(3, '0')}`;


                await lenwy.sendMessage(sender, { text: `🎫 Tiket Anda (${displayTicketId}) berhasil dibuat dengan pesan: "${initialTicketMessage}".\n\nSilakan balas chat ini untuk menambahkan detail atau pesan lain terkait tiket ini.` });

            } catch (error) {
                console.error("❌ Gagal membuat tiket baru:", error);
                await lenwy.sendMessage(sender, { text: `Terjadi kesalahan teknis saat membuat tiket Anda. Silakan coba lagi nanti. (${error.message})` });
                // Pastikan tidak ada state menggantung jika gagal
                if (activeUserTickets[sender]) { // Jika sempat ter-set tapi gagal di tengah jalan
                   // delete activeUserTickets[sender]; // Sebaiknya dihandle di blok error utama
                }
            }
            break;

        case "ticketstatus":
            try {
                const [rows] = await db.query(
                    "SELECT id, message, created_at, status FROM tickets WHERE sender = ? ORDER BY created_at DESC LIMIT 5",
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
                                  `Pesan: ${row.message.substring(0, 50)}...\n` +
                                  `🕒 Dibuat: ${createdAtDate.toLocaleString('id-ID')}\n` +
                                  `Status: ${row.status === 'open' ? 'Dibuka' : 'Ditutup'}\n\n`;
                });
                await lenwy.sendMessage(sender, { text: ticketList });
            } catch (err) {
                console.error("Gagal mengambil status tiket:", err);
                await lenwy.sendMessage(sender, { text: "Terjadi kesalahan saat mengambil status tiket Anda." });
            }
            break;

        case "listtickets": // Perintah ini biasanya untuk admin di grup tertentu
            if (!sender.endsWith("@g.us")) {
                await lenwy.sendMessage(sender, { text: "Perintah ini hanya bisa digunakan di dalam grup yang terdaftar." });
                return;
            }
            try {
                const [groupRows] = await db.query(
                    "SELECT location_code FROM wa_groups WHERE group_id = ? LIMIT 1",
                    [sender] // sender di sini adalah group_id
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

                let ticketListMsg = `🎫 *Daftar Tiket untuk Lokasi ${locationCode}:*\n\n`;
                ticketRows.forEach((ticket) => {
                     const createdAtDate = new Date(ticket.created_at);
                    const displayTicketId = `TICKET-${createdAtDate.getFullYear()}${String(createdAtDate.getMonth() + 1).padStart(2, '0')}${String(createdAtDate.getDate()).padStart(2, '0')}-${String(ticket.id).padStart(3, '0')}`;
                    ticketListMsg += `*ID: ${displayTicketId}* (Pelapor: ${ticket.name})\n` +
                                     `Pesan: ${ticket.message.substring(0, 50)}...\n` +
                                     `🕒 Dibuat: ${createdAtDate.toLocaleString('id-ID')}\n` +
                                     `Status: ${ticket.status === 'open' ? 'Dibuka' : 'Ditutup'}\n\n`;
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
• *!tiket [deskripsi masalah]* - Membuat tiket bantuan baru.
  Contoh: \`!tiket Printer tidak bisa mencetak\`
• *!ticketstatus* - Melihat status 5 tiket terakhir Anda.
• *!listtickets* - (Khusus Admin di Grup) Melihat tiket berdasarkan lokasi grup.

Anda dapat membalas chat ini untuk melanjutkan percakapan pada tiket yang aktif.`;

            // Tombol bisa ditambahkan jika platform mendukung dan Baileys dikonfigurasi untuk itu
            // const buttons = [
            //     { buttonId: "!ticket", buttonText: { displayText: "Buat Tiket Baru" }, type: 1 },
            //     { buttonId: "!ticketstatus", buttonText: { displayText: "Cek Status Tiket Saya" }, type: 1 }
            // ];
            await lenwy.sendMessage(sender, {
                text: helpText,
                // footer: "Pilih opsi atau ketik perintah.",
                // buttons: buttons, // Aktifkan jika ingin menggunakan tombol
                // headerType: 1
            });
            break;

        default:
            // Jangan kirim "Perintah tidak dikenali" jika itu bukan pesan yang dimulai dengan "!"
            // karena sudah ditangani di index.js untuk AI atau pesan tiket.
            // Jika sampai sini, berarti memang perintah tidak valid.
            await lenwy.sendMessage(sender, { text: `Perintah \`!${command}\` tidak dikenali. Ketik \`!help\` untuk daftar perintah.` });
    }
};
