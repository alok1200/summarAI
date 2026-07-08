import ZAI from 'z-ai-web-dev-sdk';
const zai = await ZAI.create();

console.log('=== Streaming test ===');
const stream = await zai.chat.completions.create({
  messages: [{ role: 'user', content: 'Count from 1 to 5' }],
  stream: true,
});

let chunkCount = 0;
let totalContent = '';
try {
  for await (const chunk of stream) {
    chunkCount++;
    const delta = chunk?.choices?.[0]?.delta?.content;
    if (typeof delta === 'string' && delta.length > 0) {
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
