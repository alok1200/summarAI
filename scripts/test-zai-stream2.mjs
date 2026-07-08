import { GoogleGenAI } from '@google/genai';

const apiKey = process.env.GEMINI_API_KEY;
if (!apiKey) {
  throw new Error(
    'GEMINI_API_KEY is not set. Get a free key at https://aistudio.google.com/apikey and set it in your env.',
  );
}
const client = new GoogleGenAI({ apiKey });

console.log('=== Streaming test ===');
const stream = await client.models.generateContentStream({
  model: 'gemini-2.0-flash',
  contents: [{ role: 'user', parts: [{ text: 'Count from 1 to 5' }] }],
});

let chunkCount = 0;
let totalContent = '';
try {
  for await (const chunk of stream) {
    chunkCount++;
    const delta = typeof chunk?.text === 'string' ? chunk.text : '';
    if (delta.length > 0) {
      totalContent += delta;
      process.stdout.write(delta);
    }
  }
  console.log('\n--- Stream ended ---');
  console.log('Total chunks:', chunkCount);
  console.log('Total content:', JSON.stringify(totalContent));
} catch (err) {
  console.error('Stream error:', err.message);
}
