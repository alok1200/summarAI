// Fetch YouTube transcript for s0jL3EKxt6I via Invidious companion strategy
// then summarize it into a structured mind-map JSON using Gemini API.

import dns from "node:dns";
dns.setDefaultResultOrder("ipv4first");

const VIDEO_ID = "s0jL3EKxt6I";
const INVIDIOUS_HOST = "inv.nadeko.net";
const COMPANION_HOST = "inv-de1.nadeko.net";
const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36";

// ─── Step 1: Get Invidious watch page via r.jina.ai (bypass IP block) ───
async function getWatchPage(videoId) {
  const url = `https://r.jina.ai/https://${INVIDIOUS_HOST}/watch?v=${videoId}`;
  console.log(`[1] Fetching watch page via jina: ${url}`);
  const resp = await fetch(url, {
    headers: { "Accept": "text/plain" },
    signal: AbortSignal.timeout(30000),
  });
  if (!resp.ok) throw new Error(`jina returned ${resp.status}`);
  const html = await resp.text();
  if (html.length < 1000) throw new Error(`jina returned short body (${html.length} chars)`);
  console.log(`[1] OK — got ${html.length} chars`);
  return html;
}

// ─── Step 2: Extract companion check ID ───
function extractCheckId(html) {
  const m = html.match(/check=([a-zA-Z0-9_-]+)/);
  if (!m) throw new Error("Could not find companion check ID");
  console.log(`[2] check ID = ${m[1]}`);
  return m[1];
}

// ─── Step 3: List captions ───
async function listCaptions(videoId, checkId) {
  const url = `https://${COMPANION_HOST}/companion/api/v1/captions/${videoId}?check=${encodeURIComponent(checkId)}`;
  console.log(`[3] Listing captions: ${url}`);
  const resp = await fetch(url, {
    headers: { "User-Agent": UA },
    signal: AbortSignal.timeout(15000),
  });
  if (!resp.ok) throw new Error(`captions list returned ${resp.status}`);
  const data = await resp.json();
  if (!data.captions || data.captions.length === 0) throw new Error("No captions available");
  console.log(`[3] OK — ${data.captions.length} caption tracks`);
  data.captions.forEach(c => console.log(`     - ${c.label} (${c.languageCode})`));
  return data.captions;
}

// ─── Step 4: Fetch VTT captions ───
async function fetchVtt(caption, checkId) {
  let url = caption.url;
  if (url.startsWith("/")) url = `https://${COMPANION_HOST}${url}`;
  const sep = url.includes("?") ? "&" : "?";
  if (!url.includes("check=")) url += `${sep}check=${encodeURIComponent(checkId)}`;
  if (!url.includes("fmt=")) url += "&fmt=vtt";
  console.log(`[4] Fetching VTT: ${url.substring(0, 120)}...`);
  const resp = await fetch(url, {
    headers: { "User-Agent": UA },
    signal: AbortSignal.timeout(30000),
  });
  if (!resp.ok) throw new Error(`VTT fetch returned ${resp.status}`);
  const vtt = await resp.text();
  console.log(`[4] OK — ${vtt.length} chars of VTT`);
  return vtt;
}

// ─── Step 5: Parse VTT into plain text ───
function parseVtt(vtt) {
  const segments = [];
  const blocks = vtt.split("\n\n");
  for (const block of blocks) {
    const lines = block.trim().split("\n");
    if (lines.length < 2) continue;
    let tsLine = null;
    const textLines = [];
    for (const line of lines) {
      if (line.includes("-->")) tsLine = line;
      else if (tsLine && !line.startsWith("WEBVTT") && !line.match(/^\d+$/)) {
        // Strip HTML tags and tag styling
        const clean = line.replace(/<[^>]+>/g, "").trim();
        if (clean) textLines.push(clean);
      }
    }
    if (!tsLine || textLines.length === 0) continue;
    const tsMatch = tsLine.match(/(\d+):(\d+):([\d.]+)\s*-->\s*(\d+):(\d+):([\d.]+)/);
    if (!tsMatch) continue;
    const h = parseInt(tsMatch[1]), m = parseInt(tsMatch[2]), s = parseFloat(tsMatch[3]);
    const startSec = h * 3600 + m * 60 + s;
    segments.push({ t: startSec, text: textLines.join(" ") });
  }

  // Deduplicate incremental-reveal captions (YouTube sometimes splits a sentence
  // into multiple progressive reveals — keep the longest version per timestamp bucket)
  const seen = new Map();
  for (const seg of segments) {
    const bucket = Math.floor(seg.t / 0.5) * 0.5;
    const prev = seen.get(bucket);
    if (!prev || seg.text.length > prev.text.length) {
      seen.set(bucket, seg);
    }
  }
  const deduped = Array.from(seen.values()).sort((a, b) => a.t - b.t);
  return deduped;
}

// ─── Step 6: Summarize via Gemini into structured mind-map JSON ───
async function summarizeWithGemini(transcriptText) {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) throw new Error("GEMINI_API_KEY not set");

  // Truncate to ~50K chars to stay within context limits
  const text = transcriptText.slice(0, 50000);

  const prompt = `You are summarizing a YouTube video transcript into a structured mind map.

VIDEO: "Building AI Agentic Workflows with DeepSeek and OpenAI" by Piyush Garg
(Transcript is in Hindi/Hinglish auto-generated captions — translate to English.)

TRANSCRIPT:
${text}

Produce a JSON mind-map structure with this exact shape:
{
  "root": "AI Agentic Workflows (DeepSeek + OpenAI)",
  "branches": [
    {
      "label": "Branch Name (3-6 words, English)",
      "children": [
        "Leaf 1 (short phrase)",
        "Leaf 2",
        "Leaf 3"
      ]
    },
    ...
  ]
}

Requirements:
- 6-8 first-level branches (covering: what agentic workflows are, DeepSeek role, OpenAI role, architecture pattern, tools/agents used, code/demo highlights, benefits, challenges/limitations)
- Each branch has 3-5 leaf children
- All text in English (translate from Hindi if needed)
- Each leaf is a short phrase (max 8 words)
- Cover the ACTUAL content of the video, not generic AI concepts
- Return ONLY the JSON, no markdown code fences, no commentary.`;

  console.log(`[5] Calling Gemini API to summarize...`);
  const resp = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent?key=${apiKey}`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        contents: [{ parts: [{ text: prompt }] }],
        generationConfig: { temperature: 0.4, responseMimeType: "application/json" },
      }),
      signal: AbortSignal.timeout(120000),
    }
  );

  if (!resp.ok) {
    const errText = await resp.text();
    throw new Error(`Gemini API ${resp.status}: ${errText.slice(0, 500)}`);
  }
  const data = await resp.json();
  const text2 = data.candidates?.[0]?.content?.parts?.[0]?.text;
  if (!text2) throw new Error("Gemini returned empty response");

  // Parse the JSON (strip any markdown fences if present)
  let cleaned = text2.trim();
  if (cleaned.startsWith("```")) {
    cleaned = cleaned.replace(/^```(?:json)?\s*/, "").replace(/\s*```$/, "");
  }
  const parsed = JSON.parse(cleaned);
  console.log(`[5] OK — got mind map with ${parsed.branches.length} branches`);
  return parsed;
}

// ─── Main ───
async function main() {
  console.log(`=== YouTube → Mind Map for ${VIDEO_ID} ===\n`);

  const watchHtml = await getWatchPage(VIDEO_ID);
  const checkId = extractCheckId(watchHtml);
  const captions = await listCaptions(VIDEO_ID, checkId);

  // Pick the first available caption (Hindi auto-generated, since this is a Hindi video)
  const chosen = captions[0];
  const vtt = await fetchVtt(chosen, checkId);

  const segments = parseVtt(vtt);
  console.log(`[5] Parsed ${segments.length} transcript segments`);

  const fullText = segments.map(s => s.text).join(" ");
  console.log(`[5] Full transcript: ${fullText.length} chars\n`);

  const mindMap = await summarizeWithGemini(fullText);

  // Save outputs
  const fs = await import("node:fs/promises");
  const path = await import("node:path");
  const { fileURLToPath } = await import("node:url");
  const __dirname = path.dirname(fileURLToPath(import.meta.url));
  const outDir = __dirname;
  await fs.writeFile(path.join(outDir, "transcript.txt"), fullText, "utf8");
  await fs.writeFile(path.join(outDir, "mindmap.json"), JSON.stringify(mindMap, null, 2), "utf8");

  console.log(`\n=== DONE ===`);
  console.log(`Transcript:  ${outDir}/transcript.txt (${fullText.length} chars)`);
  console.log(`Mind map:    ${outDir}/mindmap.json (${mindMap.branches.length} branches)`);
  console.log(`\nPreview:`);
  console.log(JSON.stringify(mindMap, null, 2).slice(0, 2000));
}

main().catch(e => {
  console.error("FATAL:", e);
  process.exit(1);
});
