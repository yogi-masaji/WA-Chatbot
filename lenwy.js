    // Panggil Scrape
    const Ai4Chat = require('./scrape/Ai4Chat')
    const agentAI = require('./scrape/agentAI');
    const db = require('./db'); // pastikan sudah import koneksi db

    const pendingTickets = {};

module.exports = async (lenwy, m) => {
    const msg = m.messages[0]
    if (!msg.message) return

    const body = msg.message.conversation || msg.message.extendedTextMessage?.text || ""
    const sender = msg.key.remoteJid
    const pushname = msg.pushName || "Lenwy"

 if (pendingTickets[sender]) {
    const namaMatch = body.match(/Nama:\s*(.+)/i);
    const lokasiMatch = body.match(/Kode\s*Lokasi:\s*(.+)/i);
    const pesanMatch = body.match(/Pesan:\s*(.+)/i);

    if (namaMatch && lokasiMatch && pesanMatch) {
        const nama = namaMatch[1].trim();
        const locationCode = lokasiMatch[1].trim();
        const message = pesanMatch[1].trim();

        try {
            await db.query(
                "INSERT INTO tickets (sender, name, location_code, message) VALUES (?, ?, ?, ?)",
                [sender, nama, locationCode, message]
            );

            await lenwy.sendMessage(sender, {
                text: `✅ Tiket berhasil dikirim. Terima kasih, ${nama}!`
            });

            // Optional: Broadcast ke grup berdasarkan kode lokasi
            const [rows] = await db.query(
                "SELECT group_id FROM wa_groups WHERE location_code = ?",
                [locationCode]
            );

            for (const row of rows) {
                await lenwy.sendMessage(row.group_id, {
                    text: `🎫 Tiket Baru dari ${nama} (${sender}):\n\n${message}`
                });
            }

        } catch (err) {
            console.error("❌ Gagal menyimpan tiket:", err);
            await lenwy.sendMessage(sender, { text: `❌ Gagal menyimpan tiket: ${err.message}` });
        }
    } else {
        await lenwy.sendMessage(sender, {
            text: `❌ Format tidak sesuai. Mohon isi seperti ini:\n\nNama: [Nama Anda]\nKode Lokasi: [Kode Lokasi]\nPesan: [Isi pesan]`
        });
    }

    delete pendingTickets[sender];
}


    if (!body.startsWith("!")) return

    const args = body.slice(1).trim().split(" ")
    const command = args.shift().toLowerCase()

    switch (command) {
        case "halo":
            await lenwy.sendMessage(sender, { text: "Halo Juga!" })
            break

        case "ping":
            await lenwy.sendMessage(sender, { text: "Pong!" })
            break

        case "ai" :
            if (args.length === 0 ) {
                await lenwy.sendMessage(sender, { text: "Mau Tanya Apa Sama Ai?"})
                return
            }    
            try {
                const prompt = args.join(" ")
                const response = await Ai4Chat(prompt)

                let resultText
                if (typeof response === 'string') {
                    resultText = response
                } else if (typeof response === 'object' && response.result) {
                    resultText = response
                } else {
                    throw new Error("Format Tidak Di Dukung")
                }

                await lenwy.sendMessage(sender, { text: resultText})
            } catch (error) {
                console.error("Kesalahan :". error)
                await lenwy.sendMessage(sender, { text: `Terjadi Kesalahan : ${error.message}`})
            }
            break


            case "proai":
    if (args.length === 0) {
        await lenwy.sendMessage(sender, { text: "Mau tanya apa ke ProAI?" });
        return;
    }
    try {
        const prompt = args.join(" ");
        const response = await agentAI(prompt); // <--- HARUS ADA DI SINI!

        await lenwy.sendMessage(sender, { text: response });
    } catch (err) {
        console.error("Error ProAI:", err);
        await lenwy.sendMessage(sender, { text: `Terjadi kesalahan saat menghubungi ProAI: ${err.message}` });
    }
    break;


        
        // case "ticket":
        //     if (args.length === 0) {
        //         await lenwy.sendMessage(sender, { text: "Mohon tulis pesan tiketnya setelah perintah !ticket" })
        //         return
        //     }
        //     try {
        //         const ticketMessage = args.join(" ")

        //         // Simpan ke DB
        //         await db.query("INSERT INTO tickets (sender, message) VALUES (?, ?)", [sender, ticketMessage])

        //         await lenwy.sendMessage(sender, { text: "🎫 Tiket Anda sudah berhasil dikirim. Terima kasih!" })
        //     } catch (error) {
        //         console.error("Error menyimpan tiket:", error)
        //         await lenwy.sendMessage(sender, { text: `Terjadi kesalahan: ${error.message}` })
        //     }
        //     break

        case "ticket":
    pendingTickets[sender] = true;
    await lenwy.sendMessage(sender, {
        text:
`📝 Mohon masukkan data tiket dengan format berikut:`
    });
    await lenwy.sendMessage(sender, {
        text:
`Nama: [Nama Anda]  
Kode Lokasi: [Kode Lokasi]  
Pesan: [Isi pesan]`
    });
    break;


            case "ticketstatus":
    try {
        const [rows] = await db.query(
            "SELECT * FROM tickets WHERE sender = ? ORDER BY created_at DESC LIMIT 5",
            [sender] // ini '628xxxxx@s.whatsapp.net'
        );

        if (rows.length === 0) {
            await lenwy.sendMessage(sender, { text: "Kamu belum punya tiket apa pun." });
            return;
        }

        let ticketList = "🎫 *Tiket Kamu:*\n\n";
        rows.forEach((row, i) => {
    ticketList += `*#${i + 1}*\n` + // Nomor tiket
                  `Pesan: ${row.message}\n` + // Isi pesan/subjek tiket
                  `🕒 ${row.created_at.toLocaleString()}\n` + // Waktu pembuatan
                  `Status: ${row.status}\n\n`; // Status tiket, diikuti dua baris baru untuk pemisah
});

        await lenwy.sendMessage(sender, { text: ticketList });
    } catch (err) {
        console.error("Gagal mengambil tiket:", err);
        await lenwy.sendMessage(sender, { text: "Terjadi kesalahan saat mengambil tiket." });
    }
    break;



    case "listtickets":
    if (!sender.endsWith("@g.us")) {
        // Jika command dipanggil bukan di grup, beritahu user
        await lenwy.sendMessage(sender, { text: "Perintah ini hanya bisa digunakan di grup." });
        return;
    }

    try {
        // Cari kode lokasi grup ini
        const [groupRows] = await db.query(
            "SELECT location_code FROM wa_groups WHERE group_id = ? LIMIT 1",
            [sender]
        );

        if (groupRows.length === 0) {
            await lenwy.sendMessage(sender, { text: "Grup ini belum terdaftar dengan kode lokasi." });
            return;
        }

        const locationCode = groupRows[0].location_code;

        // Ambil tiket berdasarkan kode lokasi grup
        const [ticketRows] = await db.query(
            "SELECT id, name, message, created_at FROM tickets WHERE location_code = ? ORDER BY created_at DESC LIMIT 10",
            [locationCode]
        );

        if (ticketRows.length === 0) {
            await lenwy.sendMessage(sender, { text: "Belum ada tiket untuk lokasi ini." });
            return;
        }

        // Buat list tiket
        let ticketList = `🎫 *Daftar Tiket untuk Lokasi ${locationCode}:*\n\n`;
        ticketRows.forEach((ticket, index) => {
    ticketList += `*#${index + 1}* dari ${ticket.name}\nPesan: ${ticket.message}\n🕒 ${new Date(ticket.created_at).toLocaleString()}\n\n`;
});


        await lenwy.sendMessage(sender, { text: ticketList });
    } catch (err) {
        console.error("Error saat mengambil daftar tiket:", err);
        await lenwy.sendMessage(sender, { text: "Terjadi kesalahan saat mengambil daftar tiket." });
    }
    break;



    case "help":
    const helpText = 
`🤖 *Daftar Perintah:*

• !ping - Cek respons bot
• !ai [pertanyaan] - Tanya AI biasa
• !proai [pertanyaan] - Tanya AI pro
• !ticket - Tambah tiket baru
• !ticketstatus - Lihat status tiketmu
• !listtickets - (Grup) Lihat tiket lokasi grup

Pilih tombol di bawah untuk cepat menggunakan perintah.`;

    const buttons = [
        { buttonId: "!ticketstatus", buttonText: { displayText: "Show Tickets" }, type: 1 },
        { buttonId: "!ticket", buttonText: { displayText: "Add Ticket" }, type: 1 }
    ];

    await lenwy.sendMessage(sender, {
        text: helpText,
        footer: "Select an option below 👇",
        buttons: buttons,
        headerType: 1 // TEXT
    }, { quoted: msg });


    break;


        default:
            await lenwy.sendMessage(sender, { text: "Perintah tidak dikenali." })
    }
   
}
