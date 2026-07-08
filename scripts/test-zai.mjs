import { GoogleGenAI } from '@google/genai';

const apiKey = process.env.GEMINI_API_KEY;
if (!apiKey) {
  throw new Error(
    'GEMINI_API_KEY is not set. Get a free key at https://aistudio.google.com/apikey and set it in your env.',
  );
}
const client = new GoogleGenAI({ apiKey });

const stream = await client.models.generateContentStream({
  model: 'gemini-2.0-flash',
  contents: [{ role: 'user', parts: [{ text: 'Count from 1 to 5' }] }],
});

let i = 0;
for await (const chunk of stream) {
  i++;
  console.log(`--- chunk ${i} ---`);
  console.log(JSON.stringify(chunk, null, 2).slice(0, 500));
  if (i > 5) break;
}
