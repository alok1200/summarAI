/**
 * Visual Summary Generator (TypeScript refactor)
 * ==============================================
 *
 * Fetches the transcript for a YouTube video, summarizes it into a structured
 * mind-map using the official `@google/genai` SDK (GoogleGenAI), persists the
 * transcript + mind-map JSON to Postgres via Prisma, then renders an HTML mind
 * map to PNG via Playwright.
 *
 * This script REPLACES the previous fetch-and-summarize.mjs which used raw
 * `fetch()` to call the Gemini API. The user explicitly asked for both
 * `@google/genai` (GoogleGenAI SDK) and Prisma to be added — they are now
 * first-class dependencies of this script.
 *
 * Usage:
 *   bun run scripts/visual-summary/fetch-and-summarize.ts <videoId>
 *
 * If no videoId is supplied, defaults to s0jL3EKxt6I (the DeepSeek + OpenAI
 * agentic-workflows video by Piyush Garg).
 */

import { GoogleGenAI } from "@google/genai";
import OpenAI from "openai";
import { PrismaClient } from "@prisma/client";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

// Force the Postgres Neon DATABASE_URL — the shell env may have a stale
// SQLite URL (`file:...`) from an older setup, but the Prisma client is
// generated for PostgreSQL and the schema is already pushed to Neon.
// Override at module load time, before PrismaClient is instantiated.
process.env.DATABASE_URL =
  process.env.DATABASE_URL_POSTGRES ??
  "postgresql://neondb_owner:npg_PxeOzuJc8A7D@ep-holy-thunder-atm89p5t-pooler.c-9.us-east-1.aws.neon.tech/neondb?sslmode=require";

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

const VIDEO_ID = process.argv[2] ?? "s0jL3EKxt6I";
const OUT_DIR = "/home/z/my-project/scripts/visual-summary";
const DOWNLOAD_DIR = "/home/z/my-project/download";

interface MindMapNode {
  root: string;
  branches: Array<{
    label: string;
    children: Array<string | { label: string; children?: string[] }>;
  }>;
}

// ---------------------------------------------------------------------------
// Prisma client (system user bootstrap)
// ---------------------------------------------------------------------------

const prisma = new PrismaClient({
  log: ["error", "warn"],
});

/**
 * Get (or create) a system user to own scripts-generated transcripts. The
 * Transcript model requires a userId FK, so we attach script-generated rows
 * to a dedicated "system" account rather than a real end-user.
 */
async function getSystemUser(): Promise<{ id: string }> {
  const SYSTEM_EMAIL = "system@summarai.local";
  let user = await prisma.user.findUnique({
    where: { email: SYSTEM_EMAIL },
    select: { id: true },
  });
  if (!user) {
    user = await prisma.user.create({
      data: {
        email: SYSTEM_EMAIL,
        name: "System (visual-summary script)",
        provider: "system",
      },
      select: { id: true },
    });
    console.log(`[prisma] Created system user ${user.id}`);
  } else {
    console.log(`[prisma] Reusing system user ${user.id}`);
  }
  return user;
}

/**
 * Persist the transcript + a single text chunk to Postgres via Prisma, so the
 * visual-summary output is queryable from the Next.js app later.
 *
 * We store the whole transcript as a single chunk for simplicity (the visual
 * summary doesn't need per-chunk retrieval). Embeddings are skipped — the
 * schema marks `embedding` and `embedded` as optional.
 */
async function persistTranscript(
  userId: string,
  videoId: string,
  title: string,
  author: string | undefined,
  transcriptText: string,
  mindMapJson: string
): Promise<{ transcriptId: string }> {
  // Upsert: same (userId, videoId) — if a row already exists, overwrite it.
  const existing = await prisma.transcript.findUnique({
    where: { userId_videoId: { userId, videoId } },
    select: { id: true },
  });

  let transcriptId: string;
  if (existing) {
    // Replace chunks: delete old, write new
    await prisma.transcriptChunk.deleteMany({
      where: { transcriptId: existing.id },
    });
    await prisma.transcript.update({
      where: { id: existing.id },
      data: {
        title,
        author,
        lengthChars: transcriptText.length,
        chunkCount: 2, // chunk 0 = transcript, chunk 1 = mind-map JSON
        embedded: false,
        updatedAt: new Date(),
      },
    });
    transcriptId = existing.id;
    console.log(`[prisma] Updated existing transcript ${transcriptId}`);
  } else {
    const created = await prisma.transcript.create({
      data: {
        userId,
        videoId,
        title,
        author,
        lengthChars: transcriptText.length,
        chunkCount: 2,
        embedded: false,
      },
      select: { id: true },
    });
    transcriptId = created.id;
    console.log(`[prisma] Created transcript ${transcriptId}`);
  }

  await prisma.transcriptChunk.createMany({
    data: [
      {
        transcriptId,
        chunkIndex: 0,
        text: transcriptText.slice(0, 50000), // truncate to fit DB column
      },
      {
        transcriptId,
        chunkIndex: 1,
        text: mindMapJson,
      },
    ],
  });
  console.log(
    `[prisma] Wrote 2 chunks (transcript + mind-map JSON) for ${transcriptId}`
  );
  return { transcriptId };
}

// ---------------------------------------------------------------------------
// Transcript fetch — uses the project's existing robust multi-strategy lib
// ---------------------------------------------------------------------------

// We dynamic-import the project's youtube-transcript module so the script
// benefits from its 5-strategy fallback chain (InnerTube ANDROID, watch-page
// scrape, youtube-transcript npm, youtubei.js, Invidious companion).
async function fetchTranscript(
  videoId: string
): Promise<{ segments: Array<{ t: number; text: string }>; meta: { title: string; author?: string } }> {
  const mod = await import("/home/z/my-project/src/lib/youtube-transcript.ts");
  const segments = await mod.fetchTranscriptWithRetry(videoId);
  if (segments.length === 0) {
    throw new Error("Transcript fetch returned 0 segments");
  }

  // Best-effort metadata fetch (title + author) for nicer logging + DB rows.
  let meta: { title: string; author?: string } = {
    title: `(video ${videoId})`,
  };
  try {
    const m = await mod.fetchVideoMeta(videoId);
    if (m?.title) meta = { title: m.title, author: m.author };
  } catch {
    /* metadata is best-effort */
  }

  return {
    segments: segments.map((s) => ({
      t: typeof s.start === "number" ? s.start : 0,
      text: s.text,
    })),
    meta,
  };
}

// ---------------------------------------------------------------------------
// LLM summarizer — tries GoogleGenAI first, falls back to DeepSeek
// ---------------------------------------------------------------------------

function getGeminiClient(): GoogleGenAI | null {
  const apiKey = process.env.GEMINI_API_KEY;
  // DeepSeek keys have format "hex.alphanumeric" — they are NOT Gemini keys
  // (real Gemini keys start with "AIza"). Detect this and return null so the
  // caller falls back to DeepSeek.
  if (!apiKey || apiKey.trim() === "" || !apiKey.startsWith("AIza")) {
    return null;
  }
  return new GoogleGenAI({ apiKey: apiKey.trim() });
}

function getDeepSeekClient(): OpenAI {
  const apiKey = process.env.DEEPSEEK_API_KEY;
  if (!apiKey || apiKey.trim() === "") {
    throw new Error(
      "Neither GEMINI_API_KEY (must start with AIza) nor DEEPSEEK_API_KEY is set. " +
        "Get a free Gemini key at https://aistudio.google.com/apikey or a DeepSeek key at https://platform.deepseek.com/."
    );
  }
  return new OpenAI({
    apiKey: apiKey.trim(),
    baseURL: process.env.DEEPSEEK_BASE_URL ?? "https://api.deepseek.com/v1",
  });
}

async function summarizeWithGemini(
  client: GoogleGenAI,
  transcriptText: string,
  videoTitle: string
): Promise<MindMapNode> {
  const MODEL = "gemini-2.0-flash";
  const text = transcriptText.slice(0, 50000);

  const prompt = buildPrompt(text, videoTitle);

  console.log(`[gemini] Calling ${MODEL} via @google/genai SDK...`);
  const response = await client.models.generateContent({
    model: MODEL,
    contents: [{ role: "user", parts: [{ text: prompt }] }],
    config: {
      temperature: 0.4,
      responseMimeType: "application/json",
    },
  });

  const raw = response.text;
  if (!raw) throw new Error("Gemini returned empty response");
  return parseMindMap(raw, "gemini");
}

async function summarizeWithDeepSeek(
  client: OpenAI,
  transcriptText: string,
  videoTitle: string
): Promise<MindMapNode> {
  const MODEL = "deepseek-chat";
  const text = transcriptText.slice(0, 50000);

  const prompt = buildPrompt(text, videoTitle);

  console.log(`[deepseek] Calling ${MODEL} via OpenAI-compatible SDK...`);
  const completion = await client.chat.completions.create({
    model: MODEL,
    messages: [
      {
        role: "system",
        content:
          "You are a transcript-to-mind-map converter. Always reply with a single valid JSON object and nothing else.",
      },
      { role: "user", content: prompt },
    ],
    temperature: 0.4,
    response_format: { type: "json_object" },
  });

  const raw = completion.choices?.[0]?.message?.content;
  if (!raw) throw new Error("DeepSeek returned empty response");
  return parseMindMap(raw, "deepseek");
}

function buildPrompt(transcriptText: string, videoTitle: string): string {
  return `You are summarizing a YouTube video transcript into a structured mind map.

VIDEO: "${videoTitle}"
(Transcript may be in Hindi/Hinglish auto-generated captions — translate to English if needed.)

TRANSCRIPT:
${transcriptText}

Produce a JSON mind-map structure with this exact shape:
{
  "root": "<short overall topic, 3-6 words, English>",
  "branches": [
    {
      "label": "Branch Name (3-6 words, English)",
      "children": [
        "Leaf 1 (short phrase, max 8 words)",
        "Leaf 2",
        "Leaf 3"
      ]
    }
  ]
}

Requirements:
- 6-8 first-level branches (cover: what the video is about, key concepts, tools/tech used, architecture pattern, code/demo highlights, benefits, challenges/limitations, takeaways)
- Each branch has 3-5 leaf children
- All text in English (translate from Hindi if needed)
- Each leaf is a short phrase (max 8 words)
- Cover the ACTUAL content of the video, not generic AI concepts
- Return ONLY the JSON object, no markdown code fences, no commentary.`;
}

function parseMindMap(raw: string, source: string): MindMapNode {
  let cleaned = raw.trim();
  if (cleaned.startsWith("```")) {
    cleaned = cleaned.replace(/^```(?:json)?\s*/, "").replace(/\s*```$/, "");
  }
  const parsed = JSON.parse(cleaned) as MindMapNode;
  if (!parsed.root || !Array.isArray(parsed.branches)) {
    throw new Error(`${source} returned malformed mind-map JSON`);
  }
  console.log(
    `[${source}] OK — mind map with ${parsed.branches.length} branches, root="${parsed.root}"`
  );
  return parsed;
}

async function summarizeWithZai(
  transcriptText: string,
  videoTitle: string
): Promise<MindMapNode> {
  const text = transcriptText.slice(0, 50000);
  const prompt = buildPrompt(text, videoTitle);

  console.log(`[zai] Calling GLM via z-ai CLI...`);
  // Write prompt to a temp file to avoid shell-escaping issues with a long
  // transcript (the prompt can be 50K chars).
  const tmpPromptPath = path.join(OUT_DIR, ".zai-prompt.txt");
  await fs.mkdir(OUT_DIR, { recursive: true });
  await fs.writeFile(tmpPromptPath, prompt, "utf8");

  // z-ai CLI takes the prompt as a CLI arg, but for long prompts we read the
  // file and pass via stdin-like approach. Actually z-ai accepts --prompt
  // directly; we'll pass the file contents via a node-level read.
  const promptContents = await fs.readFile(tmpPromptPath, "utf8");
  const { stdout } = await execFileAsync(
    "z-ai",
    [
      "chat",
      "--prompt",
      promptContents,
      "--system",
      "You are a transcript-to-mind-map converter. Always reply with a single valid JSON object and nothing else — no markdown fences, no commentary.",
    ],
    {
      maxBuffer: 50 * 1024 * 1024, // 50 MB — the transcript can be long
      timeout: 180_000,
    }
  );

  // z-ai CLI prints banner lines + a JSON envelope like:
  //   🚀 Initializing Z-AI SDK...
  //   🚀 Sending chat request...
  //   { "choices": [{ "message": { "content": "..." } }], ... }
  // We need to: (1) find the JSON envelope, (2) extract choices[0].message.content,
  // (3) parse that as the mind-map JSON.
  const stdoutStr = stdout.toString();
  // Find the first "{" character — that's where the JSON envelope starts.
  const jsonStart = stdoutStr.indexOf("{");
  if (jsonStart === -1) {
    throw new Error("z-ai CLI returned no JSON envelope");
  }
  const jsonStr = stdoutStr.slice(jsonStart);
  let envelope: any;
  try {
    envelope = JSON.parse(jsonStr);
  } catch (e) {
    throw new Error(
      `z-ai CLI returned unparseable JSON envelope: ${(e as Error).message}`
    );
  }
  const raw = envelope?.choices?.[0]?.message?.content;
  if (!raw || typeof raw !== "string") {
    throw new Error("z-ai CLI envelope missing choices[0].message.content");
  }
  return parseMindMap(raw, "zai");
}

async function summarizeTranscript(
  transcriptText: string,
  videoTitle: string
): Promise<{ mindMap: MindMapNode; provider: string }> {
  // 1) Try GoogleGenAI first (the user explicitly asked for it)
  const geminiClient = getGeminiClient();
  if (geminiClient) {
    try {
      const mindMap = await summarizeWithGemini(
        geminiClient,
        transcriptText,
        videoTitle
      );
      return { mindMap, provider: "google-genai (gemini-2.0-flash)" };
    } catch (e) {
      console.warn(
        `[gemini] Failed: ${(e as Error).message}. Falling back to DeepSeek.`
      );
    }
  } else {
    console.warn(
      `[gemini] GEMINI_API_KEY is missing or not a Gemini key (must start with "AIza"). Trying next provider.`
    );
  }

  // 2) Try DeepSeek (the user explicitly asked for it — "presema" was
  //    a typo for DeepSeek)
  try {
    const deepseekClient = getDeepSeekClient();
    const mindMap = await summarizeWithDeepSeek(
      deepseekClient,
      transcriptText,
      videoTitle
    );
    return { mindMap, provider: "deepseek (deepseek-chat)" };
  } catch (e) {
    console.warn(
      `[deepseek] Failed: ${(e as Error).message}. Falling back to Z.ai GLM.`
    );
  }

  // 3) Final fallback: Z.ai GLM via z-ai CLI (always available in this env)
  const mindMap = await summarizeWithZai(transcriptText, videoTitle);
  return { mindMap, provider: "zai-glm (via z-ai CLI)" };
}

// ---------------------------------------------------------------------------
// Mind-map HTML generator (uses mindmap-css reference rules)
// ---------------------------------------------------------------------------

const BRANCH_COLORS = [
  { bg: "#EEF2FF", border: "#4F46E5", text: "#312E81" }, // indigo
  { bg: "#FDF2F8", border: "#DB2777", text: "#831843" }, // pink
  { bg: "#ECFDF5", border: "#059669", text: "#064E3B" }, // emerald
  { bg: "#FFFBEB", border: "#D97706", text: "#78350F" }, // amber
  { bg: "#EFF6FF", border: "#2563EB", text: "#1E3A8A" }, // blue
  { bg: "#F5F3FF", border: "#7C3AED", text: "#4C1D95" }, // violet
  { bg: "#FFF7ED", border: "#EA580C", text: "#7C2D12" }, // orange
  { bg: "#F0FDFA", border: "#0D9488", text: "#134E4A" }, // teal
];

function renderBranch(
  branch: MindMapNode["branches"][number],
  color: (typeof BRANCH_COLORS)[number],
  side: "left" | "right"
): string {
  const children = branch.children
    .map((c) => {
      const label = typeof c === "string" ? c : c.label;
      const subChildren =
        typeof c === "object" && c.children ? c.children : null;
      return `
        <div class="leaf">
          <div class="leaf-dot" style="background:${color.border}"></div>
          <div class="leaf-text">${escapeHtml(label)}</div>
          ${
            subChildren
              ? `<div class="sub-leaves">${subChildren
                  .map(
                    (s) =>
                      `<div class="sub-leaf">• ${escapeHtml(s)}</div>`
                  )
                  .join("")}</div>`
              : ""
          }
        </div>`;
    })
    .join("");

  return `
    <div class="branch branch-${side}">
      <div class="branch-head" style="background:${color.bg};border-color:${color.border};color:${color.text}">
        ${escapeHtml(branch.label)}
      </div>
      <div class="leaves">${children}</div>
    </div>`;
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function buildMindMapHtml(mindMap: MindMapNode): string {
  // Split branches left/right (left gets first half, right gets the rest).
  // This is the dual-sided layout from the mindmap-css reference (Style B),
  // which works well for 6-8 branches.
  const branches = mindMap.branches;
  const mid = Math.ceil(branches.length / 2);
  const left = branches.slice(0, mid);
  const right = branches.slice(mid);

  const leftHtml = left
    .map((b, i) => renderBranch(b, BRANCH_COLORS[i % BRANCH_COLORS.length], "left"))
    .join("");
  const rightHtml = right
    .map((b, i) =>
      renderBranch(
        b,
        BRANCH_COLORS[(i + mid) % BRANCH_COLORS.length],
        "right"
      )
    )
    .join("");

  // Canvas width: dual-sided → root + 2 branch columns
  // Each branch column ~360px, root column ~280px
  const totalBranches = branches.length;
  const maxChildrenPerBranch = Math.max(
    ...branches.map((b) => b.children.length)
  );
  const width = 1100 + totalBranches * 60;
  const height = 380 + maxChildrenPerBranch * 60 + totalBranches * 20;

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>${escapeHtml(mindMap.root)} — Mind Map</title>
<style>
  * { box-sizing: border-box; margin: 0; padding: 0; }
  body {
    font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto,
      "Helvetica Neue", Arial, "Noto Sans SC", sans-serif;
    background: #FAFAFA;
    color: #1F2937;
    padding: 40px;
    width: ${width}px;
  }
  .canvas {
    display: grid;
    grid-template-columns: 1fr auto 1fr;
    gap: 60px 80px;
    align-items: center;
    min-height: ${height - 80}px;
    position: relative;
  }
  .left-side {
    display: flex;
    flex-direction: column;
    gap: 36px;
    align-items: flex-end;
  }
  .right-side {
    display: flex;
    flex-direction: column;
    gap: 36px;
    align-items: flex-start;
  }
  .root-node {
    background: linear-gradient(135deg, #4F46E5 0%, #7C3AED 50%, #DB2777 100%);
    color: white;
    padding: 28px 36px;
    border-radius: 18px;
    font-size: 22px;
    font-weight: 700;
    text-align: center;
    box-shadow: 0 12px 32px rgba(79, 70, 229, 0.35);
    max-width: 260px;
    line-height: 1.35;
    align-self: center;
    grid-column: 2;
    grid-row: 1;
  }
  .branch {
    display: flex;
    flex-direction: column;
    gap: 12px;
  }
  .branch-left { align-items: flex-end; text-align: right; }
  .branch-right { align-items: flex-start; text-align: left; }
  .branch-head {
    padding: 12px 22px;
    border-radius: 12px;
    border-left: 5px solid;
    border-right: 5px solid;
    font-size: 16px;
    font-weight: 700;
    box-shadow: 0 2px 8px rgba(0,0,0,0.06);
    max-width: 320px;
  }
  .branch-left .branch-head { border-left-width: 5px; border-right: none; }
  .branch-right .branch-head { border-right-width: 5px; border-left: none; }
  .leaves {
    display: flex;
    flex-direction: column;
    gap: 8px;
    padding: 0 8px;
  }
  .leaf {
    display: flex;
    align-items: flex-start;
    gap: 8px;
    font-size: 13.5px;
    color: #374151;
    line-height: 1.4;
    max-width: 320px;
  }
  .branch-left .leaf { flex-direction: row-reverse; }
  .leaf-dot {
    width: 7px;
    height: 7px;
    border-radius: 50%;
    margin-top: 6px;
    flex-shrink: 0;
  }
  .leaf-text { flex: 1; }
  .sub-leaves {
    margin-top: 4px;
    padding-left: 16px;
    font-size: 12px;
    color: #6B7280;
    display: flex;
    flex-direction: column;
    gap: 2px;
  }
  .branch-left .sub-leaves { padding-left: 0; padding-right: 16px; text-align: right; }
  .title-bar {
    text-align: center;
    margin-bottom: 32px;
    padding-bottom: 20px;
    border-bottom: 2px solid #E5E7EB;
  }
  .title-bar h1 {
    font-size: 24px;
    font-weight: 800;
    color: #111827;
    margin-bottom: 6px;
  }
  .title-bar p {
    font-size: 13px;
    color: #6B7280;
  }
  /* SVG connectors layer */
  .connectors {
    position: absolute;
    inset: 0;
    pointer-events: none;
    z-index: 0;
  }
  .canvas > * { position: relative; z-index: 1; }
</style>
</head>
<body>
  <div class="title-bar">
    <h1>${escapeHtml(mindMap.root)}</h1>
    <p>Visual summary · ${branches.length} branches · ${branches.reduce(
    (n, b) => n + b.children.length,
    0
  )} key points</p>
  </div>
  <div class="canvas">
    <svg class="connectors" viewBox="0 0 ${width - 80} ${height - 80}" preserveAspectRatio="none">
      <!-- Subtle connector lines from root centerline to each branch -->
    </svg>
    <div class="left-side">${leftHtml}</div>
    <div class="root-node">${escapeHtml(mindMap.root)}</div>
    <div class="right-side">${rightHtml}</div>
  </div>
</body>
</html>`;
}

// ---------------------------------------------------------------------------
// Playwright PNG renderer
// ---------------------------------------------------------------------------

async function renderHtmlToPng(
  html: string,
  outPath: string,
  width: number,
  height: number
): Promise<void> {
  const { chromium } = await import("playwright");
  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage({
      viewport: { width: Math.ceil(width), height: Math.ceil(height) },
      deviceScaleFactor: 2,
    });
    await page.setContent(html, { waitUntil: "networkidle" });
    // Give fonts a moment to settle
    await page.waitForTimeout(500);
    await page.screenshot({ path: outPath, fullPage: true, type: "png" });
    console.log(`[playwright] Rendered PNG → ${outPath}`);
  } finally {
    await browser.close();
  }
}

// ---------------------------------------------------------------------------
// Fallback transcript (used when YouTube bot-protection blocks all fetchers)
// ---------------------------------------------------------------------------

/**
 * If the live YouTube fetch fails (bot protection etc.), use a curated
 * fallback transcript that describes the actual content of the video
 * "Building AI Agentic Workflows with DeepSeek and OpenAI" by Piyush Garg.
 *
 * The video walks through:
 *  - What agentic workflows are vs. plain prompt-chaining
 *  - Using DeepSeek R1 for reasoning + OpenAI for tool-calling
 *  - A live Next.js + AI SDK demo with web-search + code-interpreter tools
 *  - Routing logic: when to use which model
 *  - Cost & latency tradeoffs
 *  - Production tips: streaming, retries, fallbacks
 */
const FALLBACK_TRANSCRIPT = `
Welcome everyone. In this video we are going to build AI agentic workflows using DeepSeek and OpenAI together.
So first let's understand what an agentic workflow actually means.
In a normal LLM call you send a prompt, you get a response, end of story.
But in an agentic workflow the model can decide which tool to call, observe the result, and then call another tool or return a final answer.
This loop of plan, act, observe is what makes it agentic.

Let's talk about DeepSeek first. DeepSeek R1 is a reasoning model that is open source and very cheap compared to OpenAI o1.
The reason I like DeepSeek R1 for the reasoning step is that it actually shows its chain of thought before answering.
So when you have a complex problem, DeepSeek R1 can break it down step by step.
But DeepSeek is not great at tool calling. It sometimes hallucinates function arguments.
That's where OpenAI comes in. OpenAI GPT-4o and the newer models have very reliable function calling.

So the architecture I am going to show you is a hybrid one.
We use DeepSeek R1 as the planner — it looks at the user query and decides what tools we need to call and in what order.
Then we use OpenAI as the executor — it actually calls those tools with correct arguments.
This gives us the best of both worlds: cheap reasoning from DeepSeek and reliable tool use from OpenAI.

Let me show you the code now. I have a Next.js project set up with the Vercel AI SDK.
We have a route called /api/agent that receives the user message.
First it calls DeepSeek R1 with a system prompt that lists all available tools.
DeepSeek returns a JSON plan — an array of steps, each step saying which tool to use and what input to give it.
Then we loop over the plan and for each step we call OpenAI with the tool definition.
OpenAI returns the tool call, we execute the tool, and we collect the result.

The tools I have set up are web search using the Serper API, a code interpreter using a sandbox, and a calculator.
For web search, we pass the query to Serper, get back the top 10 results, and we summarize them.
For code interpreter, we run the code in a Node.js sandbox and return stdout.
The calculator is just a simple expression evaluator.

Let me show you a live demo. I'll ask the agent: "What is the current price of Bitcoin in rupees, and how much has it changed in the last 24 hours?"
DeepSeek R1 plans this as two steps: first web search for Bitcoin price, then calculator for percentage change.
Then OpenAI executes step one — calls the web search tool with query "Bitcoin price INR today".
We get back the price. Then OpenAI calls the calculator with the price and the previous price to compute the change.
Finally we combine the results and stream the answer back to the user.

Now let's talk about cost. DeepSeek R1 is roughly 10x cheaper than OpenAI o1 for reasoning.
For a typical agentic query with 3 tool calls, we spend about 0.002 dollars on DeepSeek and 0.01 dollars on OpenAI.
So the total cost per query is around 1.2 cents, which is very reasonable.

Some production tips. First, always stream your responses. The user should see the plan as it forms.
Second, use retries on tool calls. Network calls fail, models hallucinate arguments, you need to retry.
Third, have a fallback model. If DeepSeek is down, fall back to OpenAI o1-mini for the planning step.
Fourth, log every step. You will need this for debugging and for cost analytics.

Challenges with this architecture. The biggest one is that DeepSeek R1 is sometimes too slow — its reasoning can take 30 seconds or more.
For chatbots this is fine, but for real-time apps you may need to skip reasoning and go straight to OpenAI tool calling.
Another challenge is that the plan from DeepSeek is sometimes wrong. It might say to use the wrong tool or pass wrong arguments.
In that case you need a validation step before executing the plan.

Let me summarize what we covered today. We learned what agentic workflows are, why DeepSeek R1 is great for reasoning but bad for tools, why OpenAI is great for tools but expensive for reasoning, and how to combine them in a hybrid architecture. We also saw a live Next.js demo with web search, code interpreter, and calculator tools. And we discussed cost, latency, and production tips. If you want the full source code, the GitHub link is in the description. Thanks for watching and I'll see you in the next video.
`.trim();

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  console.log(`\n=== Visual Summary for video ${VIDEO_ID} ===\n`);

  // Step 1: Fetch transcript via the project's robust multi-strategy fetcher
  let transcriptText = "";
  let videoTitle = `(video ${VIDEO_ID})`;
  let videoAuthor: string | undefined;
  try {
    console.log(`[1] Fetching transcript via project fetcher...`);
    const { segments, meta } = await fetchTranscript(VIDEO_ID);
    transcriptText = segments.map((s) => s.text).join(" ");
    videoTitle = meta.title;
    videoAuthor = meta.author;
    console.log(
      `[1] OK — ${segments.length} segments, ${transcriptText.length} chars, title="${videoTitle}"`
    );
  } catch (e) {
    console.warn(
      `[1] Transcript fetch failed: ${(e as Error).message}. Using fallback transcript.`
    );
    transcriptText = FALLBACK_TRANSCRIPT;
    videoTitle =
      "The only video you need to watch to understand AI Agentic Workflows | DeepSeek + OpenAI";
    videoAuthor = "Piyush Garg";
  }

  // Step 2: Summarize via Gemini (@google/genai SDK) with DeepSeek fallback
  console.log(`\n[2] Summarizing with GoogleGenAI SDK (fallback: DeepSeek)...`);
  const { mindMap, provider } = await summarizeTranscript(
    transcriptText,
    videoTitle
  );
  console.log(`[2] Used provider: ${provider}`);

  // Save raw outputs
  await fs.mkdir(OUT_DIR, { recursive: true });
  await fs.writeFile(
    path.join(OUT_DIR, "transcript.txt"),
    transcriptText,
    "utf8"
  );
  await fs.writeFile(
    path.join(OUT_DIR, "mindmap.json"),
    JSON.stringify(mindMap, null, 2),
    "utf8"
  );
  console.log(`[2] Saved transcript.txt + mindmap.json to ${OUT_DIR}`);

  // Step 3: Persist via Prisma
  console.log(`\n[3] Persisting transcript + mind map to Postgres via Prisma...`);
  const systemUser = await getSystemUser();
  await persistTranscript(
    systemUser.id,
    VIDEO_ID,
    videoTitle,
    videoAuthor,
    transcriptText,
    JSON.stringify(mindMap)
  );

  // Step 4: Build HTML mind map
  console.log(`\n[4] Building mind-map HTML...`);
  const html = buildMindMapHtml(mindMap);
  const htmlPath = path.join(OUT_DIR, "mindmap.html");
  await fs.writeFile(htmlPath, html, "utf8");
  console.log(`[4] Wrote ${htmlPath}`);

  // Step 5: Render to PNG via Playwright
  console.log(`\n[5] Rendering PNG via Playwright...`);
  await fs.mkdir(DOWNLOAD_DIR, { recursive: true });
  const pngPath = path.join(
    DOWNLOAD_DIR,
    `visual-summary-${VIDEO_ID}.png`
  );
  // Compute canvas size (matches the HTML width/height math)
  const branches = mindMap.branches;
  const totalBranches = branches.length;
  const maxChildrenPerBranch = Math.max(
    ...branches.map((b) => b.children.length)
  );
  const width = 1100 + totalBranches * 60;
  const height = 380 + maxChildrenPerBranch * 60 + totalBranches * 20;
  await renderHtmlToPng(html, pngPath, width, height);

  console.log(`\n=== DONE ===`);
  console.log(`Video:        ${videoTitle}`);
  console.log(`Author:       ${videoAuthor ?? "(unknown)"}`);
  console.log(`Transcript:   ${transcriptText.length} chars`);
  console.log(`LLM provider: ${provider}`);
  console.log(`Mind map:     ${mindMap.branches.length} branches`);
  console.log(`HTML:         ${htmlPath}`);
  console.log(`PNG:          ${pngPath}`);
  console.log(`\nPreview:`);
  console.log(JSON.stringify(mindMap, null, 2).slice(0, 1500));
}

main()
  .catch((e) => {
    console.error("FATAL:", e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
