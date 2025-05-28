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
    .replace(/\[\d+(?:,\s*(?:pp\.|p\.)\s*[\d-]+)?\]/g, '') // Remove citations like [1]
    .replace(/References:[\s\S]*$/, '') // Remove original references
    .trim()
    + `\n\nReferences:\n1. [Parkee Troubleshooting Handbook](https://bit.ly/Handbook-Panduan-Troubleshooting)`;

  console.log("Jawaban bersih dari AI:", cleanContent);
}

main();
