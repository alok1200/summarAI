import { NextRequest } from "next/server";
import ZAI from "z-ai-web-dev-sdk";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

interface AttachmentPayload {
  id: string;
  name: string;
  mimeType: string;
  size: number;
  kind: "image" | "text" | "file";
  dataUrl?: string;
  textContent?: string;
}

interface ChatMessagePayload {
  role: "system" | "user" | "assistant";
  content: string;
  attachments?: AttachmentPayload[];
}

function buildMessageText(m: ChatMessagePayload): string {
  if (!m.attachments || m.attachments.length === 0) return m.content;
  const textParts: string[] = [];
  if (m.content.trim()) textParts.push(m.content);
  for (const a of m.attachments) {
    if (a.kind === "text" && a.textContent) {
      textParts.push(
        `\n\n--- Attached file: ${a.name} ---\n${a.textContent}\n--- end of ${a.name} ---`
      );
    } else if (a.kind === "image") {
      textParts.push(`[Image attached: ${a.name}]`);
    } else {
      textParts.push(`[File attached: ${a.name}]`);
    }
  }
  return textParts.join("");
}

export async function POST(req: NextRequest) {
  try {
    const body = await req.json();
    const messages: ChatMessagePayload[] = body.messages ?? [];
    const systemPrompt: string =
      body.systemPrompt ??
      "You are a helpful, friendly AI assistant. Answer clearly and concisely. Use markdown when useful. If the user shares code or text files, reference them by filename when relevant.";

    // Strip any system messages from the client; we prepend our own.
    const cleaned = messages.filter((m) => m.role !== "system");

    // Find the last user message — only that one can carry live image attachments.
    const lastUserIdx = [...cleaned]
      .reverse()
      .findIndex((m) => m.role === "user");
    const realLastUserIdx =
      lastUserIdx === -1 ? -1 : cleaned.length - 1 - lastUserIdx;
    const lastUserMessage =
      realLastUserIdx >= 0 ? cleaned[realLastUserIdx] : null;

    const hasImages =
      !!lastUserMessage?.attachments?.some((a) => a.kind === "image" && a.dataUrl);

    const zai = await ZAI.create();

    let content: string;

    if (hasImages && lastUserMessage) {
      // Use the vision API for the latest user message with images.
      // Earlier user messages with images: convert to text-only descriptors.
      const visionMessages: any[] = [];

      visionMessages.push({ role: "system", content: systemPrompt });

      for (let i = 0; i < cleaned.length; i++) {
        const m = cleaned[i];
        if (i === realLastUserIdx) {
          // Build multimodal content for this message
          const parts: any[] = [];
          const textContent = buildMessageText({
            ...m,
            // For the last message, don't include the "[Image attached]" placeholder
            // since we're attaching real images.
            attachments: m.attachments?.filter((a) => a.kind !== "image"),
          });
          if (textContent.trim()) {
            parts.push({ type: "text", text: textContent });
          } else {
            parts.push({
              type: "text",
              text: "Please analyze the attached image(s).",
            });
          }
          for (const a of m.attachments ?? []) {
            if (a.kind === "image" && a.dataUrl) {
              parts.push({
                type: "image_url",
                image_url: { url: a.dataUrl },
              });
            }
          }
          visionMessages.push({ role: "user", content: parts });
        } else {
          // Earlier message: text only
          visionMessages.push({
            role: m.role,
            content: buildMessageText(m),
          });
        }
      }

      const completion = await zai.chat.completions.createVision({
        messages: visionMessages,
        thinking: { type: "disabled" },
      });
      content =
        completion?.choices?.[0]?.message?.content ??
        "Sorry, I couldn't analyze the attached image(s).";
    } else {
      // Plain text chat — include text-file content inline.
      const fullMessages: { role: "system" | "user" | "assistant"; content: string }[] =
        [
          { role: "system", content: systemPrompt },
          ...cleaned.map((m) => ({
            role: m.role,
            content: buildMessageText(m),
          })),
        ];

      const completion = await zai.chat.completions.create({
        messages: fullMessages,
        thinking: { type: "disabled" },
      });
      content =
        completion?.choices?.[0]?.message?.content ??
        "Sorry, I couldn't generate a response.";
    }

    // Stream the response back token-by-token for a typing effect.
    const encoder = new TextEncoder();
    const stream = new ReadableStream({
      async start(controller) {
        const tokens = content.match(/\s+|\S+/g) ?? [content];
        for (const token of tokens) {
          controller.enqueue(encoder.encode(token));
          await new Promise((r) => setTimeout(r, 12));
        }
        controller.close();
      },
    });

    return new Response(stream, {
      headers: {
        "Content-Type": "text/plain; charset=utf-8",
        "Cache-Control": "no-cache, no-transform",
        Connection: "keep-alive",
      },
    });
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : "Unknown error";
    return new Response(
      JSON.stringify({ error: message || "Chat request failed" }),
      { status: 500, headers: { "Content-Type": "application/json" } }
    );
  }
}
