import { NextRequest } from "next/server";
import ZAI from "z-ai-web-dev-sdk";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

interface ChatMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

export async function POST(req: NextRequest) {
  try {
    const body = await req.json();
    const messages: ChatMessage[] = body.messages ?? [];
    const systemPrompt: string =
      body.systemPrompt ??
      "You are a helpful, friendly AI assistant. Answer clearly and concisely. Use markdown when useful.";

    // Prepend system prompt
    const fullMessages: ChatMessage[] = [
      { role: "system", content: systemPrompt },
      ...messages.filter((m) => m.role !== "system"),
    ];

    const zai = await ZAI.create();
    const completion = await zai.chat.completions.create({
      messages: fullMessages,
      thinking: { type: "disabled" },
    });

    const content: string =
      completion?.choices?.[0]?.message?.content ??
      "Sorry, I couldn't generate a response.";

    // Stream the response back to the client in chunks to simulate
    // a ChatGPT-like typing experience.
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
