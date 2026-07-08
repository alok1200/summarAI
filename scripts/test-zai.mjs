import ZAI from 'z-ai-web-dev-sdk';
const zai = await ZAI.create();
const r = await zai.chat.completions.create({
  messages: [{ role: 'user', content: 'Say hi in exactly 5 words' }],
});
console.log(JSON.stringify(r, null, 2));
