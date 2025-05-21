require('dotenv').config();


const { Pinecone } = require('@pinecone-database/pinecone');

const pc = new Pinecone({ apiKey: process.env.PINECONE_API_KEY });
const assistantName = 'cp-guide';

const assistant = pc.Assistant(assistantName);
async function main() {
  const chatResp = await assistant.chatCompletion({
      messages: [{ role: 'user', content: 'Sop lahan parkir' }]
    });

    const cleanContent = chatResp.choices[0].message.content
    .replace(/\[\d+(?:,\s*(?:pp\.|p\.)\s*[\d-]+)?\]/g, '') // Remove citations like [1] or [1, pp. 1-2]
    .replace(/References:[\s\S]*$/, '') // Remove everything after "References:"
    .trim(); // Remove extra whitespace

    console.log("Jawaban bersih dari AI:", cleanContent);
  console.log(chatResp);
//   console.log("Jawaban dari AI:", chatResp.choices[0].message.content);
//   console.log("Jawaban dari AI:", chatResp.choices[0]);
}

main();