import { GoogleGenAI } from '@google/genai';

const apiKey = process.env.GEMINI_API_KEY;
if (!apiKey) {
  throw new Error(
    'GEMINI_API_KEY is not set. Get a free key at https://aistudio.google.com/apikey and set it in your env.',
  );
}
const client = new GoogleGenAI({ apiKey });

console.log('=== Test 1: generateContentStream (streaming) ===');
const r = await client.models.generateContentStream({
  model: 'gemini-2.0-flash',
  contents: [{ role: 'user', parts: [{ text: 'Say hello in 3 words' }] }],
});
console.log('Type:', typeof r);
console.log(
  'Is async iterator?',
  r && typeof r[Symbol.asyncIterator] === 'function',
);

let streamed = '';
for await (const chunk of r) {
  const text = typeof chunk?.text === 'string' ? chunk.text : '';
  process.stdout.write(text);
  streamed += text;
}
console.log('\nFull streamed text:', streamed);

console.log('\n=== Test 2: generateContent (non-streaming) ===');
const r2 = await client.models.generateContent({
  model: 'gemini-2.0-flash',
  contents: [{ role: 'user', parts: [{ text: 'Say hi' }] }],
});
console.log('Type:', typeof r2);
console.log('Text:', r2.text);
console.log('Full response:', JSON.stringify(r2, null, 2));
