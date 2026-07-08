import ZAI from 'z-ai-web-dev-sdk';
const zai = await ZAI.create();

console.log('=== Test 1: stream: true ===');
const r = await zai.chat.completions.create({
  messages: [{ role: 'user', content: 'Say hello in 3 words' }],
  stream: true,
});
console.log('Type:', typeof r);
console.log('Is async iterator?', r && typeof r[Symbol.asyncIterator] === 'function');
console.log('Has choices?', !!(r && r.choices));
if (r && r.choices) {
  console.log('Full response (non-streamed):', JSON.stringify(r, null, 2));
}

console.log('\n=== Test 2: no stream flag ===');
const r2 = await zai.chat.completions.create({
  messages: [{ role: 'user', content: 'Say hi' }],
});
console.log('Type:', typeof r2);
console.log('Full response:', JSON.stringify(r2, null, 2));
