import ZAI from 'z-ai-web-dev-sdk';
const zai = await ZAI.create();

const stream = await zai.chat.completions.create({
  messages: [{ role: 'user', content: 'Count from 1 to 5' }],
  stream: true,
});

let i = 0;
for await (const chunk of stream) {
  i++;
  console.log(`--- chunk ${i} ---`);
  console.log(JSON.stringify(chunk, null, 2).slice(0, 500));
  if (i > 5) break;
}
