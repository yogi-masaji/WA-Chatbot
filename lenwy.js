// Panggil Scrape
const Ai4Chat = require('./scrape/Ai4Chat')

// Fungsi Dari Index.js
module.exports = async (lenwy, m) => {
    const msg = m.messages[0]
    if (!msg.message) return
    
    const body = msg.message.conversation || msg.message.extendedTextMessage?.text || ""
    const sender = msg.key.remoteJid
    const pushname = msg.pushName || "Lenwy"

    // Prefix Bot Lenwy
    if (!body.startsWith("!")) return

    // Eksekusi Perintah Setelah Prefix
    const args = body.slice(1).trim().split(" ")
    const command = args.shift().toLowerCase()

    // Fitur Bot
    switch (command) {
        case "halo" :
            await lenwy.sendMessage(sender, { text: "Halo Juga!"})
            break

        case "ping" :
            await lenwy.sendMessage(sender, { text: "Pong!"})
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
    }
}