require('dotenv').config();


const { Pinecone } = require('@pinecone-database/pinecone');

const pc = new Pinecone({ apiKey: process.env.PINECONE_API_KEY });
const assistantName = 'cp-guide';

const assistant = pc.Assistant(assistantName);
async function agentAI(prompt) {
  try {
    const chatResp = await assistant.chatCompletion({
      messages: [{ role: 'user', content: prompt }]
    });

    const reply = chatResp.choices?.[0]?.message?.content;
    if (!reply) throw new Error("Tidak ada jawaban dari AI");

    return reply;
  } catch (error) {
    console.error("Gagal mendapatkan jawaban dari ProAI:", error);
    throw error; // biar bisa ditangkap oleh try-catch di lenwy.js
  }
}

// main();
module.exports = agentAI;
