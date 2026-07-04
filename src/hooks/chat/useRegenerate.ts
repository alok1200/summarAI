"use client";

import { useCallback } from "react";
import { useChatStore } from "@/store/chat";
import type { VideoContext } from "@/store/chat";

interface RegenerateOptions {
  activeConversationId: string | null;
  isStreaming: boolean;
  videoContext?: VideoContext | null;
}

/**
 * Hook that returns a `regenerate()` function. When called, it finds the
 * most recent assistant message in the active conversation, resets its
 * content to a "⏳ Regenerating…" placeholder, and re-runs the conversation
 * through /api/chat with the message history up to that point.
 *
 * For YouTube summary / interview messages we don't have the original
 * payload anymore, so we fall back to /api/chat with the user's text as
 * the prompt — the LLM will produce a fresh response based on context.
 *
 * Extracted from page.tsx to keep the main component focused on layout.
 */
export function useRegenerate({
  activeConversationId,
  isStreaming,
  videoContext,
}: RegenerateOptions) {
  const { updateMessage, setStreaming } = useChatStore();

  return useCallback(async () => {
    if (!activeConversationId || isStreaming) return;

    const state = useChatStore.getState();
    const convo = state.conversations.find((c) => c.id === activeConversationId);
    if (!convo) return;
    const msgs = convo.messages;
    if (msgs.length < 2) return;

    // Find the last assistant message and the user message right before it.
    let lastAssistantIdx = -1;
    for (let i = msgs.length - 1; i >= 0; i--) {
      if (msgs[i].role === "assistant") {
        lastAssistantIdx = i;
        break;
      }
    }
    if (lastAssistantIdx <= 0) return;
    const lastUserMsg = msgs[lastAssistantIdx - 1];
    if (lastUserMsg.role !== "user") return;

    const assistantMsgId = msgs[lastAssistantIdx].id;
    updateMessage(activeConversationId, assistantMsgId, "⏳ Regenerating…");
    setStreaming(true);

    const controller = new AbortController();
    try {
      // Reconstruct the prior message history (everything up to and
      // including the user message that produced the response we're
      // regenerating).
      const priorMessages = msgs
        .slice(0, lastAssistantIdx + 1)
        .filter((m) => m.content.trim() !== "")
        .map((m) => ({
          role: m.role,
          content: m.content,
          attachments: m.attachments,
        }));

      const payload: Record<string, unknown> = { messages: priorMessages };
      if (videoContext) {
        payload.videoContext = {
          url: videoContext.url,
          videoId: videoContext.videoId,
          title: videoContext.title,
          author: videoContext.author,
          transcript: videoContext.transcript,
          chunks: videoContext.chunks,
          topicIndex: videoContext.topicIndex,
          language: videoContext.language,
        };
      }

      const res = await fetch("/api/chat", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
        signal: controller.signal,
      });
      if (!res.ok || !res.body) {
        const errBody = await res.json().catch(() => ({}));
        throw new Error(errBody?.error || `Request failed: ${res.status}`);
      }
      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let acc = "";
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        acc += decoder.decode(value, { stream: true });
        updateMessage(activeConversationId, assistantMsgId, acc);
      }
      if (!acc.trim()) {
        updateMessage(
          activeConversationId,
          assistantMsgId,
          "_(No response received.)_"
        );
      }
    } catch (err: unknown) {
      if ((err as Error)?.name === "AbortError") {
        // Keep partial content.
      } else {
        const message =
          err instanceof Error ? err.message : "Something went wrong.";
        updateMessage(
          activeConversationId,
          assistantMsgId,
          `⚠️ **Error:** ${message}`
        );
      }
    } finally {
      setStreaming(false);
    }
  }, [activeConversationId, isStreaming, videoContext, updateMessage, setStreaming]);
}
