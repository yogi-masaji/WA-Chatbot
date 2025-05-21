    // Panggil Scrape
    const Ai4Chat = require('./scrape/Ai4Chat')
    const agentAI = require('./scrape/agentAI');
    const db = require('./db'); // pastikan sudah import koneksi db

module.exports = async (lenwy, m) => {
    const msg = m.messages[0]
    if (!msg.message) return

    const body = msg.message.conversation || msg.message.extendedTextMessage?.text || ""
    const sender = msg.key.remoteJid
    const pushname = msg.pushName || "Lenwy"

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



        case "ticket":
            if (args.length === 0) {
                await lenwy.sendMessage(sender, { text: "Mohon tulis pesan tiketnya setelah perintah !ticket" })
                return
            }
            try {
                const ticketMessage = args.join(" ")

                // Simpan ke DB
                await db.query("INSERT INTO tickets (sender, message) VALUES (?, ?)", [sender, ticketMessage])

                await lenwy.sendMessage(sender, { text: "🎫 Tiket Anda sudah berhasil dikirim. Terima kasih!" })
            } catch (error) {
                console.error("Error menyimpan tiket:", error)
                await lenwy.sendMessage(sender, { text: `Terjadi kesalahan: ${error.message}` })
            }
            break

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
            ticketList += `*#${row.id}*\n${row.message}\n🕒 ${row.created_at.toLocaleString()}\n\n`;
        });

        await lenwy.sendMessage(sender, { text: ticketList });
    } catch (err) {
        console.error("Gagal mengambil tiket:", err);
        await lenwy.sendMessage(sender, { text: "Terjadi kesalahan saat mengambil tiket." });
    }
    break;


        default:
            await lenwy.sendMessage(sender, { text: "Perintah tidak dikenali." })
    }
}
